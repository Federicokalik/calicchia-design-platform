/**
 * WhatsApp gateway client — GOWA (go-whatsapp-web-multidevice).
 *
 * Decommissione di Evolution API (decision 2026-05-19): manteniamo le firme
 * pubbliche (isWhatsAppConfigured, sendWhatsAppText, sendWhatsAppMedia,
 * getWhatsAppStatus) per non rompere il workflow node `tool_send_whatsapp`
 * (lib/workflow/nodes.ts) e l'agent tool `send_whatsapp` (lib/agent/tools.ts).
 *
 * Config via env (.env.example):
 *   GOWA_URL                  base URL dell'istanza (https://gowa.calicchia.design)
 *   GOWA_BASIC_AUTH_USER/PASS Basic Auth (corrisponde a --basic-auth lato GOWA)
 *   GOWA_DEVICE_ID            jid del device attivo (popolato dopo link via UI)
 *
 * Nessun retry interno: la resilienza è a carico del caller (workflow engine,
 * cron job, AI triage) — coerente con il pattern di stripe.ts/paypal.ts.
 *
 * Rate limit: 1 msg/s in-memory per evitare ban WhatsApp. Se servisse multi-process
 * spostare su Redis.
 */

import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { savePrivateFile } from './private-files';

const GOWA_URL = (process.env.GOWA_URL || '').replace(/\/+$/, '');
const GOWA_USER = process.env.GOWA_BASIC_AUTH_USER || '';
const GOWA_PASS = process.env.GOWA_BASIC_AUTH_PASS || '';
const GOWA_DEVICE_ID = process.env.GOWA_DEVICE_ID || '';

// ---------- internal helpers ----------

function gowaHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(extra || {}),
  };
  if (GOWA_USER) {
    const token = Buffer.from(`${GOWA_USER}:${GOWA_PASS}`).toString('base64');
    headers.Authorization = `Basic ${token}`;
  }
  if (GOWA_DEVICE_ID) headers['X-Device-Id'] = GOWA_DEVICE_ID;
  return headers;
}

async function gowaFetch<T = unknown>(
  path: string,
  init?: RequestInit & { jsonBody?: unknown }
): Promise<T> {
  if (!GOWA_URL) throw new Error('GOWA non configurato (GOWA_URL mancante)');
  const isJson = init?.jsonBody !== undefined;
  const headers = gowaHeaders(
    isJson ? { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string>) } : (init?.headers as Record<string, string>) || {}
  );
  const res = await fetch(`${GOWA_URL}${path}`, {
    ...init,
    headers,
    body: isJson ? JSON.stringify(init?.jsonBody) : init?.body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GOWA ${path} failed ${res.status}: ${text.slice(0, 200)}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return (await res.json()) as T;
  // For binary downloads we expose a separate path; default returns text.
  return (await res.text()) as unknown as T;
}

// E.164-ish normalization. WhatsApp accetta sia "39..." sia "39...@s.whatsapp.net".
// Per GOWA preferiamo formato numerico nudo senza prefisso "+", aggiungendo 39 a
// numeri italiani lasciati senza country code.
export function formatPhone(phone: string): string {
  let cleaned = (phone || '').replace(/[\s\-()+]/g, '');
  if (!cleaned) return cleaned;
  // Numero italiano 10 cifre che inizia per 3 → preponi 39.
  if (cleaned.startsWith('3') && cleaned.length === 10) cleaned = `39${cleaned}`;
  // Numero italiano 11 cifre che inizia per 03 → rimuovi 0, preponi 39.
  if (cleaned.startsWith('03') && cleaned.length === 11) cleaned = `39${cleaned.slice(1)}`;
  return cleaned;
}

// In-process throttle (1 msg/s) per evitare ban.
const sendQueue: Array<() => void> = [];
let sendBusy = false;
async function throttledSend<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const task = async () => {
      try { resolve(await fn()); }
      catch (err) { reject(err as Error); }
      finally {
        await new Promise((r) => setTimeout(r, 1000));
        const next = sendQueue.shift();
        if (next) next();
        else sendBusy = false;
      }
    };
    if (sendBusy) sendQueue.push(task);
    else { sendBusy = true; task(); }
  });
}

// ---------- public API (stabile, retro-compatibile) ----------

export function isWhatsAppConfigured(): boolean {
  return Boolean(GOWA_URL);
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  externalId?: string;
}

export interface SendOptions {
  /** External id of the message to quote (WhatsApp "reply" feature). */
  replyToExternalId?: string;
}

