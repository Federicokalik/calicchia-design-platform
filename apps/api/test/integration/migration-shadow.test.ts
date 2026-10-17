/**
 * Shadow mirror, proiezioni e GDPR contro Radicale 3.7.8 reale (gruppo
 * SHADOW della F3: apps/api/src/lib/calendar/migration/shadow.ts,
 * radicale/booking-projection.ts, gdpr.ts, cron/italian-holidays.ts; design
 * §13.8, §16.4; decisione 3; contratto
 * docs/calendar-radicale/contracts/f3-modules.md §6.4, §9 e §13).
 *
 * Un Radicale con storage multifilesystem in una directory temporanea, auth
 * htpasswd con caldes-svc e la matrice dei permessi di caldes-svc; volume
 * inizializzato con runInit sui dati di forma produttiva (c con la serie
 * infinita lun-mar-gio-ven, f con le festività e "Ferie", Prenotazioni con una
 * proiezione confermata) e migrato con un apply reale.
 *
 * Casi:
 *  - trigger della 165 → job shadow_mirror → handler, da capo a fondo: una
 *    modifica legacy su un oggetto a cui Radicale ha aggiunto VALARM e X-*
 *    arriva come patch per campo con If-Match, VALARM e X-* preservati;
 *  - shadow spento: nessun job dal trigger, un job pending si chiude senza
 *    scrivere;
 *  - lock cal-migration occupato da un run: il job si riaccoda senza
 *    consumare tentativi;
 *  - erasure GDPR con lo shadow spento: la proiezione su Radicale diventa
 *    "Prenotazione" e l'email sparisce dagli eventi migrati;
 *  - proiezione oltre i 24 mesi (e prenotazione anonimizzata) con lo store
 *    Radicale: risorsa riscritta con If-Match sui soli campi della decisione
 *    3, VALARM preservato, poi nessuna riscrittura;
 *  - festività con lo store Radicale: If-None-Match, 412 per quelle già
 *    migrate con l'UID legacy, mai MKCALENDAR senza collezione.
 *
 * Senza RADICALE_BIN la suite è saltata con il motivo.
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { getTextValue, parseCalendarObject } from '@calicchia/calendar-core';
import { italianHolidaysWindow, runItalianHolidaysOnRadicale } from '../../src/cron/italian-holidays';
import { buildBookingProjectionIcs, syncBookingProjection } from '../../src/lib/calendar/booking-projection';
import { readBackendStateFresh } from '../../src/lib/calendar/backend-mode';
import { createEvent, updateEvent } from '../../src/lib/calendar/events';
import { calendarErase } from '../../src/lib/calendar/gdpr';
import { enqueueCalendarJob, runCalendarJobsOnce } from '../../src/lib/calendar/jobs';
import { runApply } from '../../src/lib/calendar/migration/apply';
import { runInit } from '../../src/lib/calendar/migration/init';
import { runPlan } from '../../src/lib/calendar/migration/plan';
import { registerShadowMirrorJob } from '../../src/lib/calendar/migration/shadow';
import {
  type ApplyParams,
  type ApplySummary,
  DEFAULT_MIGRATION_OPTIONS,
  type InitParams,
  MIGRATION_LOCK_KEY,
  type PlanParams,
  type PlanSummary,
} from '../../src/lib/calendar/migration/types';
import { objectPath, RadicaleClient } from '../../src/lib/calendar/radicale/client';
import { configureRadicaleRuntime } from '../../src/lib/calendar/radicale/sync';
import { overrideCalendarStore } from '../../src/lib/calendar/store';
import type { Booking, CalendarEvent } from '../../src/lib/calendar/types';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql, useTestDatabase } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';
import { RADICALE_PLUGINS_DIR, radicaleAvailability, type RadicaleServer, startRadicale, TEST_PRINCIPAL } from '../helpers/radicale';
import { runToEnd } from '../calendar/_migration-apply-shared';
import { buildProductionShape, type ProductionShape, rome } from '../calendar/_migration-init-shared';

useTestDatabase({ resetBaseline: true });
onBeforeDatabaseClose(async () => {
  overrideCalendarStore(null);
  configureRadicaleRuntime(null);
  await resetCalendarBaseline();
});
const fx = useFixtures('mig-shadow-rad');

const radicale = radicaleAvailability();
const P = TEST_PRINCIPAL;
const SVC_PASSWORD = 'test-only-svc-password-f3-shadow';

const RIGHTS_RULES = [
  '[root]', 'user: .+', 'collection:', 'permissions: R', '',
  '[svc-principal]', 'user: caldes-svc', `collection: ${P}`, 'permissions: RW', '',
  '[svc-collections]', 'user: caldes-svc', `collection: ${P}/[^/]+`, 'permissions: rwD', '',
].join('\n');

const OPTIONS = { ...DEFAULT_MIGRATION_OPTIONS, bookings_move_event_ids: [] };
const VALARM = 'BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Promemoria\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\n';
const XPROP = 'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC\r\n';

describe('shadow mirror, proiezioni e GDPR contro Radicale reale', { skip: radicale.skip }, () => {
  let rad: RadicaleServer;
  let svc: RadicaleClient;
  let shape: ProductionShape;
  let single: CalendarEvent;

  const pathOf = (collection: string, href: string): string => objectPath(P, collection, href);

  async function liveRow(key: string): Promise<{ id: string; href: string; collection_name: string; written_etag: string | null }> {
    const rows = await sql<Array<{ id: string; href: string; collection_name: string; written_etag: string | null }>>`
      SELECT id::text AS id, href, collection_name, written_etag FROM cal_migration_ledger WHERE legacy_key = ${key} AND deleted_at IS NULL
    `;
    assert.equal(rows.length, 1, `una riga viva del ledger per ${key}`);
    return rows[0];
  }

  /** Aggiunge VALARM e una X-prop all'oggetto su Radicale, come farebbe un device dopo un rollback. */
  async function addDeviceProperties(collection: string, href: string): Promise<void> {
    const current = await svc.get(pathOf(collection, href));
    const body = current.body.replace(/END:VEVENT\r?\n/, `${XPROP}${VALARM}END:VEVENT\r\n`);
    await svc.put(pathOf(collection, href), body, { ifMatch: current.etag! });
  }

  async function jobsFor(key: string): Promise<Array<{ id: string; status: string; attempts: number; run_after: Date; result: Record<string, unknown> | null; last_error: string | null }>> {
    return sql`SELECT id::text AS id, status, attempts, run_after, result, last_error FROM cal_jobs WHERE kind = 'shadow_mirror' AND key = ${key} ORDER BY id`;
  }

  /** Esegue subito i job shadow_mirror pending (salta il debounce di 2 s). */
  async function runShadowJobs(): Promise<void> {
    await sql`UPDATE cal_jobs SET run_after = now() WHERE kind = 'shadow_mirror' AND status = 'pending'`;
    await runCalendarJobsOnce({ limit: 20 });
  }

  async function setShadow(enabled: boolean): Promise<void> {
    await sql`UPDATE calendar_backend_state SET shadow_enabled = ${enabled}, shadow_since = ${enabled ? sql`now()` : null} WHERE id = true`;
  }

  before(async () => {
    rad = await startRadicale({
      label: 'f3-shadow',
      auth: { type: 'htpasswd', users: { 'caldes-svc': SVC_PASSWORD } },
      rights: { type: 'from_file', rules: RIGHTS_RULES },
      pythonPath: [RADICALE_PLUGINS_DIR],
    });
    svc = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0 });
    configureRadicaleRuntime({ client: svc, dataDir: rad.storageDir, principal: P, watch: 'off', identitySource: 'remote' });
    await resetCalendarBaseline();
    shape = await buildProductionShape(fx, { holidayYears: [2026] });
    single = await createEvent({
      calendar_id: shape.lavoro.id, summary: fx.name('Riunione con il cliente'), description: `Contatto: ${fx.email('cliente-conf')}`,
      start_time: rome('2026-11-12', '09:00'), end_time: rome('2026-11-12', '10:00'), all_day: false, source: 'admin', status: 'confirmed',
    });
    fx.track('eventIds', single.id);
    await runToEnd<InitParams, object>('init', { action: 'initialize' }, (ctx) => runInit(ctx));
    const plan = await runToEnd<PlanParams, PlanSummary>('plan', { scope: {}, options: OPTIONS }, (ctx) => runPlan(ctx));
    const applied = await runToEnd<ApplyParams, ApplySummary>(
      'apply',
      { scope: {}, options: OPTIONS, expected_plan_hash: plan.summary.plan_hash, force_item_ids: [], force_codes: [], follow_up_verify: null },
      (ctx) => runApply(ctx),
      { planRunId: plan.runId, planHash: plan.summary.plan_hash },
    );
    assert.equal(applied.summary.failed, 0);
    assert.deepEqual(applied.summary.conflicts, {});
    registerShadowMirrorJob();
  });

  after(async () => {
    overrideCalendarStore(null);
    configureRadicaleRuntime(null);
    svc?.close();
    await rad?.stop();
  });

  test('trigger → job → handler: modifica legacy con VALARM su Radicale preservato (patch per campo, If-Match)', async () => {
    const key = `event:${shape.infiniteSeries.id}`;
    const row = await liveRow(key);
    await addDeviceProperties(row.collection_name, row.href);
    await setShadow(true);
    await sql`DELETE FROM cal_jobs WHERE kind = 'shadow_mirror'`;

    await updateEvent(shape.infiniteSeries.id, { summary: 'Gestione Creattivamente (sede nuova)', location: 'Via Roma 1' });
    const queued = await jobsFor(key);
    assert.equal(queued.length, 1, 'il trigger accoda un job per il master');
    assert.equal(queued[0].status, 'pending');
    assert.ok(queued[0].run_after.getTime() > Date.now() - 500, 'debounce di 2 s');

    await runShadowJobs();
    const [done] = await jobsFor(key);
    assert.equal(done.status, 'done', done.last_error ?? '');
    const items = (done.result?.items ?? []) as Array<{ outcome: string; action: string; fields: string[] }>;
    assert.equal(items.length, 1);
    assert.equal(items[0].action, 'update');
    assert.equal(items[0].outcome, 'done');

    const got = await svc.get(pathOf(row.collection_name, row.href));
    const parsed = parseCalendarObject(got.body);
    assert.ok(parsed.ok && parsed.value.master);
    assert.equal(getTextValue(parsed.value.master, 'SUMMARY'), 'Gestione Creattivamente (sede nuova)');
    assert.equal(getTextValue(parsed.value.master, 'LOCATION'), 'Via Roma 1');
    assert.equal(parsed.value.master.components.filter((c) => c.name === 'VALARM').length, 1, 'VALARM preservato');
    assert.ok(got.body.includes('X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC'), 'X-prop del device preservata');
    assert.match(got.body, /RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR/);
    const after = await liveRow(key);
    assert.equal(after.written_etag, got.etag, 'ledger aggiornato con l\'etag scritto');

    // Seconda esecuzione della stessa chiave: niente da scrivere.
    await enqueueCalendarJob('shadow_mirror', key, { legacy_key: key });
    await runShadowJobs();
    const jobs = await jobsFor(key);
    const last = jobs[jobs.length - 1];
    assert.equal(last.status, 'done');
    assert.deepEqual(((last.result?.items ?? []) as Array<{ outcome: string }>).map((i) => i.outcome), ['noop']);
    assert.equal((await svc.get(pathOf(row.collection_name, row.href))).etag, got.etag);
  });

  test('shadow spento: nessun job dal trigger, un pending si chiude senza scrivere', async () => {
    await setShadow(false);
    const key = `event:${shape.singles[0].id}`;
    await sql`DELETE FROM cal_jobs WHERE kind = 'shadow_mirror'`;
    const row = await liveRow(key);
    const before = await svc.get(pathOf(row.collection_name, row.href));
    await updateEvent(shape.singles[0].id, { summary: 'Gestione (spostata)' });
    assert.equal((await jobsFor(key)).length, 0, 'nessun job con lo shadow spento');
    await enqueueCalendarJob('shadow_mirror', key, { legacy_key: key });
    await runShadowJobs();
    const [job] = await jobsFor(key);
    assert.equal(job.status, 'done');
    assert.equal((job.result as { skipped?: string }).skipped, 'shadow_off');
    assert.equal((await svc.get(pathOf(row.collection_name, row.href))).etag, before.etag, 'Radicale invariato');
  });

  test('lock cal-migration occupato da un run: il job si riaccoda senza consumare tentativi', async () => {
    await setShadow(true);
    const key = `event:${shape.singles[1].id}`;
    await sql`DELETE FROM cal_jobs WHERE kind = 'shadow_mirror'`;
    await enqueueCalendarJob('shadow_mirror', key, { legacy_key: key });
    const holder = await sql.reserve();
    try {
      await holder`SELECT pg_advisory_lock(hashtext(${MIGRATION_LOCK_KEY}))`;
      await runShadowJobs();
      const [waiting] = await jobsFor(key);
      assert.equal(waiting.status, 'pending');
      assert.equal(waiting.attempts, 0, 'tentativo restituito (attesa per indisponibilità)');
      assert.match(waiting.last_error ?? '', /run di migrazione in corso/);
      assert.ok(waiting.run_after.getTime() > Date.now(), 'riaccodato con la pausa d\'attesa');
    } finally {
      await holder`SELECT pg_advisory_unlock(hashtext(${MIGRATION_LOCK_KEY}))`;
      holder.release();
    }
    await runShadowJobs();
    const [done] = await jobsFor(key);
    assert.equal(done.status, 'done', done.last_error ?? '');
    await setShadow(false);
  });

  test('erasure GDPR con lo shadow spento: proiezione minimizzata ed email tolta su Radicale', async () => {
    await setShadow(false);
    await sql`DELETE FROM cal_jobs WHERE kind = 'shadow_mirror'`;
    const email = fx.email('cliente-conf');
    const bookingKey = `booking:${shape.confirmedBookingUid}`;
    const proj = await liveRow(bookingKey);
    const before = await svc.get(pathOf(proj.collection_name, proj.href));
    assert.match(before.body, /333 0000000/);
    const eventRow = await liveRow(`event:${single.id}`);

    const report = await calendarErase(email, { actor: 'admin:test' });
    assert.equal(report.bookings, 1);
    assert.ok(report.jobs_enqueued >= 2);
    await runShadowJobs();

    const after = await svc.get(pathOf(proj.collection_name, proj.href));
    const m = parseCalendarObject(after.body);
    assert.ok(m.ok && m.value.master);
    assert.equal(getTextValue(m.value.master, 'SUMMARY'), 'Prenotazione');
    assert.equal(getTextValue(m.value.master, 'DESCRIPTION'), null);
    assert.ok(!after.body.includes('333 0000000') && !after.body.includes('Cliente Prova'), 'nome e telefono spariti dal volume');
    const ev = await svc.get(pathOf(eventRow.collection_name, eventRow.href));
    assert.ok(!ev.body.toLowerCase().includes(email), 'email tolta dall\'evento migrato');
    assert.match(ev.body, /\[dato rimosso\]/);
    const [ledger] = await sql<Array<{ legacy_hash: string | null; written_etag: string | null }>>`
      SELECT legacy_hash, written_etag FROM cal_migration_ledger WHERE legacy_key = ${bookingKey} AND deleted_at IS NULL
    `;
    assert.ok(ledger.legacy_hash, 'il giro successivo ha riscritto la sorgente redatta');
    assert.equal(ledger.written_etag, after.etag);
  });

  test('erasure con lo shadow spento di un evento spostato di calendario: create redatta nella nuova collezione, poi delete nella vecchia', async () => {
    const email = fx.email('cliente-spostato');
    await setShadow(true);
    await sql`DELETE FROM cal_jobs WHERE kind = 'shadow_mirror'`;
    const moved = await createEvent({
      calendar_id: shape.lavoro.id, summary: fx.name('Evento da spostare'), description: `Contatto: ${email}`,
      start_time: rome('2026-11-20', '09:00'), end_time: rome('2026-11-20', '10:00'), all_day: false, source: 'admin', status: 'confirmed',
    });
    fx.track('eventIds', moved.id);
    const key = `event:${moved.id}`;
    await runShadowJobs();
    const before = await liveRow(key);
    assert.equal(before.collection_name, 'lavoro');
    await svc.get(pathOf('lavoro', before.href));

    // Spostamento in c con lo shadow spento (nessun job), poi la cancellazione dei dati.
    await setShadow(false);
    await sql`UPDATE calendar_events SET calendar_id = ${shape.c.id} WHERE id = ${moved.id}`;
    await sql`DELETE FROM cal_jobs WHERE kind = 'shadow_mirror'`;
    const report = await calendarErase(email, { actor: 'admin:test' });
    assert.ok(report.jobs_enqueued >= 1);
    await runShadowJobs();
    const jobs = await jobsFor(key);
    const job = jobs[jobs.length - 1];
    assert.equal(job.status, 'done', job.last_error ?? '');
    const items = (job.result?.items ?? []) as Array<{ action: string; outcome: string; reason?: string }>;
    assert.deepEqual(items.map((i) => `${i.action}:${i.outcome}`), ['create:done', 'delete:done'], JSON.stringify(items));

    const after = await liveRow(key);
    assert.equal(after.collection_name, 'c', 'l\'evento resta sui device, nella nuova collezione');
    const obj = await svc.get(pathOf('c', after.href));
    assert.ok(!obj.body.toLowerCase().includes(email), 'email tolta');
    assert.match(obj.body, /\[dato rimosso\]/);
    await assert.rejects(svc.get(pathOf('lavoro', before.href)), 'nessuna copia nella vecchia collezione');
  });

  test('proiezione oltre i 24 mesi e prenotazione anonimizzata con lo store Radicale: riscritta con If-Match, VALARM preservato', async () => {
    overrideCalendarStore('radicale');
    try {
      const state = await readBackendStateFresh(sql);
      const old = await fx.booking({ eventType: shape.eventType, start: rome('2024-03-04', '15:00'), project: false, attendee: { name: fx.name('Cliente Vecchio'), phone: '+39 333 4445556' } });
      const href = `booking-${old.booking.uid}.ics`;
      // Risorsa scritta quando la prenotazione era recente (non minimizzata), poi un VALARM aggiunto sul volume.
      const original = buildBookingProjectionIcs({ booking: old.booking, eventTitle: shape.eventType.title, meetingUrl: null, now: new Date('2024-03-01T00:00:00Z') });
      await svc.put(pathOf('bookings', href), original.replace(/END:VEVENT\r?\n/, `${VALARM}END:VEVENT\r\n`), { ifNoneMatch: '*' });
      const first = await syncBookingProjection(old.booking.uid, old.booking, { state });
      assert.equal(first.action, 'rewritten');
      const got = await svc.get(pathOf('bookings', href));
      const m = parseCalendarObject(got.body);
      assert.ok(m.ok && m.value.master);
      assert.equal(getTextValue(m.value.master, 'SUMMARY'), 'Prenotazione');
      assert.equal(getTextValue(m.value.master, 'DESCRIPTION'), null);
      assert.equal(m.value.master.components.filter((c) => c.name === 'VALARM').length, 1, 'VALARM preservato');
      assert.ok(!got.body.includes('333 4445556'));
      const second = await syncBookingProjection(old.booking.uid, old.booking, { state });
      assert.equal(second.action, 'exists', 'nessuna riscrittura a stato invariato');
      assert.equal((await svc.get(pathOf('bookings', href))).etag, got.etag);

      // Prenotazione recente anonimizzata: la risorsa esistente diventa "Prenotazione".
      const recent = await fx.booking({ eventType: shape.eventType, start: rome('2027-01-11', '15:00'), project: false, attendee: { name: fx.name('Cliente Nuovo'), phone: '+39 333 7778889' } });
      const recentHref = `booking-${recent.booking.uid}.ics`;
      await svc.put(pathOf('bookings', recentHref), buildBookingProjectionIcs({ booking: recent.booking, eventTitle: shape.eventType.title, meetingUrl: null, now: new Date() }), { ifNoneMatch: '*' });
      const [anon] = await sql<Booking[]>`
        UPDATE calendar_bookings SET attendee_name = 'Dato cancellato (GDPR)', attendee_email = 'erased-' || id::text || '@deleted.invalid', attendee_phone = NULL
        WHERE id = ${recent.booking.id}::uuid RETURNING *
      `;
      const res = await syncBookingProjection(recent.booking.uid, anon, { state });
      assert.equal(res.action, 'rewritten');
      const anonBody = (await svc.get(pathOf('bookings', recentHref))).body;
      assert.ok(!anonBody.includes('333 7778889') && !anonBody.includes('Cliente Nuovo'));
    } finally {
      overrideCalendarStore(null);
    }
  });

  test('festività con lo store Radicale: If-None-Match, 412 per quelle migrate, mai MKCALENDAR', async () => {
    overrideCalendarStore('radicale');
    try {
      const all = italianHolidaysWindow(new Date('2026-06-01T00:00:00Z'));
      const christmas2026 = all.find((h) => h.date === '2026-12-25')!;
      const fresh = all.filter((h) => h.date.startsWith('2027-')).slice(0, 2);
      assert.equal(fresh.length, 2);
      const first = await runItalianHolidaysOnRadicale([christmas2026, ...fresh]);
      assert.deepEqual({ checked: first.checked, created: first.created, existing: first.existing, skipped: first.skipped }, { checked: 3, created: 2, existing: 1, skipped: null });
      const migrated = await svc.get(pathOf('f', 'it-holiday-2026-12-25.ics'));
      assert.ok(!migrated.body.includes('it-holiday-2026-12-25@caldes.it'), 'la festività migrata conserva l\'UID legacy');
      const created = await svc.get(pathOf('f', `it-holiday-${fresh[0].date}.ics`));
      assert.match(created.body, new RegExp(`UID:it-holiday-${fresh[0].date}@caldes\\.it`));
      assert.match(created.body, /DTSTART;TZID=Europe\/Rome:\d{8}T000000/);
      const second = await runItalianHolidaysOnRadicale([christmas2026, ...fresh]);
      assert.equal(second.created, 0);
      assert.equal(second.existing, 3);

      // Senza la collezione delle festività: avviso e nessuna scrittura (mai MKCALENDAR).
      await sql`UPDATE calendars SET role = 'user' WHERE id = ${shape.f.id}`;
      try {
        const missing = await runItalianHolidaysOnRadicale(fresh);
        assert.equal(missing.skipped, 'collection_missing');
        assert.equal(missing.created, 0);
      } finally {
        await sql`UPDATE calendars SET role = 'holidays' WHERE id = ${shape.f.id}`;
      }
    } finally {
      overrideCalendarStore(null);
    }
  });
});
