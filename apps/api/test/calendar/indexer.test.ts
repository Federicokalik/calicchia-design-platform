/**
 * Indicizzatore dell'indice derivato (apps/api/src/lib/calendar/radicale/
 * indexer.ts e index-worker.ts; design §6.2, §6.4, §6.5, §6.7, §9; contratto
 * docs/calendar-radicale/contracts/f2-modules.md §2 e §5.1), senza Radicale:
 * i change set sono costruiti dal test come li costruirebbe la sync.
 *
 * Casi del piano F2 (voce "Test", gruppo INDEX):
 *  - RRULE invalida in una collezione bloccante → oggetto in quarantena e
 *    busy conservativo (query di busy del design §7), le altre risorse intatte;
 *  - file corrotto → quarantena con l'ultima versione buona (occorrenze stale),
 *    anche dopo un rebuild che ha svuotato le righe derivate;
 *  - rebuild da zero con gli stessi id (cal_object_ids persistente);
 *  - nessuna versione nuova se cambia solo DTSTAMP;
 *  - HOURLY infinita → materialized_until senza quarantena.
 * Più: zero scritture a contenuto invariato, override orfani, proiezioni,
 * festività e chiusure, all-day e decisione 6, 404 con file su disco, remote
 * mode, cancellazioni, interruttore anti-cancellazione, CAS, lock, worker_threads,
 * espansione al volo e orizzonte.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { HEALTH_REASONS } from '../../src/lib/calendar/index-model';
import { CalendarUnavailableError } from '../../src/lib/calendar/errors';
import { ensureHorizon, assertHorizonCovers } from '../../src/lib/calendar/radicale/horizon';
import {
  type ApplyOptions,
  applyCollectionChanges,
  type ChangeSetInput,
  CollectionCasError,
  type CollectionContext,
  CollectionLockTimeoutError,
  expandIndexedObject,
  loadCollectionContext,
  prepareCollectionChanges,
  type RawItem,
  rematerializeCollection,
  removeIndexedObjects,
  stopIndexWorker,
  withCollectionWriteLock,
} from '../../src/lib/calendar/radicale/indexer';
import { requestIndexRebuild, runIndexRebuild } from '../../src/lib/calendar/radicale/rebuild';
import { onBeforeDatabaseClose, sql } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';
import { withEnv } from '../helpers/env';

const fx = useFixtures('idx-indexer', { resetBaseline: true });

onBeforeDatabaseClose(async () => {
  await stopIndexWorker();
});

// ─── Utilità ───────────────────────────────

/** Orizzonte fisso: i test non dipendono dall'orologio. */
const H = Object.freeze({ start: new Date('2026-01-01T00:00:00Z'), end: new Date('2028-01-01T00:00:00Z') });

function ics(...components: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//Indexer//IT', ...components, 'END:VCALENDAR', ''].join('\r\n');
}

function vevent(lines: string[]): string {
  return ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
}

/** Serie di produzione: lun-mar-gio-ven alle 09:00 Europe/Rome, senza fine. */
function weeklySeries(uid: string, opts: { summary?: string; dtstamp?: string; rrule?: string; extra?: string[] } = {}): string {
  return vevent([
    `UID:${uid}`,
    `DTSTAMP:${opts.dtstamp ?? '20260101T000000Z'}`,
    'DTSTART;TZID=Europe/Rome:20260105T090000',
    'DTEND;TZID=Europe/Rome:20260105T100000',
    `RRULE:${opts.rrule ?? 'FREQ=WEEKLY;BYDAY=MO,TU,TH,FR'}`,
    `SUMMARY:${opts.summary ?? 'Studio'}`,
    ...(opts.extra ?? []),
  ]);
}

function singleEvent(uid: string, start: string, end: string, extra: string[] = []): string {
  return vevent([`UID:${uid}`, 'DTSTAMP:20260101T000000Z', `DTSTART:${start}`, `DTEND:${end}`, 'SUMMARY:Singolo', ...extra]);
}

async function makeCalendar(key: string, opts: { role?: string; blocks?: boolean } = {}): Promise<{ id: string; context: CollectionContext }> {
  const cal = await fx.calendar({ key, blocks_availability: opts.blocks ?? true });
  if (opts.role) await sql`UPDATE calendars SET role = ${opts.role} WHERE id = ${cal.id}`;
  return { id: cal.id, context: await loadCollectionContext(sql, cal.id) };
}

function input(context: CollectionContext, parts: Partial<ChangeSetInput> = {}): ChangeSetInput {
  return {
    context,
    upserts: [],
    deletes: [],
    radicaleSkipped: [],
    pending404: [],
    full: false,
    horizon: { start: H.start, end: H.end },
    actor: 'test',
    ...parts,
  };
}

async function apply(context: CollectionContext, parts: Partial<ChangeSetInput>, opts: Partial<ApplyOptions> = {}) {
  return applyCollectionChanges(input(context, parts), { syncedAt: new Date(), ...opts });
}

interface ObjRow {
  id: string;
  href: string;
  etag: string | null;
  health: string;
  health_reason: string | null;
  last_good_version_id: string | null;
  semantic_fp: string | null;
  content_sha256: string | null;
  raw_ics: string | null;
  materialized_until: Date | null;
  source: string;
  source_id: string | null;
  is_recurring: boolean;
}

async function objectRow(calendarId: string, href: string): Promise<ObjRow | undefined> {
  const [row] = await sql<ObjRow[]>`
    SELECT id, href, etag, health, health_reason, last_good_version_id, semantic_fp, content_sha256, raw_ics,
           materialized_until, source, source_id, is_recurring
    FROM cal_objects WHERE calendar_id = ${calendarId} AND href = ${href}
  `;
  return row;
}

interface OccRow {
  recurrence_key: string;
  start_utc: Date;
  end_utc: Date;
  kind: string;
  blocks: boolean;
  stale: boolean;
  all_day: boolean;
  component_id: string | null;
}

async function occurrences(objectId: string): Promise<OccRow[]> {
  return Array.from(await sql<OccRow[]>`
    SELECT recurrence_key, start_utc, end_utc, kind, blocks, stale, all_day, component_id
    FROM cal_occurrences WHERE object_id = ${objectId} ORDER BY start_utc, recurrence_key
  `);
}

