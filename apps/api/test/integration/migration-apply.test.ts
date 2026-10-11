/**
 * Gruppo APPLY della F3 contro Radicale 3.7.8 reale (apps/api/src/lib/
 * calendar/migration/{apply,verify,report}.ts; design §13.6-§13.7; piano F3,
 * voce "Apply" e "Verify"; contratto docs/calendar-radicale/contracts/
 * f3-modules.md §4, §6.3, §7.2 e §8).
 *
 * Un Radicale con storage multifilesystem in una directory temporanea, auth
 * htpasswd con caldes-svc e rights from_file con la matrice di caldes-svc del
 * contratto control-plane §8; volume inizializzato con runInit (marker,
 * collezioni con lo slug di oggi, _canary) sui dati di forma produttiva
 * dell'inventario (c con la serie infinita lun-mar-gio-ven e la serie di
 * giugno con l'UNTIL "fino al", f con festività e "Ferie", Prenotazioni con
 * una proiezione confermata). Il client del runtime passa da un trasporto che
 * registra le richieste e può simulare guasti (connessione caduta DOPO la
 * PUT, UID inserito da altri prima della PUT).
 *
 * Casi del piano F3: (a) update con If-Match; (b) TARGET_NEWER mai
 * sovrascritto, poi "forza" per codice; (c) BOTH_CHANGED, poi "forza" per
 * item; (d) delete con If-Match dell'etag scritto; (e) seconda esecuzione al
 * 100% senza scritture; (f) kill fra la PUT e il ledger → adozione, poi noop;
 * (g) UID a un altro href → adozione (anche dopo un 409 no-uid-conflict) o
 * UID_AT_OTHER_HREF e scrittura forzata lì. In più: rivalidazione dopo un
 * import di backup (REVALIDATION_REQUIRED e forza), PLAN_CHANGED prima di
 * qualunque scrittura, COLLECTION_MISSING senza MKCALENDAR, annullamento
 * pulito a metà con ripresa, id legacy preassegnati, verifica V1-V5 (serie
 * lun-ven con più di 500 occorrenze senza rossi, differenze attese gialle e
 * accettabili con il riporto per firma, V4 identico senza iscrizioni e
 * informativo con le iscrizioni, rosse non accettabili), report JSON e CSV.
 *
 * Senza RADICALE_BIN la suite è saltata con il motivo.
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createEvent, deleteEvent, updateEvent } from '../../src/lib/calendar/events';
import { expandRRule } from '../../src/lib/calendar/legacy/rrule-legacy';
import { type ExecuteContext, executePlanItem, migrationThrottle, runApply } from '../../src/lib/calendar/migration/apply';
import { runInit } from '../../src/lib/calendar/migration/init';
import { buildPlan, runPlan } from '../../src/lib/calendar/migration/plan';
import { acceptDiffs, buildRunReport, calendarVerdicts, latestVerifyVerdicts } from '../../src/lib/calendar/migration/report';
import { runVerify, type VerifyRunSummary } from '../../src/lib/calendar/migration/verify';
import {
  type ApplyParams,
  type ApplySummary,
  DEFAULT_MIGRATION_OPTIONS,
  type InitParams,
  MigrationError,
  type PlanParams,
  type PlanSummary,
  type VerifyParams,
} from '../../src/lib/calendar/migration/types';
import { createNodeTransport, objectPath, RadicaleClient, type RadicaleTransport, TransportError, type TransportRequest } from '../../src/lib/calendar/radicale/client';
import { configureRadicaleRuntime, radicaleRuntime } from '../../src/lib/calendar/radicale/sync';
import type { CalendarEvent } from '../../src/lib/calendar/types';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql, useTestDatabase } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';
import { RADICALE_PLUGINS_DIR, radicaleAvailability, type RadicaleServer, startRadicale, TEST_PRINCIPAL } from '../helpers/radicale';
import { closeActiveRuns, persistedRun, runItems, runToEnd, TEST_ACTOR } from '../calendar/_migration-apply-shared';
import { buildProductionShape, type ProductionShape, rome } from '../calendar/_migration-init-shared';

useTestDatabase({ resetBaseline: true });
onBeforeDatabaseClose(async () => {
  configureRadicaleRuntime(null);
  await resetCalendarBaseline();
});
const fx = useFixtures('mig-apply-rad');

const radicale = radicaleAvailability();
const P = TEST_PRINCIPAL;
const SVC_PASSWORD = 'test-only-svc-password-f3-apply';

const RIGHTS_RULES = [
  '[root]', 'user: .+', 'collection:', 'permissions: R', '',
  '[svc-principal]', 'user: caldes-svc', `collection: ${P}`, 'permissions: RW', '',
  '[svc-collections]', 'user: caldes-svc', `collection: ${P}/[^/]+`, 'permissions: rwD', '',
].join('\n');

interface Recorded { method: string; path: string; ifMatch: string | null; ifNoneMatch: string | null }
interface Fault { match: (req: TransportRequest) => boolean; before?: () => Promise<void>; dropAfter?: boolean }

/** Trasporto node che registra le richieste e applica i guasti programmati (una volta ciascuno). */
function faultyTransport(): { transport: RadicaleTransport; take(): Recorded[]; inject(f: Fault): void; close(): void } {
  const node = createNodeTransport({ maxSockets: 4 });
  let log: Recorded[] = [];
  const faults: Fault[] = [];
  return {
    transport: async (req) => {
      log.push({ method: req.method, path: decodeURIComponent(req.url.pathname), ifMatch: req.headers['If-Match'] ?? null, ifNoneMatch: req.headers['If-None-Match'] ?? null });
      const i = faults.findIndex((f) => f.match(req));
      if (i < 0) return node(req);
      const [fault] = faults.splice(i, 1);
      if (fault.before) await fault.before();
      const res = await node(req);
      if (fault.dropAfter) throw new TransportError('network', 'connessione caduta dopo la richiesta (test)', true, 'ECONNRESET');
      return res;
    },
    take: () => {
      const out = log;
      log = [];
      return out;
    },
    inject: (f) => faults.push(f),
    close: () => node.close(),
  };
}

