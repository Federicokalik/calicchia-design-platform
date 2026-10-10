/**
 * Consumatori del calendario sullo store (fase F2; design §7, §9, §12, §14;
 * contratto dei moduli docs/calendar-radicale/contracts/f2-modules.md §1.4 e
 * §9): agenda del device, tool MCP, route admin. Senza Radicale: l'indice è
 * popolato con l'API dell'indicizzatore e lo store Radicale si forza con
 * overrideCalendarStore('radicale'); RADICALE_URL non è impostata, quindi le
 * decisioni e le scritture verso Radicale rispondono "non disponibile".
 *
 * Casi:
 *  - agenda del device con lo store Radicale: ricorrenze espanse, giorno di
 *    Roma, cancellati esclusi, stessa forma JSON del legacy;
 *  - MCP create_booking con lo store indisponibile → ramo {error} esistente,
 *    senza `code`, nessuna prenotazione scritta (piano F2, "Test");
 *  - MCP list_events con lo store Radicale: descrizione delle proiezioni
 *    ricomposta da calendar_bookings col template di booking.ts; con lo store
 *    legacy i DTO passano invariati;
 *  - event_count di list_calendars e di GET /calendars dallo store, su
 *    entrambi gli store;
 *  - admin: CalendarUnavailableError → 503 {error, code}, conflitti nuovi → 409
 *    {error, code, conflicts?}, gli altri errori all'handler globale (500);
 *    descrizione delle proiezioni ricomposta in GET /events con lo store
 *    Radicale.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { executeTool } from '../../src/lib/agent/tools';
import { projectionDescription } from '../../src/lib/calendar/adapters';
import { countEventsByCalendar } from '../../src/lib/calendar/calendars';
import {
  CalendarFieldConflictError,
  CalendarRecurrenceConflictError,
  CalendarStoreUnavailableError,
} from '../../src/lib/calendar/errors';
import { applyCollectionChanges, loadCollectionContext, type RawItem, stopIndexWorker } from '../../src/lib/calendar/radicale/indexer';
import { type CalendarStore, getPgLegacyStore, overrideCalendarStore } from '../../src/lib/calendar/store';
import type { Booking, Calendar, EventType } from '../../src/lib/calendar/types';
import { freezeTime, restoreTime } from '../helpers/clock';
import { onBeforeDatabaseClose, onDatabaseReady, sql, useTestDatabase } from '../helpers/db';
import { api } from '../helpers/http';
import { romeIso, useFixtures } from '../helpers/fixtures';

useTestDatabase({ resetBaseline: true });
const fx = useFixtures('cons-route');

const H = Object.freeze({ start: new Date('2026-01-01T00:00:00Z'), end: new Date('2028-01-01T00:00:00Z') });

/** Chiavi di un evento dell'agenda del device (contratto device-agenda). */
const AGENDA_EVENT_KEYS = ['summary', 'start_time', 'end_time', 'all_day', 'source', 'status'];

function ics(...components: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//Consumatori//IT', ...components, 'END:VCALENDAR', ''].join('\r\n');
}

