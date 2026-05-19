import { Hono } from 'hono';
import { sql } from '../db';
import { authMiddleware } from '../middleware/auth';
import { verifyTurnstileToken } from '../lib/turnstile';
import { sendEmail } from '../lib/email';
import { renderGdprRequestEmail } from '../templates/gdpr-request';

export const gdprRequests = new Hono();

const isValidEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 255;

const VALID_TYPES = ['access', 'rectification', 'erasure', 'restriction', 'portability', 'objection'] as const;

const TYPE_LABELS: Record<string, string> = {
  access: 'Accesso ai dati',
  rectification: 'Rettifica',
  erasure: 'Cancellazione',
  restriction: 'Limitazione',
  portability: 'Portabilità',
  objection: 'Opposizione',
};

// ─── Public: Submit GDPR request ───────────────────────────────

gdprRequests.post('/', async (c) => {
  const body = await c.req.json();
  const { email, name, request_type, message, turnstile_token } = body;

  // Turnstile verification
  const clientIp = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || undefined;
  const turnstileOk = await verifyTurnstileToken(turnstile_token || '', clientIp);
  if (!turnstileOk) {
    return c.json({ error: 'Verifica anti-bot fallita. Ricarica la pagina e riprova.' }, 403);
  }

  if (!email || !isValidEmail(email)) {
    return c.json({ error: 'Email non valida' }, 400);
  }
  if (!request_type || !VALID_TYPES.includes(request_type)) {
    return c.json({ error: 'Tipo di richiesta non valido' }, 400);
  }
  if (typeof name === 'string' && name.length > 100) {
    return c.json({ error: 'Nome troppo lungo' }, 400);
  }
  if (typeof message === 'string' && message.length > 2000) {
    return c.json({ error: 'Messaggio troppo lungo' }, 400);
  }

  const [inserted] = await sql`
    INSERT INTO gdpr_requests (email, name, request_type, message)
    VALUES (${email}, ${name || null}, ${request_type}, ${message || null})
    RETURNING id
  `;

  // Notify admin (standard transport — SMTP)
  const adminEmail = process.env.ADMIN_EMAIL || 'federico@calicchia.design';
  renderGdprRequestEmail({
    requestType: request_type as 'access' | 'erasure' | 'rectification' | 'portability' | 'objection' | 'restriction',
    email,
    fullName: name ?? null,
    message: message ?? null,
    requestId: String(inserted.id),
  })
    .then(({ subject, html, text }) =>
      sendEmail({ to: adminEmail, subject, html, text })
    )
    .catch((err) => console.error('[gdpr] Email notify failed:', err));

  return c.json({ success: true, message: 'Richiesta inviata. Riceverai riscontro entro 30 giorni.' });
});

// ─── Admin: List GDPR requests ─────────────────────────────────

gdprRequests.get('/', authMiddleware, async (c) => {
  const status = c.req.query('status');
  const statusFilter = status && status !== 'all'
    ? sql`AND status = ${status}`
    : sql``;

  const requests = await sql`
    SELECT * FROM gdpr_requests
    WHERE 1=1 ${statusFilter}
    ORDER BY created_at DESC
    LIMIT 200
  `;

  const stats = await sql`
    SELECT status, COUNT(*)::int AS count
    FROM gdpr_requests
    GROUP BY status
  `;

  return c.json({ requests, stats });
});

// ─── Admin: Update GDPR request status ─────────────────────────

gdprRequests.put('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const { status, admin_notes } = body;

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (status) updates.status = status;
  if (admin_notes !== undefined) updates.admin_notes = admin_notes;
  if (status === 'completed') updates.completed_at = new Date().toISOString();

  const [updated] = await sql`
    UPDATE gdpr_requests
    SET ${sql(updates)}
    WHERE id = ${id}
    RETURNING *
  `;

  if (!updated) return c.json({ error: 'Richiesta non trovata' }, 404);
  return c.json({ request: updated });
});

// ─── Admin: Export user data (for access/portability requests) ──