const writes = (log: Recorded[]): Recorded[] => log.filter((r) => r.method === 'PUT' || r.method === 'DELETE' || r.method === 'MKCOL' || r.method === 'MKCALENDAR');

const OPTIONS = { ...DEFAULT_MIGRATION_OPTIONS, bookings_move_event_ids: [] };

function applyParams(extra: Partial<ApplyParams> = {}): ApplyParams {
  return { scope: {}, options: OPTIONS, expected_plan_hash: null, force_item_ids: [], force_codes: [], follow_up_verify: null, ...extra };
}

async function plan(scope: PlanParams['scope'] = {}): Promise<{ summary: PlanSummary; runId: string }> {
  return runToEnd<PlanParams, PlanSummary>('plan', { scope, options: OPTIONS }, (ctx) => runPlan(ctx));
}

async function apply(extra: Partial<ApplyParams> = {}, opts: Parameters<typeof runToEnd<ApplyParams, ApplySummary>>[3] = {}): Promise<{ summary: ApplySummary; runId: string }> {
  return runToEnd<ApplyParams, ApplySummary>('apply', applyParams(extra), (ctx) => runApply(ctx), opts);
}

async function verify(extra: Partial<VerifyParams> = {}): Promise<{ summary: VerifyRunSummary; runId: string }> {
  const r = await runToEnd<VerifyParams, VerifyRunSummary>('verify', { scope: {}, levels: ['V1', 'V2', 'V3', 'V4', 'V5'], v4_days: 180, ...extra }, async (ctx) => (await runVerify(ctx)) as VerifyRunSummary);
  return { summary: r.summary, runId: r.runId };
}

interface LedgerLite { id: string; href: string; legacy_key: string; written_etag: string | null; written_fingerprint: string | null; intent_op: string | null; adopted: boolean; deleted_at: Date | null; revalidate_reason: string | null; legacy_hash: string | null }

async function ledgerOf(key: string): Promise<LedgerLite[]> {
  return sql<LedgerLite[]>`
    SELECT id::text AS id, href, legacy_key, written_etag, written_fingerprint, intent_op, adopted, deleted_at, revalidate_reason, legacy_hash
    FROM cal_migration_ledger WHERE legacy_key = ${key} ORDER BY id
  `;
}

async function liveRow(key: string): Promise<LedgerLite> {
  const rows = (await ledgerOf(key)).filter((r) => r.deleted_at === null);
  assert.equal(rows.length, 1, `una riga viva per ${key}`);
  return rows[0];
}

