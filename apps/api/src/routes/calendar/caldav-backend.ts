/**
 * Backend CalDAV — endpoint INTERNI chiamati dal plugin Radicale (storage+auth).
 * Postgres resta l'unica fonte di verità: questi endpoint riusano le funzioni
 * calendario esistenti. Mai esposti dal reverse proxy pubblico; protetti da
 * `caldavServiceAuth` (Bearer CALDAV_SERVICE_TOKEN) montato in app.ts.
 *
 * Copre lettura + scrittura (PUT/DELETE) + auth device (app-password).
 */

import { Hono } from 'hono';
import { listCalendars, getCalendar } from '../../lib/calendar/calendars';
import {
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  createOccurrenceOverride,
  listEventsForCollection,
  getEventOverrides,
  caldavEtag,
  EventValidationError,
} from '../../lib/calendar/events';
import { buildIcsResource } from '../../lib/calendar/ics-feed';
import { parseIcs } from '../../lib/calendar/ics-import';
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

// ─── PUT: crea/aggiorna una risorsa (.ics: master + override) ────────────
caldavBackend.put('/collections/:slug/items/:uid', async (c) => {
  const cal = await getCalendar(c.req.param('slug'));
  if (!cal) return c.json({ error: 'Collezione non trovata' }, 404);
  const uid = c.req.param('uid').replace(/\.ics$/i, '');

  const raw = await c.req.text();
  let parsed;
  try {
    parsed = parseIcs(raw);
  } catch {
    return c.json({ error: 'ICS non valido' }, 400);
  }
  if (!parsed.length) return c.json({ error: 'Nessun VEVENT' }, 400);

  // Un UID = una risorsa: il VEVENT senza RECURRENCE-ID è il master/singolo,
  // quelli con RECURRENCE-ID sono override della stessa serie.
  const masterInput = parsed.find((p) => !p.recurrence_id);
  const overrideInputs = parsed.filter((p) => p.recurrence_id);

  try {
    let master = await getEvent(uid);
    if (master && master.calendar_id !== cal.id) {
      return c.json({ error: 'UID appartiene a un altro calendario' }, 409);
    }

    if (masterInput) {
      const fields = {
        summary: masterInput.summary,
        description: masterInput.description ?? null,
        location: masterInput.location ?? null,
        url: masterInput.url ?? null,
        start_time: masterInput.start_time,
        end_time: masterInput.end_time,
        all_day: masterInput.all_day,
        rrule: masterInput.rrule ?? null,
        exdates: masterInput.exdates ?? [],
        status: masterInput.status,
      };
      master = master
        ? await updateEvent(master.id, fields)
        : await createEvent({ calendar_id: cal.id, uid, source: 'manual', ...fields });
    }

    if (overrideInputs.length && master) {
      const existing = await getEventOverrides(master.id);
      for (const ov of overrideInputs) {
        const match = existing.find(
          (e) => e.recurrence_id && new Date(e.recurrence_id).getTime() === new Date(ov.recurrence_id!).getTime(),
        );
        if (match) {
          await updateEvent(match.id, {
            summary: ov.summary,
            description: ov.description ?? null,
            start_time: ov.start_time,
            end_time: ov.end_time,
            all_day: ov.all_day,
            status: ov.status,
          });
        } else {
          await createOccurrenceOverride({
            masterEventId: master.id,
            originalStartIso: ov.recurrence_id!,
            newStartIso: ov.start_time,
            newEndIso: ov.end_time,
            newSummary: ov.summary,
            newDescription: ov.description ?? undefined,
            status: ov.status,
          });
        }
      }
    }

    if (!master) return c.json({ error: 'Risorsa senza master' }, 400);
    return c.body(null, 201, { ETag: caldavEtag(master) });
  } catch (err) {
    if (err instanceof EventValidationError) return c.json({ error: err.message }, 400);
    if ((err as { code?: string }).code === '23505') return c.json({ error: 'UID già esistente' }, 409);
    throw err;
  }
});

// ─── DELETE: rimuove la risorsa (master → cascade sugli override) ────────
caldavBackend.delete('/collections/:slug/items/:uid', async (c) => {
  const cal = await getCalendar(c.req.param('slug'));
  if (!cal) return c.json({ error: 'Collezione non trovata' }, 404);
  const uid = c.req.param('uid').replace(/\.ics$/i, '');

  const master = await getEvent(uid);
  if (!master || master.calendar_id !== cal.id || master.recurrence_master_id) {
    return c.json({ error: 'Evento non trovato' }, 404);
  }
  await deleteEvent(master.id);
  return c.body(null, 204);
});
