/**
 * Salute dell'indice e versioni degli oggetti (apps/api/src/lib/calendar/
 * radicale/health.ts e versions.ts; design §6.5, §6.7, §16.4; contratto
 * docs/calendar-radicale/contracts/f2-modules.md §2.5, §5.2 e §5.6), senza
 * Radicale.
 *
 *  - stato derivato della collezione (healthy, stale, unsyncable, hold) e
 *    soglia del 503 (decisioni subito, display dopo 10 minuti, mai per hold);
 *  - markCollectionDirty / recordSyncFailure: dirty_since, unsyncable con
 *    health_since, iscrizioni mai unsyncable; ritorno a healthy dopo una sync
 *    riuscita con una dir_mtime_ns non racy;
 *  - riepilogo getIndexHealth (quarantene con e senza ultima buona, oggetti
 *    illeggibili, materialized_until);
 *  - versioni: nessuna versione nuova se cambia solo il fingerprint escluso
 *    (needsNewVersion), retention di 90 giorni che non tocca mai l'ultima
 *    buona, cancellazione GDPR.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HEALTH_REASONS, INDEX_TIMING, type CalCollectionStateRow } from '../../src/lib/calendar/index-model';
import {
  blocksDecisions,
  type CollectionHealthView,
  collectionHealthView,
  deriveCollectionHealth,
  errorText,
  getIndexHealth,
  markCollectionDirty,
  recordSyncFailure,
} from '../../src/lib/calendar/radicale/health';
import {
  applyCollectionChanges,
  type ChangeSetInput,
  type CollectionContext,
  loadCollectionContext,
  stopIndexWorker,
} from '../../src/lib/calendar/radicale/indexer';
import {
  getObjectVersion,
  lastValidVersion,
  listObjectVersions,
  needsNewVersion,
  purgeExpiredVersions,
  purgeVersionsForErasure,
} from '../../src/lib/calendar/radicale/versions';
import { onBeforeDatabaseClose, sql } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';

const fx = useFixtures('idx-health', { resetBaseline: true });

onBeforeDatabaseClose(async () => {
  await stopIndexWorker();
});

const H = Object.freeze({ start: new Date('2026-01-01T00:00:00Z'), end: new Date('2028-01-01T00:00:00Z') });
const MIN = 60_000;

function ics(...components: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//Salute indice//IT', ...components, 'END:VCALENDAR', ''].join('\r\n');
}

function event(uid: string, opts: { summary?: string; rrule?: string; start?: string; end?: string } = {}): string {
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20260101T000000Z',
    `DTSTART:${opts.start ?? '20260310T090000Z'}`,
    `DTEND:${opts.end ?? '20260310T100000Z'}`,
    ...(opts.rrule ? [`RRULE:${opts.rrule}`] : []),
    `SUMMARY:${opts.summary ?? 'Evento'}`,
    'END:VEVENT',
  ].join('\r\n');
}

async function makeCalendar(key: string, opts: { role?: string; blocks?: boolean } = {}): Promise<{ id: string; context: CollectionContext }> {
  const cal = await fx.calendar({ key, blocks_availability: opts.blocks ?? true });
  if (opts.role) await sql`UPDATE calendars SET role = ${opts.role} WHERE id = ${cal.id}`;
  return { id: cal.id, context: await loadCollectionContext(sql, cal.id) };
}

async function apply(context: CollectionContext, parts: Partial<ChangeSetInput>, opts: { dirMtimeNs?: bigint | null; expectedSyncToken?: string | null } = {}) {
  return applyCollectionChanges(
    { context, upserts: [], deletes: [], radicaleSkipped: [], pending404: [], full: false, horizon: { ...H }, actor: 'test', ...parts },
    { syncedAt: new Date(), ...opts },
  );
}

type StateLike = Pick<CalCollectionStateRow, 'health' | 'consecutive_failures' | 'dirty_since' | 'hold_since'>;

function view(over: Partial<CollectionHealthView>): CollectionHealthView {
  return {
    calendarId: '00000000-0000-4000-8000-000000000001',
    collectionName: 'c',
    role: 'user',
    originStore: 'radicale',
    blocking: true,
    health: 'healthy',
    healthSince: new Date('2026-10-10T10:00:00Z'),
    dirtySince: null,
    lastSyncedAt: null,
    consecutiveFailures: 0,
    lastError: null,
    holdReason: null,
    pendingDeletions: 0,
    objectCount: 0,
    quarantined: 0,
    indexVersion: '0',
    horizon: null,
    ...over,
  };
}

async function stateOf(calendarId: string) {
  const [row] = await sql<Array<{
    health: string; health_since: Date; dirty_since: Date | null; consecutive_failures: number; last_error: string | null; dir_mtime_ns: string | null;
  }>>`
    SELECT health, health_since, dirty_since, consecutive_failures, last_error, dir_mtime_ns::text
    FROM cal_collection_state WHERE calendar_id = ${calendarId}
  `;
  return row;
}

// ─── Stato derivato ───────────────────────────────

describe('salute della collezione: stato derivato e soglia del 503', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const ago = (ms: number): Date => new Date(now.getTime() - ms);
  const s = (over: Partial<StateLike>): StateLike => ({ health: 'healthy', consecutive_failures: 0, dirty_since: null, hold_since: null, ...over });

  test('deriveCollectionHealth: hold, unsyncable, stale dopo 2 minuti, mai sincronizzata, healthy', () => {
    assert.equal(deriveCollectionHealth(s({ health: 'hold', hold_since: ago(MIN), consecutive_failures: 3, dirty_since: ago(MIN) }), now), 'hold');
    assert.equal(deriveCollectionHealth(s({ consecutive_failures: 1, dirty_since: ago(1_000) }), now), 'unsyncable');
    assert.equal(deriveCollectionHealth(s({ consecutive_failures: 2 }), now), 'healthy', 'fallimenti senza modifiche pendenti: nessun rischio');
    assert.equal(deriveCollectionHealth(s({ dirty_since: ago(INDEX_TIMING.staleAfterMs - 1_000) }), now), 'healthy');
    assert.equal(deriveCollectionHealth(s({ dirty_since: ago(INDEX_TIMING.staleAfterMs) }), now), 'stale');
    assert.equal(deriveCollectionHealth(s({ health: 'stale' }), now), 'stale', 'mai sincronizzata');
    assert.equal(deriveCollectionHealth(s({ health: 'unsyncable', consecutive_failures: 0 }), now), 'healthy', 'stato memorizzato superato da una sync riuscita');
  });

  test('blocksDecisions: solo bloccante e unsyncable; decisioni subito, display dopo 10 minuti; mai per hold o stale', () => {
    const since = ago(5 * MIN);
    assert.equal(blocksDecisions(view({ health: 'unsyncable', healthSince: since }), 'decision', now), true);
    assert.equal(blocksDecisions(view({ health: 'unsyncable', healthSince: since }), 'display', now), false);
    assert.equal(blocksDecisions(view({ health: 'unsyncable', healthSince: ago(INDEX_TIMING.unsyncableDisplayGraceMs) }), 'display', now), true);
    assert.equal(blocksDecisions(view({ health: 'unsyncable', healthSince: since, blocking: false }), 'decision', now), false);
    assert.equal(blocksDecisions(view({ health: 'hold', healthSince: ago(60 * MIN) }), 'decision', now), false);
    assert.equal(blocksDecisions(view({ health: 'stale', healthSince: ago(60 * MIN) }), 'decision', now), false);
  });

  test('errorText: testo breve su una riga, con il codice', () => {
    const err = Object.assign(new Error('richiesta\nrifiutata'), { code: 'bad_request' });
    assert.equal(errorText(err), 'bad_request: richiesta rifiutata');
    assert.equal(errorText('x'.repeat(5_000)).length, 1_000);
  });
});

// ─── Scritture dello stato ───────────────────────────────

describe('salute della collezione: dirty, fallimenti e ritorno a healthy', () => {
  test('mai sincronizzata: sync fallita → unsyncable (nessuna base verificata), poi una sync riuscita con mtime → healthy', async () => {
    const { id, context } = await makeCalendar('mai-sync');
    const at = new Date(Date.now() - 30_000);
    const derived = await recordSyncFailure(sql, id, Object.assign(new Error('Radicale irraggiungibile'), { code: 'radicale' }), at);
    assert.equal(derived, 'unsyncable');
    let st = await stateOf(id);
    assert.deepEqual([st.health, st.consecutive_failures, st.last_error], ['unsyncable', 1, 'radicale: Radicale irraggiungibile']);
    assert.equal(st.dirty_since?.getTime(), at.getTime());
    assert.equal(st.health_since.getTime(), at.getTime());
    const v = await collectionHealthView(sql, id, new Date());
    assert.ok(v);
    assert.equal(blocksDecisions(v, 'decision', new Date()), true, 'bloccante unsyncable: 503 nelle decisioni');
    assert.equal(blocksDecisions(v, 'display', new Date()), false, 'display: tolleranza di 10 minuti');

    await recordSyncFailure(sql, id, new Error('ancora giù'), new Date());
    st = await stateOf(id);
    assert.equal(st.consecutive_failures, 2);
    assert.equal(st.health_since.getTime(), at.getTime(), 'health_since resta l\'inizio dell\'indisponibilità');

    await apply(context, { upserts: [{ href: 'a.ics', etag: '"1"', raw: ics(event('ms-1')) }] }, { expectedSyncToken: null, dirMtimeNs: 42n });
    st = await stateOf(id);
    assert.deepEqual([st.health, st.consecutive_failures, st.last_error, st.dirty_since, st.dir_mtime_ns], ['healthy', 0, null, null, '42']);
  });

  test('sincronizzata: fallimento senza modifiche pendenti → healthy; directory cambiata → unsyncable da quell\'istante', async () => {
    const { id, context } = await makeCalendar('dirty-poi');
    await apply(context, { full: true }, { dirMtimeNs: 7n });
    assert.equal(await recordSyncFailure(sql, id, new Error('timeout'), new Date()), 'healthy');
    assert.equal((await stateOf(id)).health, 'healthy');
    const observed = new Date(Date.now() - 5_000);
    await markCollectionDirty(sql, id, observed);
    const st = await stateOf(id);
    assert.equal(st.health, 'unsyncable');
    assert.equal(st.dirty_since?.getTime(), observed.getTime());
    assert.equal(st.health_since.getTime(), observed.getTime());
    // Una seconda osservazione non sposta l'inizio delle modifiche pendenti.
    await markCollectionDirty(sql, id, new Date());
    assert.equal((await stateOf(id)).dirty_since?.getTime(), observed.getTime());
  });

  test('markCollectionDirty su una collezione senza riga di stato: la crea (stale); calendario inesistente: nulla', async () => {
    const { id } = await makeCalendar('dirty-nuova');
    const at = new Date();
    await markCollectionDirty(sql, id, at);
    const st = await stateOf(id);
    assert.deepEqual([st.health, st.dirty_since?.getTime()], ['stale', at.getTime()]);
    await markCollectionDirty(sql, '00000000-0000-4000-8000-00000000dead', at);
    const [{ n }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM cal_collection_state WHERE calendar_id = '00000000-0000-4000-8000-00000000dead'`;
    assert.equal(n, 0);
  });

  test('iscrizioni: una sync fallita non le rende mai unsyncable (le decisioni usano l\'ultimo pull completato)', async () => {
    const { id, context } = await makeCalendar('iscrizione-fallita', { role: 'subscription' });
    assert.equal(context.originStore, 'remote');
    assert.notEqual(await recordSyncFailure(sql, id, new Error('feed irraggiungibile'), new Date()), 'unsyncable');
    const st = await stateOf(id);
    assert.equal(st.dirty_since, null);
    assert.notEqual(st.health, 'unsyncable');
  });
});

// ─── Riepilogo ───────────────────────────────

describe('getIndexHealth', () => {
  test('quarantene con e senza ultima buona, illeggibili, materialized_until, viste delle collezioni', async () => {
    const { id, context } = await makeCalendar('riepilogo');
    await apply(context, {
      upserts: [
        { href: 'buono.ics', etag: '"1"', raw: ics(event('sum-1')) },
        { href: 'poi-rotto.ics', etag: '"1"', raw: ics(event('sum-2')) },
        { href: 'orario.ics', etag: '"1"', raw: ics(event('sum-3', { start: '20260105T090000Z', end: '20260105T091500Z', rrule: 'FREQ=HOURLY' })) },
      ],
      full: true,
    }, { expectedSyncToken: null, dirMtimeNs: 1n });
    await apply(context, {
      upserts: [
        { href: 'poi-rotto.ics', etag: '"2"', raw: ics(event('sum-2', { rrule: 'FREQ=WEEKLY;BYDAY=XX' })) },
        { href: 'illeggibile.ics', etag: '"1"', raw: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:sum-4\r\nSUMMARY:senza date\r\n' },
      ],
    });
    const summary = await getIndexHealth(sql);
    const col = summary.collections.find((c) => c.calendarId === id);
    assert.ok(col);
    assert.deepEqual([col.health, col.objectCount, col.quarantined, col.blocking, col.originStore], ['healthy', 4, 2, true, 'radicale']);
    assert.deepEqual(col.horizon, { start: H.start, end: H.end });
    const mine = summary.quarantined.filter((q) => q.calendarId === id).sort((a, b) => a.href.localeCompare(b.href));
    assert.deepEqual(mine.map((q) => [q.href, q.reason, q.hasLastGood]), [
      ['illeggibile.ics', HEALTH_REASONS.unreadable, false],
      ['poi-rotto.ics', HEALTH_REASONS.invalidRrule, true],
    ]);
    assert.ok(summary.unreadable >= 1, 'illeggibile: escluso dal busy, badge');
    assert.ok(summary.materializedLimited >= 1, 'HOURLY infinita: materialized_until');
    assert.ok(summary.generatedAt instanceof Date);
  });

  test('collezione Radicale attiva mai indicizzata: compare come stale; le iscrizioni senza stato no', async () => {
    const { id } = await makeCalendar('mai-indicizzata');
    const { id: subId } = await makeCalendar('iscrizione-senza-stato', { role: 'subscription' });
    const summary = await getIndexHealth(sql);
    assert.equal(summary.collections.find((c) => c.calendarId === id)?.health, 'stale');
    assert.equal(summary.collections.some((c) => c.calendarId === subId), false);
  });
});

// ─── Versioni ───────────────────────────────

describe('versioni', () => {
  test('needsNewVersion: fingerprint semantico per i testi validi, sha per quelli non validi', () => {
    const latest = { id: 'v', contentSha256: 'a'.repeat(64), semanticFp: 'fp1', valid: true, changeKind: 'update' as const };
    assert.equal(needsNewVersion(undefined, { sha256: 'b'.repeat(64), semanticFp: 'fp1', valid: true }), true);
    assert.equal(needsNewVersion({ ...latest, changeKind: 'delete' }, { sha256: 'a'.repeat(64), semanticFp: 'fp1', valid: true }), true);
    assert.equal(needsNewVersion(latest, { sha256: 'b'.repeat(64), semanticFp: 'fp1', valid: true }), false, 'cambia solo DTSTAMP');
    assert.equal(needsNewVersion(latest, { sha256: 'b'.repeat(64), semanticFp: 'fp2', valid: true }), true);
    assert.equal(needsNewVersion(latest, { sha256: 'a'.repeat(64), semanticFp: null, valid: false }), true, 'cambio di validità');
    const invalid = { ...latest, semanticFp: null, valid: false };
    assert.equal(needsNewVersion(invalid, { sha256: 'a'.repeat(64), semanticFp: null, valid: false }), false);
    assert.equal(needsNewVersion(invalid, { sha256: 'c'.repeat(64), semanticFp: null, valid: false }), true);
  });

  test('lettura: elenco dal più recente, ultima valida, per id', async () => {
    const { id, context } = await makeCalendar('versioni-lettura');
    await apply(context, { upserts: [{ href: 'v.ics', etag: '"1"', raw: ics(event('ver-1', { summary: 'Uno' })) }] });
    await apply(context, { upserts: [{ href: 'v.ics', etag: '"2"', raw: ics(event('ver-1', { summary: 'Due' })) }] });
    await apply(context, { upserts: [{ href: 'v.ics', etag: '"3"', raw: ics(event('ver-1', { rrule: 'FREQ=WEEKLY;BYDAY=XX' })) }] });
    const [obj] = await sql<Array<{ id: string; last_good_version_id: string }>>`
      SELECT id, last_good_version_id FROM cal_objects WHERE calendar_id = ${id} AND href = 'v.ics'
    `;
    const list = await listObjectVersions(sql, obj.id);
    assert.deepEqual(list.map((v) => [v.change_kind, v.valid]), [['update', false], ['update', true], ['create', true]]);
    const good = await lastValidVersion(sql, obj.id);
    assert.equal(good?.id, obj.last_good_version_id);
    assert.match(good?.raw_ics ?? '', /SUMMARY:Due/);
    assert.equal((await getObjectVersion(sql, list[2].id))?.change_kind, 'create');
    assert.equal(await getObjectVersion(sql, '00000000-0000-4000-8000-000000000000'), null);
    assert.equal((await listObjectVersions(sql, obj.id, { limit: 1 })).length, 1);
  });

  test('retention di 90 giorni: mai l\'ultima buona (anche di un oggetto in quarantena); cancellazione GDPR', async () => {
    const { id, context } = await makeCalendar('versioni-purge');
    await apply(context, {
      upserts: [
        { href: 'sano.ics', etag: '"1"', raw: ics(event('pg-1', { summary: 'Prima' })) },
        { href: 'rotto.ics', etag: '"1"', raw: ics(event('pg-2')) },
      ],
    });
    await apply(context, {
      upserts: [
        { href: 'sano.ics', etag: '"2"', raw: ics(event('pg-1', { summary: 'Dopo' })) },
        { href: 'rotto.ics', etag: '"2"', raw: ics(event('pg-2', { rrule: 'FREQ=WEEKLY;BYDAY=XX' })) },
      ],
    });
    const objs = await sql<Array<{ id: string; href: string; last_good_version_id: string }>>`
      SELECT id, href, last_good_version_id FROM cal_objects WHERE calendar_id = ${id} ORDER BY href
    `;
    const keep = new Set(objs.map((o) => o.last_good_version_id));
    assert.equal(keep.size, 2);
    const now = new Date();
    await sql`UPDATE cal_object_versions SET created_at = ${new Date(now.getTime() - 100 * 86_400_000)} WHERE calendar_id = ${id}`;
    const purged = await purgeExpiredVersions(sql, now);
    assert.ok(purged >= 2);
    const left = await sql<Array<{ id: string }>>`SELECT id FROM cal_object_versions WHERE calendar_id = ${id}`;
    assert.deepEqual(new Set(left.map((v) => v.id)), keep, 'restano solo le ultime buone');
    // La versione buona dell'oggetto in quarantena continua a servire: le sue occorrenze restano stale.
    const rotto = objs.find((o) => o.href === 'rotto.ics');
    const [{ stale }] = await sql<Array<{ stale: boolean }>>`SELECT bool_and(stale) AS stale FROM cal_occurrences WHERE object_id = ${rotto!.id}`;
    assert.equal(stale, true);

    assert.equal(await purgeVersionsForErasure(sql, {}), 0, 'senza filtri non si cancella nulla');
    assert.equal(await purgeVersionsForErasure(sql, { calendarIds: [id] }), 2);
    const after = await sql<Array<{ last_good_version_id: string | null }>>`SELECT last_good_version_id FROM cal_objects WHERE calendar_id = ${id}`;
    assert.ok(after.every((o) => o.last_good_version_id === null), 'ON DELETE SET NULL');
  });
});
