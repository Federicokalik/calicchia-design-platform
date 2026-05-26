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
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { sql } from '../db';
import { signFileUrl, savePrivateFile } from '../lib/private-files';
import {
  sendWhatsAppText,
  sendWhatsAppMedia,
  sendWhatsAppReaction,
  getWhatsAppStatus,
  linkWhatsAppDevice,
  logoutWhatsAppDevice,
  reconnectWhatsAppDevice,
  markChatRead,
  formatPhone,
  isWhatsAppConfigured,
  fetchGowaChats,
  fetchGowaChatMessages,
  type GowaChat,
  type GowaChatMessage,
} from '../lib/whatsapp';
import {
  canSendWhatsApp,
  applyStopAll,
  applyStopMarketing,
  type WhatsAppCategory,
} from '../lib/whatsapp-policy';
import { runWhatsAppTriage } from '../lib/ai/whatsapp-triage';
import { logger } from '../lib/logger';
import { publishWaEvent, subscribeWaEvents } from '../lib/whatsapp-events';
import { extname } from 'node:path';

const log = logger.child({ scope: 'whatsapp-webhook' });

const GOWA_WEBHOOK_SECRET = process.env.GOWA_WEBHOOK_SECRET || '';

// =====================================================
// PUBLIC ROUTES (no auth, HMAC verified)
// =====================================================

export const whatsappPublic = new Hono();

/**
 * Webhook ingress da GOWA.
 * GOWA (go-whatsapp-web-multidevice v6+) invia l'header standard
 * `X-Hub-Signature-256: sha256=<hex>`. Per retrocompat accettiamo anche
 * `x-hmac-signature` (sia con sia senza prefisso `sha256=`).
 * Tutti gli errori ritornano 404 generico (no enumeration, allineato al
 * webhook workflow ingress in app.ts).
 */
whatsappPublic.post('/webhook', async (c) => {
  if (!GOWA_WEBHOOK_SECRET) return c.json({ error: 'Not Found' }, 404);

  const rawBody = await c.req.text();
  const sigHeader = (
    c.req.header('X-Hub-Signature-256')   // ← header ufficiale GOWA v6+
    || c.req.header('x-hub-signature-256')
    || c.req.header('x-hmac-signature')   // legacy / custom integrations
    || c.req.header('X-Hmac-Signature')
    || ''
  ).trim();
  if (!sigHeader) return c.json({ error: 'Not Found' }, 404);

  // GOWA invia "sha256=<hex>"; legacy mandano solo "<hex>". Accettiamo entrambi.
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
  const deviceId = evt.device_id || evt?.payload?.device_id || null;

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
    case 'chat_presence':
      // Persisti (audit) ma surface anche via SSE: lo UI mostra
      // "sta scrivendo…" sotto il nome del contatto.
      await persistSideChannelEvent(eventName, deviceId, payload);
      await emitTypingFromPresence(payload);
      break;
    case 'group.participants':
    case 'group.joined':
    case 'newsletter.joined':
    case 'newsletter.left':
    case 'newsletter.message':
    case 'newsletter.mute':
    case 'call.offer':
      // Eventi side-channel: persistiti in whatsapp_events_log per audit /
      // future UI dedicate. Niente proiezioni in whatsapp_conversations.
      await persistSideChannelEvent(eventName, deviceId, payload);
      break;
    default:
      log.info({ eventName }, 'unhandled event');
  }
}

// ----- side-channel events (group / newsletter / presence / call) -----

async function persistSideChannelEvent(
  eventType: string,
  deviceId: string | null,
  payload: any,
): Promise<void> {
  // chat_id / from_jid sono ottimisticamente estratti per indicizzazione,
  // ma il payload integrale resta in JSONB per non perdere informazione.
  const chatId = payload?.chat_id ?? payload?.group_id ?? payload?.newsletter_id ?? null;
  const fromJid =
    payload?.from ??
    payload?.participant ??
    payload?.caller ??
    payload?.from_jid ??
    null;

  try {
    await sql`
      INSERT INTO whatsapp_events_log (event_type, device_id, chat_id, from_jid, payload)
      VALUES (${eventType}, ${deviceId}, ${chatId}, ${fromJid}, ${sql.json(payload)})
    `;
  } catch (err) {
    log.error({ err, eventType }, 'failed to persist side-channel event');
  }
}

