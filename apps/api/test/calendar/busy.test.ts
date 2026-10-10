/**
 * Busy fail-closed circoscritto, capacity sull'indice e protocollo di
 * decisione delle prenotazioni (apps/api/src/lib/calendar/{busy,capacity,
 * slots,booking,booking-projection}.ts; design §6.4, §6.5, §7, §9, §14;
 * decisione 1; contratto docs/calendar-radicale/contracts/f2-modules.md §7),
 * senza Radicale: l'indice si popola con l'indicizzatore (applyCollectionChanges)
 * e lo store Radicale si forza con overrideCalendarStore.
 *
 *  - mode postgres: stesso busy di oggi, ma un errore non diventa più un
 *    busy vuoto;
 *  - query di busy sull'indice: regola blocks, flag dei calendari e delle
 *    iscrizioni (decisione 5), proiezioni booking-* fuori dal busy, item non
 *    di proiezione della collezione bookings dentro;
 *  - salute: oggetto in quarantena (ultima versione buona, blocco
 *    conservativo, RRULE invalida) → busy conservativo e slot calcolati, mai
 *    un errore;
 *  - espansione al volo oltre materialized_until e fuori dall'orizzonte della
 *    collezione;
 *  - capacity: una SQL sull'indice con le esclusioni di oggi, stessi numeri
 *    dell'algoritmo legacy sugli stessi dati;
 *  - decisione con lo store Radicale e Radicale non configurato → 503
 *    (sito) e {error} senza code (MCP); modalità degradata (decisione 1):
 *    prenotazione accettata, registrata, con job di proiezione e di
 *    controllo; riprogrammazione sovrapposta all'originale accettata;
 *  - mode postgres: la riprogrammazione legge capacity e slot con la tx;
 *  - job project_booking (convergenza legacy) e booking_conflict_check
 *    (freshness non verificabile → nuovo tentativo); sovrapposizioni
 *    registrate in cal_booking_conflicts una sola volta;
 *  - contenuto della proiezione per i device (decisione 3);
 *  - prestazioni: busy su 60 giorni sotto 20 ms e /slots p95 sotto 200 ms con
 *    5000 oggetti nell'indice.
 *
 * Ogni test usa una propria finestra di date nel 2027-2028, così i dati di un
 * test non tolgono slot né aggiungono busy a un altro.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  approveBooking,
  cancelBooking,
  createBooking,
  projectionStrategyFor,
  registerBookingJobs,
  rescheduleBooking,
} from '../../src/lib/calendar/booking';
import { buildBookingProjectionIcs, recordBookingConflicts } from '../../src/lib/calendar/booking-projection';
import {
  DEGRADED_MODE_MAX_MS,
  DEGRADED_MODE_SETTING_KEY,
  disableDegradedBookingMode,
  enableDegradedBookingMode,
  getBusyRanges,
  getDegradedBookingMode,
  indexBlockingOccurrences,
  indexBusyRanges,
  isDegradableFailure,
} from '../../src/lib/calendar/busy';
import { getCapacityWeeks } from '../../src/lib/calendar/capacity';
import { CalendarUnavailableError } from '../../src/lib/calendar/errors';
import { getBusyRanges as legacyBusyRanges } from '../../src/lib/calendar/legacy/events-pg';
import { CAL_JOB_KINDS, runCalendarJobsOnce, unregisterCalendarJobHandler } from '../../src/lib/calendar/jobs';
import { applyCollectionChanges, loadCollectionContext, stopIndexWorker } from '../../src/lib/calendar/radicale/indexer';
import { computeAvailableSlots } from '../../src/lib/calendar/slots';
import { overrideCalendarStore } from '../../src/lib/calendar/store';
import type { Booking, Calendar, EventType } from '../../src/lib/calendar/types';
import { executeTool } from '../../src/lib/agent/tools';
import { freezeTime, restoreTime } from '../helpers/clock';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql } from '../helpers/db';
import { addDays, romeIso, useFixtures } from '../helpers/fixtures';

const fx = useFixtures('busy-f2', { resetBaseline: true });

onBeforeDatabaseClose(async () => {
  overrideCalendarStore(null);
  restoreTime();
  unregisterCalendarJobHandler(CAL_JOB_KINDS.projectBooking);
  unregisterCalendarJobHandler(CAL_JOB_KINDS.bookingConflictCheck);
  await sql`DELETE FROM site_settings WHERE key = ${DEGRADED_MODE_SETTING_KEY}`;
  await sql`DELETE FROM audit_logs WHERE table_name = 'calendar_degraded_bookings' OR (table_name = 'site_settings' AND record_id = ${DEGRADED_MODE_SETTING_KEY})`;
  await stopIndexWorker();
  await resetCalendarBaseline();
});

/** Orizzonte dei change set dei test (copre tutte le finestre usate). */
const H = Object.freeze({ start: new Date('2026-06-01T00:00:00Z'), end: new Date('2028-06-01T00:00:00Z') });

// ─── iCalendar ───────────────────────────────

function vcal(...components: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//Busy F2//IT', ...components, 'END:VCALENDAR', ''].join('\r\n');
}

interface VeventOpts {
  start: string;
  end?: string;
  rrule?: string;
  status?: string;
  transp?: string;
  summary?: string;
  allDay?: boolean;
  extra?: string[];
}

function vevent(uid: string, o: VeventOpts): string {
  const start = o.allDay ? `DTSTART;VALUE=DATE:${o.start}` : `DTSTART:${o.start}`;
  const end = o.end ? (o.allDay ? `DTEND;VALUE=DATE:${o.end}` : `DTEND:${o.end}`) : null;
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20270101T000000Z',
    start,
    ...(end ? [end] : []),
    ...(o.rrule ? [`RRULE:${o.rrule}`] : []),
    ...(o.status ? [`STATUS:${o.status}`] : []),
    ...(o.transp ? [`TRANSP:${o.transp}`] : []),
    `SUMMARY:${o.summary ?? 'Evento'}`,
    ...(o.extra ?? []),
    'END:VEVENT',
  ].join('\r\n');
}