gdprRequests.get('/export/:email', authMiddleware, async (c) => {
  const email = decodeURIComponent(c.req.param('email'));

  // Lookup customer/lead for cross-channel data (WhatsApp conversations linkate).
  const linked = await sql`
    SELECT id, 'customer' AS kind FROM customers WHERE email = ${email}
    UNION ALL
    SELECT id, 'lead' AS kind FROM leads WHERE email = ${email}
  ` as Array<{ id: string; kind: 'customer' | 'lead' }>;
  const customerIds = linked.filter(r => r.kind === 'customer').map(r => r.id);
  const leadIds = linked.filter(r => r.kind === 'lead').map(r => r.id);

  const [
    contacts,
    newsletterSubs,
    waConvs,
    waMessages,
    commPrefs,
  ] = await Promise.all([
    sql`SELECT name, email, phone, company, message, services, sectors, wants_call, wants_meet, source_page, created_at FROM contacts WHERE email = ${email}`,
    sql`SELECT email, name, status, confirmed_at, created_at FROM newsletter_subscribers WHERE email = ${email}`,
    customerIds.length || leadIds.length
      ? sql`SELECT id, chat_id, phone, contact_name, customer_id, lead_id, ai_mode, last_message_at, created_at
            FROM whatsapp_conversations
            WHERE (customer_id = ANY(${customerIds as any}) OR lead_id = ANY(${leadIds as any}))`
      : Promise.resolve([] as any[]),
    customerIds.length || leadIds.length
      ? sql`SELECT m.id, m.conversation_id, m.direction, m.category, m.type, m.body, m.created_at
            FROM whatsapp_messages m
            JOIN whatsapp_conversations c ON c.id = m.conversation_id
            WHERE (c.customer_id = ANY(${customerIds as any}) OR c.lead_id = ANY(${leadIds as any}))
            ORDER BY m.created_at`
      : Promise.resolve([] as any[]),
    sql`SELECT customer_id, lead_id, email, phone,
               whatsapp_transactional, whatsapp_operational, whatsapp_marketing,
               email_operational, email_marketing, sms_transactional,
               updated_via, updated_at
        FROM communication_preferences
        WHERE email = ${email}
           OR customer_id = ANY(${customerIds as any})
           OR lead_id = ANY(${leadIds as any})`,
  ]);

  return c.json({
    export_date: new Date().toISOString(),
    email,
    contacts,
    newsletter: newsletterSubs,
    whatsapp_conversations: waConvs,
    whatsapp_messages: waMessages,
    communication_preferences: commPrefs,
    note: 'Analytics data is anonymized and cannot be linked to individual users.',
  });
});

// ─── Admin: Erase user data (for erasure requests) ─────────────

gdprRequests.delete('/erase/:email', authMiddleware, async (c) => {
  const email = decodeURIComponent(c.req.param('email'));

  // Lookup linked records (per cancellare anche conversazioni WA collegate).
  const linked = await sql`
    SELECT id, 'customer' AS kind FROM customers WHERE email = ${email}
    UNION ALL
    SELECT id, 'lead' AS kind FROM leads WHERE email = ${email}
  ` as Array<{ id: string; kind: 'customer' | 'lead' }>;
  const customerIds = linked.filter(r => r.kind === 'customer').map(r => r.id);
  const leadIds = linked.filter(r => r.kind === 'lead').map(r => r.id);

  const [
    deletedContacts,
    deletedNewsletter,
    deletedPrefs,
    deletedWaConvs,
  ] = await Promise.all([
    sql`DELETE FROM contacts WHERE email = ${email} RETURNING id`,
    sql`DELETE FROM newsletter_subscribers WHERE email = ${email} RETURNING id`,
    sql`DELETE FROM communication_preferences
        WHERE email = ${email}
           OR customer_id = ANY(${customerIds as any})
           OR lead_id = ANY(${leadIds as any}) RETURNING id`,
    customerIds.length || leadIds.length
      ? sql`DELETE FROM whatsapp_conversations
            WHERE customer_id = ANY(${customerIds as any})
               OR lead_id = ANY(${leadIds as any}) RETURNING id`
      : Promise.resolve([] as Array<{ id: string }>),
  ]);

  return c.json({
    erased: true,
    email,
    contacts_deleted: deletedContacts.length,
    newsletter_deleted: deletedNewsletter.length,
    communication_preferences_deleted: deletedPrefs.length,
    whatsapp_conversations_deleted: deletedWaConvs.length,
  });
});