// Translates a GOWA chat_presence payload into the WaTypingEvent shape the
// admin SSE clients understand. Best-effort: if we can't resolve the
// conversation row (chat we haven't seen yet) we silently skip.
async function emitTypingFromPresence(payload: any): Promise<void> {
  const chatId: string | undefined = payload?.chat_id || payload?.from || payload?.to;
  if (!chatId) return;
  // GOWA reports `state` as composing | paused | recording (the WA protocol
  // values). Anything else we ignore.
  const rawState = (payload?.state || payload?.status || '').toString().toLowerCase();
  const state: 'composing' | 'recording' | 'paused' | null =
    rawState === 'composing' ? 'composing' :
    rawState === 'recording' ? 'recording' :
    rawState === 'paused' ? 'paused' : null;
  if (!state) return;
  const fromJid: string | null = payload?.participant || payload?.from_jid || null;

  try {
    const rows = await sql`
      SELECT id FROM whatsapp_conversations WHERE chat_id = ${chatId} LIMIT 1
    ` as Array<{ id: string }>;
    if (!rows.length) return;
    publishWaEvent({
      type: 'chat:typing',
      conversationId: rows[0].id,
      chatId,
      fromJid,
      state,
    });
  } catch { /* ignore */ }
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
  // Skip newsletter (canali WhatsApp) e broadcast — non sono chat 1:1/gruppo.
  // I newsletter.message dovrebbero arrivare come evento `newsletter.message`
  // (gia' persistiti in whatsapp_events_log), ma alcuni payload li mandano
  // come `event: message` con jid `@newsletter`. Defense in depth.
  if (chatId.endsWith('@newsletter') || chatId.endsWith('@broadcast') || chatId === 'status@broadcast') return;

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

  // GOWA may encode a "reply-to" reference in several shapes depending on
  // version. We try the common spots and fall back to null. The column has
  // existed since mig 096 but until now nothing wrote to it.
  const replyToExternalId: string | null =
    p?.quoted_message?.id
    || p?.quoted?.id
    || p?.context?.quoted_message_id
    || p?.message?.context_info?.quoted_message_id
    || p?.message?.context_info?.stanza_id
    || null;

  // Insert messaggio inbound + bump conversation.
  const insertedRows = await sql`
    INSERT INTO whatsapp_messages
      (conversation_id, external_id, direction, category, type, body, reply_to_external_id, sender_kind, meta)
    VALUES
      (${conv.id}, ${externalId ?? null}, 'inbound', 'inbound', ${type}, ${body || null}, ${replyToExternalId},
       'user',
       ${sql.json({
         media_pending: type !== 'text' && type !== 'reaction' && type !== 'system',
         push_name: contactName ?? null,
         raw: stripBig(p),
       })})
    ON CONFLICT DO NOTHING
    RETURNING id
  ` as Array<{ id: string }>;
  await sql`
    UPDATE whatsapp_conversations
    SET last_message_at = now(),
        last_message_preview = ${(body || `[${type}]`).slice(0, 200)},
        unread_count = unread_count + 1
    WHERE id = ${conv.id}
  `;

  if (insertedRows[0]?.id) {
    publishWaEvent({
      type: 'message:inserted',
      conversationId: conv.id,
      direction: 'inbound',
      messageId: insertedRows[0].id,
      externalId: externalId ?? null,
      unread: true,
    });
  }
  publishWaEvent({ type: 'conversation:updated', conversationId: conv.id, reason: 'message' });

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
  const norm = String(status).toLowerCase();
  if (!['sent', 'delivered', 'read'].includes(norm)) return;
  await sql`
    UPDATE whatsapp_messages
    SET ack_status = ${norm}
    WHERE external_id = ${externalId}
  `;
  publishWaEvent({ type: 'message:ack', externalId, status: norm as 'sent' | 'delivered' | 'read' });
}

