/**
 * Proiezione inversa della F4 contro Radicale 3.7.8 reale
 * (apps/api/src/lib/calendar/migration/reverse-projector.ts; design §13.11;
 * contratto docs/calendar-radicale/contracts/f4-modules.md §4). La parte
 * senza Radicale è in test/calendar/reverse-projector.test.ts.
 *
 * Stack: Radicale con storage multifilesystem in una directory temporanea,
 * htpasswd con caldes-svc e la matrice di caldes-svc del contratto
 * control-plane §8; volume inizializzato con initializeVolume(); le risorse le
 * scrive un "device" (PUT come caldes-svc con il contenuto tipico di iOS:
 * VALARM, X-APPLE-*, invitati, TZID), l'indice le riceve dalla sync reale.
 *
 * Casi (mode radicale con la finestra di rollback aperta):
 *  1. passata completa (passo reverse_start del cutover): RDATE, serie New
 *     York, invito duplicato in lavoro, durata zero, evento senza SUMMARY,
 *     override con l'UID del master → nessun REVERSE_FAILED, righe sanificate
 *     e classificate, busy legacy identico a quello dell'indice;
 *  2. NOTIFY calendar_index_changed → job reverse_projection (debounce): una
 *     RDATE aggiunta dal device compare nel legacy, una risorsa cancellata dal
 *     device sparisce dal legacy, busy ancora identico; nessun job fallito;
 *  3. seconda passata senza modifiche: nessuna scrittura, hash invariato.
 *
 * Senza RADICALE_BIN la suite è saltata con il motivo.
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';
import { radicaleAvailability, type RadicaleServer, startRadicale, TEST_PRINCIPAL } from '../helpers/radicale';
import { invalidateBackendModeCache } from '../../src/lib/calendar/backend-mode';
import { indexBusyRanges } from '../../src/lib/calendar/busy';
import { runCalendarJobsOnce, stopCalendarJobWorker, unregisterCalendarJobHandler } from '../../src/lib/calendar/jobs';
import { getBusyRanges as legacyBusyRanges } from '../../src/lib/calendar/legacy/events-pg';
import {
  computeReversePlan,
  registerReverseProjectionJob,
  REVERSE_PROJECTION_JOB_KIND,
  runReverseProjection,
  startReverseProjectionTrigger,
} from '../../src/lib/calendar/migration/reverse-projector';
import { objectPath, RadicaleClient } from '../../src/lib/calendar/radicale/client';
import { initializeVolume } from '../../src/lib/calendar/radicale/identity';
import { configureRadicaleRuntime, syncCollection } from '../../src/lib/calendar/radicale/sync';
import type { Calendar } from '../../src/lib/calendar/types';

const radicale = radicaleAvailability();
const fx = useFixtures('reverse-rad', { resetBaseline: true });
onBeforeDatabaseClose(async () => {
  unregisterCalendarJobHandler(REVERSE_PROJECTION_JOB_KIND);
  await stopCalendarJobWorker();
  configureRadicaleRuntime(null);
  await sql`DELETE FROM cal_jobs WHERE kind = ${REVERSE_PROJECTION_JOB_KIND}`;
  await resetCalendarBaseline();
});

const P = TEST_PRINCIPAL;
const SVC_PASSWORD = 'test-only-svc-password-f4-reverse';
const SVC_RIGHTS_RULES = [
  '[root]', 'user: .+', 'collection:', 'permissions: R', '',
  '[svc-principal]', 'user: caldes-svc', `collection: ${P}`, 'permissions: RW', '',
  '[svc-collections]', 'user: caldes-svc', `collection: ${P}/[^/]+`, 'permissions: rwD', '',
].join('\n');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Intervalli distinti e ordinati: getBusyRanges legacy ripete l'intervallo di due righe uguali (stesso effetto sugli slot). */
function distinct(ranges: ReadonlyArray<{ start: string; end: string }>): Array<{ start: string; end: string }> {
  const seen = new Set<string>();
  return ranges
    .filter((r) => (seen.has(`${r.start}|${r.end}`) ? false : (seen.add(`${r.start}|${r.end}`), true)))
    .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
}
const WINDOW = { from: '2026-09-28T00:00:00.000Z', to: '2027-01-31T00:00:00.000Z' } as const;

