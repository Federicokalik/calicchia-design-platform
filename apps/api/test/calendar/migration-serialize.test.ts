/**
 * Serializer della migrazione a Radicale (gruppo SERIALIZE della F3; design
 * §5, §10, §13.4-§13.5; contratto docs/calendar-radicale/contracts/f3-modules.md
 * §4.1-§4.2, §4.6, §6.2 e §7.1) sulle righe vere di calendar_events e
 * calendar_bookings, lette con loadLegacySource dal database dei test.
 *
 * Fixture:
 *  - forma di produzione (inventario del 2026-10-09): `c` con la serie
 *    infinita lun-mar-gio-ven alle 09:00 di Roma, la serie conclusa di giugno
 *    con l'UNTIL "fino al" dell'editor, singoli e copie fatte con "Duplica"
 *    (source_id = id dell'originale); `f` "Festività e chiusure" con
 *    is_system = false, 91 festività di sistema e la chiusura "Ferie";
 *    Prenotazioni con una proiezione confermata (email e telefono nella
 *    DESCRIPTION legacy) e una prenotazione annullata;
 *  - tutte le anomalie del §7.1 che il serializer vede: eccezioni DST con la
 *    firma del codice precedente al fix, orfani, override in un altro
 *    calendario, RRULE non valida, UNTIL < DTSTART, all-day ambigui e serie
 *    all-day con UNTIL ed EXDATE orari, BYDAY misto, serie fuori Roma,
 *    festività duplicate, master annullati, eventi non-proiezione in
 *    Prenotazioni (decisione 8), calendari esclusi, deriva delle
 *    prenotazioni, proiezioni minimizzate e anonimizzate.
 *
 * Si verifica: href riusati (ledger, poi cal_object_ids) e deterministici,
 * UID legacy preservati anche con '@', legacy_uid e id legacy per ogni
 * oggetto, provenienza X-CALDES-*, contenuto della decisione 3 per le
 * proiezioni (nome e telefono, mai l'email), determinismo dell'hash, lettura
 * per chiave dello shadow, patch per campo con VALARM preservato, nessun
 * dato personale nelle anomalie.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import Holidays from 'date-holidays';
import { getTextValue, parseCalendarObject, X_CALDES } from '@calicchia/calendar-core';
import { onDatabaseReady, sql } from '../helpers/db';
import { romeIso, useFixtures } from '../helpers/fixtures';
import { createCalendar, getCalendar } from '../../src/lib/calendar/calendars';
import type { Calendar, EventType } from '../../src/lib/calendar/types';
import {
  buildObjectFromSnapshot,
  canonicalJson,
  detachedUid,
  eventHrefForUid,
  type LegacySource,
  legacyHash,
  loadLegacySource,
  patchFromLegacyDiff,
  SERIALIZER_VERSION,
  serializeLegacy,
} from '../../src/lib/calendar/migration/serialize';
import {
  DEFAULT_MIGRATION_OPTIONS,
  LEGACY_HASH_RE,
  type LegacyEventSnapshot,
  type LegacyKey,
  type MigrationOptions,
  type SerializationResult,
  type SerializedObject,
} from '../../src/lib/calendar/migration/types';

const fx = useFixtures('serialize-f3', { resetBaseline: true });

const NOW = new Date('2026-10-10T08:00:00.000Z');
const EMAIL_LOCAL = 'cliente-conf';
const PHONE = '+39 333 1234567';

interface Scenario {
  c: Calendar;
  f: Calendar;
  lavoro: Calendar;
  personale: Calendar;
  bookings: Calendar;
  anomalie: Calendar;
  newYork: Calendar;
  escluso: Calendar;
  ids: Record<string, string>;
  eventType: EventType;
  confirmedUid: string;
  confirmedProjectionId: string;
  confirmedProjectionUid: string;
  cancelledUid: string;
  missingUid: string;
  driftUid: string;
  minimizedUid: string;
  anonymizedUid: string;
  holidays: number;
  email: string;
  subscriptionRowIds: string[];
}

let sc: Scenario;

/** Riga di calendar_events inserita così com'è (per i valori che createEvent non produrrebbe). */
async function insertEvent(row: {
  calendar_id: string; summary: string; start_time: string; end_time: string; uid?: string; all_day?: boolean; rrule?: string | null;
  exdates?: string[]; recurrence_id?: string | null; recurrence_master_id?: string | null; source?: string; source_id?: string | null;
  status?: string; created_at?: string;
}): Promise<string> {
  const [r] = await sql<Array<{ id: string }>>`
    INSERT INTO calendar_events (calendar_id, uid, summary, start_time, end_time, all_day, rrule, exdates, recurrence_id, recurrence_master_id, source, source_id, status, created_at)
    VALUES (${row.calendar_id}, ${row.uid ?? `${fx.slug('ev')}-${randomUUID().slice(0, 8)}`}, ${row.summary}, ${row.start_time}, ${row.end_time}, ${row.all_day ?? false},
            ${row.rrule ?? null}, ${sql.json((row.exdates ?? []) as never)}, ${row.recurrence_id ?? null}, ${row.recurrence_master_id ?? null},
            ${row.source ?? 'admin'}, ${row.source_id ?? null}, ${row.status ?? 'confirmed'}, ${row.created_at ?? new Date().toISOString()})
    RETURNING id::text AS id
  `;
  fx.track('eventIds', r.id);
  return r.id;
}

