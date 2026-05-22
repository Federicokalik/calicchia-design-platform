/**
 * WhatsApp routes — GOWA integration.
 *
 * Esporta due Hono app:
 *   - whatsappPublic  → POST /webhook (no auth, verifica HMAC GOWA_WEBHOOK_SECRET)
 *   - whatsappAdmin   → tutti gli endpoint /api/whatsapp-admin/* (auth required)
 *
 * Mount in apps/api/src/app.ts:
 *   app.use('/api/whatsapp/webhook', createRateLimit(60, 60_000));
 *   app.route('/api/whatsapp', whatsappPublic);
 *   // dopo l'auth middleware:
 *   app.route('/api/whatsapp-admin', whatsappAdmin);
 *   // E aggiungere '/api/whatsapp-admin' a protectedPaths in app.ts.
 */

import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { sql } from '../db';
import { signFileUrl } from '../lib/private-files';
import {
  sendWhatsAppText,
  sendWhatsAppMedia,
  getWhatsAppStatus,
  linkWhatsAppDevice,
  logoutWhatsAppDevice,
  reconnectWhatsAppDevice,
  markChatRead,
  formatPhone,
  isWhatsAppConfigured,
} from '../lib/whatsapp';
import {
  canSendWhatsApp,
  applyStopAll,
  applyStopMarketing,
  type WhatsAppCategory,
} from '../lib/whatsapp-policy';
import { runWhatsAppTriage } from '../lib/ai/whatsapp-triage';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'whatsapp-webhook' });

const GOWA_WEBHOOK_SECRET = process.env.GOWA_WEBHOOK_SECRET || '';

// =====================================================
// PUBLIC ROUTES (no auth, HMAC verified)
// =====================================================

export const whatsappPublic = new Hono();

/**
 * Webhook ingress da GOWA.
 * Header: x-hmac-signature: <hex sha256 del raw body con GOWA_WEBHOOK_SECRET>
 * Tutti gli errori ritornano 404 generico (no enumeration, allineato al
 * webhook workflow ingress in app.ts).
 */