function vevent(lines: string[]): string {
  return ['BEGIN:VEVENT', 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT'].join('\r\n');
}

interface Scenario {
  cal: Calendar;
  bookings: Calendar;
  eventType: EventType;
  booking: Booking;
  device: { token: string; id: string };
}

let sc: Scenario;

async function indexItems(calendarId: string, items: Array<{ href: string; raw: string }>): Promise<void> {
  const context = await loadCollectionContext(sql, calendarId);
  const upserts: RawItem[] = items.map((i, n) => ({ href: i.href, etag: `"etag-${n}"`, raw: i.raw }));
  await applyCollectionChanges({
    context, upserts, deletes: [], radicaleSkipped: [], pending404: [], full: true,
    horizon: { start: H.start, end: H.end }, actor: 'test',
  }, { syncedAt: new Date() });
}

onDatabaseReady(async () => {
  overrideCalendarStore(null);
  const cal = await fx.calendar({ key: 'studio', name: 'Studio', blocks_availability: true });
  const bookings = await fx.calendar({ key: 'prenotazioni', name: 'Prenotazioni prova' });
  await sql`UPDATE calendars SET role = 'bookings' WHERE id = ${bookings.id}`;
  const eventType = await fx.eventType({ key: 'consulenza', title: 'Consulenza', durationMinutes: 30 });
  // Prenotazione senza proiezione legacy: la sua proiezione esiste solo nell'indice (store Radicale).
  const { booking } = await fx.booking({
    eventType,
    start: '2027-01-12T10:00:00Z',
    attendee: { name: 'Mario Rossi', phone: '+39 333 0000001', company: 'Rossi SRL', message: 'Vorrei un preventivo' },
    project: false,
  });

  // Serie di produzione lun-mar-gio-ven 09:00 Europe/Rome; singolo alle 00:15 di Roma di mercoledì 6
  // (martedì 5 in UTC); singolo annullato da un device.
  await indexItems(cal.id, [
    { href: 'serie.ics', raw: ics(vevent([
      'UID:serie-cons@test.invalid', 'DTSTART;TZID=Europe/Rome:20270104T090000', 'DTEND;TZID=Europe/Rome:20270104T100000',
      'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR', 'SUMMARY:Studio',
    ])) },
    { href: 'notturno.ics', raw: ics(vevent(['UID:notturno-cons@test.invalid', 'DTSTART:20270105T231500Z', 'DTEND:20270105T234500Z', 'SUMMARY:Notturno'])) },
    { href: 'annullato.ics', raw: ics(vevent(['UID:annullato-cons@test.invalid', 'DTSTART:20270106T100000Z', 'DTEND:20270106T110000Z', 'SUMMARY:Annullato', 'STATUS:CANCELLED'])) },
  ]);
  // Proiezione con il contenuto della decisione 3 (niente email): admin e MCP vedono quello di oggi.
  await indexItems(bookings.id, [{
    href: `booking-${booking.uid}.ics`,
    raw: ics(vevent([
      `UID:${booking.uid}@caldes.it`, 'DTSTART:20270112T100000Z', 'DTEND:20270112T103000Z',
      'SUMMARY:Consulenza – Mario Rossi', 'DESCRIPTION:Tel: +39 333 0000001\\nPrenotazione: https://admin.caldes.test/x',
    ])),
  }]);

  const device = await fx.deviceToken();
  sc = { cal, bookings, eventType, booking, device };
});

onBeforeDatabaseClose(async () => {
  overrideCalendarStore(null);
  restoreTime();
  await stopIndexWorker();
});

async function withStore<T>(store: 'radicale' | CalendarStore, fn: () => Promise<T>): Promise<T> {
  overrideCalendarStore(store);
  try {
    return await fn();
  } finally {
    overrideCalendarStore(null);
  }
}

describe('agenda del device sullo store Radicale (design §12, §14)', () => {
  test('ricorrenze espanse, giorno di Roma, cancellati esclusi, stessa forma JSON', async () => {
    await withStore('radicale', async () => {
      const day = async (date: string) => {
        const res = await api.get('/api/device/agenda', { auth: { bearer: sc.device.token }, query: { date } });
        assert.equal(res.status, 200, res.text);
        assert.deepEqual(Object.keys(res.json), ['date', 'events', 'next_event', 'last_event_end', 'pending_tasks', 'pending_notes']);
        for (const e of res.json.events) assert.deepEqual(Object.keys(e), AGENDA_EVENT_KEYS);
        return res.json.events.filter((e: { summary: string }) => !e.summary.startsWith('Consulenza'))
          .map((e: { summary: string; start_time: string; all_day: boolean; source: string; status: string }) => [e.summary, e.start_time, e.all_day, e.source, e.status]);
      };
      // Martedì 5: occorrenza della serie; il "Notturno" (23:15Z del 5) è già mercoledì a Roma.
      assert.deepEqual(await day('2027-01-05'), [['Studio', romeIso('2027-01-05', '09:00'), false, 'manual', 'confirmed']]);
      // Mercoledì 6: il "Notturno" alle 00:15 di Roma; nessuna occorrenza della serie; l'annullato escluso.
      assert.deepEqual(await day('2027-01-06'), [['Notturno', romeIso('2027-01-06', '00:15'), false, 'manual', 'confirmed']]);
      // Giovedì 7: di nuovo la serie.
      assert.deepEqual(await day('2027-01-07'), [['Studio', romeIso('2027-01-07', '09:00'), false, 'manual', 'confirmed']]);
    });
  });

  test('store non disponibile → 503 con il corpo pubblico, mai un\'agenda vuota', async () => {
    const failing = Object.create(getPgLegacyStore()) as CalendarStore;
    Object.defineProperty(failing, 'listOccurrences', { value: async () => { throw new CalendarStoreUnavailableError('test', 'listOccurrences'); } });
    await withStore(failing, async () => {
      const res = await api.get('/api/device/agenda', { auth: { bearer: sc.device.token }, query: { date: '2027-01-05' } });
      assert.equal(res.status, 503);
      assert.deepEqual(res.json, { error: 'Calendario temporaneamente non verificabile, riprova tra poco', code: 'CALENDAR_UNAVAILABLE' });
    });
  });
});

describe('tool MCP sullo store (design §9, §12)', () => {
  test('create_booking con lo store indisponibile → {error} senza code, nessuna prenotazione', async () => {
    // Lunedì 4 gennaio 2027, 08:00 a Roma; prenotazione mercoledì 6 alle 10:00 (schedule di baseline lun-ven).
    freezeTime('2027-01-04T07:00:00.000Z');
    try {
      const email = fx.email('mcp-indisponibile');
      const out = await withStore('radicale', () => executeTool('create_booking', {
        event_type_slug: sc.eventType.slug,
        start: romeIso('2027-01-06', '10:00'),
        attendee_name: 'Cliente MCP',
        attendee_email: email,
      }));
      const parsed = JSON.parse(out) as Record<string, unknown>;
      assert.deepEqual(Object.keys(parsed), ['error'], `solo il ramo {error} esistente: ${out}`);
      assert.match(String(parsed.error), /^Calendario temporaneamente non verificabile, riprova tra poco/);
      const [row] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM calendar_bookings WHERE attendee_email = ${email.toLowerCase()}`;
      assert.equal(row.n, 0, 'la transazione della decisione non scrive nulla');
    } finally {
      restoreTime();
    }
  });

  test('list_events: descrizione delle proiezioni ricomposta con lo store Radicale (testo di oggi)', async () => {
    const args = { calendar: sc.bookings.slug, from: '2027-01-12T00:00:00Z', to: '2027-01-13T00:00:00Z' };
    const radicale = JSON.parse(await withStore('radicale', () => executeTool('list_events', args)));
    assert.equal(radicale.count, 1, JSON.stringify(radicale));
    const [projection] = radicale.events;
    assert.equal(projection.source, 'booking');
    assert.equal(projection.source_id, sc.booking.uid);
    assert.equal(projection.description, projectionDescription(sc.booking));
    assert.match(projection.description, /^Cliente: Mario Rossi <.+@test\.invalid>\nTel: \+39 333 0000001\nAzienda: Rossi SRL\n\nNote:\nVorrei un preventivo\n\nUID prenotazione: /);
    // Store legacy: nessuna proiezione legacy (project: false), nessuna ricomposizione.
    const legacy = JSON.parse(await executeTool('list_events', args));
    assert.equal(legacy.count, 0);
  });

  test('list_calendars: event_count dallo store (legacy e indice)', async () => {
    const legacyCounts = await countEventsByCalendar();
    const legacy = JSON.parse(await executeTool('list_calendars', {}));
    for (const c of legacy.calendars as Array<{ id: string; event_count: number }>) {
      assert.equal(c.event_count, legacyCounts.get(c.id) ?? 0);
    }
    const radicale = JSON.parse(await withStore('radicale', () => executeTool('list_calendars', {})));
    const mine = (radicale.calendars as Array<{ id: string; event_count: number }>).find((c) => c.id === sc.cal.id);
    // Semantica legacy: VEVENT non cancellati (serie e "Notturno"; l'annullato no).
    assert.equal(mine?.event_count, 2);
    const route = await withStore('radicale', () => api.get('/api/admin/calendar/calendars', { auth: 'admin' }));
    assert.equal(route.status, 200);
    assert.equal(route.json.calendars.find((c: { id: string }) => c.id === sc.cal.id)?.event_count, 2);
  });
});

describe('route admin: errori nuovi e proiezioni (contratto f2-modules §1.4)', () => {
  function storeWith(overrides: Partial<Record<keyof CalendarStore, unknown>>): CalendarStore {
    const store = Object.create(getPgLegacyStore()) as CalendarStore;
    for (const [name, value] of Object.entries(overrides)) Object.defineProperty(store, name, { value });
    return store;
  }

  test('CalendarUnavailableError → 503 {error, code}', async () => {
    const store = storeWith({ listCalendars: async () => { throw new CalendarStoreUnavailableError('test', 'listCalendars'); } });
    const res = await withStore(store, () => api.get('/api/admin/calendar/calendars', { auth: 'admin' }));
    assert.equal(res.status, 503);
    assert.deepEqual(Object.keys(res.json), ['error', 'code']);
    assert.equal(res.json.code, 'CALENDAR_UNAVAILABLE');
    // Anche dal ramo con try/catch di GET /events.
    const events = await withStore(storeWith({ listOccurrences: async () => { throw new CalendarStoreUnavailableError('test', 'listOccurrences'); } }), () =>
      api.get('/api/admin/calendar/events', { auth: 'admin', query: { from: '2027-01-04T00:00:00Z', to: '2027-01-11T00:00:00Z' } }));
    assert.equal(events.status, 503);
    assert.equal(events.json.code, 'CALENDAR_UNAVAILABLE');
  });

  test('CAS per campo → 409 con i conflitti; recurrence_key sparita → 409; errore qualsiasi → 500 globale', async () => {
    const conflicts = [{ field: 'summary', base: 'A', theirs: 'B', yours: 'C' }];
    const store = storeWith({
      updateEvent: async () => { throw new CalendarFieldConflictError(conflicts); },
      createOccurrenceOverride: async () => { throw new CalendarRecurrenceConflictError('20270105T080000Z'); },
      deleteEvent: async () => { throw new Error('guasto inatteso'); },
    });
    await withStore(store, async () => {
      const put = await api.put('/api/admin/calendar/events/00000000-0000-4000-8000-000000000001', { auth: 'admin', body: { summary: 'C' } });
      assert.equal(put.status, 409);
      assert.deepEqual(put.json, {
        error: "L'evento è stato modificato nel frattempo: verifica le modifiche e riprova",
        code: 'CALENDAR_CONFLICT',
        conflicts,
      });
      const exception = await api.post('/api/admin/calendar/events/00000000-0000-4000-8000-000000000001/exception', {
        auth: 'admin', body: { original_start: '2027-01-05T08:00:00Z', status: 'cancelled' },
      });
      assert.equal(exception.status, 409);
      assert.deepEqual(exception.json, { error: "L'occorrenza non esiste più nella serie: ricarica l'evento e riprova", code: 'CALENDAR_CONFLICT' });
      const del = await api.delete('/api/admin/calendar/events/00000000-0000-4000-8000-000000000001', { auth: 'admin' });
      assert.equal(del.status, 500);
      assert.deepEqual(del.json, { error: 'Internal Server Error' });
    });
  });

  test('GET /events con lo store Radicale: descrizione delle proiezioni ricomposta', async () => {
    const res = await withStore('radicale', () => api.get('/api/admin/calendar/events', {
      auth: 'admin', query: { calendar_id: sc.bookings.id, from: '2027-01-12T00:00:00Z', to: '2027-01-13T00:00:00Z' },
    }));
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.events.length, 1);
    assert.equal(res.json.events[0].description, projectionDescription(sc.booking));
  });
});
