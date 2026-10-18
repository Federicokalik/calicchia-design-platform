/**
 * Passo C1 della tranche C dell'API admin v2 contro Radicale 3.7.8 reale
 * (editor raw, sposta, duplica, export, cronologia, cestino; contratto
 * docs/calendar-radicale/contracts/f6-modules.md §9.1.2, §9.1.3, §9.9).
 *
 * Un Radicale con storage multifilesystem in una directory temporanea e il
 * solo caldes-svc (stessa matrice di admin-v2-radicale.test.ts). Lo store è
 * forzato su Radicale; le richieste passano da app.request come in produzione.
 *
 * Casi: PUT raw lossless (byte per byte salvo CRLF), avviso
 * sequence_not_bumped, 412 con un device concorrente, noop, testo non valido
 * (400, in dryRun valid=false), riparazione di un oggetto illeggibile; dryRun
 * senza cambiare l'ETag né l'audit; sposta con lo stesso id, noop sullo stesso
 * calendario, MOVE_CONFLICT; duplica di un'istanza (data dell'occorrenza,
 * senza RRULE), con `start`, con keep_recurrence, in un altro calendario e
 * OBJECT_EXISTS; export identico a /ics; cronologia dopo tre modifiche
 * (changed_fields, current), dettaglio, versione di un altro oggetto;
 * ripristino con SEQUENCE+1 e versione `restore`; versione scaduta, non valida
 * e di un altro oggetto → 409 VERSION_NOT_RESTORABLE; cestino: elimina →
 * elenco → ripristino con lo stesso id, uid_exists, expired, href_taken,
 * calendario di destinazione diverso, paginazione, audit senza testo.
 *
 * Senza RADICALE_BIN la suite è saltata con il motivo. Date fisse nel 2027-2028.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { bookingHref, bookingProjectionUid } from '@calicchia/calendar-core';
import type { CalV2ObjectView, CalV2TrashList, CalV2VersionDetail, CalV2VersionList, CalV2WriteResult } from '@calicchia/shared';
import { objectPath, RadicaleClient } from '../../src/lib/calendar/radicale/client';
import { initializeVolume } from '../../src/lib/calendar/radicale/identity';
import { stopIndexWorker } from '../../src/lib/calendar/radicale/indexer';
import { configureRadicaleRuntime, syncCollection, updateWatchMode } from '../../src/lib/calendar/radicale/sync';
import { overrideCalendarStore } from '../../src/lib/calendar/store';
import type { Calendar } from '../../src/lib/calendar/types';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql, useTestDatabase } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';
import { api } from '../helpers/http';
import { radicaleAvailability, type RadicaleServer, startRadicale, TEST_PRINCIPAL } from '../helpers/radicale';

useTestDatabase({ resetBaseline: true });
onBeforeDatabaseClose(async () => {
  overrideCalendarStore(null);
  await stopIndexWorker();
  await resetCalendarBaseline();
});
const fx = useFixtures('admin-v2-c1-int');

const radicale = radicaleAvailability();
const P = TEST_PRINCIPAL;
const SVC_PASSWORD = 'test-only-svc-password-f6-admin-v2-c1';
const BASE = '/api/admin/calendar/v2';

/** Matrice di caldes-svc del contratto control-plane §8 (R root, RW principal, rwD collezioni). */
const SVC_RIGHTS_RULES = [
  '[root]', 'user: .+', 'collection:', 'permissions: R', '',
  '[svc-principal]', 'user: caldes-svc', `collection: ${P}`, 'permissions: RW', '',
  '[svc-collections]', 'user: caldes-svc', `collection: ${P}/[^/]+`, 'permissions: rwD', '',
].join('\n');

const unfold = (text: string): string => text.replace(/\r\n[ \t]/g, '');
const rome = (date: string, hh: number, mm = 0) => {
  const [year, month, day] = date.split('-').map(Number);
  return { type: 'date-time', year, month, day, hour: hh, minute: mm, second: 0, zone: { kind: 'tzid', tzid: 'Europe/Rome' } } as const;
};
const day = 86_400_000;
/** Righe spiegate e ordinate: Radicale (vobject) riordina le proprietà di un componente alla PUT di un device. */
const lines = (text: string): string[] => unfold(text).split(/\r\n/).sort();

