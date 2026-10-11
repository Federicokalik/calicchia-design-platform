/**
 * GDPR del calendario senza Radicale (gruppo SHADOW della F3:
 * apps/api/src/lib/calendar/gdpr.ts, routes/gdpr-requests.ts,
 * cron/data-retention.ts; design §16.4; decisione 3; contratto
 * docs/calendar-radicale/contracts/f3-modules.md §3.6, §6.4 e §13).
 *
 * Casi:
 *  - erasure completa in mode postgres con il volume inizializzato:
 *    prenotazioni anonimizzate (anche le annullate), promemoria redatti,
 *    proiezioni legacy ridotte a "Prenotazione", email tolta dagli altri
 *    eventi, audit_logs di calendar_events e calendar_bookings redatti (anche
 *    quelli scritti dalle UPDATE dell'erasure), ledger e righe dei run,
 *    versioni dell'indice, job conclusi; job shadow_mirror di cancellazione
 *    accodati anche con lo shadow spento; dati di altre persone intatti;
 *    seconda esecuzione senza effetti;
 *  - erasure con lo store Radicale: project_booking accodati, GUC
 *    caldes.reverse_sync per le righe legacy;
 *  - route DELETE /api/gdpr-requests/erase/:email con il report del
 *    calendario; email non valida → 400;
 *  - retention: run e righe oltre 30 giorni (tranne l'ultimo riuscito per
 *    tipo), file caricati oltre 24 ore (tranne quelli di un run attivo),
 *    proiezioni oltre i 24 mesi (shadow_mirror in mode postgres con lo shadow,
 *    project_booking con lo store Radicale), cron data-retention.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { runDataRetention } from '../../src/cron/data-retention';
import {
  calendarErase,
  enqueueExpiredProjectionRewrites,
  erasureEmailPattern,
  normalizeErasureEmail,
  purgeMigrationArtifacts,
} from '../../src/lib/calendar/gdpr';
import { getPgLegacyStore } from '../../src/lib/calendar/store';
import type { Booking } from '../../src/lib/calendar/types';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql, useTestDatabase } from '../helpers/db';
import { romeIso, useFixtures } from '../helpers/fixtures';
import { api } from '../helpers/http';

useTestDatabase({ resetBaseline: true });
onBeforeDatabaseClose(async () => {
  await sql`DELETE FROM audit_logs WHERE table_name = 'calendar_bookings'`;
  await resetCalendarBaseline();
});
const fx = useFixtures('cal-gdpr');

const VOLUME = 'a1b2c3d4-0000-4000-8000-00000000f301';
const HASH = `s1:${'a'.repeat(64)}`;
const DAY = 86_400_000;

async function setState(values: { volume?: string | null; shadow?: boolean; mode?: 'postgres' | 'radicale' }): Promise<void> {
  if (values.volume !== undefined) await sql`UPDATE calendar_backend_state SET volume_id = ${values.volume}::uuid, epoch = ${values.volume ? 1 : 0} WHERE id = true`;
  if (values.shadow !== undefined) await sql`UPDATE calendar_backend_state SET shadow_enabled = ${values.shadow}, shadow_since = ${values.shadow ? sql`now()` : null} WHERE id = true`;
  if (values.mode !== undefined) await sql`UPDATE calendar_backend_state SET mode = ${values.mode} WHERE id = true`;
}

async function resetState(): Promise<void> {
  await sql`UPDATE calendar_backend_state SET mode = 'postgres', volume_id = NULL, epoch = 0, shadow_enabled = false, shadow_since = NULL WHERE id = true`;
}

/** Oggetto nell'indice (id, oggetto, componente master) con il testo indicato. */
async function indexObject(calendarId: string, href: string, opts: { raw: string; summary: string; description?: string | null }): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO cal_object_ids (id, calendar_id, href, recurrence_key, uid) VALUES (${id}::uuid, ${calendarId}::uuid, ${href}, '', ${href})`;
  await sql`
    INSERT INTO cal_objects (id, calendar_id, href, uid, raw_ics, origin_store, source)
    VALUES (${id}::uuid, ${calendarId}::uuid, ${href}, ${href}, ${opts.raw}, 'radicale', 'manual')
  `;
  await sql`
    INSERT INTO cal_components (id, object_id, calendar_id, recurrence_key, uid, summary, description, status)
    VALUES (${id}::uuid, ${id}::uuid, ${calendarId}::uuid, '', ${href}, ${opts.summary}, ${opts.description ?? null}, 'confirmed')
  `;
  return id;
}

async function addVersion(objectId: string, calendarId: string, href: string, raw: string): Promise<void> {
  await sql`
    INSERT INTO cal_object_versions (object_id, calendar_id, href, raw_ics, change_kind, valid, actor)
    VALUES (${objectId}::uuid, ${calendarId}::uuid, ${href}, ${raw}, 'create', true, 'sync')
  `;
}

describe('normalizzazione dell\'email', () => {
  test('mai una ricerca su una stringa vuota o generica', () => {
    assert.equal(normalizeErasureEmail('  Mario.Rossi@Example.COM '), 'mario.rossi@example.com');
    for (const bad of ['', '   ', 'a@b', '@example.com', 'mario', 'mario rossi@example.com', null, 42]) {
      assert.equal(normalizeErasureEmail(bad), null, String(bad));
    }
    assert.equal(erasureEmailPattern('a.b+c@x.it'), 'a\\.b\\+c@x\\.it');
  });
});

describe('calendarErase in mode postgres', () => {
  after(resetState);

  test('erasure completa, audit_logs compresi; altre persone intatte; idempotente', async () => {
    await resetState();
    await setState({ volume: VOLUME });
    const email = fx.email('gdpr-mario');
    const other = fx.email('gdpr-altro');
    const eventType = await fx.eventType({ key: 'gdpr' });
    const lavoro = (await getPgLegacyStore().getCalendar('lavoro'))!;
    const bookingsCal = (await getPgLegacyStore().getBookingsCalendar())!;

    const confirmed = await fx.booking({
      eventType, start: romeIso('2027-03-01', '10:00'),
      attendee: { name: 'Mario Rossi', email, phone: '+39 333 1112223', company: 'ACME Srl', message: 'Richiamatemi' },
      customResponses: { note: `scrivere a ${email}` },
    });
    const cancelled = await fx.booking({
      eventType, start: romeIso('2027-03-02', '10:00'), status: 'cancelled', project: false,
      attendee: { name: 'Mario Rossi', email: email.toUpperCase(), phone: '+39 333 1112223' },
      cancellationReason: 'Non posso più venire, Mario',
    });
    const untouched = await fx.booking({ eventType, start: romeIso('2027-03-03', '10:00'), attendee: { name: 'Giulia Bianchi', email: other, phone: '+39 333 9998887' } });
    const withEmail = await fx.event({ calendar: lavoro, summary: 'Call con cliente', description: `Contatto: ${email.toUpperCase()} (preferisce email)`, start_time: romeIso('2027-03-04', '09:00'), end_time: romeIso('2027-03-04', '10:00') });
    const plain = await fx.event({ calendar: lavoro, summary: 'Riunione interna', description: `Scrivere a ${other}`, start_time: romeIso('2027-03-05', '09:00'), end_time: romeIso('2027-03-05', '10:00') });
    assert.ok(confirmed.projection);

    // Promemoria inviati, audit di calendar_bookings (scritto dall'app), ledger, righe dei run, indice e job.
    await sql`
      INSERT INTO calendar_booking_reminders (booking_id, reminder_type, sent_to)
      VALUES (${confirmed.booking.id}::uuid, 'confirmation', ${email}), (${untouched.booking.id}::uuid, 'confirmation', ${other})
    `;
    await sql`
      INSERT INTO audit_logs (action, table_name, record_id, new_data)
      SELECT 'INSERT', 'calendar_bookings', b.id::text, to_jsonb(b) FROM calendar_bookings b WHERE b.id = ANY(${[confirmed.booking.id, untouched.booking.id]}::uuid[])
    `;
    const bookingKey = `booking:${confirmed.booking.uid}`;
    await sql`
      INSERT INTO cal_migration_ledger (calendar_id, collection_name, href, kind, legacy_key, uid, legacy_snapshot, legacy_hash, written_etag, written_fingerprint, written_at)
      VALUES
        (${bookingsCal.id}::uuid, 'bookings', ${`booking-${confirmed.booking.uid}.ics`}, 'booking', ${bookingKey}, ${`${confirmed.booking.uid}@caldes.it`},
         ${sql.json({ v: 1, kind: 'booking', booking: { attendee_name: 'Mario Rossi', attendee_phone: '+39 333 1112223' }, minimized: false } as never)}, ${HASH}, '"e1"', 'v1:x', now()),
        (${lavoro.id}::uuid, 'lavoro', ${`${withEmail.uid}.ics`}, 'event', ${`event:${withEmail.id}`}, ${withEmail.uid},
         ${sql.json({ v: 1, kind: 'event', master: { description: `Contatto: ${email}` } } as never)}, ${HASH}, '"e2"', 'v1:y', now()),
        (${lavoro.id}::uuid, 'lavoro', ${`${plain.uid}.ics`}, 'event', ${`event:${plain.id}`}, ${plain.uid},
         ${sql.json({ v: 1, kind: 'event', master: { summary: 'Riunione interna' } } as never)}, ${HASH}, '"e3"', 'v1:z', now())
    `;
    const [run] = await sql<Array<{ id: string }>>`
      INSERT INTO cal_migration_runs (kind, status, trigger, requested_by, params, started_at, finished_at)
      VALUES ('plan', 'succeeded', 'admin', 'admin:test', '{}'::jsonb, now(), now()) RETURNING id::text AS id
    `;
    await sql`
      INSERT INTO cal_migration_items (run_id, seq, item_type, legacy_key, action, detail)
      VALUES (${run.id}::uuid, 0, 'object', ${bookingKey}, 'create', '{}'::jsonb),
             (${run.id}::uuid, 1, 'anomaly', NULL, NULL, ${sql.json({ note: `riga sbagliata con ${email}` } as never)}),
             (${run.id}::uuid, 2, 'object', ${`event:${plain.id}`}, 'create', '{}'::jsonb)
    `;
    const projObject = await indexObject(bookingsCal.id, `booking-${confirmed.booking.uid}.ics`, { raw: 'SUMMARY:Consulenza – Mario Rossi', summary: 'Consulenza – Mario Rossi' });
    await addVersion(projObject, bookingsCal.id, `booking-${confirmed.booking.uid}.ics`, 'BEGIN:VCALENDAR\r\nSUMMARY:Consulenza – Mario Rossi\r\nEND:VCALENDAR');
    const emailObject = await indexObject(lavoro.id, 'altro-oggetto.ics', { raw: 'SUMMARY:Altro', summary: 'Altro' });
    await addVersion(emailObject, lavoro.id, 'altro-oggetto.ics', `ATTENDEE:mailto:${email}`);
    const keepObject = await indexObject(lavoro.id, 'intatto.ics', { raw: 'SUMMARY:Intatto', summary: 'Intatto' });
    await addVersion(keepObject, lavoro.id, 'intatto.ics', 'SUMMARY:Intatto');
    await sql`
      INSERT INTO cal_jobs (kind, key, payload, status, run_after, finished_at)
      VALUES ('shadow_mirror', ${bookingKey}, '{}'::jsonb, 'done', now(), now()),
             ('project_booking', ${confirmed.booking.uid}, '{}'::jsonb, 'dead', now(), now()),
             ('shadow_mirror', ${`event:${plain.id}`}, '{}'::jsonb, 'done', now(), now())
    `;

    const report = await calendarErase(`  ${email.toUpperCase()} `, { actor: 'admin:test' });
    assert.equal(report.bookings, 2);
    assert.equal(report.projections_legacy, 1);
    assert.equal(report.events_redacted, 1);
    assert.equal(report.reminders_redacted, 1);
    assert.equal(report.ledger_redacted, 2);
    assert.equal(report.migration_items_deleted, 2);
    assert.equal(report.versions_purged, 2);
    assert.ok(report.jobs_deleted >= 2);
    assert.equal(report.jobs_enqueued, 3, 'booking:<uid> per le due prenotazioni ed event:<master> per l\'evento');
    assert.ok(report.audit_logs_redacted >= 3);
    assert.ok(report.manual_followup.some((m) => m.includes('radicale-maint.sh purge-cache')));

    // 1. Prenotazioni anonimizzate (la riga resta), promemoria redatti; l'altra persona intatta.
    const rows = await sql<Booking[]>`SELECT * FROM calendar_bookings WHERE id = ANY(${[confirmed.booking.id, cancelled.booking.id, untouched.booking.id]}::uuid[])`;
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of [confirmed.booking.id, cancelled.booking.id]) {
      const b = byId.get(id)!;
      assert.equal(b.attendee_name, 'Dato cancellato (GDPR)');
      assert.equal(b.attendee_email, `erased-${id}@deleted.invalid`);
      assert.equal(b.attendee_phone, null);
      assert.equal(b.attendee_company, null);
      assert.equal(b.attendee_message, null);
      assert.deepEqual(b.custom_responses, {});
      assert.equal(b.cancellation_reason, null);
    }
    assert.equal(byId.get(untouched.booking.id)?.attendee_email, other);
    assert.equal(byId.get(untouched.booking.id)?.attendee_phone, '+39 333 9998887');
    const reminders = await sql<Array<{ booking_id: string; sent_to: string }>>`SELECT booking_id::text AS booking_id, sent_to FROM calendar_booking_reminders WHERE booking_id = ANY(${[confirmed.booking.id, untouched.booking.id]}::uuid[])`;
    assert.ok(reminders.find((r) => r.booking_id === confirmed.booking.id)?.sent_to.endsWith('@deleted.invalid'));
    assert.equal(reminders.find((r) => r.booking_id === untouched.booking.id)?.sent_to, other);

    // 2. Righe legacy.
    const [proj] = await sql<Array<{ summary: string; description: string | null; location: string | null }>>`SELECT summary, description, location FROM calendar_events WHERE id = ${confirmed.projection!.id}`;
    assert.deepEqual(proj, { summary: 'Prenotazione', description: null, location: null });
    const [ev] = await sql<Array<{ description: string }>>`SELECT description FROM calendar_events WHERE id = ${withEmail.id}`;
    assert.equal(ev.description, 'Contatto: [dato rimosso] (preferisce email)');
    const [kept] = await sql<Array<{ description: string }>>`SELECT description FROM calendar_events WHERE id = ${plain.id}`;
    assert.equal(kept.description, `Scrivere a ${other}`);

    // 3. Audit: nessuna traccia dell'email, del nome o del telefono nelle righe delle persone cancellate.
    const [leak] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM audit_logs
      WHERE table_name IN ('calendar_events', 'calendar_bookings')
        AND (strpos(lower(coalesce(old_data::text, '') || coalesce(new_data::text, '')), ${email}) > 0
             OR (coalesce(old_data::text, '') || coalesce(new_data::text, '')) LIKE '%Mario Rossi%'
             OR (coalesce(old_data::text, '') || coalesce(new_data::text, '')) LIKE '%333 1112223%')
    `;
    assert.equal(leak.n, 0, 'audit_logs redatti');
    const [bookingAudit] = await sql<Array<{ new_data: Record<string, unknown> }>>`
      SELECT new_data FROM audit_logs WHERE table_name = 'calendar_bookings' AND record_id = ${confirmed.booking.id}
    `;
    assert.equal(bookingAudit.new_data.attendee_name, '[dato rimosso]');
    assert.equal(bookingAudit.new_data.uid, confirmed.booking.uid, 'i campi non personali restano');
    const [otherAudit] = await sql<Array<{ new_data: Record<string, unknown> }>>`
      SELECT new_data FROM audit_logs WHERE table_name = 'calendar_bookings' AND record_id = ${untouched.booking.id}
    `;
    assert.equal(otherAudit.new_data.attendee_email, other);

    // 4. Ledger e righe dei run.
    const ledger = await sql<Array<{ legacy_key: string; legacy_snapshot: unknown; legacy_hash: string | null }>>`SELECT legacy_key, legacy_snapshot, legacy_hash FROM cal_migration_ledger`;
    for (const key of [bookingKey, `event:${withEmail.id}`]) {
      const row = ledger.find((l) => l.legacy_key === key)!;
      assert.equal(row.legacy_snapshot, null);
      assert.equal(row.legacy_hash, null);
    }
    assert.equal(ledger.find((l) => l.legacy_key === `event:${plain.id}`)?.legacy_hash, HASH);
    const items = await sql<Array<{ seq: number }>>`SELECT seq FROM cal_migration_items WHERE run_id = ${run.id}::uuid ORDER BY seq`;
    assert.deepEqual(items.map((i) => i.seq), [2]);

    // 6-7. Versioni e job.
    const versions = await sql<Array<{ object_id: string }>>`SELECT object_id::text AS object_id FROM cal_object_versions WHERE object_id = ANY(${[projObject, emailObject, keepObject]}::uuid[])`;
    assert.deepEqual(versions.map((v) => v.object_id), [keepObject]);
    const jobs = await sql<Array<{ kind: string; key: string; status: string; payload: Record<string, unknown> }>>`SELECT kind, key, status, payload FROM cal_jobs ORDER BY kind, key, status`;
    assert.ok(!jobs.some((j) => j.status !== 'pending' && (j.key === bookingKey || j.key === confirmed.booking.uid)), 'job conclusi delle chiavi toccate cancellati');
    assert.ok(jobs.some((j) => j.status === 'done' && j.key === `event:${plain.id}`), 'gli altri job restano');
    const erasureJobs = jobs.filter((j) => j.kind === 'shadow_mirror' && j.status === 'pending' && j.payload.erasure === true).map((j) => j.key).sort();
    assert.deepEqual(erasureJobs, [bookingKey, `booking:${cancelled.booking.uid}`, `event:${withEmail.id}`].sort());

    // Seconda esecuzione: nulla da fare.
    const again = await calendarErase(email, { actor: 'admin:test' });
    assert.deepEqual(
      [again.bookings, again.projections_legacy, again.events_redacted, again.audit_logs_redacted, again.ledger_redacted, again.migration_items_deleted, again.versions_purged, again.jobs_enqueued],
      [0, 0, 0, 0, 0, 0, 0, 0],
    );
    await assert.rejects(calendarErase('a@b', { actor: 'admin:test' }), TypeError);
  });

  test('senza volume inizializzato nessun job di cancellazione; con lo shadow acceso il trigger e l\'erasure si fondono', async () => {
    await resetState();
    const email = fx.email('gdpr-novol');
    const eventType = await fx.eventType({ key: 'gdpr-novol' });
    await fx.booking({ eventType, start: romeIso('2027-04-01', '10:00'), attendee: { name: 'Anna Verdi', email } });
    const report = await calendarErase(email, { actor: 'admin:test' });
    assert.equal(report.bookings, 1);
    assert.equal(report.jobs_enqueued, 0);

    await setState({ volume: VOLUME, shadow: true });
    const email2 = fx.email('gdpr-shadow');
    const b2 = await fx.booking({ eventType, start: romeIso('2027-04-02', '10:00'), attendee: { name: 'Anna Verdi', email: email2 } });
    await sql`DELETE FROM cal_jobs`;
    const report2 = await calendarErase(email2, { actor: 'admin:test' });
    assert.equal(report2.jobs_enqueued, 1);
    const jobs = await sql<Array<{ key: string; payload: Record<string, unknown> }>>`SELECT key, payload FROM cal_jobs WHERE kind = 'shadow_mirror' AND status = 'pending'`;
    assert.deepEqual(jobs.map((j) => j.key), [`booking:${b2.booking.uid}`], 'un solo pending per chiave (coalescenza)');
    assert.equal(jobs[0].payload.erasure, true, 'il payload dell\'erasure prevale su quello del trigger');
    await resetState();
    await sql`DELETE FROM cal_jobs`;
  });
});

