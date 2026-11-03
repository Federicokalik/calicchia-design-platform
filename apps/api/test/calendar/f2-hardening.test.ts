/**
 * Correzioni della revisione F2 (area B: indice, sync, job, busy, store,
 * iscrizioni) che non richiedono Radicale: ogni caso fallisce senza la
 * correzione corrispondente. I casi con Radicale reale stanno in
 * test/integration/radicale-f2-hardening.test.ts.
 *
 *  - rec-03: espansione al volo di una serie densa oltre le 5000 occorrenze
 *    (a blocchi fino alla fine della finestra, coda conservativa oltre i tetti),
 *    e busy che blocca fino alla fine della finestra;
 *  - index-01: la rimaterializzazione (cron dell'orizzonte, cambio di fuso)
 *    non toglie l'hold né svuota le cancellazioni sospese;
 *  - health-01: dirty_since si azzera solo per le modifiche segnate entro la
 *    stat della sync; un segno con la mtime già salvata non sporca;
 *  - sync-02 (parte indice): l'attore della versione 'delete' per href;
 *  - jobs-01 / f2r4-03: le indisponibilità del calendario non consumano i
 *    tentativi (tetto di 48 h); l'auditor riaccoda saghe e controlli morti;
 *  - f2r4-01: un'iscrizione bloccante mai scaricata non porta decisioni e
 *    slot in 503 horizon_insufficient;
 *  - f2r4-02: find_free_slots con lo store Radicale verifica il livello
 *    display e vede le prenotazioni non ancora proiettate;
 *  - f2r4-04: in mode postgres il cron dell'orizzonte non manda l'avviso;
 *  - core-08: il pull ricompone un carattere UTF-8 spezzato dal folding.
 */

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, mock, test } from 'node:test';
import { createBooking } from '../../src/lib/calendar/booking';
import {
  DEGRADED_MODE_SETTING_KEY,
  disableDegradedBookingMode,
  enableDegradedBookingMode,
  getBusyRanges,
  indexBusyRanges,
} from '../../src/lib/calendar/busy';
import { CalendarUnavailableError } from '../../src/lib/calendar/errors';
import { getBusyRanges as facadeBusyRanges } from '../../src/lib/calendar/events';
import { splitIcsFeed } from '../../src/lib/calendar/ics-split';
import {
  CAL_JOB_DEFAULTS,
  CAL_JOB_KINDS,
  CalendarJobPermanentError,
  claimCalendarJobs,
  computeCalendarJobWaitMs,
  enqueueCalendarJob,
  failCalendarJob,
  isCalendarJobWaitError,
} from '../../src/lib/calendar/jobs';
import { reviveDeadCalendarJobs } from '../../src/lib/calendar/radicale/auditor';
import { RadicaleForbiddenError, RadicaleNetworkError, RadicaleServerError, RadicaleTimeoutError } from '../../src/lib/calendar/radicale/errors';
import { markCollectionDirty, onIndexAlert } from '../../src/lib/calendar/radicale/health';
import { ensureHorizon } from '../../src/lib/calendar/radicale/horizon';
import { expandRawOnTheFly } from '../../src/lib/calendar/radicale/index-worker';
import { ensureRequestedRebuild } from '../../src/lib/calendar/radicale/rebuild';
import {
  applyCollectionChanges,
  type ChangeSetInput,
  type CollectionContext,
  loadCollectionContext,
  rematerializeCollection,
  stopIndexWorker,
} from '../../src/lib/calendar/radicale/indexer';
import { CollectionSyncError } from '../../src/lib/calendar/radicale/sync';
import { computeAvailableSlots } from '../../src/lib/calendar/slots';
import { overrideCalendarStore } from '../../src/lib/calendar/store';
import { enableSubscriptionIndex, pullSubscriptionToIndex } from '../../src/lib/calendar/subscriptions/pull';
import { freezeTime, restoreTime } from '../helpers/clock';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql } from '../helpers/db';
import { romeIso, useFixtures } from '../helpers/fixtures';

const fx = useFixtures('f2-hardening', { resetBaseline: true });

const JOB_PREFIX = 'tst_hard_';