whatsappPublic.post('/webhook', async (c) => {
  if (!GOWA_WEBHOOK_SECRET) return c.json({ error: 'Not Found' }, 404);

  const rawBody = await c.req.text();
  const sigHeader = (c.req.header('x-hmac-signature') || c.req.header('X-Hmac-Signature') || '').trim();
  if (!sigHeader) return c.json({ error: 'Not Found' }, 404);

  // GOWA invia "sha256=<hex>" oppure solo "<hex>". Accettiamo entrambi.
  const candidate = sigHeader.startsWith('sha256=') ? sigHeader.slice(7) : sigHeader;
  const expectedHex = createHmac('sha256', GOWA_WEBHOOK_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(expectedHex, 'hex');
  if (a.length !== b.length || a.length === 0 || !timingSafeEqual(a, b)) {
    return c.json({ error: 'Not Found' }, 404);
  }

  let payload: any = {};
  try { payload = rawBody ? JSON.parse(rawBody) : {}; } catch { return c.json({ ok: true }); }

  try {
    await handleGowaEvent(payload);
  } catch (err) {
    // Non rilanciamo: GOWA si attende 2xx. Errori interni a Bugsink.
    log.error({ err }, 'handler failed');
  }
  return c.json({ ok: true });
});

// =====================================================
// Webhook event dispatcher
// =====================================================

interface GowaEvent {
  event?: string;
  device_id?: string;
  payload?: any;
  // Alcuni endpoint GOWA mandano payload "flat" senza wrapper.
  [k: string]: any;
}

async function handleGowaEvent(evt: GowaEvent): Promise<void> {
  const eventName = evt.event || evt?.payload?.event || 'message';
  const payload = evt.payload ?? evt;

  switch (eventName) {
    case 'message':
      await handleMessageEvent(payload);
      break;
    case 'message.ack':
      await handleAckEvent(payload);
      break;
    case 'message.reaction':
      await handleReactionEvent(payload);
      break;
    case 'message.revoked':
    case 'message.deleted':
      await handleRevokeEvent(payload);
      break;
    case 'message.edited':
      await handleEditEvent(payload);
      break;
    default:
      // group.*, newsletter.*, call.offer → log-only fase 1
      log.info({ eventName }, 'unhandled event');
  }
}

// ----- message inbound -----

function extractMessageBody(p: any): string {
  return (
    p?.message?.text
    || p?.message?.body
    || p?.message?.conversation
    || p?.text
    || p?.body
    || p?.message?.image?.caption
    || p?.message?.video?.caption
    || p?.message?.document?.caption
    || ''
  ).toString();
}

function extractMessageType(p: any): string {
  if (p?.message?.text || p?.message?.conversation || p?.text) return 'text';
  if (p?.message?.image) return 'image';
  if (p?.message?.video) return 'video';
  if (p?.message?.audio || p?.message?.ptt) return 'audio';
  if (p?.message?.document) return 'document';
  if (p?.message?.sticker) return 'sticker';
  if (p?.message?.location) return 'location';
  if (p?.message?.contacts || p?.message?.contact) return 'contact';
  return 'text';
}

function chatIdToPhone(chatId: string): string {
  // chatId in formato "<phone>@s.whatsapp.net" o "<phone>@c.us"
  return chatId.split('@')[0].replace(/[^0-9]/g, '');
}

async function ensureConversation(opts: {
  chatId: string;
  phone: string;
  contactName?: string;
  isGroup: boolean;
}): Promise<{ id: string; aiMode: 'off' | 'triage' | 'auto_reply' }> {
  const existing = await sql`
    SELECT id, ai_mode FROM whatsapp_conversations WHERE chat_id = ${opts.chatId} LIMIT 1
  ` as Array<{ id: string; ai_mode: 'off' | 'triage' | 'auto_reply' }>;
  if (existing[0]) {
    // Aggiorna contact_name se vuoto
    if (opts.contactName) {
      await sql`
        UPDATE whatsapp_conversations
        SET contact_name = COALESCE(NULLIF(contact_name, ''), ${opts.contactName})
        WHERE id = ${existing[0].id}
      `;
    }
    return { id: existing[0].id, aiMode: existing[0].ai_mode };
  }

  // Auto-link a customer / lead per phone match.
  const phone = opts.phone;
  const customer = await sql`
    SELECT id FROM customers
    WHERE phone IS NOT NULL AND regexp_replace(phone, '[^0-9]', '', 'g') = ${phone}
    LIMIT 1
  ` as Array<{ id: string }>;
  const lead = customer[0]
    ? []
    : (await sql`
        SELECT id FROM leads
        WHERE phone IS NOT NULL AND regexp_replace(phone, '[^0-9]', '', 'g') = ${phone}
        LIMIT 1
      ` as Array<{ id: string }>);

  // ai_mode di default dal site_settings.whatsapp.default_ai_mode (best-effort).
  let defaultAiMode: 'off' | 'triage' | 'auto_reply' = 'off';
  try {
    const settings = await sql`
      SELECT value FROM site_settings WHERE key = 'whatsapp' LIMIT 1
    ` as Array<{ value: any }>;
    const v = settings[0]?.value;
    const parsed = typeof v === 'string' ? JSON.parse(v) : v;
    if (parsed?.default_ai_mode && ['off', 'triage', 'auto_reply'].includes(parsed.default_ai_mode)) {
      defaultAiMode = parsed.default_ai_mode;
    }
  } catch { /* ignore */ }

  const inserted = await sql`
    INSERT INTO whatsapp_conversations
      (chat_id, phone, contact_name, is_group, customer_id, lead_id, ai_mode)
    VALUES
      (${opts.chatId}, ${opts.phone}, ${opts.contactName ?? null}, ${opts.isGroup},
       ${customer[0]?.id ?? null}, ${lead[0]?.id ?? null}, ${defaultAiMode})
    RETURNING id, ai_mode
  ` as Array<{ id: string; ai_mode: 'off' | 'triage' | 'auto_reply' }>;
  return { id: inserted[0].id, aiMode: inserted[0].ai_mode };
}

async function handleMessageEvent(p: any): Promise<void> {
  // GOWA payload shape (semplificato): { from, chat_id, message:{...}, id, push_name, timestamp, from_me }
  const chatId: string = p?.chat_id || p?.from || p?.key?.remoteJid || '';
  if (!chatId) return;
  // Ignoriamo i nostri stessi outbound (li registriamo già lato admin send).
  if (p?.from_me === true || p?.fromMe === true || p?.key?.fromMe === true) return;

  const phone = chatIdToPhone(chatId);
  const isGroup = chatId.endsWith('@g.us');
  const contactName = (p?.push_name || p?.pushName || p?.notify || '').toString() || undefined;
  const body = extractMessageBody(p);
  const type = extractMessageType(p);
  const externalId: string | undefined = p?.id || p?.key?.id || p?.message_id;

  const conv = await ensureConversation({ chatId, phone, contactName, isGroup });

  // Handler STOP / opt-out (solo se text)
  if (type === 'text' && body) {
    const norm = body.trim().toUpperCase();
    if (norm === 'STOP' || norm === 'STOP ALL') {
      try { await applyStopAll(phone, 'wa-stop'); } catch { /* ignore */ }
      try {
        await sendWhatsAppText(
          phone,
          'Ricevuto. Hai disattivato i messaggi non essenziali. Per riattivarli o modificare le preferenze: '
            + buildPreferencesLink(phone)
        );
      } catch { /* ignore */ }
    } else if (norm === 'STOP MARKETING' || norm === 'NO MARKETING') {
      try { await applyStopMarketing(phone, 'wa-stop'); } catch { /* ignore */ }
      try {
        await sendWhatsAppText(
          phone,
          'Ricevuto. Non riceverai più messaggi promozionali. Continui a ricevere reminder e comunicazioni di servizio.'
        );
      } catch { /* ignore */ }
    }
  }

  // Insert messaggio inbound + bump conversation.
  await sql`
    INSERT INTO whatsapp_messages
      (conversation_id, external_id, direction, category, type, body, sender_kind, meta)
    VALUES
      (${conv.id}, ${externalId ?? null}, 'inbound', 'inbound', ${type}, ${body || null}, 'user',
       ${sql.json({
         media_pending: type !== 'text' && type !== 'reaction' && type !== 'system',
         raw: stripBig(p),
       })})
    ON CONFLICT DO NOTHING
  `;
  await sql`
    UPDATE whatsapp_conversations
    SET last_message_at = now(),
        last_message_preview = ${(body || `[${type}]`).slice(0, 200)},
        unread_count = unread_count + 1
    WHERE id = ${conv.id}
  `;

  // Trigger AI triage (best-effort, non blocca il webhook).
  if (conv.aiMode !== 'off' && type === 'text' && body) {
    runWhatsAppTriage(conv.id, body).catch(() => { /* logged inside */ });
  }
}

function buildPreferencesLink(phone: string): string {
  const base = (process.env.WHATSAPP_PUBLIC_BASE_URL || process.env.PUBLIC_SITE_URL || '').replace(/\/+$/, '');
  // Per ora generiamo un link generico (l'utente troverà la preference page);
  // se vogliamo token nel link, il caller deve risolverlo. Qui mettiamo un fallback.
  return `${base}/preferenze?phone=${encodeURIComponent(formatPhone(phone))}`;
}

function stripBig(p: any): any {
  // Toglie campi probabilmente grandi (media base64 inline) prima di salvare in meta.
  if (!p || typeof p !== 'object') return p;
  const copy: Record<string, any> = {};
  for (const [k, v] of Object.entries(p)) {
    if (typeof v === 'string' && v.length > 2000) continue;
    if (k === 'message' && typeof v === 'object' && v) {
      const m: Record<string, any> = {};
      for (const [mk, mv] of Object.entries(v as Record<string, unknown>)) {
        if (typeof mv === 'string' && mv.length > 2000) continue;
        m[mk] = mv;
      }
      copy[k] = m;
    } else {
      copy[k] = v;
    }
  }
  return copy;
}

// ----- ack -----
async function handleAckEvent(p: any): Promise<void> {
  const externalId: string = p?.id || p?.message_id || p?.key?.id;
  if (!externalId) return;
  const status: string = p?.status || p?.ack || '';
  if (!status) return;
  await sql`
    UPDATE whatsapp_messages
    SET ack_status = ${String(status).toLowerCase()}
    WHERE external_id = ${externalId}
  `;
}

// ----- reaction -----
async function handleReactionEvent(p: any): Promise<void> {
  const chatId: string = p?.chat_id || p?.from || '';
  if (!chatId) return;
  const phone = chatIdToPhone(chatId);
  const conv = await ensureConversation({
    chatId,
    phone,
    contactName: p?.push_name,
    isGroup: chatId.endsWith('@g.us'),
  });
  await sql`
    INSERT INTO whatsapp_messages
      (conversation_id, direction, category, type, body, sender_kind, meta)
    VALUES
      (${conv.id}, 'inbound', 'inbound', 'reaction', ${(p?.reaction || p?.emoji || '').toString() || null}, 'user',
       ${sql.json({ target: p?.target || p?.message_id || null })})
  `;
}

// ----- revoke/delete/edit (soft markers) -----
async function handleRevokeEvent(p: any): Promise<void> {
  const externalId: string = p?.id || p?.message_id || p?.key?.id;
  if (!externalId) return;
  await sql`
    UPDATE whatsapp_messages
    SET meta = meta || ${sql.json({ revoked: true, revoked_at: new Date().toISOString() })}
    WHERE external_id = ${externalId}
  `;
}

async function handleEditEvent(p: any): Promise<void> {
  const externalId: string = p?.id || p?.message_id || p?.key?.id;
  if (!externalId) return;
  const newBody = extractMessageBody(p);
  await sql`
    UPDATE whatsapp_messages
    SET body = ${newBody || null},
        meta = meta || ${sql.json({ edited: true, edited_at: new Date().toISOString() })}
    WHERE external_id = ${externalId}
  `;
}

// =====================================================
// ADMIN ROUTES (protected by auth middleware in app.ts)
// =====================================================

export const whatsappAdmin = new Hono();

type ApiUser = { id: string; email: string; role: string };

function getUser(c: any): ApiUser | null {
  return (c.get('user') as ApiUser | null) || null;
}

// --- Session status / linking ---

whatsappAdmin.get('/status', async (c) => {
  if (!isWhatsAppConfigured()) {
    return c.json({ configured: false, connected: false, reason: 'GOWA_URL non impostato' });
  }
  const status = await getWhatsAppStatus();
  // Sync su whatsapp_sessions per audit.
  if (status.connected && status.deviceId) {
    await sql`
      INSERT INTO whatsapp_sessions (device_id, display_name, phone, status, last_seen_at)
      VALUES (${status.deviceId}, ${status.displayName ?? null}, ${status.phone ?? null}, 'connected', now())
      ON CONFLICT (device_id) DO UPDATE
        SET display_name = EXCLUDED.display_name,
            phone = EXCLUDED.phone,
            status = 'connected',
            last_seen_at = now(),
            updated_at = now()
    `;
  }
  return c.json({ configured: true, ...status });
});

whatsappAdmin.post('/link', async (c) => {
  try {
    const data = await linkWhatsAppDevice();
    return c.json({ ok: true, ...data });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 502);
  }
});