describe('apply e verifica della F3 contro Radicale reale', { skip: radicale.skip }, () => {
  let rad: RadicaleServer;
  let svc: RadicaleClient;
  let fault: ReturnType<typeof faultyTransport>;
  let shape: ProductionShape;
  let weekdaySeries: CalendarEvent;

  const pathOf = (collection: string, href: string): string => objectPath(P, collection, href);

  /** Testo voluto dal piano per una chiave (serializer reale). */
  async function plannedIcs(key: string): Promise<{ ics: string; href: string; uid: string; fingerprint: string }> {
    const rt = radicaleRuntime();
    const built = await buildPlan({ db: sql, client: rt.client as RadicaleClient, principal: P, mode: 'apply', scope: {}, options: OPTIONS, now: new Date() });
    const item = built.items.find((i) => i.legacy_key === key && i.source);
    assert.ok(item?.source, `oggetto del piano per ${key}`);
    return { ics: item.source.ics, href: item.source.href, uid: item.source.uid, fingerprint: item.source.fingerprint };
  }

  async function getObject(collection: string, href: string): Promise<{ etag: string | null; body: string } | null> {
    try {
      const got = await svc.get(pathOf(collection, href));
      return { etag: got.etag, body: got.body };
    } catch {
      return null;
    }
  }

  before(async () => {
    rad = await startRadicale({
      label: 'f3-apply',
      auth: { type: 'htpasswd', users: { 'caldes-svc': SVC_PASSWORD } },
      rights: { type: 'from_file', rules: RIGHTS_RULES },
      pythonPath: [RADICALE_PLUGINS_DIR],
    });
    svc = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0 });
    fault = faultyTransport();
    const runtimeClient = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0, transport: fault.transport });
    configureRadicaleRuntime({ client: runtimeClient, dataDir: rad.storageDir, principal: P, watch: 'off', identitySource: 'remote' });
    await resetCalendarBaseline();
    shape = await buildProductionShape(fx, { holidayYears: [2026] });
    // Tutti i calendari con il feed attivo, come in produzione (V5).
    await sql`UPDATE calendars SET ics_feed_enabled = true WHERE role <> 'subscription'`;
    // Serie lun-ven con più di 500 occorrenze sull'intervallo di V3 (oltre il tetto del legacy).
    // DTSTART su un lunedì: un DTSTART fuori dalla regola è sempre un'istanza per RFC 5545 (e per i device), non per il legacy.
    const probe = new Date(Date.now() - 300 * 86_400_000);
    probe.setUTCDate(probe.getUTCDate() - ((probe.getUTCDay() + 6) % 7));
    const start = probe.toISOString().slice(0, 10);
    weekdaySeries = await createEvent({
      calendar_id: shape.lavoro.id, summary: fx.name('Standup'), start_time: rome(start, '09:00'), end_time: rome(start, '09:15'),
      all_day: false, rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', source: 'admin', status: 'confirmed',
    });
    fx.track('eventIds', weekdaySeries.id);
    await runToEnd<InitParams, object>('init', { action: 'initialize' }, (ctx) => runInit(ctx));
    fault.take();
  });

  after(async () => {
    configureRadicaleRuntime(null);
    fault?.close();
    svc?.close();
    await rad?.stop();
  });

  // ─── (e) prima e seconda esecuzione ───────────────────────────────

  test('prima esecuzione: crea tutto con If-None-Match e preassegna gli id legacy; la seconda è al 100% senza scritture', async () => {
    const p = await plan();
    assert.ok(p.summary.totals.create > 15, `create pianificate: ${p.summary.totals.create}`);
    assert.equal(p.summary.totals.conflict, 0);
    fault.take();
    const first = await apply({ expected_plan_hash: p.summary.plan_hash }, { planRunId: p.runId, planHash: p.summary.plan_hash });
    assert.equal(first.summary.writes.create, p.summary.totals.create);
    assert.equal(first.summary.totals.done, p.summary.totals.create);
    assert.equal(first.summary.failed, 0);
    assert.deepEqual(first.summary.conflicts, {});
    assert.equal(first.summary.zero_writes, false);
    const puts = writes(fault.take());
    assert.equal(puts.length, p.summary.totals.create);
    assert.ok(puts.every((r) => r.method === 'PUT' && r.ifNoneMatch === '*' && r.ifMatch === null), 'create solo con If-None-Match: *');

    // Righe 'object' con esito e dettaglio senza dati personali.
    const items = await runItems(first.runId);
    assert.equal(items.filter((i) => i.item_type === 'object').length, p.summary.totals.create + p.summary.totals.skip + p.summary.totals.noop);
    const booking = items.find((i) => i.legacy_key === `booking:${shape.confirmedBookingUid}`);
    assert.ok(booking, 'proiezione nel piano');
    assert.equal(booking.outcome, 'done');
    assert.equal(booking.detail.summary, null, 'mai il titolo di una proiezione nei dettagli');
    assert.ok(!JSON.stringify(items.map((i) => i.detail)).includes('@test.invalid'), 'nessuna email nei dettagli');

    // Id legacy preassegnati (list_events e feed invariati dopo il cutover).
    const ids = await sql<Array<{ id: string; legacy_event_id: string | null; legacy_uid: string | null; href: string }>>`
      SELECT id::text AS id, legacy_event_id::text AS legacy_event_id, legacy_uid, href FROM cal_object_ids
      WHERE calendar_id = ${shape.c.id}::uuid AND recurrence_key = '' AND legacy_event_id = ${shape.infiniteSeries.id}::uuid
    `;
    assert.equal(ids.length, 1);
    assert.equal(ids[0].id, shape.infiniteSeries.id);
    assert.equal(ids[0].legacy_uid, shape.infiniteSeries.uid);
    const row = await liveRow(`event:${shape.infiniteSeries.id}`);
    assert.equal(row.href, ids[0].href);
    assert.ok(row.written_etag && row.written_fingerprint);
    assert.equal(row.intent_op, null);

    const second = await apply();
    assert.equal(second.summary.zero_writes, true, JSON.stringify(second.summary.totals));
    assert.equal(second.summary.totals.done + second.summary.totals.conflict + second.summary.totals.failed, 0);
    assert.deepEqual(writes(fault.take()), [], 'seconda esecuzione senza PUT né DELETE');
  });

  // ─── (a) update ───────────────────────────────

  test('(a) modifica legacy → update con If-Match dell\'etag scritto, poi di nuovo zero scritture', async () => {
    const single = shape.singles[0];
    const before = await liveRow(`event:${single.id}`);
    await updateEvent(single.id, { summary: 'Gestione (spostata)', location: 'Ufficio' });
    fault.take();
    const r = await apply();
    assert.equal(r.summary.writes.update, 1, JSON.stringify(r.summary));
    const put = writes(fault.take());
    assert.equal(put.length, 1);
    assert.equal(put[0].ifMatch, before.written_etag, 'If-Match = etag dell\'ultima scrittura');
    const after = await liveRow(`event:${single.id}`);
    assert.notEqual(after.written_etag, before.written_etag);
    assert.notEqual(after.legacy_hash, before.legacy_hash);
    const obj = await getObject('c', after.href);
    assert.match(obj?.body ?? '', /SUMMARY:Gestione \(spostata\)/);
    assert.equal((await apply()).summary.zero_writes, true);
  });

  // ─── (b) TARGET_NEWER ───────────────────────────────

  test('(b) destinazione cambiata fuori dallo strumento → TARGET_NEWER mai sovrascritto; "forza" per codice riscrive il piano', async () => {
    const single = shape.singles[1];
    const row = await liveRow(`event:${single.id}`);
    const obj = await getObject('c', row.href);
    assert.ok(obj?.etag);
    await svc.put(pathOf('c', row.href), obj.body.replace(/SUMMARY:[^\r\n]*/, 'SUMMARY:Cambiato da un device'), { ifMatch: obj.etag });
    fault.take();
    const r = await apply();
    assert.deepEqual(r.summary.conflicts, { TARGET_NEWER: 1 });
    assert.equal(r.summary.zero_writes, false);
    assert.deepEqual(writes(fault.take()), [], 'nessuna scrittura sul conflitto');
    assert.match((await getObject('c', row.href))?.body ?? '', /SUMMARY:Cambiato da un device/);

    const forced = await apply({ force_codes: ['TARGET_NEWER'] });
    assert.equal(forced.summary.forced, 1);
    const put = writes(fault.take());
    assert.equal(put.length, 1);
    assert.ok(put[0].ifMatch, 'scrittura forzata con If-Match dell\'etag corrente');
    const items = await runItems(forced.runId);
    const it = items.find((i) => i.legacy_key === `event:${single.id}`);
    assert.equal(it?.outcome, 'forced');
    assert.equal(it?.forced, true);
    assert.equal(it?.code, 'TARGET_NEWER');
    assert.doesNotMatch((await getObject('c', row.href))?.body ?? '', /Cambiato da un device/);
    assert.equal((await apply()).summary.zero_writes, true);
  });

  // ─── (c) BOTH_CHANGED ───────────────────────────────

  test('(c) sorgente e destinazione cambiate → BOTH_CHANGED; "forza" per item dell\'anteprima', async () => {
    const single = shape.singles[2];
    const row = await liveRow(`event:${single.id}`);
    const obj = await getObject('c', row.href);
    assert.ok(obj?.etag);
    await svc.put(pathOf('c', row.href), obj.body.replace(/SUMMARY:[^\r\n]*/, 'SUMMARY:Device'), { ifMatch: obj.etag });
    await updateEvent(single.id, { description: 'Nota aggiornata in admin' });
    const r = await apply();
    assert.deepEqual(r.summary.conflicts, { BOTH_CHANGED: 1 });
    fault.take();

    const p = await plan();
    const items = await runItems(p.runId);
    const conflict = items.find((i) => i.item_type === 'object' && i.code === 'BOTH_CHANGED');
    assert.ok(conflict, 'riga del conflitto nell\'anteprima');
    // Senza la conferma di forza (nessun item né codice) resta un conflitto.
    const forced = await apply({ force_item_ids: [conflict.id], expected_plan_hash: p.summary.plan_hash }, { planRunId: p.runId, planHash: p.summary.plan_hash });
    assert.equal(forced.summary.forced, 1, JSON.stringify(forced.summary));
    assert.equal(writes(fault.take()).length, 1);
    const body = (await getObject('c', row.href))?.body ?? '';
    assert.match(body, /Nota aggiornata in admin/);
    assert.doesNotMatch(body, /SUMMARY:Device/);
    assert.equal((await apply()).summary.zero_writes, true);
  });

  // ─── (d) delete ───────────────────────────────

  test('(d) evento cancellato in PG → DELETE con If-Match dell\'etag scritto e riga ritirata', async () => {
    const copy = shape.duplicateCopy;
    const row = await liveRow(`event:${copy.id}`);
    assert.equal(await deleteEvent(copy.id), true);
    fault.take();
    const r = await apply();
    assert.equal(r.summary.writes.delete, 1, JSON.stringify(r.summary));
    const del = writes(fault.take());
    assert.equal(del.length, 1);
    assert.equal(del[0].method, 'DELETE');
    assert.equal(del[0].ifMatch, row.written_etag);
    assert.equal(await getObject('c', row.href), null);
    const rows = await ledgerOf(`event:${copy.id}`);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].deleted_at, 'riga ritirata');
    assert.equal(rows[0].written_etag, null);
    assert.equal((await apply()).summary.zero_writes, true);
  });

  // ─── (f) kill fra la PUT e il ledger ───────────────────────────────

  test('(f) connessione caduta dopo la PUT (esito ignoto) → intento pendente; la riesecuzione adotta come noop', async () => {
    const ev = await fx.event({ calendar: shape.c, summary: 'Riunione dopo il crash', start_time: rome('2026-11-05', '11:00'), end_time: rome('2026-11-05', '12:00'), source: 'admin' });
    fault.inject({ match: (req) => req.method === 'PUT' && req.headers['If-None-Match'] === '*', dropAfter: true });
    const first = await apply();
    assert.equal(first.summary.failed, 1, JSON.stringify(first.summary));
    const pending = await liveRow(`event:${ev.id}`);
    assert.equal(pending.intent_op, 'create', 'intento rimasto pendente');
    assert.equal(pending.written_etag, null);
    assert.ok(await getObject('c', pending.href), 'la PUT era arrivata a Radicale');
    fault.take();

    const second = await apply();
    assert.equal(second.summary.adopted, 1, JSON.stringify(second.summary));
    assert.deepEqual(writes(fault.take()), [], 'adozione senza scrivere');
    const adopted = await liveRow(`event:${ev.id}`);
    assert.equal(adopted.intent_op, null);
    assert.ok(adopted.written_etag);
    const third = await apply();
    assert.equal(third.summary.zero_writes, true);
    assert.equal(third.summary.totals.noop > 0, true);
  });

  // ─── (g) UID a un altro href ───────────────────────────────

  test('(g) UID già a un altro href con lo stesso contenuto → adozione di quell\'href (il nome non cambia più)', async () => {
    const ev = await fx.event({ calendar: shape.c, summary: 'Importato a mano', start_time: rome('2026-11-06', '15:00'), end_time: rome('2026-11-06', '16:00'), source: 'admin' });
    const wanted = await plannedIcs(`event:${ev.id}`);
    await svc.put(pathOf('c', 'altro-href-uguale.ics'), wanted.ics, { ifNoneMatch: '*' });
    fault.take();
    const r = await apply();
    assert.equal(r.summary.adopted, 1, JSON.stringify(r.summary));
    assert.deepEqual(writes(fault.take()), []);
    const row = await liveRow(`event:${ev.id}`);
    assert.equal(row.href, 'altro-href-uguale.ics');
    assert.equal(row.adopted, true);
    assert.equal(await getObject('c', wanted.href), null, 'nessuna copia al vecchio href');
    assert.equal((await apply()).summary.zero_writes, true);
  });

  test('(g) UID a un altro href con un contenuto diverso → UID_AT_OTHER_HREF; "forza" scrive all\'href trovato', async () => {
    const ev = await fx.event({ calendar: shape.c, summary: 'Conteso', start_time: rome('2026-11-09', '10:00'), end_time: rome('2026-11-09', '11:00'), source: 'admin' });
    const wanted = await plannedIcs(`event:${ev.id}`);
    await svc.put(pathOf('c', 'altro-href-diverso.ics'), wanted.ics.replace(/SUMMARY:[^\r\n]*/, 'SUMMARY:Versione diversa'), { ifNoneMatch: '*' });
    const r = await apply();
    assert.deepEqual(r.summary.conflicts, { UID_AT_OTHER_HREF: 1 });
    fault.take();
    const forced = await apply({ force_codes: ['UID_AT_OTHER_HREF'] });
    assert.equal(forced.summary.forced, 1, JSON.stringify(forced.summary));
    const put = writes(fault.take());
    assert.equal(put.length, 1);
    assert.equal(put[0].path, pathOf('c', 'altro-href-diverso.ics'));
    assert.ok(put[0].ifMatch);
    const row = await liveRow(`event:${ev.id}`);
    assert.equal(row.href, 'altro-href-diverso.ics');
    assert.doesNotMatch((await getObject('c', 'altro-href-diverso.ics'))?.body ?? '', /Versione diversa/);
    assert.equal((await apply()).summary.zero_writes, true);
  });

  test('(g) 409 no-uid-conflict durante la PUT (UID inserito da altri dopo l\'anteprima) → adozione dell\'href trovato', async () => {
    const ev = await fx.event({ calendar: shape.c, summary: 'In gara', start_time: rome('2026-11-10', '10:00'), end_time: rome('2026-11-10', '11:00'), source: 'admin' });
    const wanted = await plannedIcs(`event:${ev.id}`);
    fault.inject({
      match: (req) => req.method === 'PUT' && decodeURIComponent(req.url.pathname) === pathOf('c', wanted.href),
      before: async () => {
        await svc.put(pathOf('c', 'inserito-in-gara.ics'), wanted.ics, { ifNoneMatch: '*' });
      },
    });
    const r = await apply();
    assert.equal(r.summary.adopted, 1, JSON.stringify(r.summary));
    const row = await liveRow(`event:${ev.id}`);
    assert.equal(row.href, 'inserito-in-gara.ics');
    assert.equal(row.intent_op, null);
    fault.take();
    assert.equal((await apply()).summary.zero_writes, true);
  });

  // ─── Rivalidazione ───────────────────────────────

  test('rivalidazione dopo un import di backup: le scritture diventano REVALIDATION_REQUIRED, i noop smarcano, "forza" scrive', async () => {
    const [{ marked }] = await sql<Array<{ marked: number }>>`SELECT cal_migration_ledger_require_revalidation('backup-import') AS marked`;
    assert.ok(marked > 10);
    const target = shape.singles[0];
    await updateEvent(target.id, { summary: 'Gestione (dopo il ripristino)' });
    fault.take();
    const r = await apply();
    assert.deepEqual(r.summary.conflicts, { REVALIDATION_REQUIRED: 1 });
    assert.deepEqual(writes(fault.take()), [], 'mai una sovrascrittura senza conferma');
    const [{ remaining }] = await sql<Array<{ remaining: number }>>`SELECT count(*)::int AS remaining FROM cal_migration_ledger WHERE deleted_at IS NULL AND revalidate_reason IS NOT NULL`;
    assert.equal(remaining, 1, 'i noop hanno tolto la marcatura alle altre righe');
    const forced = await apply({ force_codes: ['REVALIDATION_REQUIRED'] });
    assert.equal(forced.summary.forced, 1);
    assert.equal(writes(fault.take()).length, 1);
    const row = await liveRow(`event:${target.id}`);
    assert.equal(row.revalidate_reason, null);
    assert.equal((await apply()).summary.zero_writes, true);
  });

  // ─── PLAN_CHANGED ───────────────────────────────

  test('PLAN_CHANGED: il piano cambiato dopo l\'anteprima ferma l\'apply prima di qualunque scrittura', async () => {
    const p = await plan();
    await updateEvent(shape.singles[1].id, { location: 'Sala riunioni' });
    fault.take();
    await assert.rejects(
      apply({ expected_plan_hash: p.summary.plan_hash }, { planRunId: p.runId, planHash: p.summary.plan_hash }),
      (err: unknown) => err instanceof MigrationError && err.code === 'PLAN_CHANGED',
    );
    assert.deepEqual(writes(fault.take()), []);
    const ok = await apply();
    assert.equal(ok.summary.writes.update, 1);
    fault.take();
  });

  // ─── COLLECTION_MISSING ───────────────────────────────

  test('collezione mancante: conflitto COLLECTION_MISSING e nessuna MKCOL o MKCALENDAR', async () => {
    const nuovo = await fx.calendar({ key: 'senza-collezione', blocks_availability: true });
    await fx.event({ calendar: nuovo, summary: 'Orfano di collezione', start_time: rome('2026-11-12', '09:00'), end_time: rome('2026-11-12', '10:00') });
    fault.take();
    const r = await apply({ scope: { calendar_ids: [nuovo.id] } });
    assert.deepEqual(r.summary.conflicts, { COLLECTION_MISSING: 1 });
    const log = fault.take();
    assert.ok(!log.some((x) => x.method === 'MKCOL' || x.method === 'MKCALENDAR' || x.method === 'PUT'));
    // Fuori dal piano per i casi successivi.
    await sql`DELETE FROM calendars WHERE id = ${nuovo.id}::uuid`;
  });

  // ─── Annullamento ───────────────────────────────

  test('annullamento a metà: CANCELLED fra un item e l\'altro, righe salvate e ledger coerente; la ripresa completa', async () => {
    const created: CalendarEvent[] = [];
    for (let i = 0; i < 6; i++) {
      created.push(await fx.event({ calendar: shape.c, summary: `Lotto ${i}`, start_time: rome('2026-12-01', `${String(9 + i).padStart(2, '0')}:00`), end_time: rome('2026-12-01', `${String(9 + i).padStart(2, '0')}:30`), source: 'admin' }));
    }
    let writesSeen = 0;
    await assert.rejects(
      apply({}, {
        onProgress: (p, cancel) => {
          if (p.phase === 'write') writesSeen++;
          if (writesSeen === 3) cancel();
        },
      }),
      (err: unknown) => err instanceof MigrationError && err.code === 'CANCELLED',
    );
    const [run] = await sql<Array<{ id: string; status: string }>>`SELECT id::text AS id, status FROM cal_migration_runs WHERE kind = 'apply' ORDER BY created_at DESC LIMIT 1`;
    assert.equal(run.status, 'cancelled');
    const rows = await runItems(run.id);
    assert.ok(rows.length >= 3, 'righe già eseguite salvate');
    const [{ pending }] = await sql<Array<{ pending: number }>>`SELECT count(*)::int AS pending FROM cal_migration_ledger WHERE intent_op IS NOT NULL`;
    assert.equal(pending, 0, 'mai un intento lasciato a metà da un annullamento');
    const resumed = await apply();
    assert.ok(resumed.summary.writes.create > 0 && resumed.summary.writes.create < created.length, JSON.stringify(resumed.summary.writes));
    assert.equal((await apply()).summary.zero_writes, true);
    fault.take();
  });

  // ─── Verifica ───────────────────────────────

  test('verifica V1-V5: serie lun-ven con più di 500 occorrenze senza rossi; unica differenza attesa l\'UNTIL riallineato (giallo)', async () => {
    // Il legacy sull'intervallo intero si fermerebbe a 500 occorrenze: le finestre servono.
    const from = new Date(Date.now() - 365 * 86_400_000).toISOString();
    const to = new Date(Date.now() + 730 * 86_400_000).toISOString();
    const capped = expandRRule({ rrule: weekdaySeries.rrule as string, masterStartIso: new Date(weekdaySeries.start_time).toISOString(), fromIso: from, toIso: to });
    assert.equal(capped.length, 500, 'tetto del legacy raggiunto sull\'intervallo intero');

    const { summary, runId } = await verify();
    const byId = new Map(summary.calendars.map((c) => [c.calendar_id, c]));
    const lavoro = byId.get(shape.lavoro.id);
    assert.equal(lavoro?.color, 'green', `lavoro: ${JSON.stringify((await runItems(runId)).filter((i) => i.calendar_id === shape.lavoro.id).map((i) => ({ level: i.level, code: i.code, key: i.legacy_key, detail: i.detail })))}`);
    for (const cal of [shape.f, shape.bookings]) assert.equal(byId.get(cal.id)?.color, 'green', `${cal.slug}: ${JSON.stringify(byId.get(cal.id))}`);
    const c = byId.get(shape.c.id);
    assert.equal(c?.color, 'yellow', JSON.stringify(c));
    assert.equal(summary.totals.unexpected, 0, JSON.stringify((await runItems(runId)).filter((i) => i.expected === false).map((i) => ({ level: i.level, code: i.code, key: i.legacy_key, detail: i.detail }))));
    assert.equal(summary.overall, 'yellow');
    assert.equal(summary.acceptable, false, 'giallo da accettare');
    assert.equal(summary.v4?.without_subscriptions, 'green', 'busy identico senza iscrizioni');
    const diffs = (await runItems(runId)).filter((i) => i.item_type === 'diff');
    assert.ok(diffs.length > 0);
    assert.ok(diffs.every((d) => d.detail.reason === 'UNTIL_REALIGNED' && d.legacy_key === `event:${shape.juneSeries.id}`), JSON.stringify(diffs.map((d) => [d.level, d.code, d.detail.reason, d.legacy_key])));
    assert.ok(diffs.every((d) => typeof d.detail.signature === 'string' && /^[0-9a-f]{64}$/.test(d.detail.signature as string)));

    // Accettazione esplicita e riporto per firma sul run successivo.
    const accepted = await acceptDiffs(sql, { runId, calendarId: shape.c.id, actor: TEST_ACTOR });
    assert.equal(accepted.accepted, diffs.length);
    assert.equal(accepted.acceptable, true);
    assert.equal((await calendarVerdicts(sql, runId)).find((v) => v.calendar_id === shape.c.id)?.accepted, true);
    const next = await verify();
    assert.equal(next.summary.acceptable, true, 'accettazioni riportate per firma');
    assert.equal(next.summary.carried_over, diffs.length);
    const latest = await latestVerifyVerdicts(sql);
    assert.equal(latest.runId, next.runId);
    assert.equal(latest.acceptable, true);
  });

  test('verifica V4 con le iscrizioni: righe informative fuori dal colore', async () => {
    const day = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    await fx.subscription({
      calendar: shape.c,
      events: [{ remote_uid: 'sub-1@remoto.test', summary: 'Evento remoto', description: null, location: null, url: null, start_time: rome(day, '15:00'), end_time: rome(day, '16:00'), all_day: false, rrule: null, exdates: [], recurrence_id: null, status: 'confirmed' }],
    });
    const { summary, runId } = await verify({ levels: ['V4'], v4_days: 30 });
    assert.equal(summary.v4?.without_subscriptions, 'green');
    assert.equal(summary.v4?.with_subscriptions, 'yellow');
    assert.equal(summary.calendars.find((c) => c.calendar_id === shape.c.id)?.color, 'green', 'le iscrizioni non entrano nel colore');
    const info = (await runItems(runId)).filter((i) => i.item_type === 'diff');
    assert.ok(info.length >= 1);
    assert.ok(info.every((i) => i.detail.variant === 'with_subscriptions' && i.expected === true && i.severity === 'info'));
    // Una verifica parziale (solo V4) non diventa "l'ultima verifica" del wizard.
    assert.notEqual((await latestVerifyVerdicts(sql)).runId, runId);
  });

  test('verifica con una destinazione cambiata: rossi V1/V2/V3 non accettabili; report JSON e CSV senza dati personali', async () => {
    const row = await liveRow(`event:${shape.singles[1].id}`);
    const obj = await getObject('c', row.href);
    assert.ok(obj?.etag);
    await svc.put(pathOf('c', row.href), obj.body.replace(/DTSTART;TZID=Europe\/Rome:(\d{8})T090000/, 'DTSTART;TZID=Europe/Rome:$1T100000').replace(/DTEND;TZID=Europe\/Rome:(\d{8})T100000/, 'DTEND;TZID=Europe/Rome:$1T110000'), { ifMatch: obj.etag });
    const { summary, runId } = await verify({ scope: { calendar_ids: [shape.c.id] }, levels: ['V1', 'V2', 'V3'] });
    assert.equal(summary.overall, 'red');
    const red = (await runItems(runId)).filter((i) => i.item_type === 'diff' && i.expected === false);
    const codes = new Set(red.map((i) => `${i.level}:${i.code}`));
    assert.ok(codes.has('V1:LEDGER_ETAG_MISMATCH'), [...codes].join(','));
    assert.ok(codes.has('V2:CONTENT_MISMATCH'), [...codes].join(','));
    assert.ok(codes.has('V3:OCCURRENCE_TIME_DIFF'), [...codes].join(','));
    await assert.rejects(acceptDiffs(sql, { runId, itemIds: [red[0].id], actor: TEST_ACTOR }), (err: unknown) => err instanceof MigrationError && err.code === 'NOT_ACCEPTABLE');

    const json = await buildRunReport(sql, runId, 'json');
    assert.match(json.filename, /^migrazione-calendario-verify-\d{8}-[0-9a-f]{8}\.json$/);
    const parsed = JSON.parse(json.body) as { run: { id: string }; readable: { overall: string }; items: unknown[]; verdicts: unknown[] };
    assert.equal(parsed.run.id, runId);
    assert.equal(parsed.readable.overall, 'red');
    assert.equal(parsed.items.length, red.length + (await runItems(runId)).filter((i) => i.expected === true).length);
    const csv = await buildRunReport(sql, runId, 'csv');
    assert.equal(csv.contentType, 'text/csv; charset=utf-8');
    assert.ok(csv.body.startsWith('﻿id,seq,item_type'));
    const applyRun = await sql<Array<{ id: string }>>`SELECT id::text AS id FROM cal_migration_runs WHERE kind = 'apply' AND status = 'succeeded' ORDER BY created_at LIMIT 1`;
    const applyReport = await buildRunReport(sql, applyRun[0].id, 'json');
    assert.ok(!applyReport.body.includes('@test.invalid') && !applyReport.body.includes('333 0000000'), 'nessuna email né telefono nel report');

    // Ripristino: l'apply forzato riporta la destinazione al piano.
    const fixed = await apply({ force_codes: ['TARGET_NEWER'] });
    assert.equal(fixed.summary.forced, 1);
    await closeActiveRuns();
  });

  // ─── Precondizioni, ripresa, patch, shadow, spostamenti ───────────────────────────────

  test('app-password attiva con username riservato: l\'apply rifiuta (PREFLIGHT_BLOCKING) prima di scrivere', async () => {
    const app = await fx.appPassword({ username: 'federico' });
    await sql`UPDATE caldav_app_passwords SET username = 'caldes-legacy' WHERE id = ${app.row.id}`;
    await fx.event({ calendar: shape.c, summary: 'In attesa della revoca', start_time: rome('2026-12-03', '09:00'), end_time: rome('2026-12-03', '10:00'), source: 'admin' });
    fault.take();
    await assert.rejects(apply(), (err: unknown) => err instanceof MigrationError && err.code === 'PRECONDITION_FAILED' && (err.details?.reasons as string[]).includes('PREFLIGHT_BLOCKING'));
    assert.deepEqual(writes(fault.take()), []);
    await sql`UPDATE caldav_app_passwords SET revoked_at = now() WHERE id = ${app.row.id}`;
    assert.equal((await apply()).summary.writes.create, 1);
    fault.take();
  });

  test('ripresa dopo un crash dell\'esecutore (tentativo 2 dello stesso run): niente duplicati e scritture precedenti contate', async () => {
    for (let i = 0; i < 5; i++) {
      await fx.event({ calendar: shape.c, summary: `Crash ${i}`, start_time: rome('2026-12-02', `${String(9 + i).padStart(2, '0')}:00`), end_time: rome('2026-12-02', `${String(9 + i).padStart(2, '0')}:30`), source: 'admin' });
    }
    let seen = 0;
    const first = await persistedRun('apply', applyParams(), {
      onProgress: (p) => {
        if (p.phase === 'write' && ++seen === 4) throw new Error('crash simulato dell\'esecutore');
      },
    });
    await assert.rejects(runApply(first.ctx), /crash simulato/);
    const before = (await runItems(first.ctx.runId)).filter((r) => r.outcome === 'done').length;
    assert.ok(before >= 1 && before < 5, `scritture del primo tentativo: ${before}`);
    // Il run resta 'running' (processo morto): l'esecutore lo riprende con attempt = 2.
    const resumed = await persistedRun('apply', applyParams(), { runId: first.ctx.runId, attempt: 2 });
    const summary = await runApply(resumed.ctx) as ApplySummary & { previous_attempt_writes: number; attempt: number };
    await resumed.finish({ summary });
    assert.equal(summary.attempt, 2);
    assert.equal(summary.previous_attempt_writes, before);
    assert.equal(summary.writes.create, 5, 'cinque create in tutto, nessuna ripetuta');
    assert.equal(summary.totals.done, 5 - before);
    const rows = (await runItems(first.ctx.runId)).filter((r) => r.outcome === 'done');
    assert.equal(rows.length, 5);
    assert.deepEqual([...new Set(rows.map((r) => r.detail.attempt))].sort(), [1, 2]);
    assert.equal((await apply()).summary.zero_writes, true);
    fault.take();
  });

  test('riga adottata: l\'update passa dalla patch per campo sull\'oggetto corrente', async () => {
    const ev = await fx.event({ calendar: shape.c, summary: 'Adottato da aggiornare', start_time: rome('2026-12-04', '15:00'), end_time: rome('2026-12-04', '16:00'), source: 'admin' });
    const wanted = await plannedIcs(`event:${ev.id}`);
    await svc.put(pathOf('c', 'adottato-patch.ics'), wanted.ics, { ifNoneMatch: '*' });
    assert.equal((await apply()).summary.adopted, 1);
    await updateEvent(ev.id, { location: 'Sala grande' });
    fault.take();
    const r = await apply();
    assert.equal(r.summary.writes.update, 1, JSON.stringify(r.summary));
    const it = (await runItems(r.runId)).find((i) => i.legacy_key === `event:${ev.id}`);
    assert.equal(it?.detail.patch, true);
    assert.ok((it?.detail.fields as string[]).includes('location'), JSON.stringify(it?.detail.fields));
    assert.match((await getObject('c', 'adottato-patch.ics'))?.body ?? '', /LOCATION:Sala grande/);
    assert.equal((await apply()).summary.zero_writes, true);
    fault.take();
  });

  test('shadow: patch per campo sull\'oggetto corrente (VALARM preservato) e un solo nuovo tentativo dopo un 412', async () => {
    const ev = await fx.event({ calendar: shape.c, summary: 'Con promemoria', start_time: rome('2026-12-07', '10:00'), end_time: rome('2026-12-07', '11:00'), source: 'admin' });
    assert.equal((await apply()).summary.writes.create, 1);
    const row = await liveRow(`event:${ev.id}`);
    const obj = await getObject('c', row.href);
    assert.ok(obj?.etag);
    const alarm = 'BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nDESCRIPTION:Promemoria\r\nEND:VALARM\r\n';
    await svc.put(pathOf('c', row.href), obj.body.replace('END:VEVENT', `${alarm}END:VEVENT`), { ifMatch: obj.etag });
    await updateEvent(ev.id, { summary: 'Con promemoria (spostato)' });

    const rt = radicaleRuntime();
    const ctx: ExecuteContext = { db: sql, client: rt.client as RadicaleClient, principal: P, runId: null, actor: 'system:shadow', mode: 'shadow', forced: false, throttle: migrationThrottle(), now: () => new Date() };
    const shadowPlan = await buildPlan({ db: sql, client: ctx.client, principal: P, mode: 'shadow', scope: {}, options: OPTIONS, legacyKeys: [`event:${ev.id}`], now: new Date() });
    const it = shadowPlan.items.find((i) => i.legacy_key === `event:${ev.id}`);
    assert.equal(it?.action, 'update');
    assert.equal(it?.patch, true);
    // Una modifica concorrente prima della PUT: 412, rilettura e nuovo tentativo con la patch.
    fault.inject({
      match: (req) => req.method === 'PUT' && decodeURIComponent(req.url.pathname) === pathOf('c', row.href),
      before: async () => {
        const cur = await getObject('c', row.href);
        await svc.put(pathOf('c', row.href), (cur?.body ?? '').replace('END:VEVENT', 'X-DEVICE-NOTE:conservata\r\nEND:VEVENT'), { ifMatch: cur?.etag as string });
      },
    });
    fault.take();
    const res = await executePlanItem(it as NonNullable<typeof it>, ctx);
    assert.equal(res.outcome, 'done', JSON.stringify(res));
    assert.equal(writes(fault.take()).filter((r) => r.method === 'PUT').length, 2, 'una PUT respinta con 412 e una riuscita');
    const body = (await getObject('c', row.href))?.body ?? '';
    assert.match(body, /SUMMARY:[^\r\n]*Con promemoria \(spostato\)/);
    assert.match(body, /BEGIN:VALARM/);
    assert.match(body, /X-DEVICE-NOTE:conservata/);
    const after = await liveRow(`event:${ev.id}`);
    assert.equal(after.intent_op, null);
    // L'apply notturno non insegue il testo del device: nessuna scrittura.
    assert.equal((await apply()).summary.zero_writes, true);
    fault.take();
  });

  test('spostamento della decisione 8: create nella nuova collezione prima della delete nella vecchia; V3 e V5 gialli NON_PROJECTION_MOVED', async () => {
    const ev = await fx.event({ calendar: shape.bookings, summary: 'Nota manuale in Prenotazioni', start_time: rome('2026-12-09', '12:00'), end_time: rome('2026-12-09', '13:00'), source: 'admin' });
    assert.equal((await apply()).summary.writes.create, 1);
    fault.take();
    const moveOptions = { ...OPTIONS, bookings_move_event_ids: [ev.id], bookings_move_target_calendar_id: shape.lavoro.id };
    const moved = await apply({ options: moveOptions });
    assert.equal(moved.summary.writes.create, 1, JSON.stringify(moved.summary));
    assert.equal(moved.summary.writes.delete, 1);
    const log = writes(fault.take());
    const putIdx = log.findIndex((r) => r.method === 'PUT' && r.path.startsWith(`/${P}/lavoro/`));
    const delIdx = log.findIndex((r) => r.method === 'DELETE' && r.path.startsWith(`/${P}/bookings/`));
    assert.ok(putIdx >= 0 && delIdx > putIdx, `prima la PUT in lavoro, poi la DELETE in bookings: ${JSON.stringify(log)}`);

    const { summary, runId } = await verify({ levels: ['V3', 'V5'], scope: { calendar_ids: [shape.bookings.id, shape.lavoro.id] } });
    const diffs = (await runItems(runId)).filter((i) => i.item_type === 'diff' && i.legacy_key === `event:${ev.id}`);
    assert.ok(diffs.length >= 2, JSON.stringify(diffs.map((d) => [d.level, d.code])));
    assert.ok(diffs.every((d) => d.expected === true && d.detail.reason === 'NON_PROJECTION_MOVED'), JSON.stringify(diffs.map((d) => [d.level, d.code, d.detail.reason])));
    assert.equal(summary.calendars.find((c) => c.calendar_id === shape.bookings.id)?.color, 'yellow');
    assert.equal(summary.calendars.find((c) => c.calendar_id === shape.lavoro.id)?.color, 'yellow');

    // Ritorno alla scelta di default: l'evento torna in Prenotazioni, poi nessuna scrittura.
    const back = await apply();
    assert.equal(back.summary.writes.create, 1, JSON.stringify(back.summary));
    assert.equal(back.summary.writes.delete, 1);
    assert.equal((await apply()).summary.zero_writes, true);
    fault.take();
  });

  test('l\'apply prende il lock cal-migration se l\'esecutore non lo tiene e lo rilascia alla fine', async () => {
    const r = await apply();
    assert.equal(r.summary.zero_writes, true);
    const [{ held }] = await sql<Array<{ held: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_locks l WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
          AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtext('cal-migration')::bigint
      ) AS held
    `;
    assert.equal(held, false, 'lock rilasciato a fine run');
  });
});