onDatabaseReady(async () => {
  const ids: Record<string, string> = {};
  const lavoro = (await getCalendar('lavoro')) as Calendar;
  const personale = (await getCalendar('personale')) as Calendar;
  const bookings = (await getCalendar('bookings')) as Calendar;

  // ── Forma di produzione ──
  const c = await createCalendar({ slug: 'c', name: 'Creattivamente SRL', timezone: 'Europe/Rome', blocks_availability: true });
  fx.track('calendarIds', c.id);
  const f = await fx.holidayCalendar({ slug: 'f' });
  await sql`UPDATE calendars SET is_system = false, origin = 'admin' WHERE id = ${f.id}`;

  ids.infinite = await insertEvent({
    calendar_id: c.id, summary: 'Gestione Creattivamente', start_time: romeIso('2026-08-10', '09:00'), end_time: romeIso('2026-08-10', '10:00'),
    rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,TH,FR',
  });
  ids.june = await insertEvent({
    calendar_id: c.id, summary: 'Gestione', start_time: romeIso('2026-06-04', '09:00'), end_time: romeIso('2026-06-04', '10:00'),
    rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,TH,FR;UNTIL=20260616T000000Z',
  });
  ids.single1 = await insertEvent({ calendar_id: c.id, summary: 'Gestione', start_time: romeIso('2026-06-01', '09:00'), end_time: romeIso('2026-06-01', '10:00') });
  ids.single2 = await insertEvent({ calendar_id: c.id, summary: 'Gestione', start_time: romeIso('2026-06-03', '09:00'), end_time: romeIso('2026-06-03', '10:00'), source: 'mcp' });
  ids.single3 = await insertEvent({ calendar_id: c.id, summary: 'Gestione', start_time: romeIso('2026-06-19', '09:00'), end_time: romeIso('2026-06-19', '10:00') });
  ids.copy = await insertEvent({
    calendar_id: c.id, summary: 'Gestione', start_time: romeIso('2026-06-19', '09:00'), end_time: romeIso('2026-06-19', '10:00'), source_id: ids.single3,
    created_at: new Date(Date.now() + 1000).toISOString(),
  });
  ids.occurrenceCopy = await insertEvent({ calendar_id: c.id, summary: 'Gestione', start_time: romeIso('2026-06-04', '09:00'), end_time: romeIso('2026-06-04', '10:00') });

  let holidays = 0;
  const hd = new Holidays('IT');
  for (const year of [2026, 2027, 2028, 2029, 2030, 2031, 2032]) {
    for (const h of hd.getHolidays(year).filter((x) => x.type === 'public')) {
      const id = await insertEvent({
        calendar_id: f.id, summary: h.name, start_time: new Date(h.start).toISOString(), end_time: new Date(h.end).toISOString(),
        source: 'system', source_id: `it-holiday-${h.date.slice(0, 10)}`, created_at: new Date(Date.now() - 86_400_000).toISOString(),
      });
      if (h.date.startsWith('2026-12-25')) ids.christmas = id;
      holidays++;
    }
  }
  ids.ferie = await insertEvent({ calendar_id: f.id, summary: 'Ferie', start_time: romeIso('2026-07-27', '00:00'), end_time: romeIso('2026-08-10', '00:00') });
  // Festività duplicata (stessa data, creata dopo): non si migra.
  ids.christmasDup = await insertEvent({
    calendar_id: f.id, summary: 'Natale', start_time: romeIso('2026-12-25', '00:00'), end_time: romeIso('2026-12-26', '00:00'),
    source: 'system', source_id: 'it-holiday-2026-12-25', created_at: new Date(Date.now() + 5000).toISOString(),
  });

  const eventType = await fx.eventType({ key: 'consulenza', durationMinutes: 30 });
  const email = fx.email(EMAIL_LOCAL);
  const confirmed = await fx.booking({ eventType, start: romeIso('2026-11-10', '15:00'), status: 'confirmed', attendee: { name: 'Mario Rossi', email, phone: PHONE } });
  assert.ok(confirmed.projection);
  const cancelled = await fx.booking({ eventType, start: romeIso('2026-06-01', '15:00'), status: 'cancelled', project: false });
  // Deriva: confermata senza proiezione, proiezione con orari diversi, proiezione orfana.
  const missing = await fx.booking({ eventType, start: romeIso('2026-11-11', '15:00'), status: 'confirmed', project: false });
  const drift = await fx.booking({ eventType, start: romeIso('2026-11-12', '15:00'), status: 'confirmed' });
  await sql`UPDATE calendar_events SET start_time = start_time + interval '1 hour', end_time = end_time + interval '1 hour' WHERE id = ${drift.projection!.id}`;
  ids.orphanProjection = await insertEvent({
    calendar_id: bookings.id, summary: 'Prenotazione sparita', start_time: romeIso('2026-11-13', '15:00'), end_time: romeIso('2026-11-13', '15:30'),
    source: 'booking', source_id: 'zzorphan0001',
  });
  // Minimizzate: conclusa da più di 24 mesi; anonimizzata dall'erasure.
  const minimized = await fx.booking({ eventType, start: '2024-01-10T10:00:00.000Z', status: 'confirmed', attendee: { name: 'Cliente Vecchio', phone: '+39 320 0000000' } });
  const anonymized = await fx.booking({ eventType, start: romeIso('2026-11-14', '15:00'), status: 'confirmed', project: false });
  await sql`UPDATE calendar_bookings SET attendee_name = 'Dato cancellato (GDPR)', attendee_email = ${`erased-${anonymized.booking.id}@deleted.invalid`}, attendee_phone = NULL WHERE id = ${anonymized.booking.id}`;

  // Iscrizione ICS su `lavoro`: le sue righe ics_pull non si copiano mai (decisione 5).
  const sub = await fx.subscription({
    calendar: lavoro,
    events: [{
      remote_uid: 'remoto-1@feed.example', summary: 'Evento remoto', description: null, location: null, url: null,
      start_time: romeIso('2026-11-02', '10:00'), end_time: romeIso('2026-11-02', '11:00'), all_day: false, rrule: null, exdates: [],
      recurrence_id: null, status: 'confirmed',
    } as never],
  });

  // Non-proiezione in Prenotazioni (decisione 8).
  ids.bookingsManual = await insertEvent({ calendar_id: bookings.id, summary: 'Promemoria in Prenotazioni', start_time: romeIso('2026-11-05', '15:00'), end_time: romeIso('2026-11-05', '16:00'), source: 'manual' });

  // ── Anomalie ──
  const anomalie = await fx.calendar({ key: 'anomalie', timezone: 'Europe/Rome' });
  const newYork = await fx.calendar({ key: 'newyork', timezone: 'America/New_York' });
  const escluso = await fx.calendar({ key: 'escluso' });
  await sql`UPDATE calendars SET origin = 'migration' WHERE id = ${escluso.id}`;
  ids.excludedEvent = await insertEvent({ calendar_id: escluso.id, summary: 'Nel calendario escluso', start_time: romeIso('2026-11-02', '09:00'), end_time: romeIso('2026-11-02', '10:00') });

  // Eccezioni DST: serie del lunedì alle 09:00 di Roma iniziata d'inverno, eccezioni d'estate salvate
  // con l'ora UTC del DTSTART (08:00Z = 10:00 di Roma): firma del codice precedente al fix.
  ids.dst = await insertEvent({
    calendar_id: anomalie.id, uid: `${fx.slug('dst')}-serie`, summary: 'Serie DST', start_time: '2026-01-05T08:00:00.000Z', end_time: '2026-01-05T09:00:00.000Z',
    rrule: 'FREQ=WEEKLY;BYDAY=MO', exdates: ['2026-06-08T08:00:00.000Z'],
  });
  ids.dstOverride = await insertEvent({
    calendar_id: anomalie.id, summary: 'Spostata DST', start_time: '2026-06-15T12:00:00.000Z', end_time: '2026-06-15T13:00:00.000Z',
    recurrence_id: '2026-06-15T08:00:00.000Z', recurrence_master_id: ids.dst,
  });
  ids.dstCancelled = await insertEvent({
    calendar_id: anomalie.id, summary: 'Serie DST', start_time: '2026-06-22T08:00:00.000Z', end_time: '2026-06-22T09:00:00.000Z',
    recurrence_id: '2026-06-22T08:00:00.000Z', recurrence_master_id: ids.dst, status: 'cancelled',
  });
  // Orfano: mercoledì in una serie del martedì.
  ids.orphanSeries = await insertEvent({
    calendar_id: anomalie.id, uid: `${fx.slug('orf')}-serie`, summary: 'Serie con orfano', start_time: romeIso('2026-09-01', '09:00'), end_time: romeIso('2026-09-01', '10:00'),
    rrule: 'FREQ=WEEKLY;BYDAY=TU',
  });
  ids.orphan = await insertEvent({
    calendar_id: anomalie.id, summary: 'Straordinaria', start_time: romeIso('2026-09-09', '09:00'), end_time: romeIso('2026-09-09', '10:00'),
    recurrence_id: romeIso('2026-09-09', '09:00'), recurrence_master_id: ids.orphanSeries,
  });
  // Override valido salvato in un altro calendario.
  ids.mismatchOverride = await insertEvent({
    calendar_id: personale.id, summary: 'Spostata in personale', start_time: romeIso('2026-09-08', '11:00'), end_time: romeIso('2026-09-08', '12:00'),
    recurrence_id: romeIso('2026-09-08', '09:00'), recurrence_master_id: ids.orphanSeries,
  });
  ids.invalidRrule = await insertEvent({ calendar_id: anomalie.id, summary: 'Regola rotta', start_time: romeIso('2026-09-02', '09:00'), end_time: romeIso('2026-09-02', '10:00'), rrule: 'FREQ=WEEKLY;BYDAY=XX' });
  ids.untilBefore = await insertEvent({ calendar_id: anomalie.id, summary: 'Finita prima di iniziare', start_time: romeIso('2026-09-03', '09:00'), end_time: romeIso('2026-09-03', '10:00'), rrule: 'FREQ=DAILY;UNTIL=20250101T000000Z' });
  ids.allDayUtc = await insertEvent({ calendar_id: anomalie.id, summary: 'Tutto il giorno UTC', start_time: '2026-09-10T00:00:00.000Z', end_time: '2026-09-11T00:00:00.000Z', all_day: true });
  ids.allDayRome = await insertEvent({ calendar_id: anomalie.id, summary: 'Tutto il giorno Roma', start_time: romeIso('2026-09-15', '00:00'), end_time: romeIso('2026-09-16', '00:00'), all_day: true });
  ids.allDaySeries = await insertEvent({
    calendar_id: anomalie.id, summary: 'Serie tutto il giorno', start_time: romeIso('2026-09-07', '00:00'), end_time: romeIso('2026-09-08', '00:00'), all_day: true,
    rrule: 'FREQ=WEEKLY;UNTIL=20261130T230000Z', exdates: [romeIso('2026-09-14', '00:00')],
  });
  ids.mixed = await insertEvent({ calendar_id: anomalie.id, summary: 'Mensile misto', start_time: romeIso('2026-09-07', '09:00'), end_time: romeIso('2026-09-07', '10:00'), rrule: 'FREQ=MONTHLY;BYDAY=1MO,FR' });
  ids.radicaleLimit = await insertEvent({ calendar_id: anomalie.id, summary: 'Troppe ripetizioni', start_time: romeIso('2026-09-08', '07:00'), end_time: romeIso('2026-09-08', '07:30'), rrule: 'FREQ=DAILY;COUNT=60000' });
  ids.cancelledMaster = await insertEvent({ calendar_id: anomalie.id, summary: 'Master annullato', start_time: romeIso('2026-09-04', '09:00'), end_time: romeIso('2026-09-04', '10:00'), status: 'cancelled' });
  ids.atUid = await insertEvent({ calendar_id: anomalie.id, uid: `${fx.slug('at')}@esterno.example`, summary: 'UID con chiocciola', start_time: romeIso('2026-09-05', '09:00'), end_time: romeIso('2026-09-05', '10:00') });
  ids.unsafeUid = await insertEvent({ calendar_id: anomalie.id, uid: `${fx.slug('spazi')} con spazi/e barre`, summary: 'UID non sicuro', start_time: romeIso('2026-09-06', '09:00'), end_time: romeIso('2026-09-06', '10:00') });
  ids.projectionLike = await insertEvent({ calendar_id: anomalie.id, uid: `booking-${fx.slug('finto')}`, summary: 'UID che imita una proiezione', start_time: romeIso('2026-09-06', '11:00'), end_time: romeIso('2026-09-06', '12:00') });
  ids.nySeries = await insertEvent({ calendar_id: newYork.id, summary: 'Serie a New York', start_time: '2026-09-01T13:00:00.000Z', end_time: '2026-09-01T14:00:00.000Z', rrule: 'FREQ=WEEKLY;BYDAY=TU' });

  // Href già noti: riga viva del ledger e cal_object_ids.
  ids.ledgerKnown = await insertEvent({ calendar_id: anomalie.id, summary: 'Href dal ledger', start_time: romeIso('2026-09-20', '09:00'), end_time: romeIso('2026-09-20', '10:00') });
  await sql`
    INSERT INTO cal_migration_ledger (calendar_id, collection_name, href, kind, legacy_key, legacy_event_id, uid)
    SELECT ${anomalie.id}, collection_name, 'storico-ledger.ics', 'event', ${`event:${ids.ledgerKnown}`}, ${ids.ledgerKnown}, uid
    FROM calendars, calendar_events WHERE calendars.id = ${anomalie.id} AND calendar_events.id = ${ids.ledgerKnown}
  `;
  ids.oidKnown = await insertEvent({ calendar_id: anomalie.id, summary: 'Href da cal_object_ids', start_time: romeIso('2026-09-21', '09:00'), end_time: romeIso('2026-09-21', '10:00') });
  await sql`
    INSERT INTO cal_object_ids (calendar_id, href, recurrence_key, uid, legacy_event_id, legacy_uid)
    SELECT ${anomalie.id}, 'storico-indice.ics', '', uid, id, uid FROM calendar_events WHERE id = ${ids.oidKnown}
  `;

  sc = {
    c, f, lavoro, personale, bookings, anomalie, newYork, escluso, ids, eventType,
    confirmedUid: confirmed.booking.uid,
    confirmedProjectionId: confirmed.projection!.id,
    confirmedProjectionUid: confirmed.projection!.uid,
    cancelledUid: cancelled.booking.uid,
    missingUid: missing.booking.uid,
    driftUid: drift.booking.uid,
    minimizedUid: minimized.booking.uid,
    anonymizedUid: anonymized.booking.uid,
    holidays,
    email,
    subscriptionRowIds: sub.events.map((e) => e.id),
  };
});

