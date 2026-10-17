/**
 * Passo C2 della tranche C dell'API admin v2 contro Radicale 3.7.8 reale
 * (calendari, import ed export, job; contratto
 * docs/calendar-radicale/contracts/f6-modules.md §9.1.4, §9.9).
 *
 * Un Radicale con storage multifilesystem in una directory temporanea e il
 * solo caldes-svc (stessa matrice di admin-v2-c1-radicale.test.ts). Lo store è
 * forzato su Radicale; le richieste passano da app.request come in produzione
 * e i job si eseguono con `runCalendarJobsOnce` (l'handler è quello registrato
 * dal cron).
 *
 * Casi: CRUD dei calendari con le PROPPATCH visibili via PROPFIND (nome,
 * colore, descrizione, fuso, ruolo, ordine), slug ricavato dal nome, nome già
 * usato, `needs_review`, ordine, rotate-token (il vecchio feed smette di
 * rispondere), eliminazione con e senza `with_objects`; export → import in un
 * calendario vuoto con lo stesso numero di oggetti e VALARM, ATTENDEE, X-*,
 * override e VTIMEZONE conservati; `on_conflict` nelle tre modalità (id e href
 * conservati dalla sostituzione, UID nuovo con RELATED-TO invariato); voce
 * cambiata dopo l'anteprima → `failed`; progress durante il job; ripresa dopo
 * un'interruzione e dopo l'attesa del gate (write_freeze) senza duplicati;
 * payload senza testo ICS a fine job (anche in dead letter); audit senza testo.
 *
 * Senza RADICALE_BIN la suite è saltata con il motivo. Date fisse nel 2028.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type {
  CalV2CalendarList,
  CalV2CalendarView,
  CalV2ImportPlan,
  CalV2ImportResult,
  CalV2JobAccepted,
  CalV2JobView,
} from '@calicchia/shared';
import { invalidateBackendModeCache } from '../../src/lib/calendar/backend-mode';
import { runCalendarJobsOnce, unregisterCalendarJobHandler, CAL_JOB_KINDS } from '../../src/lib/calendar/jobs';
import { collectionPath, objectPath, RadicaleClient } from '../../src/lib/calendar/radicale/client';
import { clark, DAV_PROPS } from '../../src/lib/calendar/radicale/dav-xml';
import { initializeVolume } from '../../src/lib/calendar/radicale/identity';
import { stopIndexWorker } from '../../src/lib/calendar/radicale/indexer';
import { configureRadicaleRuntime, syncCollection, updateWatchMode } from '../../src/lib/calendar/radicale/sync';
import { overrideCalendarStore } from '../../src/lib/calendar/store';
import type { Calendar } from '../../src/lib/calendar/types';
import { registerCalendarImportJob } from '../../src/lib/calendar/v2/import-export';
import { onBeforeDatabaseClose, onDatabaseReady, resetCalendarBaseline, snapshotSeedCalendars, sql, useTestDatabase } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';
import { api } from '../helpers/http';
import { radicaleAvailability, type RadicaleServer, startRadicale, TEST_PRINCIPAL } from '../helpers/radicale';

useTestDatabase({ resetBaseline: true });
// PUT /calendars/order e PATCH (colore di 'bookings') agiscono sui calendari
// seminati: tornano com'erano, altrimenti i contratti F0 eseguiti dopo sullo
// stesso database (test:contracts:radicale) vedrebbero sort_order e colori diversi.
let restoreSeedCalendars: (() => Promise<void>) | null = null;
onDatabaseReady(async () => {
  restoreSeedCalendars = await snapshotSeedCalendars();
});
onBeforeDatabaseClose(async () => {
  overrideCalendarStore(null);
  await stopIndexWorker();
  unregisterCalendarJobHandler(CAL_JOB_KINDS.calendarImport);
  await sql`DELETE FROM cal_jobs WHERE kind = 'calendar_import'`;
  await resetCalendarBaseline();
  await restoreSeedCalendars?.();
});
const fx = useFixtures('admin-v2-c2-int');

const radicale = radicaleAvailability();
const P = TEST_PRINCIPAL;
const SVC_PASSWORD = 'test-only-svc-password-f6-admin-v2-c2';
const BASE = '/api/admin/calendar/v2';

/** Matrice di caldes-svc del contratto control-plane §8 (R root, RW principal, rwD collezioni). */
const SVC_RIGHTS_RULES = [
  '[root]', 'user: .+', 'collection:', 'permissions: R', '',
  '[svc-principal]', 'user: caldes-svc', `collection: ${P}`, 'permissions: RW', '',
  '[svc-collections]', 'user: caldes-svc', `collection: ${P}/[^/]+`, 'permissions: rwD', '',
].join('\n');

const unfold = (text: string): string => text.replace(/\r\n[ \t]/g, '');

const TZ_ROME = [
  'BEGIN:VTIMEZONE', 'TZID:Europe/Rome',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];

const wrap = (...bodies: string[][]): string => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//C2//IT', ...bodies.flat(), 'END:VCALENDAR', ''].join('\r\n');

/** Evento con VALARM, ATTENDEE e X-* con parametri sconosciuti: tutto ciò che non si deve perdere. */
const richEvent = (uid: string, over: { summary?: string; start?: string; end?: string; extra?: string[] } = {}): string[] => [
  'BEGIN:VEVENT',
  `UID:${uid}`,
  'DTSTAMP:20270101T080000Z',
  `DTSTART:${over.start ?? '20280301T080000Z'}`,
  `DTEND:${over.end ?? '20280301T090000Z'}`,
  'SEQUENCE:2',
  `SUMMARY:${over.summary ?? 'Evento ricco'}`,
  'DESCRIPTION:Riga uno\\nRiga due con virgola\\, e punto e virgola\\;',
  'X-ACME-CUSTOM;X-PARAM=uno:valore',
  'ATTENDEE;CN=Mario Rossi;PARTSTAT=NEEDS-ACTION:mailto:mario@example.com',
  'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'DESCRIPTION:Tra poco', 'END:VALARM',
  ...(over.extra ?? []),
  'END:VEVENT',
];

