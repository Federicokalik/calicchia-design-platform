/**
 * Proiezione inversa Radicale → Postgres della F4 senza Radicale
 * (apps/api/src/lib/calendar/migration/reverse-projector.ts; design §13.11;
 * contratto docs/calendar-radicale/contracts/f4-modules.md §4). L'indice si
 * popola con l'indicizzatore reale (applyCollectionChanges), come lo
 * popolerebbe la sync; la prova con Radicale reale è in
 * test/integration/reverse-projector.test.ts.
 *
 * Cosa si verifica:
 *  - projectObject sulle fixture: RDATE e serie New York → righe derivate con
 *    il busy legacy identico a quello dell'indice; serie di Roma con override
 *    ed EXDATE → master e override (stessa espansione legacy); serie UTC che
 *    attraversa il cambio d'ora → espansa; UID dell'invito duplicato, durata
 *    zero, SUMMARY assente, override con l'UID del master, TRANSP, STATUS non
 *    standard, VALARM e X-* → righe sanificate e classificate;
 *  - computeReversePlan/applyReversePlan sul database: busy legacy identico
 *    all'indice (RDATE, New York), id e UID legacy riusati per i migrati,
 *    cancellazioni delle sole righe possedute, override annullati legacy
 *    riassorbiti dalle EXDATE, idempotenza (seconda passata senza scritture,
 *    hash stabile anche dopo l'apply), guardia 166 e GUC;
 *  - proiezioni delle prenotazioni: annullata nella finestra → riga legacy
 *    cancelled e slot libero dopo il ritorno a postgres; riprogrammata →
 *    vecchia riga cancelled e nuova riga con il testo di createLegacyProjection;
 *  - job reverse_projection: nessun job fallito sui casi limite, chiusura
 *    senza azione fuori finestra o fuori da mode radicale, errore d'attesa con
 *    cal-migration occupato, giro di backstop, salute per il wizard.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { buildBookingProjectionIcs } from '../../src/lib/calendar/booking-projection';
import { invalidateBackendModeCache } from '../../src/lib/calendar/backend-mode';
import { indexBusyRanges } from '../../src/lib/calendar/busy';
import { computeRollbackPreview } from '../../src/lib/calendar/migration/rollback';
import {
  runCalendarJobsOnce,
  stopCalendarJobWorker,
  unregisterCalendarJobHandler,
} from '../../src/lib/calendar/jobs';
import { getBusyRanges as legacyBusyRanges } from '../../src/lib/calendar/legacy/events-pg';
import {
  applyReversePlan,
  computeReversePlan,
  legacyBusyAfterPlan,
  legacyBusyFromRows,
  type ProjectObjectInput,
  projectObject,
  readReverseProjectionHealth,
  registerReverseProjectionJob,
  REVERSE_PROJECTION_JOB_KIND,
  reversePlanHash,
  reverseProjectionActive,
  runReverseProjection,
  runReverseProjectionSweep,
  type ReverseOccurrenceInput,
  enqueueReverseProjection,
  closePendingReverseProjectionJobs,
} from '../../src/lib/calendar/migration/reverse-projector';
import { withMigrationLock } from '../../src/lib/calendar/migration/runs';
import { isCalendarEventsGuardError } from '../../src/lib/calendar/migration/transition';
import { type CollectionContext, prepareItem } from '../../src/lib/calendar/radicale/index-worker';
import { applyCollectionChanges, loadCollectionContext, removeIndexedObjects, stopIndexWorker } from '../../src/lib/calendar/radicale/indexer';
import { reserveObjectId } from '../../src/lib/calendar/radicale/ids';
import { computeAvailableSlots } from '../../src/lib/calendar/slots';
import type { Calendar } from '../../src/lib/calendar/types';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql } from '../helpers/db';
import { romeIso, useFixtures } from '../helpers/fixtures';

const fx = useFixtures('reverse', { resetBaseline: true });

onBeforeDatabaseClose(async () => {
  unregisterCalendarJobHandler(REVERSE_PROJECTION_JOB_KIND);
  await stopCalendarJobWorker();
  await stopIndexWorker();
  await sql`DELETE FROM cal_jobs WHERE kind = ${REVERSE_PROJECTION_JOB_KIND}`;
  await resetCalendarBaseline();
});

const VOLUME = '7a2c4e6f-8b1d-4c3e-9f50-a1b2c3d4e5f6';
/** Orizzonte dei change set: copre tutte le finestre dei test. */
const H = Object.freeze({ start: new Date('2026-06-01T00:00:00Z'), end: new Date('2028-06-01T00:00:00Z') });

afterEach(async () => {
  unregisterCalendarJobHandler(REVERSE_PROJECTION_JOB_KIND);
  await sql`DELETE FROM cal_jobs WHERE kind = ${REVERSE_PROJECTION_JOB_KIND}`;
  await setPostgres();
});

// ─── Stato del backend ───────────────────────────────

async function setRadicale(opts: { rollbackUntil?: Date | null } = {}): Promise<void> {
  const until = opts.rollbackUntil === undefined ? new Date(Date.now() + 30 * 86_400_000) : opts.rollbackUntil;
  await sql`
    UPDATE calendar_backend_state
    SET mode = 'radicale', write_freeze = false, volume_id = ${VOLUME}::uuid, epoch = 2,
        rollback_until = ${until}, cutover_at = now() - interval '1 hour', cutover_by = 'admin:test-reverse'
    WHERE id
  `;
  invalidateBackendModeCache();
}

async function setPostgres(): Promise<void> {
  await sql`
    UPDATE calendar_backend_state
    SET mode = 'postgres', write_freeze = false, rollback_until = NULL, cutover_at = NULL, cutover_by = NULL
    WHERE id
  `;
  invalidateBackendModeCache();
}

// ─── iCalendar ───────────────────────────────

function vcal(...components: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//Reverse F4//IT', ...components, 'END:VCALENDAR', ''].join('\r\n');
}

function vevent(lines: string[]): string {
  return ['BEGIN:VEVENT', 'DTSTAMP:20261001T000000Z', ...lines, 'END:VEVENT'].join('\r\n');
}

/** Occorrenze come le scrive l'indicizzatore (prepareItem), senza database. */
function occurrencesOf(raw: string, href: string, cal: { role: CollectionContext['role']; timezone: string }): ReverseOccurrenceInput[] {
  const context: CollectionContext = {
    calendarId: '00000000-0000-4000-8000-000000000001',
    collectionName: 'test',
    role: cal.role,
    timezone: cal.timezone,
    originStore: 'radicale',
    versions: true,
    blockRules: { allDayOpaqueBlocks: false },
  };
  const item = prepareItem({ href, etag: '"e1"', raw }, 'upsert', { context, from: H.start.getTime(), to: H.end.getTime() });
  return item.occurrences.map((o) => ({
    recurrence_key: o.recurrenceKey,
    start_utc: o.startUtc,
    end_utc: o.endUtc,
    all_day: o.allDay,
    status: o.status,
    transp: o.transp,
    blocks: o.blocks,
  }));
}

const OBJ_ID = '11111111-1111-4111-8111-111111111111';
const CAL_ID = '22222222-2222-4222-8222-222222222222';

function input(raw: string, opts: Partial<Omit<ProjectObjectInput, 'object' | 'calendar'>> & { href?: string; collection?: string; timezone?: string; role?: CollectionContext['role'] } = {}): ProjectObjectInput {
  const href = opts.href ?? 'evento.ics';
  const calendar = { id: CAL_ID, collection_name: opts.collection ?? 'lavoro', role: opts.role ?? 'user', timezone: opts.timezone ?? 'Europe/Rome' } as const;
  return {
    object: { id: OBJ_ID, calendar_id: CAL_ID, collection_name: calendar.collection_name, href, etag: '"e1"', raw_ics: raw, content_sha256: null },
    calendar,
    ids: opts.ids ?? { master: { id: OBJ_ID, legacy_uid: null }, byRecurrenceKey: new Map() },
    occurrences: opts.occurrences ?? occurrencesOf(raw, href, calendar),
    usedUids: opts.usedUids ?? new Set(),
    booking: opts.booking ?? null,
    horizon: opts.horizon ?? { from: H.start, to: H.end },
    existingUids: opts.existingUids,
  };
}

/** Busy dell'indice (occorrenze con blocks) fra due istanti, come intervalli ISO ordinati e distinti. */
function indexBusyOf(occ: readonly ReverseOccurrenceInput[], fromIso: string, toIso: string): Array<{ start: string; end: string }> {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  const seen = new Set<string>();
  return occ
    .filter((o) => o.blocks && Date.parse(o.start_utc) < to && Date.parse(o.end_utc) > from)
    .map((o) => ({ start: new Date(o.start_utc).toISOString(), end: new Date(o.end_utc).toISOString() }))
    .filter((r) => (seen.has(`${r.start}|${r.end}`) ? false : (seen.add(`${r.start}|${r.end}`), true)))
    .sort((a, b) => a.start.localeCompare(b.start));
}