// ─── Utilità ───────────────────────────────

let cached: { source: LegacySource; result: SerializationResult } | null = null;

async function serialized(options: Partial<MigrationOptions> = {}): Promise<{ source: LegacySource; result: SerializationResult }> {
  if (Object.keys(options).length === 0 && cached) return cached;
  const source = await loadLegacySource(sql, { now: NOW });
  const result = serializeLegacy(source, { ...DEFAULT_MIGRATION_OPTIONS, ...options }, { now: NOW });
  if (Object.keys(options).length === 0) cached = { source, result };
  return { source, result };
}

function objectOf(result: SerializationResult, key: string): SerializedObject {
  const o = result.objects.find((x) => x.legacy_key === key);
  assert.ok(o, `oggetto ${key} assente`);
  return o;
}

const ev = (id: string): LegacyKey => `event:${id}` as LegacyKey;

function anomaliesOf(result: SerializationResult, code: string, key?: string) {
  return result.anomalies.filter((a) => a.code === code && (!key || a.legacy_key === key));
}

function skipOf(result: SerializationResult, key: string) {
  return result.skipped.find((s) => s.legacy_key === key) ?? null;
}

function veventCount(ics: string): number {
  return ics.split('BEGIN:VEVENT').length - 1;
}

// ─── Forma di produzione ───────────────────────────────

