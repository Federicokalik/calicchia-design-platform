/**
 * API admin del calendario v2 contro Radicale 3.7.8 reale (F6, criterio di
 * uscita della tranche B in piccolo; contratto
 * docs/calendar-radicale/contracts/f6-modules.md §3, §8; design §8, §11).
 *
 * Un Radicale con storage multifilesystem in una directory temporanea e il
 * solo caldes-svc (stessa matrice dei test dello store). Lo store è forzato su
 * Radicale con overrideCalendarStore('radicale'); le richieste passano da
 * app.request come in produzione (JWT admin, CSRF, JSON).
 *
 * Casi: round-trip lossless per le fixture dei client (Apple, Google,
 * Thunderbird, Outlook, DAVx5): una PATCH del titolo cambia solo SUMMARY,
 * DTSTAMP e LAST-MODIFIED; PUT concorrente di un device → 412 con `current` e
 * `conflicts`, campi disgiunti → `merged`, race a livello di PUT; nuovo invio
 * della propria modifica → noop; i tre scope in modifica e in eliminazione;
 * dryRun (stesso ETag, nessun audit, anche con write_freeze); creazione 201
 * con ETag e Location, poi 409 OBJECT_EXISTS; sola lettura (prenotazione
 * attiva, iscrizione, archivio, testo illeggibile); 503 con write_freeze e con
 * Radicale giù (lettura dall'indice); MOVE dentro la PATCH; ICS grezzo;
 * audit senza testo degli eventi.
 *
 * Senza RADICALE_BIN la suite è saltata con il motivo. Date fisse nel 2027.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { bookingHref, bookingProjectionUid } from '@calicchia/calendar-core';
import type { CalV2ObjectView, CalV2Op, CalV2WriteResult } from '@calicchia/shared';
import { invalidateBackendModeCache } from '../../src/lib/calendar/backend-mode';
import { splitIcsFeed } from '../../src/lib/calendar/ics-split';
import { createSubscription } from '../../src/lib/calendar/subscriptions';
import { pullSubscriptionToIndex } from '../../src/lib/calendar/subscriptions/pull';
import { createNodeTransport, objectPath, RadicaleClient, type RadicaleTransport } from '../../src/lib/calendar/radicale/client';
import { initializeVolume } from '../../src/lib/calendar/radicale/identity';
import { stopIndexWorker } from '../../src/lib/calendar/radicale/indexer';
import { configureRadicaleRuntime, invalidateIdentityCache, syncCollection, updateWatchMode } from '../../src/lib/calendar/radicale/sync';
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
const fx = useFixtures('admin-v2-int');

const radicale = radicaleAvailability();
const P = TEST_PRINCIPAL;
const SVC_PASSWORD = 'test-only-svc-password-f6-admin-v2';
const BASE = '/api/admin/calendar/v2';
const FIXTURES = resolve(import.meta.dirname, '../../../../packages/calendar-core/test/fixtures');

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

const set = (field: string, value: unknown): CalV2Op => ({ op: 'set', field, value }) as unknown as CalV2Op;
const prop = (name: string, value: string | null): CalV2Op => ({ op: 'set_property', name, properties: value === null ? [] : [{ name, params: [], value }] });

/** Righe di VEVENT (spiegate) senza SUMMARY, DTSTAMP e LAST-MODIFIED, per confrontare prima e dopo. */
function veventLines(text: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of unfold(text).split(/\r\n|\n/)) {
    if (line === 'BEGIN:VEVENT') inside = true;
    if (inside && !/^(SUMMARY|DTSTAMP|LAST-MODIFIED)[;:]/.test(line)) out.push(line);
    if (line === 'END:VEVENT') inside = false;
  }
  return out;
}