export async function sendWhatsAppText(phone: string, message: string, options: SendOptions = {}): Promise<SendResult> {
  if (!isWhatsAppConfigured()) throw new Error('WhatsApp (GOWA) non configurato');
  const target = formatPhone(phone);
  // GDPR L16: al primo outbound verso un numero ancora non contattato
  // appende il blocco informativo con istruzioni opt-out e link preferenze.
  // Dynamic import per evitare il ciclo whatsapp.ts <-> whatsapp-disclaimer.ts.
  const { attachDisclaimerIfFirstContact } = await import('./whatsapp-disclaimer');
  const body = await attachDisclaimerIfFirstContact(target, message);
  const payload: Record<string, unknown> = { phone: target, message: body };
  if (options.replyToExternalId) payload.reply_message_id = options.replyToExternalId;
  const data = await throttledSend(() =>
    gowaFetch<{ results?: { message_id?: string }; message_id?: string; code?: string }>(
      '/send/message',
      { method: 'POST', jsonBody: payload }
    )
  );
  const id = data?.results?.message_id || data?.message_id;
  return { success: true, messageId: id, externalId: id };
}

export async function sendWhatsAppMedia(
  phone: string,
  caption: string,
  mediaUrl: string,
  filename: string,
  mimetype = 'application/pdf',
  options: SendOptions = {},
): Promise<SendResult> {
  if (!isWhatsAppConfigured()) throw new Error('WhatsApp (GOWA) non configurato');
  const target = formatPhone(phone);
  // GDPR L16: anche per i media (es. PDF fattura come primo contatto) appende
  // il disclaimer informativo alla caption se non c'e` ancora outbound history.
  const { attachDisclaimerIfFirstContact } = await import('./whatsapp-disclaimer');
  const finalCaption = await attachDisclaimerIfFirstContact(target, caption);
  // GOWA accetta sia URL remoto (file_url) sia upload multipart. Preferiamo URL
  // perché stripe-quote-pdf / fatture sono già esposti via /media/*.
  const endpoint = mimetype.startsWith('image/')
    ? '/send/image'
    : mimetype.startsWith('audio/')
      ? '/send/audio'
      : mimetype.startsWith('video/')
        ? '/send/video'
        : '/send/file';
  const body: Record<string, unknown> = {
    phone: target,
    caption: finalCaption,
    file_url: mediaUrl,
    file_name: filename,
    mimetype,
  };
  if (options.replyToExternalId) body.reply_message_id = options.replyToExternalId;
  const data = await throttledSend(() =>
    gowaFetch<{ results?: { message_id?: string }; message_id?: string }>(
      endpoint,
      { method: 'POST', jsonBody: body }
    )
  );
  const id = data?.results?.message_id || data?.message_id;
  return { success: true, messageId: id, externalId: id };
}

export interface WhatsAppStatus {
  connected: boolean;
  phone?: string;
  deviceId?: string;
  displayName?: string;
}

export async function getWhatsAppStatus(): Promise<WhatsAppStatus> {
  if (!isWhatsAppConfigured()) return { connected: false };
  try {
    const data = await gowaFetch<{
      results?: Array<{ device: string; name?: string; jid?: string }>;
    }>('/app/devices');
    const devices = data?.results || [];
    if (!devices.length) return { connected: false };
    // Single-device fase 1: prendiamo la prima, ma se GOWA_DEVICE_ID è popolato
    // lo usiamo come filtro.
    const target = GOWA_DEVICE_ID
      ? devices.find((d) => d.device === GOWA_DEVICE_ID || d.jid === GOWA_DEVICE_ID)
      : devices[0];
    if (!target) return { connected: false };
    return {
      connected: true,
      deviceId: target.device || target.jid,
      phone: target.device || target.jid,
      displayName: target.name,
    };
  } catch {
    return { connected: false };
  }
}

// ---------- new public API (admin operations) ----------

export interface LinkResult {
  qrCode?: string;       // data URL "data:image/png;base64,..."
  qrText?: string;       // testo raw del QR (fallback)
  duration?: number;     // secondi prima della scadenza
  expiresAt?: string;
}

export async function linkWhatsAppDevice(): Promise<LinkResult> {
  if (!isWhatsAppConfigured()) throw new Error('WhatsApp (GOWA) non configurato');
  // GOWA: GET /app/login → ritorna immagine PNG del QR (binary) oppure JSON
  // con campo `qr_link` / `qr_duration`. Gestiamo entrambi.
  const res = await fetch(`${GOWA_URL}/app/login`, { headers: gowaHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GOWA /app/login failed ${res.status}: ${text.slice(0, 200)}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const json = await res.json() as { results?: { qr_link?: string; qr_duration?: number; qr_string?: string } };
    return {
      qrCode: json?.results?.qr_link,
      qrText: json?.results?.qr_string,
      duration: json?.results?.qr_duration,
    };
  }
  if (ct.startsWith('image/')) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { qrCode: `data:${ct};base64,${buf.toString('base64')}` };
  }
  // Plain text fallback
  return { qrText: await res.text() };
}

export async function logoutWhatsAppDevice(): Promise<void> {
  if (!isWhatsAppConfigured()) return;
  await gowaFetch('/app/logout', { method: 'GET' });
}

export async function reconnectWhatsAppDevice(): Promise<void> {
  if (!isWhatsAppConfigured()) return;
  await gowaFetch('/app/reconnect', { method: 'GET' });
}