describe('serializer: dati di forma produttiva', () => {
  test('serie infinita lun-mar-gio-ven 09:00 Europe/Rome: un oggetto, UID e id legacy, provenienza', async () => {
    const { result } = await serialized();
    const o = objectOf(result, ev(sc.ids.infinite));
    assert.equal(o.kind, 'event');
    assert.equal(o.collection_name, 'c', 'collezione con lo slug di produzione');
    assert.equal(o.calendar_id, sc.c.id);
    const [row] = await sql<Array<{ uid: string }>>`SELECT uid FROM calendar_events WHERE id = ${sc.ids.infinite}`;
    assert.equal(o.uid, row.uid);
    assert.equal(o.legacy_uid, row.uid);
    assert.equal(o.legacy_event_id, sc.ids.infinite);
    assert.deepEqual(o.object_ids, [{ recurrence_key: '', id: sc.ids.infinite, legacy_event_id: sc.ids.infinite }]);
    assert.equal(o.href, eventHrefForUid(row.uid));
    assert.match(o.ics, /DTSTART;TZID=Europe\/Rome:20260810T090000/);
    assert.match(o.ics, /RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR\r?\n/);
    assert.match(o.ics, new RegExp(`${X_CALDES.SOURCE}:admin`));
    assert.match(o.ics, new RegExp(`${X_CALDES.LEGACY_ID}:${sc.ids.infinite}`));
    assert.match(o.legacy_hash, LEGACY_HASH_RE);
    assert.ok(o.legacy_hash.startsWith(`s${SERIALIZER_VERSION}:`));
    assert.equal(o.summary, 'Gestione Creattivamente');
  });

  test('serie di giugno con UNTIL "fino al" a mezzanotte UTC: riallineata a fine giornata di Roma (ON) o lasciata (OFF)', async () => {
    const { result } = await serialized();
    const o = objectOf(result, ev(sc.ids.june));
    assert.match(o.ics, /UNTIL=20260616T215959Z/);
    assert.ok(o.anomalies.includes('UNTIL_ADMIN_PATTERN'));
    assert.ok(o.expected_reasons.includes('UNTIL_REALIGNED'));
    const [a] = anomaliesOf(result, 'UNTIL_ADMIN_PATTERN', ev(sc.ids.june));
    assert.equal(a.detail.fixed, true);
    assert.equal((o.legacy_snapshot as LegacyEventSnapshot).options.fix_until_admin_pattern, true);

    const { result: off } = await serialized({ fix_until_admin_pattern: false });
    const o2 = objectOf(off, ev(sc.ids.june));
    assert.match(o2.ics, /UNTIL=20260616T000000Z/);
    assert.equal(o2.expected_reasons.includes('UNTIL_REALIGNED'), false);
    assert.equal(anomaliesOf(off, 'UNTIL_ADMIN_PATTERN', ev(sc.ids.june))[0].detail.fixed, false);
    assert.notEqual(o2.legacy_hash, o.legacy_hash, 'l\'opzione che cambia l\'uscita entra nell\'hash');
  });

  test('singoli e copie di "Duplica": migrati così come sono, X-CALDES-SOURCE-ID della copia, POSSIBLE_DUPLICATE informativa', async () => {
    const { result } = await serialized();
    for (const id of [sc.ids.single1, sc.ids.single2, sc.ids.single3, sc.ids.copy, sc.ids.occurrenceCopy]) objectOf(result, ev(id));
    assert.match(objectOf(result, ev(sc.ids.single2)).ics, /X-CALDES-SOURCE:mcp/);
    assert.match(objectOf(result, ev(sc.ids.copy)).ics, new RegExp(`${X_CALDES.SOURCE_ID}:${sc.ids.single3}`));
    const dup = anomaliesOf(result, 'POSSIBLE_DUPLICATE', ev(sc.ids.copy));
    assert.equal(dup.length, 1);
    assert.equal(dup[0].detail.duplicate_of, sc.ids.single3);
    assert.equal(dup[0].severity, 'info');
    assert.ok(objectOf(result, ev(sc.ids.copy)).anomalies.includes('POSSIBLE_DUPLICATE'));
    assert.equal(objectOf(result, ev(sc.ids.single3)).anomalies.includes('POSSIBLE_DUPLICATE'), false, 'l\'originale no');
    const occ = anomaliesOf(result, 'POSSIBLE_DUPLICATE', ev(sc.ids.occurrenceCopy));
    assert.equal(occ.length, 1);
    assert.equal(occ[0].detail.duplicate_of_series, sc.ids.june);
  });

  test('`f`: 91 festività con href it-holiday-YYYY-MM-DD e UID legacy, "Ferie" come closure-<uuid>, duplicata saltata', async () => {
    const { result } = await serialized();
    const holidays = result.objects.filter((o) => o.calendar_id === sc.f.id && o.href.startsWith('it-holiday-'));
    assert.equal(holidays.length, sc.holidays);
    assert.equal(sc.holidays, 91);
    const christmas = objectOf(result, ev(sc.ids.christmas));
    assert.equal(christmas.href, 'it-holiday-2026-12-25.ics');
    const [row] = await sql<Array<{ uid: string }>>`SELECT uid FROM calendar_events WHERE id = ${sc.ids.christmas}`;
    assert.equal(christmas.uid, row.uid);
    assert.equal(christmas.legacy_uid, row.uid);
    assert.match(christmas.ics, /X-CALDES-SOURCE:system/);
    assert.match(christmas.ics, /X-CALDES-SOURCE-ID:it-holiday-2026-12-25/);
    const ferie = objectOf(result, ev(sc.ids.ferie));
    assert.equal(ferie.href, `closure-${sc.ids.ferie}.ics`);
    assert.equal(ferie.collection_name, 'f');
    assert.equal(skipOf(result, ev(sc.ids.christmasDup))?.code, 'DUPLICATE_HOLIDAY');
    assert.equal(anomaliesOf(result, 'DUPLICATE_HOLIDAY', ev(sc.ids.christmasDup))[0].detail.kept_event_id, sc.ids.christmas);
    assert.equal(result.objects.filter((o) => o.calendar_id === sc.f.id).length, 92);
  });

  test('proiezione confermata: rigenerata da calendar_bookings (decisione 3) e legata alla riga legacy', async () => {
    const { result } = await serialized();
    const o = objectOf(result, `booking:${sc.confirmedUid}`);
    assert.equal(o.kind, 'booking');
    assert.equal(o.calendar_id, sc.bookings.id);
    assert.equal(o.href, `booking-${sc.confirmedUid}.ics`);
    assert.equal(o.uid, `${sc.confirmedUid}@caldes.it`);
    assert.equal(o.legacy_event_id, sc.confirmedProjectionId, 'id di list_events invariato');
    assert.equal(o.legacy_uid, sc.confirmedProjectionUid, 'UID del feed invariato per gli abbonati');
    assert.deepEqual(o.object_ids, [{ recurrence_key: '', id: sc.confirmedProjectionId, legacy_event_id: sc.confirmedProjectionId }]);
    assert.equal(o.summary, null, 'niente titolo (nome del cliente) nell\'anteprima');
    const parsed = parseCalendarObject(o.ics);
    assert.ok(parsed.ok);
    const text = o.ics.replace(/\r?\n[ \t]/g, '');
    assert.match(text, /SUMMARY:.*consulenza – Mario Rossi/);
    assert.match(text, /DESCRIPTION:Tel: \+39 333 1234567/);
    assert.ok(!text.toLowerCase().includes(sc.email.toLowerCase()), 'mai l\'email sui device');
    assert.match(text, new RegExp(`${X_CALDES.LEGACY_ID}:${sc.confirmedProjectionId}`));
    assert.ok(o.expected_reasons.includes('BOOKING_REGENERATED'));
  });

  test('prenotazione annullata: nessuna proiezione; righe legacy non proiettate saltate', async () => {
    const { result } = await serialized();
    assert.equal(result.objects.some((o) => o.legacy_key === `booking:${sc.cancelledUid}`), false);
    assert.equal(skipOf(result, `booking:${sc.cancelledUid}`), null, 'senza riga legacy nessun salto da mostrare');
    // La riga legacy di una prenotazione annullata dopo la proiezione resta com'è: salto BOOKING_NOT_PROJECTED.
    const [row] = await sql<Array<{ id: string }>>`
      INSERT INTO calendar_events (calendar_id, uid, summary, start_time, end_time, source, source_id, status)
      SELECT ${sc.bookings.id}, ${`${fx.slug('annullata')}-proj`}, 'Annullata', start_time, end_time, 'booking', uid, 'cancelled'
      FROM calendar_bookings WHERE uid = ${sc.cancelledUid}
      RETURNING id::text AS id
    `;
    fx.track('eventIds', row.id);
    try {
      const source = await loadLegacySource(sql, { now: NOW });
      const r2 = serializeLegacy(source, { ...DEFAULT_MIGRATION_OPTIONS }, { now: NOW });
      const skip = skipOf(r2, `booking:${sc.cancelledUid}`);
      assert.equal(skip?.code, 'BOOKING_NOT_PROJECTED');
      assert.equal(skip?.legacy_event_id, row.id);
    } finally {
      await sql`DELETE FROM calendar_events WHERE id = ${row.id}`;
    }
  });

  test('ogni oggetto migrato ha legacy_uid e l\'id legacy della risorsa (feed identico, id di list_events validi)', async () => {
    const { result } = await serialized();
    for (const o of result.objects) {
      if (o.kind === 'booking' && o.legacy_event_id === null) continue; // confermata senza riga legacy (deriva)
      assert.ok(o.legacy_uid, `legacy_uid per ${o.legacy_key}`);
      assert.equal(o.object_ids[0].recurrence_key, '');
      assert.equal(o.object_ids[0].id, o.legacy_event_id, `id legacy della risorsa ${o.legacy_key}`);
    }
  });
});