const classes = (plan: { degradations: Array<{ class: string }> }): string[] => [...new Set(plan.degradations.map((d) => d.class))].sort();

// ─── projectObject (puro) ───────────────────────────────

describe('projectObject: mappatura totale sulle fixture', () => {
  test('RDATE → righe derivate: il busy legacy coincide con quello di Radicale (il 14/10 c\'è)', () => {
    const raw = vcal(vevent([
      'UID:rdate-1@test', 'SUMMARY:Riunione con RDATE',
      'DTSTART;TZID=Europe/Rome:20261001T100000', 'DTEND;TZID=Europe/Rome:20261001T110000',
      'RRULE:FREQ=WEEKLY;COUNT=6', 'RDATE;TZID=Europe/Rome:20261014T150000',
    ]));
    const inp = input(raw);
    const plan = projectObject(inp);
    assert.equal(plan.error, null);
    assert.equal(plan.status, 'degraded');
    assert.ok(plan.rows.length === 7 && plan.rows.every((r) => r.role === 'derived' && r.row.caldes_derived && r.row.rrule === null));
    assert.deepEqual(classes(plan), ['SEMANTIC_EXPANDED']);
    const expanded = plan.degradations.find((d) => d.class === 'SEMANTIC_EXPANDED');
    assert.deepEqual(expanded?.detail?.reasons, ['rdate']);
    assert.ok(plan.rows.some((r) => r.row.start_time === '2026-10-14T13:00:00.000Z'), 'occorrenza della RDATE presente');
    // Il 29/10, dopo il cambio d'ora, resta alle 10:00 di Roma (09:00Z).
    assert.ok(plan.rows.some((r) => r.row.start_time === '2026-10-29T09:00:00.000Z'));
    const from = '2026-09-01T00:00:00Z';
    const to = '2027-01-01T00:00:00Z';
    assert.deepEqual(legacyBusyFromRows(plan.rows.map((r) => r.row), from, to), indexBusyOf(inp.occurrences, from, to));
    // UID delle derivate: <UID>#<recurrence_key>, unici.
    assert.equal(new Set(plan.rows.map((r) => r.row.uid)).size, plan.rows.length);
    assert.ok(plan.rows.every((r) => r.row.uid === `rdate-1@test#${r.recurrence_key}`));
    assert.equal(plan.horizon_until, H.end.toISOString());
  });

  test('serie New York a cavallo dei due cambi d\'ora → espansa: busy legacy identico, istanti di New York', () => {
    const raw = vcal(vevent([
      'UID:ny-weekly@test', 'SUMMARY:Call con New York',
      'DTSTART;TZID=America/New_York:20261005T100000', 'DTEND;TZID=America/New_York:20261005T110000',
      'RRULE:FREQ=WEEKLY;COUNT=10',
    ]));
    const inp = input(raw);
    const plan = projectObject(inp);
    assert.equal(plan.status, 'degraded');
    assert.equal(plan.rows.length, 10);
    assert.deepEqual(plan.degradations.find((d) => d.class === 'SEMANTIC_EXPANDED')?.detail?.reasons, ['timezone']);
    // Ora legale USA fino al 1/11: 10:00 EDT = 14:00Z; poi EST = 15:00Z (Roma è già cambiata il 25/10).
    assert.ok(plan.rows.some((r) => r.row.start_time === '2026-10-26T14:00:00.000Z'));
    assert.ok(plan.rows.some((r) => r.row.start_time === '2026-11-02T15:00:00.000Z'));
    const from = '2026-09-01T00:00:00Z';
    const to = '2027-01-01T00:00:00Z';
    assert.deepEqual(legacyBusyFromRows(plan.rows.map((r) => r.row), from, to), indexBusyOf(inp.occurrences, from, to));
  });

  test('serie di Roma con override ed EXDATE → master più override, stessa espansione del legacy', () => {
    const raw = vcal(
      vevent([
        'UID:roma-serie@test', 'SUMMARY:Standup',
        'DTSTART;TZID=Europe/Rome:20261019T090000', 'DTEND;TZID=Europe/Rome:20261019T093000',
        'RRULE:FREQ=DAILY;COUNT=10', 'EXDATE;TZID=Europe/Rome:20261021T090000',
      ]),
      vevent([
        'UID:roma-serie@test', 'SUMMARY:Standup spostato', 'RECURRENCE-ID;TZID=Europe/Rome:20261023T090000',
        'DTSTART;TZID=Europe/Rome:20261023T110000', 'DTEND;TZID=Europe/Rome:20261023T113000',
      ]),
    );
    const overrideId = '33333333-3333-4333-8333-333333333333';
    const inp = input(raw, { ids: { master: { id: OBJ_ID, legacy_uid: null }, byRecurrenceKey: new Map([['20261023T070000Z', overrideId]]) } });
    const plan = projectObject(inp);
    assert.equal(plan.error, null);
    const master = plan.rows.find((r) => r.role === 'master');
    const override = plan.rows.find((r) => r.role === 'override');
    assert.ok(master && override, JSON.stringify(plan.rows.map((r) => r.role)));
    assert.equal(plan.rows.length, 2);
    assert.equal(master.row.rrule, 'FREQ=DAILY;COUNT=10');
    assert.deepEqual(master.row.exdates, ['2026-10-21T07:00:00.000Z']);
    assert.equal(master.row.uid, 'roma-serie@test');
    assert.equal(override.id, overrideId);
    assert.equal(override.row.recurrence_master_id, OBJ_ID);
    assert.equal(override.row.recurrence_id, '2026-10-23T07:00:00.000Z');
    // Override con l'UID del master: UID legacy unico <UID>#<recurrence_key>, classificato.
    assert.equal(override.row.uid, 'roma-serie@test#20261023T070000Z');
    assert.ok(plan.degradations.some((d) => d.class === 'SANITIZED_UID' && d.recurrence_key === '20261023T070000Z'));
    assert.ok(!plan.degradations.some((d) => d.class === 'SEMANTIC_EXPANDED'));
    const from = '2026-10-01T00:00:00Z';
    const to = '2026-11-15T00:00:00Z';
    assert.deepEqual(legacyBusyFromRows(plan.rows.map((r) => r.row), from, to), indexBusyOf(inp.occurrences, from, to));
  });

  test('serie tipiche dei device e dell\'admin restano rappresentabili (una riga master, nessun degrado)', () => {
    const cases: Record<string, string[]> = {
      settimanale: ['DTSTART;TZID=Europe/Rome:20260810T090000', 'DTEND;TZID=Europe/Rome:20260810T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR'],
      fino_al: ['DTSTART;TZID=Europe/Rome:20261005T090000', 'DTEND;TZID=Europe/Rome:20261005T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20270329T065959Z'],
      quindicinale: ['DTSTART;TZID=Europe/Rome:20261005T180000', 'DTEND;TZID=Europe/Rome:20261005T190000', 'RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=30'],
      secondo_martedi: ['DTSTART;TZID=Europe/Rome:20261013T090000', 'DTEND;TZID=Europe/Rome:20261013T093000', 'RRULE:FREQ=MONTHLY;BYDAY=2TU'],
      compleanno: ['DTSTART;VALUE=DATE:20261225', 'DTEND;VALUE=DATE:20261226', 'RRULE:FREQ=YEARLY'],
      domenica_tutto_il_giorno: ['DTSTART;VALUE=DATE:20261018', 'DTEND;VALUE=DATE:20261019', 'RRULE:FREQ=WEEKLY;COUNT=10'],
      floating: ['DTSTART:20261005T090000', 'DTEND:20261005T100000', 'RRULE:FREQ=DAILY;COUNT=40'],
      notte_cambio_ora: ['DTSTART;TZID=Europe/Rome:20261020T233000', 'DTEND;TZID=Europe/Rome:20261021T003000', 'RRULE:FREQ=DAILY;COUNT=15'],
    };
    for (const [name, lines] of Object.entries(cases)) {
      const plan = projectObject(input(vcal(vevent([`UID:${name}@test`, 'SUMMARY:Serie', ...lines])), { href: `${name}.ics` }));
      assert.equal(plan.status, 'projected', `${name}: ${JSON.stringify(plan.degradations)}`);
      assert.equal(plan.rows.length, 1, name);
      assert.equal(plan.rows[0].role, 'master', name);
    }
    // Un orario che non esiste nel giorno del cambio d'ora: calendar-core e il legacy divergono → espansa.
    const gap = projectObject(input(vcal(vevent(['UID:buco@test', 'SUMMARY:Buco', 'DTSTART;TZID=Europe/Rome:20270321T023000', 'DTEND;TZID=Europe/Rome:20270321T033000', 'RRULE:FREQ=WEEKLY;COUNT=3']))));
    assert.deepEqual(gap.degradations.find((d) => d.class === 'SEMANTIC_EXPANDED')?.detail?.reasons, ['rule_mismatch']);
  });

  test('override con un UID legacy già esistente: lo riusa senza degradi', () => {
    const raw = vcal(
      vevent(['UID:migrata@test', 'SUMMARY:Serie', 'DTSTART;TZID=Europe/Rome:20261019T090000', 'DTEND;TZID=Europe/Rome:20261019T100000', 'RRULE:FREQ=DAILY;COUNT=5']),
      vevent(['UID:migrata@test', 'SUMMARY:Spostata', 'RECURRENCE-ID;TZID=Europe/Rome:20261020T090000', 'DTSTART;TZID=Europe/Rome:20261020T120000', 'DTEND;TZID=Europe/Rome:20261020T130000']),
    );
    const overrideId = '44444444-4444-4444-8444-444444444444';
    const plan = projectObject(input(raw, {
      ids: { master: { id: OBJ_ID, legacy_uid: 'legacy-master-uid' }, byRecurrenceKey: new Map([['20261020T070000Z', overrideId]]) },
      existingUids: new Map([[overrideId, 'legacy-override-uid'], [OBJ_ID, 'legacy-master-uid']]),
    }));
    assert.equal(plan.status, 'projected', JSON.stringify(plan.degradations));
    assert.equal(plan.rows.find((r) => r.role === 'master')?.row.uid, 'legacy-master-uid');
    assert.equal(plan.rows.find((r) => r.role === 'override')?.row.uid, 'legacy-override-uid');
  });

  test('serie in UTC che attraversa il cambio d\'ora → espansa (il legacy ripete l\'ora di Roma)', () => {
    const raw = vcal(vevent(['UID:utc-serie@test', 'SUMMARY:UTC', 'DTSTART:20261019T080000Z', 'DTEND:20261019T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=4']));
    const inp = input(raw);
    const plan = projectObject(inp);
    assert.deepEqual(plan.degradations.find((d) => d.class === 'SEMANTIC_EXPANDED')?.detail?.reasons, ['rule_mismatch']);
    assert.ok(plan.rows.every((r) => r.row.start_time.endsWith('T08:00:00.000Z')));
    const from = '2026-10-01T00:00:00Z';
    const to = '2026-12-01T00:00:00Z';
    assert.deepEqual(legacyBusyFromRows(plan.rows.map((r) => r.row), from, to), indexBusyOf(inp.occurrences, from, to));
  });

  test('UID dell\'invito duplicato in un\'altra collezione → <UID>@<collezione>, invitati persi classificati', () => {
    const raw = vcal(vevent([
      'UID:invito-123@example.com', 'SUMMARY:Invito', 'ORGANIZER;CN=Org:mailto:org@example.com',
      'ATTENDEE;CN=Io:mailto:io@example.com', 'ATTENDEE;CN=Altro:mailto:altro@example.com',
      'DTSTART:20261110T100000Z', 'DTEND:20261110T110000Z',
    ]));
    const plan = projectObject(input(raw, { usedUids: new Set(['invito-123@example.com']) }));
    assert.equal(plan.rows.length, 1);
    assert.equal(plan.rows[0].row.uid, 'invito-123@example.com@lavoro');
    assert.deepEqual(classes(plan), ['REPR_LOSS_ATTENDEE', 'SANITIZED_UID']);
    const att = plan.degradations.find((d) => d.class === 'REPR_LOSS_ATTENDEE');
    assert.deepEqual(att?.detail, { attendees: 2, organizer: true });
    assert.ok(!JSON.stringify(plan.degradations).includes('@example.com'), 'nessun indirizzo nei degradi');
    // Anche la forma sanificata occupata: REVERSE_FAILED, mai un'eccezione.
    const failed = projectObject(input(raw, { usedUids: new Set(['invito-123@example.com', 'invito-123@example.com@lavoro']) }));
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error?.code, 'REVERSE_FAILED');
  });

  test('durata zero, SUMMARY assente, TRANSP e STATUS non standard → righe sanificate e classificate', () => {
    const zero = projectObject(input(vcal(vevent(['UID:zero@test', 'SUMMARY:Promemoria', 'DTSTART:20261110T100000Z', 'DTEND:20261110T100000Z']))));
    assert.equal(zero.rows[0].row.end_time, '2026-11-10T10:01:00.000Z');
    // In Radicale un timed a durata nulla non blocca (span vuoto): la riga allungata non deve bloccare nel legacy.
    assert.equal(zero.rows[0].row.status, 'tentative');
    assert.deepEqual(classes(zero), ['SANITIZED_DURATION']);
    assert.deepEqual(zero.degradations[0].detail, { rows: 1, non_blocking: 1 });

    const untitled = projectObject(input(vcal(vevent(['UID:senza-titolo@test', 'DTSTART:20261110T100000Z', 'DTEND:20261110T110000Z']))));
    assert.equal(untitled.rows[0].row.summary, '(senza titolo)');
    assert.deepEqual(classes(untitled), ['SANITIZED_SUMMARY']);

    const transparent = projectObject(input(vcal(vevent(['UID:libero@test', 'SUMMARY:Libero', 'TRANSP:TRANSPARENT', 'DTSTART:20261110T100000Z', 'DTEND:20261110T110000Z']))));
    assert.equal(transparent.rows[0].row.status, 'tentative');
    assert.deepEqual(classes(transparent), ['SEMANTIC_TRANSP']);

    const odd = projectObject(input(vcal(vevent(['UID:strano@test', 'SUMMARY:Strano', 'STATUS:NEEDS-ACTION', 'DTSTART:20261110T100000Z', 'DTEND:20261110T110000Z']))));
    assert.equal(odd.rows[0].row.status, 'tentative');
    assert.deepEqual(classes(odd), ['SANITIZED_STATUS']);
    for (const p of [zero, untitled, transparent, odd]) assert.equal(p.rows[0].row.caldes_derived, false);
  });

  test('VALARM, X-* e proprietà senza colonna → rappresentazione persa (X-CALDES-* escluse); TZID di un singolo', () => {
    const raw = vcal([
      'BEGIN:VEVENT', 'DTSTAMP:20261001T000000Z', 'UID:allarme@test', 'SUMMARY:Con allarme',
      'DTSTART;TZID=America/New_York:20261110T100000', 'DTEND;TZID=America/New_York:20261110T110000',
      'CATEGORIES:Lavoro', 'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC', 'X-CALDES-SOURCE:mcp',
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Promemoria', 'TRIGGER:-PT15M', 'END:VALARM',
      'END:VEVENT',
    ].join('\r\n'));
    const plan = projectObject(input(raw));
    assert.equal(plan.rows.length, 1);
    assert.equal(plan.rows[0].row.start_time, '2026-11-10T15:00:00.000Z');
    assert.equal(plan.rows[0].row.source, 'mcp');
    assert.deepEqual(classes(plan), ['REPR_LOSS_PROPERTY', 'REPR_LOSS_VALARM']);
    const props = plan.degradations.find((d) => d.class === 'REPR_LOSS_PROPERTY')?.detail?.properties as string[];
    assert.deepEqual(props, ['CATEGORIES', 'TZID', 'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR']);
  });

  test('override orfano (risorsa con soli override) → riga derivata con il testo dell\'override', () => {
    const raw = vcal(vevent([
      'UID:solo-override@test', 'SUMMARY:Istanza invitata', 'RECURRENCE-ID:20261112T100000Z',
      'DTSTART:20261112T100000Z', 'DTEND:20261112T110000Z',
    ]));
    const plan = projectObject(input(raw));
    assert.equal(plan.rows.length, 1);
    assert.equal(plan.rows[0].role, 'derived');
    assert.equal(plan.rows[0].row.summary, 'Istanza invitata');
    assert.deepEqual(plan.degradations.find((d) => d.class === 'SEMANTIC_EXPANDED')?.detail?.reasons, ['orphan_override']);
  });

  test('testo illeggibile: righe derivate dal blocco conservativo dell\'indice; senza occorrenze REVERSE_FAILED', () => {
    const occ: ReverseOccurrenceInput[] = [{ recurrence_key: 'conservative', start_utc: '2026-11-10T10:00:00.000Z', end_utc: '2026-11-10T12:00:00.000Z', all_day: false, status: 'confirmed', transp: 'OPAQUE', blocks: true }];
    const plan = projectObject(input('BEGIN:VCALENDAR\r\nnon valido', { occurrences: occ, href: 'rotto.ics' }));
    assert.equal(plan.rows.length, 1);
    assert.equal(plan.rows[0].row.summary, '(senza titolo)');
    assert.equal(plan.rows[0].row.status, 'confirmed');
    assert.equal(plan.rows[0].row.uid, 'rotto.ics#conservative');
    const none = projectObject(input('BEGIN:VCALENDAR\r\nnon valido', { occurrences: [], href: 'rotto.ics' }));
    assert.equal(none.status, 'failed');
    assert.equal(none.error?.code, 'REVERSE_FAILED');
  });

  test('determinismo: stesso input → stesso piano e stesso hash', () => {
    const raw = vcal(vevent(['UID:det@test', 'SUMMARY:Det', 'DTSTART;TZID=Europe/Rome:20261001T100000', 'DTEND;TZID=Europe/Rome:20261001T110000', 'RRULE:FREQ=WEEKLY;COUNT=3', 'RDATE;TZID=Europe/Rome:20261014T150000']));
    const a = projectObject(input(raw));
    const b = projectObject(input(raw));
    assert.deepEqual(a, b);
    assert.equal(reversePlanHash({ objects: [a] }), reversePlanHash({ objects: [b] }));
    assert.notEqual(reversePlanHash({ objects: [a] }), reversePlanHash({ objects: [{ ...a, rows: a.rows.slice(1) }] }));
  });

  test('reverseProjectionActive: solo mode radicale con la finestra aperta', () => {
    const now = new Date('2026-11-01T00:00:00Z');
    assert.equal(reverseProjectionActive({ mode: 'radicale', rollback_until: new Date('2026-11-02T00:00:00Z') }, now), true);
    assert.equal(reverseProjectionActive({ mode: 'radicale', rollback_until: new Date('2026-10-31T00:00:00Z') }, now), false);
    assert.equal(reverseProjectionActive({ mode: 'radicale', rollback_until: null }, now), false);
    assert.equal(reverseProjectionActive({ mode: 'finalized', rollback_until: new Date('2026-11-02T00:00:00Z') }, now), false);
    assert.equal(reverseProjectionActive({ mode: 'postgres', rollback_until: new Date('2026-11-02T00:00:00Z') }, now), false);
  });
});