onBeforeDatabaseClose(async () => {
  overrideCalendarStore(null);
  restoreTime();
  await sql`DELETE FROM site_settings WHERE key = ${DEGRADED_MODE_SETTING_KEY}`;
  await sql`DELETE FROM cal_jobs WHERE kind LIKE ${`${JOB_PREFIX.replace(/_/g, '\\_')}%`}`;
  await stopIndexWorker();
  await resetCalendarBaseline();
});

/** Orizzonte fisso dell'indice per i casi di questo file. */
const H = Object.freeze({ start: new Date('2026-06-01T00:00:00Z'), end: new Date('2028-06-01T00:00:00Z') });

function vcal(lines: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test hardening F2//IT', 'BEGIN:VEVENT', ...lines, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
}

function singleEvent(uid: string, start: string, end: string): string {
  return vcal([`UID:${uid}`, 'DTSTAMP:20260101T000000Z', `DTSTART:${start}`, `DTEND:${end}`, 'SUMMARY:Evento']);
}

/** Serie densa (scritta da un client: l'API la rifiuterebbe): 120 occorrenze di 5 minuti al giorno. */
function denseSeries(uid: string): string {
  const minutes = Array.from({ length: 12 }, (_, i) => i * 5).join(',');
  return vcal([
    `UID:${uid}`, 'DTSTAMP:20260101T000000Z', 'DTSTART:20260105T080000Z', 'DTEND:20260105T080500Z',
    `RRULE:FREQ=HOURLY;BYHOUR=8,9,10,11,12,13,14,15,16,17;BYMINUTE=${minutes}`, 'SUMMARY:Densa',
  ]);
}

function input(context: CollectionContext, parts: Partial<ChangeSetInput> = {}): ChangeSetInput {
  return { context, upserts: [], deletes: [], radicaleSkipped: [], pending404: [], full: false, horizon: { start: H.start, end: H.end }, actor: 'test', ...parts };
}

async function stateOf(calendarId: string) {
  const [row] = await sql<Array<{
    health: string; hold_reason: string | null; hold_since: Date | null; pending_deletions: string[];
    dirty_since: Date | null; dir_mtime_ns: string | null; horizon_end: Date | null;
  }>>`
    SELECT health, hold_reason, hold_since, pending_deletions, dirty_since, dir_mtime_ns::text AS dir_mtime_ns, horizon_end
    FROM cal_collection_state WHERE calendar_id = ${calendarId}
  `;
  assert.ok(row, 'stato della collezione assente');
  return row;
}

/** Collezioni non iscrizioni senza orizzonte: indicizzate vuote sull'orizzonte H (come la prima sync). */
async function ensureIndexedHorizon(): Promise<void> {
  const rows = await sql<Array<{ id: string }>>`
    SELECT c.id FROM calendars c LEFT JOIN cal_collection_state s ON s.calendar_id = c.id
    WHERE (s.calendar_id IS NULL OR s.horizon_end IS NULL) AND c.role <> 'subscription'
  `;
  for (const r of rows) {
    const context = await loadCollectionContext(sql, r.id);
    await applyCollectionChanges(input(context, { full: true }), { syncedAt: new Date() });
  }
}

// ─── rec-03 ───────────────────────────────

