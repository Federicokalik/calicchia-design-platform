/**
 * Facade a due store del calendario (fase F2 del passaggio a Radicale):
 * store.ts, backend-mode.ts, le facade events.ts, calendars.ts e
 * subscriptions.ts e lo stub di RadicaleStore. Riferimenti: design §12
 * "Facade", §13.1; contratto docs/calendar-radicale/contracts/f2-modules.md §1.
 *
 * - mode postgres → PgLegacyStore, cioè il codice di prima (i contratti F0
 *   lo verificano nel dettaglio; qui solo la selezione);
 * - tabella modo → store, scritture sospese in cutover e rollback, freeze;
 * - letture con il modo in cache per 2 s, scritture con il modo riletto;
 * - override per i test (tipo e istanza), vietato in produzione;
 * - ogni funzione della facade delega all'operazione omonima dello store;
 * - stesse classi d'errore per facade, legacy ed errors.ts;
 * - le letture portate sullo store (conteggi, chiusure, feed) danno con
 *   PgLegacyStore esattamente le risposte delle route di oggi;
 * - RadicaleStore senza Radicale configurato (i test tolgono RADICALE_URL):
 *   letture dal sidecar e dall'indice, scritture 503 radicale_unreachable
 *   (contratto §1.6, §6.2); freeze e transizioni restano della facade.
 *
 * I test che cambiano il modo scrivono calendar_backend_state con commit e lo
 * riportano sempre a postgres (finally e baseline a fine file).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  BACKEND_MODE_CACHE_MS,
  invalidateBackendModeCache,
  peekBackendState,
  readBackendStateCached,
  readBackendStateFresh,
  readStoreKind,
  resolveWriteStoreKind,
  startBackendModeListener,
  storeKindForMode,
  writesSuspendedInMode,
} from '../../src/lib/calendar/backend-mode';
import * as calendarsFacade from '../../src/lib/calendar/calendars';
import * as errors from '../../src/lib/calendar/errors';
import * as eventsFacade from '../../src/lib/calendar/events';
import type { Db } from '../../src/lib/calendar/radicale/policy';
import { BACKEND_MODES } from '../../src/lib/calendar/radicale/types';
import {
  CALENDAR_STORE_OPERATIONS,
  CALENDAR_STORE_WRITE_OPERATIONS,
  type CalendarStore,
  calendarStore,
  calendarStoreForWrite,
  getPgLegacyStore,
  overrideCalendarStore,
  PgLegacyStore,
} from '../../src/lib/calendar/store';
import * as subscriptionsFacade from '../../src/lib/calendar/subscriptions';
import { onBeforeDatabaseClose, sql } from '../helpers/db';
import { withEnv } from '../helpers/env';
import { addDays, romeIso, useFixtures } from '../helpers/fixtures';
import { api } from '../helpers/http';

const fx = useFixtures('store-facade', { resetBaseline: true });

const VOLUME = '5c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5';

async function setMode(mode: string, extra: { write_freeze?: boolean } = {}): Promise<void> {
  if (mode === 'postgres') {
    await sql`UPDATE calendar_backend_state SET mode = 'postgres', write_freeze = false, volume_id = NULL, epoch = 0`;
  } else {
    await sql`
      UPDATE calendar_backend_state
      SET mode = ${mode}, write_freeze = ${extra.write_freeze ?? false}, volume_id = ${VOLUME}::uuid, epoch = 1
    `;
  }
  invalidateBackendModeCache();
}

// Prima della chiusura del pool (un after() di primo livello girerebbe a pool chiuso).
onBeforeDatabaseClose(async () => {
  overrideCalendarStore(null);
  await setMode('postgres');
});

describe('selezione dello store dal modo', () => {
  test('tabella del design §13.1: postgres e cutover → PG, gli altri → Radicale; scritture sospese in cutover e rollback', () => {
    const table = Object.fromEntries(BACKEND_MODES.map((m) => [m, [storeKindForMode(m), writesSuspendedInMode(m)]]));
    assert.deepEqual(table, {
      postgres: ['postgres', false],
      cutover: ['postgres', true],
      radicale: ['radicale', false],
      rollback: ['radicale', true],
      finalized: ['radicale', false],
    });
  });

  test('mode postgres (produzione dopo il deploy della F2): PgLegacyStore per letture e scritture', async () => {
    await setMode('postgres');
    assert.equal(await calendarStore(), getPgLegacyStore());
    assert.equal(await calendarStoreForWrite(), getPgLegacyStore());
    assert.ok(getPgLegacyStore() instanceof PgLegacyStore);
    assert.equal(getPgLegacyStore().kind, 'postgres');
    const lavoro = await calendarsFacade.getCalendar('lavoro');
    assert.equal(lavoro?.slug, 'lavoro');
  });

  test('cutover: letture da PG, scritture 503 transition', async () => {
    const cal = await fx.calendar({ key: 'cutover', name: fx.name('Cutover') });
    try {
      await setMode('cutover');
      assert.equal((await calendarsFacade.getCalendar(cal.id))?.id, cal.id);
      await assert.rejects(
        eventsFacade.createEvent({ calendar_id: cal.id, summary: fx.name('Mai'), start_time: romeIso('2027-02-01', '10:00'), end_time: romeIso('2027-02-01', '11:00') }),
        (err: unknown) => err instanceof errors.CalendarUnavailableError && err.reason === 'transition' && err.status === 503,
      );
      await assert.rejects(calendarsFacade.updateCalendar(cal.id, { color: '#000000' }), errors.CalendarUnavailableError);
      await assert.rejects(calendarsFacade.getOrCreateFestivitaCalendar(), errors.CalendarUnavailableError);
    } finally {
      await setMode('postgres');
    }
  });

  test('radicale: RadicaleStore (letture dal sidecar, scritture senza Radicale → 503 radicale_unreachable); freeze → 503 write_freeze; rollback → 503 transition', async () => {
    const cal = await fx.calendar({ key: 'radicale', name: fx.name('Radicale') });
    try {
      await setMode('radicale');
      assert.equal((await calendarStore()).kind, 'radicale');
      // Letture: dal sidecar dei calendari, senza I/O verso Radicale.
      const listed = await calendarsFacade.listCalendars();
      assert.ok(listed.some((c) => c.id === cal.id), 'il calendario del sidecar compare');
      assert.equal((await calendarsFacade.getCalendar(cal.id))?.id, cal.id);
      // Scritture: Radicale non configurato → 503 dichiarato, mai un errore generico.
      await assert.rejects(
        eventsFacade.createEvent({ calendar_id: cal.id, summary: fx.name('Mai'), start_time: romeIso('2027-02-01', '10:00'), end_time: romeIso('2027-02-01', '11:00') }),
        (err: unknown) =>
          err instanceof errors.CalendarUnavailableError &&
          err.reason === 'radicale_unreachable' &&
          err.status === 503 &&
          err.code === 'CALENDAR_UNAVAILABLE',
      );

      await setMode('radicale', { write_freeze: true });
      await assert.rejects(eventsFacade.deleteEvent('x'), (err: unknown) => err instanceof errors.CalendarUnavailableError && err.reason === 'write_freeze');
      // Le letture non dipendono dal freeze (id sconosciuto → null, come oggi).
      assert.equal(await eventsFacade.getEvent('x'), null);

      await setMode('rollback');
      assert.equal((await calendarStore()).kind, 'radicale');
      await assert.rejects(subscriptionsFacade.syncAllSubscriptions(), (err: unknown) => err instanceof errors.CalendarUnavailableError && err.reason === 'transition');
    } finally {
      await setMode('postgres');
    }
  });

  test('freeze in mode postgres non conta (contratto control-plane §6.2): scritture come oggi', async () => {
    await sql`UPDATE calendar_backend_state SET write_freeze = true`;
    invalidateBackendModeCache();
    try {
      assert.equal(await resolveWriteStoreKind(), 'postgres');
    } finally {
      await setMode('postgres');
    }
  });
});

describe('cache del modo', () => {
  test('letture: cache di 2 s; scritture: modo riletto subito', async () => {
    await setMode('postgres');
    assert.equal(await readStoreKind(), 'postgres');
    try {
      // Cambio di modo senza invalidazione: le letture restano su PG finché la cache vale.
      await sql`UPDATE calendar_backend_state SET mode = 'radicale', volume_id = ${VOLUME}::uuid, epoch = 1`;
      assert.equal(await readStoreKind(), 'postgres');
      assert.equal(await resolveWriteStoreKind(), 'radicale', 'le scritture rileggono senza cache');
      // La lettura fresca ha aggiornato anche la cache.
      assert.equal(await readStoreKind(), 'radicale');
      assert.equal(peekBackendState()?.state.mode, 'radicale');
    } finally {
      await setMode('postgres');
    }
    assert.equal(await readStoreKind(), 'postgres');
  });

  test('stato illeggibile: 503 state_unreadable senza cache, ultimo stato noto con la cache scaduta', async () => {
    const failing = (() => { throw new Error('database giù'); }) as unknown as Db;
    invalidateBackendModeCache();
    await assert.rejects(readBackendStateCached(failing), (err: unknown) => err instanceof errors.CalendarUnavailableError && err.reason === 'state_unreadable');
    await assert.rejects(readBackendStateFresh(failing), (err: unknown) => err instanceof errors.CalendarUnavailableError && err.reason === 'state_unreadable');
    const real = await readBackendStateCached();
    assert.equal(real.mode, 'postgres');
    await new Promise((r) => setTimeout(r, BACKEND_MODE_CACHE_MS + 100));
    assert.equal((await readBackendStateCached(failing)).mode, 'postgres', 'ultimo stato noto');
    // La lettura fresca non usa mai la cache.
    await assert.rejects(readBackendStateFresh(failing), errors.CalendarUnavailableError);
    invalidateBackendModeCache();
  });

  test('listener: NOTIFY calendar_policy_changed invalida la cache', async () => {
    await setMode('postgres');
    await readBackendStateCached();
    assert.ok(peekBackendState());
    const stop = await startBackendModeListener();
    try {
      await sql`UPDATE calendar_backend_state SET restore_guard_until = now() + interval '1 minute'`;
      for (let i = 0; i < 100 && peekBackendState(); i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(peekBackendState(), null);
    } finally {
      await stop();
      await sql`UPDATE calendar_backend_state SET restore_guard_until = NULL`;
      invalidateBackendModeCache();
    }
  });
});

describe('override per i test', () => {
  test('tipo: lo store Radicale anche in mode postgres; null lo toglie', async () => {
    await setMode('postgres');
    overrideCalendarStore('radicale');
    try {
      assert.equal((await calendarStore()).kind, 'radicale');
      assert.equal(await readStoreKind(), 'radicale', 'vale anche per backend-mode (busy)');
      // RadicaleStore vero: senza Radicale configurato le scritture rispondono
      // 503 radicale_unreachable dopo le guardie di oggi, senza righe parziali.
      await assert.rejects(
        calendarsFacade.createCalendar({ name: fx.name('Override'), slug: fx.slug('override') }),
        (err: unknown) => err instanceof errors.CalendarUnavailableError && err.reason === 'radicale_unreachable',
      );
      assert.equal((await sql`SELECT 1 FROM calendars WHERE slug = ${fx.slug('override')}`).length, 0);
    } finally {
      overrideCalendarStore(null);
    }
    assert.equal((await calendarStore()).kind, 'postgres');
  });

  test('vietato in produzione', async () => {
    await withEnv({ NODE_ENV: 'production' }, () => {
      assert.throws(() => overrideCalendarStore('radicale'), /vietato in produzione/);
      overrideCalendarStore(null);
    });
  });

  test('istanza: ogni funzione della facade delega all\'operazione omonima con gli stessi argomenti', async () => {
    const calls: Array<{ op: string; args: unknown[] }> = [];
    const fake = { kind: 'radicale' } as Record<string, unknown>;
    for (const op of CALENDAR_STORE_OPERATIONS) {
      fake[op] = async (...args: unknown[]) => { calls.push({ op, args }); return `${op}-result`; };
    }
    overrideCalendarStore(fake as unknown as CalendarStore);
    try {
      const facade: Record<string, (...a: unknown[]) => Promise<unknown>> = {
        ...(eventsFacade as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>),
        ...(calendarsFacade as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>),
        ...(subscriptionsFacade as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>),
      };
      for (const op of CALENDAR_STORE_OPERATIONS) {
        assert.equal(typeof facade[op], 'function', `la facade esporta ${op}`);
        const args = [`${op}-a`, { b: op }];
        calls.length = 0;
        assert.equal(await facade[op](...args), `${op}-result`);
        assert.equal(calls.length, 1, op);
        assert.equal(calls[0].op, op);
        // Gli argomenti dichiarati arrivano allo store invariati e nello stesso ordine.
        const declared = Math.min(facade[op].length, args.length);
        if (facade[op].length === 0) assert.deepEqual(calls[0].args, [], op);
        else assert.deepEqual(calls[0].args.slice(0, declared), args.slice(0, declared), op);
      }
      // Classificazione delle scritture: tutte modificano lo stato o possono crearlo.
      for (const op of CALENDAR_STORE_WRITE_OPERATIONS) assert.ok((CALENDAR_STORE_OPERATIONS as readonly string[]).includes(op));
    } finally {
      overrideCalendarStore(null);
    }
  });
});

describe('errori condivisi', () => {
  test('la facade riesporta le classi di errors.ts e il codice legacy le lancia', async () => {
    assert.equal(eventsFacade.EventValidationError, errors.EventValidationError);
    assert.equal(eventsFacade.EventReadOnlyError, errors.EventReadOnlyError);
    assert.equal(calendarsFacade.CalendarValidationError, errors.CalendarValidationError);
    assert.equal(calendarsFacade.CalendarConflictError, errors.CalendarConflictError);
    assert.equal(calendarsFacade.CalendarSystemError, errors.CalendarSystemError);
    assert.equal(subscriptionsFacade.SubscriptionValidationError, errors.SubscriptionValidationError);
    await setMode('postgres');
    await assert.rejects(
      eventsFacade.createEvent({ calendar_id: 'x', summary: ' ', start_time: '2027-01-01T10:00:00Z', end_time: '2027-01-01T11:00:00Z' }),
      (err: unknown) => err instanceof eventsFacade.EventValidationError && (err as Error).message === 'Titolo richiesto',
    );
    await assert.rejects(calendarsFacade.createCalendar({ slug: 'Slug Non Valido', name: 'x' }), calendarsFacade.CalendarValidationError);
    assert.equal(calendarsFacade.isValidTimeZone('Europe/Rome'), true);
    assert.equal(calendarsFacade.isValidTimeZone('Europe/Rom'), false);
  });

  test('CalendarUnavailableError: corpo pubblico generico (design §9), mai il motivo', () => {
    const err = new errors.CalendarUnavailableError('collection_unsyncable', 'collezione c');
    assert.deepEqual(err.toPublicBody(), { error: 'Calendario temporaneamente non verificabile, riprova tra poco', code: 'CALENDAR_UNAVAILABLE' });
    assert.equal(err.status, 503);
    assert.ok(errors.isCalendarUnavailable(err));
    const field = new errors.CalendarFieldConflictError([{ field: 'summary', base: 'a', theirs: 'b', yours: 'c' }]);
    assert.ok(field instanceof errors.CalendarConflictError);
    assert.equal(field.code, 'CALENDAR_CONFLICT');
    assert.ok(new errors.CalendarRecurrenceConflictError('20270104T080000Z') instanceof errors.CalendarConflictError);
  });
});

describe('letture dei consumatori portate sullo store (PgLegacyStore = route di oggi)', () => {
  test('countEventsByCalendar, listClosures e buildCalendarFeed coincidono con le risposte delle route', async () => {
    await setMode('postgres');
    const cal = await fx.calendar({ key: 'consumers', name: fx.name('Consumatori') });
    const festivita = await fx.holidayCalendar();
    const today = new Date().toISOString().slice(0, 10);
    await fx.event({ calendar: cal, summary: 'Singolo', start_time: `${addDays(today, 3)}T09:00:00.000Z`, end_time: `${addDays(today, 3)}T10:00:00.000Z` });
    await fx.series({
      calendar: cal, summary: 'Serie', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,TH,FR',
      start_time: `${addDays(today, 1)}T07:00:00.000Z`, end_time: `${addDays(today, 1)}T08:00:00.000Z`,
    });
    await fx.event({ calendar: cal, summary: 'Annullato', start_time: `${addDays(today, 4)}T09:00:00.000Z`, end_time: `${addDays(today, 4)}T10:00:00.000Z`, status: 'cancelled' });
    await fx.closure(festivita, { from: addDays(today, 10), to: addDays(today, 12), summary: 'Ferie' });

    // event_count di GET /calendars.
    const counts = await calendarsFacade.countEventsByCalendar();
    const listed = await api.get('/api/admin/calendar/calendars', { auth: 'admin' });
    assert.equal(listed.status, 200);
    for (const row of listed.json.calendars as Array<{ id: string; event_count: number }>) {
      assert.equal(counts.get(row.id) ?? 0, row.event_count, `event_count di ${row.id}`);
    }
    assert.equal(counts.get(cal.id), 2, 'singolo e master, non il cancellato');

    // GET /closures.
    const closures = await calendarsFacade.listClosures();
    const route = await api.get('/api/admin/calendar/closures', { auth: 'admin' });
    assert.equal(route.status, 200);
    assert.deepEqual(JSON.parse(JSON.stringify(closures)), route.json);
    assert.equal(closures.calendar.id, festivita.id);
    assert.equal(closures.closures.length, 1);

    // Feed ICS: stesso corpo a meno di DTSTAMP (l'istante della generazione), nessun ETag.
    const feed = await eventsFacade.buildCalendarFeed(cal, { now: new Date(), uidDomain: 'api.caldes.test' });
    assert.equal(feed.etag, null);
    const res = await api.get(`/api/calendar/feed/${cal.ics_feed_token}.ics`);
    assert.equal(res.status, 200);
    const stripStamp = (ics: string) => ics.replace(/^DTSTAMP:.*$/gm, 'DTSTAMP:<fisso>');
    assert.equal(stripStamp(feed.body), stripStamp(res.text));
    assert.match(feed.body, /RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR/);
    assert.equal(res.headers.get('etag'), null, 'il feed legacy resta senza ETag');
  });
});
