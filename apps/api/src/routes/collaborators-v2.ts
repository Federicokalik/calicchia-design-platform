import { Hono } from 'hono';
import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { sql } from '../db';
import { sendEmail } from '../lib/email';
import { canSendWhatsApp } from '../lib/whatsapp-policy';
import { sendWhatsAppText } from '../lib/whatsapp';

export const collaboratorsV2 = new Hono();

function stripPortalSecrets(row: Record<string, unknown>): Record<string, unknown> {
  const { portal_access_code, portal_access_code_hash, ...safe } = row;
  return { ...safe, has_portal_access: Boolean(portal_access_code_hash) };
}

function portalBaseUrl(): string {
  return (process.env.PORTAL_URL || process.env.SITE_URL || 'https://calicchia.design').replace(/\/$/, '');
}

function buildPortalAccessMessage(opts: { name: string | null; link: string; code: string }): string {
  const greeting = opts.name?.trim() ? `Ciao ${opts.name.trim()},` : 'Ciao,';
  return [
    greeting,
    '',
    'ti ho preparato l\'accesso collaboratore all\'area clienti Calicchia Design.',
    `Link diretto: ${opts.link}`,
    `Codice accesso: ${opts.code}`,
    '',
    'Vedrai solo i progetti assegnati o condivisi con te.',
  ].join('\n');
}

async function rotateCollaboratorPortalCode(id: string): Promise<{ id: string; code: string } | null> {
  const code = 'COL-' + randomBytes(4).toString('hex').toUpperCase();
  const hash = await bcrypt.hash(code, 12);
  const [row] = await sql`
    UPDATE collaborators
    SET portal_access_code_hash = ${hash},
        portal_access_code_rotated_at = NOW()
    WHERE id = ${id}
    RETURNING id
  ` as Array<{ id: string }>;
  if (!row) return null;
  return { id: row.id, code };
}

collaboratorsV2.get('/', async (c) => {
  const status = c.req.query('status');
  const search = c.req.query('search');
  const statusFilter = status && status !== 'all' ? sql`AND status = ${status}` : sql``;
  const searchFilter = search ? sql`AND (name ILIKE ${'%' + search + '%'} OR company ILIKE ${'%' + search + '%'} OR email ILIKE ${'%' + search + '%'})` : sql``;

  const rows = await sql`SELECT * FROM collaborators WHERE 1=1 ${statusFilter} ${searchFilter} ORDER BY updated_at DESC`;
  return c.json({ collaborators: rows.map((row) => stripPortalSecrets(row)) });
});

collaboratorsV2.get('/:id', async (c) => {
  const [row] = await sql`SELECT * FROM collaborators WHERE id = ${c.req.param('id')}`;
  if (!row) return c.json({ error: 'Non trovato' }, 404);
  return c.json({ collaborator: stripPortalSecrets(row) });
});

collaboratorsV2.post('/', async (c) => {
  const b = await c.req.json();
  const [row] = await sql`
    INSERT INTO collaborators (name, company, email, phone, type, specialization, commission_rate, notes)
    VALUES (${b.name}, ${b.company || null}, ${b.email || null}, ${b.phone || null}, ${b.type || 'partner'}, ${b.specialization || null}, ${b.commission_rate || null}, ${b.notes || null})
    RETURNING *
  `;
  return c.json({ collaborator: row }, 201);
});

collaboratorsV2.put('/:id', async (c) => {
  const b = await c.req.json();
  const [row] = await sql`
    UPDATE collaborators SET
      name = COALESCE(${b.name || null}, name),
      company = ${b.company !== undefined ? b.company : null},
      email = ${b.email !== undefined ? b.email : null},
      phone = ${b.phone !== undefined ? b.phone : null},
      type = COALESCE(${b.type || null}, type),
      specialization = ${b.specialization !== undefined ? b.specialization : null},
      commission_rate = ${b.commission_rate !== undefined ? b.commission_rate : null},
      notes = ${b.notes !== undefined ? b.notes : null},
      status = COALESCE(${b.status || null}, status),
      updated_at = now()
    WHERE id = ${c.req.param('id')}
    RETURNING *
  `;
  if (!row) return c.json({ error: 'Non trovato' }, 404);
  return c.json({ collaborator: row });
});

collaboratorsV2.delete('/:id', async (c) => {
  await sql`DELETE FROM collaborators WHERE id = ${c.req.param('id')}`;
  return c.json({ success: true });
});

collaboratorsV2.get('/:id/projects', async (c) => {
  const rows = await sql`
    SELECT cp.*, c.contact_name AS customer_name
    FROM client_projects cp
    LEFT JOIN customers c ON c.id = cp.customer_id
    WHERE cp.collaborator_id = ${c.req.param('id')}
    ORDER BY cp.updated_at DESC
  `;
  return c.json({ projects: rows });
});

collaboratorsV2.post('/:id/generate-portal-code', async (c) => {
  const collaborator = await rotateCollaboratorPortalCode(c.req.param('id'));
  if (!collaborator) return c.json({ error: 'Collaboratore non trovato' }, 404);
  return c.json({ collaborator: { id: collaborator.id, portal_access_code: collaborator.code } });
});

collaboratorsV2.post('/:id/send-portal-access', async (c) => {
  const id = c.req.param('id');
  const rows = await sql`
    SELECT id, name, company, email, phone
    FROM collaborators
    WHERE id = ${id}
    LIMIT 1
  ` as Array<{
    id: string;
    name: string | null;
    company: string | null;
    email: string | null;
    phone: string | null;
  }>;
  const collaborator = rows[0];
  if (!collaborator) return c.json({ error: 'Collaboratore non trovato' }, 404);
  if (!collaborator.email && !collaborator.phone) {
    return c.json({ error: 'Il collaboratore non ha email o telefono per ricevere l\'accesso' }, 422);
  }

  const access = await rotateCollaboratorPortalCode(id);
  if (!access) return c.json({ error: 'Collaboratore non trovato' }, 404);
  const link = `${portalBaseUrl()}/clienti/p/${encodeURIComponent(access.code)}`;
  const name = collaborator.name || collaborator.company;

  if (collaborator.email) {
    const message = buildPortalAccessMessage({ name, link, code: access.code });
    const email = await sendEmail({
      to: collaborator.email,
      subject: 'Accesso collaboratore - Calicchia Design',
      html: message.replace(/\n/g, '<br />'),
      text: message,
      transport: 'critical',
    });
    if (!email.success) return c.json({ error: 'Invio email accesso collaboratore fallito' }, 502);
    return c.json({ channel: 'email', to: collaborator.email, portal_access_code: access.code, link });
  }

  const phone = collaborator.phone;
  if (!phone) return c.json({ error: 'Il collaboratore non ha telefono per ricevere l\'accesso' }, 422);
  const policy = await canSendWhatsApp(phone, 'transactional');
  if (!policy.allowed) {
    return c.json({ error: 'Invio WhatsApp non consentito', reason: policy.reason }, 422);
  }
  const message = buildPortalAccessMessage({ name, link, code: access.code });
  const result = await sendWhatsAppText(phone, message);
  if (!result.success) return c.json({ error: 'Invio WhatsApp accesso collaboratore fallito' }, 502);
  return c.json({ channel: 'whatsapp', to: phone, portal_access_code: access.code, link });
});