/** Blocchi VEVENT di un testo, per UID e per RECURRENCE-ID: righe spiegate e ordinate, senza le X-CALDES-* del sistema. */
function eventBlocks(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const lines = unfold(text).split(/\r\n/);
  let current: string[] | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') current = [];
    else if (line === 'END:VEVENT' && current) {
      const uid = current.find((l) => l.startsWith('UID:')) ?? 'UID:?';
      const rid = current.find((l) => l.startsWith('RECURRENCE-ID'));
      out.set(`${uid}|${rid ?? ''}`, current.filter((l) => !l.startsWith('X-CALDES-')).sort());
      current = null;
    } else if (current) current.push(line);
  }
  return out;
}

describe('API admin v2, passo C2, contro Radicale reale', { skip: radicale.skip }, () => {
  let rad: RadicaleServer;
  let svc: RadicaleClient;
  let src: Calendar;

  /** Scrive come un device (PUT con If-None-Match) e indicizza. */
  const deviceWrite = async (slug: string, calendarId: string, href: string, text: string): Promise<void> => {
    await svc.put(objectPath(P, slug, href), text, { ifNoneMatch: '*' });
    await syncCollection(calendarId, { reason: 'manual' });
  };

  const deviceEdit = async (slug: string, calendarId: string, href: string, edit: (text: string) => string): Promise<void> => {
    const cur = await svc.get(objectPath(P, slug, href));
    await svc.put(objectPath(P, slug, href), edit(cur.body), { ifMatch: cur.etag as string });
    await syncCollection(calendarId, { reason: 'manual' });
  };

  const textOf = async (slug: string, href: string): Promise<string | null> => {
    try {
      return (await svc.get(objectPath(P, slug, href))).body;
    } catch (err) {
      if ((err as { code?: string }).code === 'not_found') return null;
      throw err;
    }
  };

  const createCalendar = async (body: Record<string, unknown>): Promise<CalV2CalendarView> => {
    const res = await api.post(`${BASE}/calendars`, { auth: 'admin', body });
    assert.equal(res.status, 201, res.text);
    return res.json as CalV2CalendarView;
  };

  const calendars = async (): Promise<CalV2CalendarView[]> => {
    const res = await api.get(`${BASE}/calendars`, { auth: 'admin' });
    assert.equal(res.status, 200, res.text);
    return (res.json as CalV2CalendarList).calendars;
  };

  const davProps = async (slug: string): Promise<Record<string, string> | null> =>
    svc.readProps(collectionPath(P, slug), [DAV_PROPS.displayname, DAV_PROPS.calendarColor, DAV_PROPS.calendarDescription, DAV_PROPS.calendarOrder, DAV_PROPS.calendarTimezone, DAV_PROPS.role, DAV_PROPS.calendarId]);

  const objectCount = async (calendarId: string): Promise<number> =>
    Number((await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM cal_objects WHERE calendar_id = ${calendarId}::uuid`)[0].n);

  const dry = async (calendarId: string, ics: string, onConflict: 'skip' | 'replace' | 'new_uid'): Promise<CalV2ImportPlan> => {
    const res = await api.post(`${BASE}/calendars/${calendarId}/import`, { auth: 'admin', body: { ics, mode: 'dry_run', on_conflict: onConflict } });
    assert.equal(res.status, 200, res.text);
    return res.json as CalV2ImportPlan;
  };

  const commit = async (calendarId: string, ics: string, onConflict: 'skip' | 'replace' | 'new_uid', key = `chiave-${randomUUID()}`): Promise<CalV2JobAccepted> => {
    const p = await dry(calendarId, ics, onConflict);
    const res = await api.post(`${BASE}/calendars/${calendarId}/import`, {
      auth: 'admin',
      headers: { 'Idempotency-Key': key },
      body: { ics, mode: 'commit', on_conflict: onConflict, plan_hash: p.plan_hash },
    });
    assert.equal(res.status, 202, res.text);
    return res.json as CalV2JobAccepted;
  };

  const job = async (id: string): Promise<CalV2JobView> => {
    const res = await api.get(`${BASE}/jobs/${id}`, { auth: 'admin' });
    assert.equal(res.status, 200, res.text);
    return res.json as CalV2JobView;
  };

  /** Esegue i job in coda finché `id` non è chiuso (done o dead). */
  const runUntilClosed = async (id: string, limit = 8): Promise<CalV2JobView> => {
    for (let i = 0; i < limit; i++) {
      await runCalendarJobsOnce({ limit: 5 });
      const v = await job(id);
      if (v.status === 'done' || v.status === 'dead') return v;
    }
    return job(id);
  };

  const hasIcs = async (id: string): Promise<boolean> =>
    (await sql<Array<{ has: boolean }>>`SELECT (payload ? 'ics') AS has FROM cal_jobs WHERE id = ${id}::bigint`)[0].has;

  const exportOf = async (calendarId: string): Promise<string> => {
    const res = await api.get(`${BASE}/calendars/${calendarId}/export.ics`, { auth: 'admin' });
    assert.equal(res.status, 200, res.text.slice(0, 200));
    return res.text;
  };

  const readObject = async (id: string): Promise<{ etag: string; uid: string; summary: string | null }> => {
    const res = await api.get(`${BASE}/objects/${encodeURIComponent(id)}`, { auth: 'admin' });
    assert.equal(res.status, 200, res.text);
    return { etag: res.json.etag, uid: res.json.uid, summary: res.json.master?.fields?.summary ?? null };
  };

  before(async () => {
    rad = await startRadicale({
      label: 'f6-admin-v2-c2',
      auth: { type: 'htpasswd', users: { 'caldes-svc': SVC_PASSWORD } },
      rights: { type: 'from_file', rules: SVC_RIGHTS_RULES },
    });
    svc = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0 });
    src = await fx.calendar({ key: 'sorgente', blocks_availability: true });
    const init = await initializeVolume({ db: sql, client: svc, principal: P });
    assert.ok(init.collections.every((c) => c.status === 'created'));
    configureRadicaleRuntime({ client: svc, dataDir: rad.storageDir, principal: P, watch: 'auto', identitySource: 'auto' });
    updateWatchMode('mount', null);
    overrideCalendarStore('radicale');
    registerCalendarImportJob();
  });

  after(async () => {
    overrideCalendarStore(null);
    configureRadicaleRuntime(null);
    updateWatchMode('off', 'test concluso');
    svc?.close();
    await rad?.stop();
  });

  // ── Calendari ──

  test('capacità: calendar_properties e import_export veri', async () => {
    const res = await api.get(`${BASE}/capabilities`, { auth: 'admin' });
    for (const flag of ['calendar_properties', 'import_export']) assert.equal(res.json[flag], true, flag);
  });

  test('POST /calendars: MKCALENDAR esplicita, proprietà via PROPFIND, slug dal nome, ruolo e visibilità', async () => {
    const created = await createCalendar({
      name: 'Calendario Ünico',
      description: 'Per le prove',
      color: '#aa5500',
      timezone: 'America/New_York',
      role: 'deadlines',
      blocks_availability: false,
      device_visible: false,
      ics_feed_enabled: false,
    });
    assert.equal(created.slug, 'calendario-unico');
    assert.equal(created.collection_name, 'calendario-unico');
    assert.equal(created.role, 'deadlines');
    assert.equal(created.origin, 'admin');
    assert.equal(created.timezone, 'America/New_York');
    assert.equal(created.blocks_availability, false);
    assert.equal(created.device_visible, false);
    assert.equal(created.device_url, null, 'non visibile ai device');
    assert.equal(created.ics_feed_enabled, false);
    assert.equal(created.feed_url, null);
    assert.equal(created.lifecycle, 'active');
    assert.equal(created.deletable, true);
    assert.equal(created.object_count, 0);
    assert.ok(created.sync, 'riga di stato dell\'indice creata');

    const props = await davProps(created.slug);
    assert.ok(props, 'la collezione esiste in Radicale');
    assert.equal(props[clark(DAV_PROPS.displayname)], 'Calendario Ünico');
    assert.equal(props[clark(DAV_PROPS.calendarColor)], '#aa5500');
    assert.equal(props[clark(DAV_PROPS.calendarDescription)], 'Per le prove');
    assert.equal(props[clark(DAV_PROPS.role)], 'deadlines');
    assert.equal(props[clark(DAV_PROPS.calendarId)], created.id);
    assert.match(props[clark(DAV_PROPS.calendarTimezone)] ?? '', /^BEGIN:VCALENDAR/, 'calendar-timezone scritta');

    // Lo stesso nome ricavato dà un secondo slug libero; lo stesso nome esatto è rifiutato.
    const dup = await api.post(`${BASE}/calendars`, { auth: 'admin', body: { name: 'Calendario Ünico' } });
    assert.equal(dup.status, 400, dup.text);
    assert.equal(dup.json.code, 'VALIDATION_FAILED');
    const second = await createCalendar({ name: 'Calendario unico!' });
    assert.equal(second.slug, 'calendario-unico-2');
    assert.equal(second.role, 'user');
    assert.equal(second.device_visible, true);
    assert.match(second.device_url ?? '', /\/calendario-unico-2\/$/);
    assert.match(second.feed_url ?? '', /\/api\/calendar\/feed\/[a-z0-9]{32}\.ics$/);
    // Slug indicato e già usato → 400.
    const slugClash = await api.post(`${BASE}/calendars`, { auth: 'admin', body: { name: 'Altro nome', slug: 'calendario-unico' } });
    assert.equal(slugClash.status, 400);
    // In coda agli altri nell'ordine.
    const all = await calendars();
    assert.ok((all.find((c) => c.id === second.id)?.sort_order ?? 0) > (all.find((c) => c.id === created.id)?.sort_order ?? 0));

    const audit = await sql<Array<{ metadata: Record<string, unknown>; table_name: string; changed_fields: string[] | null }>>`
      SELECT metadata, table_name, changed_fields FROM audit_logs WHERE record_id = ${created.id} AND metadata->>'operation' = 'v2.calendar.create'
    `;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].table_name, 'calendars');
    assert.ok(!JSON.stringify(audit[0]).includes('Per le prove'), 'nessun testo dell\'utente nell\'audit');
  });

  test('PATCH /calendars/:id: PROPPATCH di nome, colore, descrizione, fuso e ruolo; segna come visto; ruoli', async () => {
    const cal = await createCalendar({ name: 'Da modificare', color: '#112233' });
    const res = await api.patch(`${BASE}/calendars/${cal.id}`, {
      auth: 'admin',
      body: { name: 'Modificato', color: '#445566', description: 'Nuova descrizione', timezone: 'Europe/London', role: 'deadlines', blocks_availability: false, ics_feed_enabled: false },
    });
    assert.equal(res.status, 200, res.text);
    const view = res.json as CalV2CalendarView;
    assert.equal(view.name, 'Modificato');
    assert.equal(view.role, 'deadlines');
    assert.equal(view.timezone, 'Europe/London');
    assert.equal(view.feed_url, null);
    const props = await davProps(cal.slug);
    assert.ok(props);
    assert.equal(props[clark(DAV_PROPS.displayname)], 'Modificato');
    assert.equal(props[clark(DAV_PROPS.calendarColor)], '#445566');
    assert.equal(props[clark(DAV_PROPS.calendarDescription)], 'Nuova descrizione');
    assert.equal(props[clark(DAV_PROPS.role)], 'deadlines');
    assert.match(props[clark(DAV_PROPS.calendarTimezone)] ?? '', /^BEGIN:VCALENDAR/, 'calendar-timezone scritta');

    // Descrizione rimossa (null) e ruolo di nuovo "personale".
    const back = await api.patch(`${BASE}/calendars/${cal.id}`, { auth: 'admin', body: { description: null, role: 'user', device_visible: false } });
    assert.equal(back.status, 200, back.text);
    assert.equal(back.json.description, null);
    assert.equal(back.json.device_visible, false);
    const props2 = await davProps(cal.slug);
    assert.ok(props2);
    assert.equal(props2[clark(DAV_PROPS.calendarDescription)], undefined, 'descrizione rimossa da Radicale');
    assert.equal(props2[clark(DAV_PROPS.role)], 'user');

    // Calendario nuovo dal dispositivo: "segna come visto".
    await sql`UPDATE calendars SET needs_review = true, review_reason = 'device_new' WHERE id = ${cal.id}::uuid`;
    const seen = await api.patch(`${BASE}/calendars/${cal.id}`, { auth: 'admin', body: { needs_review: false } });
    assert.equal(seen.status, 200);
    assert.equal(seen.json.needs_review, false);
    assert.equal(seen.json.review_reason, null);

    // Ruoli di sistema: 403, e "bookings" non si cambia.
    assert.equal((await api.patch(`${BASE}/calendars/${cal.id}`, { auth: 'admin', body: { role: 'holidays' } })).status, 403);
    const bookings = (await calendars()).find((c) => c.role === 'bookings') as CalV2CalendarView;
    assert.equal((await api.patch(`${BASE}/calendars/${bookings.id}`, { auth: 'admin', body: { role: 'user' } })).status, 403);
    const rename = await api.patch(`${BASE}/calendars/${bookings.id}`, { auth: 'admin', body: { color: '#010203' } });
    assert.equal(rename.status, 200, 'il colore di un calendario di sistema si cambia');
    const [{ n }] = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM audit_logs WHERE record_id = ${cal.id} AND metadata->>'operation' = 'v2.calendar.update'`;
    assert.equal(Number(n), 3);
  });

  test('PUT /calendars/order: sort_order = posizione e calendar-order su Radicale; rotate-token cambia il feed', async () => {
    const a = await createCalendar({ name: 'Ordine A' });
    const b = await createCalendar({ name: 'Ordine B' });
    const c = await createCalendar({ name: 'Ordine C' });
    const all = (await calendars()).map((x) => x.id);
    const wanted = [c.id, ...all.filter((id) => id !== c.id && id !== a.id && id !== b.id), b.id, a.id];
    const res = await api.put(`${BASE}/calendars/order`, { auth: 'admin', body: { ids: wanted } });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual((res.json as CalV2CalendarList).calendars.map((x) => x.id), wanted);
    for (const [slug, id] of [[a.slug, a.id], [b.slug, b.id], [c.slug, c.id]] as const) {
      const props = await davProps(slug);
      assert.equal(props?.[clark(DAV_PROPS.calendarOrder)], String(wanted.indexOf(id)), slug);
    }
    const [row] = await sql<Array<{ changed_fields: string[]; metadata: Record<string, unknown> }>>`
      SELECT changed_fields, metadata FROM audit_logs WHERE metadata->>'operation' = 'v2.calendar.order' ORDER BY created_at DESC LIMIT 1
    `;
    assert.deepEqual(row.changed_fields, ['sort_order']);

    const feedOf = async (id: string) => (await calendars()).find((x) => x.id === id)?.feed_url as string;
    const oldFeed = await feedOf(a.id);
    assert.equal((await api.get(new URL(oldFeed).pathname)).status, 200, 'il feed attuale risponde');
    const rotated = await api.post(`${BASE}/calendars/${a.id}/rotate-token`, { auth: 'admin', body: {} });
    assert.equal(rotated.status, 200, rotated.text);
    assert.notEqual(rotated.json.feed_url, oldFeed);
    assert.equal((await api.get(new URL(oldFeed).pathname)).status, 404, 'il vecchio feed non risponde più');
    assert.equal((await api.get(new URL(rotated.json.feed_url).pathname)).status, 200, 'il nuovo feed risponde');
  });

  test('DELETE /calendars/:id: non vuoto → 409; with_objects=1 elimina collezione, oggetti e riga; vuoto si elimina subito', async () => {
    const full = await createCalendar({ name: 'Da eliminare con eventi' });
    const empty = await createCalendar({ name: 'Da eliminare vuoto' });
    await deviceWrite(full.slug, full.id, 'e1.ics', wrap(richEvent('del-1@caldes.test')));
    await deviceWrite(full.slug, full.id, 'e2.ics', wrap(richEvent('del-2@caldes.test')));
    assert.equal((await calendars()).find((x) => x.id === full.id)?.object_count, 2);

    const refused = await api.delete(`${BASE}/calendars/${full.id}`, { auth: 'admin' });
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.json.code, 'CALENDAR_NOT_EMPTY');
    assert.equal(refused.json.details.object_count, 2);
    assert.ok(await davProps(full.slug), 'la collezione è ancora lì');

    const done = await api.delete(`${BASE}/calendars/${full.id}`, { auth: 'admin', query: { with_objects: 1 } });
    assert.equal(done.status, 200, done.text);
    assert.deepEqual(done.json, { deleted: true });
    assert.equal(await davProps(full.slug), null, 'collezione eliminata da Radicale');
    assert.equal((await calendars()).some((x) => x.id === full.id), false);
    assert.equal((await sql`SELECT 1 FROM calendars WHERE id = ${full.id}::uuid`).length, 0);
    assert.equal(await objectCount(full.id), 0);

    const emptyDel = await api.delete(`${BASE}/calendars/${empty.id}`, { auth: 'admin' });
    assert.equal(emptyDel.status, 200, emptyDel.text);
    assert.equal(await davProps(empty.slug), null);
    assert.equal((await api.delete(`${BASE}/calendars/${empty.id}`, { auth: 'admin' })).status, 404);

    const [row] = await sql<Array<{ metadata: Record<string, unknown>; action: string }>>`
      SELECT metadata, action FROM audit_logs WHERE record_id = ${full.id} AND metadata->>'operation' = 'v2.calendar.delete'
    `;
    assert.equal(row.action, 'DELETE');
    assert.equal(row.metadata.object_count, 2);
    assert.equal(row.metadata.with_objects, true);
  });

  // ── Export e import ──

  test('export → import in un calendario vuoto: stesso numero di oggetti, VALARM, ATTENDEE e X-* conservati; job con progress e risultato; payload senza ics', async () => {
    const uidA = 'exp-ricco@caldes.test';
    const uidB = 'exp-fuso@caldes.test';
    const uidC = 'exp-serie@caldes.test';
    const uidD = 'exp-giorno@caldes.test';
    const lossless = await createCalendar({ name: 'Sorgente lossless' });
    await deviceWrite(lossless.slug, lossless.id, 'a.ics', wrap(richEvent(uidA, { extra: ['CATEGORIES:lavoro,test'] })));
    await deviceWrite(lossless.slug, lossless.id, 'b.ics', wrap(TZ_ROME, [
      'BEGIN:VEVENT', `UID:${uidB}`, 'DTSTAMP:20270101T080000Z', 'DTSTART;TZID=Europe/Rome:20280302T100000', 'DTEND;TZID=Europe/Rome:20280302T110000', 'SUMMARY:Con fuso orario', 'LOCATION:Sala 3', 'END:VEVENT',
    ]));
    await deviceWrite(lossless.slug, lossless.id, 'c.ics', wrap(TZ_ROME, [
      'BEGIN:VEVENT', `UID:${uidC}`, 'DTSTAMP:20270101T080000Z', 'DTSTART;TZID=Europe/Rome:20280306T090000', 'DTEND;TZID=Europe/Rome:20280306T100000', 'RRULE:FREQ=WEEKLY;COUNT=4', 'EXDATE;TZID=Europe/Rome:20280320T090000', 'SUMMARY:Serie', 'END:VEVENT',
      'BEGIN:VEVENT', `UID:${uidC}`, 'DTSTAMP:20270101T080000Z', 'RECURRENCE-ID;TZID=Europe/Rome:20280313T090000', 'DTSTART;TZID=Europe/Rome:20280313T110000', 'DTEND;TZID=Europe/Rome:20280313T120000', 'SUMMARY:Serie spostata', 'END:VEVENT',
    ]));
    await deviceWrite(lossless.slug, lossless.id, 'd.ics', wrap([
      'BEGIN:VEVENT', `UID:${uidD}`, 'DTSTAMP:20270101T080000Z', 'DTSTART;VALUE=DATE:20280310', 'DTEND;VALUE=DATE:20280311', 'SUMMARY:Tutto il giorno', 'END:VEVENT',
    ]));
    const sourceCount = await objectCount(lossless.id);
    assert.equal(sourceCount, 4);

    const exp = await api.get(`${BASE}/calendars/${lossless.id}/export.ics`, { auth: 'admin' });
    assert.equal(exp.status, 200);
    assert.match(exp.headers.get('content-type') ?? '', /^text\/calendar; charset=utf-8/);
    assert.equal(exp.headers.get('content-disposition'), `attachment; filename="${lossless.slug}.ics"`);
    const ics = exp.text;
    assert.equal(ics.match(/BEGIN:VCALENDAR/g)?.length, 1);
    assert.equal(ics.match(/BEGIN:VTIMEZONE/g)?.length, 1, 'un VTIMEZONE per TZID anche se due oggetti lo usano');
    assert.equal(ics.match(/^BEGIN:VEVENT$/gm)?.length, sourceCount + 1, 'tutti i VEVENT (la serie ne ha due)');
    assert.match(ics, /PRODID:-\/\/Caldes\/\/calendar-core\/\/IT/);

    const dest = await createCalendar({ name: 'Import lossless' });
    // Finché la sorgente esiste gli UID sono "in un altro calendario": skip, o UID nuovi con le altre modalità.
    const blocked = await dry(dest.id, ics, 'skip');
    assert.deepEqual([blocked.skip, blocked.create], [sourceCount, 0]);
    assert.ok(blocked.items.every((i) => i.reason === 'uid_in_other_calendar'));
    const renamed = await dry(dest.id, ics, 'new_uid');
    assert.equal(renamed.new_uid, sourceCount);
    // Sorgente eliminata: l'export si importa in un calendario vuoto con gli stessi UID.
    assert.equal((await api.delete(`${BASE}/calendars/${lossless.id}`, { auth: 'admin', query: { with_objects: 1 } })).status, 200);
    const plan = await dry(dest.id, ics, 'skip');
    assert.equal(plan.total, sourceCount);
    assert.equal(plan.create, sourceCount);
    assert.equal(plan.invalid, 0);

    const accepted = await commit(dest.id, ics, 'skip');
    assert.equal(accepted.created, true);
    assert.equal((await job(accepted.job_id)).status, 'pending');
    const done = await runUntilClosed(accepted.job_id);
    assert.equal(done.status, 'done', JSON.stringify(done));
    assert.equal(done.kind, 'calendar_import');
    assert.equal(done.calendar_id, dest.id);
    assert.deepEqual(done.result, { created: sourceCount, replaced: 0, skipped: 0, failed: [] });
    assert.deepEqual(done.progress, { total: sourceCount, done: sourceCount, failed: 0 });
    assert.ok(done.started_at && done.finished_at);
    assert.equal(done.error, null);
    assert.equal(await hasIcs(accepted.job_id), false, 'il testo ICS non resta nel payload');

    await syncCollection(dest.id, { reason: 'manual' });
    assert.equal(await objectCount(dest.id), sourceCount, 'stesso numero di oggetti');
    const destExport = await exportOf(dest.id);
    const before = eventBlocks(ics);
    const after = eventBlocks(destExport);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
    for (const [key, lines] of before) {
      assert.deepEqual(after.get(key), lines, `blocco ${key} identico (salvo l'ordine delle righe e le X-CALDES-*)`);
    }
    const ricco = [...after.entries()].find(([k]) => k.includes(uidA))?.[1] as string[];
    for (const needle of ['X-ACME-CUSTOM;X-PARAM=uno:valore', 'TRIGGER:-PT15M', 'ATTENDEE;CN=Mario Rossi;PARTSTAT=NEEDS-ACTION:mailto:mario@example.com', 'CATEGORIES:lavoro,test']) {
      assert.ok(ricco.includes(needle), needle);
    }
    // Provenienza `admin` sugli oggetti creati, nel testo in Radicale e nell'indice.
    const stored = await textOf(dest.slug, `${uidA}.ics`);
    assert.ok(stored);
    assert.match(unfold(stored), /X-CALDES-SOURCE:admin/);
    const [prov] = await sql<Array<{ source: string }>>`SELECT source FROM cal_objects WHERE calendar_id = ${dest.id}::uuid AND uid = ${uidA}`;
    assert.equal(prov.source, 'admin');

    // Audit: una riga per oggetto scritto, più quella del job; mai il testo.
    const rows = await sql<Array<{ record_id: string; metadata: Record<string, unknown>; table_name: string }>>`
      SELECT record_id, metadata, table_name FROM audit_logs WHERE metadata->>'operation' = 'v2.import' AND metadata->>'job_id' = ${accepted.job_id}
    `;
    assert.equal(rows.length, sourceCount);
    assert.ok(rows.every((r) => r.table_name === 'cal_objects' && r.record_id));
    const [jobRow] = await sql<Array<{ metadata: Record<string, unknown>; table_name: string; record_id: string }>>`
      SELECT metadata, table_name, record_id FROM audit_logs WHERE metadata->>'operation' = 'v2.import.job' AND metadata->>'job_id' = ${accepted.job_id}
    `;
    assert.equal(jobRow.table_name, 'calendars');
    assert.equal(jobRow.record_id, dest.id);
    assert.equal(jobRow.metadata.created, sourceCount);
    assert.ok(!JSON.stringify(rows).includes('Evento ricco') && !JSON.stringify(jobRow).includes('Evento ricco'));
  });

  /** Calendario con X e Y già presenti, e W in un altro calendario. */
  const conflictFixture = async (label: string) => {
    const dst = await createCalendar({ name: `Conflitti ${label}` });
    const other = await createCalendar({ name: `Altrove ${label}` });
    const uid = (n: string) => `conf-${label}-${n}@caldes.test`;
    await deviceWrite(dst.slug, dst.id, 'x.ics', wrap(richEvent(uid('x'), { summary: 'X originale' })));
    await deviceWrite(dst.slug, dst.id, 'y.ics', wrap(richEvent(uid('y'), { summary: 'Y originale' })));
    await deviceWrite(other.slug, other.id, 'w.ics', wrap(richEvent(uid('w'), { summary: 'W originale' })));
    const file = wrap(
      richEvent(uid('x'), { summary: 'X dal file' }),
      richEvent(uid('y'), { summary: 'Y dal file', start: '20280401T080000Z', end: '20280401T090000Z' }),
      richEvent(uid('z'), { summary: 'Z nuovo' }),
      richEvent(uid('w'), { summary: 'W dal file', extra: ['RELATED-TO:genitore@caldes.test'] }),
    );
    const idOf = async (cal: { id: string }, u: string): Promise<string> =>
      (await sql<Array<{ id: string }>>`SELECT id FROM cal_objects WHERE calendar_id = ${cal.id}::uuid AND uid = ${u}`)[0]?.id;
    return { dst, other, uid, file, idOf };
  };

  test('on_conflict skip: gli esistenti e quello di un altro calendario si saltano, il nuovo si crea', async () => {
    const f = await conflictFixture('skip');
    const accepted = await commit(f.dst.id, f.file, 'skip');
    const done = await runUntilClosed(accepted.job_id);
    assert.equal(done.status, 'done', JSON.stringify(done));
    assert.deepEqual(done.result, { created: 1, replaced: 0, skipped: 3, failed: [] });
    assert.deepEqual(done.progress, { total: 4, done: 4, failed: 0 });
    await syncCollection(f.dst.id, { reason: 'manual' });
    assert.equal(await objectCount(f.dst.id), 3);
    assert.equal((await readObject(await f.idOf(f.dst, f.uid('x')))).summary, 'X originale');
  });

  test('on_conflict replace: sostituisce nello stesso href e con lo stesso id; l\'UID di un altro calendario prende un UID nuovo', async () => {
    const f = await conflictFixture('replace');
    const idX = await f.idOf(f.dst, f.uid('x'));
    const etagBefore = (await readObject(idX)).etag;
    const accepted = await commit(f.dst.id, f.file, 'replace');
    const done = await runUntilClosed(accepted.job_id);
    assert.equal(done.status, 'done', JSON.stringify(done));
    assert.deepEqual(done.result, { created: 2, replaced: 2, skipped: 0, failed: [] });
    await syncCollection(f.dst.id, { reason: 'manual' });
    const after = await readObject(idX);
    assert.equal(after.summary, 'X dal file');
    assert.notEqual(after.etag, etagBefore);
    assert.equal(await f.idOf(f.dst, f.uid('x')), idX, 'stesso id');
    assert.ok(await textOf(f.dst.slug, 'x.ics'), 'stesso href');
    assert.equal(await objectCount(f.dst.id), 4, 'X, Y, Z e W con UID nuovo');
    const [w] = await sql<Array<{ uid: string; raw_ics: string }>>`
      SELECT uid, raw_ics FROM cal_objects WHERE calendar_id = ${f.dst.id}::uuid AND uid NOT IN (${f.uid('x')}, ${f.uid('y')}, ${f.uid('z')})
    `;
    assert.notEqual(w.uid, f.uid('w'));
    assert.match(unfold(w.raw_ics), /RELATED-TO:genitore@caldes\.test/);
    assert.equal(await f.idOf(f.other, f.uid('w')) !== undefined, true, 'l\'originale resta nell\'altro calendario');
  });

  test('on_conflict new_uid: gli UID in conflitto diventano oggetti nuovi con RELATED-TO invariato; gli originali non si toccano', async () => {
    const f = await conflictFixture('newuid');
    const accepted = await commit(f.dst.id, f.file, 'new_uid');
    const done = await runUntilClosed(accepted.job_id);
    assert.equal(done.status, 'done', JSON.stringify(done));
    assert.deepEqual(done.result, { created: 4, replaced: 0, skipped: 0, failed: [] });
    await syncCollection(f.dst.id, { reason: 'manual' });
    assert.equal(await objectCount(f.dst.id), 6, 'X e Y originali più quattro oggetti nuovi');
    assert.equal((await readObject(await f.idOf(f.dst, f.uid('x')))).summary, 'X originale');
    const copies = await sql<Array<{ uid: string; raw_ics: string }>>`
      SELECT uid, raw_ics FROM cal_objects WHERE calendar_id = ${f.dst.id}::uuid AND uid NOT IN (${f.uid('x')}, ${f.uid('y')}, ${f.uid('z')})
    `;
    assert.equal(copies.length, 3);
    assert.ok(copies.every((c) => !c.uid.startsWith('conf-')), 'UID nuovi');
    assert.ok(copies.some((c) => /RELATED-TO:genitore@caldes\.test/.test(unfold(c.raw_ics))));
    assert.ok(copies.some((c) => /SUMMARY:X dal file/.test(unfold(c.raw_ics))));
  });

  test('una voce cambiata dopo l\'anteprima va in `failed` e non si sovrascrive; le altre proseguono', async () => {
    const f = await conflictFixture('changed');
    const accepted = await commit(f.dst.id, f.file, 'replace');
    // Un device modifica X fra il commit e l'esecuzione del job.
    await deviceEdit(f.dst.slug, f.dst.id, 'x.ics', (t) => t.replace('SUMMARY:X originale', 'SUMMARY:X del device'));
    const done = await runUntilClosed(accepted.job_id);
    assert.equal(done.status, 'done', JSON.stringify(done));
    assert.deepEqual((done.result as CalV2ImportResult).failed.map((x) => [x.index, x.uid, x.code]), [[0, f.uid('x'), 'changed']]);
    assert.equal((done.result as { created: number; replaced: number }).replaced, 1);
    assert.equal((done.result as { created: number }).created, 2);
    assert.deepEqual(done.progress, { total: 4, done: 4, failed: 1 });
    await syncCollection(f.dst.id, { reason: 'manual' });
    assert.equal((await readObject(await f.idOf(f.dst, f.uid('x')))).summary, 'X del device', 'la modifica del device non è stata sovrascritta');
    assert.equal((await readObject(await f.idOf(f.dst, f.uid('y')))).summary, 'Y dal file');
  });

  test('componenti non supportati e file con voci invalide: il piano le segnala, il job le riporta in `failed` senza fermarsi', async () => {
    const dest = await createCalendar({ name: 'Con invalidi' });
    const ics = wrap(
      richEvent('inv-ok@caldes.test'),
      ['BEGIN:VTODO', 'UID:inv-todo@caldes.test', 'DTSTAMP:20270101T080000Z', 'SUMMARY:Attività', 'END:VTODO'],
      ['BEGIN:VEVENT', 'UID:inv-senza-inizio@caldes.test', 'DTSTAMP:20270101T080000Z', 'SUMMARY:Senza inizio', 'END:VEVENT'],
    );
    const plan = await dry(dest.id, ics, 'skip');
    assert.deepEqual([plan.create, plan.invalid], [1, 2]);
    assert.deepEqual(plan.items.map((i) => i.reason), [null, 'component_unsupported', 'validation_failed']);
    const done = await runUntilClosed((await commit(dest.id, ics, 'skip')).job_id);
    assert.equal(done.status, 'done', JSON.stringify(done));
    assert.equal((done.result as { created: number }).created, 1);
    assert.deepEqual((done.result as { failed: Array<{ code: string }> }).failed.map((x) => x.code), ['component_unsupported', 'validation_failed']);
    assert.deepEqual(done.progress, { total: 3, done: 3, failed: 2 });
  });

  // ── Job: progress, ripresa, attesa, dead letter ──

  test('progress durante il job: running con done fra 1 e total-1, poi done con total', async () => {
    const dest = await createCalendar({ name: 'Con progress' });
    const total = 120;
    const ics = wrap(...Array.from({ length: total }, (_, i) => richEvent(`prog-${i}@caldes.test`, { summary: `Evento ${i}` })));
    const accepted = await commit(dest.id, ics, 'skip');
    const running = runCalendarJobsOnce({ limit: 1 });
    let seen: CalV2JobView | null = null;
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const v = await job(accepted.job_id);
      if (v.status === 'running' && v.progress && v.progress.done > 0 && v.progress.done < total) {
        seen = v;
        break;
      }
      if (v.status === 'done' || v.status === 'dead') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await running;
    assert.ok(seen, 'un aggiornamento di progress durante l\'esecuzione');
    assert.equal(seen.progress?.total, total);
    assert.equal(seen.result, null, 'il risultato compare solo a job chiuso');
    assert.ok(seen.started_at && !seen.finished_at);
    const done = await job(accepted.job_id);
    assert.equal(done.status, 'done');
    assert.deepEqual(done.progress, { total, done: total, failed: 0 });
    assert.equal((done.result as { created: number }).created, total);
    await syncCollection(dest.id, { reason: 'manual' });
    assert.equal(await objectCount(dest.id), total);
  });

  test('ripresa dopo un\'interruzione: dal punto registrato, nessun duplicato, la voce già scritta ma non registrata si riconosce', async () => {
    const dest = await createCalendar({ name: 'Con ripresa' });
    const total = 80;
    const ics = wrap(...Array.from({ length: total }, (_, i) => richEvent(`ripresa-${i}@caldes.test`, { summary: `Voce ${i}` })));
    const accepted = await commit(dest.id, ics, 'skip');
    // Interruzione dopo il primo aggiornamento periodico del punto raggiunto (ogni 2 s).
    const stopper = new AbortController();
    setTimeout(() => stopper.abort(), 2_700);
    await runCalendarJobsOnce({ limit: 1, signal: stopper.signal });
    await new Promise((r) => setTimeout(r, 300)); // l'esecuzione interrotta si ferma alla voce successiva
    const [mid] = await sql<Array<{ status: string; result: { cursor?: number; created?: number } | null }>>`SELECT status, result FROM cal_jobs WHERE id = ${accepted.job_id}::bigint`;
    assert.equal(mid.status, 'pending', 'interrotto: torna in coda');
    const cursor = mid.result?.cursor ?? 0;
    assert.ok(cursor >= 1 && cursor < total, `punto raggiunto registrato (${cursor})`);
    assert.equal(mid.result?.created, cursor);
    assert.equal(await hasIcs(accepted.job_id), true, 'il lavoro non è finito: il testo serve ancora');
    assert.ok(await textOf(dest.slug, `ripresa-${cursor - 1}@caldes.test.ics`), 'le voci prima del punto raggiunto sono in Radicale');
    // Come dopo un arresto fra la PUT e il salvataggio del punto raggiunto: l'ultima voce risulta ancora da fare.
    await sql`UPDATE cal_jobs SET result = jsonb_set(jsonb_set(result, '{cursor}', to_jsonb(${cursor - 1}::int)), '{created}', to_jsonb(${cursor - 1}::int)), run_after = now() WHERE id = ${accepted.job_id}::bigint`;
    const done = await runUntilClosed(accepted.job_id);
    assert.equal(done.status, 'done', JSON.stringify(done));
    assert.deepEqual(done.result, { created: total, replaced: 0, skipped: 0, failed: [] });
    assert.deepEqual(done.progress, { total, done: total, failed: 0 });
    await syncCollection(dest.id, { reason: 'manual' });
    assert.equal(await objectCount(dest.id), total, 'nessun duplicato');
    assert.equal(await hasIcs(accepted.job_id), false);
  });

  test('gate chiuso (write_freeze): il job attende senza consumare tentativi e poi completa', async () => {
    const dest = await createCalendar({ name: 'Con gate chiuso' });
    const ics = wrap(richEvent('gate-1@caldes.test'), richEvent('gate-2@caldes.test'));
    const accepted = await commit(dest.id, ics, 'skip');
    // write_freeze vale solo nei modi su Radicale: il database di prova parte da postgres con lo store forzato.
    const [prev] = await sql<Array<{ mode: string; write_freeze: boolean }>>`SELECT mode, write_freeze FROM calendar_backend_state WHERE id`;
    await sql`UPDATE calendar_backend_state SET mode = 'radicale', write_freeze = true WHERE id`;
    invalidateBackendModeCache();
    try {
      await runCalendarJobsOnce({ limit: 1 });
      const [waiting] = await sql<Array<{ status: string; attempts: number; max_attempts: number }>>`SELECT status, attempts, max_attempts FROM cal_jobs WHERE id = ${accepted.job_id}::bigint`;
      assert.equal(waiting.status, 'pending');
      assert.equal(waiting.attempts, 0, 'l\'attesa non conta come tentativo');
      assert.equal(await hasIcs(accepted.job_id), true);
    } finally {
      await sql`UPDATE calendar_backend_state SET mode = ${prev.mode}, write_freeze = ${prev.write_freeze} WHERE id`;
      invalidateBackendModeCache();
    }
    await sql`UPDATE cal_jobs SET run_after = now() WHERE id = ${accepted.job_id}::bigint`;
    const done = await runUntilClosed(accepted.job_id);
    assert.equal(done.status, 'done', JSON.stringify(done));
    assert.deepEqual(done.result, { created: 2, replaced: 0, skipped: 0, failed: [] });
  });

  test('calendario eliminato prima dell\'esecuzione: il job va in dead letter e il testo ICS non resta', async () => {
    const dest = await createCalendar({ name: 'Sparirà' });
    const accepted = await commit(dest.id, wrap(richEvent('dead-1@caldes.test')), 'skip');
    const del = await api.delete(`${BASE}/calendars/${dest.id}`, { auth: 'admin' });
    assert.equal(del.status, 200, del.text);
    const done = await runUntilClosed(accepted.job_id);
    assert.equal(done.status, 'dead');
    assert.match(done.error ?? '', /non esiste più/);
    assert.equal(await hasIcs(accepted.job_id), false, 'nessun testo di evento in cal_jobs');
  });

  test('stessa Idempotency-Key a job concluso: lo stesso job, nessun nuovo import', async () => {
    const dest = await createCalendar({ name: 'Idempotenza' });
    const ics = wrap(richEvent('idem-1@caldes.test'));
    const key = `chiave-${randomUUID()}`;
    const original = await dry(dest.id, ics, 'skip');
    const first = await commit(dest.id, ics, 'skip', key);
    assert.equal((await runUntilClosed(first.job_id)).status, 'done');
    const now = await dry(dest.id, ics, 'skip');
    assert.equal(now.items[0].action, 'skip', 'ora l\'UID esiste: il piano è cambiato');
    // Un nuovo tentativo della stessa richiesta (stesso corpo, stesso plan_hash) restituisce il job concluso.
    const again = await api.post(`${BASE}/calendars/${dest.id}/import`, {
      auth: 'admin',
      headers: { 'Idempotency-Key': key },
      body: { ics, mode: 'commit', on_conflict: 'skip', plan_hash: original.plan_hash },
    });
    assert.equal(again.status, 202, again.text);
    assert.deepEqual(again.json, { job_id: first.job_id, created: false });
    // Con il piano nuovo la richiesta è un'altra: stessa chiave → 409.
    const different = await api.post(`${BASE}/calendars/${dest.id}/import`, {
      auth: 'admin',
      headers: { 'Idempotency-Key': key },
      body: { ics, mode: 'commit', on_conflict: 'skip', plan_hash: now.plan_hash },
    });
    assert.equal(different.status, 409);
    assert.equal(different.json.code, 'IDEMPOTENCY_CONFLICT');
    const [{ n }] = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM cal_jobs WHERE kind = 'calendar_import' AND key = ${`${dest.id}:${key}`}`;
    assert.equal(Number(n), 1);
  });

  test('calendario di sistema (bookings): l\'import è negato, l\'export funziona', async () => {
    const bookings = (await calendars()).find((c) => c.role === 'bookings') as CalV2CalendarView;
    const res = await api.post(`${BASE}/calendars/${bookings.id}/import`, { auth: 'admin', body: { ics: wrap(richEvent('no@caldes.test')), mode: 'dry_run', on_conflict: 'skip' } });
    assert.equal(res.status, 403);
    assert.equal(res.json.details.reason, 'system');
    const exp = await api.get(`${BASE}/calendars/${bookings.id}/export.ics`, { auth: 'admin' });
    assert.equal(exp.status, 200);
    assert.ok(exp.text.startsWith('BEGIN:VCALENDAR'));
  });
});