function vcal(...components: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//iPhone OS 18.0//EN', 'CALSCALE:GREGORIAN', ...components, 'END:VCALENDAR', ''].join('\r\n');
}

function vevent(lines: string[], extra: string[] = []): string {
  return ['BEGIN:VEVENT', 'DTSTAMP:20261001T080000Z', 'CREATED:20261001T080000Z', ...lines, ...extra, 'END:VEVENT'].join('\r\n');
}

const ALARM = ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Promemoria', 'TRIGGER:-PT15M', 'X-WR-ALARMUID:A1', 'END:VALARM'];

describe('proiezione inversa contro Radicale reale', { skip: radicale.skip }, () => {
  let rad: RadicaleServer;
  let svc: RadicaleClient;
  let personale: Calendar;
  let lavoro: Calendar;
  const put = (cal: Calendar, name: string, body: string, opts: { ifNoneMatch: '*' } | { ifMatch: string } = { ifNoneMatch: '*' }) => svc.put(objectPath(P, cal.slug, name), body, opts);
  const sync = async (cal: Calendar): Promise<void> => {
    await sleep(60); // fuori dalla finestra racy di 50 ms della dir_mtime
    await syncCollection(cal.id, { reason: 'manual' });
  };
  async function objectId(cal: Calendar, href: string): Promise<string> {
    const [row] = await sql<Array<{ id: string }>>`SELECT id::text AS id FROM cal_objects WHERE calendar_id = ${cal.id} AND href = ${href}`;
    assert.ok(row, `${href} indicizzato`);
    return row.id;
  }
  async function rows(objectIdValue: string) {
    return sql<Array<{ id: string; uid: string; summary: string; start_time: Date; end_time: Date; caldes_derived: boolean; recurrence_master_id: string | null }>>`
      SELECT id::text AS id, uid, summary, start_time, end_time, caldes_derived, recurrence_master_id::text AS recurrence_master_id
      FROM calendar_events WHERE caldes_object_id = ${objectIdValue}::uuid ORDER BY start_time, id
    `;
  }
  async function degradations(objectIdValue: string): Promise<string[]> {
    const [row] = await sql<Array<{ degradations: Array<{ class: string }> }>>`SELECT degradations FROM cal_migration_reverse_state WHERE object_id = ${objectIdValue}::uuid`;
    return [...new Set((row?.degradations ?? []).map((d) => d.class))].sort();
  }

  before(async () => {
    rad = await startRadicale({
      label: 'f4-reverse',
      auth: { type: 'htpasswd', users: { 'caldes-svc': SVC_PASSWORD } },
      rights: { type: 'from_file', rules: SVC_RIGHTS_RULES },
    });
    svc = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0 });
    // Calendari creati in mode postgres (la guardia 166 è inerte), poi il volume.
    personale = await fx.calendar({ key: 'personale', blocks_availability: true });
    lavoro = await fx.calendar({ key: 'lavoro', blocks_availability: true });
    const init = await initializeVolume({ db: sql, client: svc, principal: P });
    assert.ok(init.collections.some((c) => c.collectionName === lavoro.slug));
    configureRadicaleRuntime({ client: svc, dataDir: rad.storageDir, principal: P, watch: 'off', identitySource: 'auto' });

    const invite = vcal(vevent([
      'UID:040000008200E00074C5B7101A82E00800000000@outlook.example',
      'SUMMARY:Revisione trimestrale', 'ORGANIZER;CN=Cliente:mailto:cliente@example.com',
      'ATTENDEE;CN=Federico;PARTSTAT=ACCEPTED:mailto:federico@example.com',
      'DTSTART;TZID=Europe/Rome:20261110T100000', 'DTEND;TZID=Europe/Rome:20261110T110000',
    ], ALARM));
    await put(personale, 'invito.ics', invite);
    await put(lavoro, 'invito-copia.ics', invite);
    await put(lavoro, 'rdate.ics', vcal(vevent([
      'UID:7C1D-RDATE@iphone', 'SUMMARY:Corso', 'DTSTART;TZID=Europe/Rome:20261001T100000', 'DTEND;TZID=Europe/Rome:20261001T110000',
      'RRULE:FREQ=WEEKLY;COUNT=6', 'RDATE;TZID=Europe/Rome:20261014T150000', 'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC',
    ], ALARM)));
    await put(lavoro, 'ny.ics', vcal(vevent([
      'UID:NY-CALL@iphone', 'SUMMARY:Call New York', 'DTSTART;TZID=America/New_York:20261005T100000', 'DTEND;TZID=America/New_York:20261005T110000',
      'RRULE:FREQ=WEEKLY;COUNT=10',
    ])));
    await put(lavoro, 'zero.ics', vcal(vevent(['UID:ZERO@iphone', 'SUMMARY:Scadenza', 'DTSTART:20261120T090000Z', 'DTEND:20261120T090000Z'])));
    await put(lavoro, 'senza-titolo.ics', vcal(vevent(['UID:NOSUMMARY@iphone', 'DTSTART:20261121T090000Z', 'DTEND:20261121T100000Z'])));
    await put(lavoro, 'serie.ics', vcal(
      vevent(['UID:SERIE@iphone', 'SUMMARY:Standup', 'DTSTART;TZID=Europe/Rome:20261116T090000', 'DTEND;TZID=Europe/Rome:20261116T093000', 'RRULE:FREQ=DAILY;COUNT=5']),
      vevent(['UID:SERIE@iphone', 'SUMMARY:Standup spostato', 'RECURRENCE-ID;TZID=Europe/Rome:20261118T090000', 'DTSTART;TZID=Europe/Rome:20261118T140000', 'DTEND;TZID=Europe/Rome:20261118T143000']),
    ));
    // L'invito in "personale" entra nell'indice per primo: è lui a tenere l'UID.
    await sync(personale);
    await sleep(20);
    await sync(lavoro);
    await sql`
      UPDATE calendar_backend_state
      SET mode = 'radicale', write_freeze = false, rollback_until = now() + interval '30 days', cutover_at = now() - interval '1 hour', cutover_by = 'admin:test-reverse'
      WHERE id
    `;
    invalidateBackendModeCache();
  });

  after(async () => {
    await sql`UPDATE calendar_backend_state SET mode = 'postgres', rollback_until = NULL, cutover_at = NULL, cutover_by = NULL WHERE id`;
    invalidateBackendModeCache();
    configureRadicaleRuntime(null);
    svc?.close();
    await rad?.stop();
  });

  test('passata completa: righe sanificate e classificate, nessun REVERSE_FAILED, busy legacy identico', async () => {
    const summary = await runReverseProjection({ actor: 'admin:test-reverse', calendarIds: [personale.id, lavoro.id] });
    assert.equal(summary.failed, 0, JSON.stringify(await sql`SELECT href, error FROM cal_migration_reverse_state WHERE status = 'failed'`));
    assert.equal(summary.objects, 7);

    const original = (await rows(await objectId(personale, 'invito.ics')))[0];
    const copy = (await rows(await objectId(lavoro, 'invito-copia.ics')))[0];
    assert.equal(original.uid, '040000008200E00074C5B7101A82E00800000000@outlook.example');
    assert.equal(copy.uid, `040000008200E00074C5B7101A82E00800000000@outlook.example@${lavoro.slug}`);
    assert.deepEqual(await degradations(await objectId(lavoro, 'invito-copia.ics')), ['REPR_LOSS_ATTENDEE', 'REPR_LOSS_VALARM', 'SANITIZED_UID']);

    const rdate = await rows(await objectId(lavoro, 'rdate.ics'));
    assert.equal(rdate.length, 7);
    assert.ok(rdate.every((r) => r.caldes_derived));
    assert.ok(rdate.some((r) => r.start_time.toISOString() === '2026-10-14T13:00:00.000Z'), 'occorrenza della RDATE');
    assert.deepEqual(await degradations(await objectId(lavoro, 'rdate.ics')), ['REPR_LOSS_PROPERTY', 'REPR_LOSS_VALARM', 'SEMANTIC_EXPANDED']);

    const zero = (await rows(await objectId(lavoro, 'zero.ics')))[0];
    assert.equal(zero.end_time.getTime() - zero.start_time.getTime(), 60_000);
    assert.equal((await rows(await objectId(lavoro, 'senza-titolo.ics')))[0].summary, '(senza titolo)');
    const serie = await rows(await objectId(lavoro, 'serie.ics'));
    assert.equal(serie.length, 2);
    assert.equal(serie.find((r) => r.recurrence_master_id)?.uid, 'SERIE@iphone#20261118T080000Z');

    assert.deepEqual(distinct(await legacyBusyRanges(WINDOW.from, WINDOW.to)), await indexBusyRanges(sql, WINDOW.from, WINDOW.to));
  });

  test('NOTIFY dell\'indice → job reverse_projection: RDATE aggiunta e risorsa cancellata dal device', async () => {
    registerReverseProjectionJob();
    const stop = await startReverseProjectionTrigger();
    try {
      await sql`DELETE FROM cal_jobs WHERE kind = ${REVERSE_PROJECTION_JOB_KIND}`;
      const href = 'rdate.ics';
      const current = await svc.get(objectPath(P, lavoro.slug, href));
      const updated = current.body.replace('RDATE;TZID=Europe/Rome:20261014T150000', 'RDATE;TZID=Europe/Rome:20261014T150000,20261028T150000');
      assert.notEqual(updated, current.body);
      await put(lavoro, href, updated, { ifMatch: current.etag ?? '*' });
      const zero = await svc.get(objectPath(P, lavoro.slug, 'zero.ics'));
      await svc.delete(objectPath(P, lavoro.slug, 'zero.ics'), { ifMatch: zero.etag ?? '*' });
      const zeroId = await objectId(lavoro, 'zero.ics');
      // Senza mount (remote mode) la cancellazione si conferma al secondo 404: la prima sync la tiene in pending_404.
      await sync(lavoro);
      await sync(lavoro);
      // Debounce di 2 s: il job compare in coda per la collezione.
      const deadline = Date.now() + 8_000;
      for (;;) {
        const [job] = await sql<Array<{ status: string }>>`SELECT status FROM cal_jobs WHERE kind = ${REVERSE_PROJECTION_JOB_KIND} AND key = ${lavoro.id}`;
        if (job) break;
        if (Date.now() > deadline) assert.fail('job reverse_projection non accodato dal NOTIFY');
        await sleep(100);
      }
      await runCalendarJobsOnce();
      const jobs = await sql<Array<{ status: string; result: { failed?: number } | null }>>`
        SELECT status, result FROM cal_jobs WHERE kind = ${REVERSE_PROJECTION_JOB_KIND} AND key = ${lavoro.id}
      `;
      assert.deepEqual(jobs.map((j) => j.status), ['done']);
      assert.equal(jobs[0].result?.failed, 0);
      const rdate = await rows(await objectId(lavoro, href));
      assert.equal(rdate.length, 8);
      assert.ok(rdate.some((r) => r.start_time.toISOString() === '2026-10-28T14:00:00.000Z'), 'nuova RDATE (dopo il cambio d\'ora)');
      assert.equal((await rows(zeroId)).length, 0, 'righe della risorsa cancellata tolte');
      const [state] = await sql<Array<{ status: string }>>`SELECT status FROM cal_migration_reverse_state WHERE object_id = ${zeroId}::uuid`;
      assert.equal(state.status, 'removed');
      assert.deepEqual(distinct(await legacyBusyRanges(WINDOW.from, WINDOW.to)), await indexBusyRanges(sql, WINDOW.from, WINDOW.to));
    } finally {
      await stop();
    }
  });

  test('seconda passata senza modifiche: nessuna scrittura, hash invariato', async () => {
    const before = await computeReversePlan(sql, { calendarIds: [personale.id, lavoro.id], now: new Date() });
    const summary = await runReverseProjection({ actor: 'admin:test-reverse', calendarIds: [personale.id, lavoro.id] });
    assert.deepEqual(summary.rows, { inserted: 0, updated: 0, deleted: 0 });
    assert.equal(summary.unchanged, summary.objects);
    assert.equal(summary.hash, before.hash);
  });
});