describe('rec-03: espansione al volo di una serie densa oltre le 5000 occorrenze', () => {
  test('la finestra si copre a blocchi fino alla fine; oltre i tetti la coda è conservativa e bloccante', async () => {
    const cal = await fx.calendar({ key: 'densa-volo', blocks_availability: true });
    const context = await loadCollectionContext(sql, cal.id);
    const raw = denseSeries('densa-volo');
    const from = Date.parse('2026-10-12T00:00:00Z');
    const to = Date.parse('2026-12-11T00:00:00Z');
    // 60 giorni × 120 occorrenze = 7200: oltre il tetto di 5000 per espansione.
    const full = expandRawOnTheFly(raw, 'densa-volo.ics', context, { from, to });
    assert.equal(full.conservative, false);
    assert.equal(full.occurrences.length, 7200);
    const last = full.occurrences[full.occurrences.length - 1];
    assert.equal(last.start.toISOString(), '2026-12-10T17:55:00.000Z', 'occorrenze fino alla fine della finestra');
    assert.ok(full.occurrences.every((o) => o.blocks));
    assert.equal(new Set(full.occurrences.map((o) => o.recurrenceKey)).size, 7200, 'nessuna occorrenza doppia fra i blocchi');
    await sql`UPDATE calendars SET blocks_availability = false WHERE id = ${cal.id}`;

    // Tetti ridotti: dopo il primo blocco il resto della finestra è un blocco conservativo, mai tempo libero.
    const capped = expandRawOnTheFly(raw, 'densa-volo.ics', context, { from, to }, { maxOccurrences: 5000, iterationBudget: 1_000_000 });
    assert.equal(capped.conservative, true);
    const tail = capped.occurrences[capped.occurrences.length - 1];
    assert.equal(tail.kind, 'conservative');
    assert.equal(tail.blocks, true);
    assert.equal(tail.end.toISOString(), new Date(to).toISOString(), 'la coda copre fino alla fine della finestra');
    // 5000 occorrenze dal 12/10: 41 giorni pieni (4920) più 80 il 22/11, dalle 08:00 → la 5001ª alle 14:40.
    assert.equal(tail.start.toISOString(), '2026-11-22T14:40:00.000Z', 'la coda parte da dove il tetto ha troncato');
    assert.equal(capped.occurrences.length, 5001);
  });

  test('busy: la serie densa oltre materialized_until blocca fino alla fine della finestra', async () => {
    const cal = await fx.calendar({ key: 'densa-busy', blocks_availability: true });
    const context = await loadCollectionContext(sql, cal.id);
    await applyCollectionChanges(input(context, { full: true, upserts: [{ href: 'densa.ics', etag: '"d1"', raw: denseSeries('densa-busy') }] }), { syncedAt: new Date() });
    const [obj] = await sql<Array<{ materialized_until: Date | null }>>`SELECT materialized_until FROM cal_objects WHERE calendar_id = ${cal.id}`;
    assert.ok(obj.materialized_until && obj.materialized_until < new Date('2026-10-12T00:00:00Z'), 'tetto delle 5000 occorrenze nell\'orizzonte');
    const ranges = await indexBusyRanges(sql, '2026-10-12T00:00:00.000Z', '2026-12-11T00:00:00.000Z');
    const last = ranges[ranges.length - 1];
    assert.ok(last, 'busy non vuoto');
    assert.ok(Date.parse(last.end) >= Date.parse('2026-12-10T18:00:00Z'), `busy fino alla fine della finestra (ultimo: ${last.start}-${last.end})`);
    const dec10 = ranges.filter((r) => r.start.startsWith('2026-12-10'));
    assert.ok(dec10.length > 0, 'il 10 dicembre (oltre la 5000ª occorrenza) blocca');
    // La serie è infinita: non deve occupare gli slot dei casi successivi.
    await sql`UPDATE calendars SET blocks_availability = false WHERE id = ${cal.id}`;
  });
});

// ─── index-01 ───────────────────────────────