/** UTC compatto (20270906T070000Z) di un ISO. */
function stamp(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Evento timed in UTC fra due istanti ISO. */
function timed(uid: string, startIso: string, endIso: string, extra: Partial<VeventOpts> = {}): string {
  return vcal(vevent(uid, { start: stamp(startIso), end: stamp(endIso), ...extra }));
}

let etagSeq = 0;

/** Indicizza gli item nella collezione del calendario (stesso percorso della sync, senza Radicale). */
async function indexItems(calendarId: string, items: Array<{ href: string; raw: string | null }>, deletes: string[] = []) {
  const context = await loadCollectionContext(sql, calendarId);
  const remote = context.originStore === 'remote';
  return applyCollectionChanges(
    {
      context,
      upserts: items.map((i) => ({ href: i.href, etag: remote ? null : `"etag-${++etagSeq}"`, raw: i.raw })),
      deletes,
      radicaleSkipped: [],
      pending404: [],
      full: true,
      horizon: { ...H },
      actor: 'test',
    },
    { syncedAt: new Date() },
  );
}

/**
 * Stato dell'indice per ogni calendario che non ce l'ha (anche i seminati):
 * l'orizzonte materializzato è la garanzia statica delle decisioni.
 */
async function ensureIndexedHorizon(): Promise<void> {
  const rows = await sql<Array<{ id: string }>>`
    SELECT c.id FROM calendars c LEFT JOIN cal_collection_state s ON s.calendar_id = c.id
    WHERE s.calendar_id IS NULL OR s.horizon_end IS NULL
  `;
  for (const r of rows) await indexItems(r.id, []);
}

async function withStore<T>(kind: 'postgres' | 'radicale', fn: () => Promise<T>): Promise<T> {
  overrideCalendarStore(kind);
  try {
    return await fn();
  } finally {
    overrideCalendarStore(null);
  }
}

async function bookingsCalendarId(): Promise<string> {
  const [row] = await sql<Array<{ id: string }>>`SELECT id FROM calendars WHERE slug = 'bookings'`;
  return row.id;
}

async function jobsFor(key: string): Promise<Array<{ kind: string; status: string; attempts: number; last_error: string | null }>> {
  return sql<Array<{ kind: string; status: string; attempts: number; last_error: string | null }>>`
    SELECT kind, status, attempts, last_error FROM cal_jobs WHERE key = ${key} ORDER BY id
  `;
}

const ranges = (list: Array<{ start: string; end: string }>) => list.map((r) => `${r.start}/${r.end}`);

// ─── Mode postgres ───────────────────────────────

test('mode postgres: busy identico a quello legacy; un errore si propaga invece di diventare un busy vuoto', async () => {
  const cal = await fx.calendar({ key: 'legacy', blocks_availability: true });
  const libero = await fx.calendar({ key: 'legacy-libero', blocks_availability: false });
  await fx.event({ calendar: cal, summary: 'Riunione', start_time: romeIso('2027-04-12', '09:00'), end_time: romeIso('2027-04-12', '10:00') });
  await fx.event({ calendar: cal, summary: 'Provvisorio', start_time: romeIso('2027-04-12', '11:00'), end_time: romeIso('2027-04-12', '12:00'), status: 'tentative' });
  await fx.allDayEvent({ calendar: cal, summary: 'Tutto il giorno', date: '2027-04-13' });
  await fx.event({ calendar: libero, summary: 'Non blocca', start_time: romeIso('2027-04-12', '14:00'), end_time: romeIso('2027-04-12', '15:00') });
  await fx.series({ calendar: cal, summary: 'Standup', rrule: 'FREQ=DAILY;COUNT=3', start_time: romeIso('2027-04-12', '08:00'), end_time: romeIso('2027-04-12', '08:30') });

  const from = romeIso('2027-04-12');
  const to = romeIso('2027-04-19');
  const expected = await legacyBusyRanges(from, to);
  assert.equal(expected.length, 4, 'riunione + 3 standup');
  assert.deepEqual(await getBusyRanges(from, to), expected, 'livello display');
  assert.deepEqual(await getBusyRanges(from, to, { level: 'decision', db: sql }), expected, 'livello decision');
  assert.deepEqual(await withStore('postgres', () => getBusyRanges(from, to)), expected);

  // Prima local-busy restituiva [] per qualsiasi errore (slot tutti liberi).
  await assert.rejects(getBusyRanges('non-una-data', to));
});

test('store Radicale non configurato: /slots (display) fallisce chiuso con 503, mai slot liberi per errore', async () => {
  const et = await fx.eventType({ key: 'chiuso' });
  await withStore('radicale', async () => {
    await assert.rejects(
      computeAvailableSlots({ eventTypeIdOrSlug: et.id, fromDateLocal: '2027-04-19', toDateLocal: '2027-04-19' }),
      (err: unknown) => err instanceof CalendarUnavailableError && err.reason === 'radicale_unreachable' && err.status === 503,
    );
  });
});

// ─── Query di busy sull'indice ───────────────────────────────

test('indice: regola blocks, flag dei calendari e delle iscrizioni; le proiezioni booking-* non bloccano', async () => {
  const day = '2027-09-06';
  const at = (h: string) => romeIso(day, h);
  const a = await fx.calendar({ key: 'idx-a', blocks_availability: true });
  const b = await fx.calendar({ key: 'idx-b', blocks_availability: false });
  const bookingsId = await bookingsCalendarId();

  // Sidecar di tre iscrizioni: flag dell'iscrizione × flag del calendario di destinazione.
  const sub = async (key: string, parent: Calendar, subscriptionBlocks: boolean): Promise<string> => {
    const sidecar = await fx.calendar({ key, blocks_availability: true });
    await sql`UPDATE calendars SET role = 'subscription', parent_calendar_id = ${parent.id} WHERE id = ${sidecar.id}`;
    const { subscription } = await fx.subscription({ calendar: parent, events: [] });
    await sql`
      UPDATE calendar_subscriptions SET collection_calendar_id = ${sidecar.id}, blocks_availability = ${subscriptionBlocks}
      WHERE id = ${subscription.id}
    `;
    return sidecar.id;
  };
  const s1 = await sub('idx-sub-si', a, true);
  const s2 = await sub('idx-sub-flag-no', a, false);
  const s3 = await sub('idx-sub-dest-no', b, true);

  await indexItems(a.id, [
    { href: 'confermato.ics', raw: timed('a-confermato', at('09:00'), at('10:00')) },
    { href: 'trasparente.ics', raw: timed('a-trasparente', at('10:00'), at('11:00'), { transp: 'TRANSPARENT' }) },
    { href: 'annullato.ics', raw: timed('a-annullato', at('11:00'), at('12:00'), { status: 'CANCELLED' }) },
    { href: 'provvisorio.ics', raw: timed('a-provvisorio', at('12:00'), at('13:00'), { status: 'TENTATIVE' }) },
    { href: 'giornata.ics', raw: vcal(vevent('a-giornata', { start: '20270906', end: '20270907', allDay: true })) },
  ]);
  await indexItems(b.id, [{ href: 'b.ics', raw: timed('b-evento', at('14:00'), at('15:00')) }]);
  await indexItems(bookingsId, [
    { href: 'booking-abcdef123456.ics', raw: timed('abcdef123456@caldes.it', at('15:00'), at('16:00')) },
    { href: 'manuale.ics', raw: timed('manuale-in-bookings', at('16:00'), at('17:00')) },
  ]);
  await indexItems(s1, [{ href: 'r-sub1.ics', raw: timed('remoto-1', at('17:00'), at('18:00')) }]);
  await indexItems(s2, [{ href: 'r-sub2.ics', raw: timed('remoto-2', at('18:00'), at('19:00')) }]);
  await indexItems(s3, [{ href: 'r-sub3.ics', raw: timed('remoto-3', at('19:00'), at('20:00')) }]);

  const from = romeIso(day);
  const to = romeIso(addDays(day, 1));
  const iso = (h: string) => new Date(at(h)).toISOString();
  const expected = [
    `${iso('09:00')}/${iso('10:00')}`, // confermato in calendario bloccante
    `${iso('16:00')}/${iso('17:00')}`, // item non di proiezione nella collezione bookings
    `${iso('17:00')}/${iso('18:00')}`, // iscrizione bloccante con destinazione bloccante
  ];
  assert.deepEqual(ranges(await indexBusyRanges(sql, from, to)), expected);

  await ensureIndexedHorizon();
  await withStore('radicale', async () => {
    assert.deepEqual(ranges(await getBusyRanges(from, to, { level: 'decision', db: sql })), expected);
  });

  // Con oggetto e istanza: base del controllo delle sovrapposizioni.
  const detailed = await indexBlockingOccurrences(sql, from, to);
  assert.deepEqual(detailed.map((o) => o.kind), ['event', 'event', 'event']);
  assert.ok(detailed.every((o) => !o.onTheFly && !o.stale));
});

// ─── Salute ───────────────────────────────

test('salute: oggetti in quarantena bloccano in modo conservativo sul loro intervallo; gli slot si calcolano (mai un errore)', async () => {
  const day = '2027-10-04';
  const at = (h: string) => romeIso(day, h);
  const cal = await fx.calendar({ key: 'salute', blocks_availability: true });
  try {
    // Oggetto valido, poi corrotto: restano le occorrenze dell'ultima versione buona (stale).
    await indexItems(cal.id, [{ href: 'buono.ics', raw: timed('buono', at('09:00'), at('10:00')) }]);
    await indexItems(cal.id, [
      { href: 'buono.ics', raw: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:buono\r\nDTSTART:20271004T070000Z\r\nquesto non è iCalendar\r\n' },
      // Nuovo e illeggibile, con intervallo estraibile: blocco conservativo sull'intervallo.
      { href: 'rotto.ics', raw: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:rotto\r\nDTSTART:20271004T120000Z\r\nDTEND:20271004T130000Z\r\nRRULE:NON-VALIDA\r\n' },
      // RRULE non valida in un oggetto ben formato: quarantena e blocco conservativo, mai un 503.
      { href: 'rrule.ics', raw: timed('rrule-invalida', at('15:00'), at('16:00'), { rrule: 'FREQ=MAI;UNTIL=20271004T235959Z' }) },
    ]);

    const objects = await sql<Array<{ href: string; health: string; health_reason: string | null }>>`
      SELECT href, health, health_reason FROM cal_objects WHERE calendar_id = ${cal.id} ORDER BY href
    `;
    assert.deepEqual(objects.map((o) => [o.href, o.health]), [['buono.ics', 'quarantined'], ['rotto.ics', 'quarantined'], ['rrule.ics', 'quarantined']]);

    const from = romeIso(day);
    const to = romeIso(addDays(day, 1));
    const busy = await indexBlockingOccurrences(sql, from, to);
    const covers = (h1: string, h2: string) => busy.some((o) => o.start.getTime() <= new Date(at(h1)).getTime() && o.end.getTime() >= new Date(at(h2)).getTime());
    assert.ok(busy.some((o) => o.stale), 'ultima versione buona dell\'oggetto corrotto');
    assert.ok(covers('09:00', '10:00'), 'l\'oggetto corrotto continua a bloccare con la versione buona');
    assert.ok(covers('14:00', '15:00'), 'l\'oggetto illeggibile blocca il suo intervallo');
    assert.ok(covers('17:00', '18:00'), 'la RRULE non valida blocca in modo conservativo');
    assert.ok(busy.some((o) => o.kind === 'conservative'));

    // /slots (livello decision, senza Radicale): risponde, e il mattino libero resta prenotabile.
    const et = await fx.eventType({ key: 'salute', durationMinutes: 60, slotIncrementMinutes: 60 });
    await ensureIndexedHorizon();
    freezeTime('2027-10-01T06:00:00Z');
    try {
      const result = await withStore('radicale', () => computeAvailableSlots(
        { eventTypeIdOrSlug: et.id, fromDateLocal: day, toDateLocal: day },
        { level: 'decision', db: sql },
      ));
      assert.ok(result, 'gli slot si calcolano');
      const starts = result.slots.map((s) => s.start);
      assert.ok(starts.includes(new Date(at('10:00')).toISOString()), 'slot libero fra i blocchi');
      assert.ok(!starts.includes(new Date(at('09:00')).toISOString()), 'versione buona: occupato');
      assert.ok(!starts.includes(new Date(at('14:00')).toISOString()), 'illeggibile: occupato');
    } finally {
      restoreTime();
    }
  } finally {
    // I blocchi conservativi a fine aperta non devono sporcare le finestre degli altri test.
    await sql`DELETE FROM calendars WHERE id = ${cal.id}`;
  }
});

// ─── Espansione al volo ───────────────────────────────

test('espansione al volo: serie oltre materialized_until e oggetti fuori dall\'orizzonte della collezione bloccano lo stesso', async () => {
  const cal = await fx.calendar({ key: 'al-volo', blocks_availability: true });
  try {
    await indexItems(cal.id, [
      // Più di 5000 occorrenze nell'orizzonte: materialized_until.
      { href: 'oraria.ics', raw: timed('oraria', '2027-11-01T08:00:00Z', '2027-11-01T08:30:00Z', { rrule: 'FREQ=HOURLY;UNTIL=20280801T000000Z' }) },
      // Evento singolo dopo la fine dell'orizzonte materializzato (2028-06-01).
      { href: 'lontano.ics', raw: timed('lontano', '2028-06-20T09:00:00Z', '2028-06-20T10:00:00Z') },
    ]);
    const [oraria] = await sql<Array<{ materialized_until: Date | null; health: string }>>`
      SELECT materialized_until, health FROM cal_objects WHERE calendar_id = ${cal.id} AND href = 'oraria.ics'
    `;
    assert.equal(oraria.health, 'ok', 'oltre il tetto non è una quarantena');
    assert.ok(oraria.materialized_until, 'materialized_until valorizzato');
    const mu = oraria.materialized_until.getTime();

    const count = async (fromIso: string, toIso: string) => (await indexBlockingOccurrences(sql, fromIso, toIso)).filter((o) => o.calendarId === cal.id);

    // Prima di materialized_until: dalle righe dell'indice.
    const before = await count(new Date(mu - 2 * 86_400_000).toISOString(), new Date(mu - 86_400_000).toISOString());
    assert.equal(before.length, 24);
    assert.ok(before.every((o) => !o.onTheFly));

    // Dopo: espansione al volo del solo oggetto sulla finestra.
    const after = await count(new Date(mu + 86_400_000).toISOString(), new Date(mu + 2 * 86_400_000).toISOString());
    assert.equal(after.length, 24, 'una occorrenza oraria per ora anche oltre il tetto');
    assert.ok(after.every((o) => o.onTheFly && o.kind === 'event'));

    // Fuori dall'orizzonte della collezione: la serie e il singolo.
    const far = await count('2028-06-20T00:00:00Z', '2028-06-21T00:00:00Z');
    assert.ok(far.some((o) => o.objectId && o.start.toISOString() === '2028-06-20T09:00:00.000Z' && o.recurrenceKey === ''), 'evento singolo oltre l\'orizzonte');
    assert.equal(far.filter((o) => o.recurrenceKey !== '').length, 24, 'serie oraria oltre l\'orizzonte');

    // Busy per intervalli: niente duplicati.
    const list = await indexBusyRanges(sql, '2028-06-20T08:00:00Z', '2028-06-20T11:00:00Z');
    assert.deepEqual(ranges(list), [
      '2028-06-20T08:00:00.000Z/2028-06-20T08:30:00.000Z',
      '2028-06-20T09:00:00.000Z/2028-06-20T09:30:00.000Z',
      '2028-06-20T09:00:00.000Z/2028-06-20T10:00:00.000Z',
      '2028-06-20T10:00:00.000Z/2028-06-20T10:30:00.000Z',
    ]);
  } finally {
    await sql`DELETE FROM calendars WHERE id = ${cal.id}`;
  }
});

// ─── Capacity ───────────────────────────────

test('capacity: una SQL sull\'indice con le esclusioni di oggi dà gli stessi numeri dell\'algoritmo legacy', async () => {
  const lavoro = await fx.calendar({ key: 'cap-lavoro', blocks_availability: true });
  const libero = await fx.calendar({ key: 'cap-libero', blocks_availability: false });
  const festivita = await fx.holidayCalendar();
  await sql`UPDATE calendars SET role = 'holidays' WHERE id = ${festivita.id}`;
  const bookingsId = await bookingsCalendarId();
  const et = await fx.eventType({ key: 'cap', durationMinutes: 60 });

  // Stessi dati nei due modelli: righe legacy in calendar_events, risorse iCalendar nell'indice.
  type Ev = { cal: string; summary: string; start: string; end: string; status?: 'confirmed' | 'tentative' | 'cancelled'; source?: 'manual' | 'admin'; allDay?: boolean; rrule?: string };
  const events: Ev[] = [
    { cal: lavoro.id, summary: 'Riunione', start: romeIso('2027-05-10', '09:00'), end: romeIso('2027-05-10', '11:00') },
    { cal: lavoro.id, summary: 'Amministrazione', start: romeIso('2027-05-11', '10:00'), end: romeIso('2027-05-11', '11:00'), source: 'admin' },
    { cal: lavoro.id, summary: 'Annullato', start: romeIso('2027-05-12', '10:00'), end: romeIso('2027-05-12', '12:00'), status: 'cancelled' },
    { cal: lavoro.id, summary: 'Provvisorio', start: romeIso('2027-05-13', '10:00'), end: romeIso('2027-05-13', '12:00'), status: 'tentative' },
    { cal: lavoro.id, summary: 'A cavallo', start: romeIso('2027-05-16', '23:00'), end: romeIso('2027-05-17', '01:00') },
    { cal: lavoro.id, summary: 'Settimanale', start: romeIso('2027-05-14', '15:00'), end: romeIso('2027-05-14', '16:30'), rrule: 'FREQ=WEEKLY;COUNT=4' },
    { cal: lavoro.id, summary: 'Giornata', start: romeIso('2027-05-12'), end: romeIso('2027-05-13'), allDay: true },
    { cal: libero.id, summary: 'Non blocca', start: romeIso('2027-05-10', '14:00'), end: romeIso('2027-05-10', '18:00') },
    { cal: bookingsId, summary: 'Manuale in bookings', start: romeIso('2027-05-18', '09:00'), end: romeIso('2027-05-18', '09:45') },
  ];
  const items = new Map<string, Array<{ href: string; raw: string }>>();
  for (const [i, e] of events.entries()) {
    await fx.event({
      calendar: e.cal, summary: e.summary, start_time: e.start, end_time: e.end,
      status: e.status ?? 'confirmed', source: e.source ?? 'manual', all_day: e.allDay ?? false, rrule: e.rrule ?? null,
    });
    const raw = e.allDay
      ? vcal(vevent(`cap-${i}`, { start: e.start.slice(0, 10).replace(/-/g, ''), end: e.end.slice(0, 10).replace(/-/g, ''), allDay: true }))
      : timed(`cap-${i}`, e.start, e.end, {
          status: e.status?.toUpperCase(),
          rrule: e.rrule,
          extra: e.source === 'admin' ? ['X-CALDES-SOURCE:admin'] : [],
        });
    const list = items.get(e.cal) ?? [];
    list.push({ href: `cap-${i}.ics`, raw });
    items.set(e.cal, list);
  }
  // Chiusura e festività nel calendario festività; proiezione di una prenotazione.
  await fx.closure(festivita, { from: '2027-05-19', to: '2027-05-20' });
  await fx.holidays(festivita, { year: 2027, only: ['2027-06-02'] });
  const booking = await fx.booking({ eventType: et, start: romeIso('2027-05-18', '11:00') });
  items.set(festivita.id, [
    { href: 'closure-ponte.ics', raw: timed('chiusura', romeIso('2027-05-19'), romeIso('2027-05-21'), { extra: ['X-CALDES-SOURCE:admin'] }) },
    { href: 'it-holiday-2027-06-02.ics', raw: timed('it-holiday-2027-06-02@caldes.it', romeIso('2027-06-02'), romeIso('2027-06-03')) },
  ]);
  items.get(bookingsId)!.push({ href: `booking-${booking.booking.uid}.ics`, raw: timed(`${booking.booking.uid}@caldes.it`, booking.booking.start_time, booking.booking.end_time) });
  for (const [calendarId, list] of items) await indexItems(calendarId, list);

  const from = romeIso('2027-05-10');
  const to = romeIso('2027-06-07');
  const legacy = await withStore('postgres', () => getCapacityWeeks(from, to));
  const indexed = await withStore('radicale', () => getCapacityWeeks(from, to));
  assert.equal(indexed.length, legacy.length);
  assert.equal(legacy.length, 5, 'dal lunedì 10 maggio al lunedì 7 giugno compreso');
  for (const [i, week] of legacy.entries()) {
    assert.equal(indexed[i].weekStartIso, week.weekStartIso);
    assert.equal(indexed[i].calendarMinutes, week.calendarMinutes, `minuti del calendario, settimana ${week.weekStartIso}`);
    assert.deepEqual(indexed[i].calendarBySource, week.calendarBySource, `bucket per source, settimana ${week.weekStartIso}`);
    assert.equal(indexed[i].minutesUsed, week.minutesUsed);
    assert.equal(indexed[i].bookingMinutes, week.bookingMinutes);
  }
  // Settimana del 10 maggio: riunione 120 + amministrazione 60 + settimanale 90 + metà del "a cavallo" 60.
  assert.deepEqual(legacy[0].calendarBySource, { manual: { minutes: 270, count: 3 }, admin: { minutes: 60, count: 1 } });
  // Settimana del 17: l'altra metà, la settimanale, il manuale in bookings (45); proiezione, chiusura esclusi.
  assert.deepEqual(legacy[1].calendarBySource, { manual: { minutes: 195, count: 3 } });
  assert.equal(legacy[1].bookingMinutes, 60);

  // Con la tx della sezione critica (livello decision) stesso risultato.
  const inTx = await withStore('radicale', () => sql.begin((tx) => getCapacityWeeks(from, to, { db: tx as unknown as typeof sql, level: 'decision' })));
  assert.deepEqual(inTx.map((w) => w.calendarMinutes), indexed.map((w) => w.calendarMinutes));
});

// ─── Decisioni con lo store Radicale ───────────────────────────────

test('modalità degradata (decisione 1): interruttore al massimo 2 ore, motivi scavalcabili, scadenza', async () => {
  const now = new Date('2027-07-01T06:00:00Z');
  assert.equal((await getDegradedBookingMode(sql, now)).active, false);

  const on = await enableDegradedBookingMode({ actor: 'test', reason: 'Radicale in manutenzione', durationMs: 5 * 3_600_000, now });
  assert.equal(on.active, true);
  assert.equal(on.expiresAt?.getTime(), now.getTime() + DEGRADED_MODE_MAX_MS, 'mai oltre 2 ore');
  assert.equal((await getDegradedBookingMode(sql, new Date(now.getTime() + DEGRADED_MODE_MAX_MS + 1))).active, false, 'scaduto');

  // Un valore scritto a mano con una scadenza più lunga vale comunque al massimo 2 ore.
  await sql`
    UPDATE site_settings SET value = ${sql.json({ enabled_at: now.toISOString(), expires_at: '2027-07-09T00:00:00Z', enabled_by: 'x', reason: 'y' })}
    WHERE key = ${DEGRADED_MODE_SETTING_KEY}
  `;
  const clamped = await getDegradedBookingMode(sql, new Date(now.getTime() + 3 * 3_600_000));
  assert.equal(clamped.active, false);
  assert.equal(clamped.expiresAt?.getTime(), now.getTime() + DEGRADED_MODE_MAX_MS);

  const [audit] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM audit_logs WHERE table_name = 'site_settings' AND record_id = ${DEGRADED_MODE_SETTING_KEY}
  `;
  assert.ok(audit.n >= 1, 'accensione registrata');
  await disableDegradedBookingMode({ actor: 'test' });
  assert.equal((await getDegradedBookingMode(sql, now)).active, false);

  for (const reason of ['radicale_unreachable', 'collection_unsyncable', 'freshness_timeout', 'remote_budget_exceeded', 'watcher_down', 'rebuild_in_progress'] as const) {
    assert.equal(isDegradableFailure(new CalendarUnavailableError(reason)), true, reason);
  }
  for (const reason of ['identity_mismatch', 'identity_unverified', 'state_unreadable', 'horizon_insufficient', 'write_freeze', 'transition'] as const) {
    assert.equal(isDegradableFailure(new CalendarUnavailableError(reason)), false, reason);
  }
});

test('decisione con lo store Radicale non verificabile: 503 (sito), {error} senza code (MCP); in modalità degradata accettata e registrata; riprogrammazione sovrapposta accettata', async () => {
  freezeTime('2027-07-01T06:00:00Z');
  const et = await fx.eventType({ key: 'decisione', durationMinutes: 60, slotIncrementMinutes: 30 });
  const bookingsId = await bookingsCalendarId();
  // Evento manuale nella collezione bookings: blocca come oggi.
  await indexItems(bookingsId, [{ href: 'manuale-luglio.ics', raw: timed('manuale-luglio', romeIso('2027-07-05', '11:00'), romeIso('2027-07-05', '12:00')) }]);
  await ensureIndexedHorizon();
  const attendee = { name: 'Cliente Decisione', email: fx.email('decisione'), timezone: 'Europe/Rome' };
  try {
    await withStore('radicale', async () => {
      await assert.rejects(
        createBooking({ event_type_id: et.id, start: romeIso('2027-07-05', '09:00'), attendee, source: 'public_page', require_available_slot: true }),
        (err: unknown) => err instanceof CalendarUnavailableError && err.reason === 'radicale_unreachable' && err.status === 503
          && err.toPublicBody().code === 'CALENDAR_UNAVAILABLE',
      );
      const mcp = JSON.parse(await executeTool('create_booking', {
        event_type_slug: et.slug, start: romeIso('2027-07-05', '09:00'), attendee_name: 'Cliente MCP', attendee_email: fx.email('mcp'),
      })) as Record<string, unknown>;
      assert.equal(typeof mcp.error, 'string');
      assert.equal('code' in mcp, false, 'ramo {error} esistente, senza code');
      const [none] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM calendar_bookings WHERE event_type_id = ${et.id}`;
      assert.equal(none.n, 0, 'nessuna prenotazione senza calendario verificato');

      // Display: senza modalità degradata 503, con la modalità degradata gli slot dall'ultimo indice.
      await assert.rejects(computeAvailableSlots({ eventTypeIdOrSlug: et.id, fromDateLocal: '2027-07-05', toDateLocal: '2027-07-05' }), CalendarUnavailableError);
      await enableDegradedBookingMode({ actor: 'test', reason: 'prova' });
      const shown = await computeAvailableSlots({ eventTypeIdOrSlug: et.id, fromDateLocal: '2027-07-05', toDateLocal: '2027-07-05' });
      assert.ok(shown && shown.slots.length > 0);
      assert.ok(!shown.slots.some((s) => s.start === new Date(romeIso('2027-07-05', '11:00')).toISOString()), 'l\'evento manuale in bookings blocca');

      const created = await createBooking({ event_type_id: et.id, start: romeIso('2027-07-05', '09:00'), attendee, source: 'public_page', require_available_slot: true });
      fx.track('bookingIds', created.booking.id);
      assert.equal(created.decision.store, 'radicale');
      assert.equal(created.decision.degraded?.reason, 'radicale_unreachable');
      assert.deepEqual((created.booking.source_metadata as Record<string, Record<string, unknown>>).calendar_degraded.reason, 'radicale_unreachable');
      const [audit] = await sql<Array<{ new_data: Record<string, unknown> }>>`
        SELECT new_data FROM audit_logs WHERE table_name = 'calendar_degraded_bookings' AND record_id = ${created.booking.id}
      `;
      assert.equal(audit.new_data.booking_uid, created.booking.uid);
      assert.equal(audit.new_data.reason, 'radicale_unreachable');
      assert.equal(JSON.stringify(audit.new_data).includes(attendee.email), false, 'nessun dato personale nella riga di audit');
      assert.deepEqual((await jobsFor(created.booking.uid)).map((j) => [j.kind, j.status]), [
        [CAL_JOB_KINDS.projectBooking, 'pending'],
        [CAL_JOB_KINDS.bookingConflictCheck, 'pending'],
      ]);

      // La proiezione dell'originale nell'indice (booking-<uid>.ics) non blocca:
      // la riprogrammazione 30 minuti più avanti, sovrapposta, è accettata.
      await indexItems(bookingsId, [{
        href: `booking-${created.booking.uid}.ics`,
        raw: timed(`${created.booking.uid}@caldes.it`, created.booking.start_time, created.booking.end_time),
      }]);
      const moved = await rescheduleBooking(created.booking.uid, romeIso('2027-07-05', '09:30'), { by: 'attendee', require_available_slot: true });
      fx.track('bookingIds', moved.booking.id);
      assert.equal(new Date(moved.booking.start_time).toISOString(), new Date(romeIso('2027-07-05', '09:30')).toISOString());
      const [original] = await sql<Array<{ status: string }>>`SELECT status FROM calendar_bookings WHERE uid = ${created.booking.uid}`;
      assert.equal(original.status, 'cancelled');
      assert.ok((await jobsFor(created.booking.uid)).some((j) => j.kind === CAL_JOB_KINDS.projectBooking && j.status === 'pending'), 'rimozione della vecchia proiezione accodata');
      assert.ok((await jobsFor(moved.booking.uid)).some((j) => j.kind === CAL_JOB_KINDS.projectBooking && j.status === 'pending'), 'nuova proiezione accodata');

      // L'evento manuale della collezione bookings continua a bloccare la riprogrammazione.
      await assert.rejects(
        rescheduleBooking(moved.booking.uid, romeIso('2027-07-05', '11:00'), { by: 'attendee', require_available_slot: true }),
        (err: unknown) => err instanceof Error && err.message === 'Orario non più disponibile: scegli uno degli slot proposti',
      );
    });
  } finally {
    await disableDegradedBookingMode({ actor: 'test' });
    restoreTime();
  }
});