whatsappAdmin.post('/logout', async (c) => {
  try {
    await logoutWhatsAppDevice();
    if (process.env.GOWA_DEVICE_ID) {
      await sql`
        UPDATE whatsapp_sessions SET status = 'disconnected', last_seen_at = now()
        WHERE device_id = ${process.env.GOWA_DEVICE_ID}
      `;
    }
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 502);
  }
});

whatsappAdmin.post('/reconnect', async (c) => {
  try { await reconnectWhatsAppDevice(); return c.json({ ok: true }); }
  catch (err) { return c.json({ ok: false, error: (err as Error).message }, 502); }
});

// --- Conversations ---

whatsappAdmin.get('/conversations', async (c) => {
  const archived = c.req.query('archived') === '1';
  const q = c.req.query('q');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const offset = parseInt(c.req.query('offset') || '0');
  const archFilter = archived ? sql`AND wc.archived = TRUE` : sql`AND wc.archived = FALSE`;
  const searchFilter = q
    ? sql`AND (wc.contact_name ILIKE ${'%' + q + '%'} OR wc.phone ILIKE ${'%' + q + '%'} OR wc.last_message_preview ILIKE ${'%' + q + '%'})`
    : sql``;
  const rows = await sql`
    SELECT wc.*,
      c.contact_name AS customer_name, c.company_name,
      l.name AS lead_name,
      COUNT(*) OVER() AS _total_count
    FROM whatsapp_conversations wc
    LEFT JOIN customers c ON c.id = wc.customer_id
    LEFT JOIN leads l ON l.id = wc.lead_id
    WHERE 1=1 ${archFilter} ${searchFilter}
    ORDER BY wc.last_message_at DESC NULLS LAST
    LIMIT ${limit} OFFSET ${offset}
  `;
  return c.json({ conversations: rows });
});

