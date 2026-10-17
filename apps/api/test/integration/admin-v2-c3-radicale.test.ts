/**
 * Passo C3 della tranche C dell'API admin v2 contro Radicale 3.7.8 reale
 * (salute e vista; contratto docs/calendar-radicale/contracts/f6-modules.md
 * §9.1.5, §9.1.6, §9.9).
 *
 * Un Radicale con storage multifilesystem in una directory temporanea e il
 * solo caldes-svc (stessa matrice di admin-v2-c2-radicale.test.ts). Lo store è
 * forzato su Radicale; le richieste passano da app.request e i job si eseguono
 * con `runCalendarJobsOnce` (gli handler sono quelli registrati dal cron).
 * "Device" = scrittura e cancellazione dirette su Radicale con il client di
 * servizio, poi la sync che le osserva.
 *
 * Casi: serie giornaliera oltre l'orizzonte → 100 occorrenze su 100 giorni,
 * senza troncamento, anche a cavallo dell'orizzonte (indice più espansione al
 * volo, nessun doppione); cancellazione di massa dal device → hold →
 * occorrenze con badge `hold` che continuano a esistere → anteprima → applica
 * un sottoinsieme (l'hold resta) e poi il resto (indice ripulito, hold caduto,
 * audit senza testo); di nuovo cancellazione di massa → ricostruisci dall'indice
 * (risorse riscritte dall'ultima versione, byte per byte, con gli stessi id,
 * una già tornata dal device saltata, hold caduto); /sync-state coerente con lo
 * stato dell'hold.
 *
 * Senza RADICALE_BIN la suite è saltata con il motivo. Date fisse nel 2034.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import {
  CAL_V2_HOLD_CONFIRMATIONS,
  type CalV2CalendarView,
  type CalV2HoldPlan,
  type CalV2JobAccepted,
  type CalV2JobView,
  type CalV2OccurrenceList,
  type CalV2SyncState,
} from '@calicchia/shared';
import { invalidateBackendModeCache } from '../../src/lib/calendar/backend-mode';
import { CAL_JOB_KINDS, runCalendarJobsOnce, unregisterCalendarJobHandler } from '../../src/lib/calendar/jobs';
import { objectPath, RadicaleClient } from '../../src/lib/calendar/radicale/client';
import { initializeVolume } from '../../src/lib/calendar/radicale/identity';
import { stopIndexWorker } from '../../src/lib/calendar/radicale/indexer';
import { configureRadicaleRuntime, syncCollection, updateWatchMode } from '../../src/lib/calendar/radicale/sync';
import { overrideCalendarStore } from '../../src/lib/calendar/store';
import { registerCalendarHoldJobs } from '../../src/lib/calendar/v2/hold';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql, useTestDatabase } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';
import { api } from '../helpers/http';
import { radicaleAvailability, type RadicaleServer, startRadicale, TEST_PRINCIPAL } from '../helpers/radicale';

useTestDatabase({ resetBaseline: true });
onBeforeDatabaseClose(async () => {
  overrideCalendarStore(null);
  await stopIndexWorker();
  unregisterCalendarJobHandler(CAL_JOB_KINDS.calendarHoldApply);
  unregisterCalendarJobHandler(CAL_JOB_KINDS.calendarHoldRebuild);
  await sql`DELETE FROM cal_jobs WHERE kind IN ('calendar_hold_apply', 'calendar_hold_rebuild')`;
  await resetCalendarBaseline();
});
const fx = useFixtures('admin-v2-c3-int');

const radicale = radicaleAvailability();
const P = TEST_PRINCIPAL;
const SVC_PASSWORD = 'test-only-svc-password-f6-admin-v2-c3';
const BASE = '/api/admin/calendar/v2';
const DAY_MS = 86_400_000;

/** Matrice di caldes-svc del contratto control-plane §8 (R root, RW principal, rwD collezioni). */
const SVC_RIGHTS_RULES = [
  '[root]', 'user: .+', 'collection:', 'permissions: R', '',
  '[svc-principal]', 'user: caldes-svc', `collection: ${P}`, 'permissions: RW', '',
  '[svc-collections]', 'user: caldes-svc', `collection: ${P}/[^/]+`, 'permissions: rwD', '',
].join('\n');

