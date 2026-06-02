/**
 * Backend CalDAV — endpoint INTERNI chiamati dal plugin Radicale (storage+auth).
 * Postgres resta l'unica fonte di verità: questi endpoint riusano le funzioni
 * calendario esistenti. Mai esposti dal reverse proxy pubblico; protetti da
 * `caldavServiceAuth` (Bearer CALDAV_SERVICE_TOKEN) montato in app.ts.
 *
 * FASE 1: sola lettura + verifica credenziali. La scrittura (PUT/DELETE) arriva
 * in Fase 2.
 */

import { Hono } from 'hono';
import { listCalendars, getCalendar } from '../../lib/calendar/calendars';
import {
  getEvent,
  listEventsForCollection,
  getEventOverrides,
  caldavEtag,
} from '../../lib/calendar/events';
import { buildIcsResource } from '../../lib/calendar/ics-feed';
import { verifyCredentials } from '../../lib/calendar/caldav-passwords';
import { getClientIp } from '../../lib/client-ip';
import { createRateLimit } from '../../middleware/rate-limit';
import type { Calendar } from '../../lib/calendar/types';

export const caldavBackend = new Hono();

// Anti-bruteforce sul controllo credenziali (il device ripassa l'auth a ogni
// richiesta, quindi il limite è generoso ma presente).
const verifyLimit = createRateLimit(30, 60_000);

function collectionDTO(cal: Calendar) {
  return {
    id: cal.id,
    slug: cal.slug,
    displayName: cal.name,
    description: cal.description,
    color: cal.color,
    timezone: cal.timezone,
    blocks_availability: cal.blocks_availability,
  };
}

// ─── Auth device (Basic) ────────────────────────────────────────────────
caldavBackend.post('/verify-credentials', verifyLimit, async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const username = typeof body.username === 'string' ? body.username : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const result = await verifyCredentials(username, password, getClientIp(c) ?? undefined);
  if (!result.ok) return c.json({ ok: false }, 401);
  return c.json({ ok: true, principal: result.principal });
});

// ─── Collezioni (calendari) ─────────────────────────────────────────────
caldavBackend.get('/collections', async (c) => {
  const cals = await listCalendars();
  return c.json({ collections: cals.map(collectionDTO) });
});

caldavBackend.get('/collections/:slug', async (c) => {
  const cal = await getCalendar(c.req.param('slug'));
  if (!cal) return c.json({ error: 'Collezione non trovata' }, 404);
  return c.json({ collection: collectionDTO(cal) });
});

// ─── Items (manifest href+uid+etag) ─────────────────────────────────────
caldavBackend.get('/collections/:slug/items', async (c) => {
  const cal = await getCalendar(c.req.param('slug'));
  if (!cal) return c.json({ error: 'Collezione non trovata' }, 404);
  const events = await listEventsForCollection(cal.id);
  return c.json({
    items: events.map((e) => ({ uid: e.uid, href: `${e.uid}.ics`, etag: caldavEtag(e) })),
  });
});

// ─── Singola risorsa (.ics: master + override) ──────────────────────────
caldavBackend.get('/collections/:slug/items/:uid', async (c) => {
  const cal = await getCalendar(c.req.param('slug'));
  if (!cal) return c.json({ error: 'Collezione non trovata' }, 404);

  const uid = c.req.param('uid').replace(/\.ics$/i, '');
  const master = await getEvent(uid);
  if (!master || master.calendar_id !== cal.id || master.recurrence_master_id) {
    return c.json({ error: 'Evento non trovato' }, 404);
  }
  const overrides = master.rrule ? await getEventOverrides(master.id) : [];
  const ics = buildIcsResource({ calendar: cal, master, overrides });
  return c.body(ics, 200, {
    'Content-Type': 'text/calendar; charset=utf-8',
    ETag: caldavEtag(master),
  });
});
