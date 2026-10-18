/**
 * Indice derivato contro Radicale 3.7.8 reale: rebuild, quarantena e auditor
 * (piano F2, "Test": Salute e Rebuild; contratto dei moduli
 * docs/calendar-radicale/contracts/f2-modules.md §5.1-§5.4 e §11; design
 * §6.5, §6.7, §6.8).
 *
 * Un Radicale con storage multifilesystem in una directory temporanea, auth
 * htpasswd con il solo caldes-svc e rights from_file con la matrice di
 * caldes-svc del contratto control-plane §8. Il volume si inizializza con
 * initializeVolume() di F1 (principal, marker volume-id/epoch, collezioni del
 * sidecar); il runtime della sync punta allo storage come a RADICALE_DATA_DIR.
 *
 * Casi:
 *  - RRULE invalida scritta da un device in una collezione bloccante →
 *    quarantena e busy conservativo, le altre risorse intatte;
 *  - file corrotto sul volume (item che Radicale salta) → quarantena
 *    'radicale-skip' con l'ultima versione buona;
 *  - rebuild da zero (righe derivate cancellate) con gli stessi id; durante il
 *    rebuild le decisioni forzano la sync (o rispondono 503 con Radicale
 *    fermo), mai busy vuoto; rebuild_required si azzera solo a rebuild
 *    riuscito;
 *  - auditor: differenza fra (href, etag) di Radicale e indice → resync;
 *    file sul volume assente dal listing → quarantena; bookings nulli in mode
 *    postgres.
 *
 * Senza RADICALE_BIN la suite è saltata con il motivo. Date fisse nel 2027.
 */

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql, useTestDatabase } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';
import { radicaleAvailability, type RadicaleServer, startRadicale, TEST_PRINCIPAL } from '../helpers/radicale';
import { CalendarUnavailableError } from '../../src/lib/calendar/errors';
import { HEALTH_REASONS } from '../../src/lib/calendar/index-model';
import { overrideCalendarStore } from '../../src/lib/calendar/store';
import type { Calendar } from '../../src/lib/calendar/types';
import { runCalendarAudit } from '../../src/lib/calendar/radicale/auditor';
import { objectPath, RadicaleClient } from '../../src/lib/calendar/radicale/client';
import { verifyFreshness } from '../../src/lib/calendar/radicale/freshness';
import { initializeVolume } from '../../src/lib/calendar/radicale/identity';
import { stopIndexWorker } from '../../src/lib/calendar/radicale/indexer';
import { requestIndexRebuild, runIndexRebuild } from '../../src/lib/calendar/radicale/rebuild';
import { configureRadicaleRuntime, syncCollection, updateWatchMode } from '../../src/lib/calendar/radicale/sync';

useTestDatabase({ resetBaseline: true });
onBeforeDatabaseClose(async () => {
  overrideCalendarStore(null);
  await stopIndexWorker();
  await resetCalendarBaseline();
});
const fx = useFixtures('idx-rebuild');

const radicale = radicaleAvailability();
const P = TEST_PRINCIPAL;
const SVC_PASSWORD = 'test-only-svc-password-f2-index';

/** Matrice di caldes-svc del contratto control-plane §8 (R root, RW principal, rwD collezioni). */
const SVC_RIGHTS_RULES = [
  '[root]', 'user: .+', 'collection:', 'permissions: R', '',
  '[svc-principal]', 'user: caldes-svc', `collection: ${P}`, 'permissions: RW', '',
  '[svc-collections]', 'user: caldes-svc', `collection: ${P}/[^/]+`, 'permissions: rwD', '',
].join('\n');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function ics(...components: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Calicchia Design//Test indice F2//IT', ...components, 'END:VCALENDAR', ''].join('\r\n');
}

function vevent(lines: string[]): string {
  return ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
}

/** Serie di produzione lun-mar-gio-ven alle 09:00 Roma, con un override spostato. */
const SERIES = ics(
  vevent(['UID:idx-serie', 'DTSTAMP:20261001T080000Z', 'DTSTART;TZID=Europe/Rome:20270104T090000', 'DTEND;TZID=Europe/Rome:20270104T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR', 'SUMMARY:Studio']),
  vevent(['UID:idx-serie', 'DTSTAMP:20261001T080000Z', 'RECURRENCE-ID;TZID=Europe/Rome:20270105T090000', 'DTSTART;TZID=Europe/Rome:20270105T150000', 'DTEND;TZID=Europe/Rome:20270105T160000', 'SUMMARY:Studio (spostato)']),
);