describe('calendarErase con lo store Radicale', () => {
  after(async () => {
    await resetState();
    await sql`DELETE FROM cal_jobs`;
  });

  test('project_booking per le prenotazioni, righe legacy redatte con il GUC', async () => {
    const email = fx.email('gdpr-rad');
    const eventType = await fx.eventType({ key: 'gdpr-rad' });
    const b = await fx.booking({ eventType, start: romeIso('2027-05-01', '10:00'), attendee: { name: 'Luca Neri', email } });
    await setState({ volume: VOLUME, mode: 'radicale' });
    await sql`DELETE FROM cal_jobs`;
    const report = await calendarErase(email, { actor: 'admin:test' });
    assert.equal(report.bookings, 1);
    assert.equal(report.projections_legacy, 1);
    const jobs = await sql<Array<{ kind: string; key: string; source_version: string | null }>>`SELECT kind, key, source_version FROM cal_jobs WHERE status = 'pending'`;
    assert.deepEqual(jobs.map((j) => `${j.kind}:${j.key}`), [`project_booking:${b.booking.uid}`]);
    assert.ok(jobs[0].source_version);
    await resetState();
  });
});

describe('route DELETE /api/gdpr-requests/erase/:email', () => {
  test('report del calendario nella risposta; email non valida → 400', async () => {
    const email = fx.email('gdpr-route');
    const eventType = await fx.eventType({ key: 'gdpr-route' });
    await fx.booking({ eventType, start: romeIso('2027-06-01', '10:00'), attendee: { name: 'Sara Blu', email } });
    const res = await api.delete(`/api/gdpr-requests/erase/${encodeURIComponent(email)}`, { auth: 'admin' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.erased, true);
    assert.equal(res.json.calendar.bookings, 1);
    assert.ok((res.json.manual_followup as string[]).some((m) => m.includes('purge-cache')));
    const bad = await api.delete(`/api/gdpr-requests/erase/${encodeURIComponent('x@y')}`, { auth: 'admin' });
    assert.equal(bad.status, 400);
    const anon = await api.delete(`/api/gdpr-requests/erase/${encodeURIComponent(email)}`);
    assert.equal(anon.status, 401);
  });
});

describe('retention', () => {
  const uploadDir = { path: '' };
  after(async () => {
    delete process.env.CAL_MIGRATION_UPLOAD_DIR;
    if (uploadDir.path) await rm(uploadDir.path, { recursive: true, force: true });
    await sql`DELETE FROM cal_migration_runs`;
    await sql`DELETE FROM cal_migration_ledger`;
    await sql`DELETE FROM cal_jobs`;
    await resetState();
  });

  test('run oltre 30 giorni tranne l\'ultimo riuscito per tipo; file caricati oltre 24 ore tranne quelli di un run attivo', async () => {
    await sql`DELETE FROM cal_migration_runs`;
    const now = new Date();
    const run = async (kind: string, status: string, daysAgo: number, params: object = {}): Promise<string> => {
      const at = new Date(now.getTime() - daysAgo * DAY);
      const terminal = status !== 'queued' && status !== 'running';
      const [r] = await sql<Array<{ id: string }>>`
        INSERT INTO cal_migration_runs (kind, status, trigger, requested_by, params, created_at, started_at, finished_at)
        VALUES (${kind}, ${status}, 'admin', 'admin:test', ${sql.json(params as never)}, ${at},
                ${status === 'queued' ? null : at}, ${terminal ? at : null})
        RETURNING id::text AS id
      `;
      return r.id;
    };
    const oldPlan = await run('plan', 'succeeded', 45);
    const latestPlan = await run('plan', 'succeeded', 35);
    const oldVerify = await run('verify', 'failed', 40);
    const recentApply = await run('apply', 'succeeded', 5);
    await sql`INSERT INTO cal_migration_items (run_id, seq, item_type, code) VALUES (${oldPlan}::uuid, 0, 'anomaly', 'POSSIBLE_DUPLICATE')`;

    uploadDir.path = await mkdtemp(join(tmpdir(), 'cal-migration-uploads-'));
    process.env.CAL_MIGRATION_UPLOAD_DIR = uploadDir.path;
    const oldFile = join(uploadDir.path, 'vecchio.zip');
    const newFile = join(uploadDir.path, 'nuovo.zip');
    const activeFile = join(uploadDir.path, 'in-uso.zip');
    for (const f of [oldFile, newFile, activeFile]) await writeFile(f, 'x', { mode: 0o600 });
    const twoDaysAgo = new Date(now.getTime() - 2 * DAY);
    await utimes(oldFile, twoDaysAgo, twoDaysAgo);
    await utimes(activeFile, twoDaysAgo, twoDaysAgo);
    const active = await run('archive', 'queued', 0, { upload_path: activeFile, upload_sha256: 'x', original_name: 'in-uso.zip' });

    const res = await purgeMigrationArtifacts({ now });
    assert.deepEqual(res, { runs: 2, uploads: 1 });
    const left = (await sql<Array<{ id: string }>>`SELECT id::text AS id FROM cal_migration_runs`).map((r) => r.id).sort();
    assert.deepEqual(left, [latestPlan, recentApply, active].sort());
    assert.ok(!left.includes(oldVerify));
    const [{ n }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM cal_migration_items WHERE run_id = ${oldPlan}::uuid`;
    assert.equal(n, 0, 'righe cancellate in cascata');
    assert.deepEqual((await readdir(uploadDir.path)).sort(), ['in-uso.zip', 'nuovo.zip']);
    await sql`UPDATE cal_migration_runs SET status = 'cancelled', finished_at = now() WHERE id = ${active}::uuid`;
  });

  test('proiezioni oltre i 24 mesi: shadow_mirror in mode postgres con lo shadow, project_booking con lo store Radicale', async () => {
    await sql`DELETE FROM cal_jobs`;
    const now = new Date();
    const eventType = await fx.eventType({ key: 'retention' });
    const monthsAgo = (months: number, extraDays = 0): string => {
      const d = new Date(now.getTime());
      d.setUTCMonth(d.getUTCMonth() - months);
      return new Date(d.getTime() - extraDays * DAY - 2 * 3_600_000).toISOString();
    };
    const justExpired = await fx.booking({ eventType, start: monthsAgo(24, 2) });
    const notYet = await fx.booking({ eventType, start: monthsAgo(23) });
    const oldNotMinimized = await fx.booking({ eventType, start: monthsAgo(30) });
    const oldMinimized = await fx.booking({ eventType, start: monthsAgo(31) });
    const cancelledOld = await fx.booking({ eventType, start: monthsAgo(24, 3), status: 'cancelled', project: false });
    const bookingsCal = (await getPgLegacyStore().getBookingsCalendar())!;
    const ledgerRow = async (uid: string, minimized: boolean) => {
      await sql`
        INSERT INTO cal_migration_ledger (calendar_id, collection_name, href, kind, legacy_key, uid, legacy_snapshot, legacy_hash, written_etag, written_fingerprint, written_at)
        VALUES (${bookingsCal.id}::uuid, 'bookings', ${`booking-${uid}.ics`}, 'booking', ${`booking:${uid}`}, ${`${uid}@caldes.it`},
                ${sql.json({ v: 1, kind: 'booking', minimized } as never)}, ${HASH}, '"e"', 'v1:x', now())
      `;
    };
    await ledgerRow(oldNotMinimized.booking.uid, false);
    await ledgerRow(oldMinimized.booking.uid, true);

    // Mode postgres senza volume inizializzato: nessun job.
    await resetState();
    assert.equal(await enqueueExpiredProjectionRewrites({ now }), 0);

    // Volume inizializzato e shadow spento: solo le risorse già scritte dallo strumento (mai creazioni).
    await setState({ volume: VOLUME });
    await sql`DELETE FROM cal_jobs`;
    assert.equal(await enqueueExpiredProjectionRewrites({ now }), 1);
    const offJobs = await sql<Array<{ key: string; payload: Record<string, unknown> }>>`SELECT key, payload FROM cal_jobs WHERE kind = 'shadow_mirror' AND status = 'pending'`;
    assert.deepEqual(offJobs.map((j) => j.key), [`booking:${oldNotMinimized.booking.uid}`]);
    assert.equal(offJobs[0].payload.erasure, true, 'eseguito anche con lo shadow spento, solo sugli oggetti tracciati');

    await setState({ shadow: true });
    await sql`DELETE FROM cal_jobs`;
    assert.equal(await enqueueExpiredProjectionRewrites({ now }), 2);
    const shadowJobs = (await sql<Array<{ key: string }>>`SELECT key FROM cal_jobs WHERE kind = 'shadow_mirror' AND status = 'pending' ORDER BY key`).map((j) => j.key);
    assert.deepEqual(shadowJobs, [`booking:${justExpired.booking.uid}`, `booking:${oldNotMinimized.booking.uid}`].sort());
    assert.ok(!shadowJobs.includes(`booking:${notYet.booking.uid}`));
    assert.ok(!shadowJobs.includes(`booking:${oldMinimized.booking.uid}`));
    assert.ok(!shadowJobs.includes(`booking:${cancelledOld.booking.uid}`));

    // Store Radicale: project_booking per quelle appena scadute e per quelle che l'indice mostra ancora non minimizzate.
    await sql`DELETE FROM cal_jobs`;
    await setState({ mode: 'radicale' });
    await indexObject(bookingsCal.id, `booking-${oldMinimized.booking.uid}.ics`, { raw: 'x', summary: 'Consulenza – Cliente di test' });
    await indexObject(bookingsCal.id, `booking-${oldNotMinimized.booking.uid}.ics`, { raw: 'x', summary: 'Prenotazione' });
    assert.equal(await enqueueExpiredProjectionRewrites({ now }), 2);
    const radJobs = (await sql<Array<{ key: string }>>`SELECT key FROM cal_jobs WHERE kind = 'project_booking' AND status = 'pending' ORDER BY key`).map((j) => j.key);
    assert.deepEqual(radJobs, [justExpired.booking.uid, oldMinimized.booking.uid].sort());
    await resetState();
    await sql`DELETE FROM cal_jobs`;
    await sql`DELETE FROM cal_object_ids WHERE calendar_id = ${bookingsCal.id}::uuid`;
  });

  test('cron data-retention: passi del calendario isolati', async () => {
    await sql`DELETE FROM cal_migration_runs`;
    const old = new Date(Date.now() - 40 * DAY);
    await sql`
      INSERT INTO cal_migration_runs (kind, status, trigger, requested_by, params, created_at, started_at, finished_at)
      VALUES ('inventory', 'failed', 'admin', 'admin:test', '{}'::jsonb, ${old}, ${old}, ${old})
    `;
    await runDataRetention();
    const [{ n }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM cal_migration_runs`;
    assert.equal(n, 0);
  });
});