test('mode postgres: la riprogrammazione legge capacity e slot con la propria transazione', async () => {
  freezeTime('2027-08-01T06:00:00Z');
  const [previous] = await sql<Array<{ value: unknown }>>`SELECT value FROM site_settings WHERE key = 'freelancer.studio'`;
  const et = await fx.eventType({ key: 'cap-tx', durationMinutes: 60 });
  const original = await fx.booking({ eventType: et, start: romeIso('2027-08-02', '09:00'), source: 'admin_manual' });
  try {
    // Capacità di un'ora: con la lettura fuori dalla tx l'originale (annullata
    // nella tx) contava ancora e la riprogrammazione falliva per capacità.
    await sql`
      INSERT INTO site_settings (key, value) VALUES ('freelancer.studio', ${sql.json({ weekly_capacity_hours: 1 })})
      ON CONFLICT (key) DO UPDATE SET value = site_settings.value || ${sql.json({ weekly_capacity_hours: 1 })}
    `;
    assert.equal(projectionStrategyFor({ mode: 'postgres' }), 'legacy');
    const moved = await rescheduleBooking(original.booking.uid, romeIso('2027-08-04', '10:00'), { by: 'admin' });
    fx.track('bookingIds', moved.booking.id);
    assert.equal(new Date(moved.booking.start_time).toISOString(), new Date(romeIso('2027-08-04', '10:00')).toISOString());
    // Proiezione legacy come oggi (sincrona, link della riunione nullo), nessun job.
    const [projection] = await sql<Array<{ status: string; url: string | null }>>`
      SELECT status, url FROM calendar_events WHERE source = 'booking' AND source_id = ${moved.booking.uid}
    `;
    assert.equal(projection.status, 'confirmed');
    assert.equal(projection.url, null);
    assert.equal((await jobsFor(moved.booking.uid)).length, 0);
  } finally {
    if (previous) await sql`UPDATE site_settings SET value = ${sql.json(previous.value as Parameters<typeof sql.json>[0])} WHERE key = 'freelancer.studio'`;
    else await sql`DELETE FROM site_settings WHERE key = 'freelancer.studio'`;
    restoreTime();
  }
});