// ─── Database ───────────────────────────────

let etagSeq = 0;

async function indexItems(calendarId: string, items: Array<{ href: string; raw: string | null }>, deletes: string[] = [], full = false): Promise<void> {
  const context = await loadCollectionContext(sql, calendarId);
  await applyCollectionChanges(
    {
      context,
      upserts: items.map((i) => ({ href: i.href, etag: `"rev-${++etagSeq}"`, raw: i.raw })),
      deletes,
      radicaleSkipped: [],
      pending404: [],
      full,
      horizon: { ...H },
      actor: 'test',
    },
    { syncedAt: new Date() },
  );
}

async function objectIdOf(calendarId: string, href: string): Promise<string> {
  const [row] = await sql<Array<{ id: string }>>`SELECT id::text AS id FROM cal_objects WHERE calendar_id = ${calendarId} AND href = ${href}`;
  assert.ok(row, `oggetto ${href} indicizzato`);
  return row.id;
}

async function rowsOf(objectId: string) {
  return sql<Array<{ id: string; uid: string; summary: string; status: string; start_time: Date; end_time: Date; rrule: string | null; caldes_derived: boolean; recurrence_master_id: string | null; source: string; source_id: string | null; description: string | null }>>`
    SELECT id::text AS id, uid, summary, status, start_time, end_time, rrule, caldes_derived, recurrence_master_id::text AS recurrence_master_id, source, source_id, description
    FROM calendar_events WHERE caldes_object_id = ${objectId}::uuid ORDER BY start_time, id
  `;
}