// ----- reaction -----
// GOWA sends reactions as standalone events. We previously stored them as
// their own message row, which polluted the thread and broke counts. Now we
// look up the target message and merge the reaction into its `meta.reactions`
// jsonb array — exactly how WhatsApp renders them: an overlay on the original
// bubble, not a new bubble. If we can't find the target (e.g. reaction to a
// message that pre-dates our backfill) we fall back to inserting a standalone
// row so the operator at least sees something happened.
async function handleReactionEvent(p: any): Promise<void> {
  const chatId: string = p?.chat_id || p?.from || '';
  if (!chatId) return;
  const phone = chatIdToPhone(chatId);
  const isGroup = chatId.endsWith('@g.us');
  const conv = await ensureConversation({ chatId, phone, contactName: p?.push_name, isGroup });

  const emoji: string = (p?.reaction || p?.emoji || p?.message?.reaction?.text || '').toString();
  const targetExternalId: string | null =
    (typeof p?.target === 'string' && p.target)
    || p?.target?.id
    || p?.message_id
    || p?.reaction?.target_id
    || p?.message?.reaction?.key?.id
    || null;
  const from: string | null = p?.from_jid || p?.sender || p?.participant || null;
  const at = new Date().toISOString();

  if (targetExternalId) {
    const target = await sql`
      SELECT id, meta FROM whatsapp_messages
      WHERE external_id = ${targetExternalId} AND conversation_id = ${conv.id}
      LIMIT 1
    ` as Array<{ id: string; meta: Record<string, unknown> | null }>;
    if (target.length) {
      const existingMeta = target[0].meta || {};
      const reactions = Array.isArray((existingMeta as { reactions?: unknown }).reactions)
        ? ((existingMeta as { reactions: Array<{ emoji: string; from: string | null; at: string }> }).reactions)
        : [];
      // De-dup by sender: a contact replacing 👍 with ❤️ should overwrite, not stack.
      const filtered = from ? reactions.filter((r) => r.from !== from) : reactions;
      const next = emoji ? [...filtered, { emoji, from, at }] : filtered;
      await sql`
        UPDATE whatsapp_messages
        SET meta = meta || ${sql.json({ reactions: next })}
        WHERE id = ${target[0].id}
      `;
      publishWaEvent({ type: 'message:reaction', conversationId: conv.id, targetExternalId, emoji, from });
      return;
    }
  }

  // Fallback — target unknown, surface as a standalone row to preserve a trace.
  await sql`
    INSERT INTO whatsapp_messages
      (conversation_id, direction, category, type, body, sender_kind, meta)
    VALUES
      (${conv.id}, 'inbound', 'inbound', 'reaction', ${emoji || null}, 'user',
       ${sql.json({ target: targetExternalId, from })})
  `;
  publishWaEvent({ type: 'message:reaction', conversationId: conv.id, targetExternalId, emoji, from });
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
  const rows = await sql`
    UPDATE whatsapp_messages
    SET body = ${newBody || null},
        meta = meta || ${sql.json({ edited: true, edited_at: new Date().toISOString() })}
    WHERE external_id = ${externalId}
    RETURNING conversation_id
  ` as Array<{ conversation_id: string }>;
  if (rows[0]) {
    publishWaEvent({ type: 'conversation:updated', conversationId: rows[0].conversation_id, reason: 'message' });
  }
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

// Server-sent events: real-time push of conversation / message updates so the
// admin inbox can drop its 5s TanStack polling and feel instant. The handler
// keeps the connection open until the client disconnects; clients should
// listen for `message:inserted`, `message:ack`, `message:reaction` and
// `conversation:updated` events and invalidate the corresponding queries.
//
// A periodic comment line (`: heartbeat`) keeps reverse proxies from idling
// the socket out. Pattern lifted from `analytics.ts:/realtime/stream`.
whatsappAdmin.get('/stream', async (c) => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const safeSend = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch { /* closed */ }
      };

      // Tell the client we are live so it can mark the indicator "connected".
      safeSend('ready', { at: new Date().toISOString() });

      const unsubscribe = subscribeWaEvents((evt) => {
        safeSend(evt.type, evt);
      });

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch { /* closed */ }
      }, 30_000);

      c.req.raw.signal?.addEventListener('abort', () => {
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
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
      COALESCE(
        (SELECT array_agg(t.tag ORDER BY t.tag)
         FROM whatsapp_conversation_tags t WHERE t.conversation_id = wc.id),
        ARRAY[]::TEXT[]
      ) AS tags,
      COUNT(*) OVER() AS _total_count
    FROM whatsapp_conversations wc
    LEFT JOIN customers c ON c.id = wc.customer_id
    LEFT JOIN leads l ON l.id = wc.lead_id
    WHERE 1=1 ${archFilter} ${searchFilter}
    ORDER BY wc.pinned DESC, wc.last_message_at DESC NULLS LAST
    LIMIT ${limit} OFFSET ${offset}
  `;
  return c.json({ conversations: rows });
});

whatsappAdmin.get('/conversations/:id', async (c) => {
  const id = c.req.param('id');
  // Hierarchical opt-out lookup (mig 096): customer > lead > phone match.
  // We pull `whatsapp_marketing` / `whatsapp_operational` so the inbox can
  // surface a badge before the operator tries to send.
  const rows = await sql`
    SELECT wc.*,
      c.contact_name AS customer_name, c.company_name, c.email AS customer_email,
      l.name AS lead_name, l.email AS lead_email,
      COALESCE(
        (SELECT array_agg(t.tag ORDER BY t.tag)
         FROM whatsapp_conversation_tags t WHERE t.conversation_id = wc.id),
        ARRAY[]::TEXT[]
      ) AS tags,
      (SELECT MAX(m.created_at) FROM whatsapp_messages m
        WHERE m.conversation_id = wc.id AND m.direction = 'outbound'
      ) AS last_outbound_at,
      (SELECT COUNT(*) FROM whatsapp_scheduled_messages s
        WHERE s.conversation_id = wc.id AND s.sent_at IS NULL AND s.error IS NULL
      ) AS scheduled_pending,
      cp.whatsapp_marketing AS pref_marketing,
      cp.whatsapp_operational AS pref_operational,
      cp.whatsapp_transactional AS pref_transactional
    FROM whatsapp_conversations wc
    LEFT JOIN customers c ON c.id = wc.customer_id
    LEFT JOIN leads l ON l.id = wc.lead_id
    LEFT JOIN LATERAL (
      SELECT whatsapp_marketing, whatsapp_operational, whatsapp_transactional
      FROM communication_preferences
      WHERE (customer_id IS NOT NULL AND customer_id = wc.customer_id)
         OR (lead_id IS NOT NULL AND lead_id = wc.lead_id)
         OR (phone IS NOT NULL AND phone = wc.phone)
      ORDER BY
        (customer_id IS NOT NULL AND customer_id = wc.customer_id) DESC,
        (lead_id IS NOT NULL AND lead_id = wc.lead_id) DESC
      LIMIT 1
    ) cp ON TRUE
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

// Search within a single conversation. Returns matching message ids ordered
// newest-first so the UI can jump-scroll to them. We deliberately don't run
// a tsvector full-text index — chats are small (≤10k messages), ILIKE is
// fine, and bringing in tsvector would force schema migrations + tokenizer
// decisions per language that aren't worth it yet.
whatsappAdmin.get('/conversations/:id/search', async (c) => {
  const id = c.req.param('id');
  const q = (c.req.query('q') || '').trim();
  if (!q || q.length < 2) return c.json({ matches: [] });
  if (q.length > 200) return c.json({ error: 'query_too_long' }, 400);
  const pattern = `%${q}%`;
  const rows = await sql`
    SELECT id, body, created_at, direction
    FROM whatsapp_messages
    WHERE conversation_id = ${id}
      AND body ILIKE ${pattern}
    ORDER BY created_at DESC
    LIMIT 50
  ` as Array<{ id: string; body: string | null; created_at: string; direction: 'inbound' | 'outbound' }>;
  return c.json({ matches: rows });
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
  // Optional WhatsApp "reply-to" — quote a previous message. The external id
  // is the GOWA message id (UUID-ish string). We pass it through to GOWA so
  // the recipient sees the quoted message; we also store it locally so the
  // admin thread can render the quote card.
  const replyToExternalId: string | undefined = body?.reply_to?.external_id || body?.replyToExternalId;

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
      const res = await sendWhatsAppText(conv.phone, text, { replyToExternalId });
      externalId = res.externalId;
    } else {
      const url = mediaUrl
        ? mediaUrl
        : `${process.env.PUBLIC_API_URL || ''}/media/${mediaPath}`;
      const res = await sendWhatsAppMedia(conv.phone, mediaCaption || text || '', url, fileName, mimetype, { replyToExternalId });
      externalId = res.externalId;
    }
    const msgRows = await sql`
      INSERT INTO whatsapp_messages
        (conversation_id, external_id, direction, category, type, body, media_path, media_mime, reply_to_external_id, sender_kind, sender_user_id, meta)
      VALUES
        (${conv.id}, ${externalId ?? null}, 'outbound', ${category},
         ${text && !mediaPath && !mediaUrl ? 'text' : (mimetype.startsWith('image/') ? 'image' : 'document')},
         ${text ?? mediaCaption ?? null},
         ${mediaPath ?? null}, ${mediaPath ? mimetype : null},
         ${replyToExternalId ?? null},
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
    publishWaEvent({
      type: 'message:inserted',
      conversationId: conv.id,
      direction: 'outbound',
      messageId: msgRows[0].id,
      externalId: externalId ?? null,
      unread: false,
    });
    publishWaEvent({ type: 'conversation:updated', conversationId: conv.id, reason: 'message' });
    return c.json({ ok: true, id: msgRows[0].id, externalId });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 502);
  }
});

// Media upload — multipart endpoint. The browser uploads a single file, we
// persist it to PRIVATE_UPLOAD_DIR/whatsapp/<random>.<ext>, then forward to
// GOWA via signed URL (GOWA fetches it back over the public /api/files
// signed-URL route — no auth, capability-based). We never send file bytes
// to GOWA directly because GOWA's `/send/*` endpoints expect either a URL
// or a base64 blob, and URL is simpler + cheaper.
//
// Limits: 16MB hard cap (matches WhatsApp's own upload ceiling for media),
// allow-list of MIME types covering the common ops use cases. Anything not
// on the list returns 415 so the operator gets a useful error.
const ALLOWED_UPLOAD_MIME = new Set<string>([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/pdf',
  'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac',
  'video/mp4', 'video/quicktime', 'video/webm',
]);
const UPLOAD_MAX_BYTES = 16 * 1024 * 1024;

whatsappAdmin.post('/conversations/:id/messages/media', async (c) => {
  const user = getUser(c);
  const id = c.req.param('id');

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'multipart_required' }, 400);
  }
  const file = form.get('file');
  const caption = (form.get('caption') as string | null) ?? '';
  const category = ((form.get('category') as string | null) || 'operational') as WhatsAppCategory;
  const replyToExternalId = (form.get('reply_to_external_id') as string | null) || undefined;

  if (!(file instanceof File)) return c.json({ error: 'file_required' }, 400);
  if (file.size > UPLOAD_MAX_BYTES) return c.json({ error: 'file_too_large', limit: UPLOAD_MAX_BYTES }, 413);
  const mimetype = file.type || 'application/octet-stream';
  if (!ALLOWED_UPLOAD_MIME.has(mimetype)) {
    return c.json({ error: 'unsupported_mime', mime: mimetype }, 415);
  }

  const convRows = await sql`
    SELECT id, phone, customer_id, lead_id
    FROM whatsapp_conversations WHERE id = ${id} LIMIT 1
  ` as Array<{ id: string; phone: string; customer_id: string | null; lead_id: string | null }>;
  if (!convRows.length) return c.json({ error: 'Not Found' }, 404);
  const conv = convRows[0];

  const policy = await canSendWhatsApp(conv.phone, category, {
    customerId: conv.customer_id,
    leadId: conv.lead_id,
  });
  if (!policy.allowed) return c.json({ error: 'opt_out', reason: policy.reason }, 403);

  // Persist locally before talking to GOWA so we have a stable URL to hand off.
  const originalName = (file.name || 'media').replace(/[^A-Za-z0-9._-]/g, '_');
  const ext = extname(originalName) || mimeToExt(mimetype);
  const storedName = `${randomUUID()}${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  await savePrivateFile('whatsapp', storedName, buffer);
  const fileUrl = signFileUrl('whatsapp', storedName);

  const messageType =
    mimetype.startsWith('image/') ? 'image' :
    mimetype.startsWith('video/') ? 'video' :
    mimetype.startsWith('audio/') ? 'audio' :
    'document';

  try {
    const res = await sendWhatsAppMedia(conv.phone, caption, fileUrl, originalName, mimetype, { replyToExternalId });
    const externalId = res.externalId;
    const msgRows = await sql`
      INSERT INTO whatsapp_messages
        (conversation_id, external_id, direction, category, type, body, media_path, media_mime, media_size, reply_to_external_id, sender_kind, sender_user_id, meta)
      VALUES
        (${conv.id}, ${externalId ?? null}, 'outbound', ${category}, ${messageType},
         ${caption || null}, ${storedName}, ${mimetype}, ${file.size},
         ${replyToExternalId ?? null}, 'admin', ${user?.id ?? null},
         ${sql.json({ filename: originalName })})
      RETURNING id
    ` as Array<{ id: string }>;
    await sql`
      UPDATE whatsapp_conversations
      SET last_message_at = now(),
          last_message_preview = ${(caption || `[${messageType}]`).slice(0, 200)},
          unread_count = 0
      WHERE id = ${conv.id}
    `;
    publishWaEvent({
      type: 'message:inserted',
      conversationId: conv.id,
      direction: 'outbound',
      messageId: msgRows[0].id,
      externalId: externalId ?? null,
      unread: false,
    });
    publishWaEvent({ type: 'conversation:updated', conversationId: conv.id, reason: 'message' });
    return c.json({ ok: true, id: msgRows[0].id, externalId, media_path: storedName });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 502);
  }
});

function mimeToExt(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return '.jpg';
    case 'image/png': return '.png';
    case 'image/webp': return '.webp';
    case 'image/gif': return '.gif';
    case 'application/pdf': return '.pdf';
    case 'audio/ogg': return '.ogg';
    case 'audio/mp4': return '.m4a';
    case 'audio/mpeg': return '.mp3';
    case 'audio/aac': return '.aac';
    case 'video/mp4': return '.mp4';
    case 'video/quicktime': return '.mov';
    case 'video/webm': return '.webm';
    default: return '';
  }
}

whatsappAdmin.post('/conversations/:id/ai-mode', async (c) => {
  const id = c.req.param('id');
  const { ai_mode } = await c.req.json().catch(() => ({} as any));
  if (!['off', 'triage', 'auto_reply'].includes(ai_mode)) {
    return c.json({ error: 'invalid ai_mode' }, 400);
  }
  await sql`UPDATE whatsapp_conversations SET ai_mode = ${ai_mode}, updated_at = now() WHERE id = ${id}`;
  publishWaEvent({ type: 'conversation:updated', conversationId: id, reason: 'ai-mode' });
  return c.json({ ok: true });
});

whatsappAdmin.post('/conversations/:id/read', async (c) => {
  const id = c.req.param('id');
  const rows = await sql`SELECT chat_id FROM whatsapp_conversations WHERE id = ${id} LIMIT 1` as Array<{ chat_id: string }>;
  if (!rows.length) return c.json({ error: 'Not Found' }, 404);
  await sql`UPDATE whatsapp_conversations SET unread_count = 0 WHERE id = ${id}`;
  try { await markChatRead(rows[0].chat_id); } catch { /* ignore */ }
  publishWaEvent({ type: 'conversation:updated', conversationId: id, reason: 'read' });
  return c.json({ ok: true });
});

