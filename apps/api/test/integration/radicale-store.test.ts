/**
 * RadicaleStore contro Radicale 3.7.8 reale (piano F2, "Test": STORE;
 * contratto dei moduli docs/calendar-radicale/contracts/f2-modules.md §6 e
 * §11; design §8, §11 lato API, §5).
 *
 * Un Radicale con storage multifilesystem in una directory temporanea, auth
 * htpasswd con il solo caldes-svc e rights from_file con la matrice di
 * caldes-svc del contratto control-plane §8. Il volume si inizializza con
 * initializeVolume() di F1 (principal, marker, collezioni del sidecar); il
 * runtime della sync punta allo storage come a RADICALE_DATA_DIR. Lo store è
 * forzato con overrideCalendarStore('radicale') e si usa attraverso la facade.
 *
 * Casi: CRUD di un evento singolo con write-through, id stabile e audit;
 * VALARM, ATTENDEE e X-* scritti da un device preservati dopo una modifica
 * dall'API; serie ricorrente: solo questa (override), elimina questa
 * (EXDATE), questa e le successive (saga con UNTIL e RELATED-TO, job di
 * recupero: già troncata, taglio, compensazione), tutta la serie (Δ anche su
 * override ed EXDATE), eliminazione; 412 per una modifica concorrente → CAS per
 * campo: 409 con i campi in conflitto, oppure fusione se il device ha toccato
 * altri campi; recurrence_key sparita → 409; MOVE fra calendari con lo stesso
 * id; festività idempotente con If-None-Match; calendario creato (MKCALENDAR
 * con dead prop, stato dell'indice), modificato (PROPPATCH) e cancellato;
 * collezione già esistente → stesso messaggio di oggi e nessuna riga; recupero
 * di creating/deleting; identità del volume diversa, write_freeze e Radicale
 * giù → 503 senza scritture, letture dall'indice.
 *
 * Senza RADICALE_BIN la suite è saltata con il motivo. Date fisse nel 2027.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { invalidateBackendModeCache } from '../../src/lib/calendar/backend-mode';
import { createCalendar, deleteCalendar, getCalendar, updateCalendar } from '../../src/lib/calendar/calendars';
import {
  CalendarConflictError,
  CalendarFieldConflictError,
  CalendarRecurrenceConflictError,
  CalendarUnavailableError,
} from '../../src/lib/calendar/errors';
import {
  createEvent,
  createOccurrenceOverride,
  deleteEvent,
  getEvent,
  getEventBySource,
  listOccurrences,
  updateEvent,
} from '../../src/lib/calendar/events';
import type { CalendarJob } from '../../src/lib/calendar/jobs';
import { collectionPath, createNodeTransport, objectPath, RadicaleClient, type RadicaleTransport } from '../../src/lib/calendar/radicale/client';
import { clark, DAV_PROPS } from '../../src/lib/calendar/radicale/dav-xml';
import { initializeVolume } from '../../src/lib/calendar/radicale/identity';
import { stopIndexWorker } from '../../src/lib/calendar/radicale/indexer';
import {
  runCalendarLifecycleJob,
  runRecurrenceSplitJob,
  splitRecurringEvent,
} from '../../src/lib/calendar/radicale/store';
import { configureRadicaleRuntime, invalidateIdentityCache, syncCollection, updateWatchMode } from '../../src/lib/calendar/radicale/sync';
import { overrideCalendarStore } from '../../src/lib/calendar/store';
import type { Calendar, CalendarEvent } from '../../src/lib/calendar/types';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql, useTestDatabase } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';
import { radicaleAvailability, type RadicaleServer, startRadicale, TEST_PRINCIPAL } from '../helpers/radicale';

useTestDatabase({ resetBaseline: true });
onBeforeDatabaseClose(async () => {
  overrideCalendarStore(null);
  await stopIndexWorker();
  await resetCalendarBaseline();
});
const fx = useFixtures('store-int');

const radicale = radicaleAvailability();
const P = TEST_PRINCIPAL;
const SVC_PASSWORD = 'test-only-svc-password-f2-store';

/** Matrice di caldes-svc del contratto control-plane §8 (R root, RW principal, rwD collezioni). */
const SVC_RIGHTS_RULES = [
  '[root]', 'user: .+', 'collection:', 'permissions: R', '',
  '[svc-principal]', 'user: caldes-svc', `collection: ${P}`, 'permissions: RW', '',
  '[svc-collections]', 'user: caldes-svc', `collection: ${P}/[^/]+`, 'permissions: rwD', '',
].join('\n');