async function stateOf(objectId: string) {
  const [row] = await sql<Array<{ status: string; rows: unknown; degradations: Array<{ class: string; recurrence_key?: string | null; detail?: Record<string, unknown> }>; error_code: string | null; horizon_until: Date | null }>>`
    SELECT status, rows, degradations, error_code, horizon_until FROM cal_migration_reverse_state WHERE object_id = ${objectId}::uuid
  `;
  return row ?? null;
}

/** Errori REVERSE_FAILED registrati (messaggio delle asserzioni). */
async function failures(): Promise<string> {
  const rows = await sql<Array<{ href: string; error: string | null; degradations: unknown }>>`
    SELECT href, error, degradations FROM cal_migration_reverse_state WHERE status = 'failed' ORDER BY href
  `;
  return JSON.stringify(rows);
}

async function blockingCalendar(key: string, timezone = 'Europe/Rome'): Promise<Calendar> {
  const cal = await fx.calendar({ key, blocks_availability: true, timezone });
  // Prima sync (collezione vuota): fissa l'orizzonte materializzato.
  await indexItems(cal.id, [], [], true);
  return cal;
}

describe('computeReversePlan e applyReversePlan sul database', () => {
  test('RDATE e serie New York: dopo la proiezione il busy legacy coincide con quello dell\'indice', async () => {
    const cal = await blockingCalendar('rev-busy');
    await indexItems(cal.id, [
      { href: 'rdate.ics', raw: vcal(vevent(['UID:db-rdate@test', 'SUMMARY:RDATE', 'DTSTART;TZID=Europe/Rome:20261001T100000', 'DTEND;TZID=Europe/Rome:20261001T110000', 'RRULE:FREQ=WEEKLY;COUNT=6', 'RDATE;TZID=Europe/Rome:20261014T150000'])) },
      { href: 'ny.ics', raw: vcal(vevent(['UID:db-ny@test', 'SUMMARY:NY', 'DTSTART;TZID=America/New_York:20261005T100000', 'DTEND;TZID=America/New_York:20261005T110000', 'RRULE:FREQ=WEEKLY;COUNT=10'])) },
      { href: 'roma.ics', raw: vcal(vevent(['UID:db-roma@test', 'SUMMARY:Roma', 'DTSTART;TZID=Europe/Rome:20261020T080000', 'DTEND;TZID=Europe/Rome:20261020T083000', 'RRULE:FREQ=DAILY;COUNT=12'])) },
    ]);
    await setRadicale();
    const summary = await runReverseProjection({ actor: 'admin:test-reverse', calendarIds: [cal.id] });
    assert.equal(summary.failed, 0, await failures());
    assert.equal(summary.objects, 3);
    const from = '2026-09-28T00:00:00.000Z';
    const to = '2026-12-31T00:00:00.000Z';
    const index = await indexBusyRanges(sql, from, to);
    const legacy = await legacyBusyRanges(from, to);
    assert.ok(index.length >= 28, `busy dell'indice: ${index.length}`);
    assert.deepEqual(legacy, index);
    const roma = await rowsOf(await objectIdOf(cal.id, 'roma.ics'));
    assert.equal(roma.length, 1, 'serie di Roma rappresentabile: una riga master');
    assert.equal(roma[0].rrule, 'FREQ=DAILY;COUNT=12');
    const rdate = await stateOf(await objectIdOf(cal.id, 'rdate.ics'));
    assert.equal(rdate?.status, 'degraded');
    assert.ok(rdate?.degradations.some((d) => d.class === 'SEMANTIC_EXPANDED'));
    assert.ok(rdate?.horizon_until);
  });

  test('F4R-ROLL-06: REVERSE_FAILED nati nell\'apply compaiono nell\'anteprima (reverse_apply_failed) e busy_identical diventa null; collezioni in hold contate', async () => {
    const cal = await blockingCalendar('rev-apply-failed');
    await indexItems(cal.id, [{ href: 'rotta.ics', raw: vcal(vevent(['UID:roll06@test', 'SUMMARY:Rotta', 'DTSTART:20310310T100000Z', 'DTEND:20310310T110000Z'])) }]);
    await setRadicale();
    const first = await runReverseProjection({ actor: 'admin:test-reverse', calendarIds: [cal.id] });
    assert.equal(first.failed, 0, await failures());
    const objectId = await objectIdOf(cal.id, 'rotta.ics');
    const clean = await computeRollbackPreview(sql, { now: new Date() });
    assert.equal(clean.summary.reverse_apply_failed, 0);
    const baseFailed = clean.summary.reverse_failed;

    // Errore dell'apply registrato solo nello stato: il piano puro continua a dare la risorsa per proiettabile.
    await sql`
      UPDATE cal_migration_reverse_state SET status = 'failed', error_code = 'REVERSE_FAILED', error = 'vincolo violato', attempts = 1
      WHERE object_id = ${objectId}::uuid
    `;
    await sql`UPDATE cal_collection_state SET health = 'hold', hold_since = now(), hold_reason = 'mass-delete' WHERE calendar_id = ${cal.id}::uuid`;
    const { summary, applyFailed } = await computeRollbackPreview(sql, { now: new Date() });
    assert.equal(summary.reverse_apply_failed, 1);
    assert.equal(summary.reverse_failed, baseFailed + 1, 'sommato a reverse_failed');
    assert.equal(summary.busy_identical, null, 'il presupposto del confronto non vale più');
    assert.ok(summary.held_collections >= 1);
    assert.deepEqual(applyFailed.map((f) => ({ id: f.object_id, code: f.error_code })), [{ id: objectId, code: 'REVERSE_FAILED' }]);
    await sql`UPDATE cal_collection_state SET health = 'healthy', hold_since = NULL, hold_reason = NULL WHERE calendar_id = ${cal.id}::uuid`;
    await sql`DELETE FROM cal_migration_reverse_state WHERE object_id = ${objectId}::uuid`;
  });

  test('F4R-ROLL-03: il busy dell\'anteprima esclude le iscrizioni (righe ics_pull legacy e collezioni subscription): busy_identical non diventa rumore', async () => {
    const parent = await blockingCalendar('rev-sub-parent');
    const sidecar = await fx.calendar({ key: 'rev-sub-sidecar', blocks_availability: true });
    await sql`UPDATE calendars SET role = 'subscription', parent_calendar_id = ${parent.id} WHERE id = ${sidecar.id}`;
    const [sub] = await sql<Array<{ id: string }>>`
      INSERT INTO calendar_subscriptions (calendar_id, collection_calendar_id, name, ics_url, blocks_availability)
      VALUES (${parent.id}::uuid, ${sidecar.id}::uuid, ${fx.name('iscrizione')}, 'https://example.invalid/roll03.ics', true)
      RETURNING id
    `;
    // Riga ics_pull legacy congelata al cutover e occorrenza diversa nel feed riscaricato nell'indice.
    const frozen = await fx.event({ calendar: parent, summary: 'Feed congelato', start_time: '2031-03-02T09:00:00Z', end_time: '2031-03-02T10:00:00Z' });
    await sql`UPDATE calendar_events SET source = 'ics_pull', subscription_id = ${sub.id}::uuid WHERE id = ${frozen.id}::uuid`;
    await indexItems(sidecar.id, [], [], true);
    await indexItems(sidecar.id, [{ href: 'nuovo.ics', raw: vcal(vevent(['UID:roll03-feed@test', 'SUMMARY:Feed nuovo', 'DTSTART:20310303T140000Z', 'DTEND:20310303T150000Z'])) }]);
    await setRadicale();
    const from = '2031-03-01T00:00:00Z';
    const to = '2031-03-06T00:00:00Z';
    const legacy = await legacyBusyAfterPlan(sql, { objects: [] }, from, to);
    assert.deepEqual(legacy, [], 'le righe ics_pull non entrano nel busy legacy dell\'anteprima');
    assert.deepEqual(await indexBusyRanges(sql, from, to, { excludeSubscriptions: true }), [], 'collezioni subscription escluse dall\'indice');
    assert.equal((await indexBusyRanges(sql, from, to)).length, 1, 'senza l\'opzione il busy dell\'indice comprende la collezione dell\'iscrizione');
  });

  test('migrati: stessi id e UID legacy; override annullati legacy riassorbiti dalle EXDATE; nessuna riscrittura alla seconda passata', async () => {
    const cal = await blockingCalendar('rev-migrati');
    const series = await fx.series({
      calendar: cal,
      summary: 'Serie migrata',
      rrule: 'FREQ=DAILY;COUNT=6',
      start_time: romeIso('2026-11-02', '09:00'),
      end_time: romeIso('2026-11-02', '10:00'),
      overrides: [
        { originalStart: romeIso('2026-11-03', '09:00'), start: romeIso('2026-11-03', '11:00'), end: romeIso('2026-11-03', '12:00'), summary: 'Spostata' },
        { originalStart: romeIso('2026-11-04', '09:00'), status: 'cancelled' },
      ],
    });
    const [moved, cancelledOv] = series.overrides;
    const single = await fx.event({ calendar: cal, summary: 'Singolo migrato', start_time: romeIso('2026-11-10', '15:00'), end_time: romeIso('2026-11-10', '16:00') });
    const frozen = await fx.event({ calendar: cal, summary: 'Mai migrato', start_time: romeIso('2026-11-11', '15:00'), end_time: romeIso('2026-11-11', '16:00') });
    // Oggetti come li scrive la migrazione (F3): UID legacy, X-CALDES-LEGACY-ID, override annullato come EXDATE.
    const masterHref = `${series.master.uid}.ics`;
    await reserveObjectId(sql, { calendarId: cal.id, href: masterHref, id: series.master.id, uid: series.master.uid, legacyEventId: series.master.id, legacyUid: series.master.uid });
    await reserveObjectId(sql, { calendarId: cal.id, href: masterHref, recurrenceKey: '20261103T080000Z', id: moved.id, uid: series.master.uid, legacyEventId: moved.id });
    await reserveObjectId(sql, { calendarId: cal.id, href: `${single.uid}.ics`, id: single.id, uid: single.uid, legacyEventId: single.id, legacyUid: single.uid });
    await indexItems(cal.id, [
      {
        href: masterHref,
        raw: vcal(
          vevent([`UID:${series.master.uid}`, `SUMMARY:${series.master.summary}`, `X-CALDES-LEGACY-ID:${series.master.id}`, 'DTSTART;TZID=Europe/Rome:20261102T090000', 'DTEND;TZID=Europe/Rome:20261102T100000', 'RRULE:FREQ=DAILY;COUNT=6', 'EXDATE;TZID=Europe/Rome:20261104T090000', 'STATUS:CONFIRMED']),
          vevent([`UID:${series.master.uid}`, `SUMMARY:${moved.summary}`, `X-CALDES-LEGACY-ID:${moved.id}`, 'RECURRENCE-ID;TZID=Europe/Rome:20261103T090000', 'DTSTART;TZID=Europe/Rome:20261103T110000', 'DTEND;TZID=Europe/Rome:20261103T120000', 'STATUS:CONFIRMED']),
        ),
      },
      { href: `${single.uid}.ics`, raw: vcal(vevent([`UID:${single.uid}`, `SUMMARY:${single.summary}`, `X-CALDES-LEGACY-ID:${single.id}`, 'DTSTART;TZID=Europe/Rome:20261110T150000', 'DTEND;TZID=Europe/Rome:20261110T160000'])) },
    ]);
    const legacyBefore = await legacyBusyRanges('2026-11-01T00:00:00Z', '2026-11-12T00:00:00Z');
    await setRadicale();
    const first = await runReverseProjection({ actor: 'admin:test-reverse', calendarIds: [cal.id] });
    assert.equal(first.failed, 0);
    const masterRows = await rowsOf(series.master.id);
    assert.deepEqual(masterRows.map((r) => r.id).sort(), [series.master.id, moved.id].sort(), 'stessi id legacy, posseduti');
    assert.equal(masterRows.find((r) => r.id === series.master.id)?.uid, series.master.uid);
    assert.equal(masterRows.find((r) => r.id === moved.id)?.uid, moved.uid, 'UID legacy dell\'override riusato');
    const [gone] = await sql`SELECT id FROM calendar_events WHERE id = ${cancelledOv.id}::uuid`;
    assert.equal(gone, undefined, 'override annullato legacy sostituito dall\'EXDATE');
    const [still] = await sql<Array<{ caldes_object_id: string | null; summary: string }>>`SELECT caldes_object_id, summary FROM calendar_events WHERE id = ${frozen.id}::uuid`;
    assert.equal(still.caldes_object_id, null, 'riga mai migrata non toccata');
    assert.equal((await rowsOf(single.id))[0]?.uid, single.uid);
    assert.equal((await stateOf(series.master.id))?.status, 'projected');
    assert.deepEqual(await legacyBusyRanges('2026-11-01T00:00:00Z', '2026-11-12T00:00:00Z'), legacyBefore, 'busy legacy invariato');

    // Seconda passata: nessuna scrittura, hash stabile.
    const plan = await computeReversePlan(sql, { calendarIds: [cal.id], now: new Date() });
    assert.ok(plan.objects.every((o) => o.unchanged), JSON.stringify(plan.objects.filter((o) => !o.unchanged).map((o) => o.href)));
    const again = await applyReversePlan(sql, plan, { actor: 'admin:test-reverse' });
    assert.deepEqual(again.rows, { inserted: 0, updated: 0, deleted: 0 });
    assert.equal(again.unchanged, plan.objects.length);
    const planAfter = await computeReversePlan(sql, { calendarIds: [cal.id], now: new Date() });
    assert.equal(planAfter.hash, plan.hash);
  });

  test('anteprima prima dell\'apply e passata finale dopo: stesso hash; busy previsto senza scrivere', async () => {
    const cal = await blockingCalendar('rev-hash');
    await indexItems(cal.id, [
      { href: 'a.ics', raw: vcal(vevent(['UID:hash-a@test', 'SUMMARY:A', 'DTSTART;TZID=Europe/Rome:20261201T100000', 'DTEND;TZID=Europe/Rome:20261201T110000', 'RDATE;TZID=Europe/Rome:20261203T100000'])) },
      { href: 'b.ics', raw: vcal(vevent(['UID:hash-b@test', 'SUMMARY:B', 'DTSTART:20261202T100000Z', 'DTEND:20261202T110000Z'])) },
    ]);
    await setRadicale();
    const preview = await computeReversePlan(sql, { calendarIds: [cal.id], now: new Date() });
    const predicted = await legacyBusyAfterPlan(sql, preview, '2026-11-30T00:00:00Z', '2026-12-05T00:00:00Z');
    assert.deepEqual(predicted, await indexBusyRanges(sql, '2026-11-30T00:00:00Z', '2026-12-05T00:00:00Z'));
    await applyReversePlan(sql, preview, { actor: 'admin:test-reverse' });
    const final = await computeReversePlan(sql, { calendarIds: [cal.id], now: new Date() });
    assert.equal(final.hash, preview.hash);
    assert.deepEqual(await legacyBusyRanges('2026-11-30T00:00:00Z', '2026-12-05T00:00:00Z'), predicted);
  });

  test('risorsa sparita: cancellate solo le righe possedute; cambio da rappresentabile a espansa', async () => {
    const cal = await blockingCalendar('rev-delete');
    await indexItems(cal.id, [
      { href: 'x.ics', raw: vcal(vevent(['UID:del-x@test', 'SUMMARY:X', 'DTSTART;TZID=Europe/Rome:20261201T100000', 'DTEND;TZID=Europe/Rome:20261201T110000', 'RRULE:FREQ=DAILY;COUNT=3'])) },
    ]);
    const frozen = await fx.event({ calendar: cal, summary: 'Legacy congelato', start_time: romeIso('2026-12-01', '15:00'), end_time: romeIso('2026-12-01', '16:00') });
    await setRadicale();
    await runReverseProjection({ actor: 'admin:test-reverse', calendarIds: [cal.id] });
    const id = await objectIdOf(cal.id, 'x.ics');
    assert.equal((await rowsOf(id)).length, 1);
    // Il device aggiunge una RDATE: la riga master lascia il posto alle derivate.
    await indexItems(cal.id, [
      { href: 'x.ics', raw: vcal(vevent(['UID:del-x@test', 'SUMMARY:X', 'DTSTART;TZID=Europe/Rome:20261201T100000', 'DTEND;TZID=Europe/Rome:20261201T110000', 'RRULE:FREQ=DAILY;COUNT=3', 'RDATE;TZID=Europe/Rome:20261210T100000'])) },
    ]);
    const second = await runReverseProjection({ actor: 'admin:test-reverse', calendarIds: [cal.id] });
    assert.equal(second.rows.deleted, 1);
    const derived = await rowsOf(id);
    assert.equal(derived.length, 4);
    assert.ok(derived.every((r) => r.caldes_derived));
    // Il device la cancella: righe possedute cancellate, la riga legacy congelata resta.
    await removeIndexedObjects(cal.id, ['x.ics'], { actor: 'test' });
    const third = await runReverseProjection({ actor: 'admin:test-reverse', calendarIds: [cal.id] });
    assert.equal(third.rows.deleted, 4);
    assert.equal((await rowsOf(id)).length, 0);
    assert.equal((await stateOf(id))?.status, 'removed');
    const [kept] = await sql`SELECT id FROM calendar_events WHERE id = ${frozen.id}::uuid`;
    assert.ok(kept, 'riga legacy mai posseduta intatta');
  });

  test('MOVE fra collezioni (stesso id): la passata della collezione di partenza non cancella, quella di arrivo sposta la riga', async () => {
    const a = await blockingCalendar('rev-move-a');
    const b = await blockingCalendar('rev-move-b');
    const raw = vcal(vevent(['UID:move@test', 'SUMMARY:Spostato', 'DTSTART:20261206T100000Z', 'DTEND:20261206T110000Z']));
    await indexItems(a.id, [{ href: 'move.ics', raw }]);
    await setRadicale();
    await runReverseProjection({ actor: 'admin:test-reverse', calendarIds: [a.id] });
    const id = await objectIdOf(a.id, 'move.ics');
    await removeIndexedObjects(a.id, ['move.ics'], { actor: 'test' });
    await indexItems(b.id, [{ href: 'move.ics', raw }]);
    assert.equal(await objectIdOf(b.id, 'move.ics'), id, 'MOVE: stesso id');
    const first = await runReverseProjection({ actor: 'admin:test-reverse', calendarIds: [a.id] });
    assert.equal(first.rows.deleted, 0);
    assert.equal((await rowsOf(id)).length, 1);
    await runReverseProjection({ actor: 'admin:test-reverse', calendarIds: [b.id] });
    const [row] = await sql<Array<{ calendar_id: string }>>`SELECT calendar_id::text AS calendar_id FROM calendar_events WHERE caldes_object_id = ${id}::uuid`;
    assert.equal(row.calendar_id, b.id);
    const state = await sql<Array<{ calendar_id: string; status: string }>>`SELECT calendar_id::text AS calendar_id, status FROM cal_migration_reverse_state WHERE object_id = ${id}::uuid`;
    assert.deepEqual([...state], [{ calendar_id: b.id, status: 'projected' }]);
  });

  test('guardia 166: in mode radicale una scrittura diretta fallisce, il proiettore scrive con il GUC', async () => {
    const cal = await blockingCalendar('rev-guard');
    const legacy = await fx.event({ calendar: cal, summary: 'Legacy', start_time: romeIso('2026-12-02', '09:00'), end_time: romeIso('2026-12-02', '10:00') });
    await indexItems(cal.id, [{ href: 'g.ics', raw: vcal(vevent(['UID:guard@test', 'SUMMARY:G', 'DTSTART:20261202T120000Z', 'DTEND:20261202T130000Z'])) }]);
    await setRadicale();
    await assert.rejects(sql`UPDATE calendar_events SET summary = 'x' WHERE id = ${legacy.id}::uuid`, (err: unknown) => isCalendarEventsGuardError(err));
    const res = await runReverseProjection({ actor: 'admin:test-reverse', calendarIds: [cal.id] });
    assert.equal(res.failed, 0);
    assert.equal(res.rows.inserted, 1);
  });
});