whatsappAdmin.post('/conversations/:id/archive', async (c) => {
  const id = c.req.param('id');
  const { archived } = await c.req.json().catch(() => ({} as any));
  await sql`UPDATE whatsapp_conversations SET archived = ${Boolean(archived)} WHERE id = ${id}`;
  publishWaEvent({ type: 'conversation:updated', conversationId: id, reason: 'archive' });
  return c.json({ ok: true });
});

// Mark a conversation as unread (idempotent — bump to 1 if currently 0).
// Pure UI affordance: GOWA has no "mark unread" remote op, this only affects
// the admin inbox so we can route attention back to a chat we already opened.
whatsappAdmin.post('/conversations/:id/unread', async (c) => {
  const id = c.req.param('id');
  const rows = await sql`
    UPDATE whatsapp_conversations
    SET unread_count = GREATEST(unread_count, 1)
    WHERE id = ${id}
    RETURNING id
  ` as Array<{ id: string }>;
  if (!rows.length) return c.json({ error: 'Not Found' }, 404);
  publishWaEvent({ type: 'conversation:updated', conversationId: id, reason: 'unread' });
  return c.json({ ok: true });
});

// Delete a conversation locally. The chat remains on the phone — GOWA has no
// "delete chat" endpoint and we intentionally do not call one even if it
// existed: erasing remote state from admin would surprise the contact. This
// only purges our mirror. Cascades to whatsapp_messages via FK ON DELETE.
whatsappAdmin.delete('/conversations/:id', async (c) => {
  const id = c.req.param('id');
  const rows = await sql`
    DELETE FROM whatsapp_conversations WHERE id = ${id} RETURNING id
  ` as Array<{ id: string }>;
  if (!rows.length) return c.json({ error: 'Not Found' }, 404);
  publishWaEvent({ type: 'conversation:updated', conversationId: id, reason: 'delete' });
  return c.json({ ok: true });
});

