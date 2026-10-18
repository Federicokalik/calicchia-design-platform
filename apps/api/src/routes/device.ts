import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { fromZonedTime } from 'date-fns-tz';
import { sql } from '../db';
import { authMiddleware } from '../middleware/auth';
import { isCalendarUnavailable } from '../lib/calendar/errors';
import { listOccurrences } from '../lib/calendar/events';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'device' });

const isValidDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Fuso del giorno dell'agenda (design §12 e §14: giorno di Roma, non UTC). */
const AGENDA_TZ = 'Europe/Rome';

/** Data di oggi (YYYY-MM-DD) nel fuso dell'agenda. */
function agendaToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: AGENDA_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * Finestra [fromIso, toIso) del giorno `date` in Europe/Rome (DST-safe: 23 o
 * 25 ore nei giorni del cambio d'ora). null se la data non esiste (es. 2027-02-30).
 */
function agendaDayWindow(date: string): { fromIso: string; toIso: string } | null {
  const [y, m, d] = date.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== m - 1 || day.getUTCDate() !== d) return null;
  const next = new Date(day.getTime() + 86_400_000).toISOString().slice(0, 10);
  return {
    fromIso: fromZonedTime(`${date}T00:00:00`, AGENDA_TZ).toISOString(),
    toIso: fromZonedTime(`${next}T00:00:00`, AGENDA_TZ).toISOString(),
  };
}

type DeviceEnv = {
  Variables: {
    deviceId: string;
    user: { id: string; email?: string; role?: string };
  };
};

// Voice captures are personal data: stored under PRIVATE_UPLOAD_DIR, which is
// never mounted on the public /media route (same policy as private-files.ts).
const PRIVATE_DIR = process.env.PRIVATE_UPLOAD_DIR || './private-uploads';
const AUDIO_DIR = resolve(join(PRIVATE_DIR, 'device'));

const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MB ≈ 5 min @16kHz mono 16-bit
const VALID_TAGS = new Set(['idea', 'todo', 'note']);

type DeviceTokenRow = {
  id: string;
  label: string;
  token_prefix: string;
  is_active: boolean;
  last_used_at: string | null;
  last_used_ip: string | null;
  usage_count: number | null;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
};

type AgendaEventRow = {
  summary: string;
  start_time: string;
  end_time: string;
  all_day: boolean;
  source: string;
  status: string;
};

export const device = new Hono<DeviceEnv>();

// --- device auth (Bearer dvt_<64hex>, sha256 lookup — mcp_tokens pattern) ---

export async function deviceAuth(c: Context, next: Next) {
  const header = c.req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.replace('Bearer ', '') : '';
  if (!token.startsWith('dvt_')) {
    return c.json({ error: 'Device token richiesto' }, 401);
  }
  const hash = createHash('sha256').update(token).digest('hex');
  const [row] = await sql<Array<{ id: string; expires_at: string | null }>>`
    SELECT id, expires_at FROM device_tokens
    WHERE token_hash = ${hash} AND is_active = true AND revoked_at IS NULL
  `;
  if (!row) return c.json({ error: 'Device token non valido' }, 401);
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return c.json({ error: 'Device token scaduto' }, 401);
  }
  await sql`
    UPDATE device_tokens
    SET usage_count = COALESCE(usage_count, 0) + 1,
        last_used_at = NOW()
    WHERE id = ${row.id}::uuid
  `;
  c.set('deviceId', row.id);
  await next();
}

// --- admin: pairing management (JWT via authMiddleware, mounted inline) ---

const admin = new Hono<DeviceEnv>();
admin.use('*', authMiddleware);

// POST /api/device/pair — create a device token. The plaintext token is
// returned ONCE (hash-only at rest).
admin.post('/pair', async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const label = typeof body.label === 'string' && body.label.trim()
    ? body.label.trim().slice(0, 100)
    : 'ePaper device';
  const expiresDays = typeof body.expires_days === 'number' && body.expires_days > 0
    ? Math.min(Math.floor(body.expires_days), 3650)
    : null;
  const token = `dvt_${randomUUID().replace(/-/g, '')}`;
  const hash = createHash('sha256').update(token).digest('hex');
  const prefix = token.slice(0, 12);
  const expiresAt = expiresDays
    ? new Date(Date.now() + expiresDays * 86_400_000).toISOString()
    : null;

  const [row] = await sql<Array<DeviceTokenRow>>`
    INSERT INTO device_tokens (token_hash, token_prefix, label, expires_at)
    VALUES (${hash}, ${prefix}, ${label}, ${expiresAt})
    RETURNING id, token_prefix, label, expires_at, created_at
  `;
  log.info({ prefix, label }, 'device token created');
  return c.json({ device_token: token, ...row }, 201);
});

admin.get('/tokens', async (c) => {
  const rows = await sql<Array<DeviceTokenRow>>`
    SELECT id, label, token_prefix, is_active, last_used_at, last_used_ip,
           usage_count, expires_at, created_at, revoked_at
    FROM device_tokens
    ORDER BY created_at DESC
  `;
  return c.json({ tokens: rows });
});

admin.delete('/tokens/:id', async (c) => {
  await sql`
    UPDATE device_tokens
    SET is_active = false, revoked_at = NOW()
    WHERE id = ${c.req.param('id')}::uuid
  `;
  return c.json({ success: true });
});