describe('API admin v2 contro Radicale reale', { skip: radicale.skip }, () => {
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

  /** Scrive la risorsa come farebbe un device e la indicizza. */
  const deviceWrite = async (c: Calendar, href: string, text: string): Promise<void> => {
    await svc.put(objectPath(P, c.slug, href), text, { ifNoneMatch: '*' });
    await syncCollection(c.id, { reason: 'manual' });
  };

  /** Modifica da device con If-Match (il testo è quello letto), poi indicizza. */
  const deviceEdit = async (c: Calendar, href: string, edit: (text: string) => string): Promise<string> => {
    const cur = await svc.get(objectPath(P, c.slug, href));
    const res = await svc.put(objectPath(P, c.slug, href), edit(cur.body), { ifMatch: cur.etag as string });
    await syncCollection(c.id, { reason: 'manual' });
    return res.etag as string;
  };

  const read = async (id: string, query: Record<string, string> = {}): Promise<CalV2ObjectView> => {
    const res = await api.get(`${BASE}/objects/${encodeURIComponent(id)}`, { auth: 'admin', query });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get('etag'), res.json.etag, 'header ETag = etag del corpo');
    return res.json as CalV2ObjectView;
  };

  /** Corpo di PATCH con la base presa da target.tokens per ogni campo toccato. */
  const patchBody = (view: CalV2ObjectView, ops: CalV2Op[], over: Record<string, unknown> = {}): Record<string, unknown> => {
    const tokens = view.target?.tokens ?? {};
    const base: Record<string, string> = {};
    for (const op of ops) {
      const key = op.op === 'set' ? op.field : `prop:${op.name}`;
      base[key] = tokens[key] ?? '-';
    }
    return { target: { recurrence_key: view.target?.recurrence_key ?? '' }, scope: 'all', ops, base, ...over };
  };

  const patch = (id: string, etag: string, body: Record<string, unknown>) =>
    api.patch<CalV2WriteResult & { code?: string; current?: CalV2ObjectView; conflicts?: Array<{ field: string; theirs: unknown; yours: unknown }>; details?: Record<string, unknown> }>(
      `${BASE}/objects/${encodeURIComponent(id)}`,
      { auth: 'admin', headers: { 'If-Match': etag }, body },
    );

  const create = async (fields: Record<string, unknown>, over: Record<string, unknown> = {}) => {
    const res = await api.post(`${BASE}/objects`, { auth: 'admin', body: { calendar_id: cal.id, fields, ...over } });
    assert.equal(res.status, 201, res.text);
    return res.json as CalV2WriteResult;
  };

  const auditRows = (id: string) => sql<Array<{ action: string; old_data: unknown; new_data: unknown; metadata: Record<string, unknown>; changed_fields: string[] | null }>>`
    SELECT action, old_data, new_data, metadata, changed_fields FROM audit_logs
    WHERE table_name = 'cal_objects' AND record_id = ${id} ORDER BY created_at, id
  `;

  before(async () => {
    rad = await startRadicale({
      label: 'f6-admin-v2',
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

  // ── Capacità ──

  test('capacità: lettura, scrittura e anteprima con lo store Radicale', async () => {
    const res = await api.get(`${BASE}/capabilities`, { auth: 'admin' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.objects, { read: true, write: true, dry_run: true, scopes: ['this', 'this_and_future', 'all'] });
    assert.deepEqual(res.json.reasons, []);
  });

  // ── Round-trip lossless ──

  describe('una PATCH del titolo cambia solo SUMMARY, DTSTAMP e LAST-MODIFIED', () => {
    const google = splitIcsFeed(readFileSync(resolve(FIXTURES, 'google-feed.ics'), 'utf8'));
    const cases: Array<[string, () => string]> = [
      // Radicale rifiuta un componente di primo livello sconosciuto (X-WR-UNKNOWN-TOP): resta nei test del core.
      ['Apple', () => readFileSync(resolve(FIXTURES, 'apple-fidelity.ics'), 'utf8').replace(/BEGIN:X-WR-UNKNOWN-TOP[\s\S]*?END:X-WR-UNKNOWN-TOP\r?\n/, '')],
      ['Google (serie con override)', () => (google.objects.find((o) => o.uid === 'ny-standup@google.com') as { raw: string }).raw],
      ['Thunderbird', () => readFileSync(resolve(FIXTURES, 'thunderbird-mozilla-tz.ics'), 'utf8')],
      ['Outlook', () => readFileSync(resolve(FIXTURES, 'outlook-windows-tz.ics'), 'utf8')],
      ['DAVx5', () => readFileSync(resolve(FIXTURES, 'davx5-android.ics'), 'utf8')],
    ];
    for (const [label, source] of cases) {
      test(label, async () => {
        const href = `fixture-${randomUUID()}.ics`;
        await deviceWrite(cal, href, source());
        const stored = await textOf(cal, href);
        assert.ok(stored);
        const uid = /^UID:(.*)$/m.exec(unfold(stored.body))?.[1]?.trim() as string;
        const view = await read(uid);
        assert.equal(view.etag, stored.etag);
        assert.equal(view.source, 'radicale');
        const title = `Titolo v2 ${label}`;
        const res = await patch(view.id, stored.etag, patchBody(view, [set('summary', title)]));
        assert.equal(res.status, 200, res.text);
        assert.equal(res.json.noop, false);
        assert.equal(res.json.merged, false);
        assert.deepEqual(res.json.changed, ['summary']);
        assert.equal(res.json.sequence_bumped, false);
        assert.equal(res.headers.get('etag'), res.json.etag);
        assert.notEqual(res.json.etag, stored.etag);
        assert.equal(res.json.object?.master?.fields.summary, title);
        const after = await textOf(cal, href);
        assert.ok(after);
        assert.equal(after.etag, res.json.etag);
        assert.deepEqual(veventLines(after.body), veventLines(stored.body), 'VALARM, ATTENDEE, X-* e il resto restano identici');
        assert.ok(unfold(after.body).split(/\r\n|\n/).some((l) => /^SUMMARY[;:]/.test(l) && l.endsWith(`:${title}`)), 'SUMMARY aggiornato');
        const dtstamp = /^DTSTAMP:(.*)$/m.exec(unfold(after.body))?.[1];
        assert.notEqual(dtstamp, /^DTSTAMP:(.*)$/m.exec(unfold(stored.body))?.[1], 'DTSTAMP aggiornato');
      });
    }
  });

  // ── Letture ──

  test('GET: vista da Radicale, ICS grezzo e target per original_start', async () => {
    const created = await create({
      summary: fx.name('Corso'), start: rome('2027-05-03', 9), end: rome('2027-05-03', 10),
      rrule: 'FREQ=DAILY;COUNT=5', location: 'Aula', alarms: [{ name: 'VALARM', properties: [{ name: 'ACTION', params: [], value: 'DISPLAY' }, { name: 'TRIGGER', params: [], value: '-PT10M' }, { name: 'DESCRIPTION', params: [], value: 'Tra poco' }], components: [] }],
    });
    const id = created.object?.id as string;
    const view = await read(id);
    assert.equal(view.recurring, true);
    assert.equal(view.target?.recurrence_key, '');
    assert.equal(view.master?.alarms[0].action, 'DISPLAY');
    assert.equal(view.preview?.rrule_summary, 'Ogni giorno, per 5 volte');

    const byStart = await read(id, { original_start: '2027-05-05T07:00:00.000Z' });
    assert.equal(byStart.target?.recurrence_key, '20270505T070000Z');
    assert.equal(byStart.target?.is_override, false);
    assert.equal(byStart.target?.fields.start.type === 'date-time' && byStart.target.fields.start.hour, 9);

    const gone = await api.get(`${BASE}/objects/${id}`, { auth: 'admin', query: { original_start: '2027-05-20T07:00:00.000Z' } });
    assert.equal(gone.status, 409);
    assert.equal(gone.json.code, 'RECURRENCE_TARGET_GONE');
    assert.equal((await api.get(`${BASE}/objects/${randomUUID()}`, { auth: 'admin' })).status, 404);

    const ics = await api.get(`${BASE}/objects/${id}/ics`, { auth: 'admin' });
    assert.equal(ics.status, 200);
    assert.match(ics.contentType ?? '', /^text\/calendar; charset=utf-8/);
    assert.equal(ics.headers.get('etag'), view.etag);
    assert.match(ics.headers.get('content-disposition') ?? '', /^inline; filename="[A-Za-z0-9._@-]+\.ics"$/);
    assert.equal(ics.text, (await textOf(cal, `${view.uid}.ics`))?.body);
    assert.equal(view.ics, ics.text);
  });

  // ── Creazione ──

  test('POST: 201 con ETag e Location, provenienza admin, SEQUENCE 0; secondo invio → 409 OBJECT_EXISTS', async () => {
    const uid = `nuovo-${randomUUID()}`;
    const res = await api.post(`${BASE}/objects`, {
      auth: 'admin',
      body: {
        calendar_id: cal.id, uid,
        fields: { summary: fx.name('Creato'), start: rome('2027-06-01', 15), end: rome('2027-06-01', 16), categories: ['uno'] },
        properties: { 'X-MIO': [{ name: 'X-MIO', params: [], value: 'valore' }] },
      },
    });
    assert.equal(res.status, 201, res.text);
    const view = res.json.object as CalV2ObjectView;
    assert.equal(res.headers.get('etag'), res.json.etag);
    assert.equal(res.headers.get('location'), `${BASE}/objects/${view.id}`);
    assert.equal(view.uid, uid);
    assert.equal(view.provenance.source, 'admin');
    assert.equal(view.master?.fields.transp, null, 'TRANSP assente per default (decisione 6)');
    assert.equal(view.master?.readonly.sequence, 0);
    const text = unfold((await textOf(cal, `${uid}.ics`))?.body ?? '');
    assert.match(text, /X-CALDES-SOURCE:admin/);
    assert.match(text, /SEQUENCE:0/);
    assert.match(text, /X-MIO:valore/);
    assert.match(text, /STATUS:CONFIRMED/);

    const again = await api.post(`${BASE}/objects`, { auth: 'admin', body: { calendar_id: cal.id, uid, fields: { summary: 'Doppione', start: rome('2027-06-01', 15), end: rome('2027-06-01', 16) } } });
    assert.equal(again.status, 409);
    assert.equal(again.json.code, 'OBJECT_EXISTS');
    assert.equal(again.json.details.object_id, view.id);
    assert.match(unfold((await textOf(cal, `${uid}.ics`))?.body ?? ''), /SUMMARY:.*Creato/, 'l\'oggetto esistente non è stato toccato');

    const [audit] = await auditRows(view.id);
    assert.equal(audit.action, 'INSERT');
    assert.equal(audit.metadata.operation, 'v2.create');
  });

  test('POST: all-day senza fine = un giorno; timed senza fine né durata → 400 con issues; calendario inesistente → 404', async () => {
    const allDay = await create({ summary: fx.name('Giornata'), start: { type: 'date', year: 2027, month: 6, day: 10 } });
    assert.deepEqual(allDay.object?.master?.fields.end, { type: 'date', year: 2027, month: 6, day: 11 });
    assert.equal(allDay.object?.master?.all_day, true);
    const noEnd = await api.post(`${BASE}/objects`, { auth: 'admin', body: { calendar_id: cal.id, fields: { summary: 'x', start: rome('2027-06-10', 9) } } });
    assert.equal(noEnd.status, 400);
    assert.equal(noEnd.json.code, 'VALIDATION_FAILED');
    assert.ok(noEnd.json.details.issues.length > 0);
    const invalid = await api.post(`${BASE}/objects`, { auth: 'admin', body: { calendar_id: cal.id, fields: { summary: 'x', start: rome('2027-06-10', 9), end: rome('2027-06-10', 8) } } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.code, 'VALIDATION_FAILED');
    assert.ok(invalid.json.details.issues.length > 0);
    const dry = await api.post(`${BASE}/objects`, { auth: 'admin', body: { calendar_id: cal.id, dryRun: true, fields: { summary: 'x', start: rome('2027-06-10', 9), end: rome('2027-06-10', 8) } } });
    assert.equal(dry.status, 200, 'in dryRun la validazione fallita dà valid: false, non 400');
    assert.equal(dry.json.valid, false);
    assert.ok(dry.json.issues.length > 0);
    const missing = await api.post(`${BASE}/objects`, { auth: 'admin', body: { calendar_id: randomUUID(), fields: { start: rome('2027-06-10', 9), end: rome('2027-06-10', 10) } } });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.code, 'NOT_FOUND');
  });

  // ── 412, fusione e noop ──

  test('PUT concorrente di un device: stesso campo → 412 con current e conflicts; campi disgiunti → merged; nuovo invio → noop', async () => {
    const created = await create({ summary: 'Base', start: rome('2027-07-01', 9), end: rome('2027-07-01', 10), location: 'Sala 1' });
    const id = created.object?.id as string;
    const href = `${created.object?.uid}.ics`;
    const viewV1 = await read(id);
    const etag1 = viewV1.etag as string;

    // Il device cambia il titolo dopo la lettura.
    const etag2 = await deviceEdit(cal, href, (t) => t.replace(/SUMMARY:Base/, 'SUMMARY:Dal device'));
    const conflict = await patch(id, etag1, patchBody(viewV1, [set('summary', 'Dall\'admin')]));
    assert.equal(conflict.status, 412, conflict.text);
    assert.equal(conflict.json.code, 'PRECONDITION_FAILED');
    assert.deepEqual(conflict.json.conflicts, [{ field: 'summary', theirs: 'Dal device', yours: 'Dall\'admin' }]);
    assert.equal(conflict.json.current?.etag, etag2);
    assert.equal(conflict.json.current?.target?.fields.summary, 'Dal device');
    assert.match(unfold((await textOf(cal, href))?.body ?? ''), /SUMMARY:Dal device/, 'la modifica del device non è stata sovrascritta');

    // Campi disgiunti: il device cambia la località, l'admin il titolo.
    const viewV2 = await read(id);
    const etag3 = await deviceEdit(cal, href, (t) => t.replace(/LOCATION:Sala 1/, 'LOCATION:Sala del device'));
    const merged = await patch(id, viewV2.etag as string, patchBody(viewV2, [set('summary', 'Fuso')]));
    assert.equal(merged.status, 200, merged.text);
    assert.equal(merged.json.merged, true);
    assert.equal(merged.json.object?.master?.fields.summary, 'Fuso');
    assert.equal(merged.json.object?.master?.fields.location, 'Sala del device');
    assert.notEqual(merged.json.etag, etag3);

    // Nuovo invio della stessa modifica con l'ETag vecchio: il server ha già il valore → noop.
    const resend = await patch(id, viewV2.etag as string, patchBody(viewV2, [set('summary', 'Fuso')]));
    assert.equal(resend.status, 200, resend.text);
    assert.equal(resend.json.noop, true);
    assert.equal(resend.json.merged, false);
    assert.equal(resend.json.etag, merged.json.etag, 'nessuna scrittura: ETag corrente');
    assert.deepEqual(resend.json.changed, []);
    // Stesso ETag, stesso valore: noop anche senza differenze di versione.
    const same = await patch(id, merged.json.etag as string, patchBody(merged.json.object as CalV2ObjectView, [set('summary', 'Fuso')]));
    assert.equal(same.json.noop, true);
  });

  test('race a livello di PUT: il device scrive fra il GET e la PUT → nuovo tentativo e fusione', async () => {
    const created = await create({ summary: 'Corsa', start: rome('2027-07-02', 9), end: rome('2027-07-02', 10) });
    const id = created.object?.id as string;
    const href = `${created.object?.uid}.ics`;
    const view = await read(id);
    const node = createNodeTransport({ maxSockets: 4 });
    let hook: (() => Promise<void>) | null = null;
    const transport: RadicaleTransport = async (req) => {
      if (req.method === 'PUT' && hook) {
        const h = hook;
        hook = null;
        await h();
      }
      return node(req);
    };
    const racing = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0, transport });
    configureRadicaleRuntime({ client: racing });
    try {
      hook = async () => {
        const cur = await svc.get(objectPath(P, cal.slug, href));
        await svc.put(objectPath(P, cal.slug, href), cur.body.replace('END:VEVENT', 'LOCATION:Aggiunta dal device\r\nEND:VEVENT'), { ifMatch: cur.etag as string });
      };
      const res = await patch(id, view.etag as string, patchBody(view, [set('summary', 'Corsa rinominata')]));
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.merged, true, 'la PUT con l\'ETag vecchio ha avuto 412 e la modifica è stata riapplicata');
      assert.equal(res.json.object?.master?.fields.location, 'Aggiunta dal device');
      assert.equal(res.json.object?.master?.fields.summary, 'Corsa rinominata');
    } finally {
      configureRadicaleRuntime({ client: svc });
      racing.close();
      node.close();
    }
  });

  // ── Scope in modifica ──

  test('i tre scope in modifica: solo questa, questa e le successive, tutta la serie', async () => {
    const created = await create({
      summary: fx.name('Studio'), start: rome('2027-03-01', 9), end: rome('2027-03-01', 10),
      rrule: 'FREQ=WEEKLY;COUNT=6;BYDAY=MO', location: 'Aula 1',
    });
    const id = created.object?.id as string;
    const uid = created.object?.uid as string;
    const href = `${uid}.ics`;

    // Solo questa: override dell'8/3 (lunedì 09:00 CET = 08:00Z).
    let view = await read(id, { recurrence_key: '20270308T080000Z' });
    assert.equal(view.target?.is_override, false);
    let res = await patch(id, view.etag as string, patchBody(view, [set('summary', 'Solo questa')], { scope: 'this' }));
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.changed, ['summary']);
    assert.equal(res.json.object?.target?.is_override, true);
    assert.ok(res.json.object?.target?.component_id, 'l\'override ha il suo id');
    assert.equal(res.json.object?.master?.fields.summary, view.master?.fields.summary);
    assert.match(unfold((await textOf(cal, href))?.body ?? ''), /RECURRENCE-ID;TZID=Europe\/Rome:20270308T090000/);

    // Un campo di serie con scope this → SCOPE_INVALID.
    view = await read(id, { recurrence_key: '20270315T080000Z' });
    const bad = await patch(id, view.etag as string, patchBody(view, [set('rrule', 'FREQ=DAILY')], { scope: 'this' }));
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'SCOPE_INVALID');

    // Questa e le successive: dal 22/3 una nuova serie con UID nuovo.
    view = await read(id, { recurrence_key: '20270322T080000Z' });
    res = await patch(id, view.etag as string, patchBody(view, [set('summary', 'Nuova serie'), set('location', 'Aula 7')], { scope: 'this_and_future' }));
    assert.equal(res.status, 200, res.text);
    assert.ok(res.json.tail, 'la coda è nel risultato');
    assert.notEqual(res.json.tail?.uid, uid);
    assert.equal(res.json.tail?.master?.fields.summary, 'Nuova serie');
    assert.equal(res.json.tail?.master?.fields.location, 'Aula 7');
    assert.equal(res.json.whole_series, undefined);
    const head = unfold((await textOf(cal, href))?.body ?? '');
    assert.match(head, /RRULE:FREQ=WEEKLY;COUNT=3;BYDAY=MO/);
    const tailText = unfold((await textOf(cal, `${res.json.tail?.uid}.ics`))?.body ?? '');
    assert.match(tailText, new RegExp(`RELATED-TO;RELTYPE=SIBLING:${uid}`));
    assert.match(tailText, /DTSTART;TZID=Europe\/Rome:20270322T090000/);
    const tailView = await read(res.json.tail?.id as string);
    assert.equal(tailView.uid, res.json.tail?.uid);
    const audits = await auditRows(id);
    assert.ok(audits.some((a) => a.metadata.operation === 'v2.patch' && a.metadata.scope === 'this_and_future'));

    // Questa e le successive sulla prima istanza = tutta la serie.
    view = await read(id, { recurrence_key: '20270301T080000Z' });
    res = await patch(id, view.etag as string, patchBody(view, [set('description', 'Per tutta la serie')], { scope: 'this_and_future' }));
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.whole_series, true);
    assert.equal(res.json.tail, undefined);
    assert.match(unfold((await textOf(cal, href))?.body ?? ''), /DESCRIPTION:Per tutta la serie/);

    // Tutta la serie da un'istanza: lo spostamento dell'orario vale per la serie intera (Δ +1 ora).
    view = await read(id, { recurrence_key: '20270301T080000Z' });
    res = await patch(id, view.etag as string, patchBody(view, [set('start', rome('2027-03-01', 10)), set('end', rome('2027-03-01', 11)), set('summary', 'Tutta la serie')], { scope: 'all' }));
    assert.equal(res.status, 200, res.text);
    assert.deepEqual([...res.json.changed].sort(), ['end', 'start', 'summary']);
    assert.equal(res.json.sequence_bumped, true);
    const all = unfold((await textOf(cal, href))?.body ?? '');
    assert.match(all, /DTSTART;TZID=Europe\/Rome:20270301T100000/);
    assert.match(all, /RECURRENCE-ID;TZID=Europe\/Rome:20270308T100000/, 'il RECURRENCE-ID dell\'override segue lo spostamento');
    assert.match(all, /SUMMARY:Solo questa/, 'l\'override personalizzato mantiene il suo titolo');
    assert.match(all, /SUMMARY:Tutta la serie/);

    // Uno scope non ammesso per un evento singolo.
    const single = await create({ summary: 'Singolo', start: rome('2027-08-02', 9), end: rome('2027-08-02', 10) });
    const sv = await read(single.object?.id as string);
    const invalid = await patch(sv.id, sv.etag as string, patchBody(sv, [set('summary', 'x')], { scope: 'this' }));
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.code, 'SCOPE_INVALID');
  });

  test('questa e le successive con ETag vecchio: campi disgiunti → merged, stesso campo → 412 prima di ogni scrittura della saga', async () => {
    const created = await create({
      summary: 'Saga', start: rome('2028-03-06', 9), end: rome('2028-03-06', 10), rrule: 'FREQ=WEEKLY;COUNT=6;BYDAY=MO', location: 'Sala 1',
    });
    const id = created.object?.id as string;
    const href = `${created.object?.uid}.ics`;
    const key = '20280320T080000Z';
    const view = await read(id, { recurrence_key: key });
    const hrefsBefore = async (): Promise<number> => {
      const rows = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM cal_objects WHERE calendar_id = ${cal.id}::uuid`;
      return Number(rows[0].n);
    };

    // Il device cambia il titolo dopo la lettura: stesso campo dell'admin → 412, nessuna nuova serie.
    await deviceEdit(cal, href, (t) => t.replace(/SUMMARY:Saga/, 'SUMMARY:Dal device'));
    const objectsBefore = await hrefsBefore();
    const conflict = await patch(id, view.etag as string, patchBody(view, [set('summary', 'Dall\'admin')], { scope: 'this_and_future' }));
    assert.equal(conflict.status, 412, conflict.text);
    assert.equal(conflict.json.code, 'PRECONDITION_FAILED');
    assert.deepEqual(conflict.json.conflicts?.map((c) => c.field), ['summary']);
    assert.match(unfold((await textOf(cal, href))?.body ?? ''), /RRULE:FREQ=WEEKLY;COUNT=6;BYDAY=MO/, 'la serie non è stata troncata');
    await syncCollection(cal.id, { reason: 'manual' });
    assert.equal(await hrefsBefore(), objectsBefore, 'nessuna nuova serie');

    // Il device cambia la località: campi disgiunti dal titolo → la modifica si fonde.
    const fresh = await read(id, { recurrence_key: key });
    await deviceEdit(cal, href, (t) => t.replace(/LOCATION:Sala 1/, 'LOCATION:Sala del device'));
    const merged = await patch(id, fresh.etag as string, patchBody(fresh, [set('summary', 'Nuova coda')], { scope: 'this_and_future' }));
    assert.equal(merged.status, 200, merged.text);
    assert.equal(merged.json.merged, true);
    assert.equal(merged.json.tail?.master?.fields.summary, 'Nuova coda');
    assert.equal(merged.json.tail?.master?.fields.location, 'Sala del device', 'la coda nasce dal testo corrente');
    assert.match(unfold((await textOf(cal, href))?.body ?? ''), /COUNT=2/, 'la vecchia serie finisce prima del 20/3');
  });

  // ── dryRun ──

  test('dryRun: stesso ETag, nessuna scrittura né audit, anche con le scritture sospese', async () => {
    const created = await create({ summary: 'Anteprima', start: rome('2027-09-01', 9), end: rome('2027-09-01', 10), rrule: 'FREQ=DAILY;COUNT=3' });
    const id = created.object?.id as string;
    const href = `${created.object?.uid}.ics`;
    const view = await read(id);
    const before = await textOf(cal, href);
    const auditsBefore = (await auditRows(id)).length;

    const run = async () => {
      const res = await patch(id, view.etag as string, patchBody(view, [set('rrule', 'FREQ=DAILY;COUNT=5'), set('summary', 'Anteprima nuova')], { dryRun: true }));
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.dry_run, true);
      assert.equal(res.json.valid, true);
      assert.equal(res.json.object?.etag, view.etag, 'ETag invariato');
      assert.equal(res.json.object?.preview?.rrule_summary, 'Ogni giorno, per 5 volte');
      assert.equal(res.json.object?.master?.fields.summary, 'Anteprima nuova');
      assert.deepEqual([...res.json.changed].sort(), ['rrule', 'summary']);
      assert.deepEqual(res.json.orphaned_overrides, []);
      return res;
    };
    await run();
    // Non valido: valid=false e issues, non 400.
    const invalid = await patch(id, view.etag as string, patchBody(view, [set('rrule', 'FREQ=DAILY;UNTIL=20200101T000000Z')], { dryRun: true }));
    assert.equal(invalid.status, 200, invalid.text);
    assert.equal(invalid.json.valid, false);
    assert.ok(invalid.json.issues.some((i) => i.severity === 'error'));

    // Con write_freeze le scritture sono sospese ma l'anteprima funziona.
    await sql`UPDATE calendar_backend_state SET mode = 'radicale', write_freeze = true WHERE id`;
    invalidateBackendModeCache();
    try {
      await run();
      const frozen = await patch(id, view.etag as string, patchBody(view, [set('summary', 'No')]));
      assert.equal(frozen.status, 503);
      assert.equal(frozen.json.code, 'CALENDAR_UNAVAILABLE');
      const del = await api.delete(`${BASE}/objects/${id}`, { auth: 'admin', headers: { 'If-Match': view.etag as string }, query: { scope: 'all', dry_run: '1' } });
      assert.equal(del.status, 200, del.text);
      assert.equal(del.json.dry_run, true);
      assert.equal(del.json.object, null);
      const dryCreate = await api.post(`${BASE}/objects`, { auth: 'admin', body: { calendar_id: cal.id, dryRun: true, fields: { summary: 'Prova', start: rome('2027-09-02', 9), end: rome('2027-09-02', 10) } } });
      assert.equal(dryCreate.status, 200, dryCreate.text);
      assert.equal(dryCreate.json.object.id, '');
      assert.equal(dryCreate.json.etag, null);
      assert.equal(dryCreate.json.dry_run, true);
      const caps = await api.get(`${BASE}/capabilities`, { auth: 'admin' });
      assert.deepEqual([caps.json.objects.read, caps.json.objects.write, caps.json.objects.dry_run], [true, false, true]);
    } finally {
      await sql`UPDATE calendar_backend_state SET mode = 'postgres', write_freeze = false WHERE id`;
      invalidateBackendModeCache();
    }

    const after = await textOf(cal, href);
    assert.equal(after?.etag, before?.etag, 'nessuna PUT');
    assert.equal(after?.body, before?.body);
    assert.equal((await auditRows(id)).length, auditsBefore, 'nessun audit');
  });

  // ── Scope in eliminazione ──

  test('i tre scope in eliminazione: questa, questa e le successive, tutta la serie', async () => {
    const created = await create({
      summary: fx.name('Da eliminare'), start: rome('2027-03-01', 9), end: rome('2027-03-01', 10), rrule: 'FREQ=WEEKLY;COUNT=6;BYDAY=MO',
    });
    const id = created.object?.id as string;
    const href = `${created.object?.uid}.ics`;
    const del = (etag: string, query: Record<string, string>) => api.delete<CalV2WriteResult & { code?: string }>(`${BASE}/objects/${id}`, { auth: 'admin', headers: { 'If-Match': etag }, query });

    let view = await read(id);
    // Evento senza serie o master con scope this → SCOPE_INVALID.
    const invalid = await del(view.etag as string, { scope: 'this' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.code, 'SCOPE_INVALID');

    let res = await del(view.etag as string, { scope: 'this', recurrence_key: '20270308T080000Z' });
    assert.equal(res.status, 200, res.text);
    assert.match(unfold((await textOf(cal, href))?.body ?? ''), /EXDATE;TZID=Europe\/Rome:20270308T090000/);
    assert.equal(res.headers.get('etag'), res.json.etag);
    assert.ok(res.json.object, 'la risorsa resta');

    view = await read(id);
    res = await del(view.etag as string, { scope: 'this_and_future', recurrence_key: '20270322T080000Z' });
    assert.equal(res.status, 200, res.text);
    assert.match(unfold((await textOf(cal, href))?.body ?? ''), /RRULE:FREQ=WEEKLY;COUNT=3;BYDAY=MO/);

    // L'istanza non c'è più → 409.
    view = await read(id);
    const gone = await del(view.etag as string, { scope: 'this', recurrence_key: '20270322T080000Z' });
    assert.equal(gone.status, 409);
    assert.equal(gone.json.code, 'RECURRENCE_TARGET_GONE');

    // ETag vecchio → 412 senza campi in conflitto.
    const stale = await del(`"${randomUUID()}"`, { scope: 'all' });
    assert.equal(stale.status, 412);
    assert.deepEqual((stale.json as unknown as { conflicts: unknown[] }).conflicts, []);
    assert.ok((stale.json as unknown as { current: CalV2ObjectView }).current.id);

    res = await del(view.etag as string, { scope: 'all' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.object, null);
    assert.equal(await textOf(cal, href), null, 'risorsa eliminata');
    assert.equal((await api.get(`${BASE}/objects/${id}`, { auth: 'admin' })).status, 404);
    const audits = await auditRows(id);
    assert.deepEqual(audits.map((a) => `${a.action}:${a.metadata.operation}:${a.metadata.scope}`), [
      `INSERT:v2.create:undefined`,
      'UPDATE:v2.delete:this',
      'UPDATE:v2.delete:this_and_future',
      'DELETE:v2.delete:all',
    ]);
  });

  test('DELETE di un id di override senza parametri: 400 sullo scope e serie intatta; con scope=this esclude solo quell\'occorrenza', async () => {
    const created = await create({
      summary: fx.name('Serie con override'), start: rome('2027-05-03', 9), end: rome('2027-05-03', 10), rrule: 'FREQ=WEEKLY;COUNT=4;BYDAY=MO',
    });
    const id = created.object?.id as string;
    const href = `${created.object?.uid}.ics`;
    const del = (ref: string, etag: string, query: Record<string, string> = {}) =>
      api.delete<CalV2WriteResult & { code?: string; details?: { issues?: Array<{ property?: string }> } }>(`${BASE}/objects/${ref}`, { auth: 'admin', headers: { 'If-Match': etag }, query });

    // Override del 10/5 (lunedì 09:00 CEST = 07:00Z).
    const occurrence = await read(id, { recurrence_key: '20270510T070000Z' });
    const patched = await patch(id, occurrence.etag as string, patchBody(occurrence, [set('summary', 'Solo questa')], { scope: 'this' }));
    assert.equal(patched.status, 200, patched.text);
    const overrideId = patched.json.object?.target?.component_id as string;
    assert.ok(overrideId && overrideId !== id, 'l\'override ha il suo id');
    const before = (await textOf(cal, href))?.body ?? '';

    // L'id dell'override senza recurrence_key né scope ha come target quell'override: lo scope va scelto.
    const refused = await del(overrideId, patched.json.etag as string);
    assert.equal(refused.status, 400, refused.text);
    assert.equal(refused.json.code, 'VALIDATION_FAILED');
    assert.equal(refused.json.details?.issues?.[0]?.property, 'scope');
    assert.equal((await textOf(cal, href))?.body, before, 'la serie è intatta');
    assert.equal((await api.get(`${BASE}/objects/${id}`, { auth: 'admin' })).status, 200, 'la serie esiste ancora');

    // Stessa regola con recurrence_key esplicita su un'istanza: senza scope non si elimina nulla.
    const noScope = await del(id, (await read(id)).etag as string, { recurrence_key: '20270517T070000Z' });
    assert.equal(noScope.status, 400, noScope.text);
    assert.equal(noScope.json.details?.issues?.[0]?.property, 'scope');
    assert.equal((await textOf(cal, href))?.body, before, 'la serie è intatta');

    // Con scope=this esclude solo quell'occorrenza (EXDATE; l'override sparisce), il resto della serie resta.
    const ok = await del(overrideId, (await read(id)).etag as string, { scope: 'this' });
    assert.equal(ok.status, 200, ok.text);
    assert.ok(ok.json.object, 'la risorsa resta');
    const after = unfold((await textOf(cal, href))?.body ?? '');
    assert.match(after, /EXDATE;TZID=Europe\/Rome:20270510T090000/);
    assert.doesNotMatch(after, /RECURRENCE-ID/);
    assert.match(after, /RRULE:FREQ=WEEKLY;COUNT=4;BYDAY=MO/);
  });

  test('prima istanza con questa e le successive: elimina la risorsa', async () => {
    const created = await create({ summary: fx.name('Prima'), start: rome('2027-04-05', 9), end: rome('2027-04-05', 10), rrule: 'FREQ=DAILY;COUNT=3' });
    const view = await read(created.object?.id as string);
    const res = await api.delete(`${BASE}/objects/${view.id}`, { auth: 'admin', headers: { 'If-Match': view.etag as string }, query: { scope: 'this_and_future', recurrence_key: '20270405T070000Z' } });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.object, null);
    assert.equal(await textOf(cal, `${view.uid}.ics`), null);
  });

  // ── Sola lettura ──

  test('prenotazione attiva: DELETE → 403 booking_active; la PATCH resta ammessa con la nota booking_projection', async () => {
    const eventType = await fx.eventType({ key: 'tipo-v2' });
    const { booking } = await fx.booking({ eventType, start: '2027-10-04T08:00:00Z', project: false });
    const bookings = (await sql<Array<{ id: string; collection_name: string }>>`SELECT id, collection_name FROM calendars WHERE role = 'bookings' AND lifecycle = 'active' LIMIT 1`)[0];
    const href = bookingHref(booking.uid);
    const text = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//IT', 'BEGIN:VEVENT',
      `UID:${bookingProjectionUid(booking.uid)}`, 'DTSTAMP:20271001T080000Z', 'DTSTART:20271004T080000Z', 'DTEND:20271004T083000Z', 'SUMMARY:Consulenza', 'END:VEVENT', 'END:VCALENDAR', '',
    ].join('\r\n');
    await svc.put(objectPath(P, bookings.collection_name, href), text, { ifNoneMatch: '*' });
    await syncCollection(bookings.id, { reason: 'manual' });
    const view = await read(bookingProjectionUid(booking.uid));
    assert.equal(view.delete_blocked_reason, 'booking_active');
    assert.ok(view.notices.includes('booking_projection'));
    assert.equal(view.provenance.source, 'booking');
    const del = await api.delete(`${BASE}/objects/${view.id}`, { auth: 'admin', headers: { 'If-Match': view.etag as string }, query: { scope: 'all' } });
    assert.equal(del.status, 403);
    assert.equal(del.json.code, 'READ_ONLY');
    assert.equal(del.json.details.reason, 'booking_active');
    assert.ok((await svc.get(objectPath(P, bookings.collection_name, href))).body, 'proiezione intatta');
    const res = await patch(view.id, view.etag as string, patchBody(view, [set('summary', 'Consulenza rinominata')]));
    assert.equal(res.status, 200, res.text);
  });

  test('iscrizione e archivio: sola lettura con il motivo; testo illeggibile letto dall\'indice', async () => {
    // Iscrizione: la risorsa del sidecar si legge dall'indice.
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Feed//IT', 'BEGIN:VEVENT', 'UID:feed-evento-1@test', 'DTSTAMP:20271001T080000Z', 'DTSTART:20271105T090000Z', 'DTEND:20271105T100000Z', 'SUMMARY:Dal feed', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
    const sub = await createSubscription({ calendar_id: cal.id, name: fx.name('iscrizione'), ics_url: `https://feeds.caldes.test/${fx.name('feed')}.ics` });
    fx.track('subscriptionIds', sub.id);
    const pulled = await pullSubscriptionToIndex(sub.id, { body: ics, force: true, updateSubscriptionRow: true });
    assert.ok(pulled.status !== 'rejected' && pulled.status !== 'skipped', JSON.stringify(pulled));
    const subView = await read('feed-evento-1@test');
    assert.equal(subView.readonly_reason, 'subscription');
    assert.equal(subView.source, 'index');
    assert.ok(subView.notices.includes('index_fallback'));
    const subPatch = await patch(subView.id, subView.etag ?? '"x"', patchBody(subView, [set('summary', 'No')]));
    assert.equal(subPatch.status, 403, subPatch.text);
    assert.equal(subPatch.json.details?.reason, 'subscription');
    const subDelete = await api.delete(`${BASE}/objects/${subView.id}`, { auth: 'admin', headers: { 'If-Match': subView.etag ?? '"x"' }, query: { scope: 'all' } });
    assert.equal(subDelete.status, 403);
    assert.equal(subDelete.json.details.reason, 'subscription');
    const [sidecar] = await sql<Array<{ calendar_id: string }>>`SELECT calendar_id FROM cal_objects WHERE id = ${subView.id}::uuid`;
    const subCreate = await api.post(`${BASE}/objects`, { auth: 'admin', body: { calendar_id: sidecar.calendar_id, fields: { start: rome('2027-11-05', 9), end: rome('2027-11-05', 10) } } });
    assert.equal(subCreate.status, 403, 'nessun evento si crea nel calendario di un\'iscrizione');

    // Archivio della Fase 0.
    const created = await create({ summary: 'In archivio', start: rome('2027-11-06', 9), end: rome('2027-11-06', 10) });
    const view = await read(created.object?.id as string);
    await sql`UPDATE calendars SET origin = 'migration' WHERE id = ${cal.id}::uuid`;
    try {
      assert.equal((await read(view.id)).readonly_reason, 'archive');
      const res = await patch(view.id, view.etag as string, patchBody(view, [set('summary', 'No')]));
      assert.equal(res.status, 403);
      assert.equal(res.json.details?.reason, 'archive');
      const del = await api.delete(`${BASE}/objects/${view.id}`, { auth: 'admin', headers: { 'If-Match': view.etag as string }, query: { scope: 'all' } });
      assert.equal(del.status, 403);
      const post = await api.post(`${BASE}/objects`, { auth: 'admin', body: { calendar_id: cal.id, fields: { start: rome('2027-11-06', 9), end: rome('2027-11-06', 10) } } });
      assert.equal(post.status, 403);
    } finally {
      await sql`UPDATE calendars SET origin = 'admin' WHERE id = ${cal.id}::uuid`;
    }

    // Testo illeggibile (solo nell'indice, con Radicale giù): sola lettura e testo grezzo.
    const down = new RadicaleClient({ baseUrl: 'http://127.0.0.1:1', password: SVC_PASSWORD, retries: 0, timeoutMs: 1_000 });
    configureRadicaleRuntime({ client: down, identitySource: 'file' });
    await sql`UPDATE cal_objects SET raw_ics = 'NON È UN ICS' WHERE id = ${view.id}::uuid`;
    try {
      const unreadable = await read(view.id);
      assert.equal(unreadable.readonly_reason, 'unreadable');
      assert.equal(unreadable.master, null);
      assert.equal(unreadable.target, null);
      assert.equal(unreadable.ics, 'NON È UN ICS');
      assert.ok(unreadable.parse_error);
      const res = await patch(view.id, view.etag as string, patchBody(view, [set('summary', 'No')]));
      assert.equal(res.status, 503, 'con Radicale giù la scrittura è 503');
    } finally {
      configureRadicaleRuntime({ client: svc, identitySource: 'auto' });
      down.close();
      await syncCollection(cal.id, { reason: 'manual' });
    }
  });

  test('oggetto in quarantena (oltre i limiti strutturali): sola lettura "unreadable", salute e DELETE all ammessa', async () => {
    const uid = `rotto-${randomUUID()}`;
    const href = `${uid}.ics`;
    // Per Radicale è un evento valido; calendar-core lo rifiuta (oltre 2000 proprietà per componente) e l'indice lo mette in quarantena.
    const junk = Array.from({ length: 2100 }, () => 'X-JUNK:1');
    const text = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//IT', 'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20271001T080000Z', 'DTSTART:20280201T080000Z', 'DTEND:20280201T090000Z', 'SUMMARY:Enorme', ...junk, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
    await deviceWrite(cal, href, text);
    const view = await read(uid);
    assert.equal(view.readonly_reason, 'unreadable');
    assert.equal(view.health, 'quarantined');
    assert.equal(view.master, null);
    assert.equal(view.target, null);
    assert.ok(view.parse_error);
    assert.equal(view.ics, (await textOf(cal, href))?.body, 'testo così com\'è in Radicale');
    const edit = await patch(view.id, view.etag as string, patchBody({ ...view, target: null }, [set('summary', 'No')]));
    assert.equal(edit.status, 403, edit.text);
    assert.equal(edit.json.details?.reason, 'unreadable');
    const instance = await api.delete(`${BASE}/objects/${view.id}`, { auth: 'admin', headers: { 'If-Match': view.etag as string }, query: { scope: 'this', recurrence_key: '20280201T080000Z' } });
    assert.equal(instance.status, 403);
    const del = await api.delete(`${BASE}/objects/${view.id}`, { auth: 'admin', headers: { 'If-Match': view.etag as string }, query: { scope: 'all' } });
    assert.equal(del.status, 200, del.text);
    assert.equal(await textOf(cal, href), null);
  });

  // ── Radicale giù, write_freeze, identità ──

  test('write_freeze e Radicale giù → 503 senza scritture; GET dall\'indice con la nota index_fallback', async () => {
    const created = await create({ summary: 'Guasto', start: rome('2027-12-01', 9), end: rome('2027-12-01', 10) });
    const id = created.object?.id as string;
    const href = `${created.object?.uid}.ics`;
    const view = await read(id);
    const stored = await textOf(cal, href);

    await sql`UPDATE calendar_backend_state SET mode = 'radicale', write_freeze = true WHERE id`;
    invalidateBackendModeCache();
    try {
      const frozen = await patch(id, view.etag as string, patchBody(view, [set('summary', 'No')]));
      assert.equal(frozen.status, 503);
      assert.equal(frozen.json.code, 'CALENDAR_UNAVAILABLE');
      const frozenRead = await read(id);
      assert.equal(frozenRead.readonly_reason, 'writes_suspended');
      const frozenCreate = await api.post(`${BASE}/objects`, { auth: 'admin', body: { calendar_id: cal.id, fields: { summary: 'No', start: rome('2027-12-02', 9), end: rome('2027-12-02', 10) } } });
      assert.equal(frozenCreate.status, 503);
      const frozenDelete = await api.delete(`${BASE}/objects/${id}`, { auth: 'admin', headers: { 'If-Match': view.etag as string }, query: { scope: 'all' } });
      assert.equal(frozenDelete.status, 503);
    } finally {
      await sql`UPDATE calendar_backend_state SET mode = 'postgres', write_freeze = false WHERE id`;
      invalidateBackendModeCache();
    }

    const down = new RadicaleClient({ baseUrl: 'http://127.0.0.1:1', password: SVC_PASSWORD, retries: 0, timeoutMs: 1_000 });
    configureRadicaleRuntime({ client: down, identitySource: 'file' });
    try {
      const fallback = await read(id);
      assert.equal(fallback.source, 'index');
      assert.ok(fallback.notices.includes('index_fallback'));
      assert.equal(fallback.master?.fields.summary, 'Guasto');
      const res = await patch(id, view.etag as string, patchBody(view, [set('summary', 'No')]));
      assert.equal(res.status, 503);
    } finally {
      configureRadicaleRuntime({ client: svc, identitySource: 'auto' });
      down.close();
    }

    await sql`UPDATE calendar_backend_state SET epoch = epoch + 1 WHERE id`;
    invalidateBackendModeCache();
    invalidateIdentityCache();
    try {
      const res = await patch(id, view.etag as string, patchBody(view, [set('summary', 'No')]));
      assert.equal(res.status, 503, 'identità del volume diversa: mai scrivere');
      assert.equal(res.json.code, 'CALENDAR_UNAVAILABLE');
    } finally {
      await sql`UPDATE calendar_backend_state SET epoch = epoch - 1 WHERE id`;
      invalidateBackendModeCache();
      invalidateIdentityCache();
    }
    assert.equal((await textOf(cal, href))?.etag, stored?.etag, 'nessuna scrittura durante i guasti');
  });

  // ── MOVE ──

  test('move_to_calendar_id: stessa risorsa nella destinazione con lo stesso id; conflitto di href → 409 MOVE_CONFLICT', async () => {
    const created = await create({ summary: 'Da spostare', start: rome('2028-01-10', 9), end: rome('2028-01-10', 10) });
    const id = created.object?.id as string;
    const href = `${created.object?.uid}.ics`;
    const view = await read(id);
    const res = await patch(id, view.etag as string, patchBody(view, [set('summary', 'Spostato')], { move_to_calendar_id: other.id }));
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.object?.calendar_id, other.id);
    assert.equal(res.json.object?.id, id, 'il MOVE conserva l\'id');
    assert.ok(res.json.changed.includes('calendar_id'));
    assert.equal(await textOf(cal, href), null);
    assert.match((await textOf(other, href))?.body ?? '', /SUMMARY:Spostato/);
    assert.equal((await read(id)).calendar_id, other.id);
    const audits = await auditRows(id);
    assert.ok(audits.some((a) => a.metadata.operation === 'v2.patch+move' && a.metadata.from_calendar_id === cal.id));

    // Solo MOVE (nessun cambiamento): ammesso; scope diverso da all → SCOPE_INVALID.
    const moved = await read(id);
    const back = await patch(id, moved.etag as string, patchBody(moved, [set('summary', 'Spostato')], { move_to_calendar_id: cal.id }));
    assert.equal(back.status, 200, back.text);
    assert.equal(back.json.object?.calendar_id, cal.id);

    // Href già presente nella destinazione.
    const second = await create({ summary: 'Occupa il posto', start: rome('2028-01-11', 9), end: rome('2028-01-11', 10) });
    const secondHref = `${second.object?.uid}.ics`;
    const text = (await textOf(cal, secondHref))?.body as string;
    await svc.put(objectPath(P, other.slug, secondHref), text.replace(/^UID:.*$/m, 'UID:altro-uid-diverso'), { ifNoneMatch: '*' });
    await syncCollection(other.id, { reason: 'manual' });
    const sv = await read(second.object?.id as string);
    const conflict = await patch(sv.id, sv.etag as string, patchBody(sv, [set('summary', 'Conflitto')], { move_to_calendar_id: other.id }));
    assert.equal(conflict.status, 409, conflict.text);
    assert.equal(conflict.json.code, 'MOVE_CONFLICT');
    assert.equal(conflict.json.details?.patched, true);
    assert.ok(conflict.json.details?.etag);
    assert.match((await textOf(cal, secondHref))?.body ?? '', /SUMMARY:Conflitto/, 'la PUT è riuscita, la MOVE no');

    const missing = await patch(sv.id, sv.etag as string, patchBody(sv, [set('summary', 'x')], { move_to_calendar_id: randomUUID() }));
    assert.equal(missing.status, 404);
  });

  test('solo spostamento di calendario (ops vuote): 200 con changed [calendar_id]; ETag vecchio → 412; senza move → 400', async () => {
    const created = await create({ summary: 'Solo calendario', start: rome('2028-02-07', 9), end: rome('2028-02-07', 10) });
    const id = created.object?.id as string;
    const href = `${created.object?.uid}.ics`;

    const view = await read(id);
    const res = await patch(id, view.etag as string, patchBody(view, [], { move_to_calendar_id: other.id }));
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.noop, false, 'lo spostamento non è un noop');
    assert.deepEqual(res.json.changed, ['calendar_id']);
    assert.equal(res.json.object?.id, id, 'il MOVE conserva l\'id');
    assert.equal(res.json.object?.calendar_id, other.id);
    assert.equal(await textOf(cal, href), null, 'la risorsa lascia il calendario di origine');
    assert.match((await textOf(other, href))?.body ?? '', /SUMMARY:Solo calendario/, 'la risorsa è nella destinazione, con il testo invariato');
    assert.equal((await read(id)).calendar_id, other.id);

    // ETag vecchio: senza op non c'è nulla da fondere, quindi serve l'ETag esatto (412 come la DELETE).
    const second = await create({ summary: 'Ancora ferma', start: rome('2028-02-08', 9), end: rome('2028-02-08', 10) });
    const secondHref = `${second.object?.uid}.ics`;
    const stale = await read(second.object?.id as string);
    await deviceEdit(cal, secondHref, (t) => t.replace(/SUMMARY:Ancora ferma/, 'SUMMARY:Dal device'));
    const refused = await patch(stale.id, stale.etag as string, patchBody(stale, [], { move_to_calendar_id: other.id }));
    assert.equal(refused.status, 412, refused.text);
    assert.equal(refused.json.code, 'PRECONDITION_FAILED');
    assert.deepEqual(refused.json.conflicts, []);
    assert.ok(refused.json.current?.id);
    assert.match((await textOf(cal, secondHref))?.body ?? '', /SUMMARY:Dal device/, 'nessuno spostamento con ETag vecchio');
    assert.equal(await textOf(other, secondHref), null);

    // Nessuna op e nessuno spostamento: la richiesta non chiede nulla.
    const none = await patch(id, (await read(id)).etag as string, patchBody(view, []));
    assert.equal(none.status, 400, none.text);
    assert.equal(none.json.code, 'VALIDATION_FAILED');
  });

  // ── Proprietà non tipizzate e audit ──

  test('set_property conserva gli altri X-*; riferimento per UID; audit senza testo né dati personali', async () => {
    const uid = `props-${randomUUID()}`;
    const secret = `Riservato ${randomUUID()}`;
    const created = await create({ summary: secret, start: rome('2028-02-01', 9), end: rome('2028-02-01', 10) }, {
      uid,
      properties: { 'X-UNO': [{ name: 'X-UNO', params: [], value: '1' }], 'X-DUE': [{ name: 'X-DUE', params: [], value: '2' }] },
    });
    const view = await read(uid);
    assert.equal(view.id, created.object?.id, ':id accetta anche l\'UID');
    assert.deepEqual(Object.keys(view.master?.extra_properties ?? {}).sort(), ['X-CALDES-SOURCE', 'X-DUE', 'X-UNO'], 'la provenienza informativa è una proprietà non tipizzata come le altre');
    const res = await patch(uid, view.etag as string, patchBody(view, [prop('X-UNO', '10'), prop('X-DUE', null), prop('X-TRE', '3')]));
    assert.equal(res.status, 200, res.text);
    assert.deepEqual([...res.json.changed].sort(), ['prop:X-DUE', 'prop:X-TRE', 'prop:X-UNO']);
    const text = unfold((await textOf(cal, `${uid}.ics`))?.body ?? '');
    assert.match(text, /X-UNO:10/);
    assert.doesNotMatch(text, /X-DUE/);
    assert.match(text, /X-TRE:3/);
    const rows = await sql<Array<{ old_data: unknown; new_data: unknown; metadata: unknown; changed_fields: unknown; user_email: string }>>`
      SELECT old_data, new_data, metadata, changed_fields, user_email FROM audit_logs WHERE table_name = 'cal_objects' AND record_id = ${view.id}
    `;
    assert.ok(rows.length >= 2);
    for (const row of rows) {
      const dump = JSON.stringify(row);
      assert.ok(!dump.includes(secret), 'nessun testo di evento in audit_logs');
      assert.ok(!dump.includes('X-UNO:'), 'nessuna proprietà in audit_logs');
    }
    const patchRow = rows.find((r) => (r.metadata as Record<string, unknown>).operation === 'v2.patch');
    assert.ok(patchRow);
    assert.equal(patchRow.user_email, 'calendar:admin');
    assert.deepEqual(Object.keys(patchRow.new_data as object).sort(), ['collection', 'etag', 'href']);
    assert.equal((patchRow.metadata as Record<string, unknown>).scope, 'all');
    assert.ok((patchRow.metadata as Record<string, unknown>).user_id, 'id dell\'utente del JWT');
  });
});