whatsappAdmin.post('/conversations/:id/link', async (c) => {
  const id = c.req.param('id');
  const { customer_id = null, lead_id = null } = await c.req.json().catch(() => ({} as any));
  await sql`UPDATE whatsapp_conversations SET customer_id = ${customer_id}, lead_id = ${lead_id} WHERE id = ${id}`;
  publishWaEvent({ type: 'conversation:updated', conversationId: id, reason: 'link' });
  return c.json({ ok: true });
});

// ---------- workflow mutations (mig 110) ----------

whatsappAdmin.post('/conversations/:id/pin', async (c) => {
  const id = c.req.param('id');
  const { pinned } = await c.req.json().catch(() => ({} as { pinned?: unknown }));
  await sql`UPDATE whatsapp_conversations SET pinned = ${Boolean(pinned)} WHERE id = ${id}`;
  publishWaEvent({ type: 'conversation:updated', conversationId: id, reason: 'link' });
  return c.json({ ok: true });
});

whatsappAdmin.post('/conversations/:id/mute', async (c) => {
  const id = c.req.param('id');
  // `muted_until` ISO string or null → mute / unmute. We accept also a
  // simple `{ minutes: number }` shorthand for the common case (mute 1h /
  // 8h / 24h from now).
  const body = await c.req.json().catch(() => ({} as { muted_until?: unknown; minutes?: unknown }));
  let mutedUntil: string | null = null;
  if (typeof body.minutes === 'number' && body.minutes > 0) {
    mutedUntil = new Date(Date.now() + body.minutes * 60_000).toISOString();
  } else if (typeof body.muted_until === 'string' && body.muted_until) {
    const d = new Date(body.muted_until);
    if (!Number.isNaN(d.getTime())) mutedUntil = d.toISOString();
  } else if (body.muted_until === null) {
    mutedUntil = null;
  }
  await sql`UPDATE whatsapp_conversations SET muted_until = ${mutedUntil} WHERE id = ${id}`;
  publishWaEvent({ type: 'conversation:updated', conversationId: id, reason: 'link' });
  return c.json({ ok: true, muted_until: mutedUntil });
});

whatsappAdmin.post('/conversations/:id/status', async (c) => {
  const id = c.req.param('id');
  const { status } = await c.req.json().catch(() => ({} as { status?: unknown }));
  if (status !== 'open' && status !== 'waiting' && status !== 'resolved') {
    return c.json({ error: 'invalid_status' }, 400);
  }
  await sql`UPDATE whatsapp_conversations SET status = ${status} WHERE id = ${id}`;
  publishWaEvent({ type: 'conversation:updated', conversationId: id, reason: 'link' });
  return c.json({ ok: true });
});

