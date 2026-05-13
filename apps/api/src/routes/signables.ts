import { Hono, type Context } from 'hono';
import { sql, sqlv } from '../db';
import { extractIpUa } from '../lib/signing';
import { sendEmail } from '../lib/email';
import { isSmsConfigured, sendSms } from '../lib/sms';

export const signables = new Hono();

const SIGNABLE_TYPES = new Set(['nda', 'contract', 'sow', 'other']);
const SIGNATURE_METHODS = new Set(['email_otp', 'sms_otp']);
const SIGNABLE_STATUSES = new Set(['draft', 'sent', 'viewed', 'signed', 'expired', 'cancelled']);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SignableDocument = {
  id: string;
  type: string;
  title: string;
  content_md: string;
  customer_id: string | null;
  signer_name: string | null;
  signer_email: string | null;
  signer_phone: string | null;
  signature_method: string;
  sign_token: string;
  status: string;
  expires_at: string | null;
  signed_at: string | null;
  signature_image: string | null;
  signer_ip: string | null;
  signer_user_agent: string | null;
  pdf_hash_sha256: string | null;
  sent_at: string | null;
  viewed_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function readJsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function optionalString(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return stringValue(value);
}

function numericDays(value: unknown, fallback: number): number {
  const days = Number(value ?? fallback);
  if (!Number.isFinite(days) || days <= 0) return fallback;
  return Math.min(Math.floor(days), 365);
}

function isUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

function publicBaseUrl(): string {
  return (process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function writeAuditLog(args: {
  signableId: string;
  action: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}) {
  await sql`
    INSERT INTO signable_audit_log (signable_id, action, ip_address, user_agent, metadata)
    VALUES (
      ${args.signableId},
      ${args.action},
      ${args.ipAddress ?? null},
      ${args.userAgent ?? null},
      ${args.metadata ? sqlv(args.metadata) : null}
    )
  `;
}

signables.get('/', async (c) => {
  const status = stringValue(c.req.query('status'));
  const type = stringValue(c.req.query('type'));
  const customerId = stringValue(c.req.query('customer_id'));

  if (status && !SIGNABLE_STATUSES.has(status)) return c.json({ error: 'Status non valido' }, 400);
  if (type && !SIGNABLE_TYPES.has(type)) return c.json({ error: 'Tipo documento non valido' }, 400);
  if (customerId && !isUuid(customerId)) return c.json({ error: 'customer_id non valido' }, 400);

  const rows = await sql`
    SELECT *
    FROM signable_documents
    WHERE (${status}::text IS NULL OR status = ${status})
      AND (${type}::text IS NULL OR type = ${type})
      AND (${customerId}::uuid IS NULL OR customer_id = ${customerId})
    ORDER BY created_at DESC
  ` as SignableDocument[];

  return c.json({ signables: rows, count: rows.length });
});

signables.get('/:id', async (c) => {
  const { id } = c.req.param();
  if (!isUuid(id)) return c.json({ error: 'ID non valido' }, 400);
  const [doc] = await sql`SELECT * FROM signable_documents WHERE id = ${id}` as SignableDocument[];
  if (!doc) return c.json({ error: 'Documento non trovato' }, 404);
  const audit = await sql`
    SELECT *
    FROM signable_audit_log
    WHERE signable_id = ${id}
    ORDER BY created_at DESC
  `;
  return c.json({ document: doc, audit });
});

signables.post('/', async (c) => {
  const body = await readJsonBody(c);
  if (!body) return c.json({ error: 'Payload non valido' }, 400);

  const type = stringValue(body.type);
  const title = stringValue(body.title);
  const contentMd = stringValue(body.content_md);
  const signatureMethod = stringValue(body.signature_method) ?? 'email_otp';

  if (!type || !SIGNABLE_TYPES.has(type)) return c.json({ error: 'Tipo documento non valido' }, 400);
  if (!title || !contentMd) return c.json({ error: 'Titolo e contenuto richiesti' }, 400);
  if (!SIGNATURE_METHODS.has(signatureMethod)) return c.json({ error: 'Metodo firma non valido' }, 400);

  const expiresInDays = numericDays(body.expires_in_days, 14);
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  const metadata = isRecord(body.metadata) ? body.metadata : {};
  const { ip, ua } = extractIpUa({ header: (name) => c.req.header(name) });

  const [doc] = await sql`
    INSERT INTO signable_documents ${sql({
      type,
      title,
      content_md: contentMd,
      customer_id: optionalString(body.customer_id),
      signer_name: optionalString(body.signer_name),
      signer_email: optionalString(body.signer_email),
      signer_phone: optionalString(body.signer_phone),
      signature_method: signatureMethod,
      status: 'draft',
      expires_at: expiresAt,
      metadata: sqlv(metadata),
    })}
    RETURNING *
  ` as SignableDocument[];

  await writeAuditLog({
    signableId: doc.id,
    action: 'created',
    ipAddress: ip,
    userAgent: ua,
    metadata: { type, signature_method: signatureMethod },
  });

  return c.json({ document: doc }, 201);
});

signables.patch('/:id', async (c) => {
  const { id } = c.req.param();
  if (!isUuid(id)) return c.json({ error: 'ID non valido' }, 400);
  const body = await readJsonBody(c);
  if (!body) return c.json({ error: 'Payload non valido' }, 400);

  const [existing] = await sql`
    SELECT id, status
    FROM signable_documents
    WHERE id = ${id}
  ` as Array<{ id: string; status: string }>;
  if (!existing) return c.json({ error: 'Documento non trovato' }, 404);
  if (existing.status !== 'draft') return c.json({ error: 'Documento modificabile solo in bozza' }, 409);

  const updates: Record<string, unknown> = {};

  if (Object.prototype.hasOwnProperty.call(body, 'type')) {
    const type = stringValue(body.type);
    if (!type || !SIGNABLE_TYPES.has(type)) return c.json({ error: 'Tipo documento non valido' }, 400);
    updates.type = type;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'title')) {
    const title = stringValue(body.title);
    if (!title) return c.json({ error: 'Titolo richiesto' }, 400);
    updates.title = title;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'content_md')) {
    const contentMd = stringValue(body.content_md);
    if (!contentMd) return c.json({ error: 'Contenuto richiesto' }, 400);
    updates.content_md = contentMd;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'signature_method')) {
    const signatureMethod = stringValue(body.signature_method);
    if (!signatureMethod || !SIGNATURE_METHODS.has(signatureMethod)) return c.json({ error: 'Metodo firma non valido' }, 400);
    updates.signature_method = signatureMethod;
  }
  for (const key of ['customer_id', 'signer_name', 'signer_email', 'signer_phone'] as const) {
    if (Object.prototype.hasOwnProperty.call(body, key)) updates[key] = optionalString(body[key]);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'expires_in_days')) {
    const expiresInDays = numericDays(body.expires_in_days, 14);
    updates.expires_at = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  }
  if (Object.prototype.hasOwnProperty.call(body, 'expires_at')) {
    updates.expires_at = optionalString(body.expires_at);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'metadata')) {
    if (!isRecord(body.metadata)) return c.json({ error: 'Metadata non valida' }, 400);
    updates.metadata = sqlv(body.metadata);
  }

  if (Object.keys(updates).length === 0) return c.json({ error: 'Nessun campo da aggiornare' }, 400);

  const [doc] = await sql`
    UPDATE signable_documents
    SET ${sql(updates)}
    WHERE id = ${id}
    RETURNING *
  ` as SignableDocument[];

  return c.json({ document: doc });
});

