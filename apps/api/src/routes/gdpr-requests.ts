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

// GDPR-03 — Erasure policy. Three categories, applied atomically:
//
//  • DELETE — pure-PII records with no retention obligation:
//      contacts, newsletter_subscribers, communication_preferences,
//      whatsapp_conversations (whatsapp_messages cascade), portal_login_events.
//
//  • ANONYMIZE — records that cannot be deleted because fiscal/contractual
//      children (invoices, payments, quotes) reference them under a 10-year
//      legal retention obligation, and the FKs are RESTRICT/NO ACTION/CASCADE
//      (a hard DELETE would either be blocked or destroy fiscal records):
//      customers, leads. Identifying fields are overwritten; the row and its
//      fiscal links survive in anonymized form.
//
//  • RETAINED / MANUAL — not touched here, surfaced in the response:
//      invoices/payments/quotes (legal retention), email_messages (mailbox
//      correspondence — controller's business record, manual review),
//      client_uploads files on storage, and the Stripe customer (separate
//      processor). cookie_consents/analytics hold no person-linkable PII.
gdprRequests.delete('/erase/:email', authMiddleware, async (c) => {
  const email = decodeURIComponent(c.req.param('email'));

  // Resolve linked records BEFORE anonymizing (anonymization changes the email).
  const linked = await sql`
    SELECT id, 'customer' AS kind FROM customers WHERE email = ${email}
    UNION ALL
    SELECT id, 'lead' AS kind FROM leads WHERE email = ${email}
  ` as Array<{ id: string; kind: 'customer' | 'lead' }>;
  const customerIds = linked.filter(r => r.kind === 'customer').map(r => r.id);
  const leadIds = linked.filter(r => r.kind === 'lead').map(r => r.id);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await sql.begin(async (tx: any) => {
    const deletedContacts = await tx`DELETE FROM contacts WHERE email = ${email} RETURNING id`;
    const deletedNewsletter = await tx`DELETE FROM newsletter_subscribers WHERE email = ${email} RETURNING id`;
    const deletedPrefs = await tx`
      DELETE FROM communication_preferences
      WHERE email = ${email}
         OR customer_id = ANY(${customerIds as any})
         OR lead_id = ANY(${leadIds as any}) RETURNING id`;
    const deletedWaConvs = customerIds.length || leadIds.length
      ? await tx`
          DELETE FROM whatsapp_conversations
          WHERE customer_id = ANY(${customerIds as any})
             OR lead_id = ANY(${leadIds as any}) RETURNING id`
      : [];
    const deletedLoginEvents = await tx`
      DELETE FROM portal_login_events
      WHERE email = ${email} OR customer_id = ANY(${customerIds as any}) RETURNING id`;

    // Anonymize customers — keep the row (fiscal children) but strip PII.
    const anonCustomers = customerIds.length
      ? await tx`
          UPDATE customers SET
            contact_name = 'Dato cancellato (GDPR)',
            company_name = NULL,
            email = 'erased-' || id::text || '@deleted.invalid',
            phone = NULL,
            billing_address = '{}'::jsonb,
            notes = NULL,
            tags = '[]'::jsonb,
            portal_access_code_hash = NULL,
            updated_at = NOW()
          WHERE id = ANY(${customerIds as any}) RETURNING id`
      : [];
    const anonLeads = leadIds.length
      ? await tx`
          UPDATE leads SET
            name = 'Dato cancellato (GDPR)',
            company = NULL,
            email = 'erased-' || id::text || '@deleted.invalid',
            phone = NULL,
            notes = NULL,
            tags = '{}'::text[],
            updated_at = NOW()
          WHERE id = ANY(${leadIds as any}) RETURNING id`
      : [];

    return {
      deletedContacts: deletedContacts.length,
      deletedNewsletter: deletedNewsletter.length,
      deletedPrefs: deletedPrefs.length,
      deletedWaConvs: deletedWaConvs.length,
      deletedLoginEvents: deletedLoginEvents.length,
      anonCustomers: anonCustomers.length,
      anonLeads: anonLeads.length,
    };
  });

  return c.json({
    erased: true,
    email,
    deleted: {
      contacts: result.deletedContacts,
      newsletter: result.deletedNewsletter,
      communication_preferences: result.deletedPrefs,
      whatsapp_conversations: result.deletedWaConvs,
      portal_login_events: result.deletedLoginEvents,
    },
    anonymized: {
      customers: result.anonCustomers,
      leads: result.anonLeads,
    },
    retained: 'Fatture, pagamenti e preventivi sono conservati per obbligo fiscale (10 anni); il cliente collegato è stato anonimizzato.',
    manual_followup: [
      "Verificare ed eventualmente eliminare la corrispondenza dell'interessato nella casella email (email_messages).",
      'Eliminare dallo storage i file caricati collegati (client_uploads).',
      "Se l'interessato esiste come cliente Stripe, richiedere la cancellazione anche lì (responsabile esterno).",
    ],
  });
});