whatsappAdmin.post('/conversations/:id/note', async (c) => {
  const id = c.req.param('id');
  const { internal_note } = await c.req.json().catch(() => ({} as { internal_note?: unknown }));
  const value = typeof internal_note === 'string' && internal_note.trim() ? internal_note : null;
  await sql`UPDATE whatsapp_conversations SET internal_note = ${value} WHERE id = ${id}`;
  publishWaEvent({ type: 'conversation:updated', conversationId: id, reason: 'link' });
  return c.json({ ok: true });
});

whatsappAdmin.post('/conversations/:id/ai-instructions', async (c) => {
  const id = c.req.param('id');
  const { ai_instructions } = await c.req.json().catch(() => ({} as { ai_instructions?: unknown }));
  const value = typeof ai_instructions === 'string' && ai_instructions.trim() ? ai_instructions : null;
  await sql`UPDATE whatsapp_conversations SET ai_instructions = ${value} WHERE id = ${id}`;
  publishWaEvent({ type: 'conversation:updated', conversationId: id, reason: 'ai-mode' });
  return c.json({ ok: true });
});

// ---------- scheduled messages (mig 110, cron whatsapp-scheduled) ----------

whatsappAdmin.get('/conversations/:id/scheduled', async (c) => {
  const id = c.req.param('id');
  const rows = await sql`
    SELECT id, body, media_path, media_mime, category, send_at,
           sent_at, sent_message_id, error, attempts, created_at
    FROM whatsapp_scheduled_messages
    WHERE conversation_id = ${id}
    ORDER BY send_at DESC
    LIMIT 50
  `;
  return c.json({ scheduled: rows });
});

whatsappAdmin.post('/conversations/:id/schedule', async (c) => {
  const user = getUser(c);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({} as { body?: unknown; send_at?: unknown; category?: unknown }));
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  const sendAtStr = typeof body.send_at === 'string' ? body.send_at : '';
  const category = (body.category === 'transactional' || body.category === 'marketing') ? body.category : 'operational';

  if (!text) return c.json({ error: 'body_required' }, 400);
  const sendAt = new Date(sendAtStr);
  if (Number.isNaN(sendAt.getTime())) return c.json({ error: 'invalid_send_at' }, 400);
  // Must be at least 1 minute in the future. Anything sooner is meaningless
  // (the polling interval is 60s) and probably a UI bug — reject loudly.
  if (sendAt.getTime() - Date.now() < 60_000) {
    return c.json({ error: 'send_at_must_be_future' }, 400);
  }

  const exists = await sql`SELECT id FROM whatsapp_conversations WHERE id = ${id} LIMIT 1` as Array<{ id: string }>;
  if (!exists.length) return c.json({ error: 'Not Found' }, 404);

  const rows = await sql`
    INSERT INTO whatsapp_scheduled_messages
      (conversation_id, body, category, send_at, created_by)
    VALUES
      (${id}, ${text}, ${category}, ${sendAt.toISOString()}, ${user?.id ?? null})
    RETURNING id, send_at
  ` as Array<{ id: string; send_at: string }>;
  return c.json({ ok: true, ...rows[0] });
});

whatsappAdmin.delete('/scheduled/:id', async (c) => {
  const id = c.req.param('id');
  const rows = await sql`
    DELETE FROM whatsapp_scheduled_messages
    WHERE id = ${id} AND sent_at IS NULL
    RETURNING id
  ` as Array<{ id: string }>;
  if (!rows.length) return c.json({ error: 'Not Found or already sent' }, 404);
  return c.json({ ok: true });
});

// Replace-style tags endpoint. The UI passes the full intended list; we
// diff against the existing rows and INSERT/DELETE the delta. Tags are
// normalized to lowercase trimmed; empty entries dropped.
whatsappAdmin.post('/conversations/:id/tags', async (c) => {
  const id = c.req.param('id');
  const { tags } = await c.req.json().catch(() => ({} as { tags?: unknown }));
  if (!Array.isArray(tags)) return c.json({ error: 'tags_must_be_array' }, 400);
  const normalized = Array.from(new Set(
    (tags as unknown[])
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && t.length <= 40)
      .map((t) => t.toLowerCase()),
  ));

  // Replace strategy: delete-all + insert-all. The conversation has at most
  // a handful of tags so the round-trip is cheap and the code stays simple.
  await sql`DELETE FROM whatsapp_conversation_tags WHERE conversation_id = ${id}`;
  if (normalized.length > 0) {
    const rows = normalized.map((tag) => ({ conversation_id: id, tag }));
    // postgres.js: bulk insert via `sql(rows)` expansion
    await sql`INSERT INTO whatsapp_conversation_tags ${sql(rows, 'conversation_id', 'tag')}`;
  }
  publishWaEvent({ type: 'conversation:updated', conversationId: id, reason: 'link' });
  return c.json({ ok: true, tags: normalized });
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
    publishWaEvent({ type: 'conversation:updated', conversationId: m.conversation_id, reason: 'message' });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 502);
  }
});

whatsappAdmin.post('/messages/:msgId/discard', async (c) => {
  const msgId = c.req.param('msgId');
  const rows = await sql`
    DELETE FROM whatsapp_messages
    WHERE id = ${msgId} AND ai_draft = TRUE AND ai_draft_approved_at IS NULL
    RETURNING conversation_id
  ` as Array<{ conversation_id: string }>;
  if (rows[0]) {
    publishWaEvent({ type: 'conversation:updated', conversationId: rows[0].conversation_id, reason: 'message' });
  }
  return c.json({ ok: true });
});