/** Testo di un oggetto scritto da un device (Apple): VALARM, ATTENDEE con parametri, X-* e proprietà sconosciute. */
function deviceIcs(uid: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Apple Inc.//iPhone OS 18.0//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20261001T080000Z',
    'DTSTART;TZID=Europe/Rome:20270412T150000',
    'DTEND;TZID=Europe/Rome:20270412T160000',
    'SUMMARY:Dal telefono',
    'ATTENDEE;CN="Mario Rossi";PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:mario@example.invalid',
    'ORGANIZER;CN=Federico:mailto:federico@example.invalid',
    'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC',
    'X-CUSTOM-PROP;X-PARAM=uno:valore libero',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:Promemoria',
    'TRIGGER:-PT15M',
    'X-WR-ALARMUID:9B2C2E3A-1111-2222-3333-444455556666',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

function unfold(text: string): string {
  return text.replace(/\r\n[ \t]/g, '');
}

describe('RadicaleStore contro Radicale reale', { skip: radicale.skip }, () => {
  let rad: RadicaleServer;
  let svc: RadicaleClient;
  let cal: Calendar;
  let other: Calendar;
  let holidays: Calendar;

  const raw = async (c: Calendar, href: string): Promise<string | null> => {
    try {
      return (await svc.get(objectPath(P, c.slug, href))).body;
    } catch (err) {
      if ((err as { code?: string }).code === 'not_found') return null;
      throw err;
    }
  };
  const hrefOf = (ev: CalendarEvent): string => `${ev.uid}.ics`;

  before(async () => {
    rad = await startRadicale({
      label: 'f2-store',
      auth: { type: 'htpasswd', users: { 'caldes-svc': SVC_PASSWORD } },
      rights: { type: 'from_file', rules: SVC_RIGHTS_RULES },
    });
    svc = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0 });
    cal = await fx.calendar({ key: 'lav', blocks_availability: true });
    other = await fx.calendar({ key: 'altro', blocks_availability: true });
    holidays = await fx.holidayCalendar();
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

  // ── Evento singolo ──

  let single: CalendarEvent;

  test('createEvent: PUT con If-None-Match, write-through nell\'indice, id persistente e audit', async () => {
    single = await createEvent({
      calendar_id: cal.id,
      summary: fx.name('Riunione'),
      description: 'Ordine del giorno',
      location: 'Sala A',
      start_time: '2027-04-05T08:00:00Z',
      end_time: '2027-04-05T09:00:00Z',
      source: 'admin',
      source_id: 'orig-42',
    });
    assert.equal(single.calendar_id, cal.id);
    assert.equal(single.source, 'admin');
    assert.equal(single.source_id, 'orig-42');
    assert.equal(single.start_time, '2027-04-05T08:00:00.000Z');
    const text = unfold((await raw(cal, hrefOf(single))) ?? '');
    assert.match(text, /DTSTART;TZID=Europe\/Rome:20270405T100000/);
    assert.match(text, /X-CALDES-SOURCE:admin/);
    const [ids] = await sql<Array<{ id: string }>>`
      SELECT id FROM cal_object_ids WHERE calendar_id = ${cal.id} AND href = ${hrefOf(single)} AND recurrence_key = ''
    `;
    assert.equal(ids.id, single.id, 'il DTO ha l\'id dell\'indice (write-through)');
    const [obj] = await sql<Array<{ etag: string }>>`SELECT etag FROM cal_objects WHERE id = ${single.id}`;
    assert.ok(obj?.etag, 'oggetto indicizzato con l\'ETag di Radicale');
    const [log] = await sql<Array<{ action: string; new_data: Record<string, unknown> }>>`
      SELECT action, new_data FROM audit_logs WHERE table_name = 'cal_objects' AND record_id = ${single.id} ORDER BY created_at DESC LIMIT 1
    `;
    assert.equal(log.action, 'INSERT');
    assert.deepEqual(Object.keys(log.new_data).sort(), ['collection', 'etag', 'href']);
    const fresh = await getEvent(single.id);
    assert.deepEqual(fresh, single, 'getEvent (GET diretto) = DTO della creazione');
  });

  test('updateEvent: patch lossless, SEQUENCE+1 sugli orari, If-Match; getEventBySource', async () => {
    const updated = await updateEvent(single.id, { summary: fx.name('Riunione spostata'), start_time: '2027-04-05T09:00:00Z', end_time: '2027-04-05T10:00:00Z' });
    assert.ok(updated);
    assert.equal(updated.id, single.id);
    assert.equal(updated.start_time, '2027-04-05T09:00:00.000Z');
    assert.equal(updated.location, 'Sala A', 'i campi non toccati restano');
    const text = unfold((await raw(cal, hrefOf(single))) ?? '');
    assert.match(text, /SEQUENCE:1/);
    assert.match(text, /DTSTART;TZID=Europe\/Rome:20270405T110000/);
    const bySource = await getEventBySource('admin', 'orig-42');
    assert.equal(bySource?.id, single.id);
    // Nessun cambiamento effettivo: niente PUT.
    const before = (await svc.get(objectPath(P, cal.slug, hrefOf(single)))).etag;
    await updateEvent(single.id, { location: 'Sala A' });
    assert.equal((await svc.get(objectPath(P, cal.slug, hrefOf(single)))).etag, before);
  });

  test('VALARM, ATTENDEE e X-* scritti da un device restano dopo una modifica dall\'API', async () => {
    const uid = `device-${randomUUID()}`;
    await svc.put(objectPath(P, cal.slug, `${uid}.ics`), deviceIcs(uid), { ifNoneMatch: '*' });
    await syncCollection(cal.id, { reason: 'manual' });
    const ev = await getEvent(uid);
    assert.ok(ev);
    const updated = await updateEvent(ev.id, { summary: 'Modificato da admin', description: 'Note' });
    assert.equal(updated?.summary, 'Modificato da admin');
    const text = unfold((await raw(cal, `${uid}.ics`)) ?? '');
    assert.match(text, /SUMMARY:Modificato da admin/);
    assert.match(text, /BEGIN:VALARM[\s\S]*TRIGGER:-PT15M[\s\S]*X-WR-ALARMUID:9B2C2E3A-1111-2222-3333-444455556666[\s\S]*END:VALARM/);
    assert.match(text, /ATTENDEE;CN="?Mario Rossi"?;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:mario@example\.invalid/);
    assert.match(text, /ORGANIZER;CN=Federico:mailto:federico@example\.invalid/);
    assert.match(text, /X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC/);
    assert.match(text, /X-CUSTOM-PROP;X-PARAM=uno:valore libero/);
    assert.match(text, /PRODID:-\/\/Apple Inc\.\/\/iPhone OS 18\.0\/\/EN/, 'PRODID del device preservato');
    assert.match(text, /DTSTART;TZID=Europe\/Rome:20270412T150000/);
  });

  test('412 per una modifica concorrente: stesso campo → 409 con i campi in conflitto, altro campo → fusione', async () => {
    const ev = await createEvent({ calendar_id: cal.id, summary: 'Base', start_time: '2027-04-06T08:00:00Z', end_time: '2027-04-06T09:00:00Z' });
    const path = objectPath(P, cal.slug, hrefOf(ev));
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
    const client = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0, transport });
    configureRadicaleRuntime({ client });
    const deviceEdit = (edit: (text: string) => string) => async () => {
      const cur = await svc.get(path);
      await svc.put(path, edit(cur.body), { ifMatch: cur.etag as string });
    };
    try {
      hook = deviceEdit((t) => t.replace(/SUMMARY:Base/, 'SUMMARY:Dal device'));
      await assert.rejects(updateEvent(ev.id, { summary: 'Dall\'admin' }), (err: unknown) => {
        assert.ok(err instanceof CalendarFieldConflictError, String(err));
        assert.equal(err.code, 'CALENDAR_CONFLICT');
        assert.deepEqual(err.conflicts.map((c) => [c.field, c.base, c.theirs, c.yours]), [['summary', 'Base', 'Dal device', 'Dall\'admin']]);
        return true;
      });
      assert.match((await svc.get(path)).body, /SUMMARY:Dal device/, 'la modifica del device non è stata sovrascritta');

      hook = deviceEdit((t) => t.replace('END:VEVENT', 'LOCATION:Sala del device\r\nEND:VEVENT'));
      const merged = await updateEvent(ev.id, { summary: 'Dall\'admin' });
      assert.equal(merged?.summary, 'Dall\'admin');
      assert.equal(merged?.location, 'Sala del device', 'il CAS per campo fonde le modifiche su campi diversi');
    } finally {
      configureRadicaleRuntime({ client: svc });
      client.close();
      node.close();
    }
  });

  test('MOVE fra calendari: stessa risorsa nella destinazione, id invariato', async () => {
    const moved = await updateEvent(single.id, { calendar_id: other.id });
    assert.equal(moved?.calendar_id, other.id);
    assert.equal(moved?.id, single.id, 'il MOVE conserva l\'id (cal_object_ids ri-chiavata)');
    assert.equal(await raw(cal, hrefOf(single)), null);
    assert.ok(await raw(other, hrefOf(single)));
    const again = await getEvent(single.id);
    assert.equal(again?.calendar_id, other.id);
    assert.equal(await deleteEvent(single.id), true);
    assert.equal(await raw(other, hrefOf(single)), null);
    assert.equal(await getEvent(single.id), null);
    assert.equal(await deleteEvent(single.id), false);
  });

  // ── Serie ricorrente ──

  let master: CalendarEvent;

  test('serie: creazione e "solo questa" (override con RECURRENCE-ID dello stesso tipo e TZID)', async () => {
    master = await createEvent({
      calendar_id: cal.id,
      summary: 'Studio',
      start_time: '2027-03-01T08:00:00Z',
      end_time: '2027-03-01T09:00:00Z',
      rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,TH,FR',
      source: 'admin',
    });
    assert.equal(master.rrule, 'FREQ=WEEKLY;BYDAY=MO,TU,TH,FR');
    const override = await createOccurrenceOverride({
      masterEventId: master.id,
      originalStartIso: '2027-03-02T08:00:00.000Z',
      newStartIso: '2027-03-02T10:00:00Z',
      newEndIso: '2027-03-02T11:00:00Z',
      newSummary: 'Spostata',
    });
    assert.equal(override.recurrence_master_id, master.id);
    assert.equal(override.recurrence_id, '2027-03-02T08:00:00.000Z');
    assert.equal(override.start_time, '2027-03-02T10:00:00.000Z');
    assert.equal(override.uid, master.uid);
    const text = unfold((await raw(cal, hrefOf(master))) ?? '');
    assert.match(text, /RECURRENCE-ID;TZID=Europe\/Rome:20270302T090000/);
    const week = await listOccurrences({ calendarId: cal.id, fromIso: '2027-03-01T00:00:00Z', toIso: '2027-03-06T00:00:00Z' });
    assert.deepEqual(week.map((o) => [o.start_time, o.summary, o.is_override]), [
      ['2027-03-01T08:00:00.000Z', 'Studio', false],
      ['2027-03-02T10:00:00.000Z', 'Spostata', true],
      ['2027-03-04T08:00:00.000Z', 'Studio', false],
      ['2027-03-05T08:00:00.000Z', 'Studio', false],
    ]);
    assert.equal(week[1].id, override.id);
    // Modifica dell'override con il suo id.
    const renamed = await updateEvent(override.id, { summary: 'Spostata e rinominata' });
    assert.equal(renamed?.summary, 'Spostata e rinominata');
    assert.equal(renamed?.recurrence_master_id, master.id);
  });

  test('"elimina questa": EXDATE tipizzato e rimozione dell\'override', async () => {
    const week = await listOccurrences({ calendarId: cal.id, fromIso: '2027-03-01T00:00:00Z', toIso: '2027-03-06T00:00:00Z' });
    const override = week.find((o) => o.is_override);
    assert.ok(override);
    assert.equal(await deleteEvent(override.id), true);
    const text = unfold((await raw(cal, hrefOf(master))) ?? '');
    assert.match(text, /EXDATE;TZID=Europe\/Rome:20270302T090000/);
    assert.doesNotMatch(text, /RECURRENCE-ID/);
    const after = await listOccurrences({ calendarId: cal.id, fromIso: '2027-03-01T00:00:00Z', toIso: '2027-03-06T00:00:00Z' });
    assert.deepEqual(after.map((o) => o.start_time), ['2027-03-01T08:00:00.000Z', '2027-03-04T08:00:00.000Z', '2027-03-05T08:00:00.000Z']);
  });

  test('recurrence_key che non è un\'istanza → 409; override rimosso da un device → 409 sull\'id vecchio', async () => {
    await assert.rejects(
      createOccurrenceOverride({ masterEventId: master.id, originalStartIso: '2027-03-03T08:00:00.000Z', newSummary: 'Mercoledì' }),
      CalendarRecurrenceConflictError,
    );
    const ov = await createOccurrenceOverride({ masterEventId: master.id, originalStartIso: '2027-03-04T08:00:00.000Z', newSummary: 'Giovedì speciale' });
    // Il device toglie l'override (il master resta): l'indice non è ancora aggiornato.
    const path = objectPath(P, cal.slug, hrefOf(master));
    const cur = await svc.get(path);
    const withoutOverride = cur.body.replace(/BEGIN:VEVENT(?:(?!END:VEVENT)[\s\S])*RECURRENCE-ID[\s\S]*?END:VEVENT\r\n/, '');
    assert.doesNotMatch(withoutOverride, /RECURRENCE-ID/);
    await svc.put(path, withoutOverride, { ifMatch: cur.etag as string });
    await assert.rejects(updateEvent(ov.id, { summary: 'Troppo tardi' }), (err: unknown) => err instanceof CalendarRecurrenceConflictError && err.code === 'CALENDAR_CONFLICT');
    await syncCollection(cal.id, { reason: 'manual' });
  });

  test('"questa e le successive": saga con UNTIL, RELATED-TO e COUNT/override dal taglio; job di verifica', async () => {
    const res = await splitRecurringEvent({ masterEventId: master.id, originalStartIso: '2027-03-11T08:00:00.000Z', changes: { summary: 'Nuova serie' } });
    assert.equal(res.wholeSeries, false);
    assert.ok(res.head);
    assert.equal(res.tail.summary, 'Nuova serie');
    assert.notEqual(res.tail.uid, master.uid);
    assert.equal(res.tail.start_time, '2027-03-11T08:00:00.000Z');
    const head = unfold((await raw(cal, hrefOf(master))) ?? '');
    assert.match(head, /RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR;UNTIL=20270311T075959Z/);
    const tail = unfold((await raw(cal, hrefOf(res.tail))) ?? '');
    assert.match(tail, new RegExp(`RELATED-TO;RELTYPE=SIBLING:${master.uid}`));
    const weeks = await listOccurrences({ calendarId: cal.id, fromIso: '2027-03-08T00:00:00Z', toIso: '2027-03-16T00:00:00Z' });
    assert.deepEqual(weeks.map((o) => [o.start_time, o.summary]), [
      ['2027-03-08T08:00:00.000Z', 'Studio'],
      ['2027-03-09T08:00:00.000Z', 'Studio'],
      ['2027-03-11T08:00:00.000Z', 'Nuova serie'],
      ['2027-03-12T08:00:00.000Z', 'Nuova serie'],
      ['2027-03-15T08:00:00.000Z', 'Nuova serie'],
    ]);
    const [job] = await sql<Array<{ id: string; payload: Record<string, unknown>; status: string }>>`
      SELECT id, payload, status FROM cal_jobs WHERE kind = 'recurrence_split' AND key = ${master.uid}
    `;
    assert.equal(job.payload.phase, 'done', 'la saga conclusa in linea marca il job come verifica');
    const asJob = (payload: Record<string, unknown>): CalendarJob => ({ id: job.id, kind: 'recurrence_split', key: master.uid, payload } as CalendarJob);
    assert.deepEqual(await runRecurrenceSplitJob(asJob(job.payload)), { result: 'done' });
    assert.deepEqual(await runRecurrenceSplitJob(asJob({ ...job.payload, phase: 'tail-written' })), { result: 'already-truncated' });
  });

  test('job recurrence_split: taglio mancante completato con l\'ETag di base, compensazione se la serie è cambiata', async () => {
    const series = await createEvent({
      calendar_id: cal.id, summary: 'Serie da recuperare', start_time: '2027-05-03T08:00:00Z', end_time: '2027-05-03T09:00:00Z',
      rrule: 'FREQ=DAILY;COUNT=10',
    });
    const tailHref = `tail-${randomUUID()}.ics`;
    const tailUid = `tail-${randomUUID()}`;
    const tailText = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//IT', 'BEGIN:VEVENT', `UID:${tailUid}`, 'DTSTAMP:20261001T080000Z',
      'DTSTART:20270506T080000Z', 'DTEND:20270506T090000Z', 'RRULE:FREQ=DAILY;COUNT=7', `RELATED-TO;RELTYPE=SIBLING:${series.uid}`,
      'SUMMARY:Coda', 'END:VEVENT', 'END:VCALENDAR', '',
    ].join('\r\n');
    const masterPath = objectPath(P, cal.slug, hrefOf(series));
    const base = (await svc.get(masterPath)).etag;
    const payload = {
      calendarId: cal.id, href: hrefOf(series), newHref: tailHref, newUid: tailUid,
      recurrenceKey: '20270506T080000Z', baseEtag: base, phase: 'tail-written',
    };
    const job = (p: Record<string, unknown>): CalendarJob => ({ id: '0', kind: 'recurrence_split', key: series.uid, payload: p } as CalendarJob);
    // Nuova serie assente: la saga non l'aveva scritta.
    assert.deepEqual(await runRecurrenceSplitJob(job(payload)), { result: 'aborted' });
    await svc.put(objectPath(P, cal.slug, tailHref), tailText, { ifNoneMatch: '*' });
    assert.deepEqual(await runRecurrenceSplitJob(job(payload)), { result: 'truncated' });
    assert.match(unfold((await svc.get(masterPath)).body), /COUNT=3/, 'COUNT ridotto alle istanze prima del taglio');

    // Seconda serie modificata da altri prima del taglio: la coda si cancella.
    const s2 = await createEvent({
      calendar_id: cal.id, summary: 'Serie cambiata', start_time: '2027-06-07T08:00:00Z', end_time: '2027-06-07T09:00:00Z',
      rrule: 'FREQ=DAILY;COUNT=10',
    });
    const tail2 = `tail-${randomUUID()}.ics`;
    await svc.put(objectPath(P, cal.slug, tail2), tailText.replace(tailUid, `${tailUid}-2`), { ifNoneMatch: '*' });
    assert.deepEqual(await runRecurrenceSplitJob(job({
      calendarId: cal.id, href: hrefOf(s2), newHref: tail2, newUid: `${tailUid}-2`, recurrenceKey: '20270610T080000Z', baseEtag: '"non-piu-valido"', phase: 'tail-written',
    })), { result: 'compensated' });
    assert.equal(await raw(cal, tail2), null);
  });

  test('"tutta la serie": spostamento con Δ anche su override ed EXDATE, nessun doppione', async () => {
    await createOccurrenceOverride({ masterEventId: master.id, originalStartIso: '2027-03-05T08:00:00.000Z', newSummary: 'Venerdì speciale' });
    const shifted = await updateEvent(master.id, { start_time: '2027-03-01T09:00:00Z', end_time: '2027-03-01T10:00:00Z' });
    assert.equal(shifted?.start_time, '2027-03-01T09:00:00.000Z');
    const text = unfold((await raw(cal, hrefOf(master))) ?? '');
    assert.match(text, /RECURRENCE-ID;TZID=Europe\/Rome:20270305T100000/, 'il RECURRENCE-ID segue lo spostamento');
    assert.match(text, /EXDATE;TZID=Europe\/Rome:20270302T100000/, 'l\'EXDATE segue lo spostamento');
    const week = await listOccurrences({ calendarId: cal.id, fromIso: '2027-03-01T00:00:00Z', toIso: '2027-03-06T00:00:00Z' });
    const days = week.map((o) => o.start_time.slice(0, 10));
    assert.deepEqual(days, ['2027-03-01', '2027-03-04', '2027-03-05'], 'martedì resta escluso, venerdì una volta sola');
    const friday = week.find((o) => o.start_time.startsWith('2027-03-05'));
    assert.equal(friday?.is_override, true);
    assert.equal(friday?.summary, 'Venerdì speciale');
  });

  test('eliminazione della serie: DELETE della risorsa con If-Match', async () => {
    assert.equal(await deleteEvent(master.id), true);
    assert.equal(await raw(cal, hrefOf(master)), null);
    assert.equal(await getEvent(master.id), null);
  });

  // ── Festività ──

  test('festività del cron: href e UID deterministici, If-None-Match idempotente', async () => {
    const input = {
      calendar_id: holidays.id, summary: 'Epifania', start_time: '2027-01-05T23:00:00Z', end_time: '2027-01-06T23:00:00Z',
      all_day: false, source: 'system' as const, source_id: 'it-holiday-2027-01-06', status: 'confirmed' as const,
    };
    const first = await createEvent(input);
    const second = await createEvent(input);
    assert.equal(second.id, first.id);
    assert.equal(first.source, 'system');
    assert.equal(first.source_id, 'it-holiday-2027-01-06');
    const text = unfold((await raw(holidays, 'it-holiday-2027-01-06.ics')) ?? '');
    assert.match(text, /UID:it-holiday-2027-01-06@caldes\.it/);
    assert.equal((await getEventBySource('system', 'it-holiday-2027-01-06'))?.id, first.id);
  });

  // ── Calendari ──

  test('calendario: MKCALENDAR con dead prop e stato dell\'indice, PROPPATCH, DELETE della collezione', async () => {
    const slug = fx.slug('nuovo');
    const created = await createCalendar({ slug, name: fx.name('Nuovo'), color: '#22aa66', timezone: 'Europe/Rome', description: 'Prova' });
    assert.equal(created.slug, slug);
    const props = await svc.readProps(collectionPath(P, slug), [DAV_PROPS.calendarId, DAV_PROPS.role, DAV_PROPS.displayname, DAV_PROPS.calendarColor]);
    assert.ok(props);
    assert.equal(props[clark(DAV_PROPS.calendarId)], created.id);
    assert.equal(props[clark(DAV_PROPS.role)], 'user');
    assert.equal(props[clark(DAV_PROPS.displayname)], created.name);
    const [row] = await sql<Array<{ lifecycle: string; collection_name: string }>>`SELECT lifecycle, collection_name FROM calendars WHERE id = ${created.id}`;
    assert.deepEqual({ ...row }, { lifecycle: 'active', collection_name: slug });
    const [state] = await sql`SELECT 1 FROM cal_collection_state WHERE calendar_id = ${created.id}`;
    assert.ok(state, 'riga di stato della collezione per freshness e salute');
    const [job] = await sql<Array<{ status: string }>>`SELECT status FROM cal_jobs WHERE kind = 'calendar_lifecycle' AND key = ${created.id}`;
    assert.equal(job.status, 'pending', 'job di recupero accodato prima della MKCALENDAR');
    assert.deepEqual(await runCalendarLifecycleJob({ key: created.id } as CalendarJob), { result: 'active' });

    const renamed = await updateCalendar(created.id, { name: fx.name('Rinominato'), color: '#0055ff' });
    assert.equal(renamed?.color, '#0055ff');
    const after = await svc.readProps(collectionPath(P, slug), [DAV_PROPS.displayname, DAV_PROPS.calendarColor]);
    assert.equal(after?.[clark(DAV_PROPS.displayname)], renamed?.name);
    assert.equal(after?.[clark(DAV_PROPS.calendarColor)], '#0055ff');

    await deleteCalendar(created.id);
    assert.equal(await svc.readProps(collectionPath(P, slug), [DAV_PROPS.resourcetype]), null, 'collezione cancellata');
    assert.equal((await sql`SELECT 1 FROM calendars WHERE id = ${created.id}`).length, 0);
    assert.equal(await getCalendar(created.id), null);
  });

  test('collezione già esistente su Radicale → "Slug gia usato" e nessuna riga', async () => {
    const slug = fx.slug('occupato');
    await svc.mkcalendar(collectionPath(P, slug), { displayName: 'Del telefono' });
    await assert.rejects(createCalendar({ slug, name: fx.name('Occupato') }), (err: unknown) => err instanceof CalendarConflictError && err.message === 'Slug gia usato');
    assert.equal((await sql`SELECT 1 FROM calendars WHERE slug = ${slug}`).length, 0);
    await svc.delete(collectionPath(P, slug), { ifMatch: '*' });
  });

  test('recupero del lifecycle: creating adottato o eliminato, deleting completato', async () => {
    const insertRow = async (key: string, lifecycle: 'creating' | 'deleting'): Promise<{ id: string; slug: string }> => {
      const slug = fx.slug(key);
      const [r] = await sql<Array<{ id: string; slug: string }>>`
        INSERT INTO calendars (slug, name, ics_feed_token, collection_name, lifecycle, origin, created_at, updated_at)
        VALUES (${slug}, ${fx.name(key)}, ${randomUUID().replace(/-/g, '')}, ${slug}, ${lifecycle}, 'admin',
                now() - interval '10 minutes', now() - interval '10 minutes')
        RETURNING id, slug
      `;
      return r;
    };
    const adopt = await insertRow('adotta', 'creating');
    await svc.mkcalendar(collectionPath(P, adopt.slug), { props: [{ ...DAV_PROPS.calendarId, value: adopt.id }, { ...DAV_PROPS.role, value: 'user' }] });
    assert.deepEqual(await runCalendarLifecycleJob({ key: adopt.id } as CalendarJob), { result: 'activated' });
    assert.equal((await sql<Array<{ lifecycle: string }>>`SELECT lifecycle FROM calendars WHERE id = ${adopt.id}`)[0].lifecycle, 'active');

    const orphan = await insertRow('orfana', 'creating');
    assert.deepEqual(await runCalendarLifecycleJob({ key: orphan.id } as CalendarJob), { result: 'removed:missing' });
    assert.equal((await sql`SELECT 1 FROM calendars WHERE id = ${orphan.id}`).length, 0);

    const doomed = await insertRow('morente', 'deleting');
    await svc.mkcalendar(collectionPath(P, doomed.slug), {});
    assert.deepEqual(await runCalendarLifecycleJob({ key: doomed.id } as CalendarJob), { result: 'deleted' });
    assert.equal(await svc.readProps(collectionPath(P, doomed.slug), [DAV_PROPS.resourcetype]), null);
    assert.equal((await sql`SELECT 1 FROM calendars WHERE id = ${doomed.id}`).length, 0);

    // Riga creating appena nata: forse la richiesta è ancora in corso, il recupero la rimanda.
    const [young] = await sql<Array<{ id: string }>>`
      INSERT INTO calendars (slug, name, ics_feed_token, collection_name, lifecycle, origin)
      VALUES (${fx.slug('giovane')}, ${fx.name('giovane')}, ${randomUUID().replace(/-/g, '')}, ${fx.slug('giovane')}, 'creating', 'admin')
      RETURNING id
    `;
    assert.deepEqual(await runCalendarLifecycleJob({ key: young.id } as CalendarJob), { result: 'deferred' });
    await sql`DELETE FROM calendars WHERE id = ${young.id}`;
  });

  // ── Fail-closed delle scritture ──

  test('identità del volume diversa, write_freeze e Radicale giù → 503 senza scritture; letture dall\'indice', async () => {
    const ev = await createEvent({ calendar_id: cal.id, summary: 'Prima del guasto', start_time: '2027-04-07T08:00:00Z', end_time: '2027-04-07T09:00:00Z' });
    const etag = (await svc.get(objectPath(P, cal.slug, hrefOf(ev)))).etag;
    const expect503 = async (reason: string): Promise<void> => {
      await assert.rejects(updateEvent(ev.id, { summary: 'No' }), (err: unknown) => err instanceof CalendarUnavailableError && err.reason === reason);
      await assert.rejects(
        createEvent({ calendar_id: cal.id, summary: 'No', start_time: '2027-04-08T08:00:00Z', end_time: '2027-04-08T09:00:00Z' }),
        (err: unknown) => err instanceof CalendarUnavailableError && err.reason === reason,
      );
    };

    await sql`UPDATE calendar_backend_state SET epoch = epoch + 1 WHERE id`;
    invalidateBackendModeCache();
    invalidateIdentityCache();
    try {
      await expect503('identity_mismatch');
    } finally {
      await sql`UPDATE calendar_backend_state SET epoch = epoch - 1 WHERE id`;
      invalidateBackendModeCache();
      invalidateIdentityCache();
    }

    await sql`UPDATE calendar_backend_state SET mode = 'radicale', write_freeze = true WHERE id`;
    invalidateBackendModeCache();
    try {
      await expect503('write_freeze');
    } finally {
      await sql`UPDATE calendar_backend_state SET mode = 'postgres', write_freeze = false WHERE id`;
      invalidateBackendModeCache();
    }

    const down = new RadicaleClient({ baseUrl: 'http://127.0.0.1:1', password: SVC_PASSWORD, retries: 0, timeoutMs: 1_000 });
    configureRadicaleRuntime({ client: down, identitySource: 'file' });
    try {
      await expect503('radicale_unreachable');
      const read = await getEvent(ev.id);
      assert.equal(read?.summary, 'Prima del guasto', 'con Radicale giù getEvent risponde dall\'indice');
    } finally {
      configureRadicaleRuntime({ client: svc, identitySource: 'auto' });
      down.close();
    }
    assert.equal((await svc.get(objectPath(P, cal.slug, hrefOf(ev)))).etag, etag, 'nessuna scrittura durante i guasti');
  });
});