whatsappAdmin.get('/conversations/:id', async (c) => {
  const id = c.req.param('id');
  const rows = await sql`
    SELECT wc.*,
      c.contact_name AS customer_name, c.company_name, c.email AS customer_email,
      l.name AS lead_name, l.email AS lead_email
    FROM whatsapp_conversations wc
    LEFT JOIN customers c ON c.id = wc.customer_id
    LEFT JOIN leads l ON l.id = wc.lead_id
    WHERE wc.id = ${id} LIMIT 1
  `;
  if (!rows.length) return c.json({ error: 'Not Found' }, 404);
  return c.json(rows[0]);
});

whatsappAdmin.get('/conversations/:id/messages', async (c) => {
  const id = c.req.param('id');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const before = c.req.query('before');
  const beforeFilter = before ? sql`AND created_at < ${before}` : sql``;
  const rows = await sql`
    SELECT * FROM whatsapp_messages
    WHERE conversation_id = ${id} ${beforeFilter}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  // SEC-10: media lives in the private store — expose a signed URL, not a path.
  const messages = rows.reverse().map((m) => ({
    ...m,
    media_url:
      typeof m.media_path === 'string' && /^[A-Za-z0-9._-]+$/.test(m.media_path)
        ? signFileUrl('whatsapp', m.media_path)
        : null,
  }));
  return c.json({ messages });
});

whatsappAdmin.post('/conversations/:id/messages', async (c) => {
  const user = getUser(c);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const text: string | undefined = body?.text;
  const mediaPath: string | undefined = body?.mediaPath;
  const mediaUrl: string | undefined = body?.mediaUrl;
  const mediaCaption: string = body?.caption || '';
  const fileName: string = body?.fileName || 'file.pdf';
  const mimetype: string = body?.mimetype || 'application/pdf';
  const category: WhatsAppCategory = (body?.category as WhatsAppCategory) || 'operational';

  if (!text && !mediaPath && !mediaUrl) {
    return c.json({ error: 'Empty message' }, 400);
  }

  const convRows = await sql`SELECT id, phone, customer_id, lead_id FROM whatsapp_conversations WHERE id = ${id} LIMIT 1` as Array<{ id: string; phone: string; customer_id: string | null; lead_id: string | null }>;
  if (!convRows.length) return c.json({ error: 'Not Found' }, 404);
  const conv = convRows[0];

  const policy = await canSendWhatsApp(conv.phone, category, {
    customerId: conv.customer_id,
    leadId: conv.lead_id,
  });
  if (!policy.allowed) {
    return c.json({ error: 'opt_out', reason: policy.reason }, 403);
  }

  try {
    let externalId: string | undefined;
    if (text && !mediaPath && !mediaUrl) {
      const res = await sendWhatsAppText(conv.phone, text);
      externalId = res.externalId;
    } else {
      const url = mediaUrl
        ? mediaUrl
        : `${process.env.PUBLIC_API_URL || ''}/media/${mediaPath}`;
      const res = await sendWhatsAppMedia(conv.phone, mediaCaption || text || '', url, fileName, mimetype);
      externalId = res.externalId;
    }
    const msgRows = await sql`
      INSERT INTO whatsapp_messages
        (conversation_id, external_id, direction, category, type, body, media_path, media_mime, sender_kind, sender_user_id, meta)
      VALUES
        (${conv.id}, ${externalId ?? null}, 'outbound', ${category},
         ${text && !mediaPath && !mediaUrl ? 'text' : (mimetype.startsWith('image/') ? 'image' : 'document')},
         ${text ?? mediaCaption ?? null},
         ${mediaPath ?? null}, ${mediaPath ? mimetype : null},
         'admin', ${user?.id ?? null}, ${sql.json({})})
      RETURNING id
    ` as Array<{ id: string }>;
    await sql`
      UPDATE whatsapp_conversations
      SET last_message_at = now(),
          last_message_preview = ${(text || mediaCaption || '[allegato]').slice(0, 200)},
          unread_count = 0
      WHERE id = ${conv.id}
    `;
    return c.json({ ok: true, id: msgRows[0].id, externalId });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 502);
  }
});

whatsappAdmin.post('/conversations/:id/ai-mode', async (c) => {
  const id = c.req.param('id');
  const { ai_mode } = await c.req.json().catch(() => ({} as any));
  if (!['off', 'triage', 'auto_reply'].includes(ai_mode)) {
    return c.json({ error: 'invalid ai_mode' }, 400);
  }
  await sql`UPDATE whatsapp_conversations SET ai_mode = ${ai_mode}, updated_at = now() WHERE id = ${id}`;
  return c.json({ ok: true });
});

whatsappAdmin.post('/conversations/:id/read', async (c) => {
  const id = c.req.param('id');
  const rows = await sql`SELECT chat_id FROM whatsapp_conversations WHERE id = ${id} LIMIT 1` as Array<{ chat_id: string }>;
  if (!rows.length) return c.json({ error: 'Not Found' }, 404);
  await sql`UPDATE whatsapp_conversations SET unread_count = 0 WHERE id = ${id}`;
  try { await markChatRead(rows[0].chat_id); } catch { /* ignore */ }
  return c.json({ ok: true });
});

whatsappAdmin.post('/conversations/:id/archive', async (c) => {
  const id = c.req.param('id');
  const { archived } = await c.req.json().catch(() => ({} as any));
  await sql`UPDATE whatsapp_conversations SET archived = ${Boolean(archived)} WHERE id = ${id}`;
  return c.json({ ok: true });
});

whatsappAdmin.post('/conversations/:id/link', async (c) => {
  const id = c.req.param('id');
  const { customer_id = null, lead_id = null } = await c.req.json().catch(() => ({} as any));
  await sql`UPDATE whatsapp_conversations SET customer_id = ${customer_id}, lead_id = ${lead_id} WHERE id = ${id}`;
  return c.json({ ok: true });
});

// Approve / discard AI draft.
whatsappAdmin.post('/messages/:msgId/approve', async (c) => {
  const user = getUser(c);
  const msgId = c.req.param('msgId');
  const rows = await sql`
    SELECT m.id, m.body, m.conversation_id, m.ai_draft, m.ai_draft_approved_at,
           wc.phone, wc.customer_id, wc.lead_id
    FROM whatsapp_messages m
    JOIN whatsapp_conversations wc ON wc.id = m.conversation_id
    WHERE m.id = ${msgId} LIMIT 1
  ` as Array<{ id: string; body: string | null; conversation_id: string; ai_draft: boolean; ai_draft_approved_at: Date | null; phone: string; customer_id: string | null; lead_id: string | null }>;
  if (!rows.length) return c.json({ error: 'Not Found' }, 404);
  const m = rows[0];
  if (!m.ai_draft || m.ai_draft_approved_at) return c.json({ error: 'not_draft' }, 400);
  if (!m.body) return c.json({ error: 'empty' }, 400);

  const policy = await canSendWhatsApp(m.phone, 'operational', { customerId: m.customer_id, leadId: m.lead_id });
  if (!policy.allowed) return c.json({ error: 'opt_out', reason: policy.reason }, 403);

  try {
    const res = await sendWhatsAppText(m.phone, m.body);
    await sql`
      UPDATE whatsapp_messages
      SET ai_draft_approved_at = now(),
          ai_draft_approved_by = ${user?.id ?? null},
          external_id = ${res.externalId ?? null}
      WHERE id = ${m.id}
    `;
    await sql`
      UPDATE whatsapp_conversations
      SET last_message_at = now(),
          last_message_preview = ${m.body.slice(0, 200)}
      WHERE id = ${m.conversation_id}
    `;
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 502);
  }
});

whatsappAdmin.post('/messages/:msgId/discard', async (c) => {
  const msgId = c.req.param('msgId');
  await sql`DELETE FROM whatsapp_messages WHERE id = ${msgId} AND ai_draft = TRUE AND ai_draft_approved_at IS NULL`;
  return c.json({ ok: true });
});

whatsappAdmin.patch('/messages/:msgId', async (c) => {
  const msgId = c.req.param('msgId');
  const { body } = await c.req.json().catch(() => ({} as any));
  if (typeof body !== 'string') return c.json({ error: 'invalid body' }, 400);
  await sql`UPDATE whatsapp_messages SET body = ${body} WHERE id = ${msgId} AND ai_draft = TRUE AND ai_draft_approved_at IS NULL`;
  return c.json({ ok: true });
});

// --- "Send WA" from contact page: find-or-create conversation by phone ---
whatsappAdmin.post('/send-to-phone', async (c) => {
  const user = getUser(c);
  const { phone, text, category = 'operational', customerId = null, leadId = null } = await c.req.json().catch(() => ({} as any));
  if (!phone || !text) return c.json({ error: 'phone and text required' }, 400);
  const normalized = formatPhone(phone);
  const chatId = `${normalized}@s.whatsapp.net`;

  const policy = await canSendWhatsApp(normalized, category as WhatsAppCategory, { customerId, leadId });
  if (!policy.allowed) return c.json({ error: 'opt_out', reason: policy.reason }, 403);

  const conv = await ensureConversation({ chatId, phone: normalized, isGroup: false });
  if (customerId || leadId) {
    await sql`UPDATE whatsapp_conversations SET customer_id = ${customerId}, lead_id = ${leadId} WHERE id = ${conv.id}`;
  }
  try {
    const res = await sendWhatsAppText(normalized, text);
    await sql`
      INSERT INTO whatsapp_messages
        (conversation_id, external_id, direction, category, type, body, sender_kind, sender_user_id)
      VALUES (${conv.id}, ${res.externalId ?? null}, 'outbound', ${category}, 'text', ${text}, 'admin', ${user?.id ?? null})
    `;
    await sql`
      UPDATE whatsapp_conversations
      SET last_message_at = now(), last_message_preview = ${text.slice(0, 200)}, unread_count = 0
      WHERE id = ${conv.id}
    `;
    return c.json({ ok: true, conversationId: conv.id });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 502);
  }
});