// ─── Anomalie ───────────────────────────────

describe('serializer: anomalie del §7.1', () => {
  test('DST_SHIFTED_EXCEPTION: EXDATE, override e cancellato riallineati sulla griglia di Roma (ON)', async () => {
    const { result } = await serialized();
    const o = objectOf(result, ev(sc.ids.dst));
    assert.ok(o.anomalies.includes('DST_SHIFTED_EXCEPTION'));
    assert.ok(o.expected_reasons.includes('DST_REALIGNED'));
    assert.match(o.ics, /EXDATE;TZID=Europe\/Rome:20260608T090000/);
    assert.match(o.ics, /EXDATE;TZID=Europe\/Rome:20260622T090000|EXDATE;TZID=Europe\/Rome:[0-9T,]*20260622T090000/);
    assert.match(o.ics, /RECURRENCE-ID;TZID=Europe\/Rome:20260615T090000/);
    assert.equal(veventCount(o.ics), 2);
    const [a] = anomaliesOf(result, 'DST_SHIFTED_EXCEPTION', ev(sc.ids.dst));
    assert.equal(a.detail.to_fix, 3);
    assert.equal(a.detail.realigned, true);
    // L'override riallineato conserva il proprio id legacy nella recurrence key corretta.
    assert.deepEqual(o.object_ids.find((x) => x.id === sc.ids.dstOverride), { recurrence_key: '20260615T070000Z', id: sc.ids.dstOverride, legacy_event_id: sc.ids.dstOverride });
    assert.equal(result.objects.some((x) => x.legacy_key === `detached:${sc.ids.dstOverride}`), false);
  });

  test('DST_SHIFTED_EXCEPTION con l\'opzione OFF: eccezioni lasciate, override modificato orfano e staccato', async () => {
    const { result } = await serialized({ realign_dst_exceptions: false });
    const o = objectOf(result, ev(sc.ids.dst));
    assert.match(o.ics, /EXDATE;TZID=Europe\/Rome:20260608T100000/);
    assert.equal(o.expected_reasons.includes('DST_REALIGNED'), false);
    assert.equal(veventCount(o.ics), 1);
    const det = objectOf(result, `detached:${sc.ids.dstOverride}`);
    const [master] = await sql<Array<{ uid: string }>>`SELECT uid FROM calendar_events WHERE id = ${sc.ids.dst}`;
    assert.equal(det.uid, detachedUid(master.uid, '2026-06-15T08:00:00.000Z'));
    assert.equal(det.uid, `${master.uid}-det-${Date.parse('2026-06-15T08:00:00.000Z') / 1000}`);
    assert.equal(det.href, `${det.uid}.ics`);
  });

  test('ORPHAN_OVERRIDE_NOT_IN_RULE: staccato in <uid>-det-<epoch> (convert) o saltato (discard)', async () => {
    const { result } = await serialized();
    const det = objectOf(result, `detached:${sc.ids.orphan}`);
    assert.equal(det.kind, 'detached');
    assert.equal(det.calendar_id, sc.anomalie.id);
    assert.equal(det.legacy_event_id, sc.ids.orphan);
    const [ov] = await sql<Array<{ uid: string }>>`SELECT uid FROM calendar_events WHERE id = ${sc.ids.orphan}`;
    assert.equal(det.legacy_uid, ov.uid);
    assert.ok(det.expected_reasons.includes('ORPHAN_CONVERTED'));
    assert.equal(det.legacy_snapshot.kind, 'detached');
    assert.equal(det.legacy_snapshot.kind === 'detached' && det.legacy_snapshot.master_id, sc.ids.orphanSeries);
    assert.doesNotMatch(det.ics, /RECURRENCE-ID/);
    const [a] = anomaliesOf(result, 'ORPHAN_OVERRIDE_NOT_IN_RULE', `detached:${sc.ids.orphan}`);
    assert.equal(a.detail.reason, 'not_in_rule');

    const { result: discard } = await serialized({ orphans: 'discard' });
    assert.equal(skipOf(discard, `detached:${sc.ids.orphan}`)?.code, 'ORPHAN_DISCARDED');
  });

  test('OVERRIDE_CALENDAR_MISMATCH: override di un altro calendario nell\'oggetto del master', async () => {
    const { result } = await serialized();
    const o = objectOf(result, ev(sc.ids.orphanSeries));
    assert.ok(o.anomalies.includes('OVERRIDE_CALENDAR_MISMATCH'));
    assert.equal(veventCount(o.ics), 2);
    assert.ok(o.object_ids.some((x) => x.id === sc.ids.mismatchOverride));
    assert.equal(result.objects.some((x) => x.calendar_id === sc.personale.id && x.legacy_event_id === sc.ids.mismatchOverride), false);
  });

  test('INVALID_RRULE: evento singolo con X-CALDES-LEGACY-RRULE; UNTIL < DTSTART: saltata', async () => {
    const { result } = await serialized();
    const o = objectOf(result, ev(sc.ids.invalidRrule));
    const parsed = parseCalendarObject(o.ics);
    assert.ok(parsed.ok);
    assert.equal(parsed.value.master?.properties.some((p) => p.name === 'RRULE'), false, 'nessuna RRULE nel VEVENT');
    assert.equal(getTextValue(parsed.value.master!, X_CALDES.LEGACY_RRULE), 'FREQ=WEEKLY;BYDAY=XX', 'regola originale come testo');
    assert.ok(o.expected_reasons.includes('INVALID_RRULE_SINGLE'));
    assert.equal(skipOf(result, ev(sc.ids.untilBefore))?.code, 'UNTIL_BEFORE_DTSTART');
    assert.equal(anomaliesOf(result, 'UNTIL_BEFORE_DTSTART', ev(sc.ids.untilBefore)).length, 1);
  });

  test('RADICALE_RRULE_LIMIT: serie oltre il limite di Radicale saltata come INVALID_OBJECT', async () => {
    const { result } = await serialized();
    assert.equal(skipOf(result, ev(sc.ids.radicaleLimit))?.code, 'INVALID_OBJECT');
    const [a] = anomaliesOf(result, 'RADICALE_RRULE_LIMIT', ev(sc.ids.radicaleLimit));
    assert.equal(a.severity, 'error');
    assert.equal(result.objects.some((o) => o.legacy_key === ev(sc.ids.radicaleLimit)), false);
  });

  test('all-day: VALUE=DATE con la regola +12 h, ALLDAY_AMBIGUOUS, UNTIL ed EXDATE scritti come DATE', async () => {
    const { result } = await serialized();
    const utc = objectOf(result, ev(sc.ids.allDayUtc));
    assert.match(utc.ics, /DTSTART;VALUE=DATE:20260910/);
    assert.match(utc.ics, /DTEND;VALUE=DATE:20260911/);
    assert.ok(utc.anomalies.includes('ALLDAY_AMBIGUOUS'));
    assert.ok(utc.expected_reasons.includes('ALLDAY_NORMALIZED'));
    const rome = objectOf(result, ev(sc.ids.allDayRome));
    assert.match(rome.ics, /DTSTART;VALUE=DATE:20260915/);
    assert.equal(rome.anomalies.includes('ALLDAY_AMBIGUOUS'), false);
    const series = objectOf(result, ev(sc.ids.allDaySeries));
    assert.match(series.ics, /RRULE:FREQ=WEEKLY;UNTIL=20261201\r?\n|RRULE:FREQ=WEEKLY;UNTIL=20261130\r?\n/);
    assert.match(series.ics, /EXDATE;VALUE=DATE:20260914/);
    assert.ok(series.anomalies.includes('ALLDAY_UNTIL_DATETIME'));
    assert.ok(series.anomalies.includes('ALLDAY_EXDATE_DATETIME'));
  });

  test('MIXED_BYDAY con le due espansioni nel dettaglio; NON_ROME_SERIES', async () => {
    const { result } = await serialized();
    const [mixed] = anomaliesOf(result, 'MIXED_BYDAY', ev(sc.ids.mixed));
    assert.ok(mixed);
    assert.ok(Array.isArray(mixed.detail.legacy) && Array.isArray(mixed.detail.core));
    assert.notDeepEqual(mixed.detail.legacy, mixed.detail.core, 'unione RFC 5545 contro intersezione del legacy');
    assert.ok(objectOf(result, ev(sc.ids.mixed)).expected_reasons.includes('MIXED_BYDAY'));
    const ny = objectOf(result, ev(sc.ids.nySeries));
    assert.ok(ny.anomalies.includes('NON_ROME_SERIES'));
    assert.match(ny.ics, /DTSTART;TZID=Europe\/Rome:20260901T150000/, 'serie in Europe/Rome come la espande il legacy');
  });

  test('iscrizioni mai copiate: le righe ics_pull non entrano nella sorgente né negli oggetti', async () => {
    const { source, result } = await serialized();
    assert.ok(sc.subscriptionRowIds.length > 0);
    for (const id of sc.subscriptionRowIds) {
      assert.equal(source.events.some((e) => e.id === id), false);
      assert.equal(result.objects.some((o) => o.legacy_event_id === id || o.object_ids.some((x) => x.id === id)), false);
    }
    assert.equal(source.events.some((e) => e.source === 'ics_pull'), false);
  });

  test('CANCELLED_MASTER saltato; calendario escluso: EVENTS_IN_EXCLUDED_CALENDAR e salto', async () => {
    const { result } = await serialized();
    assert.equal(skipOf(result, ev(sc.ids.cancelledMaster))?.code, 'CANCELLED_MASTER');
    assert.equal(skipOf(result, ev(sc.ids.excludedEvent))?.code, 'EXCLUDED_CALENDAR');
    const [a] = anomaliesOf(result, 'EVENTS_IN_EXCLUDED_CALENDAR').filter((x) => x.calendar_id === sc.escluso.id);
    assert.equal(a.detail.excluded_reason, 'archive');
    assert.equal(a.detail.rows, 1);
  });

  test('UID con \'@\' preservato con href <uid>.ics; UID non sicuri o che imitano una proiezione → href sha256', async () => {
    const { result } = await serialized();
    const at = objectOf(result, ev(sc.ids.atUid));
    assert.equal(at.uid, `${fx.slug('at')}@esterno.example`);
    assert.equal(at.legacy_uid, at.uid);
    assert.equal(at.href, `${at.uid}.ics`);
    const unsafe = objectOf(result, ev(sc.ids.unsafeUid));
    assert.match(unsafe.href, /^[0-9a-f]{32}\.ics$/);
    assert.equal(unsafe.uid, `${fx.slug('spazi')} con spazi/e barre`);
    const fake = objectOf(result, ev(sc.ids.projectionLike));
    assert.match(fake.href, /^[0-9a-f]{32}\.ics$/, 'un evento non diventa mai una proiezione per href');
  });

  test('NON_PROJECTION_IN_BOOKINGS: resta in Prenotazioni (default) o si sposta solo nella destinazione (decisione 8)', async () => {
    const { result } = await serialized();
    const stay = objectOf(result, ev(sc.ids.bookingsManual));
    assert.equal(stay.calendar_id, sc.bookings.id);
    assert.match(stay.ics, /X-CALDES-SOURCE:manual/);
    const [a] = anomaliesOf(result, 'NON_PROJECTION_IN_BOOKINGS', ev(sc.ids.bookingsManual));
    assert.equal(a.detail.moved, false);

    const { result: moved } = await serialized({ bookings_move_event_ids: [sc.ids.bookingsManual] });
    const m = objectOf(moved, ev(sc.ids.bookingsManual));
    assert.equal(m.calendar_id, sc.lavoro.id, 'calendario di default');
    assert.equal(m.collection_name, 'lavoro');
    assert.ok(m.expected_reasons.includes('NON_PROJECTION_MOVED'));
    assert.equal((m.legacy_snapshot as LegacyEventSnapshot).options.moved_to_calendar_id, sc.lavoro.id);
    const [row] = await sql<Array<{ calendar_id: string }>>`SELECT calendar_id::text AS calendar_id FROM calendar_events WHERE id = ${sc.ids.bookingsManual}`;
    assert.equal(row.calendar_id, sc.bookings.id, 'lo strumento non scrive mai calendar_events');

    const { result: chosen } = await serialized({ bookings_move_event_ids: [sc.ids.bookingsManual], bookings_move_target_calendar_id: sc.personale.id });
    assert.equal(objectOf(chosen, ev(sc.ids.bookingsManual)).calendar_id, sc.personale.id);
  });

  test('BOOKING_DRIFT: confermata senza proiezione, orari divergenti, proiezione orfana', async () => {
    const { result } = await serialized();
    const missing = objectOf(result, `booking:${sc.missingUid}`);
    assert.equal(missing.legacy_event_id, null);
    assert.ok(missing.expected_reasons.includes('BOOKING_DRIFT'));
    assert.equal(anomaliesOf(result, 'BOOKING_DRIFT', `booking:${sc.missingUid}`)[0].detail.kind, 'missing_projection');
    const drift = objectOf(result, `booking:${sc.driftUid}`);
    assert.equal(anomaliesOf(result, 'BOOKING_DRIFT', `booking:${sc.driftUid}`)[0].detail.kind, 'time_mismatch');
    const [b] = await sql<Array<{ start_time: Date }>>`SELECT start_time FROM calendar_bookings WHERE uid = ${sc.driftUid}`;
    const stamp = b.start_time.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    assert.match(drift.ics, new RegExp(`DTSTART:${stamp}`), 'orari dalla prenotazione');
    assert.equal(anomaliesOf(result, 'BOOKING_DRIFT', 'booking:zzorphan0001')[0].detail.kind, 'orphan_projection');
    assert.equal(skipOf(result, 'booking:zzorphan0001')?.code, 'BOOKING_NOT_PROJECTED');
  });

  test('proiezioni minimizzate: oltre 24 mesi dalla fine e prenotazioni anonimizzate → "Prenotazione" senza dati', async () => {
    const { result } = await serialized();
    for (const uid of [sc.minimizedUid, sc.anonymizedUid]) {
      const o = objectOf(result, `booking:${uid}`);
      assert.equal(o.legacy_snapshot.kind === 'booking' && o.legacy_snapshot.minimized, true, uid);
      assert.match(o.ics, /SUMMARY:Prenotazione\r?\n/);
      assert.doesNotMatch(o.ics, /DESCRIPTION|LOCATION|^URL/m);
      const snap = o.legacy_snapshot.kind === 'booking' ? o.legacy_snapshot.booking : null;
      assert.equal(snap?.attendee_name, '');
      assert.equal(snap?.attendee_phone, null);
    }
    // Il giorno in cui scatta la minimizzazione cambia l'hash (un solo update).
    const early = new Date('2025-06-01T00:00:00.000Z');
    const r = serializeLegacy((await serialized()).source, { ...DEFAULT_MIGRATION_OPTIONS }, { now: early });
    const fresh = objectOf(r, `booking:${sc.minimizedUid}`);
    assert.equal(fresh.legacy_snapshot.kind === 'booking' && fresh.legacy_snapshot.minimized, false);
    assert.notEqual(fresh.legacy_hash, objectOf(result, `booking:${sc.minimizedUid}`).legacy_hash);
  });

  test('nessun dato personale nelle anomalie, nei salti e nei titoli delle proiezioni', async () => {
    const { result } = await serialized();
    const blob = JSON.stringify({ anomalies: result.anomalies, skipped: result.skipped, summaries: result.objects.filter((o) => o.kind === 'booking').map((o) => o.summary) });
    assert.ok(!blob.toLowerCase().includes(sc.email.toLowerCase()));
    assert.ok(!blob.includes(PHONE));
    assert.ok(!blob.includes('Mario Rossi'));
  });
});