test('store Radicale: approvazione e annullamento accodano project_booking nella stessa transazione, senza righe legacy', async () => {
  const et = await fx.eventType({ key: 'approva', durationMinutes: 30, requiresApproval: true });
  const { booking } = await fx.booking({ eventType: et, start: romeIso('2027-08-23', '10:00'), status: 'pending', project: false });
  await withStore('radicale', async () => {
    const approved = await approveBooking(booking.uid);
    assert.equal(approved?.booking.status, 'confirmed');
    assert.deepEqual((await jobsFor(booking.uid)).map((j) => [j.kind, j.status]), [[CAL_JOB_KINDS.projectBooking, 'pending']]);
    await cancelBooking(booking.uid, { cancelled_by: 'admin' });
    const jobs = await jobsFor(booking.uid);
    assert.equal(jobs.length, 1, 'coalescenza sul job pending');
    const [row] = await sql<Array<{ source_version: string | null }>>`SELECT source_version FROM cal_jobs WHERE key = ${booking.uid}`;
    const [current] = await sql<Array<{ updated_at: Date }>>`SELECT updated_at FROM calendar_bookings WHERE uid = ${booking.uid}`;
    assert.equal(row.source_version, current.updated_at.toISOString(), 'versione della sorgente aggiornata dall\'annullamento');
  });
  const legacy = await sql`SELECT id FROM calendar_events WHERE source = 'booking' AND source_id = ${booking.uid}`;
  assert.equal(legacy.length, 0, 'con lo store Radicale nessuna proiezione legacy');
});