test('index-01: la rimaterializzazione non toglie l\'hold né svuota le cancellazioni sospese', async () => {
  const cal = await fx.calendar({ key: 'hold-remat', blocks_availability: true });
  const context = await loadCollectionContext(sql, cal.id);
  const upserts = ['a', 'b', 'c'].map((n, i) => ({
    href: `${n}.ics`, etag: `"${n}1"`, raw: singleEvent(`hold-${n}`, `2027010${i + 4}T080000Z`, `2027010${i + 4}T090000Z`),
  }));
  await applyCollectionChanges(input(context, { full: true, upserts }), { syncedAt: new Date() });
  await applyCollectionChanges(input(context), { syncedAt: new Date(), hold: { reason: 'mass-delete', pendingDeletions: ['b.ics', 'c.ics'] } });
  const held = await stateOf(cal.id);
  assert.equal(held.health, 'hold');
  assert.deepEqual([...held.pending_deletions].sort(), ['b.ics', 'c.ics']);

  const newHorizon = { start: new Date('2026-07-01T00:00:00Z'), end: new Date('2028-07-01T00:00:00Z') };
  await rematerializeCollection(cal.id, { horizon: newHorizon, reason: 'horizon' });
  const after = await stateOf(cal.id);
  assert.equal(after.health, 'hold', 'la collezione resta in hold');
  assert.equal(after.hold_reason, 'mass-delete');
  assert.equal(after.hold_since?.getTime(), held.hold_since?.getTime(), 'inizio dell\'hold invariato');
  assert.deepEqual([...after.pending_deletions].sort(), ['b.ics', 'c.ics'], 'le cancellazioni da decidere restano');
  assert.equal(after.horizon_end?.toISOString(), newHorizon.end.toISOString(), 'occorrenze rigenerate sull\'orizzonte nuovo');
  const [{ n }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM cal_occurrences WHERE calendar_id = ${cal.id} AND blocks`;
  assert.equal(n, 3, 'le sospese continuano a bloccare');
});

// ─── health-01 ───────────────────────────────

test('health-01: dirty_since resta per un cambio segnato dopo la stat; il segno con la mtime già salvata non sporca', async () => {
  const cal = await fx.calendar({ key: 'dirty-obs', blocks_availability: true });
  const context = await loadCollectionContext(sql, cal.id);
  await applyCollectionChanges(input(context, { full: true }), { syncedAt: new Date(), dirMtimeNs: 1_000n, expectedSyncToken: null, newSyncToken: 't1' });
  const observedAt = new Date(Date.now() - 2_000);
  // Cambio osservato dal campanello DOPO la stat della sync (es. una PUT arrivata dopo il REPORT).
  await markCollectionDirty(sql, cal.id, new Date(Date.now() - 1_000));
  await applyCollectionChanges(input(context), { syncedAt: new Date(), dirMtimeNs: 2_000n, observedAt });
  assert.ok((await stateOf(cal.id)).dirty_since, 'la modifica arrivata dopo la stat resta pendente');
  // Una sync che ha fatto la stat dopo il segno lo azzera.
  await applyCollectionChanges(input(context), { syncedAt: new Date(), dirMtimeNs: 3_000n, observedAt: new Date() });
  assert.equal((await stateOf(cal.id)).dirty_since, null);
  // Segno tardivo per la mtime che la sync ha già salvato: nessun dirty falso.
  await markCollectionDirty(sql, cal.id, new Date(), { mtimeNs: 3_000n });
  assert.equal((await stateOf(cal.id)).dirty_since, null);
  await markCollectionDirty(sql, cal.id, new Date(), { mtimeNs: 4_000n });
  assert.ok((await stateOf(cal.id)).dirty_since, 'mtime diversa: modifica pendente');
});

// ─── sync-02 (indice) ───────────────────────────────

test('sync-02: la versione \'delete\' porta l\'attore per href (osservata dalla sync o fatta dall\'API)', async () => {
  const cal = await fx.calendar({ key: 'del-actor', blocks_availability: true });
  const context = await loadCollectionContext(sql, cal.id);
  const upserts = ['x', 'y'].map((n, i) => ({ href: `${n}.ics`, etag: `"${n}"`, raw: singleEvent(`actor-${n}`, `2027020${i + 1}T080000Z`, `2027020${i + 1}T090000Z`) }));
  await applyCollectionChanges(input(context, { full: true, upserts }), { syncedAt: new Date() });
  await applyCollectionChanges(input(context, { actor: 'write-through:api', deletes: ['x.ics', 'y.ics'], deleteActors: { 'x.ics': 'write-through:api', 'y.ics': 'sync' } }), { syncedAt: new Date() });
  const versions = await sql<Array<{ href: string; actor: string }>>`
    SELECT href, actor FROM cal_object_versions WHERE calendar_id = ${cal.id} AND change_kind = 'delete' ORDER BY href
  `;
  assert.deepEqual(versions.map((v) => [v.href, v.actor]), [['x.ics', 'write-through:api'], ['y.ics', 'sync']]);
});

// ─── jobs-01 / f2r4-03 ───────────────────────────────

describe('jobs-01 / f2r4-03: indisponibilità del calendario', () => {
  const dav = { method: 'PUT', path: '/federico/x/y.ics' };

  test('classificazione: attese e errori del lavoro', () => {
    assert.equal(isCalendarJobWaitError(new CalendarUnavailableError('radicale_unreachable', 'giù')), true);
    assert.equal(isCalendarJobWaitError(new CalendarUnavailableError('transition', 'cutover')), true);
    assert.equal(isCalendarJobWaitError(new RadicaleTimeoutError({ ...dav, timeoutMs: 10 })), true);
    assert.equal(isCalendarJobWaitError(new RadicaleNetworkError({ ...dav, errno: 'ECONNREFUSED' })), true);
    assert.equal(isCalendarJobWaitError(new RadicaleServerError({ ...dav, status: 503 })), true);
    assert.equal(isCalendarJobWaitError(new RadicaleServerError({ ...dav, status: 500 })), false);
    assert.equal(isCalendarJobWaitError(new RadicaleForbiddenError({ ...dav, status: 403 })), false);
    assert.equal(isCalendarJobWaitError(new CollectionSyncError('id', 'radicale', 'Radicale giù')), true);
    assert.equal(isCalendarJobWaitError(new CollectionSyncError('id', 'collection_missing', 'calendario cancellato')), false);
    assert.equal(isCalendarJobWaitError(new CalendarJobPermanentError('no')), false);
    assert.equal(isCalendarJobWaitError(new Error('boom')), false);
    // Pausa: cresce con l'età, da 5 s a 15 minuti (±20%).
    assert.ok(computeCalendarJobWaitMs(0, () => 0.5) === CAL_JOB_DEFAULTS.backoffBaseMs);
    assert.equal(computeCalendarJobWaitMs(10 * 60_000, () => 0.5), 5 * 60_000);
    assert.equal(computeCalendarJobWaitMs(5 * 3_600_000, () => 0.5), CAL_JOB_DEFAULTS.unavailableBackoffMaxMs);
  });

  test('Radicale giù oltre gli 8 tentativi: il job attende senza consumarli, dead letter solo dopo 48 h', async () => {
    const kind = `${JOB_PREFIX}wait`;
    await enqueueCalendarJob(kind, 'k1', {});
    const [first] = await claimCalendarJobs({ kinds: [kind] });
    assert.equal(first.attempts, 1);
    assert.equal(await failCalendarJob(first, new CalendarUnavailableError('radicale_unreachable', 'giù')), 'requeued');
    let [row] = await sql<Array<{ status: string; attempts: number; run_after: Date; last_error: string }>>`SELECT status, attempts, run_after, last_error FROM cal_jobs WHERE kind = ${kind}`;
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 0, 'tentativo restituito');
    assert.match(row.last_error, /radicale_unreachable/);

    // Al limite dei tentativi un errore di indisponibilità non manda in dead letter.
    await sql`UPDATE cal_jobs SET attempts = ${CAL_JOB_DEFAULTS.maxAttempts - 1}, run_after = now() WHERE kind = ${kind}`;
    const [second] = await claimCalendarJobs({ kinds: [kind] });
    assert.equal(second.attempts, CAL_JOB_DEFAULTS.maxAttempts);
    assert.equal(await failCalendarJob(second, new RadicaleNetworkError({ method: 'REPORT', path: '/x/', errno: 'ECONNREFUSED' })), 'requeued');
    [row] = await sql`SELECT status, attempts, run_after, last_error FROM cal_jobs WHERE kind = ${kind}`;
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, CAL_JOB_DEFAULTS.maxAttempts - 1);

    // Un errore del lavoro, al limite, va in dead letter come prima.
    await sql`UPDATE cal_jobs SET run_after = now() WHERE kind = ${kind}`;
    const [third] = await claimCalendarJobs({ kinds: [kind] });
    assert.equal(await failCalendarJob(third, new Error('boom')), 'dead');

    // Oltre le 48 h di attesa: dead letter.
    await enqueueCalendarJob(kind, 'k2', {});
    await sql`UPDATE cal_jobs SET created_at = now() - interval '49 hours' WHERE kind = ${kind} AND key = 'k2'`;
    const [old] = await claimCalendarJobs({ kinds: [kind] });
    assert.equal(await failCalendarJob(old, new CalendarUnavailableError('transition', 'cutover')), 'dead');
  });

  test('auditor: saghe non concluse e controlli di prenotazioni attive riaccodati dalla dead letter, mai quelli definitivi', async () => {
    await sql`DELETE FROM cal_jobs WHERE kind IN ('recurrence_split', 'booking_conflict_check')`;
    const et = await fx.eventType({ key: 'revive' });
    const { booking } = await fx.booking({ eventType: et, start: '2099-05-10T08:00:00Z', project: false });
    const dead = async (kind: string, key: string, payload: Record<string, unknown>, lastError: string): Promise<string> => {
      const { id } = await enqueueCalendarJob(kind, key, payload);
      await sql`UPDATE cal_jobs SET status = 'dead', finished_at = now(), attempts = 8, last_error = ${lastError} WHERE id = ${id}`;
      return id;
    };
    const saga = await dead(CAL_JOB_KINDS.recurrenceSplit, 'serie-1', { phase: 'tail-written' }, 'CalendarUnavailableError: Calendario temporaneamente non verificabile');
    const sagaDone = await dead(CAL_JOB_KINDS.recurrenceSplit, 'serie-2', { phase: 'done' }, 'Error: x');
    const sagaPermanent = await dead(CAL_JOB_KINDS.recurrenceSplit, 'serie-3', { phase: 'started' }, 'CalendarJobPermanentError: payload della saga incompleto');
    const check = await dead(CAL_JOB_KINDS.bookingConflictCheck, booking.uid, {}, 'CalendarUnavailableError: giù');
    const checkGone = await dead(CAL_JOB_KINDS.bookingConflictCheck, 'prenotazione-inesistente', {}, 'CalendarUnavailableError: giù');
    assert.equal(await reviveDeadCalendarJobs(), 2);
    const rows = new Map((await sql<Array<{ id: string; status: string; attempts: number }>>`
      SELECT id::text AS id, status, attempts FROM cal_jobs WHERE kind IN ('recurrence_split', 'booking_conflict_check')
    `).map((r) => [r.id, r]));
    assert.equal(rows.get(saga)?.status, 'pending');
    assert.equal(rows.get(saga)?.attempts, 0);
    assert.equal(rows.get(check)?.status, 'pending');
    for (const id of [sagaDone, sagaPermanent, checkGone]) assert.equal(rows.get(id)?.status, 'dead');
    await sql`DELETE FROM cal_jobs WHERE kind IN ('recurrence_split', 'booking_conflict_check')`;
  });
});

// ─── rebuild-01 ───────────────────────────────

test('rebuild-01: rebuild richiesto dallo stato senza job (restore dello stack, UPDATE manuale) → accodato all\'avvio, una volta', async () => {
  await sql`DELETE FROM cal_jobs WHERE kind = 'index_rebuild'`;
  const cal = await fx.calendar({ key: 'rebuild-avvio', blocks_availability: true });
  const context = await loadCollectionContext(sql, cal.id);
  await applyCollectionChanges(input(context, { full: true }), { syncedAt: new Date(), dirMtimeNs: 5_000n, expectedSyncToken: null, newSyncToken: 'tok-1' });
  assert.equal(await ensureRequestedRebuild(), false, 'nessun rebuild richiesto');
  await sql`UPDATE calendar_backend_state SET rebuild_required = true WHERE id = true`;
  try {
    assert.equal(await ensureRequestedRebuild(), true);
    const jobs = await sql<Array<{ status: string; payload: Record<string, unknown> }>>`SELECT status, payload FROM cal_jobs WHERE kind = 'index_rebuild'`;
    assert.deepEqual(jobs.map((j) => [j.status, j.payload.reason]), [['pending', 'startup']]);
    const [st] = await sql<Array<{ sync_token: string | null; dir_mtime_ns: string | null }>>`
      SELECT sync_token, dir_mtime_ns::text AS dir_mtime_ns FROM cal_collection_state WHERE calendar_id = ${cal.id}
    `;
    assert.deepEqual(st, { sync_token: null, dir_mtime_ns: null }, 'token e mtime azzerati: la prima sync è completa');
    assert.equal(await ensureRequestedRebuild(), false, 'job già accodato: nessun duplicato');
  } finally {
    await sql`UPDATE calendar_backend_state SET rebuild_required = false WHERE id = true`;
    await sql`DELETE FROM cal_jobs WHERE kind = 'index_rebuild'`;
  }
});

// ─── f2r4-01 ───────────────────────────────

test('f2r4-01: un\'iscrizione bloccante mai scaricata non porta decisioni e slot in 503', async () => {
  freezeTime('2027-03-01T06:00:00Z');
  const parent = await fx.calendar({ key: 'sub-parent', blocks_availability: true });
  const { subscription } = await fx.subscription({ calendar: parent, events: [] });
  const sidecarId = await enableSubscriptionIndex(subscription.id, { allowPostgresMode: true });
  await sql`UPDATE calendar_subscriptions SET blocks_availability = true WHERE id = ${subscription.id}`;
  await ensureIndexedHorizon();
  const pulled = await pullSubscriptionToIndex(subscription.id, { body: '<html>errore</html>' });
  assert.equal(pulled.status, 'rejected');
  const [st] = await sql<Array<{ horizon_end: Date | null }>>`SELECT horizon_end FROM cal_collection_state WHERE calendar_id = ${sidecarId}`;
  assert.equal(st.horizon_end, null, 'iscrizione mai scaricata: nessun orizzonte');
  const et = await fx.eventType({ key: 'sub-dec', durationMinutes: 60 });
  overrideCalendarStore('radicale');
  try {
    const busy = await getBusyRanges(romeIso('2027-03-08', '09:00'), romeIso('2027-03-08', '18:00'), { level: 'decision', db: sql });
    assert.ok(Array.isArray(busy), 'decisione possibile: nessun 503 horizon_insufficient');
    const slots = await computeAvailableSlots({ eventTypeIdOrSlug: et.id, fromDateLocal: '2027-03-08', toDateLocal: '2027-03-08' }, { level: 'decision', db: sql });
    assert.ok(slots && slots.slots.length > 0, 'slot disponibili nonostante il feed esterno guasto');
  } finally {
    overrideCalendarStore(null);
    await sql`UPDATE calendar_subscriptions SET blocks_availability = false WHERE id = ${subscription.id}`;
    restoreTime();
  }
});

// ─── f2r4-02 ───────────────────────────────

test('f2r4-02: find_free_slots con lo store Radicale verifica il livello display e vede le prenotazioni non proiettate', async () => {
  freezeTime('2027-04-01T06:00:00Z');
  const { executeTool } = await import('../../src/lib/agent/tools');
  await ensureIndexedHorizon();
  const et = await fx.eventType({ key: 'ffs', durationMinutes: 60 });
  const { booking } = await fx.booking({ eventType: et, start: romeIso('2027-04-12', '14:00'), project: false });
  overrideCalendarStore('radicale');
  try {
    // Radicale non configurato: il livello display risponde 503 come /slots.
    await assert.rejects(
      facadeBusyRanges('2027-04-12T07:00:00.000Z', '2027-04-12T16:00:00.000Z'),
      (err: unknown) => err instanceof CalendarUnavailableError && err.reason === 'radicale_unreachable',
    );
    const refused = JSON.parse(await executeTool('find_free_slots', { from: '2027-04-12T07:00:00Z', to: '2027-04-12T16:00:00Z', duration_minutes: 60 }));
    assert.ok(refused.error, 'find_free_slots non risponde dall\'indice senza verifica');

    // Con la modalità degradata (ultimo indice noto) la prenotazione confermata, senza proiezione, è occupata.
    await enableDegradedBookingMode({ actor: 'test', reason: 'prova f2r4-02' });
    const busy = await facadeBusyRanges(romeIso('2027-04-12', '09:00'), romeIso('2027-04-12', '18:00'));
    assert.deepEqual(busy, [{ start: new Date(booking.start_time).toISOString(), end: new Date(booking.end_time).toISOString() }]);
    const out = JSON.parse(await executeTool('find_free_slots', { from: romeIso('2027-04-12', '09:00'), to: romeIso('2027-04-12', '18:00'), duration_minutes: 60 })) as { free_slots: Array<{ start: string; end: string }> };
    const bStart = new Date(booking.start_time).getTime();
    const bEnd = new Date(booking.end_time).getTime();
    assert.ok(!out.free_slots.some((s) => Date.parse(s.start) < bEnd && Date.parse(s.end) > bStart), 'la prenotazione confermata non è tempo libero');
  } finally {
    overrideCalendarStore(null);
    await disableDegradedBookingMode({ actor: 'test' });
    restoreTime();
  }
});

// ─── f2r4-04 ───────────────────────────────

test('f2r4-04: in mode postgres il cron dell\'orizzonte non manda l\'avviso horizon-insufficient; con lo store Radicale sì', async () => {
  await resetCalendarBaseline();
  const alerts: string[] = [];
  const stop = onIndexAlert((code) => alerts.push(code));
  try {
    const [state] = await sql<Array<{ mode: string }>>`SELECT mode FROM calendar_backend_state`;
    assert.equal(state.mode, 'postgres');
    await ensureHorizon();
    assert.ok(!alerts.includes('horizon-insufficient'), 'nessun falso allarme in mode postgres (indice in shadow)');
    overrideCalendarStore('radicale');
    await ensureHorizon();
    assert.ok(alerts.includes('horizon-insufficient'), 'con lo store Radicale la garanzia conta');
  } finally {
    overrideCalendarStore(null);
    stop();
  }
});

// ─── core-08 ───────────────────────────────

describe('core-08: pull di un feed piegato a 75 caratteri invece che a 75 ottetti', () => {
  const PUBLIC_HOST = '203.0.113.10';
  let server: Server | null = null;
  let port = 0;
  let restoreFetch: (() => void) | null = null;
  /** "à" (C3 A0) spezzata fra due righe fisiche da CRLF + spazio. */
  const folded = Buffer.concat([
    Buffer.from('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Esterno//IT\r\nBEGIN:VEVENT\r\nUID:piegato-1\r\nDTSTAMP:20261001T000000Z\r\n'
      + 'DTSTART:20270310T090000Z\r\nDTEND:20270310T100000Z\r\nSUMMARY:Riunione con Nicol', 'utf8'),
    Buffer.from([0xc3, 0x0d, 0x0a, 0x20, 0xa0]),
    Buffer.from(' e Mario\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n', 'utf8'),
  ]);

  before(async () => {
    server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8' });
      res.end(folded);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    const realFetch = globalThis.fetch;
    const m = mock.method(globalThis, 'fetch', (target: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof target === 'string' ? target : target instanceof URL ? target.toString() : target.url);
      if (url.hostname === PUBLIC_HOST) url.hostname = '127.0.0.1';
      return realFetch(url, init);
    });
    restoreFetch = () => m.mock.restore();
  });

  after(async () => {
    restoreFetch?.();
    const s = server;
    server = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  test('splitIcsFeed sui byte ricompone il carattere; il pull indicizza il testo intatto', async () => {
    const split = splitIcsFeed(new Uint8Array(folded));
    assert.match(split.objects[0].raw, /SUMMARY:Riunione con Nicolà e Mario/);
    // Byte non UTF-8: sostituiti, il feed resta utilizzabile (come la decodifica tollerante di prima).
    const latin1 = Buffer.concat([folded.subarray(0, 120), Buffer.from([0xe0]), folded.subarray(120)]);
    assert.equal(splitIcsFeed(new Uint8Array(latin1)).objects.length, 1);

    const cal = await fx.calendar({ key: 'piegato', blocks_availability: false });
    const { subscription } = await fx.subscription({ calendar: cal, url: `http://${PUBLIC_HOST}:${port}/piegato.ics` });
    const sidecarId = await enableSubscriptionIndex(subscription.id, { allowPostgresMode: true });
    const res = await pullSubscriptionToIndex(subscription.id, { force: true });
    assert.equal(res.status, 'applied', JSON.stringify(res));
    const [comp] = await sql<Array<{ summary: string }>>`SELECT summary FROM cal_components WHERE calendar_id = ${sidecarId} AND recurrence_key = ''`;
    assert.equal(comp.summary, 'Riunione con Nicolà e Mario');
  });
});

// ─── K2 (ricaduta in mode postgres: nessun cambio) ───────────────────────────────

test('createBooking in mode postgres invariato (le correzioni dello store Radicale non toccano il legacy)', async () => {
  freezeTime('2027-06-01T06:00:00Z');
  try {
    const et = await fx.eventType({ key: 'legacy-ok', durationMinutes: 30 });
    const created = await createBooking({
      event_type_id: et.id, start: romeIso('2027-06-07', '10:00'),
      attendee: { name: 'Cliente', email: fx.email('legacy'), timezone: 'Europe/Rome' }, source: 'admin_manual',
    });
    fx.track('bookingIds', created.booking.id);
    assert.equal(created.booking.status, 'confirmed');
    const [{ n }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM cal_jobs WHERE key = ${created.booking.uid}`;
    assert.equal(n, 0, 'mode postgres: nessun job accodato');
  } finally {
    restoreTime();
  }
});