const wrap = (...bodies: string[][]): string => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//C3//IT', ...bodies.flat(), 'END:VCALENDAR', ''].join('\r\n');

const vevent = (uid: string, over: { summary: string; start: string; end: string; extra?: string[] }): string[] => [
  'BEGIN:VEVENT',
  `UID:${uid}`,
  'DTSTAMP:20330101T080000Z',
  `DTSTART:${over.start}`,
  `DTEND:${over.end}`,
  `SUMMARY:${over.summary}`,
  'X-ACME-CUSTOM;X-PARAM=uno:valore',
  'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'DESCRIPTION:Tra poco', 'END:VALARM',
  ...(over.extra ?? []),
  'END:VEVENT',
];

describe('API admin v2, passo C3, contro Radicale reale', { skip: radicale.skip }, () => {
  let rad: RadicaleServer;
  let svc: RadicaleClient;

  const createCalendar = async (name: string): Promise<CalV2CalendarView> => {
    const res = await api.post(`${BASE}/calendars`, { auth: 'admin', body: { name: `${fx.prefix} ${name}` } });
    assert.equal(res.status, 201, res.text);
    return res.json as CalV2CalendarView;
  };

  /** Scrive come un device (PUT con If-None-Match) senza sincronizzare. */
  const put = async (slug: string, href: string, text: string): Promise<void> => {
    await svc.put(objectPath(P, slug, href), text, { ifNoneMatch: '*' });
  };
  const sync = (calendarId: string) => syncCollection(calendarId, { reason: 'manual' });
  const textOf = async (slug: string, href: string): Promise<string | null> => {
    try {
      return (await svc.get(objectPath(P, slug, href))).body;
    } catch (err) {
      if ((err as { code?: string }).code === 'not_found') return null;
      throw err;
    }
  };
  const deleteAll = async (slug: string, hrefs: readonly string[]): Promise<void> => {
    for (const href of hrefs) {
      const cur = await svc.get(objectPath(P, slug, href));
      await svc.delete(objectPath(P, slug, href), { ifMatch: cur.etag as string });
    }
  };

  const occurrences = async (query: string): Promise<CalV2OccurrenceList> => {
    const res = await api.get(`${BASE}/occurrences?${query}`, { auth: 'admin' });
    assert.equal(res.status, 200, res.text);
    return res.json as CalV2OccurrenceList;
  };

  const syncState = async (): Promise<CalV2SyncState> => {
    const res = await api.get(`${BASE}/sync-state`, { auth: 'admin' });
    assert.equal(res.status, 200, res.text);
    return res.json as CalV2SyncState;
  };

  const plan = async (action: 'apply-deletions' | 'rebuild-from-index', calendarId: string, hrefs?: string[]): Promise<CalV2HoldPlan> => {
    const res = await api.post(`${BASE}/collections/${calendarId}/${action}`, { auth: 'admin', body: { mode: 'dry_run', ...(hrefs ? { hrefs } : {}) } });
    assert.equal(res.status, 200, res.text);
    return res.json as CalV2HoldPlan;
  };

  const commit = async (action: 'apply-deletions' | 'rebuild-from-index', calendarId: string, p: CalV2HoldPlan, hrefs?: string[]): Promise<CalV2JobAccepted> => {
    const res = await api.post(`${BASE}/collections/${calendarId}/${action}`, {
      auth: 'admin',
      headers: { 'Idempotency-Key': `chiave-${randomUUID()}` },
      body: {
        mode: 'commit',
        confirm: CAL_V2_HOLD_CONFIRMATIONS[action === 'apply-deletions' ? 'apply_deletions' : 'rebuild_from_index'],
        plan_hash: p.plan_hash,
        ...(hrefs ? { hrefs } : {}),
      },
    });
    assert.equal(res.status, 202, res.text);
    return res.json as CalV2JobAccepted;
  };

  const runUntilClosed = async (id: string, limit = 8): Promise<CalV2JobView> => {
    let view = {} as CalV2JobView;
    for (let i = 0; i < limit; i++) {
      await runCalendarJobsOnce({ limit: 5 });
      const res = await api.get(`${BASE}/jobs/${id}`, { auth: 'admin' });
      assert.equal(res.status, 200, res.text);
      view = res.json as CalV2JobView;
      if (view.status === 'done' || view.status === 'dead') return view;
    }
    return view;
  };

  const holdOf = async (calendarId: string): Promise<{ health: string; pending: string[] } | null> => {
    const [row] = await sql<Array<{ health: string; pending_deletions: string[] }>>`SELECT health, pending_deletions FROM cal_collection_state WHERE calendar_id = ${calendarId}::uuid`;
    return row ? { health: row.health, pending: row.pending_deletions } : null;
  };

  const indexed = async (calendarId: string): Promise<Map<string, string>> =>
    new Map((await sql<Array<{ href: string; id: string }>>`SELECT href, id FROM cal_objects WHERE calendar_id = ${calendarId}::uuid`).map((r) => [r.href, r.id]));

  /** Calendario con `n` eventi scritti dal device e indicizzati. */
  const populate = async (name: string, n: number): Promise<{ cal: CalV2CalendarView; hrefs: string[]; texts: Map<string, string> }> => {
    const cal = await createCalendar(name);
    const slug = cal.collection_name as string;
    const hrefs: string[] = [];
    const texts = new Map<string, string>();
    for (let i = 0; i < n; i++) {
      const uid = `c3-${name}-${i}-${randomUUID().slice(0, 8)}@caldes.test`;
      const href = `${uid}.ics`;
      const day = String(i + 1).padStart(2, '0');
      const text = wrap(vevent(uid, { summary: `Titolo riservato ${name} ${i}`, start: `203403${day}T090000Z`, end: `203403${day}T100000Z` }));
      await put(slug, href, text);
      hrefs.push(href);
      // Il testo di riferimento è quello che Radicale conserva (può riordinare le proprietà), non quello inviato.
      texts.set(href, (await textOf(slug, href)) as string);
    }
    hrefs.sort();
    await sync(cal.id);
    assert.equal((await indexed(cal.id)).size, n, 'tutti gli eventi sono nell\'indice');
    return { cal, hrefs, texts };
  };

  before(async () => {
    rad = await startRadicale({
      label: 'f6-admin-v2-c3',
      auth: { type: 'htpasswd', users: { 'caldes-svc': SVC_PASSWORD } },
      rights: { type: 'from_file', rules: SVC_RIGHTS_RULES },
    });
    svc = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0 });
    const init = await initializeVolume({ db: sql, client: svc, principal: P });
    assert.ok(init.collections.every((c) => c.status === 'created'));
    configureRadicaleRuntime({ client: svc, dataDir: rad.storageDir, principal: P, watch: 'auto', identitySource: 'auto' });
    updateWatchMode('mount', null);
    overrideCalendarStore('radicale');
    registerCalendarHoldJobs();
  });

  after(async () => {
    overrideCalendarStore(null);
    configureRadicaleRuntime(null);
    updateWatchMode('off', 'test concluso');
    svc?.close();
    await rad?.stop();
  });

  // ── Vista ──

  test('serie giornaliera oltre l\'orizzonte: 100 occorrenze su 100 giorni, nessun troncamento', async () => {
    const cal = await createCalendar('serie-lontana');
    const slug = cal.collection_name as string;
    const uid = `c3-serie-${randomUUID().slice(0, 8)}@caldes.test`;
    await put(slug, `${uid}.ics`, wrap(vevent(uid, { summary: 'Serie lontana', start: '20330101T090000Z', end: '20330101T100000Z', extra: ['RRULE:FREQ=DAILY'] })));
    await sync(cal.id);
    const [state] = await sql<Array<{ horizon_end: Date }>>`SELECT horizon_end FROM cal_collection_state WHERE calendar_id = ${cal.id}::uuid`;
    assert.ok(state.horizon_end.getTime() < Date.parse('2034-01-01T00:00:00Z'), 'la finestra è oltre l\'orizzonte dell\'indice');

    const from = Date.parse('2034-01-01T00:00:00Z');
    const q = `from=${new Date(from).toISOString()}&to=${new Date(from + 100 * DAY_MS).toISOString()}&calendar_id=${cal.id}`;
    const list = await occurrences(q);
    assert.equal(list.occurrences.length, 100, 'tutte le occorrenze, nessun troncamento');
    assert.equal(new Set(list.occurrences.map((o) => o.recurrence_key)).size, 100);
    const starts = list.occurrences.map((o) => Date.parse(o.start_utc));
    assert.deepEqual(starts, Array.from({ length: 100 }, (_, i) => from + i * DAY_MS + 9 * 3_600_000), 'un\'occorrenza al giorno alle 09:00 UTC, in ordine');
    assert.ok(list.occurrences.every((o) => o.summary === 'Serie lontana' && o.recurring && o.kind === 'event' && o.badges.length === 0));

    // Finestra più corta: solo le occorrenze che la intersecano.
    const short = await occurrences(`from=${new Date(from + 10 * DAY_MS).toISOString()}&to=${new Date(from + 13 * DAY_MS).toISOString()}&calendar_id=${cal.id}`);
    assert.equal(short.occurrences.length, 3);
  });

  test('a cavallo dell\'orizzonte: indice più espansione al volo, nessun doppione e nessun buco', async () => {
    const cal = await createCalendar('cavallo');
    const slug = cal.collection_name as string;
    const uid = `c3-cavallo-${randomUUID().slice(0, 8)}@caldes.test`;
    const base = new Date();
    const startDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() - 5));
    const stamp = (d: Date, h: string) => `${d.toISOString().slice(0, 10).replaceAll('-', '')}T${h}0000Z`;
    await put(slug, `${uid}.ics`, wrap(vevent(uid, { summary: 'Serie lunga', start: stamp(startDay, '09'), end: stamp(startDay, '10'), extra: ['RRULE:FREQ=DAILY'] })));
    await sync(cal.id);
    const [state] = await sql<Array<{ horizon_end: Date }>>`SELECT horizon_end FROM cal_collection_state WHERE calendar_id = ${cal.id}::uuid`;
    const end = Date.UTC(state.horizon_end.getUTCFullYear(), state.horizon_end.getUTCMonth(), state.horizon_end.getUTCDate());
    const from = end - 50 * DAY_MS;
    const list = await occurrences(`from=${new Date(from).toISOString()}&to=${new Date(from + 100 * DAY_MS).toISOString()}&calendar_id=${cal.id}`);
    assert.equal(list.occurrences.length, 100);
    assert.equal(new Set(list.occurrences.map((o) => o.recurrence_key)).size, 100, 'nessun doppione');
    const starts = list.occurrences.map((o) => Date.parse(o.start_utc));
    assert.deepEqual(starts, Array.from({ length: 100 }, (_, i) => from + i * DAY_MS + 9 * 3_600_000), 'nessun buco');
  });

  // ── Hold: applica ──

  test('cancellazione di massa dal device → hold → anteprima → applica un sottoinsieme e poi il resto', async () => {
    const { cal, hrefs } = await populate('applica', 6);
    const slug = cal.collection_name as string;
    await deleteAll(slug, hrefs);
    const held = await sync(cal.id);
    assert.equal(held.status, 'held', 'la collezione svuotata va in hold');
    const hold = await holdOf(cal.id);
    assert.equal(hold?.health, 'hold');
    assert.deepEqual(hold?.pending, hrefs);
    assert.equal((await indexed(cal.id)).size, 6, 'l\'indice non è toccato: le occorrenze continuano a bloccare');

    // Sync-state e vista vedono l'hold.
    const state = await syncState();
    const col = state.collections.find((c) => c.calendar_id === cal.id);
    assert.equal(col?.health, 'hold');
    assert.equal(col?.hold_reason, 'collection-empty');
    assert.equal(col?.pending_deletions, 6);
    assert.equal(col?.object_count, 6);
    const list = await occurrences(`from=2034-03-01T00:00:00Z&to=2034-03-20T00:00:00Z&calendar_id=${cal.id}`);
    assert.equal(list.occurrences.length, 6);
    assert.ok(list.occurrences.every((o) => o.badges.includes('hold')), 'badge hold su ogni occorrenza');
    assert.ok(list.stale_calendar_ids.includes(cal.id));

    // Anteprima, poi applica due cancellazioni: l'hold resta con le altre quattro.
    const first = hrefs.slice(0, 2);
    const p1 = await plan('apply-deletions', cal.id, first);
    assert.equal(p1.total, 2);
    assert.ok(p1.items.every((i) => i.action === 'remove_from_index'));
    const job1 = await runUntilClosed((await commit('apply-deletions', cal.id, p1, first)).job_id);
    assert.equal(job1.status, 'done', JSON.stringify(job1));
    assert.equal(job1.kind, 'calendar_hold_apply');
    assert.deepEqual(job1.progress, { total: 2, done: 2, failed: 0 });
    assert.equal((job1.result as { applied: number }).applied, 2);
    assert.equal((job1.result as { collection_health: string }).collection_health, 'hold');
    assert.equal((await indexed(cal.id)).size, 4);
    assert.deepEqual((await holdOf(cal.id))?.pending, hrefs.slice(2));

    // Il resto: indice ripulito e hold caduto.
    const rest = await plan('apply-deletions', cal.id);
    assert.equal(rest.total, 4);
    const job2 = await runUntilClosed((await commit('apply-deletions', cal.id, rest)).job_id);
    assert.equal(job2.status, 'done', JSON.stringify(job2));
    assert.equal((job2.result as { applied: number }).applied, 4);
    assert.equal((await indexed(cal.id)).size, 0, 'indice ripulito');
    assert.notEqual((await holdOf(cal.id))?.health, 'hold', 'hold caduto');
    assert.deepEqual((await holdOf(cal.id))?.pending, []);
    const after = await syncState();
    assert.notEqual(after.collections.find((c) => c.calendar_id === cal.id)?.health, 'hold');
    assert.equal((await api.post(`${BASE}/collections/${cal.id}/apply-deletions`, { auth: 'admin', body: { mode: 'dry_run' } })).json.code, 'NOT_IN_HOLD');

    // Audit: una riga per oggetto tolto e una di riepilogo, senza testo di evento.
    const rows = await sql<Array<{ metadata: Record<string, unknown>; old_data: unknown; new_data: unknown }>>`
      SELECT metadata, old_data, new_data FROM audit_logs WHERE metadata->>'operation' = 'v2.hold.apply' AND metadata->>'calendar_id' = ${cal.id}
    `;
    assert.ok(rows.length >= 6 + 2, `righe di audit: ${rows.length}`);
    assert.ok(!JSON.stringify(rows).includes('Titolo riservato'), 'nessun testo di evento nell\'audit');
    const [jobRow] = await sql<Array<{ payload: unknown; result: unknown }>>`SELECT payload, result FROM cal_jobs WHERE id = ${job2.id}::bigint`;
    assert.ok(!JSON.stringify(jobRow).includes('Titolo riservato'), 'nessun testo di evento in cal_jobs');
  });

  // ── Hold: ricostruisci ──

  test('cancellazione di massa → ricostruisci dall\'indice: risorse riscritte dall\'ultima versione, stessi id, hold caduto', async () => {
    const { cal, hrefs, texts } = await populate('ricostruisci', 6);
    const slug = cal.collection_name as string;
    const idsBefore = await indexed(cal.id);
    await deleteAll(slug, hrefs);
    assert.equal((await sync(cal.id)).status, 'held');

    // Un evento torna da solo prima della conferma: l'anteprima lo salta.
    const back = hrefs[0];
    await put(slug, back, texts.get(back) as string);
    const p = await plan('rebuild-from-index', cal.id);
    assert.equal(p.action, 'rebuild_from_index');
    assert.equal(p.total, 6);
    const byHref = new Map(p.items.map((i) => [i.href, i]));
    assert.deepEqual([byHref.get(back)?.action, byHref.get(back)?.reason], ['skip', 'present_in_radicale']);
    const others = p.items.filter((i) => i.href !== back);
    assert.ok(others.every((i) => i.action === 'put_to_radicale' && i.version_id && i.object_id === idsBefore.get(i.href)));

    const job = await runUntilClosed((await commit('rebuild-from-index', cal.id, p)).job_id);
    assert.equal(job.status, 'done', JSON.stringify(job));
    assert.equal(job.kind, 'calendar_hold_rebuild');
    assert.deepEqual(job.progress, { total: 6, done: 6, failed: 0 });
    const result = job.result as { applied: number; skipped: number; failed: unknown[]; collection_health: string };
    assert.equal(result.applied, 5);
    assert.equal(result.skipped, 1);
    assert.deepEqual(result.failed, []);
    assert.equal(result.collection_health, 'healthy');

    // Risorse riscritte come prima (byte per byte), stesso indice, stessi id, hold caduto.
    for (const href of hrefs) assert.equal(await textOf(slug, href), texts.get(href), `${href}: testo identico`);
    const idsAfter = await indexed(cal.id);
    assert.deepEqual([...idsAfter.entries()].sort(), [...idsBefore.entries()].sort(), 'stessi id');
    const hold = await holdOf(cal.id);
    assert.notEqual(hold?.health, 'hold', 'hold caduto');
    assert.deepEqual(hold?.pending, []);
    const state = await syncState();
    assert.equal(state.collections.find((c) => c.calendar_id === cal.id)?.pending_deletions, 0);

    const list = await occurrences(`from=2034-03-01T00:00:00Z&to=2034-03-20T00:00:00Z&calendar_id=${cal.id}`);
    assert.equal(list.occurrences.length, 6);
    assert.deepEqual(new Set(list.occurrences.map((o) => o.object_id)), new Set(idsBefore.values()));
    assert.ok(list.occurrences.every((o) => o.badges.length === 0));

    const rows = await sql<Array<{ metadata: Record<string, unknown>; old_data: unknown; new_data: unknown }>>`
      SELECT metadata, old_data, new_data FROM audit_logs WHERE metadata->>'operation' = 'v2.hold.rebuild' AND metadata->>'calendar_id' = ${cal.id}
    `;
    assert.ok(rows.length >= 5 + 1, `righe di audit: ${rows.length}`);
    assert.ok(!JSON.stringify(rows).includes('Titolo riservato'), 'nessun testo di evento nell\'audit');
  });

  test('applica con write_freeze: il job attende senza consumare tentativi né toccare l\'indice, poi completa', async () => {
    const { cal, hrefs } = await populate('applica-freeze', 3);
    await deleteAll(cal.collection_name as string, hrefs);
    assert.equal((await sync(cal.id)).status, 'held');
    const accepted = await commit('apply-deletions', cal.id, await plan('apply-deletions', cal.id));

    const [prev] = await sql<Array<{ mode: string; write_freeze: boolean }>>`SELECT mode, write_freeze FROM calendar_backend_state WHERE id`;
    await sql`UPDATE calendar_backend_state SET mode = 'radicale', write_freeze = true WHERE id`;
    invalidateBackendModeCache();
    try {
      await runCalendarJobsOnce({ limit: 1 });
      const [waiting] = await sql<Array<{ status: string; attempts: number }>>`SELECT status, attempts FROM cal_jobs WHERE id = ${accepted.job_id}::bigint`;
      assert.equal(waiting.status, 'pending');
      assert.equal(waiting.attempts, 0, 'l\'attesa non conta come tentativo');
      assert.equal((await indexed(cal.id)).size, 3, 'nessuna riga tolta dall\'indice');
      assert.equal((await holdOf(cal.id))?.health, 'hold');
    } finally {
      await sql`UPDATE calendar_backend_state SET mode = ${prev.mode}, write_freeze = ${prev.write_freeze} WHERE id`;
      invalidateBackendModeCache();
    }
    await sql`UPDATE cal_jobs SET run_after = now() WHERE id = ${accepted.job_id}::bigint`;
    const done = await runUntilClosed(accepted.job_id);
    assert.equal(done.status, 'done', JSON.stringify(done));
    assert.equal((done.result as { applied: number }).applied, 3);
    assert.equal((await indexed(cal.id)).size, 0);
  });

  test('ricostruisci dopo applica: le voci cancellate dall\'admin non risorgono, tutte in failed con code changed', async () => {
    const { cal, hrefs } = await populate('rebuild-dopo-apply', 4);
    const slug = cal.collection_name as string;
    await deleteAll(slug, hrefs);
    assert.equal((await sync(cal.id)).status, 'held');

    // Due piani in anteprima sulla stessa collezione, confermati in fila con chiavi diverse: i job sono asincroni.
    const applyPlan = await plan('apply-deletions', cal.id);
    const rebuildPlan = await plan('rebuild-from-index', cal.id);
    const applyAccepted = await commit('apply-deletions', cal.id, applyPlan);
    const rebuildAccepted = await commit('rebuild-from-index', cal.id, rebuildPlan);

    // Prima il job applica, poi la ricostruzione.
    const applied = await runUntilClosed(applyAccepted.job_id);
    assert.equal(applied.status, 'done', JSON.stringify(applied));
    assert.equal((await indexed(cal.id)).size, 0, 'indice ripulito dall\'applica');

    const rebuilt = await runUntilClosed(rebuildAccepted.job_id);
    assert.equal(rebuilt.status, 'done', JSON.stringify(rebuilt));
    const result = rebuilt.result as { applied: number; skipped: number; failed: Array<{ href: string; code: string }> };
    assert.equal(result.applied, 0, 'nessuna voce riscritta');
    assert.equal(result.failed.length, 4, 'tutte le voci in failed');
    assert.ok(result.failed.every((f) => f.code === 'changed'), JSON.stringify(result.failed));
    assert.deepEqual(result.failed.map((f) => f.href).sort(), hrefs);

    for (const href of hrefs) assert.equal(await textOf(slug, href), null, `${href}: non è ricomparsa su Radicale`);
    assert.equal((await indexed(cal.id)).size, 0, 'l\'indice resta senza quegli oggetti');
  });

  test('ricostruisci: senza versione valida la voce è saltata e l\'hold resta per quella', async () => {
    const { cal, hrefs, texts } = await populate('senza-versione', 4);
    const slug = cal.collection_name as string;
    await deleteAll(slug, hrefs);
    assert.equal((await sync(cal.id)).status, 'held');
    // Una versione cancellata (scaduta/rimossa): la ricostruzione non ha da dove riscrivere.
    const idOf = (await indexed(cal.id)).get(hrefs[0]) as string;
    await sql`DELETE FROM cal_object_versions WHERE object_id = ${idOf}::uuid`;
    await sql`UPDATE cal_objects SET last_good_version_id = NULL WHERE id = ${idOf}::uuid`;

    const p = await plan('rebuild-from-index', cal.id);
    const skipped = p.items.filter((i) => i.action === 'skip');
    assert.deepEqual(skipped.map((i) => [i.href, i.reason]), [[hrefs[0], 'no_valid_version']]);
    const job = await runUntilClosed((await commit('rebuild-from-index', cal.id, p)).job_id);
    assert.equal(job.status, 'done', JSON.stringify(job));
    assert.equal((job.result as { applied: number }).applied, 3);
    assert.equal((job.result as { skipped: number }).skipped, 1);
    for (const href of hrefs.slice(1)) assert.equal(await textOf(slug, href), texts.get(href));
    assert.equal(await textOf(slug, hrefs[0]), null);
    // La voce senza versione resta sospesa: l'hold non cade finché l'admin non decide (applica).
    const hold = await holdOf(cal.id);
    assert.equal(hold?.health, 'hold');
    assert.deepEqual(hold?.pending, [hrefs[0]]);
  });
});
