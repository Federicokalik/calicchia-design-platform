/**
 * API admin del calendario v2 `/api/admin/calendar/v2` (fase F6 del piano:
 * admin client CalDAV quasi 1:1; contratto
 * docs/calendar-radicale/contracts/f6-modules.md §3).
 *
 * Protetta dal JWT admin come il resto di /api/admin/calendar (protectedPaths
 * di app.ts); montata PRIMA di /api/admin/calendar. Regole comuni:
 *  - risposte JSON (tranne GET /objects/:id/ics); errori
 *    `{ error, code, details? }` con i codici del §3.10; un 412 porta la
 *    versione del server (`current`) e i conflitti per campo;
 *  - difesa CSRF delle richieste che scrivono: Sec-Fetch-Site, Origin ammesse
 *    e corpo solo application/json (lib/http/same-origin-writes.ts);
 *  - corpo al più 2 MB (un oggetto è al più 1 MB, design §8);
 *  - le route `objects` lavorano solo sullo store Radicale: con lo store
 *    postgres rispondono 409 STORE_MODE_UNSUPPORTED senza toccare nulla;
 *  - PATCH e DELETE richiedono If-Match con un ETag esatto (428 se manca o è `*`);
 *  - nessun testo di evento nei log.
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { CAL_V2_SCOPES, type CalV2Scope } from '@calicchia/shared';
import { logger } from '../../lib/logger';
import { isCalendarUnavailable } from '../../lib/calendar/errors';
import { assertV2ObjectsAvailable, readCalendarV2Capabilities } from '../../lib/calendar/v2/capabilities';
import { CalendarV2Error, invalidValue, v2ErrorFrom } from '../../lib/calendar/v2/errors';
import {
  createObjectV2,
  deleteObjectV2,
  parseCreateRequest,
  parsePatchRequest,
  patchObjectV2,
  readObjectIcsV2,
  readObjectV2,
  requireIfMatch,
} from '../../lib/calendar/v2/objects';
import { sameOriginWrites } from '../../lib/http/same-origin-writes';

const log = logger.child({ scope: 'calendar-admin-v2-routes' });

interface AdminUser { id: string; email?: string | null; role?: string | null }
type Env = { Variables: { user: AdminUser | undefined } };

export const calendarAdminV2 = new Hono<Env>();

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const BASE_PATH = '/api/admin/calendar/v2';

// ─── Errori ───────────────────────────────

calendarAdminV2.onError((err, c) => {
  const v2 = v2ErrorFrom(err);
  if (v2) {
    if (v2.status >= 500) log.error({ code: v2.code, url: c.req.path, method: c.req.method }, v2.message);
    return c.json(v2.toBody(), v2.status);
  }
  if (isCalendarUnavailable(err)) {
    log.warn({ reason: err.reason, url: c.req.path, method: c.req.method }, 'calendario non disponibile');
    return c.json({ error: err.message, code: 'CALENDAR_UNAVAILABLE' }, 503);
  }
  throw err;
});

// Difesa in profondità: il JWT admin lo verifica già authMiddleware (protectedPaths di app.ts).
calendarAdminV2.use('*', async (c, next) => {
  if (!c.get('user')?.id) return c.json({ error: 'Autenticazione richiesta', code: 'VALIDATION_FAILED' }, 401);
  await next();
});

// Difesa CSRF (contratto §3.1): vedi lib/http/same-origin-writes.ts. Nessun percorso multipart.
calendarAdminV2.use('*', sameOriginWrites({ log }));

calendarAdminV2.use(
  '*',
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: 'Corpo della richiesta troppo grande (massimo 2 MB)', code: 'VALIDATION_FAILED' }, 413),
  }),
);

// ─── Utilità ───────────────────────────────

function actorOf(c: { get(key: 'user'): AdminUser | undefined }): { userId: string | null } {
  return { userId: c.get('user')?.id ?? null };
}

async function readJson(c: { req: { text(): Promise<string> } }): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) throw invalidValue('Corpo della richiesta mancante');
  try {
    return JSON.parse(text);
  } catch {
    throw invalidValue('Il corpo della richiesta non è JSON valido');
  }
}

/** Nome del file di GET /objects/:id/ics: l'UID senza caratteri che romperebbero l'header. */
function safeFilename(uid: string): string {
  const base = uid.replace(/[^A-Za-z0-9._@-]+/g, '_').replace(/^\.+/, '').slice(0, 100);
  return `${base || 'evento'}.ics`;
}

// ─── Capacità ───────────────────────────────

calendarAdminV2.get('/capabilities', async (c) => c.json(await readCalendarV2Capabilities()));

// ─── Letture ───────────────────────────────

calendarAdminV2.get('/objects/:id/ics', async (c) => {
  const { ics, etag, uid } = await readObjectIcsV2(c.req.param('id'));
  if (etag) c.header('ETag', etag);
  c.header('Content-Type', 'text/calendar; charset=utf-8');
  c.header('Content-Disposition', `inline; filename="${safeFilename(uid)}"`);
  c.header('Cache-Control', 'no-store');
  return c.body(ics);
});

calendarAdminV2.get('/objects/:id', async (c) => {
  const view = await readObjectV2(c.req.param('id'), {
    recurrenceKey: c.req.query('recurrence_key'),
    originalStart: c.req.query('original_start'),
  });
  if (view.etag) c.header('ETag', view.etag);
  c.header('Cache-Control', 'no-store');
  return c.json(view);
});

// ─── Scritture ───────────────────────────────

calendarAdminV2.patch('/objects/:id', async (c) => {
  await assertV2ObjectsAvailable();
  const ifMatch = c.req.header('If-Match') ?? '';
  requireIfMatch(ifMatch);
  const req = parsePatchRequest(await readJson(c));
  const res = await patchObjectV2(c.req.param('id'), ifMatch, req, actorOf(c));
  if (res.etag) c.header('ETag', res.etag);
  return c.json(res);
});

calendarAdminV2.post('/objects', async (c) => {
  await assertV2ObjectsAvailable();
  const req = parseCreateRequest(await readJson(c));
  const res = await createObjectV2(req, actorOf(c));
  if (req.dryRun) return c.json(res);
  if (res.etag) c.header('ETag', res.etag);
  if (res.object?.id) c.header('Location', `${BASE_PATH}/objects/${encodeURIComponent(res.object.id)}`);
  return c.json(res, 201);
});

calendarAdminV2.delete('/objects/:id', async (c) => {
  await assertV2ObjectsAvailable();
  const ifMatch = c.req.header('If-Match') ?? '';
  requireIfMatch(ifMatch);
  // Senza recurrence_key vale il componente indicato dall'id (un id di override ha come target quell'override);
  // senza scope lo decide deleteObjectV2: "tutto" solo per il master, per un'istanza va scelto.
  const recurrenceKey = c.req.query('recurrence_key');
  const scopeParam = c.req.query('scope');
  if (scopeParam !== undefined && !(CAL_V2_SCOPES as readonly string[]).includes(scopeParam)) {
    throw new CalendarV2Error('SCOPE_INVALID', 400, 'scope non valido');
  }
  const dry = c.req.query('dry_run');
  const dryRun = dry === '1' || dry === 'true';
  const res = await deleteObjectV2(
    c.req.param('id'),
    ifMatch,
    { scope: scopeParam === undefined ? undefined : (scopeParam as CalV2Scope), recurrenceKey, dryRun },
    actorOf(c),
  );
  if (res.etag) c.header('ETag', res.etag);
  return c.json(res);
});