device.route('/admin', admin);

// --- device: authenticated endpoints ---

device.use('/*', deviceAuth);

// GET /api/device/ping — keepalive/health with token
device.get('/ping', (c) => c.json({ ok: true, now: new Date().toISOString() }));

// GET /api/device/agenda?date=YYYY-MM-DD — occorrenze che si sovrappongono al
// giorno di Roma, di tutti i calendari (iscrizioni, proiezioni delle
// prenotazioni e festività comprese, cancellati esclusi), con le ricorrenze
// espanse dallo store del calendario (facade listOccurrences: PgLegacyStore in
// mode postgres, indice di Radicale dopo il cutover) + next_event /
// last_event_end per la lock adattiva e i contatori per l'avatar. Data di
// default: oggi a Roma. Fase F2 (design §12 "Agenda device", §14): prima
// dell'F2 il giorno era quello UTC e le serie comparivano solo nel giorno del
// DTSTART del master; la forma JSON non cambia.
device.get('/agenda', async (c) => {
  const date = c.req.query('date') || agendaToday();
  const dayWindow = isValidDate(date) ? agendaDayWindow(date) : null;
  if (!dayWindow) {
    return c.json({ error: 'date non valida (YYYY-MM-DD)' }, 400);
  }
  let events: AgendaEventRow[];
  try {
    const occurrences = await listOccurrences({ fromIso: dayWindow.fromIso, toIso: dayWindow.toIso });
    events = occurrences.map((o) => ({
      summary: o.summary,
      start_time: o.start_time,
      end_time: o.end_time,
      all_day: o.all_day,
      source: o.source,
      status: o.status,
    }));
  } catch (err) {
    if (!isCalendarUnavailable(err)) throw err;
    log.warn({ reason: err.reason, detail: err.detail }, 'agenda del device non disponibile: calendario non verificabile');
    return c.json(err.toPublicBody(), 503);
  }

  const [counts] = await sql<Array<{ pending_tasks: number; pending_notes: number }>>`
    SELECT
      (SELECT COUNT(*)::int FROM project_tasks WHERE status = 'todo') AS pending_tasks,
      (SELECT COUNT(*)::int FROM device_notes WHERE status IN ('pending', 'transcribing')) AS pending_notes
  `;

  const now = new Date();
  const timed = events.filter((e) => !e.all_day);
  // Primo evento non ancora finito (o in corso); null se la giornata è chiusa.
  const nextEvent = timed.find((e) => new Date(e.end_time) > now) ?? null;
  const lastEventEnd = timed.length
    ? timed[timed.length - 1].end_time
    : null;

  return c.json({
    date,
    events,
    next_event: nextEvent
      ? { summary: nextEvent.summary, start_time: nextEvent.start_time, end_time: nextEvent.end_time }
      : null,
    last_event_end: lastEventEnd,
    pending_tasks: counts?.pending_tasks ?? 0,
    pending_notes: counts?.pending_notes ?? 0,
  });
});

// POST /api/device/notes — multipart upload of one voice capture.
// Fields: audio (file, WAV), tag ('idea'|'todo'|'note'), duration_ms.
// Transcription runs server-side (worker) and lands in `notes` with
// source='device'; the device polls GET /api/device/notes/:id.
device.post('/notes', async (c) => {
  const formData = await c.req.formData();
  const file = formData.get('audio');
  if (!(file instanceof File)) {
    return c.json({ error: 'Campo "audio" mancante' }, 400);
  }
  if (file.size <= 0 || file.size > MAX_AUDIO_BYTES) {
    return c.json({ error: 'File audio oltre i limiti (max 10 MB)' }, 413);
  }
  const tag = typeof formData.get('tag') === 'string' && VALID_TAGS.has(String(formData.get('tag')))
    ? String(formData.get('tag'))
    : 'note';
  const durationMs = Number(formData.get('duration_ms')) || null;

  mkdirSync(AUDIO_DIR, { recursive: true });
  const audioName = `${randomUUID()}.wav`;
  const audioPath = `device/${audioName}`;
  await writeFile(join(AUDIO_DIR, audioName), Buffer.from(await file.arrayBuffer()));

  const [row] = await sql<Array<{ id: string; status: string; created_at: string }>>`
    INSERT INTO device_notes (token_id, audio_path, audio_bytes, duration_ms, tag, status)
    VALUES (${c.get('deviceId')}, ${audioPath}, ${file.size}, ${durationMs}, ${tag}, 'pending')
    RETURNING id, status, created_at
  `;
  log.info({ device_note: row.id, tag, bytes: file.size }, 'voice capture received');
  return c.json(row, 201);
});

// GET /api/device/notes/:id — transcription status poll (for the device UI).
device.get('/notes/:id', async (c) => {
  const [row] = await sql<Array<{
    id: string;
    status: string;
    transcript: string | null;
    tag: string;
    note_id: string | null;
    error: string | null;
  }>>`
    SELECT id, status, transcript, tag, note_id, error
    FROM device_notes
    WHERE id = ${c.req.param('id')}::uuid
  `;
  if (!row) return c.json({ error: 'Nota non trovata' }, 404);
  return c.json(row);
});