function single(uid: string, start: string, end: string, extra: string[] = []): string {
  return ics(vevent([`UID:${uid}`, 'DTSTAMP:20261001T080000Z', `DTSTART:${start}`, `DTEND:${end}`, 'SUMMARY:Singolo', ...extra]));
}

interface ObjRow { id: string; href: string; etag: string | null; health: string; health_reason: string | null; last_good_version_id: string | null }

async function objectsOf(calendarId: string): Promise<ObjRow[]> {
  return Array.from(await sql<ObjRow[]>`
    SELECT id, href, etag, health, health_reason, last_good_version_id FROM cal_objects WHERE calendar_id = ${calendarId} ORDER BY href
  `);
}

async function componentIds(calendarIds: string[]): Promise<Array<{ href: string; recurrence_key: string; id: string }>> {
  return Array.from(await sql<Array<{ href: string; recurrence_key: string; id: string }>>`
    SELECT o.href, c.recurrence_key, c.id FROM cal_components c JOIN cal_objects o ON o.id = c.object_id
    WHERE o.calendar_id = ANY(${calendarIds}::uuid[]) ORDER BY o.href, c.recurrence_key
  `, (r) => ({ ...r }));
}

/** Occorrenze bloccanti della collezione (o della sola risorsa `href`) che toccano [from, to). */
async function blockingIn(calendarId: string, from: string, to: string, href?: string): Promise<number> {
  const [row] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM cal_occurrences x
    JOIN cal_objects o ON o.id = x.object_id
    WHERE x.calendar_id = ${calendarId} AND x.blocks AND x.span && tstzrange(${from}::timestamptz, ${to}::timestamptz, '[)')
      AND (${href ?? null}::text IS NULL OR o.href = ${href ?? null})
  `;
  return row.n;
}

describe('indice contro Radicale reale: quarantena, rebuild e auditor', { skip: radicale.skip }, () => {
  let rad: RadicaleServer;
  let svc: RadicaleClient;
  const cal: Record<string, Calendar> = {};
  const put = (key: string, name: string, body: string) => svc.put(objectPath(P, cal[key].slug, name), body, { ifNoneMatch: '*' });
  const sync = (key: string, full = false) => syncCollection(cal[key].id, { reason: 'manual', full });
  const storagePath = (key: string, name: string): string => join(rad.storageDir, 'collection-root', P, cal[key].slug, name);

  before(async () => {
    rad = await startRadicale({
      label: 'f2-index',
      auth: { type: 'htpasswd', users: { 'caldes-svc': SVC_PASSWORD } },
      rights: { type: 'from_file', rules: SVC_RIGHTS_RULES },
    });
    svc = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0 });
    for (const key of ['studio', 'device']) cal[key] = await fx.calendar({ key, blocks_availability: true });
    await initializeVolume({ db: sql, client: svc, principal: P });
    configureRadicaleRuntime({ client: svc, dataDir: rad.storageDir, principal: P, watch: 'auto', identitySource: 'auto' });
    updateWatchMode('mount', null);
  });

  after(async () => {
    configureRadicaleRuntime(null);
    updateWatchMode('off', 'test concluso');
    svc?.close();
    await rad?.stop();
  });

  test('RRULE invalida da un device in una collezione bloccante: quarantena e busy conservativo', async () => {
    await put('device', 'buona.ics', single('dev-ok', '20270112T080000Z', '20270112T090000Z'));
    // Radicale accetta la PUT (dateutil tiene l'ultima delle parti ripetute, RFC 5545 §3.3.10 le vieta):
    // per calendar-core la RRULE non è valida e l'indice mette l'oggetto in quarantena.
    await put('device', 'rrule.ics', ics(vevent([
      'UID:dev-rrule', 'DTSTAMP:20261001T080000Z', 'DTSTART;TZID=Europe/Rome:20270111T100000', 'DTEND;TZID=Europe/Rome:20270111T110000',
      'RRULE:FREQ=WEEKLY;BYDAY=MO;BYDAY=TU', 'SUMMARY:Regola rotta',
    ])));
    await sleep(60);
    const res = await sync('device');
    assert.equal(res.quarantined, 1);
    const objects = await objectsOf(cal.device.id);
    assert.deepEqual(objects.map((o) => [o.href, o.health, o.health_reason]), [
      ['buona.ics', 'ok', null],
      ['rrule.ics', 'quarantined', HEALTH_REASONS.invalidRrule],
    ]);
    // Busy conservativo dal DTSTART in poi: qualunque giornata successiva è occupata (anche un mercoledì).
    assert.equal(await blockingIn(cal.device.id, '2027-03-03T00:00:00Z', '2027-03-04T00:00:00Z', 'rrule.ics'), 1);
    assert.equal(await blockingIn(cal.device.id, '2027-01-11T00:00:00Z', '2027-01-11T09:00:00Z', 'rrule.ics'), 0, 'prima del DTSTART non blocca');
    const [{ health }] = await sql<Array<{ health: string }>>`SELECT health FROM cal_collection_state WHERE calendar_id = ${cal.device.id}`;
    assert.equal(health, 'healthy', 'un oggetto rotto non rende la collezione non sincronizzabile');
  });

  test('file corrotto sul volume: quarantena radicale-skip con l\'ultima versione buona', async () => {
    await put('studio', 'serie.ics', SERIES);
    await put('studio', 'singolo.ics', single('idx-singolo', '20270115T080000Z', '20270115T090000Z'));
    await put('studio', 'fragile.ics', single('idx-fragile', '20270118T080000Z', '20270118T090000Z'));
    await sleep(60);
    await sync('studio');
    const [good] = (await objectsOf(cal.studio.id)).filter((o) => o.href === 'fragile.ics');
    assert.equal(good.health, 'ok');
    // Il file si corrompe sul disco (es. scritto a metà): Radicale non lo serve più.
    writeFileSync(storagePath('studio', 'fragile.ics'), 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:idx-fragile\r\nDTSTART:2027');
    await sleep(60);
    await sync('studio', true);
    const [bad] = (await objectsOf(cal.studio.id)).filter((o) => o.href === 'fragile.ics');
    assert.equal(bad.id, good.id);
    assert.deepEqual([bad.health, bad.health_reason], ['quarantined', HEALTH_REASONS.radicaleSkip]);
    assert.equal(bad.last_good_version_id, good.last_good_version_id);
    assert.equal(await blockingIn(cal.studio.id, '2027-01-18T00:00:00Z', '2027-01-19T00:00:00Z', 'fragile.ics'), 1, 'continua a bloccare con la versione buona');
    const [{ stale }] = await sql<Array<{ stale: boolean }>>`
      SELECT bool_and(x.stale) AS stale FROM cal_occurrences x WHERE x.object_id = ${bad.id}
    `;
    assert.equal(stale, true, 'occorrenze dell\'ultima versione buona marcate stale');
    // Riparato sul disco con un testo valido: torna ok alla sync successiva.
    writeFileSync(storagePath('studio', 'fragile.ics'), single('idx-fragile', '20270118T080000Z', '20270118T093000Z'));
    await sleep(60);
    await sync('studio', true);
    const [fixed] = (await objectsOf(cal.studio.id)).filter((o) => o.href === 'fragile.ics');
    assert.equal(fixed.health, 'ok');
    assert.equal(fixed.id, good.id);
    assert.notEqual(fixed.last_good_version_id, good.last_good_version_id, 'il testo riparato è la nuova versione buona');
  });

  test('rebuild da zero con gli stessi id; durante il rebuild decisioni con sync forzata o 503, mai busy vuoto', async () => {
    const ids = [cal.studio.id, cal.device.id];
    const before = await componentIds(ids);
    assert.ok(before.some((r) => r.href === 'serie.ics' && r.recurrence_key !== ''), 'l\'override ha un proprio id');

    const busyBefore = await blockingIn(cal.studio.id, '2027-01-11T00:00:00Z', '2027-01-12T00:00:00Z');
    assert.ok(busyBefore > 0);

    await requestIndexRebuild(sql, { reason: 'test', actor: 'test' });
    const [reset] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM cal_collection_state
      WHERE calendar_id = ANY(${ids}::uuid[]) AND (dir_mtime_ns IS NOT NULL OR sync_token IS NOT NULL)
    `;
    assert.equal(reset.n, 0, 'richiesta del rebuild: dir_mtime_ns e sync_token azzerati');
    // Le decisioni valgono solo con lo store Radicale (in mode postgres verifyFreshness non fa nulla).
    overrideCalendarStore('radicale');
    // Radicale irraggiungibile durante il rebuild: la decisione non si fida delle righe vecchie (dir_mtime NULL) → 503.
    const dead = new RadicaleClient({ baseUrl: 'http://127.0.0.1:9', password: SVC_PASSWORD, retries: 0, timeoutMs: 300 });
    configureRadicaleRuntime({ client: dead });
    try {
      await assert.rejects(verifyFreshness({ db: sql, budgetMs: 1_500 }), (err: unknown) => {
        assert.ok(err instanceof CalendarUnavailableError);
        assert.ok(['rebuild_in_progress', 'radicale_unreachable', 'freshness_timeout'].includes(err.reason), err.reason);
        return true;
      });
      assert.equal(await blockingIn(cal.studio.id, '2027-01-11T00:00:00Z', '2027-01-12T00:00:00Z'), busyBefore, 'il busy esistente non sparisce');
      // Il rebuild con Radicale irraggiungibile non si completa: rebuild_required resta.
      const failed = await runIndexRebuild();
      assert.equal(failed.cleared, false);
      assert.ok(failed.collections.some((c) => !c.ok));
      assert.equal(await blockingIn(cal.studio.id, '2027-01-11T00:00:00Z', '2027-01-12T00:00:00Z'), busyBefore, 'rebuild fallito: busy invariato');
    } finally {
      configureRadicaleRuntime({ client: svc });
      dead.close();
    }
    let [state] = await sql<Array<{ rebuild_required: boolean }>>`SELECT rebuild_required FROM calendar_backend_state WHERE id = true`;
    assert.equal(state.rebuild_required, true);

    // Con Radicale di nuovo raggiungibile la decisione forza la sync delle collezioni e procede.
    try {
      const fresh = await verifyFreshness({ db: sql, budgetMs: 10_000 });
      assert.ok(ids.every((id) => fresh.synced.includes(id)), 'sync forzata delle collezioni con dir_mtime_ns NULL');
    } finally {
      overrideCalendarStore(null);
    }

    // Rebuild da zero: le righe derivate spariscono, id e versioni restano.
    await sql`DELETE FROM cal_objects WHERE calendar_id = ANY(${ids}::uuid[])`;
    await requestIndexRebuild(sql, { reason: 'test da zero', actor: 'test' });
    const report = await runIndexRebuild();
    assert.equal(report.cleared, true, JSON.stringify(report.collections));
    assert.ok(report.collections.every((c) => c.ok));
    [state] = await sql<Array<{ rebuild_required: boolean }>>`SELECT rebuild_required FROM calendar_backend_state WHERE id = true`;
    assert.equal(state.rebuild_required, false);
    assert.deepEqual(await componentIds(ids), before, 'stessi id dopo il rebuild');
    const objects = await objectsOf(cal.device.id);
    assert.deepEqual(objects.map((o) => [o.href, o.health]), [['buona.ics', 'ok'], ['rrule.ics', 'quarantined']], 'la quarantena si ricostruisce');
    await sql`DELETE FROM cal_jobs WHERE kind = 'index_rebuild'`;
  });

  test('auditor: indice diverso da Radicale → resync; file sul volume assente dal listing → quarantena', async () => {
    // Indice "sporco": etag alterato su una risorsa.
    await sql`UPDATE cal_objects SET etag = '"falso"' WHERE calendar_id = ${cal.studio.id} AND href = 'singolo.ics'`;
    // File rotto mai indicizzato (Radicale lo salta): solo l'auditor lo vede.
    writeFileSync(storagePath('studio', 'nascosto.ics'), 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:idx-nascosto\r\nDTSTART:20270120T080000Z\r\nDTEND:20270120T090000Z');
    const report = await runCalendarAudit({ client: svc, principal: P, dataDir: rad.storageDir, controlPlane: null });
    assert.equal(report.identity, 'ok');
    assert.equal(report.bookings, null, 'mode postgres: le proiezioni sono ancora legacy');
    const studio = report.collections.find((c) => c.calendarId === cal.studio.id);
    assert.ok(studio);
    assert.ok(studio.etagMismatches >= 1);
    assert.equal(studio.resynced, true);
    assert.deepEqual(studio.brokenFiles, ['nascosto.ics']);
    const [fixedEtag] = (await objectsOf(cal.studio.id)).filter((o) => o.href === 'singolo.ics');
    assert.notEqual(fixedEtag.etag, '"falso"', 'la resync riallinea l\'etag');
    const [hidden] = (await objectsOf(cal.studio.id)).filter((o) => o.href === 'nascosto.ics');
    assert.deepEqual([hidden?.health, hidden?.health_reason], ['quarantined', HEALTH_REASONS.radicaleSkip]);
    assert.equal(await blockingIn(cal.studio.id, '2027-01-20T00:00:00Z', '2027-01-21T00:00:00Z', 'nascosto.ics'), 1, 'busy conservativo del file rotto');
  });
});