// ─── Job e sovrapposizioni ───────────────────────────────

test('job project_booking in mode postgres: proiezione legacy convergente (crea, poi annulla)', async () => {
  const et = await fx.eventType({ key: 'job-legacy', durationMinutes: 45 });
  const { booking } = await fx.booking({ eventType: et, start: romeIso('2027-08-09', '15:00'), project: false });
  await sql`DELETE FROM cal_jobs`;
  registerBookingJobs();
  await sql`INSERT INTO cal_jobs (kind, key) VALUES (${CAL_JOB_KINDS.projectBooking}, ${booking.uid})`;
  let summary = await runCalendarJobsOnce({ limit: 5 });
  assert.equal(summary.done, 1);
  const projected = await sql<Array<{ id: string; status: string; summary: string; url: string | null }>>`
    SELECT id, status, summary, url FROM calendar_events WHERE source = 'booking' AND source_id = ${booking.uid}
  `;
  assert.equal(projected.length, 1);
  fx.track('eventIds', projected[0].id);
  assert.equal(projected[0].status, 'confirmed');
  assert.equal(projected[0].summary, `${et.title} – ${booking.attendee_name}`);
  assert.equal(projected[0].url, et.location_value, 'link della riunione ricalcolato');

  // Rieseguito: nessuna seconda riga.
  await sql`INSERT INTO cal_jobs (kind, key) VALUES (${CAL_JOB_KINDS.projectBooking}, ${booking.uid})`;
  summary = await runCalendarJobsOnce({ limit: 5 });
  assert.equal(summary.done, 1);

  await sql`UPDATE calendar_bookings SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'admin' WHERE id = ${booking.id}`;
  await sql`INSERT INTO cal_jobs (kind, key) VALUES (${CAL_JOB_KINDS.projectBooking}, ${booking.uid})`;
  summary = await runCalendarJobsOnce({ limit: 5 });
  assert.equal(summary.done, 1);
  const [after] = await sql<Array<{ status: string }>>`SELECT status FROM calendar_events WHERE id = ${projected[0].id}`;
  assert.equal(after.status, 'cancelled');
});

