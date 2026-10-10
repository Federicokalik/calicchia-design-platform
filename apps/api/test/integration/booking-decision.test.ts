/**
 * Protocollo di decisione delle prenotazioni con lo store Radicale contro
 * Radicale 3.7.8 reale (piano F2, "Test": Prenotazioni e Salute; design §6.5,
 * §9, §14; decisione 3; contratto dei moduli
 * docs/calendar-radicale/contracts/f2-modules.md §7 e §11).
 *
 * Un Radicale con storage multifilesystem in una directory temporanea, auth
 * htpasswd con il solo caldes-svc e la matrice di caldes-svc del contratto
 * control-plane §8; volume inizializzato con initializeVolume() di F1 e
 * runtime della sync che punta allo storage come al mount
 * (RADICALE_DATA_DIR). Lo store Radicale si forza con overrideCalendarStore.
 *
 * Casi:
 *  - Radicale fermo e nessuna modifica pendente → prenotazione accettata
 *    senza alcuna richiesta HTTP verso Radicale;
 *  - Radicale fermo con una directory bloccante cambiata → 503 (nessuna
 *    prenotazione) e, da MCP, {error} senza code;
 *  - proiezione via job project_booking (decisione 3: titolo con nome,
 *    telefono e link all'admin, niente email) e riprogrammazione 30 minuti più
 *    avanti, sovrapposta all'originale → accettata, vecchia proiezione rimossa;
 *  - evento comparso su un'altra collezione mentre la decisione sincronizzava
 *    → prenotazione presa e conflitto registrato dal controllo post-commit;
 *    evento già sotto una prenotazione admin (decisione 2) → nessun conflitto;
 *  - RRULE invalida in una collezione bloccante → /slots 200 con busy
 *    conservativo (campanello vivo, livello display).
 *
 * Senza RADICALE_BIN la suite è saltata con il motivo. Le date sono calcolate
 * a partire da oggi (min_notice e max_advance usano l'orologio reale, come la
 * sync: niente orologio fermo qui).
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fromZonedTime } from 'date-fns-tz';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql, useTestDatabase } from '../helpers/db';
import { api } from '../helpers/http';
import { useFixtures } from '../helpers/fixtures';
import { radicaleAvailability, type RadicaleServer, startRadicale, TEST_PRINCIPAL } from '../helpers/radicale';
import { executeTool } from '../../src/lib/agent/tools';
import { cancelBooking, createBooking, registerBookingJobs, rescheduleBooking } from '../../src/lib/calendar/booking';
import { CalendarUnavailableError } from '../../src/lib/calendar/errors';
import { CAL_JOB_KINDS, runCalendarJobsOnce, unregisterCalendarJobHandler } from '../../src/lib/calendar/jobs';
import { createNodeTransport, objectPath, RadicaleClient, type RadicaleTransport } from '../../src/lib/calendar/radicale/client';
import { discoverCollections } from '../../src/lib/calendar/radicale/discovery';
import { initializeVolume } from '../../src/lib/calendar/radicale/identity';
import { stopIndexWorker } from '../../src/lib/calendar/radicale/indexer';
import {
  configureRadicaleRuntime,
  syncAllCollections,
  type SyncCollectionResult,
  updateWatchMode,
} from '../../src/lib/calendar/radicale/sync';
import { startCalendarWatcher, statCollectionDir, stopCalendarWatcher } from '../../src/lib/calendar/radicale/watcher';
import { overrideCalendarStore } from '../../src/lib/calendar/store';
import type { Calendar, EventType } from '../../src/lib/calendar/types';

useTestDatabase({ resetBaseline: true });
onBeforeDatabaseClose(async () => {
  overrideCalendarStore(null);
  unregisterCalendarJobHandler(CAL_JOB_KINDS.projectBooking);
  unregisterCalendarJobHandler(CAL_JOB_KINDS.bookingConflictCheck);
  await stopIndexWorker();
  await resetCalendarBaseline();
});
const fx = useFixtures('decisione-rad');

const radicale = radicaleAvailability();
const P = TEST_PRINCIPAL;
const SVC_PASSWORD = 'test-only-svc-password-f2-busy';

const SVC_RIGHTS_RULES = [
  '[root]', 'user: .+', 'collection:', 'permissions: R', '',
  '[svc-principal]', 'user: caldes-svc', `collection: ${P}`, 'permissions: RW', '',
  '[svc-collections]', 'user: caldes-svc', `collection: ${P}/[^/]+`, 'permissions: rwD', '',
].join('\n');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Data locale (YYYY-MM-DD) del lunedì almeno `minDays` giorni dopo oggi. */
function mondayAfter(minDays: number): string {
  const d = new Date(Date.now() + minDays * 86_400_000);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Istante ISO di una data e un'ora di Roma. */
function rome(date: string, time: string): string {
  return fromZonedTime(`${date}T${time}:00`, 'Europe/Rome').toISOString();
}

function stamp(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function ics(uid: string, startIso: string, endIso: string, extra: string[] = []): string {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Calicchia Design//Test decisione F2//IT',
    'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261001T080000Z',
    `DTSTART:${stamp(startIso)}`, `DTEND:${stamp(endIso)}`, 'SUMMARY:Evento di prova', ...extra,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

/** Trasporto node con un contatore delle richieste e un hook sulla prossima REPORT sync-collection. */
function countingTransport(): { transport: RadicaleTransport; requests: () => number; onNextReport: (fn: () => Promise<void>) => void; close(): void } {
  const node = createNodeTransport({ maxSockets: 4 });
  let requests = 0;
  let hook: (() => Promise<void>) | null = null;
  const transport: RadicaleTransport = async (req) => {
    requests++;
    if (req.method === 'REPORT' && req.body?.toString('utf8').includes('sync-collection')) {
      const h = hook;
      hook = null;
      if (h) await h();
    }
    return node(req);
  };
  return { transport, requests: () => requests, onNextReport: (fn) => { hook = fn; }, close: () => node.close() };
}

describe('decisioni delle prenotazioni con lo store Radicale reale', { skip: radicale.skip }, () => {
  let rad: RadicaleServer;
  let svc: RadicaleClient;
  let et: EventType;
  const cal: Record<string, Calendar> = {};
  const attendee = (name: string) => ({ name, email: fx.email(name.toLowerCase().replace(/\s+/g, '-')), phone: '+39 333 0000000', timezone: 'Europe/Rome' });

  /** Sincronizza tutto finché ogni collezione ha la dir_mtime_ns della propria directory. */
  async function settleAll(): Promise<void> {
    for (let round = 0; round < 4; round++) {
      await sleep(60);
      const results = await syncAllCollections({ reason: 'manual' });
      for (const r of results) if (r instanceof Error) throw r;
      let settled = true;
      for (const r of results as SyncCollectionResult[]) {
        const [row] = await sql<Array<{ collection_name: string }>>`SELECT collection_name FROM calendars WHERE id = ${r.calendarId}`;
        const m = await statCollectionDir(row.collection_name);
        if (m === null || r.dirMtimeNs !== m.toString()) settled = false;
      }
      if (settled) break;
    }
    await discoverCollections();
  }

  before(async () => {
    rad = await startRadicale({
      label: 'f2-busy',
      auth: { type: 'htpasswd', users: { 'caldes-svc': SVC_PASSWORD } },
      rights: { type: 'from_file', rules: SVC_RIGHTS_RULES },
    });
    svc = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0 });
    cal.lavoro = await fx.calendar({ key: 'lavoro', blocks_availability: true });
    cal.altro = await fx.calendar({ key: 'altro', blocks_availability: true });
    et = await fx.eventType({ key: 'decisione', durationMinutes: 60, slotIncrementMinutes: 30 });
    const init = await initializeVolume({ db: sql, client: svc, principal: P });
    assert.ok(init.collections.every((c) => c.status === 'created'));
    configureRadicaleRuntime({ client: svc, dataDir: rad.storageDir, principal: P, watch: 'auto', identitySource: 'auto' });
    updateWatchMode('mount', null);
    registerBookingJobs();
    await settleAll();
  });

  after(async () => {
    await stopCalendarWatcher();
    overrideCalendarStore(null);
    configureRadicaleRuntime(null);
    updateWatchMode('off', 'test concluso');
    svc?.close();
    await rad?.stop();
  });

  const book = (day: string, time: string, name: string, extra: Partial<Parameters<typeof createBooking>[0]> = {}) =>
    createBooking({ event_type_id: et.id, start: rome(day, time), attendee: attendee(name), source: 'public_page', require_available_slot: true, ...extra });

  test('Radicale fermo: senza modifiche la prenotazione è accettata senza HTTP; con una directory cambiata 503 e, da MCP, {error} senza code', async () => {
    overrideCalendarStore('radicale');
    const day = mondayAfter(21);
    const counting = countingTransport();
    const dead = new RadicaleClient({ baseUrl: 'http://127.0.0.1:9', password: 'x', retries: 0, timeoutMs: 500, transport: counting.transport });
    try {
      await settleAll();
      configureRadicaleRuntime({ client: dead });
      const ok = await book(day, '09:00', 'Cliente Fermo');
      fx.track('bookingIds', ok.booking.id);
      assert.equal(ok.booking.status, 'confirmed');
      assert.equal(ok.decision.degraded, null);
      assert.equal(counting.requests(), 0, 'nessuna richiesta verso Radicale');
      const [job] = await sql<Array<{ kind: string; status: string }>>`SELECT kind, status FROM cal_jobs WHERE key = ${ok.booking.uid}`;
      assert.deepEqual([job.kind, job.status], [CAL_JOB_KINDS.projectBooking, 'pending']);

      // Directory bloccante cambiata (PUT con il client vero) e Radicale fermo: 503.
      await svc.put(objectPath(P, cal.lavoro.slug, 'cambiato.ics'), ics('cambiato', rome(day, '16:00'), rome(day, '17:00')), { ifNoneMatch: '*' });
      await assert.rejects(
        book(day, '11:00', 'Cliente Rifiutato'),
        (err: unknown) => err instanceof CalendarUnavailableError && err.status === 503 && err.reason === 'collection_unsyncable',
      );
      const mcp = JSON.parse(await executeTool('create_booking', {
        event_type_slug: et.slug, start: rome(day, '11:00'), attendee_name: 'Cliente MCP', attendee_email: fx.email('mcp'),
      })) as Record<string, unknown>;
      assert.equal(typeof mcp.error, 'string');
      assert.equal('code' in mcp, false);
      const [n] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM calendar_bookings WHERE event_type_id = ${et.id} AND start_time = ${rome(day, '11:00')}`;
      assert.equal(n.n, 0, 'nessuna prenotazione su un calendario non verificato');
    } finally {
      configureRadicaleRuntime({ client: svc });
      counting.close();
      overrideCalendarStore(null);
    }
  });

  test('proiezione via job (decisione 3) e riprogrammazione sovrapposta all\'originale accettata', async () => {
    overrideCalendarStore('radicale');
    const day = mondayAfter(28);
    try {
      await settleAll();
      const created = await book(day, '09:00', 'Mario Rossi');
      fx.track('bookingIds', created.booking.id);
      await runCalendarJobsOnce({ limit: 10 });
      const href = `booking-${created.booking.uid}.ics`;
      const projection = await svc.get(objectPath(P, 'bookings', href));
      const text = projection.body.replace(/\r\n[ \t]/g, '');
      assert.match(text, new RegExp(`^UID:${created.booking.uid}@caldes\\.it$`, 'm'));
      assert.match(text, /^SUMMARY:.* – Mario Rossi$/m);
      assert.match(text, /Tel: \+39 333 0000000/);
      assert.match(text, /calendario\/prenotazioni\?uid=/);
      assert.doesNotMatch(text, /mailto:|ATTENDEE|test\.invalid/);
      assert.match(text, new RegExp(`^URL:${et.location_value!.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`, 'm'), 'link della riunione ricalcolato');
      const [indexed] = await sql<Array<{ kind: string; blocks: boolean }>>`
        SELECT o.kind, o.blocks FROM cal_occurrences o JOIN cal_objects ob ON ob.id = o.object_id
        WHERE ob.href = ${href}
      `;
      assert.deepEqual([indexed.kind, indexed.blocks], ['booking_projection', false], 'write-through: proiezione nell\'indice, non bloccante');

      const moved = await rescheduleBooking(created.booking.uid, rome(day, '09:30'), { by: 'attendee', require_available_slot: true });
      fx.track('bookingIds', moved.booking.id);
      assert.equal(new Date(moved.booking.start_time).toISOString(), rome(day, '09:30'));
      await runCalendarJobsOnce({ limit: 10 });
      await assert.rejects(svc.get(objectPath(P, 'bookings', href)), /404|not_found|non trovat/i);
      const next = await svc.get(objectPath(P, 'bookings', `booking-${moved.booking.uid}.ics`));
      assert.match(next.body, /DTSTART:\d{8}T\d{6}Z/);

      // Annullamento: la proiezione sparisce.
      await cancelBooking(moved.booking.uid, { cancelled_by: 'admin' });
      await runCalendarJobsOnce({ limit: 10 });
      await assert.rejects(svc.get(objectPath(P, 'bookings', `booking-${moved.booking.uid}.ics`)));
    } finally {
      overrideCalendarStore(null);
    }
  });

  test('evento comparso durante la decisione: prenotazione presa e conflitto registrato dopo il commit; evento già sotto una prenotazione admin: nessun conflitto', async () => {
    overrideCalendarStore('radicale');
    const day = mondayAfter(35);
    const counting = countingTransport();
    const hooked = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0, transport: counting.transport });
    try {
      await settleAll();
      configureRadicaleRuntime({ client: hooked });
      // La decisione sincronizza 'lavoro' (cambiata); durante quella sync un
      // device scrive in 'altro' un evento sopra l'orario richiesto.
      await svc.put(objectPath(P, cal.lavoro.slug, 'innesco.ics'), ics('innesco', rome(day, '17:00'), rome(day, '17:30')), { ifNoneMatch: '*' });
      counting.onNextReport(async () => {
        await sleep(5);
        await svc.put(objectPath(P, cal.altro.slug, 'intruso.ics'), ics('intruso', rome(day, '10:00'), rome(day, '10:45')), { ifNoneMatch: '*' });
      });
      const created = await book(day, '10:00', 'Cliente Conflitto');
      fx.track('bookingIds', created.booking.id);
      const conflicts = await sql<Array<{ detected_by: string; calendar_id: string; alerted_at: Date | null }>>`
        SELECT detected_by, calendar_id, alerted_at FROM cal_booking_conflicts WHERE booking_id = ${created.booking.id}
      `;
      assert.equal(conflicts.length, 1, 'conflitto registrato dal controllo post-commit');
      assert.equal(conflicts[0].detected_by, 'post_commit');
      assert.equal(conflicts[0].calendar_id, cal.altro.id);
      assert.ok(conflicts[0].alerted_at);
      const [still] = await sql<Array<{ status: string }>>`SELECT status FROM calendar_bookings WHERE id = ${created.booking.id}`;
      assert.equal(still.status, 'confirmed', 'nessun annullamento automatico');

      // Prenotazione admin sopra un evento esistente (decisione 2): non è un conflitto.
      await svc.put(objectPath(P, cal.lavoro.slug, 'sotto.ics'), ics('sotto', rome(day, '14:00'), rome(day, '15:00')), { ifNoneMatch: '*' });
      await settleAll();
      const admin = await createBooking({ event_type_id: et.id, start: rome(day, '14:00'), attendee: attendee('Cliente Admin'), source: 'admin_manual' });
      fx.track('bookingIds', admin.booking.id);
      assert.equal(admin.decision.preexisting.length, 1);
      const none = await sql`SELECT id FROM cal_booking_conflicts WHERE booking_id = ${admin.booking.id}`;
      assert.equal(none.length, 0);
    } finally {
      configureRadicaleRuntime({ client: svc });
      counting.close();
      overrideCalendarStore(null);
    }
  });

  test('RRULE invalida in una collezione bloccante: /slots 200 con busy conservativo (livello display, campanello vivo)', async () => {
    const day = mondayAfter(42);
    await svc.put(
      objectPath(P, cal.lavoro.slug, 'rrule-rotta.ics'),
      // Radicale (vobject) la accetta, calendar-core no: BYDAY ripetuto.
      ics('rrule-rotta', rome(day, '11:00'), rome(day, '12:00'), ['RRULE:FREQ=WEEKLY;BYDAY=MO;BYDAY=TU;UNTIL=' + stamp(rome(day, '23:00'))]),
      { ifNoneMatch: '*' },
    );
    await settleAll();
    const [object] = await sql<Array<{ health: string }>>`SELECT health FROM cal_objects WHERE calendar_id = ${cal.lavoro.id} AND href = 'rrule-rotta.ics'`;
    assert.equal(object.health, 'quarantined');
    await startCalendarWatcher({ intervalMs: 1_000 });
    overrideCalendarStore('radicale');
    try {
      await sleep(1_200);
      const res = await api.get(`/api/calendar/event-types/${et.slug}/slots`, { query: { from: day, to: day } });
      assert.equal(res.status, 200, res.text);
      const starts: string[] = res.json.slots.map((s: { start: string }) => s.start);
      assert.ok(starts.includes(rome(day, '09:00')), 'il mattino prima dell\'oggetto rotto resta prenotabile');
      assert.ok(!starts.includes(rome(day, '11:00')), 'l\'oggetto in quarantena blocca in modo conservativo');
      assert.ok(!starts.includes(rome(day, '15:00')), 'blocco conservativo fino a UNTIL');
    } finally {
      overrideCalendarStore(null);
      await stopCalendarWatcher();
    }
  });
});