signables.post('/:id/send', async (c) => {
  const { id } = c.req.param();
  if (!isUuid(id)) return c.json({ error: 'ID non valido' }, 400);
  const [doc] = await sql`SELECT * FROM signable_documents WHERE id = ${id}` as SignableDocument[];
  if (!doc) return c.json({ error: 'Documento non trovato' }, 404);
  if (!['draft', 'sent'].includes(doc.status)) return c.json({ error: 'Documento non inviabile' }, 409);

  const signUrl = `${publicBaseUrl()}/firma/${doc.sign_token}`;
  const target = doc.signature_method === 'sms_otp' ? doc.signer_phone : doc.signer_email;

  if (doc.signature_method === 'sms_otp') {
    if (!doc.signer_phone) return c.json({ error: 'Telefono firmatario non configurato' }, 400);
    if (!isSmsConfigured()) return c.json({ error: 'SMS non configurato' }, 400);
    const sms = await sendSms({
      to: doc.signer_phone,
      body: `Documento da firmare "${doc.title}": ${signUrl}`,
    });
    if (!sms.success) return c.json({ error: 'Invio link firma fallito' }, 502);
  } else {
    if (!doc.signer_email) return c.json({ error: 'Email firmatario non configurata' }, 400);
    const email = await sendEmail({
      to: doc.signer_email,
      subject: `Documento da firmare: ${doc.title}`,
      html: `<p>Puoi firmare il documento <strong>${htmlEscape(doc.title)}</strong> da questo link:</p><p><a href="${htmlEscape(signUrl)}">${htmlEscape(signUrl)}</a></p>`,
      text: `Puoi firmare il documento "${doc.title}" da questo link: ${signUrl}`,
      transport: 'critical',
    });
    if (!email.success) return c.json({ error: 'Invio link firma fallito' }, 502);
  }

  const [updated] = await sql`
    UPDATE signable_documents
    SET status = 'sent', sent_at = now()
    WHERE id = ${id}
    RETURNING *
  ` as SignableDocument[];

  const { ip, ua } = extractIpUa({ header: (name) => c.req.header(name) });
  await writeAuditLog({
    signableId: id,
    action: 'sent',
    ipAddress: ip,
    userAgent: ua,
    metadata: { method: doc.signature_method, target },
  });

  return c.json({ document: updated, sign_url: signUrl });
});

signables.delete('/:id', async (c) => {
  const { id } = c.req.param();
  if (!isUuid(id)) return c.json({ error: 'ID non valido' }, 400);
  const [doc] = await sql`
    SELECT id, status
    FROM signable_documents
    WHERE id = ${id}
  ` as Array<{ id: string; status: string }>;
  if (!doc) return c.json({ error: 'Documento non trovato' }, 404);
  if (doc.status === 'signed') return c.json({ error: 'Documento firmato non cancellabile' }, 409);

  await sql`
    UPDATE signable_documents
    SET status = 'cancelled'
    WHERE id = ${id}
  `;

  const { ip, ua } = extractIpUa({ header: (name) => c.req.header(name) });
  await writeAuditLog({
    signableId: id,
    action: 'cancelled',
    ipAddress: ip,
    userAgent: ua,
    metadata: { previous_status: doc.status },
  });

  return c.json({ success: true });
});