test('sovrapposizioni: registrate una sola volta, escluse quelle già viste nella decisione; il job di controllo riprova senza freshness', async () => {
  const et = await fx.eventType({ key: 'conflitti', durationMinutes: 60 });
  const { booking } = await fx.booking({ eventType: et, start: romeIso('2027-08-16', '10:00'), project: false });
  const cal = await fx.calendar({ key: 'conflitti', blocks_availability: true });
  await indexItems(cal.id, [
    { href: 'sotto.ics', raw: timed('sotto', romeIso('2027-08-16', '10:30'), romeIso('2027-08-16', '11:30')) },
    { href: 'prima.ics', raw: timed('prima', romeIso('2027-08-16', '09:00'), romeIso('2027-08-16', '10:00')) },
  ]);
  const b = booking as Booking;
  assert.equal(await recordBookingConflicts(sql, b, new Set(), 'post_commit'), 1, 'l\'evento adiacente non è una sovrapposizione');
  assert.equal(await recordBookingConflicts(sql, b, new Set(), 'post_commit'), 0, 'idempotente');
  const [row] = await sql<Array<{ booking_uid: string; detected_by: string; alerted_at: Date | null; recurrence_key: string }>>`
    SELECT booking_uid, detected_by, alerted_at, recurrence_key FROM cal_booking_conflicts WHERE booking_id = ${booking.id}
  `;
  assert.equal(row.booking_uid, booking.uid);
  assert.equal(row.detected_by, 'post_commit');
  assert.ok(row.alerted_at);
  assert.equal(row.recurrence_key, '');

  // Un evento già sovrapposto nella decisione (prenotazione admin sopra un evento, decisione 2) non è un conflitto.
  const other = await fx.booking({ eventType: et, start: romeIso('2027-08-16', '14:00'), project: false });
  await indexItems(cal.id, [{ href: 'gia.ics', raw: timed('gia', romeIso('2027-08-16', '14:00'), romeIso('2027-08-16', '15:00')) }]);
  const seen = (await indexBlockingOccurrences(sql, other.booking.start_time, other.booking.end_time))
    .map((o) => `${o.objectId}|${o.recurrenceKey}|${o.start.getTime()}|${o.end.getTime()}`);
  assert.equal(await recordBookingConflicts(sql, other.booking, new Set(seen), 'post_commit'), 0);

  // Job di controllo con lo store Radicale e Radicale non configurato: errore ripetibile, nuovo tentativo.
  await sql`DELETE FROM cal_jobs`;
  registerBookingJobs();
  await sql`INSERT INTO cal_jobs (kind, key, payload) VALUES (${CAL_JOB_KINDS.bookingConflictCheck}, ${other.booking.uid}, ${sql.json({ preexisting: seen })})`;
  await withStore('radicale', async () => {
    const summary = await runCalendarJobsOnce({ limit: 5 });
    assert.equal(summary.requeued, 1);
  });
  const [job] = await jobsFor(other.booking.uid);
  assert.equal(job.status, 'pending');
  assert.equal(job.attempts, 1);
  assert.match(job.last_error ?? '', /radicale_unreachable/);
});

