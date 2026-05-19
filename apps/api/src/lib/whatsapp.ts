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
import { mkdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const GOWA_URL = (process.env.GOWA_URL || '').replace(/\/+$/, '');
const GOWA_USER = process.env.GOWA_BASIC_AUTH_USER || '';
const GOWA_PASS = process.env.GOWA_BASIC_AUTH_PASS || '';
const GOWA_DEVICE_ID = process.env.GOWA_DEVICE_ID || '';
const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
const MEDIA_SUBDIR = 'whatsapp';

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

export async function sendWhatsAppText(phone: string, message: string): Promise<SendResult> {
  if (!isWhatsAppConfigured()) throw new Error('WhatsApp (GOWA) non configurato');
  const target = formatPhone(phone);
  const data = await throttledSend(() =>
    gowaFetch<{ results?: { message_id?: string }; message_id?: string; code?: string }>(
      '/send/message',
      { method: 'POST', jsonBody: { phone: target, message } }
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
  mimetype = 'application/pdf'
): Promise<SendResult> {
  if (!isWhatsAppConfigured()) throw new Error('WhatsApp (GOWA) non configurato');
  const target = formatPhone(phone);
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
    caption,
    file_url: mediaUrl,
    file_name: filename,
    mimetype,
  };
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
 * Scarica un media da GOWA e lo salva in UPLOAD_DIR/whatsapp/.
 * Ritorna il path relativo a UPLOAD_DIR (es. "whatsapp/<uuid>.jpg") da inserire
 * in whatsapp_messages.media_path.
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
  const fullDir = join(UPLOAD_DIR, MEDIA_SUBDIR);
  mkdirSync(fullDir, { recursive: true });
  writeFileSync(join(fullDir, fileName), buf);
  return {
    path: `${MEDIA_SUBDIR}/${fileName}`,
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