// ─── Prenotazioni ───────────────────────────────

async function bookingsCalendarId(): Promise<string> {
  const [row] = await sql<Array<{ id: string; horizon_end: Date | null }>>`
    SELECT c.id::text AS id, st.horizon_end FROM calendars c LEFT JOIN cal_collection_state st ON st.calendar_id = c.id
    WHERE c.role = 'bookings' ORDER BY c.created_at LIMIT 1
  `;
  if (!row.horizon_end) await indexItems(row.id, [], [], true);
  return row.id;
}

/** Risorsa della proiezione come la scrive la migrazione (X-CALDES-LEGACY-ID della riga legacy). */
function projectionIcs(booking: { uid: string; attendee_name: string; attendee_phone: string | null; start_time: string; end_time: string; location_value: string | null; created_at: string }, legacyId: string | null): string {
  const raw = buildBookingProjectionIcs({ booking, eventTitle: 'Consulenza', meetingUrl: null, now: new Date('2026-10-01T00:00:00Z') });
  return legacyId ? raw.replace('END:VEVENT', `X-CALDES-LEGACY-ID:${legacyId}\r\nEND:VEVENT`) : raw;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tipo tx di postgres-js (stesso pattern di src/)
type Tx = any;

describe('proiezioni delle prenotazioni', () => {
  test('F4R-ROLL-04: una cancellazione GDPR fra il piano e l\'apply non viene annullata dall\'upsert della proiezione; la INSERT scrive il testo del piano', async () => {
    const bookingsId = await bookingsCalendarId();
    await sql`UPDATE calendars SET blocks_availability = true WHERE id = ${bookingsId}::uuid`;
    const schedule = await fx.schedule();
    const et = await fx.eventType({ key: 'rev-gdpr-race', durationMinutes: 30, schedule });
    const { booking, projection } = await fx.booking({ eventType: et, start: romeIso('2026-11-23', '10:00') });
    assert.ok(projection);
    const href = `booking-${booking.uid}.ics`;
    await reserveObjectId(sql, { calendarId: bookingsId, href, id: projection.id, uid: `${booking.uid}@caldes.it`, legacyEventId: projection.id, legacyUid: projection.uid });
    await indexItems(bookingsId, [{ href, raw: projectionIcs(booking, projection.id) }]);
    await setRadicale();
    await runReverseProjection({ actor: 'admin:test-reverse', calendarIds: [bookingsId] });

    // La prenotazione viene annullata nella finestra: la riga segue calendar_bookings (il piano cambia lo stato e porta il testo legacy).
    await sql`UPDATE calendar_bookings SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'attendee' WHERE uid = ${booking.uid}`;
    const plan = await computeReversePlan(sql, { calendarIds: [bookingsId], now: new Date() });
    const planned = plan.objects.flatMap((o) => o.rows).find((r) => r.id === projection.id);
    assert.ok(planned && planned.role === 'projection', 'riga di proiezione nel piano');
    assert.ok(plan.objects.some((o) => !o.unchanged), 'il piano cambia qualcosa');

    // Cancellazione GDPR committata dopo il piano (scrittore privilegiato: GUC della transazione).
    await sql.begin(async (tx: Tx) => {
      await tx`SELECT set_config('caldes.reverse_sync', txid_current()::text, true)`;
      await tx`UPDATE calendar_events SET summary = 'Prenotazione [rimosso]', description = NULL, location = NULL, url = NULL WHERE id = ${projection.id}::uuid`;
    });
    await applyReversePlan(sql, plan, { actor: 'admin:test-reverse' });
    let [row] = await sql<Array<{ summary: string; description: string | null; status: string }>>`SELECT summary, description, status FROM calendar_events WHERE id = ${projection.id}::uuid`;
    assert.equal(row.summary, 'Prenotazione [rimosso]', 'il testo redatto resta tale');
    assert.equal(row.description, null);
    assert.equal(row.status, 'cancelled', 'le altre colonne seguono il piano');

    // Riga mancante: la INSERT è completa e scrive il testo del piano.
    await sql.begin(async (tx: Tx) => {
      await tx`SELECT set_config('caldes.reverse_sync', txid_current()::text, true)`;
      await tx`DELETE FROM calendar_events WHERE id = ${projection.id}::uuid`;
    });
    await applyReversePlan(sql, plan, { actor: 'admin:test-reverse' });
    [row] = await sql`SELECT summary, description, status FROM calendar_events WHERE id = ${projection.id}::uuid`;
    assert.ok(row, 'riga reinserita');
    assert.equal(row.summary, planned.row.summary, 'testo del piano scritto dalla INSERT');
  });

  test('prenotazione pre-cutover annullata nella finestra → riga legacy cancelled e slot libero dopo il rollback', async () => {
    const bookingsId = await bookingsCalendarId();
    await sql`UPDATE calendars SET blocks_availability = true WHERE id = ${bookingsId}::uuid`;
    const schedule = await fx.schedule();
    const et = await fx.eventType({ key: 'rev-annullata', durationMinutes: 30, schedule });
    const day = '2026-11-17';
    const { booking, projection } = await fx.booking({ eventType: et, start: romeIso(day, '10:00') });
    assert.ok(projection);
    const href = `booking-${booking.uid}.ics`;
    await reserveObjectId(sql, { calendarId: bookingsId, href, id: projection.id, uid: `${booking.uid}@caldes.it`, legacyEventId: projection.id, legacyUid: projection.uid });
    await indexItems(bookingsId, [{ href, raw: projectionIcs(booking, projection.id) }]);

    await setRadicale();
    await runReverseProjection({ actor: 'admin:test-reverse', calendarIds: [bookingsId] });
    let rows = await rowsOf(projection.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, projection.id);
    assert.equal(rows[0].status, 'confirmed');
    assert.equal(rows[0].uid, projection.uid, 'UID legacy della proiezione invariato');
    assert.equal(rows[0].description, projection.description, 'testo della riga legacy invariato (mai quello del device)');

    // Annullamento nella finestra: prima ancora che il job tolga la risorsa, la riga segue calendar_bookings.
    await sql`UPDATE calendar_bookings SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'attendee' WHERE uid = ${booking.uid}`;
    await runReverseProjection({ actor: 'admin:test-reverse', calendarIds: [bookingsId] });
    rows = await rowsOf(projection.id);
    assert.equal(rows[0].status, 'cancelled');
    // Il job project_booking toglie la risorsa: la riga resta (id valido) e annullata.
    await removeIndexedObjects(bookingsId, [href], { actor: 'test' });
    await runReverseProjection({ actor: 'admin:test-reverse', calendarIds: [bookingsId] });
    rows = await rowsOf(projection.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'cancelled');
    assert.equal((await stateOf(projection.id))?.status, 'removed');

    // Ritorno a postgres: slot di nuovo libero.
    await setPostgres();
    const busy = await legacyBusyRanges(romeIso(day, '00:00'), romeIso('2026-11-18', '00:00'));
    assert.ok(!busy.some((r) => r.start === new Date(romeIso(day, '10:00')).toISOString()), JSON.stringify(busy));
    const slots = await computeAvailableSlots({ eventTypeIdOrSlug: et.id, fromDateLocal: day, toDateLocal: day });
    assert.ok(slots?.slots.some((s) => new Date(s.start).toISOString() === new Date(romeIso(day, '10:00')).toISOString()), 'slot delle 10:00 libero');
  });

  test('prenotazione annullata a cavallo del freeze (risorsa tolta dal delta, mai proiettata) → riga cancelled', async () => {
    const bookingsId = await bookingsCalendarId();
    const schedule = await fx.schedule();
    const et = await fx.eventType({ key: 'rev-delta', durationMinutes: 30, schedule });
    const { booking, projection } = await fx.booking({ eventType: et, start: romeIso('2026-11-18', '11:00') });
    assert.ok(projection);
    const href = `booking-${booking.uid}.ics`;
    await reserveObjectId(sql, { calendarId: bookingsId, href, id: projection.id, uid: `${booking.uid}@caldes.it`, legacyEventId: projection.id, legacyUid: projection.uid });
    await indexItems(bookingsId, [{ href, raw: projectionIcs(booking, projection.id) }]);
    await sql`UPDATE calendar_bookings SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'admin' WHERE uid = ${booking.uid}`;
    await removeIndexedObjects(bookingsId, [href], { actor: 'test' });
    await setRadicale();
    await runReverseProjection({ actor: 'admin:test-reverse', calendarIds: [bookingsId] });
    const [row] = await sql<Array<{ status: string; caldes_object_id: string | null }>>`SELECT status, caldes_object_id::text AS caldes_object_id FROM calendar_events WHERE id = ${projection.id}::uuid`;
    assert.equal(row.status, 'cancelled');
    assert.equal(row.caldes_object_id, projection.id);
  });

  test('riprogrammata nella finestra → vecchia riga cancelled, nuova riga con il testo legacy', async () => {
    const bookingsId = await bookingsCalendarId();
    const schedule = await fx.schedule();
    const et = await fx.eventType({ key: 'rev-riprogrammata', durationMinutes: 30, schedule });
    const { booking: old, projection } = await fx.booking({ eventType: et, start: romeIso('2026-11-19', '10:00'), attendee: { name: 'Mario Rossi', phone: '+39 333 0000000' } });
    assert.ok(projection);
    const oldHref = `booking-${old.uid}.ics`;
    await reserveObjectId(sql, { calendarId: bookingsId, href: oldHref, id: projection.id, uid: `${old.uid}@caldes.it`, legacyEventId: projection.id, legacyUid: projection.uid });
    await indexItems(bookingsId, [{ href: oldHref, raw: projectionIcs(old, projection.id) }]);
    await setRadicale();
    await runReverseProjection({ actor: 'admin:test-reverse', calendarIds: [bookingsId] });

    // Riprogrammazione: la vecchia annullata, la nuova confermata con la propria risorsa (job project_booking).
    await sql`UPDATE calendar_bookings SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'attendee' WHERE uid = ${old.uid}`;
    const { booking: fresh } = await fx.booking({ eventType: et, start: romeIso('2026-11-20', '15:00'), attendee: { name: 'Mario Rossi', phone: '+39 333 0000000' }, project: false, rescheduledFromUid: old.uid });
    const newHref = `booking-${fresh.uid}.ics`;
    await indexItems(bookingsId, [{ href: newHref, raw: projectionIcs(fresh, null) }]);
    await removeIndexedObjects(bookingsId, [oldHref], { actor: 'test' });
    const res = await runReverseProjection({ actor: 'admin:test-reverse', calendarIds: [bookingsId] });
    assert.equal(res.failed, 0);
    const [oldRow] = await sql<Array<{ status: string }>>`SELECT status FROM calendar_events WHERE id = ${projection.id}::uuid`;
    assert.equal(oldRow.status, 'cancelled');
    const newObject = await objectIdOf(bookingsId, newHref);
    const [newRow] = await rowsOf(newObject);
    assert.ok(newRow);
    assert.equal(newRow.id, newObject);
    assert.equal(newRow.source, 'booking');
    assert.equal(newRow.source_id, fresh.uid);
    assert.equal(newRow.status, 'confirmed');
    assert.equal(newRow.uid, `${fresh.uid}@caldes.it`);
    assert.equal(newRow.summary, `${et.title} – Mario Rossi`);
    assert.ok(newRow.description?.includes(`UID prenotazione: ${fresh.uid}`));
    assert.equal(newRow.start_time.toISOString(), new Date(romeIso('2026-11-20', '15:00')).toISOString());
    // Nessun dato personale nello stato della proiezione.
    const state = await stateOf(newObject);
    assert.ok(!JSON.stringify(state).includes('Mario'), 'nessun nome nello stato');
  });
});

// ─── Job, backstop e salute ───────────────────────────────

async function jobsOf(key: string) {
  return sql<Array<{ status: string; attempts: number; last_error: string | null; result: Record<string, unknown> | null }>>`
    SELECT status, attempts, last_error, result FROM cal_jobs WHERE kind = ${REVERSE_PROJECTION_JOB_KIND} AND key = ${key} ORDER BY id
  `;
}

describe('job reverse_projection', () => {
  test('casi limite (invito duplicato, durata zero, senza SUMMARY, override con l\'UID del master): nessun job fallito, righe classificate', async () => {
    const personale = await blockingCalendar('rev-personale');
    const lavoro = await blockingCalendar('rev-lavoro');
    const invite = vcal(vevent(['UID:invito-dup@example.com', 'SUMMARY:Invito', 'ORGANIZER:mailto:org@example.com', 'ATTENDEE:mailto:io@example.com', 'DTSTART:20261203T100000Z', 'DTEND:20261203T110000Z']));
    await indexItems(personale.id, [{ href: 'invito.ics', raw: invite }]);
    await indexItems(lavoro.id, [
      { href: 'invito-copia.ics', raw: invite },
      { href: 'zero.ics', raw: vcal(vevent(['UID:job-zero@test', 'SUMMARY:Zero', 'DTSTART:20261203T120000Z', 'DTEND:20261203T120000Z'])) },
      { href: 'senza.ics', raw: vcal(vevent(['UID:job-senza@test', 'DTSTART:20261203T130000Z', 'DTEND:20261203T140000Z'])) },
      {
        href: 'serie.ics',
        raw: vcal(
          vevent(['UID:job-serie@test', 'SUMMARY:Serie', 'DTSTART;TZID=Europe/Rome:20261207T090000', 'DTEND;TZID=Europe/Rome:20261207T100000', 'RRULE:FREQ=DAILY;COUNT=4']),
          vevent(['UID:job-serie@test', 'SUMMARY:Override', 'RECURRENCE-ID;TZID=Europe/Rome:20261208T090000', 'DTSTART;TZID=Europe/Rome:20261208T150000', 'DTEND;TZID=Europe/Rome:20261208T160000']),
        ),
      },
    ]);
    await setRadicale();
    registerReverseProjectionJob();
    await enqueueReverseProjection(personale.id);
    await enqueueReverseProjection(lavoro.id);
    await runCalendarJobsOnce();
    for (const cal of [personale, lavoro]) {
      const jobs = await jobsOf(cal.id);
      assert.deepEqual(jobs.map((j) => j.status), ['done'], JSON.stringify(jobs));
      assert.equal((jobs[0].result as { failed?: number }).failed, 0);
    }
    const original = (await rowsOf(await objectIdOf(personale.id, 'invito.ics')))[0];
    const copy = (await rowsOf(await objectIdOf(lavoro.id, 'invito-copia.ics')))[0];
    assert.equal(original.uid, 'invito-dup@example.com');
    assert.equal(copy.uid, `invito-dup@example.com@${lavoro.slug}`);
    const copyState = await stateOf(await objectIdOf(lavoro.id, 'invito-copia.ics'));
    assert.deepEqual([...new Set(copyState?.degradations.map((d) => d.class))].sort(), ['REPR_LOSS_ATTENDEE', 'SANITIZED_UID']);
    const zero = (await rowsOf(await objectIdOf(lavoro.id, 'zero.ics')))[0];
    assert.equal(zero.end_time.getTime() - zero.start_time.getTime(), 60_000);
    assert.ok((await stateOf(await objectIdOf(lavoro.id, 'zero.ics')))?.degradations.some((d) => d.class === 'SANITIZED_DURATION'));
    const senza = (await rowsOf(await objectIdOf(lavoro.id, 'senza.ics')))[0];
    assert.equal(senza.summary, '(senza titolo)');
    const serieRows = await rowsOf(await objectIdOf(lavoro.id, 'serie.ics'));
    const override = serieRows.find((r) => r.recurrence_master_id !== null);
    assert.equal(override?.uid, 'job-serie@test#20261208T080000Z');
    const serieState = await stateOf(await objectIdOf(lavoro.id, 'serie.ics'));
    assert.ok(serieState?.degradations.some((d) => d.class === 'SANITIZED_UID' && d.recurrence_key === '20261208T080000Z'));

    // Salute per il wizard.
    const health = await readReverseProjectionHealth(sql);
    assert.equal(health.active, true);
    assert.ok(health.objects >= 5);
    assert.equal(health.by_status.failed, 0);
    assert.ok((health.by_class.SANITIZED_UID ?? 0) >= 2);
    assert.equal(health.queue.dead, 0);
  });

  test('fuori finestra o fuori da mode radicale il job si chiude senza azione; cal-migration occupato → attesa senza tentativi', async () => {
    const cal = await blockingCalendar('rev-skip');
    await indexItems(cal.id, [{ href: 's.ics', raw: vcal(vevent(['UID:skip@test', 'SUMMARY:S', 'DTSTART:20261204T100000Z', 'DTEND:20261204T110000Z'])) }]);
    registerReverseProjectionJob();
    const run = () => runCalendarJobsOnce();

    await enqueueReverseProjection(cal.id);
    await run();
    assert.equal((await jobsOf(cal.id)).at(-1)?.result?.skipped, 'mode_not_radicale');

    await setRadicale({ rollbackUntil: new Date(Date.now() - 60_000) });
    await enqueueReverseProjection(cal.id);
    await run();
    assert.equal((await jobsOf(cal.id)).at(-1)?.result?.skipped, 'window_closed');
    assert.equal((await rowsOf(await objectIdOf(cal.id, 's.ics'))).length, 0);

    await setRadicale();
    await enqueueReverseProjection(cal.id);
    await withMigrationLock(async () => {
      await run();
    }, { wait: false });
    const waiting = (await jobsOf(cal.id)).at(-1);
    assert.equal(waiting?.status, 'pending', JSON.stringify(waiting));
    assert.equal(waiting?.attempts, 0, 'errore d\'attesa: tentativo restituito');
    assert.match(waiting?.last_error ?? '', /run di migrazione in corso/);
    assert.equal(await closePendingReverseProjectionJobs(sql, 'test'), 1);
    assert.equal((await jobsOf(cal.id)).at(-1)?.status, 'done');
  });

  test('giro di backstop: accoda le collezioni con risorse cambiate dopo la proiezione', async () => {
    const cal = await blockingCalendar('rev-sweep');
    await indexItems(cal.id, [{ href: 'w.ics', raw: vcal(vevent(['UID:sweep@test', 'SUMMARY:W', 'DTSTART:20261205T100000Z', 'DTEND:20261205T110000Z'])) }]);
    await setRadicale();
    await runReverseProjection({ actor: 'admin:test-reverse' });
    await sql`DELETE FROM cal_jobs WHERE kind = ${REVERSE_PROJECTION_JOB_KIND}`;
    const quiet = await runReverseProjectionSweep();
    assert.equal((await jobsOf(cal.id)).length, 0, `nessun lavoro a proiezione allineata (accodate: ${quiet.enqueued})`);
    await indexItems(cal.id, [{ href: 'w.ics', raw: vcal(vevent(['UID:sweep@test', 'SUMMARY:W cambiato', 'DTSTART:20261205T100000Z', 'DTEND:20261205T120000Z'])) }]);
    const res = await runReverseProjectionSweep();
    assert.ok(res.enqueued >= 1);
    assert.deepEqual((await jobsOf(cal.id)).map((j) => j.status), ['pending']);
    await setPostgres();
    assert.deepEqual(await runReverseProjectionSweep(), { enqueued: 0 });
  });
});