// ─── Contenuto della proiezione ───────────────────────────────

test('proiezione per i device (decisione 3): titolo con nome, telefono e link all\'admin; niente email, azienda né messaggio', () => {
  const now = new Date('2027-07-01T06:00:00Z');
  const booking = {
    uid: 'abc123def456',
    attendee_name: 'Mario Rossi',
    attendee_phone: '+39 333 1234567',
    start_time: '2027-07-05T07:00:00.000Z',
    end_time: '2027-07-05T08:00:00.000Z',
    location_value: 'https://meet.caldes.test/x',
    created_at: '2027-06-30T10:00:00.000Z',
  };
  const ics = buildBookingProjectionIcs({ booking, eventTitle: 'Consulenza', meetingUrl: 'https://meet.caldes.test/x', now });
  const unfolded = ics.replace(/\r\n[ \t]/g, '');
  assert.match(unfolded, /^UID:abc123def456@caldes\.it$/m);
  assert.match(unfolded, /^SUMMARY:Consulenza – Mario Rossi$/m);
  assert.match(unfolded, /^DTSTART:20270705T070000Z$/m);
  assert.match(unfolded, /^DTEND:20270705T080000Z$/m);
  assert.match(unfolded, /^STATUS:CONFIRMED$/m);
  assert.match(unfolded, /^URL:https:\/\/meet\.caldes\.test\/x$/m);
  assert.match(unfolded, /Tel: \+39 333 1234567/);
  assert.match(unfolded, /calendario\/prenotazioni\?uid=abc123def456/);
  assert.doesNotMatch(unfolded, /ATTENDEE|ORGANIZER|mailto:|@test\.invalid|Azienda|Note/);

  // Oltre 24 mesi: solo "Prenotazione".
  const old = buildBookingProjectionIcs({ booking, eventTitle: 'Consulenza', meetingUrl: null, now: new Date('2029-08-01T00:00:00Z') });
  assert.match(old, /^SUMMARY:Prenotazione$/m);
  assert.doesNotMatch(old, /DESCRIPTION|Mario|Tel:/);
});