async function versions(objectId: string): Promise<Array<{ id: string; change_kind: string; valid: boolean; etag: string | null }>> {
  return Array.from(await sql<Array<{ id: string; change_kind: string; valid: boolean; etag: string | null }>>`
    SELECT id, change_kind, valid, etag FROM cal_object_versions WHERE object_id = ${objectId} ORDER BY created_at, id
  `);
}

async function state(calendarId: string) {
  const [row] = await sql<Array<{
    index_version: string; health: string; object_count: number; quarantined_count: number; pending_deletions: string[];
    hold_since: Date | null; sync_token: string | null; dir_mtime_ns: string | null; dirty_since: Date | null;
    horizon_start: Date | null; horizon_end: Date | null; consecutive_failures: number;
  }>>`
    SELECT index_version::text, health, object_count, quarantined_count, pending_deletions, hold_since, sync_token,
           dir_mtime_ns::text, dirty_since, horizon_start, horizon_end, consecutive_failures
    FROM cal_collection_state WHERE calendar_id = ${calendarId}
  `;
  return row;
}

/** Query di busy del design §7 (flag dei calendari a query time). */
async function busy(from: string, to: string, calendarIds: string[]): Promise<Array<{ start_utc: Date; end_utc: Date }>> {
  return Array.from(await sql<Array<{ start_utc: Date; end_utc: Date }>>`
    SELECT o.start_utc, o.end_utc FROM cal_occurrences o
    JOIN calendars c ON c.id = o.calendar_id
    LEFT JOIN calendars p ON p.id = c.parent_calendar_id
    LEFT JOIN calendar_subscriptions s ON s.collection_calendar_id = c.id
    WHERE o.blocks
      AND CASE WHEN c.role = 'subscription'
               THEN COALESCE(s.blocks_availability, false) AND p.blocks_availability
               ELSE c.blocks_availability END
      AND o.span && tstzrange(${from}::timestamptz, ${to}::timestamptz, '[)')
      AND o.calendar_id = ANY(${calendarIds}::uuid[])
    ORDER BY o.start_utc
  `);
}

const item = (href: string, raw: string | null, etag: string | null = `"${href}-1"`): RawItem => ({ href, etag, raw });

afterEach(async () => {
  // Nessun test lascia CAL_ALLDAY_OPAQUE_BLOCKS impostata.
  delete process.env.CAL_ALLDAY_OPAQUE_BLOCKS;
});

// ─── Oggetti validi ───────────────────────────────