/** Evento con VALARM, ATTENDEE e X-* con parametri sconosciuti: tutto ciò che non si deve perdere. */
const eventText = (uid: string, over: { summary?: string; start?: string; end?: string; sequence?: number; extra?: string[] } = {}): string =>
  [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//C1//IT',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20270101T080000Z',
    `DTSTART:${over.start ?? '20280301T080000Z'}`,
    `DTEND:${over.end ?? '20280301T090000Z'}`,
    `SEQUENCE:${over.sequence ?? 0}`,
    `SUMMARY:${over.summary ?? 'Evento raw'}`,
    'X-ACME-CUSTOM;X-PARAM=uno:valore',
    'ATTENDEE;CN=Mario Rossi;PARTSTAT=NEEDS-ACTION:mailto:mario@example.com',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'DESCRIPTION:Tra poco', 'END:VALARM',
    ...(over.extra ?? []),
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');

describe('API admin v2, passo C1, contro Radicale reale', { skip: radicale.skip }, () => {
  let rad: RadicaleServer;
  let svc: RadicaleClient;
  let cal: Calendar;
  let other: Calendar;

  const textOf = async (c: Calendar, href: string): Promise<{ body: string; etag: string } | null> => {
    try {
      const res = await svc.get(objectPath(P, c.slug, href));
      return { body: res.body, etag: res.etag as string };
    } catch (err) {
      if ((err as { code?: string }).code === 'not_found') return null;
      throw err;
    }
  };

  const deviceWrite = async (c: Calendar, href: string, text: string): Promise<void> => {
    await svc.put(objectPath(P, c.slug, href), text, { ifNoneMatch: '*' });
    await syncCollection(c.id, { reason: 'manual' });
  };

  /** Modifica da device con If-Match, poi indicizza. */
  const deviceEdit = async (c: Calendar, href: string, edit: (text: string) => string): Promise<string> => {
    const cur = await svc.get(objectPath(P, c.slug, href));
    const res = await svc.put(objectPath(P, c.slug, href), edit(cur.body), { ifMatch: cur.etag as string });
    await syncCollection(c.id, { reason: 'manual' });
    return res.etag as string;
  };

  const read = async (id: string, query: Record<string, string> = {}): Promise<CalV2ObjectView> => {
    const res = await api.get(`${BASE}/objects/${encodeURIComponent(id)}`, { auth: 'admin', query });
    assert.equal(res.status, 200, res.text);
    return res.json as CalV2ObjectView;
  };

  /** Evento scritto da un device e indicizzato; restituisce vista e href. */
  const seed = async (c: Calendar, over: Parameters<typeof eventText>[1] = {}): Promise<{ view: CalV2ObjectView; href: string; uid: string }> => {
    const uid = `c1-${randomUUID()}@caldes.test`;
    const href = `${uid}.ics`;
    await deviceWrite(c, href, eventText(uid, over));
    return { view: await read(uid), href, uid };
  };

  const create = async (c: Calendar, fields: Record<string, unknown>, over: Record<string, unknown> = {}): Promise<CalV2ObjectView> => {
    const res = await api.post(`${BASE}/objects`, { auth: 'admin', body: { calendar_id: c.id, fields, ...over } });
    assert.equal(res.status, 201, res.text);
    return (res.json as CalV2WriteResult).object as CalV2ObjectView;
  };

  const patchField = async (view: CalV2ObjectView, field: string, value: unknown): Promise<CalV2WriteResult> => {
    const fresh = await read(view.id);
    const res = await api.patch(`${BASE}/objects/${view.id}`, {
      auth: 'admin',
      headers: { 'If-Match': fresh.etag as string },
      body: { target: { recurrence_key: '' }, scope: 'all', ops: [{ op: 'set', field, value }], base: { [field]: fresh.target?.tokens[field] ?? '-' } },
    });
    assert.equal(res.status, 200, res.text);
    return res.json as CalV2WriteResult;
  };

  const rawPut = (id: string, etag: string, ics: string, over: Record<string, unknown> = {}) =>
    api.put<CalV2WriteResult & { code?: string; current?: CalV2ObjectView; conflicts?: unknown[]; details?: { issues?: Array<{ code: string; property?: string; severity: string }> } }>(
      `${BASE}/objects/${encodeURIComponent(id)}/ics`,
      { auth: 'admin', headers: { 'If-Match': etag }, body: { ics, ...over } },
    );

  const auditRows = (id: string) => sql<Array<{ action: string; metadata: Record<string, unknown>; old_data: unknown; new_data: unknown }>>`
    SELECT action, metadata, old_data, new_data FROM audit_logs WHERE table_name = 'cal_objects' AND record_id = ${id} ORDER BY created_at, id
  `;
  const auditTotal = async (): Promise<number> => Number((await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM audit_logs WHERE table_name = 'cal_objects'`)[0].n);

  const versionsOf = async (id: string): Promise<CalV2VersionList> => {
    const res = await api.get(`${BASE}/objects/${encodeURIComponent(id)}/versions`, { auth: 'admin' });
    assert.equal(res.status, 200, res.text);
    return res.json as CalV2VersionList;
  };

  const trash = async (query: Record<string, string> = {}): Promise<CalV2TrashList> => {
    const res = await api.get(`${BASE}/trash`, { auth: 'admin', query });
    assert.equal(res.status, 200, res.text);
    return res.json as CalV2TrashList;
  };

  const del = async (view: CalV2ObjectView) => {
    const fresh = await read(view.id);
    const res = await api.delete(`${BASE}/objects/${view.id}`, { auth: 'admin', headers: { 'If-Match': fresh.etag as string }, query: { scope: 'all' } });
    assert.equal(res.status, 200, res.text);
  };

  before(async () => {
    rad = await startRadicale({
      label: 'f6-admin-v2-c1',
      auth: { type: 'htpasswd', users: { 'caldes-svc': SVC_PASSWORD } },
      rights: { type: 'from_file', rules: SVC_RIGHTS_RULES },
    });
    svc = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0 });
    cal = await fx.calendar({ key: 'lav', blocks_availability: true });
    other = await fx.calendar({ key: 'altro', blocks_availability: true });
    const init = await initializeVolume({ db: sql, client: svc, principal: P });
    assert.ok(init.collections.every((c) => c.status === 'created'));
    configureRadicaleRuntime({ client: svc, dataDir: rad.storageDir, principal: P, watch: 'auto', identitySource: 'auto' });
    updateWatchMode('mount', null);
    overrideCalendarStore('radicale');
  });

  after(async () => {
    overrideCalendarStore(null);
    configureRadicaleRuntime(null);
    updateWatchMode('off', 'test concluso');
    svc?.close();
    await rad?.stop();
  });

  // ── Editor raw ──

  test('capacità: i quattro flag del passo C1 sono veri', async () => {
    const res = await api.get(`${BASE}/capabilities`, { auth: 'admin' });
    for (const flag of ['raw_edit', 'object_tools', 'history', 'trash']) assert.equal(res.json[flag], true, flag);
  });

  test('PUT raw lossless: il testo arriva in Radicale byte per byte (salvo CRLF), nessun ritocco di DTSTAMP, SEQUENCE e VALARM', async () => {
    const { view, href, uid } = await seed(cal);
    const stored = await textOf(cal, href);
    assert.ok(stored);
    // L'utente modifica a mano: titolo, una X-prop nuova, una riga con "a capo" LF (l'editor li manda così).
    const edited = stored.body.replace('SUMMARY:Evento raw', 'SUMMARY:Titolo modificato a mano').replace('X-ACME-CUSTOM;X-PARAM=uno:valore', 'X-ACME-CUSTOM;X-PARAM=due:cambiato\r\nX-NUOVA:1');
    const withLf = edited.replace(/\r\n/g, '\n');
    const before = await auditTotal();
    const res = await rawPut(view.id, stored.etag, withLf);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.changed, ['raw']);
    assert.equal(res.json.noop, false);
    assert.equal(res.json.sequence_bumped, false);
    assert.equal(res.headers.get('etag'), res.json.etag);
    assert.notEqual(res.json.etag, stored.etag);
    const after = await textOf(cal, href);
    assert.ok(after);
    assert.equal(after.etag, res.json.etag);
    assert.equal(after.body, edited, 'testo identico byte per byte (CRLF)');
    assert.match(after.body, /DTSTAMP:20270101T080000Z/, 'DTSTAMP non toccato');
    assert.match(after.body, /SEQUENCE:0/, 'SEQUENCE non toccata');
    assert.equal(res.json.object?.uid, uid);
    assert.equal(res.json.object?.master?.fields.summary, 'Titolo modificato a mano');
    assert.equal(res.json.object?.id, view.id);
    // Audit senza testo.
    const rows = await auditRows(view.id);
    const audit = rows.find((a) => a.metadata.operation === 'v2.raw');
    assert.ok(audit, 'riga v2.raw');
    assert.equal(await auditTotal(), before + 1);
    assert.doesNotMatch(JSON.stringify(audit), /Titolo modificato a mano|mario@example/);
    assert.deepEqual((audit as { old_data: { href: string } }).old_data, { collection: cal.slug, href, etag: stored.etag });
  });

  test('avviso sequence_not_bumped: tempi cambiati senza SEQUENCE+1; con SEQUENCE+1 nessun avviso', async () => {
    const { view, href } = await seed(cal);
    const stored = (await textOf(cal, href)) as { body: string; etag: string };
    const moved = stored.body.replace('DTSTART:20280301T080000Z', 'DTSTART:20280301T100000Z').replace('DTEND:20280301T090000Z', 'DTEND:20280301T110000Z');
    const warn = await rawPut(view.id, stored.etag, moved);
    assert.equal(warn.status, 200, warn.text);
    const issue = warn.json.issues.find((i) => i.code === 'sequence_not_bumped');
    assert.ok(issue, JSON.stringify(warn.json.issues));
    assert.equal(issue.severity, 'warning');
    assert.equal(warn.json.valid, true);
    const second = (await textOf(cal, href)) as { body: string; etag: string };
    const bumped = second.body.replace('DTSTART:20280301T100000Z', 'DTSTART:20280301T120000Z').replace('DTEND:20280301T110000Z', 'DTEND:20280301T130000Z').replace('SEQUENCE:0', 'SEQUENCE:1');
    const ok = await rawPut(view.id, second.etag, bumped);
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.issues.some((i) => i.code === 'sequence_not_bumped'), false);
  });

  test('device concorrente → 412 con `current` e `conflicts: []`, nessuna fusione; stesso testo → noop', async () => {
    const { view, href } = await seed(cal);
    const stored = (await textOf(cal, href)) as { body: string; etag: string };
    await deviceEdit(cal, href, (t) => t.replace('SUMMARY:Evento raw', 'SUMMARY:Cambiato dal device'));
    const res = await rawPut(view.id, stored.etag, stored.body.replace('SUMMARY:Evento raw', 'SUMMARY:Mia modifica'));
    assert.equal(res.status, 412, res.text);
    assert.equal(res.json.code, 'PRECONDITION_FAILED');
    assert.equal(res.json.current?.master?.fields.summary, 'Cambiato dal device');
    assert.deepEqual(res.json.conflicts, []);
    assert.match((await textOf(cal, href))?.body ?? '', /Cambiato dal device/, 'nessuna scrittura');

    const now = (await textOf(cal, href)) as { body: string; etag: string };
    const noop = await rawPut(view.id, now.etag, now.body);
    assert.equal(noop.status, 200, noop.text);
    assert.equal(noop.json.noop, true);
    assert.deepEqual(noop.json.changed, []);
    assert.equal((await textOf(cal, href))?.etag, now.etag, 'ETag invariato');
  });

  test('testo non valido: 400 con issue (UID, fine prima dell\'inizio); in dryRun 200 con valid=false', async () => {
    const { view, href } = await seed(cal);
    const stored = (await textOf(cal, href)) as { body: string; etag: string };
    const other = await rawPut(view.id, stored.etag, stored.body.replace(/UID:.*/, 'UID:altro-evento@caldes.test'));
    assert.equal(other.status, 400, other.text);
    assert.equal(other.json.code, 'VALIDATION_FAILED');
    assert.ok(other.json.details?.issues?.some((i) => i.property === 'UID'));

    const backwards = stored.body.replace('DTEND:20280301T090000Z', 'DTEND:20280301T070000Z');
    const bad = await rawPut(view.id, stored.etag, backwards);
    assert.equal(bad.status, 400, bad.text);
    assert.equal(bad.json.code, 'VALIDATION_FAILED');
    const dry = await rawPut(view.id, stored.etag, backwards, { dryRun: true });
    assert.equal(dry.status, 200, dry.text);
    assert.equal(dry.json.valid, false);
    assert.equal(dry.json.dry_run, true);
    assert.ok(dry.json.issues.some((i) => i.severity === 'error'));
    const garbage = await rawPut(view.id, stored.etag, 'BEGIN:VCALENDAR\nSPAZZATURA', { dryRun: true });
    assert.equal(garbage.status, 200);
    assert.equal(garbage.json.valid, false);
    assert.equal((await textOf(cal, href))?.etag, stored.etag, 'nessuna scrittura');
  });

  test('dryRun: stessa anteprima, ETag invariato, nessun audit e nessuna PUT', async () => {
    const { view, href } = await seed(cal);
    const stored = (await textOf(cal, href)) as { body: string; etag: string };
    const before = await auditTotal();
    const dry = await rawPut(view.id, stored.etag, stored.body.replace('SUMMARY:Evento raw', 'SUMMARY:Solo anteprima'), { dryRun: true });
    assert.equal(dry.status, 200, dry.text);
    assert.equal(dry.json.dry_run, true);
    assert.equal(dry.json.valid, true);
    assert.deepEqual(dry.json.changed, ['raw']);
    assert.equal(dry.json.etag, stored.etag);
    assert.equal(dry.json.object?.etag, stored.etag);
    assert.equal(dry.json.object?.master?.fields.summary, 'Solo anteprima');
    assert.equal(await auditTotal(), before);
    assert.deepEqual(await textOf(cal, href), stored, 'Radicale intatto');
    const stale = await rawPut(view.id, '"vecchio"', stored.body, { dryRun: true });
    assert.equal(stale.status, 412, 'la stessa logica produce gli stessi 412');
  });

  test('oggetto illeggibile (in quarantena): il raw PUT lo ripara se il testo nuovo è valido', async () => {
    const uid = `rotto-${randomUUID()}`;
    const href = `${uid}.ics`;
    const junk = Array.from({ length: 2100 }, () => 'X-JUNK:1');
    const broken = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//IT', 'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20271001T080000Z', 'DTSTART:20280201T080000Z', 'DTEND:20280201T090000Z', 'SUMMARY:Enorme', ...junk, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
    await deviceWrite(cal, href, broken);
    const view = await read(uid);
    assert.equal(view.readonly_reason, 'unreadable');
    const fixed = eventText(uid, { summary: 'Riparato', start: '20280201T080000Z', end: '20280201T090000Z' });
    const res = await rawPut(view.id, view.etag as string, fixed);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.object?.readonly_reason, null);
    assert.equal(res.json.object?.master?.fields.summary, 'Riparato');
    assert.deepEqual(lines((await textOf(cal, href))?.body ?? ''), lines(fixed));
    assert.equal((await read(view.id)).health, 'ok');
  });

  // ── Sposta ──

  test('sposta: stesso id nel calendario di destinazione, ETag esatto, noop sullo stesso calendario', async () => {
    const { view, href } = await seed(cal);
    const before = await auditTotal();
    const stale = await api.post(`${BASE}/objects/${view.id}/move`, { auth: 'admin', headers: { 'If-Match': '"vecchio"' }, body: { calendar_id: other.id } });
    assert.equal(stale.status, 412, stale.text);
    assert.deepEqual(stale.json.conflicts, []);
    assert.equal(stale.json.current.id, view.id);

    const same = await api.post(`${BASE}/objects/${view.id}/move`, { auth: 'admin', headers: { 'If-Match': view.etag as string }, body: { calendar_id: cal.id } });
    assert.equal(same.status, 200, same.text);
    assert.equal(same.json.noop, true);
    assert.equal(await auditTotal(), before, 'noop: nessun audit');

    const dry = await api.post(`${BASE}/objects/${view.id}/move`, { auth: 'admin', headers: { 'If-Match': view.etag as string }, body: { calendar_id: other.id, dryRun: true } });
    assert.equal(dry.status, 200, dry.text);
    assert.equal(dry.json.dry_run, true);
    assert.equal(dry.json.valid, true);
    assert.equal(dry.json.object.calendar_id, other.id);
    assert.ok(await textOf(cal, href), 'dryRun: la risorsa è ancora dov\'era');

    const res = await api.post(`${BASE}/objects/${view.id}/move`, { auth: 'admin', headers: { 'If-Match': view.etag as string }, body: { calendar_id: other.id } });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.changed, ['calendar_id']);
    assert.equal(res.json.object.calendar_id, other.id);
    assert.equal(res.json.object.id, view.id, 'il MOVE conserva l\'id');
    assert.equal(res.headers.get('etag'), res.json.etag);
    assert.equal(await textOf(cal, href), null);
    const moved = await textOf(other, href);
    assert.ok(moved);
    assert.equal(moved.etag, res.json.etag);
    assert.equal((await read(view.id)).calendar_id, other.id);
    const audit = (await auditRows(view.id)).find((a) => a.metadata.operation === 'v2.move');
    assert.ok(audit);
    assert.equal(audit.metadata.from_calendar_id, cal.id);
    assert.equal(audit.metadata.to_calendar_id, other.id);
  });

  test('sposta: href già presente nella destinazione → 409 MOVE_CONFLICT (in dryRun valid=false); destinazione sconosciuta → 404', async () => {
    const { view, href } = await seed(cal);
    const text = (await textOf(cal, href))?.body as string;
    await svc.put(objectPath(P, other.slug, href), text.replace(/^UID:.*$/m, 'UID:un-altro-uid@caldes.test'), { ifNoneMatch: '*' });
    await syncCollection(other.id, { reason: 'manual' });
    const conflict = await api.post(`${BASE}/objects/${view.id}/move`, { auth: 'admin', headers: { 'If-Match': view.etag as string }, body: { calendar_id: other.id } });
    assert.equal(conflict.status, 409, conflict.text);
    assert.equal(conflict.json.code, 'MOVE_CONFLICT');
    assert.ok(await textOf(cal, href), 'la risorsa è rimasta nell\'origine');
    const dry = await api.post(`${BASE}/objects/${view.id}/move`, { auth: 'admin', headers: { 'If-Match': view.etag as string }, body: { calendar_id: other.id, dryRun: true } });
    assert.equal(dry.status, 200, dry.text);
    assert.equal(dry.json.valid, false);
    assert.equal(dry.json.issues[0].code, 'MOVE_CONFLICT');
    const missing = await api.post(`${BASE}/objects/${view.id}/move`, { auth: 'admin', headers: { 'If-Match': view.etag as string }, body: { calendar_id: randomUUID() } });
    assert.equal(missing.status, 404);
  });

  // ── Duplica ──

  const series = (uid: string): string =>
    eventText(uid, { summary: 'Corso', start: '20270503T070000Z', end: '20270503T080000Z', extra: ['RRULE:FREQ=DAILY;COUNT=5', 'LOCATION:Aula 3'] });

  test('duplica di un\'istanza: data dell\'occorrenza, durata, VALARM/ATTENDEE/X-*, niente RRULE; 201 con ETag e Location', async () => {
    const uid = `serie-${randomUUID()}@caldes.test`;
    await deviceWrite(cal, `${uid}.ics`, series(uid));
    const view = await read(uid);
    const copyUid = `copia-${randomUUID()}@caldes.test`;
    const res = await api.post(`${BASE}/objects/${view.id}/duplicate`, { auth: 'admin', body: { recurrence_key: '20270505T070000Z', uid: copyUid } });
    assert.equal(res.status, 201, res.text);
    const copy = res.json.object as CalV2ObjectView;
    assert.equal(res.headers.get('etag'), res.json.etag);
    assert.equal(res.headers.get('location'), `${BASE}/objects/${copy.id}`);
    assert.notEqual(copy.id, view.id);
    assert.equal(copy.uid, copyUid);
    assert.equal(copy.recurring, false);
    assert.equal(copy.provenance.source, 'admin');
    assert.equal(copy.provenance.source_id, view.id);
    assert.equal(copy.master?.readonly.sequence, 0);
    const text = unfold((await textOf(cal, `${copyUid}.ics`))?.body ?? '');
    assert.doesNotMatch(text, /RRULE|RECURRENCE-ID|EXDATE|RDATE/);
    assert.match(text, /DTSTART:20270505T070000Z/);
    assert.match(text, /DTEND:20270505T080000Z/);
    assert.match(text, /LOCATION:Aula 3/);
    assert.match(text, /X-ACME-CUSTOM;X-PARAM=uno:valore/);
    assert.match(text, /ATTENDEE;CN=Mario Rossi;PARTSTAT=NEEDS-ACTION:mailto:mario@example.com/);
    assert.match(text, /BEGIN:VALARM/);
    assert.match(text, /X-CALDES-SOURCE:admin/);
    assert.match(text, new RegExp(`X-CALDES-SOURCE-ID:${view.id}`));
    assert.match(text, new RegExp(`UID:${copyUid}`));
    assert.doesNotMatch(text, /DTSTAMP:20270101T080000Z/, 'DTSTAMP nuovo');
    assert.equal((await auditRows(copy.id)).find((a) => a.metadata.operation === 'v2.duplicate')?.action, 'INSERT');
    // L'originale non è cambiato.
    assert.deepEqual(lines((await textOf(cal, `${uid}.ics`))?.body ?? ''), lines(series(uid)));

    const again = await api.post(`${BASE}/objects/${view.id}/duplicate`, { auth: 'admin', body: { recurrence_key: '20270505T070000Z', uid: copyUid } });
    assert.equal(again.status, 409, again.text);
    assert.equal(again.json.code, 'OBJECT_EXISTS');
    assert.equal(again.json.details.object_id, copy.id);
  });

  test('duplica con `start`, in un altro calendario e in dryRun; il tipo di inizio deve restare quello dell\'originale', async () => {
    const { view } = await seed(cal);
    const dry = await api.post(`${BASE}/objects/${view.id}/duplicate`, { auth: 'admin', body: { start: rome('2028-04-10', 15), calendar_id: other.id, dryRun: true } });
    assert.equal(dry.status, 200, dry.text);
    assert.equal(dry.json.object.id, '');
    assert.equal(dry.json.etag, null);
    assert.equal(dry.json.dry_run, true);
    const res = await api.post(`${BASE}/objects/${view.id}/duplicate`, { auth: 'admin', body: { start: rome('2028-04-10', 15), calendar_id: other.id } });
    assert.equal(res.status, 201, res.text);
    const copy = res.json.object as CalV2ObjectView;
    assert.equal(copy.calendar_id, other.id);
    const start = copy.master?.fields.start;
    const end = copy.master?.fields.end;
    assert.ok(start?.type === 'date-time' && end?.type === 'date-time');
    assert.deepEqual([start.year, start.month, start.day, start.hour], [2028, 4, 10, 15]);
    assert.deepEqual([end.year, end.month, end.day, end.hour], [2028, 4, 10, 16], 'durata di un\'ora conservata');
    const allDay = await api.post(`${BASE}/objects/${view.id}/duplicate`, { auth: 'admin', body: { start: { type: 'date', year: 2028, month: 4, day: 10 } } });
    assert.equal(allDay.status, 400, allDay.text);
  });

  test('duplica con keep_recurrence: copia la serie intera (RRULE, eccezioni, override), spostata se c\'è `start`', async () => {
    const uid = `serie-${randomUUID()}@caldes.test`;
    const text = series(uid).replace('END:VEVENT', 'EXDATE:20270504T070000Z\r\nEND:VEVENT');
    await deviceWrite(cal, `${uid}.ics`, text);
    const view = await read(uid);
    const res = await api.post(`${BASE}/objects/${view.id}/duplicate`, { auth: 'admin', body: { keep_recurrence: true, recurrence_key: '' } });
    assert.equal(res.status, 201, res.text);
    const copy = res.json.object as CalV2ObjectView;
    assert.equal(copy.recurring, true);
    const copied = unfold((await textOf(cal, `${copy.uid}.ics`))?.body ?? '');
    assert.match(copied, /RRULE:FREQ=DAILY;COUNT=5/);
    assert.match(copied, /EXDATE:20270504T070000Z/);
    assert.notEqual(copy.uid, uid);

    const shifted = await api.post(`${BASE}/objects/${view.id}/duplicate`, { auth: 'admin', body: { keep_recurrence: true, start: { type: 'date-time', year: 2027, month: 5, day: 10, hour: 7, minute: 0, second: 0, zone: { kind: 'utc' } } } });
    assert.equal(shifted.status, 201, shifted.text);
    const shiftedText = unfold((await textOf(cal, `${shifted.json.object.uid}.ics`))?.body ?? '');
    assert.match(shiftedText, /DTSTART:20270510T070000Z/);
    assert.match(shiftedText, /EXDATE:20270511T070000Z/, 'l\'eccezione segue la serie');
  });

  // ── Export ──

  test('export: stesso testo di /ics, come allegato, con ETag', async () => {
    const { view, uid } = await seed(cal);
    const ics = await api.get(`${BASE}/objects/${view.id}/ics`, { auth: 'admin' });
    const exp = await api.get(`${BASE}/objects/${view.id}/export.ics`, { auth: 'admin' });
    assert.equal(exp.status, 200);
    assert.match(exp.contentType ?? '', /^text\/calendar; charset=utf-8/);
    assert.equal(exp.text, ics.text);
    assert.equal(exp.headers.get('etag'), view.etag);
    assert.equal(exp.headers.get('content-disposition'), `attachment; filename="${uid}.ics"`);
    assert.match(ics.headers.get('content-disposition') ?? '', /^inline;/);
  });

  // ── Cronologia ──

  test('versioni dopo tre modifiche: ordine, changed_fields, current, attori, dettaglio', async () => {
    const created = await create(cal, { summary: fx.name('Storico'), start: rome('2028-05-02', 9), end: rome('2028-05-02', 10) });
    await patchField(created, 'summary', 'Storico 2');
    await patchField(created, 'location', 'Sala riunioni');
    const last = await patchField(created, 'description', 'Descrizione lunga');
    const list = await versionsOf(created.id);
    assert.equal(list.object_id, created.id);
    assert.equal(list.retention_days, 90);
    assert.equal(list.versions.length, 4, JSON.stringify(list.versions.map((v) => [v.change_kind, v.changed_fields])));
    const [v4, v3, v2, v1] = list.versions;
    assert.deepEqual(v4.changed_fields, ['description']);
    assert.deepEqual(v3.changed_fields, ['location']);
    assert.deepEqual(v2.changed_fields, ['summary']);
    assert.deepEqual(v1.changed_fields, [], 'la prima versione non ha precedente');
    assert.equal(v1.change_kind, 'create');
    assert.deepEqual(list.versions.map((v) => v.current), [true, false, false, false]);
    assert.equal(v4.etag, last.etag);
    assert.ok(v4.valid);
    assert.equal(v4.actor, 'write-through:admin');
    assert.equal(v4.summary, 'Storico 2');
    assert.equal(v1.summary, fx.name('Storico'));
    assert.ok(v4.size_bytes > 100);
    assert.ok(Date.parse(v4.expires_at) - Date.parse(v4.recorded_at) === 90 * day);

    const detail = await api.get(`${BASE}/objects/${created.id}/versions/${v2.id}`, { auth: 'admin' });
    assert.equal(detail.status, 200, detail.text);
    const body = detail.json as CalV2VersionDetail;
    assert.equal(body.version.id, v2.id);
    assert.match(body.ics ?? '', /SUMMARY:Storico 2/);
    assert.doesNotMatch(body.ics ?? '', /LOCATION:Sala riunioni/);
    assert.equal(body.view?.master?.fields.summary, 'Storico 2');
    assert.equal(body.view?.id, created.id);
    assert.equal(body.view?.etag, last.etag, 'ETag dell\'oggetto corrente');
    assert.equal(body.view?.source, 'index');

    const foreign = await seed(cal);
    const foreignList = await versionsOf(foreign.view.id);
    const cross = await api.get(`${BASE}/objects/${created.id}/versions/${foreignList.versions[0].id}`, { auth: 'admin' });
    assert.equal(cross.status, 404, 'versione di un altro oggetto');
    assert.equal((await api.get(`${BASE}/objects/${created.id}/versions/${randomUUID()}`, { auth: 'admin' })).status, 404);
  });

  test('ripristino: SEQUENCE = max + 1, DTSTAMP nuovo, versione `restore` con attore admin:<id>, ETag esatto, dryRun', async () => {
    const created = await create(cal, { summary: fx.name('Da ripristinare'), start: rome('2028-05-03', 9), end: rome('2028-05-03', 10) });
    await patchField(created, 'location', 'Sala A');
    await patchField(created, 'summary', 'Titolo cambiato');
    const list = await versionsOf(created.id);
    const first = list.versions[list.versions.length - 1];
    const href = `${created.uid}.ics`;
    const cur = (await textOf(cal, href)) as { body: string; etag: string };
    const seq = Number(/SEQUENCE:(\d+)/.exec(cur.body)?.[1]);
    assert.ok(seq >= 1, 'la modifica del luogo ha alzato SEQUENCE');

    const stale = await api.post(`${BASE}/objects/${created.id}/restore`, { auth: 'admin', headers: { 'If-Match': '"vecchio"' }, body: { version_id: first.id } });
    assert.equal(stale.status, 412, stale.text);
    assert.deepEqual(stale.json.conflicts, []);
    assert.ok(stale.json.current);

    const before = await auditTotal();
    const dry = await api.post(`${BASE}/objects/${created.id}/restore`, { auth: 'admin', headers: { 'If-Match': cur.etag }, body: { version_id: first.id, dryRun: true } });
    assert.equal(dry.status, 200, dry.text);
    assert.equal(dry.json.dry_run, true);
    assert.equal(dry.json.etag, cur.etag);
    assert.equal(dry.json.object.master.fields.summary, fx.name('Da ripristinare'));
    assert.equal(await auditTotal(), before);
    assert.deepEqual(await textOf(cal, href), cur, 'dryRun: Radicale intatto');

    const res = await api.post(`${BASE}/objects/${created.id}/restore`, { auth: 'admin', headers: { 'If-Match': cur.etag }, body: { version_id: first.id } });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.sequence_bumped, true);
    assert.equal(res.headers.get('etag'), res.json.etag);
    const after = (await textOf(cal, href)) as { body: string; etag: string };
    assert.equal(after.etag, res.json.etag);
    assert.match(after.body, new RegExp(`SUMMARY:${fx.name('Da ripristinare')}`));
    assert.doesNotMatch(after.body, /LOCATION:Sala A/, 'testo della versione, non quello corrente');
    assert.equal(Number(/SEQUENCE:(\d+)/.exec(after.body)?.[1]), Math.max(seq, 0) + 1, 'SEQUENCE = max(corrente, versione) + 1');
    assert.match(after.body, /DTSTAMP:\d{8}T\d{6}Z/);
    assert.match(after.body, /LAST-MODIFIED:\d{8}T\d{6}Z/);
    assert.equal(res.json.object.id, created.id);

    const afterList = await versionsOf(created.id);
    const newest = afterList.versions[0];
    assert.equal(newest.change_kind, 'restore');
    assert.match(newest.actor ?? '', /^admin:/);
    assert.equal(newest.current, true);
    assert.equal(newest.etag, res.json.etag);
    const audit = (await auditRows(created.id)).find((a) => a.metadata.operation === 'v2.restore');
    assert.ok(audit);
    assert.equal(audit.metadata.version_id, first.id);
  });

  test('ripristino di una versione scaduta, non valida o di un altro oggetto → 409 VERSION_NOT_RESTORABLE; inesistente → 404', async () => {
    const created = await create(cal, { summary: fx.name('Versioni'), start: rome('2028-05-04', 9), end: rome('2028-05-04', 10) });
    await patchField(created, 'summary', 'Versioni 2');
    await patchField(created, 'summary', 'Versioni 3');
    const list = await versionsOf(created.id);
    const [, mid, oldest] = list.versions;
    const view = await read(created.id);
    const restore = (versionId: string) => api.post(`${BASE}/objects/${created.id}/restore`, { auth: 'admin', headers: { 'If-Match': view.etag as string }, body: { version_id: versionId } });

    await sql`UPDATE cal_object_versions SET created_at = now() - interval '100 days' WHERE id = ${oldest.id}`;
    const expired = await restore(oldest.id);
    assert.equal(expired.status, 409, expired.text);
    assert.equal(expired.json.code, 'VERSION_NOT_RESTORABLE');
    assert.equal(expired.json.details.reason, 'expired');
    assert.equal((await versionsOf(created.id)).versions.some((v) => v.id === oldest.id), false, 'una versione scaduta non è più nella lista');

    await sql`UPDATE cal_object_versions SET valid = false WHERE id = ${mid.id}`;
    const invalid = await restore(mid.id);
    assert.equal(invalid.status, 409, invalid.text);
    assert.equal(invalid.json.details.reason, 'invalid');

    const foreign = await seed(cal);
    const foreignVersion = (await versionsOf(foreign.view.id)).versions[0];
    const cross = await restore(foreignVersion.id);
    assert.equal(cross.status, 409, cross.text);
    assert.equal(cross.json.details.reason, 'other_object');

    assert.equal((await restore(randomUUID())).status, 404);
    assert.equal((await textOf(cal, `${created.uid}.ics`))?.etag, view.etag, 'nessuna scrittura');
  });

  // ── Cestino ──

  test('elimina → cestino → ripristino con lo stesso id sullo stesso href, SEQUENCE+1 e versione `restore`', async () => {
    const created = await create(cal, { summary: fx.name('Cestinato'), start: rome('2028-06-05', 9), end: rome('2028-06-05', 10), rrule: 'FREQ=WEEKLY;COUNT=3' });
    await patchField(created, 'location', 'Studio');
    const href = `${created.uid}.ics`;
    const lastText = (await textOf(cal, href)) as { body: string };
    const seq = Number(/SEQUENCE:(\d+)/.exec(lastText.body)?.[1]);
    await del(created);
    assert.equal(await textOf(cal, href), null);
    assert.equal((await api.get(`${BASE}/objects/${created.id}`, { auth: 'admin' })).status, 404, 'eliminato: non c\'è più fra gli oggetti vivi');

    const list = await trash({ calendar_id: cal.id });
    const item = list.items.find((i) => i.object_id === created.id);
    assert.ok(item, JSON.stringify(list.items.map((i) => i.object_id)));
    assert.equal(list.retention_days, 90);
    assert.equal(item.calendar_id, cal.id);
    assert.equal(item.calendar_name, cal.name);
    assert.equal(item.href, href);
    assert.equal(item.uid, created.uid);
    assert.equal(item.summary, fx.name('Cestinato'));
    assert.equal(item.start_utc, '2028-06-05T07:00:00.000Z');
    assert.equal(item.recurring, true);
    assert.equal(item.restorable, true);
    assert.equal(item.not_restorable_reason, null);
    assert.ok(item.restore_version_id);
    assert.match(item.deleted_by ?? '', /^write-through:/);
    assert.ok(Date.parse(item.expires_at) > Date.now());

    const dry = await api.post(`${BASE}/trash/${created.id}/restore`, { auth: 'admin', body: { dryRun: true } });
    assert.equal(dry.status, 200, dry.text);
    assert.equal(dry.json.dry_run, true);
    assert.equal(dry.json.object.id, created.id);
    assert.equal(await textOf(cal, href), null, 'dryRun: nulla scritto');

    const res = await api.post(`${BASE}/trash/${created.id}/restore`, { auth: 'admin', body: {} });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.object.id, created.id, 'stesso id');
    assert.equal(res.headers.get('location'), `${BASE}/objects/${created.id}`);
    assert.equal(res.headers.get('etag'), res.json.etag);
    const text = (await textOf(cal, href)) as { body: string; etag: string };
    assert.equal(text.etag, res.json.etag);
    assert.match(text.body, /SUMMARY:.*Cestinato/);
    assert.match(text.body, /RRULE:FREQ=WEEKLY;COUNT=3/);
    assert.match(text.body, /LOCATION:Studio/);
    assert.equal(Number(/SEQUENCE:(\d+)/.exec(text.body)?.[1]), seq + 1);
    const alive = await read(created.id);
    assert.equal(alive.calendar_id, cal.id);
    assert.equal(alive.href, href);
    assert.equal((await trash({ calendar_id: cal.id })).items.some((i) => i.object_id === created.id), false, 'fuori dal cestino');
    const newest = (await versionsOf(created.id)).versions[0];
    assert.equal(newest.change_kind, 'restore');
    assert.match(newest.actor ?? '', /^admin:/);
    const audit = (await auditRows(created.id)).find((a) => a.metadata.operation === 'v2.trash_restore');
    assert.ok(audit);
    assert.equal(audit.action, 'INSERT');
    assert.doesNotMatch(JSON.stringify(audit), /Cestinato|Studio/);

    const gone = await api.post(`${BASE}/trash/${created.id}/restore`, { auth: 'admin', body: {} });
    assert.equal(gone.status, 404, 'un oggetto vivo non è nel cestino');
  });

  test('cestino: uid_exists (stesso UID attivo altrove), expired, no_valid_version', async () => {
    // uid_exists: l'UID rinasce in un altro calendario oltre la finestra dei 30 giorni dei MOVE.
    const a = await create(cal, { summary: fx.name('Gemello'), start: rome('2028-06-06', 9), end: rome('2028-06-06', 10) });
    await del(a);
    await sql`UPDATE cal_object_ids SET retired_at = now() - interval '40 days' WHERE id = ${a.id}`;
    const twin = await api.post(`${BASE}/objects`, { auth: 'admin', body: { calendar_id: other.id, uid: a.uid, fields: { summary: 'Gemello nuovo', start: rome('2028-06-06', 9), end: rome('2028-06-06', 10) } } });
    assert.equal(twin.status, 201, twin.text);
    assert.notEqual(twin.json.object.id, a.id, 'oltre i 30 giorni non è un MOVE: id nuovo');
    const itemA = (await trash()).items.find((i) => i.object_id === a.id);
    assert.ok(itemA);
    assert.equal(itemA.restorable, false);
    assert.equal(itemA.not_restorable_reason, 'uid_exists');
    const refused = await api.post(`${BASE}/trash/${a.id}/restore`, { auth: 'admin', body: {} });
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.json.code, 'NOT_RESTORABLE');
    assert.equal(refused.json.details.reason, 'uid_exists');

    // expired: l'ultima versione valida è scaduta, la cancellazione è recente.
    const b = await create(cal, { summary: fx.name('Scaduto'), start: rome('2028-06-07', 9), end: rome('2028-06-07', 10) });
    await del(b);
    await sql`UPDATE cal_object_versions SET created_at = now() - interval '100 days' WHERE object_id = ${b.id} AND change_kind <> 'delete'`;
    const itemB = (await trash()).items.find((i) => i.object_id === b.id);
    assert.ok(itemB, 'la cancellazione è recente: resta nel cestino');
    assert.equal(itemB.restorable, false);
    assert.equal(itemB.not_restorable_reason, 'expired');
    const expired = await api.post(`${BASE}/trash/${b.id}/restore`, { auth: 'admin', body: {} });
    assert.equal(expired.status, 409, expired.text);
    assert.equal(expired.json.details.reason, 'expired');
    // Anche la versione `delete` scaduta: l'oggetto sparisce dal cestino.
    await sql`UPDATE cal_object_versions SET created_at = now() - interval '100 days' WHERE object_id = ${b.id}`;
    assert.equal((await trash()).items.some((i) => i.object_id === b.id), false);

    // no_valid_version: nessuna versione valida con testo.
    const c = await create(cal, { summary: fx.name('Senza testo'), start: rome('2028-06-08', 9), end: rome('2028-06-08', 10) });
    await del(c);
    await sql`UPDATE cal_object_versions SET valid = false WHERE object_id = ${c.id} AND change_kind <> 'delete'`;
    const itemC = (await trash()).items.find((i) => i.object_id === c.id);
    assert.ok(itemC);
    assert.equal(itemC.restore_version_id, null);
    assert.equal(itemC.not_restorable_reason, 'no_valid_version');
    const none = await api.post(`${BASE}/trash/${c.id}/restore`, { auth: 'admin', body: {} });
    assert.equal(none.status, 409, none.text);
    assert.equal(none.json.details.reason, 'no_valid_version');
  });

  test('ripristino dal cestino in un altro calendario (MOVE riconosciuta: stesso id); href occupato → NOT_RESTORABLE href_taken', async () => {
    const a = await create(cal, { summary: fx.name('Altrove'), start: rome('2028-06-09', 9), end: rome('2028-06-09', 10) });
    const hrefA = `${a.uid}.ics`;
    await del(a);
    const moved = await api.post(`${BASE}/trash/${a.id}/restore`, { auth: 'admin', body: { calendar_id: other.id } });
    assert.equal(moved.status, 201, moved.text);
    assert.equal(moved.json.object.calendar_id, other.id);
    assert.equal(moved.json.object.id, a.id, 'riconosciuta come MOVE entro 30 giorni');
    assert.ok(await textOf(other, hrefA));
    assert.equal(await textOf(cal, hrefA), null);

    const b = await create(cal, { summary: fx.name('Occupato'), start: rome('2028-06-10', 9), end: rome('2028-06-10', 10) });
    const hrefB = `${b.uid}.ics`;
    const textB = (await textOf(cal, hrefB))?.body as string;
    await del(b);
    await svc.put(objectPath(P, other.slug, hrefB), textB.replace(/^UID:.*$/m, 'UID:occupante@caldes.test'), { ifNoneMatch: '*' });
    await syncCollection(other.id, { reason: 'manual' });
    const taken = await api.post(`${BASE}/trash/${b.id}/restore`, { auth: 'admin', body: { calendar_id: other.id } });
    assert.equal(taken.status, 409, taken.text);
    assert.equal(taken.json.code, 'NOT_RESTORABLE');
    assert.equal(taken.json.details.reason, 'href_taken');
    assert.equal((await api.post(`${BASE}/trash/${b.id}/restore`, { auth: 'admin', body: { calendar_id: randomUUID() } })).status, 404);
    // L'originale resta ripristinabile nel suo calendario.
    const back = await api.post(`${BASE}/trash/${b.id}/restore`, { auth: 'admin', body: {} });
    assert.equal(back.status, 201, back.text);
    assert.equal(back.json.object.id, b.id);
  });

  test('cestino: ordine per cancellazione decrescente, paginazione con cursore, filtro per calendario', async () => {
    const items: CalV2ObjectView[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await create(other, { summary: fx.name(`Pagina ${i}`), start: rome('2028-07-0' + (i + 1), 9), end: rome('2028-07-0' + (i + 1), 10) });
      await del(c);
      items.push(c);
    }
    const all = await trash({ calendar_id: other.id });
    const ours = all.items.filter((i) => items.some((c) => c.id === i.object_id));
    assert.deepEqual(ours.map((i) => i.object_id), items.map((c) => c.id).reverse(), 'dal più recente');
    const sorted = [...all.items].map((i) => i.deleted_at);
    assert.deepEqual(sorted, [...sorted].sort().reverse());
    assert.equal(all.items.every((i) => i.calendar_id === other.id), true);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: CalV2TrashList = await trash({ calendar_id: other.id, limit: '2', ...(cursor ? { before: cursor } : {}) });
      assert.ok(page.items.length <= 2);
      seen.push(...page.items.map((i) => i.object_id));
      cursor = page.next;
      pages++;
    } while (cursor && pages < 20);
    assert.deepEqual(seen, all.items.map((i) => i.object_id), 'le pagine ricompongono l\'elenco senza buchi né doppioni');
    assert.ok(pages >= 2);
  });

  test('proiezione di prenotazione: lo spostamento è rifiutato (booking_active) e, cancellata, non si ripristina dal cestino', async () => {
    const eventType = await fx.eventType({ key: 'tipo-v2-c1' });
    const { booking } = await fx.booking({ eventType, start: '2027-10-04T08:00:00Z', project: false });
    const bookings = (await sql<Array<{ id: string; collection_name: string }>>`SELECT id, collection_name FROM calendars WHERE role = 'bookings' AND lifecycle = 'active' LIMIT 1`)[0];
    const href = bookingHref(booking.uid);
    const path = objectPath(P, bookings.collection_name, href);
    const text = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//IT', 'BEGIN:VEVENT',
      `UID:${bookingProjectionUid(booking.uid)}`, 'DTSTAMP:20271001T080000Z', 'DTSTART:20271004T080000Z', 'DTEND:20271004T083000Z', 'SUMMARY:Consulenza', 'END:VEVENT', 'END:VCALENDAR', '',
    ].join('\r\n');
    await svc.put(path, text, { ifNoneMatch: '*' });
    await syncCollection(bookings.id, { reason: 'manual' });
    const view = await read(bookingProjectionUid(booking.uid));

    // Move: 403 READ_ONLY, anche in anteprima, e la proiezione resta dov'è.
    for (const dryRun of [true, false]) {
      const moved = await api.post(`${BASE}/objects/${view.id}/move`, { auth: 'admin', headers: { 'If-Match': view.etag as string }, body: { calendar_id: other.id, ...(dryRun ? { dryRun } : {}) } });
      assert.equal(moved.status, 403, moved.text);
      assert.equal(moved.json.code, 'READ_ONLY');
      assert.equal(moved.json.details.reason, 'booking_active');
    }
    assert.ok((await svc.get(path)).body, 'proiezione intatta su Radicale');

    // Cancellata dal proiettore (qui: DELETE del device + sync) finisce nel cestino ma non è ripristinabile.
    const current = await svc.get(path);
    await svc.delete(path, { ifMatch: current.etag as string });
    await syncCollection(bookings.id, { reason: 'manual' });
    const item = (await trash({ calendar_id: bookings.id })).items.find((i) => i.object_id === view.id);
    assert.ok(item, 'la proiezione cancellata è nel cestino');
    assert.equal(item.restorable, false);
    assert.equal(item.not_restorable_reason, 'calendar_readonly');
    const restore = await api.post(`${BASE}/trash/${view.id}/restore`, { auth: 'admin', body: {} });
    assert.equal(restore.status, 409, restore.text);
    assert.equal(restore.json.code, 'NOT_RESTORABLE');
    await assert.rejects(svc.get(path), (err: unknown) => (err as { code?: string }).code === 'not_found', 'nessuna risorsa ricreata');
  });
});
