/**
 * Anteprima e piano della migrazione contro Radicale 3.7.8 reale (gruppo
 * SERIALIZE della F3: apps/api/src/lib/calendar/migration/{serialize,plan}.ts;
 * design §13.4-§13.6, §13.8; contratto
 * docs/calendar-radicale/contracts/f3-modules.md §4, §6.2 e §7.2).
 *
 * Un Radicale con storage multifilesystem in una directory temporanea, auth
 * htpasswd con caldes-svc, rights della matrice di caldes-svc e la patch di
 * fedeltà dell'immagine; volume inizializzato con runInit (l'unico punto di
 * MKCOL/MKCALENDAR) sui dati di forma produttiva (`c`, `f`, Prenotazioni).
 * Le scritture che in produzione fa apply.ts (gruppo APPLY) qui le fa un
 * esecutore minimo del test: PUT con le stesse precondizioni e riga del ledger
 * come la lascia la transazione 2 del protocollo (§4.3).
 *
 * Casi:
 *  - runPlan sul volume vuoto: create e skip, righe 'object' e 'anomaly',
 *    plan_hash uguale a quello di buildPlan, anteprima per calendario;
 *  - dopo le scritture: seconda esecuzione al 100% noop e skip, anche per lo
 *    shadow per chiave; readTargetSnapshot legge il contenuto solo dove serve;
 *  - modifica legacy → update (patch per campo nello shadow, VALARM della
 *    destinazione preservato); destinazione cambiata → TARGET_NEWER
 *    (apply) / noop (shadow); entrambe → BOTH_CHANGED;
 *  - destinazione non tracciata con lo stesso contenuto → adopt; UID a un altro
 *    href → adopt di quell'href; fonte sparita → delete; collezione mancante →
 *    COLLECTION_MISSING;
 *  - ambito parziale con lo spostamento della decisione 8: Prenotazioni e la
 *    destinazione sempre insieme.
 *
 * Senza RADICALE_BIN la suite è saltata con il motivo.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { parseCalendarObject, semanticFingerprint } from '@calicchia/calendar-core';
import { logger } from '../../src/lib/logger';
import { createCalendar, getCalendar } from '../../src/lib/calendar/calendars';
import { runInit } from '../../src/lib/calendar/migration/init';
import {
  buildPlan,
  effectivePlanScope,
  planHash,
  readTargetSnapshot,
  runPlan,
} from '../../src/lib/calendar/migration/plan';
import {
  DEFAULT_MIGRATION_OPTIONS,
  type InitParams,
  type LegacyKey,
  MigrationError,
  type MigrationItemInput,
  type MigrationRunContext,
  type MigrationRunKind,
  type PlanItem,
  type PlanParams,
  type SerializedObject,
} from '../../src/lib/calendar/migration/types';
import { collectionPath, objectPath, RadicaleClient } from '../../src/lib/calendar/radicale/client';
import { configureRadicaleRuntime, invalidateIdentityCache } from '../../src/lib/calendar/radicale/sync';
import type { Calendar } from '../../src/lib/calendar/types';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql, useTestDatabase } from '../helpers/db';
import { romeIso, useFixtures } from '../helpers/fixtures';
import { RADICALE_PLUGINS_DIR, radicaleAvailability, type RadicaleServer, startRadicale, TEST_PRINCIPAL } from '../helpers/radicale';

useTestDatabase({ resetBaseline: true });
onBeforeDatabaseClose(async () => {
  configureRadicaleRuntime(null);
  await resetCalendarBaseline();
});
const fx = useFixtures('mig-plan-rad');

const radicale = radicaleAvailability();
const P = TEST_PRINCIPAL;
const SVC_PASSWORD = 'test-only-svc-password-f3-plan';

const RIGHTS_RULES = [
  '[root]', 'user: .+', 'collection:', 'permissions: R', '',
  '[svc-principal]', 'user: caldes-svc', `collection: ${P}`, 'permissions: RW', '',
  '[svc-collections]', 'user: caldes-svc', `collection: ${P}/[^/]+`, 'permissions: rwD', '',
].join('\n');

// ─── Contesto dei run ───────────────────────────────

async function insertRun(kind: MigrationRunKind, params: object): Promise<string> {
  await sql`
    UPDATE cal_migration_runs SET status = 'succeeded', finished_at = now(), started_at = coalesce(started_at, now())
    WHERE status IN ('queued', 'running')
  `;
  const [row] = await sql<Array<{ id: string }>>`
    INSERT INTO cal_migration_runs (kind, status, trigger, requested_by, params, started_at, attempts)
    VALUES (${kind}, 'running', 'admin', 'admin:test-plan', ${sql.json(params as never)}, now(), 1)
    RETURNING id::text AS id
  `;
  return row.id;
}

async function runContext<P extends object>(kind: MigrationRunKind, params: P): Promise<{ ctx: MigrationRunContext<P>; items: MigrationItemInput[] }> {
  const runId = await insertRun(kind, params);
  const items: MigrationItemInput[] = [];
  const controller = new AbortController();
  const ctx: MigrationRunContext<P> = {
    runId, kind, trigger: 'admin', actor: 'admin:test-plan', params, planRunId: null, planHash: null, attempt: 1,
    signal: controller.signal, log: logger.child({ scope: 'test-migration-plan' }), db: sql,
    async progress() {},
    async addItems(rows) {
      const ids = rows.map((_, i) => String(items.length + i + 1));
      items.push(...rows);
      return ids;
    },
    throwIfCancelled() {
      if (controller.signal.aborted) throw new MigrationError('CANCELLED', 'Run annullato');
    },
  };
  return { ctx, items };
}

describe('anteprima e piano della F3 contro Radicale reale', { skip: radicale.skip }, () => {
  let rad: RadicaleServer;
  let svc: RadicaleClient;
  const cal: Record<string, Calendar> = {};
  const ids: Record<string, string> = {};
  let confirmedUid = '';

  const NOW = (): Date => new Date();

  function plan(opts: { mode?: 'apply' | 'shadow'; keys?: LegacyKey[]; scope?: { calendar_ids?: string[] }; options?: Partial<typeof DEFAULT_MIGRATION_OPTIONS> } = {}) {
    return buildPlan({
      db: sql, client: svc, principal: P, mode: opts.mode ?? 'apply', scope: opts.scope ?? {},
      options: { ...DEFAULT_MIGRATION_OPTIONS, ...(opts.options ?? {}) }, legacyKeys: opts.keys, now: NOW(),
    });
  }

  function itemOf(items: PlanItem[], key: string, calendarId?: string): PlanItem {
    const found = items.filter((i) => i.legacy_key === key && (!calendarId || i.calendar_id === calendarId));
    assert.equal(found.length, 1, `atteso un item per ${key}, trovati ${found.length}: ${JSON.stringify(found.map((f) => [f.calendar_id, f.action, f.code]))}`);
    return found[0];
  }

  /**
   * Esecutore minimo (al posto di apply.ts, gruppo APPLY): create con
   * If-None-Match, update con If-Match, delete con If-Match, adozioni; riga del
   * ledger con lo stato della transazione 2 del protocollo (§4.3).
   */
  async function execute(items: PlanItem[]): Promise<void> {
    for (const item of items) {
      const s = item.source;
      if (item.action === 'create' && s) {
        const res = await svc.put(objectPath(P, s.collection_name, s.href), s.ics, { ifNoneMatch: '*' });
        await recordWritten(s, res.etag ?? (await svc.get(objectPath(P, s.collection_name, s.href))).etag, item.ledger?.id ?? null);
      } else if (item.action === 'update' && s && item.target?.etag) {
        const href = item.other_href ?? s.href;
        const res = await svc.put(objectPath(P, s.collection_name, href), s.ics, { ifMatch: item.target.etag });
        await recordWritten(s, res.etag ?? (await svc.get(objectPath(P, s.collection_name, href))).etag, item.ledger?.id ?? null);
      } else if (item.action === 'delete' && item.ledger && item.target?.etag) {
        await svc.delete(objectPath(P, item.collection_name, item.href), { ifMatch: item.target.etag });
        await sql`UPDATE cal_migration_ledger SET deleted_at = now(), written_etag = NULL, written_at = NULL, written_fingerprint = NULL, legacy_hash = NULL WHERE id = ${item.ledger.id}`;
      } else if (item.action === 'adopt' && s && (item.target || item.other_href)) {
        const href = item.other_href ?? s.href;
        const got = await svc.get(objectPath(P, s.collection_name, href));
        await recordWritten({ ...s, href }, got.etag, item.ledger?.id ?? null, true);
      }
    }
  }

  async function recordWritten(s: SerializedObject, etag: string | null, ledgerId: string | null, adopted = false): Promise<void> {
    if (ledgerId) {
      await sql`
        UPDATE cal_migration_ledger SET href = ${s.href}, legacy_snapshot = ${sql.json(s.legacy_snapshot as never)}, legacy_hash = ${s.legacy_hash},
          written_etag = ${etag}, written_fingerprint = ${s.fingerprint}, written_at = now(), adopted = adopted OR ${adopted}, updated_at = now()
        WHERE id = ${ledgerId}
      `;
      return;
    }
    await sql`
      INSERT INTO cal_migration_ledger (calendar_id, collection_name, href, kind, legacy_key, legacy_event_id, uid, legacy_snapshot, legacy_hash,
                                        written_etag, written_fingerprint, written_at, adopted)
      VALUES (${s.calendar_id}, ${s.collection_name}, ${s.href}, ${s.kind}, ${s.legacy_key}, ${s.legacy_event_id}, ${s.uid},
              ${sql.json(s.legacy_snapshot as never)}, ${s.legacy_hash}, ${etag}, ${s.fingerprint}, now(), ${adopted})
    `;
  }

  async function ledgerRow(key: string): Promise<{ id: string; href: string; calendar_id: string; written_etag: string } | null> {
    const [row] = await sql<Array<{ id: string; href: string; calendar_id: string; written_etag: string }>>`
      SELECT id::text AS id, href, calendar_id::text AS calendar_id, written_etag FROM cal_migration_ledger WHERE legacy_key = ${key} AND deleted_at IS NULL
    `;
    return row ?? null;
  }

  before(async () => {
    rad = await startRadicale({
      label: 'f3-plan',
      auth: { type: 'htpasswd', users: { 'caldes-svc': SVC_PASSWORD } },
      rights: { type: 'from_file', rules: RIGHTS_RULES },
      pythonPath: [RADICALE_PLUGINS_DIR],
    });
    svc = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0 });
    configureRadicaleRuntime({ client: svc, dataDir: rad.storageDir, principal: P, watch: 'off', identitySource: 'remote' });
    invalidateIdentityCache();
    await resetCalendarBaseline();

    cal.c = await createCalendar({ slug: 'c', name: 'Creattivamente SRL', timezone: 'Europe/Rome', blocks_availability: true });
    fx.track('calendarIds', cal.c.id);
    cal.f = await fx.holidayCalendar({ slug: 'f' });
    await sql`UPDATE calendars SET is_system = false, origin = 'admin' WHERE id = ${cal.f.id}`;
    cal.lavoro = (await getCalendar('lavoro')) as Calendar;
    cal.bookings = (await getCalendar('bookings')) as Calendar;

    const series = await fx.series({
      calendar: cal.c, summary: 'Gestione Creattivamente', prefixSummary: false, start_time: romeIso('2026-08-10', '09:00'), end_time: romeIso('2026-08-10', '10:00'),
      rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,TH,FR', source: 'admin',
      overrides: [{ originalStart: romeIso('2026-08-11', '09:00'), start: romeIso('2026-08-11', '11:00'), end: romeIso('2026-08-11', '12:00') }, { originalStart: romeIso('2026-08-13', '09:00'), status: 'cancelled' }],
    });
    ids.series = series.master.id;
    ids.single = (await fx.event({ calendar: cal.c, summary: 'Riunione', start_time: romeIso('2026-11-03', '09:00'), end_time: romeIso('2026-11-03', '10:00'), source: 'admin' })).id;
    ids.toDelete = (await fx.event({ calendar: cal.c, summary: 'Da cancellare', start_time: romeIso('2026-11-04', '09:00'), end_time: romeIso('2026-11-04', '10:00') })).id;
    ids.untracked = (await fx.event({ calendar: cal.c, summary: 'Già nel volume', start_time: romeIso('2026-11-05', '09:00'), end_time: romeIso('2026-11-05', '10:00') })).id;
    ids.elsewhere = (await fx.event({ calendar: cal.c, summary: 'Altro href', start_time: romeIso('2026-11-06', '09:00'), end_time: romeIso('2026-11-06', '10:00') })).id;
    const holidays = await fx.holidays(cal.f, { year: 2026 });
    ids.christmas = holidays.find((h) => h.source_id === 'it-holiday-2026-12-25')!.id;
    ids.ferie = (await fx.closure(cal.f, { from: '2026-07-27', to: '2026-08-09', summary: 'Ferie' })).id;
    const eventType = await fx.eventType({ key: 'consulenza' });
    const confirmed = await fx.booking({ eventType, start: romeIso('2026-11-10', '15:00'), status: 'confirmed', attendee: { name: 'Mario Rossi', phone: '+39 333 1234567' } });
    confirmedUid = confirmed.booking.uid;
    await fx.booking({ eventType, start: romeIso('2026-06-01', '15:00'), status: 'cancelled', project: false });
    ids.bookingsManual = (await fx.event({ calendar: cal.bookings, summary: 'Promemoria', start_time: romeIso('2026-11-07', '15:00'), end_time: romeIso('2026-11-07', '16:00'), source: 'manual' })).id;
    const sub = await fx.subscription({
      calendar: cal.lavoro,
      events: [{
        remote_uid: 'remoto-1@feed.example', summary: 'Evento remoto', description: null, location: null, url: null,
        start_time: romeIso('2026-11-02', '10:00'), end_time: romeIso('2026-11-02', '11:00'), all_day: false, rrule: null, exdates: [],
        recurrence_id: null, status: 'confirmed',
      } as never],
    });
    ids.subscription = sub.subscription.id;

    const init = await runContext<InitParams>('init', { action: 'initialize' });
    const summary = await runInit(init.ctx);
    assert.equal(summary.epoch, 1);
  });

  after(async () => {
    configureRadicaleRuntime(null);
    svc?.close();
    await rad?.stop();
  });

  test('runPlan sul volume appena inizializzato: create e skip, righe object e anomaly, hash di buildPlan, anteprima', async () => {
    const run = await runContext<PlanParams>('plan', { scope: {}, options: { ...DEFAULT_MIGRATION_OPTIONS } });
    const summary = await runPlan(run.ctx);
    assert.match(summary.plan_hash, /^[0-9a-f]{64}$/);
    assert.equal(summary.totals.update + summary.totals.delete + summary.totals.conflict + summary.totals.noop + summary.totals.adopt, 0);
    assert.ok(summary.totals.create >= 20, `create: ${summary.totals.create}`);
    assert.equal(summary.writes, summary.totals.create);
    assert.equal(summary.revalidation_pending, 0);
    const objects = run.items.filter((i) => i.item_type === 'object');
    const anomalies = run.items.filter((i) => i.item_type === 'anomaly');
    assert.equal(objects.length, Object.values(summary.totals).reduce((a, b) => a + b, 0));
    assert.ok(anomalies.some((a) => a.code === 'NON_PROJECTION_IN_BOOKINGS'));
    const projection = objects.find((o) => o.legacy_key === `booking:${confirmedUid}`);
    assert.equal(projection?.action, 'create');
    assert.equal(projection?.href, `booking-${confirmedUid}.ics`);
    assert.equal((projection?.detail as { summary: string | null }).summary, null, 'nessun nome del cliente nelle righe');
    assert.ok(!JSON.stringify(run.items).includes('Mario Rossi'));
    assert.ok(!JSON.stringify(run.items).includes('333 1234567'));
    const preview = summary.preview;
    const c = preview.calendars.find((x) => x.calendar_id === cal.c.id);
    assert.equal(c?.collection_name, 'c');
    assert.ok((c?.counts.create ?? 0) >= 5);
    assert.deepEqual(preview.bookings_move_candidates.map((m) => m.event_id), [ids.bookingsManual]);
    // Iscrizioni: mai nel piano, flag per singola iscrizione con i default della decisione 5 e l'impatto.
    assert.deepEqual(preview.subscription_defaults, { blocks_availability: false, device_visible: false });
    const sub = preview.subscriptions.find((x) => x.subscription_id === ids.subscription);
    assert.ok(sub, 'iscrizione nell\'anteprima');
    assert.equal(sub.blocks_availability, false);
    assert.equal(sub.device_visible, false);
    assert.equal(sub.events_legacy, 1);
    assert.ok(!objects.some((o) => o.calendar_id === cal.lavoro.id && (o.detail as { summary: string | null }).summary === 'Evento remoto'));
    // Stesso piano ricalcolato: stesso hash (l'apply si ferma se cambia).
    const again = await plan();
    assert.equal(again.hash, summary.plan_hash);
    assert.equal(planHash(again.items), summary.plan_hash);
  });

  test('dopo le scritture: seconda esecuzione al 100% noop/skip, anche nello shadow per chiave', async () => {
    const first = await plan();
    await execute(first.items);
    const second = await plan();
    const writes = second.items.filter((i) => ['create', 'update', 'delete', 'conflict'].includes(i.action));
    assert.deepEqual(writes.map((i) => `${i.legacy_key}:${i.action}:${i.code}`), []);
    assert.ok(second.items.every((i) => i.action === 'noop' || i.action === 'skip'));
    // La lettura della destinazione non ha chiesto il contenuto degli oggetti invariati.
    const coll = second.target.collections.get(cal.c.id);
    assert.ok(coll?.exists);
    assert.ok([...coll.objects.values()].every((t) => t.raw === null), 'nessun multiget per gli oggetti con etag invariata');
    // Shadow per chiave: solo l'oggetto della chiave, letto con un multiget.
    const shadow = await plan({ mode: 'shadow', keys: [`event:${ids.series}` as LegacyKey] });
    assert.deepEqual(shadow.items.map((i) => `${i.legacy_key}:${i.action}`), [`event:${ids.series}:noop`]);
    // Il fingerprint semantico del testo salvato da Radicale è quello voluto (fedeltà).
    const row = await ledgerRow(`event:${ids.series}`);
    const got = await svc.get(objectPath(P, 'c', row!.href));
    const parsed = parseCalendarObject(got.body);
    assert.ok(parsed.ok);
    assert.equal(semanticFingerprint(parsed.value), itemOf(second.items, `event:${ids.series}`).source?.fingerprint);
  });

  test('modifica legacy → update (patch per campo nello shadow con VALARM della destinazione preservato)', async () => {
    await sql`UPDATE calendar_events SET summary = 'Gestione Creattivamente (aggiornata)' WHERE id = ${ids.series}`;
    const apply = itemOf((await plan()).items, `event:${ids.series}`);
    assert.equal(apply.action, 'update');
    assert.deepEqual(apply.fields, ['summary']);
    assert.equal(apply.patch, false);

    // La destinazione riceve un VALARM (per esempio dopo un rollback): lo shadow aggiorna solo il titolo.
    const row = (await ledgerRow(`event:${ids.series}`))!;
    const path = objectPath(P, 'c', row.href);
    const current = await svc.get(path);
    const withAlarm = current.body.replace('END:VEVENT', 'BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Promemoria\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VEVENT');
    await svc.put(path, withAlarm, { ifMatch: current.etag! });
    const shadow = await plan({ mode: 'shadow', keys: [`event:${ids.series}` as LegacyKey] });
    const item = itemOf(shadow.items, `event:${ids.series}`);
    assert.equal(item.action, 'update');
    assert.equal(item.patch, true);
    assert.deepEqual(item.fields, ['summary']);
    assert.equal(itemOf((await plan()).items, `event:${ids.series}`).code, 'BOTH_CHANGED', 'apply: entrambe cambiate');
    // Ripristino per i casi successivi.
    await sql`UPDATE calendar_events SET summary = 'Gestione Creattivamente' WHERE id = ${ids.series}`;
    const fresh = await svc.get(path);
    await svc.put(path, current.body, { ifMatch: fresh.etag! });
    const restored = await svc.get(path);
    await sql`UPDATE cal_migration_ledger SET written_etag = ${restored.etag} WHERE id = ${row.id}`;
    assert.equal(itemOf((await plan()).items, `event:${ids.series}`).action, 'noop');
  });

  test('destinazione cambiata fuori dallo strumento: TARGET_NEWER (apply), noop (shadow)', async () => {
    const row = (await ledgerRow(`event:${ids.single}`))!;
    const path = objectPath(P, 'c', row.href);
    const current = await svc.get(path);
    await svc.put(path, current.body.replace('SUMMARY:', 'SUMMARY:[telefono] '), { ifMatch: current.etag! });
    const apply = itemOf((await plan()).items, `event:${ids.single}`);
    assert.equal(apply.action, 'conflict');
    assert.equal(apply.code, 'TARGET_NEWER');
    const shadow = itemOf((await plan({ mode: 'shadow', keys: [`event:${ids.single}` as LegacyKey] })).items, `event:${ids.single}`);
    assert.equal(shadow.action, 'noop');
  });

  test('destinazione non tracciata con lo stesso contenuto → adopt; UID a un altro href → adopt di quell\'href', async () => {
    // Riga del ledger persa (per esempio dopo un ripristino del DB): l'oggetto resta nel volume.
    const untracked = (await ledgerRow(`event:${ids.untracked}`))!;
    await sql`DELETE FROM cal_migration_ledger WHERE id = ${untracked.id}`;
    const adopt = itemOf((await plan()).items, `event:${ids.untracked}`);
    assert.equal(adopt.action, 'adopt');
    assert.equal(adopt.href, untracked.href);

    // Stesso oggetto spostato a un altro href (MOVE da un client): il piano lo trova per UID.
    const moved = (await ledgerRow(`event:${ids.elsewhere}`))!;
    const from = objectPath(P, 'c', moved.href);
    const body = (await svc.get(from)).body;
    const otherHref = `${randomUUID()}.ics`;
    await svc.delete(from, { ifMatch: moved.written_etag });
    await svc.put(objectPath(P, 'c', otherHref), body, { ifNoneMatch: '*' });
    await sql`DELETE FROM cal_migration_ledger WHERE id = ${moved.id}`;
    const elsewhere = itemOf((await plan()).items, `event:${ids.elsewhere}`);
    assert.equal(elsewhere.action, 'adopt');
    assert.equal(elsewhere.other_href, otherHref);
    await execute([adopt, elsewhere]);
    const after = await plan();
    assert.equal(itemOf(after.items, `event:${ids.untracked}`).action, 'noop');
    assert.equal(itemOf(after.items, `event:${ids.elsewhere}`).action, 'noop');
    assert.equal(itemOf(after.items, `event:${ids.elsewhere}`).href, otherHref, 'l\'href adottato resta quello dell\'oggetto');
  });

  test('fonte sparita → delete con If-Match; collezione mancante → COLLECTION_MISSING', async () => {
    const row = (await ledgerRow(`event:${ids.toDelete}`))!;
    await sql`DELETE FROM calendar_events WHERE id = ${ids.toDelete}`;
    const del = itemOf((await plan()).items, `event:${ids.toDelete}`);
    assert.equal(del.action, 'delete');
    assert.equal(del.target?.etag, row.written_etag);
    await execute([del]);
    assert.equal((await plan()).items.some((i) => i.legacy_key === `event:${ids.toDelete}`), false, 'riga ritirata: niente più item');

    const nuovo = await fx.calendar({ key: 'nuovo' });
    const ev = await fx.event({ calendar: nuovo, summary: 'Senza collezione', start_time: romeIso('2026-11-08', '09:00'), end_time: romeIso('2026-11-08', '10:00') });
    const missing = itemOf((await plan()).items, `event:${ev.id}`);
    assert.equal(missing.action, 'conflict');
    assert.equal(missing.code, 'COLLECTION_MISSING');
    const snap = await readTargetSnapshot(svc, P, [{ calendar_id: nuovo.id, collection_name: nuovo.slug }], { needContent: () => true });
    assert.equal(snap.collections.get(nuovo.id)?.exists, false);
    const only = await readTargetSnapshot(svc, P, [{ calendar_id: nuovo.id, collection_name: nuovo.slug }], { needContent: () => true, only: new Map([[nuovo.id, new Set(['x.ics'])]]) });
    assert.equal(only.collections.get(nuovo.id)?.exists, false);
    await sql`DELETE FROM calendar_events WHERE id = ${ev.id}`;
  });

  test('ambito parziale: Prenotazioni e destinazione degli spostamenti sempre insieme (nessun delete senza la create)', async () => {
    const options = { ...DEFAULT_MIGRATION_OPTIONS, bookings_move_event_ids: [ids.bookingsManual] };
    const scope = await effectivePlanScope(sql, { calendar_ids: [cal.bookings.id] }, options);
    assert.deepEqual(scope.calendar_ids, [cal.bookings.id, cal.lavoro.id].sort());
    const unrelated = await effectivePlanScope(sql, { calendar_ids: [cal.c.id] }, options);
    assert.deepEqual(unrelated.calendar_ids, [cal.c.id]);

    const moved = await plan({ scope: { calendar_ids: [cal.bookings.id] }, options: { bookings_move_event_ids: [ids.bookingsManual] } });
    const key = `event:${ids.bookingsManual}`;
    assert.equal(itemOf(moved.items, key, cal.lavoro.id).action, 'create');
    assert.equal(itemOf(moved.items, key, cal.bookings.id).action, 'delete');
    await execute(moved.items.filter((i) => i.legacy_key === key));
    // Ora lo spostamento è scritto: un piano limitato a `lavoro` comprende Prenotazioni (spostamento dal ledger).
    const back = await effectivePlanScope(sql, { calendar_ids: [cal.lavoro.id] }, { ...DEFAULT_MIGRATION_OPTIONS });
    assert.deepEqual(back.calendar_ids, [cal.bookings.id, cal.lavoro.id].sort());
    const stay = await plan({ scope: { calendar_ids: [cal.lavoro.id] }, options: { bookings_move_event_ids: [ids.bookingsManual] } });
    assert.equal(itemOf(stay.items, key).action, 'noop');
  });
});