whatsappAdmin.patch('/messages/:msgId', async (c) => {
  const msgId = c.req.param('msgId');
  const { body } = await c.req.json().catch(() => ({} as any));
  if (typeof body !== 'string') return c.json({ error: 'invalid body' }, 400);
  await sql`UPDATE whatsapp_messages SET body = ${body} WHERE id = ${msgId} AND ai_draft = TRUE AND ai_draft_approved_at IS NULL`;
  return c.json({ ok: true });
});

// React to a message. Mirrors the reaction overlay behaviour we apply to
// inbound reactions (handleReactionEvent): we update meta.reactions on the
// target with our entry, then fire the GOWA call so the contact sees it too.
// `emoji` empty string clears any previous reaction we sent.
whatsappAdmin.post('/messages/:msgId/react', async (c) => {
  const msgId = c.req.param('msgId');
  const { emoji } = await c.req.json().catch(() => ({} as { emoji?: string }));
  if (typeof emoji !== 'string') return c.json({ error: 'invalid_emoji' }, 400);

  const rows = await sql`
    SELECT m.id, m.external_id, m.conversation_id, m.meta, wc.phone
    FROM whatsapp_messages m
    JOIN whatsapp_conversations wc ON wc.id = m.conversation_id
    WHERE m.id = ${msgId} LIMIT 1
  ` as Array<{ id: string; external_id: string | null; conversation_id: string; meta: Record<string, unknown> | null; phone: string }>;
  if (!rows.length) return c.json({ error: 'Not Found' }, 404);
  const target = rows[0];
  if (!target.external_id) return c.json({ error: 'no_external_id' }, 400);

  const existingMeta = target.meta || {};
  const reactions = Array.isArray((existingMeta as { reactions?: unknown }).reactions)
    ? ((existingMeta as { reactions: Array<{ emoji: string; from: string | null; at: string }> }).reactions)
    : [];
  // The admin entry is identified by `from: 'admin'` so we replace, not stack.
  const filtered = reactions.filter((r) => r.from !== 'admin');
  const next = emoji ? [...filtered, { emoji, from: 'admin', at: new Date().toISOString() }] : filtered;

  await sql`
    UPDATE whatsapp_messages
    SET meta = meta || ${sql.json({ reactions: next })}
    WHERE id = ${target.id}
  `;

  try {
    await sendWhatsAppReaction(target.phone, target.external_id, emoji);
  } catch (err) {
    log.warn({ err }, 'GOWA reaction send failed; local overlay updated anyway');
  }

  publishWaEvent({
    type: 'message:reaction',
    conversationId: target.conversation_id,
    targetExternalId: target.external_id,
    emoji,
    from: 'admin',
  });

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

// --- Side-channel events log (group / newsletter / presence / call) ---

whatsappAdmin.get('/events', async (c) => {
  const eventType = c.req.query('type');
  const limit = Math.min(parseInt(c.req.query('limit') || '100'), 500);
  const offset = parseInt(c.req.query('offset') || '0');
  const filter = eventType ? sql`WHERE event_type = ${eventType}` : sql``;
  const rows = await sql`
    SELECT id, event_type, device_id, chat_id, from_jid, payload, received_at,
           COUNT(*) OVER() AS _total_count
    FROM whatsapp_events_log
    ${filter}
    ORDER BY received_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  const totalCount = rows[0]?._total_count ? Number(rows[0]._total_count) : 0;
  return c.json({
    events: rows.map((r: any) => {
      const { _total_count, ...rest } = r;
      return rest;
    }),
    total: totalCount,
    limit,
    offset,
  });
});

// --- Backfill: import chats + messages history from GOWA ---

/**
 * POST /api/whatsapp-admin/sync
 *   ?messages_per_chat=200  → limita lo storico messaggi per chat (default 200, max 500)
 *   ?max_chats=200          → limita il numero di chat sincronizzate (default 200, max 500)
 *
 * Idempotente: usa `external_id` per evitare duplicate messages. Le conversazioni
 * esistenti sono aggiornate (preview + last_message_at); quelle nuove sono create
 * via ensureConversation() (auto-link customer/lead per phone match).
 *
 * Non scarica i media (richiederebbe un secondo round-trip per ogni messaggio
 * con media_type non null + ban di rate dal lato WhatsApp). I media verranno
 * scaricati a richiesta via /api/files quando l'admin apre la chat.
 */
whatsappAdmin.post('/sync', async (c) => {
  if (!isWhatsAppConfigured()) {
    return c.json({ error: 'GOWA non configurato' }, 400);
  }

  const msgsPerChat = Math.min(parseInt(c.req.query('messages_per_chat') || '200'), 500);
  const maxChats = Math.min(parseInt(c.req.query('max_chats') || '200'), 500);

  // Cleanup difensivo: rimuove dalle inbox eventuali newsletter/broadcast che
  // erano finiti li' da run precedenti del sync (prima del filtro). I messaggi
  // collegati cadono via ON DELETE CASCADE.
  const cleaned = await sql`
    DELETE FROM whatsapp_conversations
    WHERE chat_id LIKE '%@newsletter'
       OR chat_id LIKE '%@broadcast'
       OR chat_id = 'status@broadcast'
    RETURNING id
  ` as Array<{ id: string }>;
  const removedLegacy = cleaned.length;

  let totalChats = 0;
  let totalMessages = 0;
  let createdConvs = 0;
  let createdMessages = 0;
  let skippedNewsletter = 0;
  let skippedBroadcast = 0;
  let skippedUnknown = 0;
  const errors: Array<{ chatJid: string; error: string }> = [];

  try {
    // Paginazione GOWA chats (100 per pagina).
    for (let offset = 0; offset < maxChats; offset += 100) {
      const { chats } = await fetchGowaChats({ limit: 100, offset });
      if (chats.length === 0) break;
      totalChats += chats.length;

      for (const chat of chats) {
        if (!chat.jid) continue;
        try {
          const stats = await importChatFromGowa(chat, msgsPerChat);
          if (stats.skipped === 'newsletter') skippedNewsletter++;
          else if (stats.skipped === 'broadcast') skippedBroadcast++;
          else if (stats.skipped === 'unknown_jid') skippedUnknown++;
          else {
            createdConvs += stats.createdConv ? 1 : 0;
            totalMessages += stats.fetchedMessages;
            createdMessages += stats.createdMessages;
          }
        } catch (err) {
          errors.push({ chatJid: chat.jid, error: (err as Error).message });
          log.error({ err, chatJid: chat.jid }, 'sync chat failed');
        }
      }

      if (chats.length < 100) break;
    }
  } catch (err) {
    return c.json({
      ok: false,
      error: `Sync interrotta: ${(err as Error).message}`,
      totalChats,
      createdConvs,
      totalMessages,
      createdMessages,
      skippedNewsletter,
      skippedBroadcast,
      skippedUnknown,
      errors,
    }, 502);
  }

  return c.json({
    ok: true,
    totalChats,
    createdConvs,
    totalMessages,
    createdMessages,
    skippedNewsletter,
    skippedBroadcast,
    skippedUnknown,
    removedLegacy,
    errors,
  });
});

async function importChatFromGowa(chat: GowaChat, msgsPerChat: number): Promise<{
  createdConv: boolean;
  fetchedMessages: number;
  createdMessages: number;
  skipped?: 'newsletter' | 'broadcast' | 'unknown_jid';
}> {
  const chatId = chat.jid;
  // Skip newsletter / WhatsApp channels e status broadcast — non sono chat
  // 1:1 o di gruppo e l'UI inbox non e' progettata per gestirli.
  // Sono comunque registrati in whatsapp_events_log via webhook newsletter.*.
  if (chatId.endsWith('@newsletter')) {
    return { createdConv: false, fetchedMessages: 0, createdMessages: 0, skipped: 'newsletter' };
  }
  if (chatId.endsWith('@broadcast') || chatId === 'status@broadcast') {
    return { createdConv: false, fetchedMessages: 0, createdMessages: 0, skipped: 'broadcast' };
  }
  // Accept solo individui (@s.whatsapp.net) e gruppi (@g.us).
  if (!chatId.endsWith('@s.whatsapp.net') && !chatId.endsWith('@g.us')) {
    return { createdConv: false, fetchedMessages: 0, createdMessages: 0, skipped: 'unknown_jid' };
  }
  const isGroup = chatId.endsWith('@g.us');
  const phone = chatIdToPhone(chatId);
  const contactName = chat.name?.trim() || undefined;

  // Crea/recupera la conversazione (con auto-link a customer/lead).
  const existing = await sql`
    SELECT id FROM whatsapp_conversations WHERE chat_id = ${chatId} LIMIT 1
  ` as Array<{ id: string }>;
  const conv = await ensureConversation({ chatId, phone, contactName, isGroup });
  const createdConv = existing.length === 0;

  // Fetch storico messaggi (max msgsPerChat, paginazione 100).
  let fetched = 0;
  let created = 0;
  for (let offset = 0; offset < msgsPerChat; offset += 100) {
    const remaining = msgsPerChat - offset;
    const batchLimit = Math.min(remaining, 100);
    const { messages } = await fetchGowaChatMessages(chatId, { limit: batchLimit, offset });
    if (messages.length === 0) break;
    fetched += messages.length;
    for (const msg of messages) {
      created += await upsertGowaMessage(conv.id, msg);
    }
    if (messages.length < batchLimit) break;
  }

  // Aggiorna preview/last_message_at sulla conversazione (best-effort).
  if (chat.last_message_time) {
    await sql`
      UPDATE whatsapp_conversations
      SET last_message_at = COALESCE(last_message_at, ${chat.last_message_time}::timestamptz)
      WHERE id = ${conv.id}
    `;
  }

  return { createdConv, fetchedMessages: fetched, createdMessages: created };
}

async function upsertGowaMessage(conversationId: string, msg: GowaChatMessage): Promise<number> {
  // ON CONFLICT (external_id) DO NOTHING per idempotenza.
  // Vincolo presente su whatsapp_messages.external_id (UNIQUE), se non c'e'
  // funziona comunque ma puo' creare duplicati: il check applicativo qui sotto
  // riproduce l'idempotenza.
  if (msg.id) {
    const dup = await sql`
      SELECT 1 FROM whatsapp_messages WHERE external_id = ${msg.id} LIMIT 1
    ` as Array<{ '?column?': number }>;
    if (dup.length > 0) return 0;
  }

  const direction = msg.is_from_me ? 'outbound' : 'inbound';
  const type = msg.media_type || (msg.content ? 'text' : 'unknown');
  const body = msg.content || null;
  const senderKind: 'user' | 'admin' = msg.is_from_me ? 'admin' : 'user';
  // Per i media salviamo l'URL GOWA come hint (no download immediato — vedi
  // commento sul `/sync` endpoint).
  const mediaUrl = msg.url || null;

  await sql`
    INSERT INTO whatsapp_messages
      (conversation_id, external_id, direction, category, type, body,
       media_url, media_mime, sender_kind, created_at)
    VALUES
      (${conversationId}, ${msg.id ?? null}, ${direction}, 'operational', ${type}, ${body},
       ${mediaUrl}, ${null}, ${senderKind}, ${msg.timestamp ?? null}::timestamptz)
  `;
  return 1;
}