describe('indicizzatore: oggetti validi', () => {
  test('serie infinita lun-mar-gio-ven alle 09:00 Roma: occorrenze nell\'orizzonte, chiavi, blocks, versione e stato', async () => {
    const { id, context } = await makeCalendar('serie');
    const res = await apply(context, { upserts: [item('studio.ics', ics(weeklySeries('serie-1')))], full: true }, { newSyncToken: 't1', dirMtimeNs: 123n });
    assert.equal(res.upserted, 1);
    assert.equal(res.quarantined, 0);
    const obj = await objectRow(id, 'studio.ics');
    assert.ok(obj);
    assert.equal(obj.health, 'ok');
    assert.equal(obj.is_recurring, true);
    assert.equal(obj.source, 'manual');
    assert.match(obj.semantic_fp ?? '', /^v1:[0-9a-f]{64}$/);
    assert.equal(res.objectIds.get('studio.ics'), obj.id);
    // Settimana a cavallo del cambio d'ora di fine marzo 2026: sempre alle 09:00 locali.
    const week = (await occurrences(obj.id)).filter((o) => o.start_utc >= new Date('2026-03-23T00:00:00Z') && o.start_utc < new Date('2026-03-30T00:00:00Z'));
    assert.deepEqual(week.map((o) => o.start_utc.toISOString()), ['2026-03-23T08:00:00.000Z', '2026-03-24T08:00:00.000Z', '2026-03-26T08:00:00.000Z', '2026-03-27T08:00:00.000Z']);
    const after = (await occurrences(obj.id)).find((o) => o.start_utc >= new Date('2026-03-30T00:00:00Z'));
    assert.equal(after?.start_utc.toISOString(), '2026-03-30T07:00:00.000Z', 'dopo il cambio d\'ora resta alle 09:00 di Roma');
    assert.ok(week.every((o) => o.blocks && o.kind === 'event' && !o.stale && o.component_id === obj.id));
    assert.equal(week[0].recurrence_key, '20260323T080000Z');
    const v = await versions(obj.id);
    assert.deepEqual(v.map((x) => [x.change_kind, x.valid]), [['create', true]]);
    assert.equal(obj.last_good_version_id, v[0].id);
    const st = await state(id);
    assert.equal(st.health, 'healthy');
    assert.equal(st.object_count, 1);
    assert.equal(st.index_version, '1');
    assert.equal(st.sync_token, 't1');
    assert.equal(st.dir_mtime_ns, '123');
    assert.equal(st.horizon_start?.toISOString(), H.start.toISOString());
    assert.equal(st.horizon_end?.toISOString(), H.end.toISOString());
  });

  test('stesso etag e stesso testo: nessuna scrittura, nessuna versione, index_version invariata', async () => {
    const { id, context } = await makeCalendar('invariato');
    const raw = ics(weeklySeries('inv-1'));
    await apply(context, { upserts: [item('a.ics', raw)], full: true });
    const before = await state(id);
    const res = await apply(context, { upserts: [item('a.ics', raw)], full: true });
    assert.equal(res.unchanged, 1);
    assert.equal(res.upserted, 0);
    const after = await state(id);
    assert.equal(after.index_version, before.index_version);
    const obj = await objectRow(id, 'a.ics');
    assert.equal((await versions(obj!.id)).length, 1);
  });

  test('cambia solo DTSTAMP (nuovo etag): nessuna versione nuova; cambia il titolo: versione nuova', async () => {
    const { id, context } = await makeCalendar('dtstamp');
    await apply(context, { upserts: [item('d.ics', ics(weeklySeries('dt-1', { dtstamp: '20260101T000000Z' })), '"e1"')] });
    const first = await objectRow(id, 'd.ics');
    assert.ok(first);
    await apply(context, { upserts: [item('d.ics', ics(weeklySeries('dt-1', { dtstamp: '20260917T101500Z' })), '"e2"')] });
    const second = await objectRow(id, 'd.ics');
    assert.ok(second);
    assert.equal(second.etag, '"e2"', 'l\'etag nuovo è memorizzato (altrimenti la prossima sync lo rivedrebbe)');
    assert.notEqual(second.content_sha256, first.content_sha256);
    assert.equal(second.semantic_fp, first.semantic_fp, 'fingerprint semantico senza DTSTAMP');
    const v = await versions(second.id);
    assert.equal(v.length, 1, 'nessuna versione per un cambio del solo DTSTAMP');
    assert.equal(second.last_good_version_id, v[0].id);
    await apply(context, { upserts: [item('d.ics', ics(weeklySeries('dt-1', { summary: 'Studio (spostato)' })), '"e3"')] });
    const v3 = await versions(second.id);
    assert.deepEqual(v3.map((x) => x.change_kind), ['create', 'update']);
    assert.equal((await objectRow(id, 'd.ics'))?.last_good_version_id, v3[1].id);
  });

  test('HOURLY infinita: materialized_until, salute ok e tetto di 5000 occorrenze', async () => {
    const { id, context } = await makeCalendar('hourly');
    const raw = ics(vevent(['UID:h-1', 'DTSTAMP:20260101T000000Z', 'DTSTART:20260105T090000Z', 'DTEND:20260105T093000Z', 'RRULE:FREQ=HOURLY', 'SUMMARY:Ogni ora']));
    const res = await apply(context, { upserts: [item('h.ics', raw)], full: true });
    assert.equal(res.quarantined, 0);
    const obj = await objectRow(id, 'h.ics');
    assert.equal(obj?.health, 'ok');
    assert.ok(obj?.materialized_until instanceof Date);
    assert.equal((await occurrences(obj!.id)).length, 5000);
    // Oltre materialized_until l'espansione al volo copre la finestra richiesta.
    const ctx = await loadCollectionContext(sql, id);
    const from = new Date(obj!.materialized_until!.getTime() + 86_400_000);
    const onTheFly = expandIndexedObject({ id: obj!.id, calendar_id: id, href: 'h.ics', raw_ics: obj!.raw_ics, health: 'ok' }, ctx, { from, to: new Date(from.getTime() + 3 * 3_600_000) });
    assert.equal(onTheFly.conservative, false);
    assert.equal(onTheFly.occurrences.length, 3);
    assert.ok(onTheFly.occurrences.every((o) => o.blocks && o.kind === 'event'));
  });

  test('override fuori regola: occorrenza autonoma orphan_override bloccante e componente orphan', async () => {
    const { id, context } = await makeCalendar('orfani');
    const raw = ics(
      vevent(['UID:o-1', 'DTSTAMP:20260101T000000Z', 'DTSTART;TZID=Europe/Rome:20260105T090000', 'DTEND;TZID=Europe/Rome:20260105T100000', 'RRULE:FREQ=DAILY;COUNT=5', 'SUMMARY:Serie']),
      vevent(['UID:o-1', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID;VALUE=DATE:20260106', 'DTSTART;TZID=Europe/Rome:20260106T150000', 'DTEND;TZID=Europe/Rome:20260106T160000', 'SUMMARY:Spostata']),
      vevent(['UID:o-1', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID:20260201T080000Z', 'DTSTART:20260201T080000Z', 'DTEND:20260201T090000Z', 'SUMMARY:Orfana']),
    );
    await apply(context, { upserts: [item('o.ics', raw)] });
    const obj = await objectRow(id, 'o.ics');
    assert.equal(obj?.health, 'ok');
    const occ = await occurrences(obj!.id);
    const moved = occ.find((o) => o.recurrence_key === '20260106T080000Z');
    assert.equal(moved?.kind, 'override');
    assert.equal(moved?.start_utc.toISOString(), '2026-01-06T14:00:00.000Z');
    const orphan = occ.find((o) => o.kind === 'orphan_override');
    assert.ok(orphan, 'l\'override fuori regola resta nel busy');
    assert.equal(orphan.blocks, true);
    const comps = await sql<Array<{ id: string; recurrence_key: string; orphan: boolean; summary: string | null }>>`
      SELECT id, recurrence_key, orphan, summary FROM cal_components WHERE object_id = ${obj!.id} ORDER BY recurrence_key
    `;
    assert.deepEqual(comps.map((c) => [c.recurrence_key, c.orphan]), [['', false], ['20260106T080000Z', false], ['20260201T080000Z', true]]);
    assert.equal(orphan.component_id, comps.find((c) => c.orphan)?.id);
    const ids = await sql<Array<{ recurrence_key: string; id: string }>>`
      SELECT recurrence_key, id FROM cal_object_ids WHERE calendar_id = ${id} AND href = 'o.ics' AND retired_at IS NULL ORDER BY recurrence_key
    `;
    assert.deepEqual(ids.map((r) => r.id), comps.map((c) => c.id), 'id dei componenti = cal_object_ids');
  });

  test('proiezioni booking-* non bloccano, festività holiday_system, altri item delle festività closure', async () => {
    const bookings = await makeCalendar('bookings', { role: 'bookings' });
    await apply(bookings.context, {
      upserts: [
        item('booking-abc123.ics', ics(singleEvent('abc123@caldes.it', '20260310T090000Z', '20260310T100000Z'))),
        item('altro.ics', ics(singleEvent('altro-1', '20260311T090000Z', '20260311T100000Z'))),
      ],
    });
    const proj = await objectRow(bookings.id, 'booking-abc123.ics');
    assert.deepEqual([proj?.source, proj?.source_id], ['booking', 'abc123']);
    assert.deepEqual((await occurrences(proj!.id)).map((o) => [o.kind, o.blocks]), [['booking_projection', false]]);
    const other = await objectRow(bookings.id, 'altro.ics');
    assert.equal(other?.source, 'manual', 'una X-prop non promuove a booking: gli altri item restano manual');
    assert.deepEqual((await occurrences(other!.id)).map((o) => [o.kind, o.blocks]), [['event', true]]);

    const holidays = await makeCalendar('festivi', { role: 'holidays' });
    await apply(holidays.context, {
      upserts: [
        item('it-holiday-2026-06-02.ics', ics(singleEvent('it-holiday-2026-06-02@caldes.it', '20260601T220000Z', '20260602T220000Z'))),
        item('closure-x1.ics', ics(singleEvent('closure-x1', '20260810T220000Z', '20260814T220000Z'))),
      ],
    });
    const holiday = await objectRow(holidays.id, 'it-holiday-2026-06-02.ics');
    assert.deepEqual([holiday?.source, holiday?.source_id], ['system', 'it-holiday-2026-06-02']);
    assert.deepEqual((await occurrences(holiday!.id)).map((o) => [o.kind, o.blocks]), [['holiday_system', true]]);
    const closure = await objectRow(holidays.id, 'closure-x1.ics');
    assert.equal(closure?.source, 'admin');
    assert.deepEqual((await occurrences(closure!.id)).map((o) => [o.kind, o.blocks]), [['closure', true]]);
  });

  test('all-day: non bloccano (decisione 6 spenta); con CAL_ALLDAY_OPAQUE_BLOCKS=on solo TRANSP:OPAQUE esplicito', async () => {
    const allDay = (uid: string, transp?: string) => ics(vevent([
      `UID:${uid}`, 'DTSTAMP:20260101T000000Z', 'DTSTART;VALUE=DATE:20260420', 'DTEND;VALUE=DATE:20260421', 'SUMMARY:Giornata', ...(transp ? [`TRANSP:${transp}`] : []),
    ]));
    const off = await makeCalendar('allday-off');
    await apply(off.context, { upserts: [item('a.ics', allDay('ad-1')), item('b.ics', allDay('ad-2', 'OPAQUE'))] });
    for (const href of ['a.ics', 'b.ics']) {
      const occ = await occurrences((await objectRow(off.id, href))!.id);
      assert.deepEqual(occ.map((o) => [o.all_day, o.blocks]), [[true, false]]);
    }
    await withEnv({ CAL_ALLDAY_OPAQUE_BLOCKS: 'on' }, async () => {
      const on = await makeCalendar('allday-on');
      assert.equal(on.context.blockRules.allDayOpaqueBlocks, true);
      await apply(on.context, { upserts: [item('a.ics', allDay('ad-3')), item('b.ics', allDay('ad-4', 'OPAQUE')), item('c.ics', allDay('ad-5', 'TRANSPARENT'))] });
      const blocks = async (href: string) => (await occurrences((await objectRow(on.id, href))!.id))[0].blocks;
      assert.equal(await blocks('a.ics'), false, 'senza TRANSP gli all-day migrati restano non bloccanti');
      assert.equal(await blocks('b.ics'), true);
      assert.equal(await blocks('c.ics'), false);
    });
  });
});

// ─── Salute per oggetto ───────────────────────────────

describe('indicizzatore: salute per oggetto', () => {
  test('RRULE invalida in una collezione bloccante: quarantena e busy conservativo, le altre risorse intatte', async () => {
    const { id, context } = await makeCalendar('rrule-invalida');
    const res = await apply(context, {
      upserts: [
        item('rotto.ics', ics(weeklySeries('bad-1', { rrule: 'FREQ=WEEKLY;BYDAY=XX' }))),
        item('sano.ics', ics(singleEvent('good-1', '20260310T090000Z', '20260310T100000Z'))),
      ],
      full: true,
    });
    assert.equal(res.upserted, 2);
    assert.equal(res.quarantined, 1);
    const bad = await objectRow(id, 'rotto.ics');
    assert.deepEqual([bad?.health, bad?.health_reason], ['quarantined', HEALTH_REASONS.invalidRrule]);
    const occ = await occurrences(bad!.id);
    assert.equal(occ.length, 1);
    assert.deepEqual([occ[0].recurrence_key, occ[0].kind, occ[0].blocks, occ[0].stale], ['conservative', 'conservative', true, false]);
    assert.equal(occ[0].start_utc.toISOString(), '2026-01-05T08:00:00.000Z');
    assert.equal(occ[0].end_utc.toISOString(), H.end.toISOString(), 'fine aperta → fine dell\'orizzonte');
    // Busy conservativo: una giornata qualsiasi dopo il DTSTART è occupata.
    const day = await busy('2026-05-06T00:00:00Z', '2026-05-07T00:00:00Z', [id]);
    assert.equal(day.length, 1);
    const good = await objectRow(id, 'sano.ics');
    assert.equal(good?.health, 'ok');
    assert.equal((await occurrences(good!.id)).length, 1);
    const st = await state(id);
    assert.equal(st.quarantined_count, 1);
    assert.equal(st.health, 'healthy', 'un oggetto rotto non rende la collezione non sincronizzabile');
    const v = await versions(bad!.id);
    assert.deepEqual(v.map((x) => [x.change_kind, x.valid]), [['create', false]]);
    assert.equal(bad?.last_good_version_id, null);
  });

  test('RRULE che diventa invalida: restano (stale) le occorrenze dell\'ultima versione buona', async () => {
    const { id, context } = await makeCalendar('rrule-poi-invalida');
    await apply(context, { upserts: [item('s.ics', ics(weeklySeries('lg-1')), '"1"')] });
    const good = await objectRow(id, 's.ics');
    const goodOcc = await occurrences(good!.id);
    await apply(context, { upserts: [item('s.ics', ics(weeklySeries('lg-1', { rrule: 'FREQ=WEEKLY;INTERVAL=0' })), '"2"')] });
    const bad = await objectRow(id, 's.ics');
    assert.deepEqual([bad?.health, bad?.health_reason], ['quarantined', HEALTH_REASONS.invalidRrule]);
    assert.equal(bad?.last_good_version_id, good?.last_good_version_id);
    const occ = await occurrences(bad!.id);
    assert.equal(occ.length, goodOcc.length);
    assert.ok(occ.every((o) => o.stale && o.blocks));
    assert.deepEqual(occ.map((o) => o.recurrence_key), goodOcc.map((o) => o.recurrence_key));
  });

  test('file corrotto: quarantena con ultima versione buona; testo valido di nuovo: ok', async () => {
    const { id, context } = await makeCalendar('corrotto');
    await apply(context, { upserts: [item('c.ics', ics(weeklySeries('cor-1')), '"1"')] });
    const good = await objectRow(id, 'c.ics');
    const goodVersion = good!.last_good_version_id;
    const goodOcc = await occurrences(good!.id);
    const corrupt = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:cor-1\r\nDTSTART;TZID=Europe/Rome:20260105T09';
    const res = await apply(context, { upserts: [item('c.ics', corrupt, '"2"')] });
    assert.equal(res.quarantined, 1);
    const bad = await objectRow(id, 'c.ics');
    assert.equal(bad?.id, good?.id, 'stesso id');
    assert.deepEqual([bad?.health, bad?.health_reason], ['quarantined', HEALTH_REASONS.parseError]);
    assert.equal(bad?.raw_ics, corrupt, 'il testo corrente è quello rotto');
    assert.equal(bad?.etag, '"2"');
    assert.equal(bad?.semantic_fp, null);
    assert.equal(bad?.last_good_version_id, goodVersion);
    const occ = await occurrences(bad!.id);
    assert.equal(occ.length, goodOcc.length, 'restano le occorrenze dell\'ultima versione buona');
    assert.ok(occ.every((o) => o.stale));
    assert.ok((await busy('2026-02-02T00:00:00Z', '2026-02-03T00:00:00Z', [id])).length === 1, 'continua a bloccare');
    const v = await versions(bad!.id);
    assert.deepEqual(v.map((x) => [x.change_kind, x.valid]), [['create', true], ['update', false]]);
    // Stesso testo rotto, stesso etag: nessuna scrittura.
    const again = await apply(context, { upserts: [item('c.ics', corrupt, '"2"')] });
    assert.equal(again.unchanged, 1);
    // Testo di nuovo valido: fuori dalla quarantena.
    await apply(context, { upserts: [item('c.ics', ics(weeklySeries('cor-1', { summary: 'Riparato' })), '"3"')] });
    const fixed = await objectRow(id, 'c.ics');
    assert.equal(fixed?.health, 'ok');
    assert.ok((await occurrences(fixed!.id)).every((o) => !o.stale));
    assert.notEqual(fixed?.last_good_version_id, goodVersion);
  });

  test('quarantena dopo un rebuild che ha svuotato le righe derivate: occorrenze stale rigenerate dalla versione buona', async () => {
    const { id, context } = await makeCalendar('corrotto-rebuild');
    await apply(context, { upserts: [item('c.ics', ics(weeklySeries('cr-1')), '"1"')] });
    const good = await objectRow(id, 'c.ics');
    const goodCount = (await occurrences(good!.id)).length;
    // Rebuild: le righe derivate spariscono, id e versioni restano.
    await sql`DELETE FROM cal_objects WHERE calendar_id = ${id}`;
    await sql`DELETE FROM cal_collection_state WHERE calendar_id = ${id}`;
    await apply(context, { upserts: [item('c.ics', 'BEGIN:VCALENDAR\r\nGARBAGE', '"2"')], full: true }, { replaceAll: true });
    const bad = await objectRow(id, 'c.ics');
    assert.equal(bad?.id, good?.id, 'stesso id dopo il rebuild');
    assert.equal(bad?.health, 'quarantined');
    assert.equal(bad?.last_good_version_id, good?.last_good_version_id);
    const occ = await occurrences(bad!.id);
    assert.equal(occ.length, goodCount);
    assert.ok(occ.every((o) => o.stale && o.blocks));
  });

  test('file corrotto nuovo: blocco conservativo dal testo; senza DTSTART leggibile nessuna occorrenza e motivo unreadable', async () => {
    const { id, context } = await makeCalendar('corrotto-nuovo');
    const corrupt = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:cn-1\r\nDTSTART:20260415T100000Z\r\nDTEND:20260415T113000Z\r\nSUMMARY:troncato';
    await apply(context, { upserts: [item('n.ics', corrupt), item('u.ics', 'questo non è un calendario')] });
    const n = await objectRow(id, 'n.ics');
    assert.deepEqual([n?.health, n?.health_reason], ['quarantined', HEALTH_REASONS.parseError]);
    const occ = await occurrences(n!.id);
    assert.deepEqual(occ.map((o) => [o.recurrence_key, o.kind, o.blocks, o.start_utc.toISOString(), o.end_utc.toISOString()]), [
      ['conservative', 'conservative', true, '2026-04-15T10:00:00.000Z', '2026-04-15T11:30:00.000Z'],
    ]);
    const u = await objectRow(id, 'u.ics');
    assert.deepEqual([u?.health, u?.health_reason], ['quarantined', HEALTH_REASONS.unreadable]);
    assert.equal((await occurrences(u!.id)).length, 0);
  });

  test('budget di espansione esaurito: quarantena con l\'occorrenza conservativa dell\'espansione', async () => {
    const { id, context } = await makeCalendar('budget');
    const raw = ics(vevent(['UID:b-1', 'DTSTAMP:20260101T000000Z', 'DTSTART:20200101T000000Z', 'DTEND:20200101T000030Z', 'RRULE:FREQ=MINUTELY;COUNT=9000000', 'SUMMARY:Ogni minuto']));
    await apply(context, { upserts: [item('b.ics', raw)] });
    const obj = await objectRow(id, 'b.ics');
    assert.deepEqual([obj?.health, obj?.health_reason], ['quarantined', HEALTH_REASONS.expansionBudget]);
    const occ = await occurrences(obj!.id);
    assert.equal(occ.length, 1);
    assert.deepEqual([occ[0].kind, occ[0].blocks], ['conservative', true]);
    assert.notEqual(obj?.semantic_fp, null, 'il testo è valido: il fingerprint resta');
  });

  test('404 con file su disco (skip_broken_item): quarantena radicale-skip, occorrenze invariate e marcate stale', async () => {
    const { id, context } = await makeCalendar('skip');
    await apply(context, { upserts: [item('k.ics', ics(singleEvent('k-1', '20260310T090000Z', '20260310T100000Z')), '"1"')] });
    const before = await objectRow(id, 'k.ics');
    await apply(context, { radicaleSkipped: [{ href: 'k.ics', etag: null, raw: null }] });
    const after = await objectRow(id, 'k.ics');
    assert.deepEqual([after?.health, after?.health_reason], ['quarantined', HEALTH_REASONS.radicaleSkip]);
    assert.equal(after?.raw_ics, before?.raw_ics, 'senza testo dal mount resta quello noto');
    assert.equal(after?.etag, null, 'etag sconosciuto: la prossima sync rielabora la risorsa');
    const occ = await occurrences(after!.id);
    assert.deepEqual(occ.map((o) => [o.kind, o.blocks, o.stale]), [['event', true, true]]);
  });

  test('remote mode: primo 404 → pending_404 e continua a bloccare; ricompare → ok', async () => {
    const { id, context } = await makeCalendar('pending404');
    const raw = ics(singleEvent('p-1', '20260310T090000Z', '20260310T100000Z'));
    await apply(context, { upserts: [item('p.ics', raw, '"1"')] });
    await apply(context, { pending404: ['p.ics'] });
    const pending = await objectRow(id, 'p.ics');
    assert.equal(pending?.health, 'pending_404');
    assert.equal((await busy('2026-03-10T00:00:00Z', '2026-03-11T00:00:00Z', [id])).length, 1);
    const [{ count }] = await sql<Array<{ count: number }>>`SELECT pending_404_count AS count FROM cal_objects WHERE id = ${pending!.id}`;
    assert.equal(count, 1);
    await apply(context, { upserts: [item('p.ics', raw, '"1"')] });
    const back = await objectRow(id, 'p.ics');
    assert.equal(back?.health, 'ok');
  });

  test('un oggetto illeggibile non fa fallire la transazione della collezione', async () => {
    const { id, context } = await makeCalendar('misto');
    const res = await apply(context, {
      upserts: [
        item('a.ics', ics(singleEvent('m-1', '20260310T090000Z', '20260310T100000Z'))),
        item('b.ics', '\u0000\u0001 spazzatura'),
        item('c.ics', ics(vevent(['UID:m-3', 'SUMMARY:senza DTSTART']))),
        item('d.ics', ics(singleEvent('m-4', '20260311T090000Z', '20260311T100000Z'))),
      ],
      full: true,
    });
    assert.equal(res.upserted, 4);
    assert.equal(res.quarantined, 2);
    assert.equal((await objectRow(id, 'a.ics'))?.health, 'ok');
    assert.equal((await objectRow(id, 'd.ics'))?.health, 'ok');
    assert.equal((await objectRow(id, 'b.ics'))?.raw_ics?.includes('\u0000'), false, 'NUL sostituito: Postgres non lo accetta nei TEXT');
  });
});

// ─── Collezione ───────────────────────────────

describe('indicizzatore: cancellazioni, hold, CAS, mtime', () => {
  test('cancellazione confermata: versione delete con l\'ultimo testo, id ritirato e riattivato (stesso id) se ricompare', async () => {
    const { id, context } = await makeCalendar('cancella');
    const raw = ics(singleEvent('del-1', '20260310T090000Z', '20260310T100000Z'));
    await apply(context, { upserts: [item('x.ics', raw)] });
    const obj = await objectRow(id, 'x.ics');
    const res = await apply(context, { deletes: ['x.ics'] });
    assert.equal(res.deleted, 1);
    assert.equal(await objectRow(id, 'x.ics'), undefined);
    const v = await versions(obj!.id);
    assert.deepEqual(v.map((x) => x.change_kind), ['create', 'delete']);
    const [ids] = await sql<Array<{ retired_at: Date | null }>>`SELECT retired_at FROM cal_object_ids WHERE id = ${obj!.id}`;
    assert.ok(ids.retired_at instanceof Date);
    await apply(context, { upserts: [item('x.ics', raw)] });
    const back = await objectRow(id, 'x.ics');
    assert.equal(back?.id, obj?.id);
    assert.deepEqual((await versions(obj!.id)).map((x) => x.change_kind), ['create', 'delete', 'create']);
    // removeIndexedObjects: stessa semantica, senza toccare lo stato di sync.
    await removeIndexedObjects(id, ['x.ics'], { actor: 'test' });
    assert.equal(await objectRow(id, 'x.ics'), undefined);
  });

  test('interruttore anti-cancellazione: hold sospende le cancellazioni, gli upsert si applicano, chi ricompare esce', async () => {
    const { id, context } = await makeCalendar('hold');
    const raws = ['h1', 'h2', 'h3'].map((u) => item(`${u}.ics`, ics(singleEvent(u, '20260310T090000Z', '20260310T100000Z'))));
    await apply(context, { upserts: raws, full: true });
    const res = await apply(context, { upserts: [item('h4.ics', ics(singleEvent('h4', '20260312T090000Z', '20260312T100000Z')))] }, {
      hold: { reason: 'mass-delete', pendingDeletions: ['h1.ics', 'h2.ics', 'h3.ics'] },
    });
    assert.equal(res.held, true);
    let st = await state(id);
    assert.equal(st.health, 'hold');
    assert.deepEqual(st.pending_deletions, ['h1.ics', 'h2.ics', 'h3.ics']);
    assert.ok(await objectRow(id, 'h1.ics'), 'le occorrenze esistenti continuano a bloccare');
    assert.ok(await objectRow(id, 'h4.ics'), 'l\'upsert si applica comunque');
    // Una sync senza nuova sospensione: hold resta finché ci sono cancellazioni sospese; h2 ricompare e ne esce.
    await apply(context, { upserts: [raws[1]] }, { hold: null });
    st = await state(id);
    assert.equal(st.health, 'hold');
    assert.deepEqual(st.pending_deletions, ['h1.ics', 'h3.ics']);
    // "Applica cancellazioni": le sospese diventano cancellazioni confermate, hold finisce.
    await apply(context, { deletes: ['h1.ics', 'h3.ics'] });
    st = await state(id);
    assert.equal(st.health, 'healthy');
    assert.deepEqual(st.pending_deletions, []);
    assert.equal(st.hold_since, null);
  });

  test('CAS sul sync-token: token diverso → CollectionCasError, nessuna scrittura', async () => {
    const { id, context } = await makeCalendar('cas');
    await apply(context, { upserts: [item('a.ics', ics(singleEvent('cas-1', '20260310T090000Z', '20260310T100000Z')))] }, { expectedSyncToken: null, newSyncToken: 't1' });
    await assert.rejects(
      apply(context, { upserts: [item('b.ics', ics(singleEvent('cas-2', '20260310T090000Z', '20260310T100000Z')))] }, { expectedSyncToken: 'altro', newSyncToken: 't2' }),
      CollectionCasError,
    );
    assert.equal(await objectRow(id, 'b.ics'), undefined);
    assert.equal((await state(id)).sync_token, 't1');
    await apply(context, { upserts: [item('b.ics', ics(singleEvent('cas-2', '20260310T090000Z', '20260310T100000Z')))] }, { expectedSyncToken: 't1', newSyncToken: 't2' });
    assert.equal((await state(id)).sync_token, 't2');
  });

  test('dirty_since: azzerato solo da una sync che salva una dir_mtime_ns non NULL', async () => {
    const { id, context } = await makeCalendar('dirty');
    await apply(context, { full: true }, { dirMtimeNs: 10n });
    const marked = new Date(Date.now() - 1_000);
    await sql`UPDATE cal_collection_state SET dirty_since = ${marked} WHERE calendar_id = ${id}`;
    await apply(context, {}, { dirMtimeNs: null });
    assert.ok((await state(id)).dirty_since instanceof Date, 'finestra racy: resta dirty');
    await apply(context, {}, { dirMtimeNs: 20n });
    const st = await state(id);
    assert.equal(st.dirty_since, null);
    assert.equal(st.dir_mtime_ns, '20');
  });
  test('sync iniziale da token nullo: healthy anche se incrementale; incrementale su una collezione mai sincronizzata: stale', async () => {
    const { id: a, context: ca } = await makeCalendar('iniziale');
    await apply(ca, { upserts: [item('a.ics', ics(singleEvent('ini-1', '20260310T090000Z', '20260310T100000Z')))] }, { expectedSyncToken: null, newSyncToken: 't1', dirMtimeNs: 5n });
    assert.equal((await state(a)).health, 'healthy', 'il REPORT da token nullo elenca tutta la collezione');
    const { id: b, context: cb } = await makeCalendar('incrementale');
    await apply(cb, { upserts: [item('b.ics', ics(singleEvent('inc-1', '20260310T090000Z', '20260310T100000Z')))] });
    assert.equal((await state(b)).health, 'stale');
    await apply(cb, { full: true, upserts: [item('b.ics', ics(singleEvent('inc-1', '20260310T090000Z', '20260310T100000Z')))] });
    assert.equal((await state(b)).health, 'healthy');
  });
});

// ─── Iscrizioni ───────────────────────────────

describe('iscrizioni (origin remote)', () => {
  test('DTSTAMP sempre nuovo: zero scritture e zero versioni; oggetto rotto stabile: zero scritture, occorrenze tenute (stale)', async () => {
    const { id, context } = await makeCalendar('iscrizione', { role: 'subscription' });
    assert.deepEqual([context.originStore, context.versions], ['remote', false]);
    const feed = (dtstamp: string, rrule?: string, summary?: string): RawItem => ({
      href: 'r-abc.ics',
      etag: null,
      raw: ics(weeklySeries('remote-1', { dtstamp, rrule, summary })),
    });
    const first = await apply(context, { upserts: [feed('20261001T000000Z')], full: true });
    assert.equal(first.upserted, 1);
    const obj = await objectRow(id, 'r-abc.ics');
    assert.deepEqual([obj?.health, obj?.etag, obj?.last_good_version_id], ['ok', null, null]);
    assert.equal((await versions(obj!.id)).length, 0, 'nessuna versione per le iscrizioni');
    const v0 = (await state(id)).index_version;

    const again = await apply(context, { upserts: [feed('20261002T000000Z')], full: true });
    assert.deepEqual([again.unchanged, again.upserted], [1, 0]);
    assert.equal((await state(id)).index_version, v0, 'zero scritture: stesso fingerprint semantico');
    const occOk = await occurrences(obj!.id);

    // RRULE rotta nel feed: quarantena del solo oggetto; senza versioni restano le occorrenze già indicizzate.
    const broken = await apply(context, { upserts: [feed('20261003T000000Z', 'FREQ=WEEKLY;BYDAY=XX')], full: true });
    assert.equal(broken.quarantined, 1);
    const bad = await objectRow(id, 'r-abc.ics');
    assert.deepEqual([bad?.id, bad?.health, bad?.health_reason, bad?.semantic_fp], [obj?.id, 'quarantined', HEALTH_REASONS.invalidRrule, null]);
    const occBad = await occurrences(obj!.id);
    assert.equal(occBad.length, occOk.length);
    assert.ok(occBad.every((o) => o.stale && o.blocks));
    const v1 = (await state(id)).index_version;

    // Lo stesso oggetto rotto con un DTSTAMP nuovo a ogni pull: invariato (fingerprint del testo indicizzato).
    const brokenAgain = await apply(context, { upserts: [feed('20261004T000000Z', 'FREQ=WEEKLY;BYDAY=XX')], full: true });
    assert.deepEqual([brokenAgain.unchanged, brokenAgain.upserted], [1, 0]);
    assert.equal((await state(id)).index_version, v1);

    // Riparato nel feed: ok e occorrenze rigenerate.
    await apply(context, { upserts: [feed('20261005T000000Z', undefined, 'Studio (nuovo)')], full: true });
    const fixed = await objectRow(id, 'r-abc.ics');
    assert.deepEqual([fixed?.health, fixed?.id], ['ok', obj?.id]);
    assert.ok((await occurrences(obj!.id)).every((o) => !o.stale));
    assert.equal((await versions(obj!.id)).length, 0);
  });
});

// ─── Rebuild ───────────────────────────────

describe('rebuild', () => {
  test('rebuild da zero con gli stessi id, senza mai svuotare il busy durante la richiesta', async () => {
    const { id, context } = await makeCalendar('rebuild');
    const series = ics(
      vevent(['UID:rb-1', 'DTSTAMP:20260101T000000Z', 'DTSTART;TZID=Europe/Rome:20260105T090000', 'DTEND;TZID=Europe/Rome:20260105T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR', 'SUMMARY:Serie']),
      vevent(['UID:rb-1', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID;TZID=Europe/Rome:20260106T090000', 'DTSTART;TZID=Europe/Rome:20260106T110000', 'DTEND;TZID=Europe/Rome:20260106T120000', 'SUMMARY:Spostata']),
    );
    const items = [item('serie.ics', series), item('singolo.ics', ics(singleEvent('rb-2', '20260310T090000Z', '20260310T100000Z')))];
    await apply(context, { upserts: items, full: true }, { newSyncToken: 't1', dirMtimeNs: 5n });
    const snapshot = async () => Array.from(await sql<Array<{ href: string; recurrence_key: string; id: string }>>`
      SELECT o.href, c.recurrence_key, c.id FROM cal_components c JOIN cal_objects o ON o.id = c.object_id
      WHERE o.calendar_id = ${id} ORDER BY o.href, c.recurrence_key
    `, (r) => ({ ...r }));
    const before = await snapshot();
    assert.equal(before.length, 3);

    await requestIndexRebuild(sql, { reason: 'test', actor: 'test' });
    const [backend] = await sql<Array<{ rebuild_required: boolean }>>`SELECT rebuild_required FROM calendar_backend_state WHERE id = true`;
    assert.equal(backend.rebuild_required, true);
    const st = await state(id);
    assert.deepEqual([st.sync_token, st.dir_mtime_ns], [null, null], 'le decisioni troveranno dir_mtime NULL e forzeranno la sync');
    assert.ok((await busy('2026-03-10T00:00:00Z', '2026-03-11T00:00:00Z', [id])).length > 0, 'la richiesta non svuota il busy');
    const [job] = await sql<Array<{ status: string }>>`SELECT status FROM cal_jobs WHERE kind = 'index_rebuild' AND key = 'all'`;
    assert.equal(job?.status, 'pending');

    // Ricostruzione della collezione: derivate da zero, stesso contenuto, replaceAll.
    await sql`DELETE FROM cal_objects WHERE calendar_id = ${id}`;
    await apply(context, { upserts: items, full: true, actor: 'rebuild' }, { replaceAll: true, newSyncToken: 't2', dirMtimeNs: 6n });
    assert.deepEqual(await snapshot(), before, 'id identici dopo il rebuild');
    // Nessuna versione nuova: il contenuto non è cambiato.
    const obj = await objectRow(id, 'serie.ics');
    assert.equal((await versions(obj!.id)).length, 1);

    // Volume mai inizializzato (mode postgres, epoch 0): nulla da ricostruire, rebuild_required si azzera.
    const report = await runIndexRebuild();
    assert.equal(report.cleared, true);
    const [after] = await sql<Array<{ rebuild_required: boolean }>>`SELECT rebuild_required FROM calendar_backend_state WHERE id = true`;
    assert.equal(after.rebuild_required, false);
    await sql`DELETE FROM cal_jobs WHERE kind = 'index_rebuild'`;
  });
});

// ─── Lock ───────────────────────────────

describe('lock della collezione', () => {
  test('rientrante per la stessa collezione, vietato annidare collezioni diverse', async () => {
    const a = await makeCalendar('lock-a');
    const b = await makeCalendar('lock-b');
    const out = await withCollectionWriteLock(a.id, async (outer) => withCollectionWriteLock(a.id, async (inner) => inner === outer));
    assert.equal(out, true);
    await assert.rejects(withCollectionWriteLock(a.id, async () => withCollectionWriteLock(b.id, async () => 1)), /vietato/);
  });

  test('advisory lock tenuto da un altro processo: CollectionLockTimeoutError entro il deadline', async () => {
    const { id } = await makeCalendar('lock-timeout');
    const other = await sql.reserve();
    try {
      await other`SELECT pg_advisory_lock(hashtext(${`cal-sync:${id}`}))`;
      const started = Date.now();
      await assert.rejects(withCollectionWriteLock(id, async () => 1, { deadline: Date.now() + 300 }), CollectionLockTimeoutError);
      assert.ok(Date.now() - started < 2_000);
      await other`SELECT pg_advisory_unlock(hashtext(${`cal-sync:${id}`}))`;
      assert.equal(await withCollectionWriteLock(id, async () => 2), 2);
    } finally {
      other.release();
    }
  });
});

// ─── Worker thread ───────────────────────────────

describe('preparazione in worker_threads', () => {
  test('stesso risultato nel worker e nel thread principale', async () => {
    const { context } = await makeCalendar('worker');
    const upserts = [
      item('a.ics', ics(weeklySeries('w-1'))),
      item('b.ics', 'BEGIN:VCALENDAR\r\nrotto'),
      item('c.ics', ics(weeklySeries('w-3', { rrule: 'FREQ=WEEKLY;BYDAY=XX' }))),
    ];
    const base = input(context, { upserts });
    const inThread = await prepareCollectionChanges(base, { worker: false });
    const inWorker = await prepareCollectionChanges(base, { worker: true });
    assert.deepEqual(inWorker.items, inThread.items);
    assert.equal(inWorker.items[0].health, 'ok');
  });
});

// ─── Orizzonte ───────────────────────────────

describe('orizzonte', () => {
  test('ensureHorizon estende le collezioni rimaste indietro; assertHorizonCovers fallisce chiusa', async () => {
    const { id, context } = await makeCalendar('orizzonte');
    const short = { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-03-01T00:00:00Z') };
    await applyCollectionChanges(input(context, { upserts: [item('s.ics', ics(weeklySeries('hz-1')))], full: true, horizon: short }), { syncedAt: new Date() });
    const obj = await objectRow(id, 's.ics');
    const countShort = (await occurrences(obj!.id)).length;
    await assert.rejects(assertHorizonCovers(sql, new Date('2026-06-01T00:00:00Z'), [id]), (err: unknown) => err instanceof CalendarUnavailableError && err.reason === 'horizon_insufficient');

    const now = new Date('2026-02-01T12:00:00Z');
    const res = await ensureHorizon({ now });
    assert.ok(res.extended.includes(id));
    const st = await state(id);
    assert.equal(st.horizon_end?.toISOString(), '2028-04-11T00:00:00.000Z', 'oggi + 800 giorni');
    assert.ok((await occurrences(obj!.id)).length > countShort, 'la serie infinita avanza con l\'orizzonte');
    await assertHorizonCovers(sql, new Date('2026-06-01T00:00:00Z'), [id]);
    // Rimaterializzazione: nessuna versione nuova (il testo non cambia).
    assert.equal((await versions(obj!.id)).length, 1);
    const again = await rematerializeCollection(id, { horizon: { start: st.horizon_start!, end: st.horizon_end! }, reason: 'rules' });
    assert.equal(again.upserted, 1);
    assert.equal((await versions(obj!.id)).length, 1);
  });

  test('expandIndexedObject su un testo illeggibile: blocco conservativo della sola finestra', async () => {
    const { id, context } = await makeCalendar('al-volo');
    const window = { from: new Date('2030-03-01T00:00:00Z'), to: new Date('2030-03-02T00:00:00Z') };
    const res = expandIndexedObject({ id: '00000000-0000-4000-8000-000000000000', calendar_id: id, href: 'x.ics', raw_ics: 'spazzatura', health: 'quarantined' }, context, window);
    assert.equal(res.conservative, true);
    assert.deepEqual(res.occurrences.map((o) => [o.kind, o.blocks, o.start.toISOString(), o.end.toISOString()]), [['conservative', true, window.from.toISOString(), window.to.toISOString()]]);
  });
});