// ─── Identità e determinismo ───────────────────────────────

describe('serializer: href, determinismo e lettura per chiave', () => {
  test('href già noti: riga viva del ledger, poi cal_object_ids', async () => {
    const { result } = await serialized();
    assert.equal(objectOf(result, ev(sc.ids.ledgerKnown)).href, 'storico-ledger.ics');
    assert.equal(objectOf(result, ev(sc.ids.oidKnown)).href, 'storico-indice.ics');
  });

  test('href, UID e oggetti unici per collezione', async () => {
    const { result } = await serialized();
    const hrefs = new Set<string>();
    const uids = new Set<string>();
    for (const o of result.objects) {
      const h = `${o.calendar_id}|${o.href}`;
      const u = `${o.calendar_id}|${o.uid}`;
      assert.ok(!hrefs.has(h), `href duplicato ${h}`);
      assert.ok(!uids.has(u), `UID duplicato ${u}`);
      hrefs.add(h);
      uids.add(u);
      assert.ok(parseCalendarObject(o.ics).ok, `testo valido per ${o.legacy_key}`);
    }
  });

  test('determinismo: stessa sorgente, stesse opzioni e stesso now → stessi oggetti e hash; legacy_hash = s1:sha256(snapshot)', async () => {
    const a = await loadLegacySource(sql, { now: NOW });
    const b = await loadLegacySource(sql, { now: NOW });
    const ra = serializeLegacy(a, { ...DEFAULT_MIGRATION_OPTIONS }, { now: NOW });
    const rb = serializeLegacy(b, { ...DEFAULT_MIGRATION_OPTIONS }, { now: NOW });
    assert.equal(canonicalJson(ra), canonicalJson(rb));
    for (const o of ra.objects) assert.equal(o.legacy_hash, legacyHash(o.legacy_snapshot));
    // DTSTAMP cambia con now, il fingerprint e l'hash no (proiezioni lontane dai 24 mesi).
    const later = serializeLegacy(a, { ...DEFAULT_MIGRATION_OPTIONS }, { now: new Date(NOW.getTime() + 3_600_000) });
    for (const o of ra.objects) {
      const other = later.objects.find((x) => x.legacy_key === o.legacy_key);
      assert.ok(other);
      assert.equal(other.fingerprint, o.fingerprint, o.legacy_key);
      assert.equal(other.legacy_hash, o.legacy_hash, o.legacy_key);
    }
  });

  test('la ricostruzione dallo snapshot dà lo stesso contenuto semantico (a meno di CREATED e LAST-MODIFIED)', async () => {
    const { result } = await serialized();
    const o = objectOf(result, ev(sc.ids.dst));
    const rebuilt = buildObjectFromSnapshot(o.legacy_snapshot, { now: NOW });
    const strip = (ics: string): string => ics.split(/\r?\n/).filter((l) => !/^(CREATED|LAST-MODIFIED|DTSTAMP):/.test(l)).join('\n');
    assert.equal(strip(rebuilt.ics), strip(o.ics));
  });

  test('una modifica legacy cambia l\'hash del solo oggetto toccato', async () => {
    const before = (await serialized()).result;
    await sql`UPDATE calendar_events SET summary = 'Gestione (modificata)' WHERE id = ${sc.ids.single1}`;
    try {
      const after = serializeLegacy(await loadLegacySource(sql, { now: NOW }), { ...DEFAULT_MIGRATION_OPTIONS }, { now: NOW });
      for (const o of before.objects) {
        const other = after.objects.find((x) => x.legacy_key === o.legacy_key);
        assert.ok(other);
        if (o.legacy_key === ev(sc.ids.single1)) assert.notEqual(other.legacy_hash, o.legacy_hash);
        else if (!o.anomalies.includes('POSSIBLE_DUPLICATE')) assert.equal(other.legacy_hash, o.legacy_hash, o.legacy_key);
      }
    } finally {
      await sql`UPDATE calendar_events SET summary = 'Gestione' WHERE id = ${sc.ids.single1}`;
    }
  });

  test('lettura per chiave (shadow): master con gli override, prenotazione con la riga di proiezione, righe detached di un master cancellato', async () => {
    const src = await loadLegacySource(sql, { legacyKeys: [ev(sc.ids.dst)], now: NOW });
    assert.deepEqual(src.events.map((e) => e.id).sort(), [sc.ids.dst, sc.ids.dstOverride, sc.ids.dstCancelled].sort());
    assert.ok(src.calendars.length >= 6, 'tutti i calendari, per gli spostamenti');
    const r = serializeLegacy(src, { ...DEFAULT_MIGRATION_OPTIONS }, { now: NOW });
    assert.equal(objectOf(r, ev(sc.ids.dst)).legacy_hash, objectOf((await serialized()).result, ev(sc.ids.dst)).legacy_hash, 'stesso hash della lettura completa');

    const bk = await loadLegacySource(sql, { legacyKeys: [`booking:${sc.confirmedUid}` as LegacyKey], now: NOW });
    assert.deepEqual(bk.events.map((e) => e.id), [sc.confirmedProjectionId]);
    assert.deepEqual(bk.bookings.map((b) => b.uid), [sc.confirmedUid]);
    const rb = serializeLegacy(bk, { ...DEFAULT_MIGRATION_OPTIONS }, { now: NOW });
    assert.equal(objectOf(rb, `booking:${sc.confirmedUid}`).legacy_hash, objectOf((await serialized()).result, `booking:${sc.confirmedUid}`).legacy_hash);

    // Riga detached di un master ormai cancellato in PG: compresa nella chiave del master.
    const goneMaster = randomUUID();
    const [ledger] = await sql<Array<{ id: string }>>`
      INSERT INTO cal_migration_ledger (calendar_id, collection_name, href, kind, legacy_key, uid, legacy_snapshot)
      VALUES (${sc.anomalie.id}, ${sc.anomalie.slug}, 'orfano-sparito.ics', 'detached', ${`detached:${randomUUID()}`}, 'orfano-sparito',
              ${sql.json({ v: 1, kind: 'detached', master_id: goneMaster } as never)})
      RETURNING id::text AS id
    `;
    try {
      const gone = await loadLegacySource(sql, { legacyKeys: [ev(goneMaster)], now: NOW });
      assert.equal(gone.events.length, 0);
      assert.deepEqual(gone.ledger.map((l) => l.id), [ledger.id]);
    } finally {
      await sql`DELETE FROM cal_migration_ledger WHERE id = ${ledger.id}`;
    }
  });

  test('ambito: solo i calendari indicati (più gli override dei loro master)', async () => {
    const src = await loadLegacySource(sql, { scope: { calendar_ids: [sc.anomalie.id] }, now: NOW });
    assert.deepEqual(src.calendars.map((c) => c.id), [sc.anomalie.id]);
    assert.ok(src.events.some((e) => e.id === sc.ids.mismatchOverride), 'override in personale di un master dell\'ambito');
    assert.equal(src.events.some((e) => e.calendar_id === sc.c.id), false);
    assert.equal(src.bookings.length, 0, 'Prenotazioni fuori dall\'ambito');
  });
});