// ─── Prestazioni ───────────────────────────────

test('prestazioni: busy su 60 giorni sotto 20 ms e /slots p95 sotto 200 ms con 5000 oggetti nell\'indice', async (t) => {
  const cal = await fx.calendar({ key: 'prestazioni', blocks_availability: true });
  await indexItems(cal.id, []);
  await ensureIndexedHorizon();
  const et: EventType = await fx.eventType({ key: 'prestazioni', durationMinutes: 30, slotIncrementMinutes: 15 });

  const time = async (fn: () => Promise<unknown>, runs: number): Promise<number[]> => {
    await fn();
    const out: number[] = [];
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      await fn();
      out.push(performance.now() - t0);
    }
    return out.sort((x, y) => x - y);
  };
  const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
  const from = '2027-09-01T00:00:00Z';
  const to = '2027-10-31T00:00:00Z';

  // Tutto in una transazione annullata alla fine, come nella sezione critica
  // di una prenotazione: i dati non restano per i file di test successivi.
  // Niente ANALYZE: aggiornerebbe reltuples e relpages in pg_class anche
  // dopo il rollback, cambiando i piani dei test che seguono.
  const ROLLBACK = new Error('rollback dei dati di prestazione');
  const measured = sql.begin(async (txSql) => {
    const tx = txSql as unknown as typeof sql;
    // 4800 eventi singoli in 600 giorni e 200 serie settimanali di due anni (≈ 25.000 occorrenze).
    await tx`
      WITH ids AS (
        INSERT INTO cal_object_ids (calendar_id, href, uid)
        SELECT ${cal.id}, 'perf-' || g || '.ics', 'perf-' || g FROM generate_series(1, 5000) g
        RETURNING id, href
      ), objs AS (
        INSERT INTO cal_objects (id, calendar_id, href, uid, etag, raw_ics, origin_store, range_start, range_end, is_recurring)
        SELECT id, ${cal.id}, href, replace(href, '.ics', ''), '"perf"', 'BEGIN:VCALENDAR', 'radicale',
               '2027-01-04T08:00:00Z'::timestamptz, '2029-01-04T08:00:00Z'::timestamptz,
               (replace(replace(href, 'perf-', ''), '.ics', '')::int > 4800)
        FROM ids
        RETURNING id, href
      )
      INSERT INTO cal_occurrences (object_id, recurrence_key, calendar_id, start_utc, end_utc, kind, blocks)
      SELECT o.id,
             CASE WHEN n.k > 4800 THEN to_char(s.t AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS"Z"') ELSE '' END,
             ${cal.id}, s.t, s.t + INTERVAL '1 hour', 'event', true
      FROM objs o
      CROSS JOIN LATERAL (SELECT replace(replace(o.href, 'perf-', ''), '.ics', '')::int AS k) n
      CROSS JOIN LATERAL (
        SELECT '2027-01-04T07:00:00Z'::timestamptz + ((n.k % 600) * INTERVAL '1 day') + ((n.k % 9) * INTERVAL '1 hour') AS t
        WHERE n.k <= 4800
        UNION ALL
        SELECT '2027-01-04T07:00:00Z'::timestamptz + ((n.k % 7) * INTERVAL '1 day') + ((n.k % 9) * INTERVAL '1 hour') + (w * INTERVAL '7 days')
        FROM generate_series(0, 103) w
        WHERE n.k > 4800
      ) s
    `;
    const [{ n: objects }] = await tx<Array<{ n: number }>>`SELECT count(*)::int AS n FROM cal_objects WHERE calendar_id = ${cal.id}`;
    assert.equal(objects, 5000);

    const busyCount = (await indexBusyRanges(tx, from, to)).length;
    assert.ok(busyCount > 300, `busy reale sui 60 giorni (${busyCount} intervalli)`);
    const busy = await time(() => indexBusyRanges(tx, from, to), 30);
    const busyDecision = await withStore('radicale', () => time(() => getBusyRanges(from, to, { level: 'decision', db: tx }), 30));
    t.diagnostic(`busy indice 60 g: mediana ${pct(busy, 0.5).toFixed(2)} ms, p95 ${pct(busy, 0.95).toFixed(2)} ms (${busyCount} intervalli)`);
    t.diagnostic(`busy decision 60 g: mediana ${pct(busyDecision, 0.5).toFixed(2)} ms, p95 ${pct(busyDecision, 0.95).toFixed(2)} ms`);
    // Obiettivo del piano (busy su 60 giorni sotto 20 ms) sulla mediana; il p95
    // ha un margine più largo perché la macchina dei test è condivisa.
    assert.ok(pct(busy, 0.5) < 20, `busy su 60 giorni: mediana ${pct(busy, 0.5).toFixed(1)} ms (p95 ${pct(busy, 0.95).toFixed(1)} ms)`);
    assert.ok(pct(busy, 0.95) < 50, `busy su 60 giorni: p95 ${pct(busy, 0.95).toFixed(1)} ms`);
    assert.ok(pct(busyDecision, 0.5) < 20, `busy decision su 60 giorni: mediana ${pct(busyDecision, 0.5).toFixed(1)} ms (p95 ${pct(busyDecision, 0.95).toFixed(1)} ms)`);

    freezeTime('2027-08-30T06:00:00Z');
    try {
      const slots = await withStore('radicale', () => time(() => computeAvailableSlots(
        { eventTypeIdOrSlug: et.id, fromDateLocal: '2027-09-01', toDateLocal: '2027-09-30' },
        { level: 'decision', db: tx },
      ), 20));
      t.diagnostic(`/slots 30 g: mediana ${pct(slots, 0.5).toFixed(1)} ms, p95 ${pct(slots, 0.95).toFixed(1)} ms`);
      assert.ok(pct(slots, 0.95) < 200, `/slots su 30 giorni: p95 ${pct(slots, 0.95).toFixed(1)} ms`);
    } finally {
      restoreTime();
    }
    throw ROLLBACK;
  });
  try {
    await measured;
    assert.fail('la transazione dei dati di prestazione doveva essere annullata');
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
  const [{ n: left }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM cal_objects WHERE calendar_id = ${cal.id}`;
  assert.equal(left, 0, 'nessun dato di prestazione dopo il rollback');
});