export async function markChatRead(chatId: string): Promise<void> {
  if (!isWhatsAppConfigured()) return;
  await gowaFetch(`/chat/${encodeURIComponent(chatId)}/mark-as-read`, { method: 'POST' });
}

/**
 * Send an emoji reaction to a specific message. GOWA accepts either an empty
 * string to clear the reaction or any emoji to set it. We always go through
 * the throttle since each call is a real network round-trip.
 *
 * `messageId` is the GOWA external id of the target message (the one the
 * operator is reacting to), NOT the phone-number chat id.
 */
export async function sendWhatsAppReaction(phone: string, messageId: string, emoji: string): Promise<void> {
  if (!isWhatsAppConfigured()) throw new Error('WhatsApp (GOWA) non configurato');
  const target = formatPhone(phone);
  await throttledSend(() =>
    gowaFetch('/send/reaction', {
      method: 'POST',
      jsonBody: { phone: target, message_id: messageId, emoji },
    })
  );
}

// ---------- Backfill (chats & history) ----------

export interface GowaChat {
  jid: string;
  name?: string | null;
  last_message_time?: string | null;
  ephemeral_expiration?: number;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface GowaChatMessage {
  id: string;
  chat_jid: string;
  sender_jid?: string | null;
  content?: string | null;
  timestamp: string;
  is_from_me: boolean;
  media_type?: string | null;
  filename?: string | null;
  url?: string | null;
  file_length?: number | null;
  call_metadata?: string | null;
  reactions?: Array<{ emoji: string; sender_jid: string; timestamp: string }>;
  created_at?: string | null;
  updated_at?: string | null;
}

interface GowaPaginated<T> {
  code: string;
  message?: string;
  results: {
    data: T[];
    pagination: { limit: number; offset: number; total: number };
    chat_info?: GowaChat;
  };
}

/**
 * Lista chat esistenti su GOWA. Paginato 100 alla volta.
 * Ritorna [] se GOWA non e' configurato.
 */
export async function fetchGowaChats(opts: { limit?: number; offset?: number; archived?: boolean } = {}): Promise<{
  chats: GowaChat[];
  total: number;
}> {
  if (!isWhatsAppConfigured()) return { chats: [], total: 0 };
  const params = new URLSearchParams();
  params.set('limit', String(opts.limit ?? 100));
  params.set('offset', String(opts.offset ?? 0));
  if (opts.archived !== undefined) params.set('archived', String(opts.archived));
  const res = await gowaFetch<GowaPaginated<GowaChat>>(`/chats?${params.toString()}`, { method: 'GET' });
  return {
    chats: res.results?.data ?? [],
    total: res.results?.pagination?.total ?? 0,
  };
}

/**
 * Storico messaggi di una chat. Default 100 piu' recenti.
 */
export async function fetchGowaChatMessages(
  chatJid: string,
  opts: { limit?: number; offset?: number; startTime?: string; endTime?: string } = {},
): Promise<{ messages: GowaChatMessage[]; total: number; chatInfo: GowaChat | null }> {
  if (!isWhatsAppConfigured()) return { messages: [], total: 0, chatInfo: null };
  const params = new URLSearchParams();
  params.set('limit', String(opts.limit ?? 100));
  params.set('offset', String(opts.offset ?? 0));
  if (opts.startTime) params.set('start_time', opts.startTime);
  if (opts.endTime) params.set('end_time', opts.endTime);
  const res = await gowaFetch<GowaPaginated<GowaChatMessage>>(
    `/chat/${encodeURIComponent(chatJid)}/messages?${params.toString()}`,
    { method: 'GET' },
  );
  return {
    messages: res.results?.data ?? [],
    total: res.results?.pagination?.total ?? 0,
    chatInfo: res.results?.chat_info ?? null,
  };
}

/**
 * Scarica un media da GOWA e lo salva nello store privato (SEC-10).
 * Ritorna il nome file (es. "<uuid>.jpg") da inserire in
 * whatsapp_messages.media_path; la URL firmata viene generata in lettura.
 */
export async function downloadMedia(messageId: string, hintExt?: string): Promise<{ path: string; mime: string; size: number }> {
  if (!isWhatsAppConfigured()) throw new Error('WhatsApp (GOWA) non configurato');
  const res = await fetch(`${GOWA_URL}/message/${encodeURIComponent(messageId)}/download`, {
    headers: gowaHeaders(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GOWA download failed ${res.status}: ${text.slice(0, 200)}`);
  }
  const mime = res.headers.get('content-type') || 'application/octet-stream';
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = hintExt || extFromMime(mime) || extname(messageId) || '.bin';
  const safeExt = ext.startsWith('.') ? ext : `.${ext}`;
  const fileName = `${randomUUID()}${safeExt}`;
  await savePrivateFile('whatsapp', fileName, buf);
  return {
    path: fileName,
    mime,
    size: buf.length,
  };
}

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'application/pdf': '.pdf',
    'application/zip': '.zip',
  };
  return map[mime] || '';
}