// ─── Patch per campo ───────────────────────────────

describe('patchFromLegacyDiff (shadow e righe adottate)', () => {
  test('modifica legacy su un oggetto con VALARM in destinazione: VALARM preservato, solo i campi toccati', async () => {
    const { result } = await serialized();
    const before = objectOf(result, ev(sc.ids.orphanSeries));
    const withAlarm = before.ics.replace('END:VEVENT', 'BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Promemoria\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nX-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC\r\nEND:VEVENT');
    const target = parseCalendarObject(withAlarm);
    assert.ok(target.ok);
    const prev = before.legacy_snapshot as LegacyEventSnapshot;
    const current: LegacyEventSnapshot = { ...prev, master: { ...prev.master, summary: 'Serie con orfano (rinominata)', location: 'Sala riunioni' } };
    const patch = patchFromLegacyDiff(target.value, prev, current, { tz: 'Europe/Rome', now: NOW });
    assert.equal(patch.changed, true);
    assert.deepEqual(patch.fields, ['location', 'summary']);
    assert.deepEqual(patch.conflicts, []);
    const out = patch.object.master!;
    assert.ok(out.components.some((c) => c.name === 'VALARM'), 'VALARM preservato');
    assert.ok(out.properties.some((p) => p.name === 'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR'), 'X-* del device preservate');
    assert.equal(out.properties.find((p) => p.name === 'SUMMARY')?.value, 'Serie con orfano (rinominata)');
    // L'override resta.
    assert.equal(patch.object.overrides.length, 1);
  });

  test('campo cambiato anche nella destinazione: conflitto del CAS (vince il valore nuovo, decide il chiamante)', async () => {
    const { result } = await serialized();
    const before = objectOf(result, ev(sc.ids.single1));
    const target = parseCalendarObject(before.ics.replace('SUMMARY:Gestione', 'SUMMARY:Dal telefono'));
    assert.ok(target.ok);
    const prev = before.legacy_snapshot as LegacyEventSnapshot;
    const current: LegacyEventSnapshot = { ...prev, master: { ...prev.master, summary: 'Gestione nuova' } };
    const patch = patchFromLegacyDiff(target.value, prev, current, { tz: 'Europe/Rome', now: NOW });
    assert.deepEqual(patch.conflicts.map((c) => c.field), ['summary']);
    assert.equal(patch.object.master!.properties.find((p) => p.name === 'SUMMARY')?.value, 'Gestione nuova');
  });

  test('override aggiunto e cancellato nel legacy: materializzato ed EXDATE sull\'oggetto corrente', async () => {
    const { result } = await serialized();
    const before = objectOf(result, ev(sc.ids.infinite));
    const target = parseCalendarObject(before.ics);
    assert.ok(target.ok);
    const prev = before.legacy_snapshot as LegacyEventSnapshot;
    const ovBase = { ...prev.master, recurrence_master_id: prev.master.id, rrule: null, exdates: [] };
    const current: LegacyEventSnapshot = {
      ...prev,
      overrides: [
        { ...ovBase, id: randomUUID(), uid: 'ov-modificato', summary: 'Spostata', recurrence_id: romeIso('2026-10-12', '09:00'), start_time: romeIso('2026-10-12', '11:00'), end_time: romeIso('2026-10-12', '12:00') },
        { ...ovBase, id: randomUUID(), uid: 'ov-annullato', recurrence_id: romeIso('2026-10-13', '09:00'), start_time: romeIso('2026-10-13', '09:00'), end_time: romeIso('2026-10-13', '10:00'), status: 'cancelled' },
      ],
    };
    const patch = patchFromLegacyDiff(target.value, prev, current, { tz: 'Europe/Rome', now: NOW });
    assert.equal(patch.changed, true);
    assert.equal(patch.object.overrides.length, 1);
    const master = patch.object.master!;
    assert.ok(master.properties.some((p) => p.name === 'EXDATE' && p.value.includes('20261013T090000')), 'occorrenza cancellata come EXDATE');
    assert.ok(patch.fields.some((f) => f.startsWith('override[')));
  });

  test('proiezione: patch sui soli campi della decisione 3', async () => {
    const { result } = await serialized();
    const before = objectOf(result, `booking:${sc.confirmedUid}`);
    const target = parseCalendarObject(before.ics.replace('END:VEVENT', 'BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:x\r\nTRIGGER:-PT5M\r\nEND:VALARM\r\nEND:VEVENT'));
    assert.ok(target.ok);
    const prev = before.legacy_snapshot;
    assert.equal(prev.kind, 'booking');
    if (prev.kind !== 'booking' || !prev.booking) return;
    const current = { ...prev, booking: { ...prev.booking, attendee_phone: '+39 333 7654321' } };
    const patch = patchFromLegacyDiff(target.value, prev, current, { tz: 'Europe/Rome', now: NOW });
    assert.deepEqual(patch.fields, ['description']);
    assert.ok(patch.object.master!.components.some((c) => c.name === 'VALARM'));
  });
});
