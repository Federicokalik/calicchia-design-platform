/**
 * Criterio di uscita della fase F3 da capo a fondo (piano F3, "Criterio di
 * uscita"; design §13.2-§13.8 e §16.4; decisioni 3, 5 e 8; contratto
 * docs/calendar-radicale/contracts/f3-modules.md), su una copia sintetica
 * della produzione, contro Radicale 3.7.8 reale e l'app HTTP reale.
 *
 * Copia sintetica costruita dai fatti dell'inventario del 2026-10-09
 * (docs/calendar-radicale/inventario-produzione-2026-10-09.md):
 *  - sei calendari con gli slug di produzione: c, f, lavoro, personale,
 *    bookings, scadenze, tutti con il feed ICS attivo (token da preservare);
 *  - `f` "Festività e chiusure" con is_system = false: 91 festività di sistema
 *    (sette anni del cron) e la chiusura manuale "Ferie";
 *  - in `c` la serie infinita lun-mar-gio-ven alle 09:00 di Roma, iniziata
 *    d'estate, con un EXDATE e un override salvati con l'ora UTC del DTSTART
 *    (firma del codice precedente al fix DST), la serie conclusa di giugno,
 *    singoli e copie fatte con "Duplica" (source_id = id dell'originale);
 *  - Prenotazioni con una proiezione confermata (email e telefono nella
 *    DESCRIPTION della riga legacy) e una prenotazione annullata;
 *  - un evento di lavoro con l'email del cliente nella descrizione e la sua
 *    copia fatta con "Duplica" dalla route; un all-day in personale e una
 *    scadenza;
 *  - un'iscrizione ICS (server HTTP locale) sul calendario lavoro, con
 *    impegni nelle prossime settimane;
 *  - un'app-password con username non canonico.
 *
 * Percorso, dalle route del wizard (/api/admin/calendar/migration) e
 * dall'esecutore reale dei run dove possibile:
 *  1. inventario e preflight su un volume vuoto, inizializzazione con le
 *     collezioni dagli slug di oggi, dichiarazioni, preflight pronto;
 *  2. anteprima con le anomalie attese, apply, seconda esecuzione a zero
 *     scritture;
 *  3. verifica V1-V5: solo verdi o gialli attesi, accettati;
 *  4. kill simulato a metà apply (risposta della PUT persa, worker fermato,
 *     job in lease scaduto come lo lascia un processo ucciso): il reaper non
 *     tocca il run, il lease scaduto lo riprende (tentativo 2), l'intento
 *     pendente si adotta senza scrivere, poi zero scritture;
 *  5. shadow attivo con l'apply di recupero; modifica legacy dall'admin di un
 *     evento a cui il device ha aggiunto VALARM e una X-prop: patch per campo,
 *     VALARM e X-prop preservati (riga adottata); giro notturno e orario della
 *     parità verdi, passo 5 del wizard in corso;
 *  5b. iscrizione: flag per singola iscrizione dalla route (sidecar invisibile
 *     al legacy, solo l'host del feed), collezione sub-* mancante creata solo
 *     da "Crea collezioni mancanti" (init create_missing);
 *  6. feed ICS pubblici: lo stesso token servito dallo store legacy e dallo
 *     store Radicale (indice sincronizzato da Radicale) pubblica gli stessi
 *     UID e le stesse istanze, salvo le differenze attese e documentate;
 *  7. erasure GDPR dalla route: prenotazione, righe legacy, audit_logs,
 *     ledger, righe dei run, job, indice e volume di Radicale senza email né
 *     telefono; seconda richiesta idempotente.
 * In ogni momento Postgres resta autorevole (mode postgres, nessun
 * write_freeze, nessun cutover), i token dei feed non cambiano e nessuna
 * MKCOL o MKCALENDAR parte fuori dal run di inizializzazione.
 *
 * Il preflight usa le dipendenze di produzione (defaultPreflightDeps con
 * RADICALE_PROBE_PASSWORD) tranne il control-plane (non avviato nei test) e il
 * campanello (remote mode dichiarata); il worker dei job è sostituito da giri
 * espliciti di runCalendarJobsOnce.
 *
 * Senza RADICALE_BIN la suite è saltata con il motivo.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, mock, test } from 'node:test';
import {
  expandObject,
  FEED_FUTURE_DAYS,
  FEED_PAST_DAYS,
  getTextValue,
  parseCalendarObject,
  parseIcs,
  splitCalendar,
} from '@calicchia/calendar-core';
import { invalidateBackendModeCache } from '../../src/lib/calendar/backend-mode';
import { clearIndexFeedCache } from '../../src/lib/calendar/feed-builder';
import { runCalendarJobsOnce, unregisterCalendarJobHandler } from '../../src/lib/calendar/jobs';
import { defaultPreflightDeps, runPreflightWith } from '../../src/lib/calendar/migration/preflight';
import { reapInterruptedRuns, registerMigrationRunJob, setMigrationRunHandlerOverride } from '../../src/lib/calendar/migration/runs';
import { registerShadowMirrorJob, runShadowHourlyParity, runShadowNightly } from '../../src/lib/calendar/migration/shadow';
import {
  MIGRATION_CONFIRMATIONS,
  MIGRATION_LIMITS,
  MIGRATION_LOCK_KEY,
  MIGRATION_RUN_JOB_KIND,
  type MigrationRunContext,
  type PreflightParams,
  SHADOW_MIRROR_JOB_KIND,
} from '../../src/lib/calendar/migration/types';
import { createNodeTransport, objectPath, RadicaleClient, type RadicaleTransport, TransportError, type TransportRequest } from '../../src/lib/calendar/radicale/client';
import type { ControlPlaneStatus, ControlPlaneTick } from '../../src/lib/calendar/radicale/heartbeat';
import { stopIndexWorker } from '../../src/lib/calendar/radicale/indexer';
import { CollectionSyncError, configureRadicaleRuntime, drainSyncs, invalidateIdentityCache, syncAllCollections } from '../../src/lib/calendar/radicale/sync';
import { overrideCalendarStore } from '../../src/lib/calendar/store';
import type { CalendarEvent } from '../../src/lib/calendar/types';
import { databaseNow, onBeforeDatabaseClose, resetCalendarBaseline, sql, useTestDatabase } from '../helpers/db';
import { romeIso, useFixtures } from '../helpers/fixtures';
import { api } from '../helpers/http';
import { RADICALE_PLUGINS_DIR, radicaleAvailability, type RadicaleServer, startRadicale, TEST_PRINCIPAL } from '../helpers/radicale';
import { buildProductionShape, type ProductionShape, rome } from '../calendar/_migration-init-shared';

useTestDatabase({ resetBaseline: true });
const fx = useFixtures('mig-f3-e2e');

const radicale = radicaleAvailability();
const P = TEST_PRINCIPAL;
const SVC_PASSWORD = 'test-only-svc-password-f3-e2e';
const PROBE_PASSWORD = 'test-only-probe-password-f3-e2e';
const BASE = '/api/admin/calendar/migration';
const DAY_MS = 86_400_000;
/** IP pubblico di documentazione (TEST-NET-3): accettato dalle difese SSRF del pull, riscritto verso il server locale. */
const FEED_HOST = '203.0.113.10';
const USER_COLLECTIONS = ['bookings', 'c', 'f', 'lavoro', 'personale', 'scadenze'];

/** Matrice dei permessi di caldes-svc e caldes-probe (contratto control-plane §8). */
const RIGHTS_RULES = [
  '[root]', 'user: .+', 'collection:', 'permissions: R', '',
  '[svc-principal]', 'user: caldes-svc', `collection: ${P}`, 'permissions: RW', '',
  '[svc-collections]', 'user: caldes-svc', `collection: ${P}/[^/]+`, 'permissions: rwD', '',
  '[probe-principal]', 'user: caldes-probe', `collection: ${P}`, 'permissions: R', '',
  '[probe-user-collections]', 'user: caldes-probe', `collection: ${P}/[^_/][^/]*`, 'permissions: r', '',
].join('\n');

const RUNNING_CONTROL_PLANE: ControlPlaneStatus = {
  running: true, listening: true, policyFile: '/tmp/policy.json', heartbeatFile: '/tmp/heartbeat.json', identitySource: 'remote',
  lastTick: null, lastSuccessAt: null, lastPolicyWriteAt: null, lastHeartbeatAt: null, consecutiveFailures: 0,
};

function okTick(): ControlPlaneTick {
  const now = new Date().toISOString();
  return {
    trigger: 'manual', startedAt: now, finishedAt: now, ok: true, failedStage: null, error: null, state: null, identity: null,
    policy: { written: true, previous: 'same', mode: 'shadow', version: 1, reasons: [] }, heartbeat: { ts: now },
  };
}

const VALARM = 'BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Promemoria\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\n';
const DEVICE_XPROP = 'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC\r\n';
const PHONE = '333 0000000';

// ─── Trasporto del runtime: registro delle richieste e guasti programmati ───────────────────────────────

interface Recorded { method: string; path: string }
interface Fault { match: (req: TransportRequest) => boolean; after: () => void }

/**
 * Trasporto node del client di runtime: registra ogni richiesta (per
 * dimostrare che MKCOL e MKCALENDAR partono solo dall'inizializzazione) e
 * applica i guasti programmati, una volta ciascuno: la richiesta arriva
 * davvero a Radicale, poi `after` (kill del worker) e la risposta si perde
 * (esito ignoto, come una connessione caduta).
 */
function recordingTransport(): { transport: RadicaleTransport; log: Recorded[]; inject(f: Fault): void; close(): void } {
  const node = createNodeTransport({ maxSockets: 4 });
  const log: Recorded[] = [];
  const faults: Fault[] = [];
  return {
    log,
    transport: async (req) => {
      log.push({ method: req.method, path: decodeURIComponent(req.url.pathname) });
      const i = faults.findIndex((f) => f.match(req));
      if (i < 0) return node(req);
      const [fault] = faults.splice(i, 1);
      await node(req);
      fault.after();
      throw new TransportError('network', 'connessione caduta dopo la PUT (kill simulato)', true, 'ECONNRESET');
    },
    inject: (f) => faults.push(f),
    close: () => node.close(),
  };
}

// ─── Feed remoto dell'iscrizione ───────────────────────────────

function icsUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Prossimo giorno feriale (lun-ven) a partire da `from` (YYYY-MM-DD). */
function weekdayOnOrAfter(from: Date): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 12));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Offset di Roma (ore) a mezzogiorno UTC di un giorno. */
function romeOffsetHours(date: string): number {
  const probe = new Date(`${date}T12:00:00Z`);
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', timeZoneName: 'shortOffset' })
    .formatToParts(probe).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+1';
  return Number(name.replace('GMT', '') || '0');
}

/** Primo giorno della settimana `weekday` (0 = domenica) in ora solare di Roma, da `from` in poi. */
function winterWeekday(weekday: number, from: Date): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 12));
  for (let i = 0; i < 400; i++) {
    const date = d.toISOString().slice(0, 10);
    if (d.getUTCDay() === weekday && romeOffsetHours(date) === 1) return date;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  throw new Error('nessun giorno in ora solare entro 400 giorni');
}

/** Istanze (non cancellate) per UID nella finestra del feed, come la verifica V5. */
function feedInstances(body: string, from: number, to: number): Map<string, Set<string>> {
  const parsed = parseIcs(body);
  assert.ok(parsed.ok, `feed illeggibile: ${parsed.ok ? '' : parsed.error.message}`);
  const out = new Map<string, Set<string>>();
  for (const obj of splitCalendar(parsed.value, { duplicateMasters: 'keep-first' }).objects) {
    const set = out.get(obj.uid) ?? new Set<string>();
    const res = expandObject(obj, { from, to, tz: 'Europe/Rome', computeRangeEnd: false });
    for (const o of res.occurrences) {
      if ((o.status ?? '').toUpperCase() === 'CANCELLED') continue;
      set.add(o.allDay && o.startDate && o.endDate ? `D${o.startDate}/${o.endDate}` : `${new Date(o.startUtc).toISOString()}/${new Date(o.endUtc).toISOString()}`);
    }
    out.set(obj.uid, set);
  }
  return out;
}

describe('criterio di uscita della F3 su una copia sintetica della produzione, contro Radicale reale', { skip: radicale.skip }, () => {
  let rad: RadicaleServer;
  let svc: RadicaleClient;
  let runtime: ReturnType<typeof recordingTransport>;
  let runtimeClient: RadicaleClient;
  let feedServer: Server;
  let restoreFetch: (() => void) | null = null;
  let uploadDir: string;
  let startedAt: string;
  const savedUploadEnv = process.env.CAL_MIGRATION_UPLOAD_DIR;

  let shape: ProductionShape;
  let clientEvent: CalendarEvent;
  let clientCopyId: string;
  let subscriptionId: string;
  let dstExdate: string;
  let dstThursday: string;
  let dstOverrideId: string;
  let feedTokens: Map<string, string>;
  let legacyRowsAtStart = 0;
  /** Intervalli del registro delle richieste coperti dai run di inizializzazione (le sole MKCOL/MKCALENDAR ammesse). */
  const initWindows: Array<[number, number]> = [];
  let feedPort = 0;
  let killRunId = '';
  const email = fx.email('cliente-conf');
  const subscriptionDays: string[] = [];

  // ─── Utilità ───────────────────────────────

  const pathOf = (collection: string, href: string): string => objectPath(P, collection, href);
  const key = (label: string): string => `f3-e2e-${label}-${randomUUID()}`;

  async function drainJobs(max = 40): Promise<void> {
    for (let i = 0; i < max; i++) {
      const r = await runCalendarJobsOnce({ limit: 5 });
      if (r.claimed === 0) return;
    }
  }

  /** Esegue subito i job shadow_mirror pending (salta il debounce di 2 s). */
  async function runShadowJobsNow(): Promise<void> {
    await sql`UPDATE cal_jobs SET run_after = now() WHERE kind = ${SHADOW_MIRROR_JOB_KIND} AND status = 'pending'`;
    await drainJobs();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function getRun(id: string): Promise<any> {
    const res = await api.get(`${BASE}/runs/${id}`, { auth: 'admin' });
    assert.equal(res.status, 200, res.text);
    return res.json;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function startRun(path: string, body: object, idempotencyKey: string | null = null): Promise<any> {
    const res = await api.post(`${BASE}${path}`, { auth: 'admin', body, headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {} });
    assert.equal(res.status, 202, `${path}: ${res.text}`);
    return res.json.run;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function runToEnd(path: string, body: object, idempotencyKey: string | null = null): Promise<any> {
    const run = await startRun(path, body, idempotencyKey);
    await drainJobs();
    const done = await getRun(run.id);
    assert.equal(done.status, 'succeeded', `${path}: ${JSON.stringify(done.error)} ${done.error_code ?? ''}`);
    return done;
  }

  /** Run d'inizializzazione dalla route, con l'intervallo delle sue richieste a Radicale. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function runInitRoute(body: object): Promise<{ run: any; created: string[] }> {
    const start = runtime.log.length;
    const run = await runToEnd('/init', body, key('init'));
    initWindows.push([start, runtime.log.length]);
    const created = runtime.log.slice(start).filter((r) => r.method === 'MKCOL' || r.method === 'MKCALENDAR').map((r) => r.path.split('/').filter(Boolean).pop() ?? '');
    return { run, created };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function wizard(): Promise<any> {
    invalidateIdentityCache();
    const res = await api.get(`${BASE}/state`, { auth: 'admin' });
    assert.equal(res.status, 200, res.text);
    return res.json;
  }

  const statuses = (s: { wizard: { steps: Array<{ status: string }> } }): string[] => s.wizard.steps.map((x) => x.status);

  /** Postgres autorevole: mode postgres, nessun write_freeze, nessun cutover né rollback. */
  async function assertPostgresAuthoritative(when: string): Promise<void> {
    const [st] = await sql<Array<{ mode: string; write_freeze: boolean; cutover_at: Date | null; rollback_until: Date | null; finalized_at: Date | null }>>`
      SELECT mode, write_freeze, cutover_at, rollback_until, finalized_at FROM calendar_backend_state WHERE id = true
    `;
    assert.deepEqual({ mode: st.mode, write_freeze: st.write_freeze, cutover_at: st.cutover_at, rollback_until: st.rollback_until, finalized_at: st.finalized_at },
      { mode: 'postgres', write_freeze: false, cutover_at: null, rollback_until: null, finalized_at: null }, `Postgres autorevole (${when})`);
  }

  async function liveRow(legacyKey: string): Promise<{ href: string; collection_name: string; written_etag: string | null; intent_op: string | null; adopted: boolean; legacy_hash: string | null }> {
    const rows = await sql<Array<{ href: string; collection_name: string; written_etag: string | null; intent_op: string | null; adopted: boolean; legacy_hash: string | null }>>`
      SELECT href, collection_name, written_etag, intent_op, adopted, legacy_hash
      FROM cal_migration_ledger WHERE legacy_key = ${legacyKey} AND deleted_at IS NULL
    `;
    assert.equal(rows.length, 1, `una riga viva del ledger per ${legacyKey}`);
    return rows[0];
  }

  async function getObject(collection: string, href: string): Promise<{ etag: string | null; body: string } | null> {
    try {
      const got = await svc.get(pathOf(collection, href));
      return { etag: got.etag, body: got.body };
    } catch {
      return null;
    }
  }

  async function migrationLockHeld(): Promise<boolean> {
    const [{ held }] = await sql<Array<{ held: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_locks l WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
          AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtext(${MIGRATION_LOCK_KEY})::bigint
      ) AS held
    `;
    return held;
  }

  /** GET del feed pubblico dalla route reale, con lo store che la facade sceglie in quel momento. */
  async function fetchFeed(token: string): Promise<{ status: number; body: string; etag: string | null }> {
    const res = await api.get(`/api/calendar/feed/${token}.ics`);
    return { status: res.status, body: res.text, etag: res.headers.get('etag') };
  }

  async function syncIndexFromRadicale(): Promise<void> {
    const results = await syncAllCollections({ reason: 'manual' });
    const failed = results.filter((r): r is CollectionSyncError => r instanceof CollectionSyncError);
    assert.equal(failed.length, 0, failed.map((e) => `${e.calendarId} ${e.code}: ${e.message}`).join('; '));
  }

  // ─── Copia sintetica della produzione ───────────────────────────────

  before(async () => {
    startedAt = await databaseNow();

    // Feed remoto dell'iscrizione: server locale, fetch riscritto solo per FEED_HOST.
    feedServer = createServer((req, res) => {
      if (new URL(req.url ?? '/', 'http://feed.local').pathname !== '/remoto.ics') {
        res.writeHead(404).end();
        return;
      }
      const events = subscriptionDays.flatMap((date, i) => [
        'BEGIN:VEVENT', `UID:impegno-remoto-${i}@google.test`, `DTSTAMP:${icsUtc(Date.now())}`,
        `DTSTART:${icsUtc(Date.parse(rome(date, '10:00')))}`, `DTEND:${icsUtc(Date.parse(rome(date, '11:00')))}`,
        `SUMMARY:Impegno remoto ${i + 1}`, 'END:VEVENT',
      ]);
      res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8' });
      res.end(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', ...events, 'END:VCALENDAR', ''].join('\r\n'));
    });
    await new Promise<void>((resolve) => feedServer.listen(0, '127.0.0.1', resolve));
    const realFetch = globalThis.fetch;
    const m = mock.method(globalThis, 'fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      if (url.hostname === FEED_HOST) url.hostname = '127.0.0.1';
      return realFetch(url, init);
    });
    restoreFetch = () => m.mock.restore();

    rad = await startRadicale({
      label: 'f3-e2e',
      auth: { type: 'htpasswd', users: { 'caldes-svc': SVC_PASSWORD, 'caldes-probe': PROBE_PASSWORD } },
      rights: { type: 'from_file', rules: RIGHTS_RULES },
      pythonPath: [RADICALE_PLUGINS_DIR],
    });
    svc = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0 });
    runtime = recordingTransport();
    runtimeClient = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0, transport: runtime.transport });
    configureRadicaleRuntime({ client: runtimeClient, dataDir: rad.storageDir, principal: P, watch: 'off', identitySource: 'remote' });
    uploadDir = await mkdtemp(join(tmpdir(), 'caldes-f3-e2e-upload-'));
    process.env.CAL_MIGRATION_UPLOAD_DIR = uploadDir;

    await resetCalendarBaseline();
    // 91 festività (sette anni del cron) e "Ferie" in f, serie e copie in c, prenotazioni.
    shape = await buildProductionShape(fx);
    assert.equal(shape.holidays, 91);
    await sql`UPDATE calendars SET ics_feed_enabled = true WHERE role <> 'subscription'`;

    // Eccezioni DST della serie infinita (iniziata d'estate alle 07:00Z) salvate con l'ora UTC del
    // DTSTART in ora solare, come le scriveva il codice precedente al fix: 07:00Z = 08:00 di Roma.
    // Sempre oltre la finestra del giro orario V4 (v4HourlyDays, più un margine): il giro orario del passo 5
    // resta verde in qualunque giorno della settimana, mentre V3, V4 notturno (180 giorni) e feed le vedono.
    const winterFrom = new Date(Math.max(Date.now() + (MIGRATION_LIMITS.v4HourlyDays + 3) * DAY_MS, Date.parse('2026-10-26T12:00:00Z')));
    const monday = winterWeekday(1, winterFrom);
    const thursday = winterWeekday(4, new Date(Date.parse(`${monday}T12:00:00Z`) + DAY_MS));
    dstExdate = `${monday}T07:00:00.000Z`;
    dstThursday = thursday;
    await sql`UPDATE calendar_events SET exdates = ${sql.json([dstExdate] as never)} WHERE id = ${shape.infiniteSeries.id}`;
    const [override] = await sql<Array<{ id: string }>>`
      INSERT INTO calendar_events (calendar_id, uid, summary, location, start_time, end_time, all_day, recurrence_id, recurrence_master_id, source, status)
      VALUES (${shape.c.id}, ${`${randomUUID()}@caldes.it`}, 'Gestione Creattivamente (spostata)', 'Sede del cliente',
              ${`${thursday}T10:00:00.000Z`}, ${`${thursday}T11:00:00.000Z`}, false, ${`${thursday}T07:00:00.000Z`}, ${shape.infiniteSeries.id}, 'admin', 'confirmed')
      RETURNING id::text AS id
    `;
    dstOverrideId = override.id;
    fx.track('eventIds', dstOverrideId);

    // Lavoro: riunione con l'email del cliente nella descrizione e la sua copia "Duplica" dalla route.
    const meetingDay = weekdayOnOrAfter(new Date(Date.now() + 20 * DAY_MS));
    const created = await api.post('/api/admin/calendar/events', {
      auth: 'admin',
      body: {
        calendar_id: shape.lavoro.id, summary: fx.name('Riunione con il cliente'), description: `Contatto: ${email}`,
        location: 'Studio', start_time: rome(meetingDay, '10:00'), end_time: rome(meetingDay, '11:00'),
      },
    });
    assert.equal(created.status, 200, created.text);
    clientEvent = created.json.event;
    fx.track('eventIds', clientEvent.id);
    const copy = await api.post(`/api/admin/calendar/events/${clientEvent.id}/duplicate`, { auth: 'admin', body: { shiftMinutes: 7 * 24 * 60 } });
    assert.equal(copy.status, 200, copy.text);
    clientCopyId = copy.json.event.id;
    fx.track('eventIds', clientCopyId);
    assert.equal(copy.json.event.source_id, clientEvent.id);

    // Personale: un giorno intero; Scadenze: una scadenza.
    const personale = await sql<Array<{ id: string }>>`SELECT id::text AS id FROM calendars WHERE slug = 'personale'`;
    const scadenze = await sql<Array<{ id: string }>>`SELECT id::text AS id FROM calendars WHERE slug = 'scadenze'`;
    const allDayDate = weekdayOnOrAfter(new Date(Date.now() + 30 * DAY_MS));
    const allDayEnd = new Date(Date.parse(`${allDayDate}T12:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
    for (const [calendarId, summary] of [[personale[0].id, 'Visita medica'], [scadenze[0].id, 'Scadenza F24']] as const) {
      const r = await api.post('/api/admin/calendar/events', {
        auth: 'admin',
        body: { calendar_id: calendarId, summary: fx.name(summary), all_day: true, start_time: romeIso(allDayDate), end_time: romeIso(allDayEnd) },
      });
      assert.equal(r.status, 200, r.text);
      fx.track('eventIds', r.json.event.id);
    }

    // Iscrizione ICS su lavoro (bloccante) con due impegni nelle prossime settimane. Le righe legacy
    // arrivano dagli eventi già letti (il parser legacy scarta i VEVENT di un VCALENDAR: bug noto, design
    // §14); lo stesso feed lo serve il server locale al pull verso l'indice del sidecar.
    subscriptionDays.push(weekdayOnOrAfter(new Date(Date.now() + 8 * DAY_MS)), weekdayOnOrAfter(new Date(Date.now() + 15 * DAY_MS)));
    feedPort = (feedServer.address() as AddressInfo).port;
    const sub = await fx.subscription({
      calendar: shape.lavoro,
      name: 'Google del cliente',
      url: `http://${FEED_HOST}:${feedPort}/remoto.ics?token=segreto-del-feed`,
      events: subscriptionDays.map((date, i) => ({
        remote_uid: `impegno-remoto-${i}@google.test`, summary: `Impegno remoto ${i + 1}`, description: null, location: null, url: null,
        start_time: rome(date, '10:00'), end_time: rome(date, '11:00'), all_day: false, rrule: null, exdates: [], recurrence_id: null, status: 'confirmed' as const,
      })),
    });
    subscriptionId = sub.subscription.id;
    assert.equal(sub.events.length, 2);

    // App-password con username non canonico (diverso dal principal, non riservato).
    await fx.appPassword({ username: 'Federico.iPhone', device: 'iPhone di Federico' });

    feedTokens = new Map(
      (await sql<Array<{ slug: string; ics_feed_token: string }>>`SELECT slug, ics_feed_token FROM calendars WHERE role <> 'subscription'`)
        .map((r) => [r.slug, r.ics_feed_token]),
    );
    assert.deepEqual([...feedTokens.keys()].sort(), USER_COLLECTIONS);
    const [{ n }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM calendar_events`;
    legacyRowsAtStart = n;
    assert.ok(n >= 100 && n <= 120, `circa 100 righe come in produzione: ${n}`);

    registerMigrationRunJob();
    registerShadowMirrorJob();
    // Dipendenze di produzione del preflight (probe con RADICALE_PROBE_PASSWORD), salvo control-plane e campanello.
    setMigrationRunHandlerOverride('preflight', (ctx: MigrationRunContext<PreflightParams>) => runPreflightWith(ctx, {
      ...defaultPreflightDeps({ ...process.env, RADICALE_PROBE_PASSWORD: PROBE_PASSWORD }),
      watch: () => ({ mode: 'remote', reason: 'stack di test senza mount del volume' }),
      controlPlane: () => ({ status: RUNNING_CONTROL_PLANE, sync: async () => okTick() }),
    }));
  });

  onBeforeDatabaseClose(async () => {
    overrideCalendarStore(null);
    invalidateBackendModeCache();
    await drainSyncs(10_000).catch(() => undefined);
    await stopIndexWorker();
    configureRadicaleRuntime(null);
    setMigrationRunHandlerOverride('preflight', null);
    unregisterCalendarJobHandler(MIGRATION_RUN_JOB_KIND);
    unregisterCalendarJobHandler(SHADOW_MIRROR_JOB_KIND);
    await resetCalendarBaseline();
    // Audit dei dati di questo file (eventi, prenotazioni, iscrizioni, calendari e azioni del wizard).
    if (startedAt) {
      await sql`
        DELETE FROM audit_logs
        WHERE created_at >= ${startedAt}::timestamptz
          AND table_name IN ('calendars', 'calendar_events', 'calendar_subscriptions', 'calendar_bookings', 'calendar_migration')
      `;
    }
  });

  after(async () => {
    if (savedUploadEnv === undefined) delete process.env.CAL_MIGRATION_UPLOAD_DIR;
    else process.env.CAL_MIGRATION_UPLOAD_DIR = savedUploadEnv;
    restoreFetch?.();
    if (feedServer) await new Promise<void>((resolve) => feedServer.close(() => resolve()));
    runtimeClient?.close();
    runtime?.close();
    svc?.close();
    await rad?.stop();
    if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
  });

  // ─── 1. Inventario, preflight e inizializzazione ───────────────────────────────

  test('1. inventario e preflight su un volume vuoto, inizializzazione con gli slug di produzione, preflight pronto', async () => {
    await assertPostgresAuthoritative('prima del wizard');
    let s = await wizard();
    assert.equal(s.radicale.configured, true);
    assert.equal(s.backend.mode, 'postgres');
    // Dalla F4 il passo 6 (passaggio) esiste: bloccato finché i criteri del cutover non sono soddisfatti.
    assert.deepEqual(statuses(s), ['todo', 'locked', 'locked', 'locked', 'locked', 'locked']);

    // Inventario in sola lettura con le anomalie della produzione.
    const inv = await runToEnd('/inventory', {});
    const byslug = (slug: string) => inv.summary.calendars.find((c: { slug: string }) => c.slug === slug);
    assert.equal(byslug('f').counts.holidays_system, 91);
    assert.equal(byslug('f').counts.closures, 1);
    assert.equal(byslug('f').is_system, false);
    assert.equal(byslug('c').counts.series, 2);
    assert.equal(byslug('bookings').counts.projections, 1);
    for (const code of ['DST_SHIFTED_EXCEPTION', 'POSSIBLE_DUPLICATE', 'NON_CANONICAL_APP_PASSWORD', 'SUBSCRIPTION_BLOCKING_IMPACT']) {
      assert.ok((inv.summary.anomalies[code] ?? 0) > 0, `anomalia ${code} nell'inventario: ${JSON.stringify(inv.summary.anomalies)}`);
    }
    assert.equal(inv.summary.app_passwords.non_canonical, 1);
    assert.equal(inv.summary.app_passwords.reserved, 0);
    assert.equal(inv.summary.subscriptions.length, 1);
    assert.equal(inv.summary.subscriptions[0].events_legacy, 2);
    const invItems = await api.get(`${BASE}/runs/${inv.id}/items`, { auth: 'admin', query: { item_type: 'anomaly', limit: 500 } });
    assert.ok(!invItems.text.toLowerCase().includes(email), 'nessuna email nelle righe dell\'inventario');
    assert.ok(!invItems.text.includes(PHONE), 'nessun telefono nelle righe dell\'inventario');

    // Preflight su un volume vuoto: si propone l'inizializzazione; probe reale in sola lettura.
    const pf1 = await runToEnd('/preflight', { probe_public_url: false });
    assert.equal(pf1.summary.can_initialize, true);
    assert.equal(pf1.summary.identity, 'uninitialized');

    // Un solo run alla volta: un secondo run mentre il primo è in coda → MIGRATION_BUSY.
    const queued = await startRun('/preflight', { probe_public_url: false });
    const busy = await api.post(`${BASE}/inventory`, { auth: 'admin', body: {} });
    assert.equal(busy.status, 409, busy.text);
    assert.equal(busy.json.code, 'MIGRATION_BUSY');
    await drainJobs();
    assert.equal((await getRun(queued.id)).status, 'succeeded');

    // Inizializzazione con la conferma: marker, collezioni con lo slug di oggi, _canary.
    const { run: init, created } = await runInitRoute({ action: 'initialize', confirm: MIGRATION_CONFIRMATIONS.initialize });
    assert.equal(init.summary.epoch, 1);
    for (const name of [...USER_COLLECTIONS, '_canary']) assert.ok(created.includes(name), `collezione ${name} creata dall'init: ${JSON.stringify(created)}`);
    s = await wizard();
    assert.equal(s.identity.status, 'ok');
    assert.equal(s.backend.epoch, 1);
    assert.ok(s.backend.volume_id);

    // Dichiarazioni: niente Fase 0, remote mode, 401 pubblico verificato con curl, backup verificato.
    for (const body of [
      { key: 'phase0', value: { status: 'absent', note: 'nessun volume della Fase 0 sul server' }, confirm: MIGRATION_CONFIRMATIONS.declare },
      { key: 'remote_mode_accepted', value: { reason: 'stack di test senza mount' }, confirm: MIGRATION_CONFIRMATIONS.declare },
      { key: 'public_401_verified', value: { method: 'curl' }, confirm: MIGRATION_CONFIRMATIONS.declare },
      { key: 'backup_verified', value: { note: 'backup coordinato della copia' }, confirm: MIGRATION_CONFIRMATIONS.declare },
    ]) {
      const res = await api.post(`${BASE}/declarations`, { auth: 'admin', body });
      assert.equal(res.status, 200, res.text);
    }
    const pf2 = await runToEnd('/preflight', { probe_public_url: false });
    const notReady = pf2.summary.checks.filter((c: { status: string }) => c.status === 'fail' || c.status === 'confirm');
    assert.equal(pf2.summary.ready, true, JSON.stringify(notReady));
    const checks = new Map<string, string>(pf2.summary.checks.map((c: { code: string; status: string }) => [c.code, c.status]));
    assert.equal(checks.get('PROBE_READONLY'), 'pass', 'probe caldes-probe in sola lettura');
    assert.equal(checks.get('PROBE_CANARY_FORBIDDEN'), 'pass', 'PUT del probe su _canary respinta con 403');
    assert.equal(checks.get('IDENTITY'), 'pass');
    assert.equal(checks.get('DST_EXCEPTIONS'), 'warn', 'eccezioni DST ancora in PG: avviso, non blocco');
    s = await wizard();
    assert.deepEqual(statuses(s).slice(0, 3), ['done', 'todo', 'locked']);
    await assertPostgresAuthoritative('dopo l\'inizializzazione');
  });

  // ─── 2. Anteprima, apply, seconda esecuzione ───────────────────────────────

  test('2. anteprima con le anomalie attese, apply, seconda esecuzione a zero scritture', async () => {
    const plan = await runToEnd('/plan', { options: {} });
    const preview = plan.summary.preview;
    assert.equal(plan.summary.totals.conflict, 0, JSON.stringify(plan.summary.conflicts));
    assert.deepEqual(preview.blocking, []);
    assert.equal(plan.summary.totals.create, plan.summary.writes);
    const codes = new Set(preview.anomalies.map((a: { code: string }) => a.code));
    for (const code of ['DST_SHIFTED_EXCEPTION', 'POSSIBLE_DUPLICATE', 'UNTIL_ADMIN_PATTERN']) assert.ok(codes.has(code), `anomalia ${code} nell'anteprima: ${[...codes].join(', ')}`);
    assert.deepEqual(preview.calendars.map((c: { collection_name: string }) => c.collection_name).sort(), USER_COLLECTIONS);
    // Iscrizioni mai copiate, con i default della decisione 5 e l'impatto.
    assert.equal(preview.subscriptions.length, 1);
    assert.deepEqual(preview.subscription_defaults, { blocks_availability: false, device_visible: false });
    assert.ok(preview.fixed_rules.some((r: { key: string; affected: number }) => r.key === 'subscriptions_not_copied' && r.affected === 1));
    const f = preview.calendars.find((c: { collection_name: string }) => c.collection_name === 'f');
    assert.equal(f.counts.create, 92, '91 festività più Ferie');

    const apply1 = await runToEnd('/apply', { plan_run_id: plan.id, confirm: MIGRATION_CONFIRMATIONS.apply }, key('apply1'));
    assert.equal(apply1.summary.writes.create, plan.summary.totals.create);
    assert.equal(apply1.summary.failed, 0);
    assert.deepEqual(apply1.summary.conflicts, {});
    // Ogni collezione utente ha tutti i suoi oggetti: f con 92 risorse.
    const fObjects = await svc.propfind(`/${P}/f/`, { depth: 1 });
    assert.equal(fObjects.responses.filter((r) => r.path.endsWith('.ics')).length, 92);
    // La proiezione su Radicale non porta l'email (decisione 3), il telefono sì.
    const proj = await liveRow(`booking:${shape.confirmedBookingUid}`);
    const projBody = (await getObject(proj.collection_name, proj.href))?.body ?? '';
    assert.ok(projBody.includes(PHONE), 'telefono nella proiezione');
    assert.ok(!projBody.toLowerCase().includes(email), 'mai l\'email nella proiezione');

    // Seconda esecuzione: nuova anteprima e apply al 100% senza scritture.
    const plan2 = await runToEnd('/plan', {});
    assert.equal(plan2.summary.writes, 0);
    const apply2 = await runToEnd('/apply', { plan_run_id: plan2.id, confirm: MIGRATION_CONFIRMATIONS.apply }, key('apply2'));
    assert.equal(apply2.summary.zero_writes, true);
    const s = await wizard();
    assert.deepEqual(statuses(s).slice(1, 4), ['done', 'done', 'todo']);
    await assertPostgresAuthoritative('dopo l\'apply');
  });

  // ─── 3. Verifica ───────────────────────────────

  test('3. verifica V1-V5: solo verdi o gialli attesi, accettati dal wizard', async () => {
    const verify = await runToEnd('/verify', {});
    assert.notEqual(verify.summary.overall, 'red', JSON.stringify(verify.summary.calendars));
    for (const cal of verify.summary.calendars) assert.notEqual(cal.color, 'red', `${cal.collection_name ?? cal.calendar_id}: ${JSON.stringify(cal)}`);
    const reds = await api.get(`${BASE}/runs/${verify.id}/items`, { auth: 'admin', query: { item_type: 'diff', severity: 'error', limit: 500 } });
    assert.equal(reds.json.items.length, 0, JSON.stringify(reds.json.items.slice(0, 5)));
    const diffs = await api.get(`${BASE}/runs/${verify.id}/items`, { auth: 'admin', query: { item_type: 'diff', limit: 500 } });
    // Le eccezioni DST riallineate sono gialle attese (DST_REALIGNED), mai rosse.
    const reasons = new Set(diffs.json.items.map((d: { detail: { reason: string | null } }) => d.detail.reason));
    assert.ok(diffs.json.items.every((d: { expected: boolean }) => d.expected === true), JSON.stringify(diffs.json.items.filter((d: { expected: boolean }) => !d.expected).slice(0, 3)));
    assert.ok(reasons.has('DST_REALIGNED'), `differenze attese: ${[...reasons].join(', ')}`);
    let s = await wizard();
    if (verify.summary.overall === 'yellow') {
      assert.equal(s.wizard.steps[3].status, 'attention');
      const accepted = await api.post(`${BASE}/runs/${verify.id}/accept`, { auth: 'admin', body: { all_expected: true, confirm: MIGRATION_CONFIRMATIONS.accept } });
      assert.equal(accepted.status, 200, accepted.text);
      assert.equal(accepted.json.acceptable, true);
      s = await wizard();
    }
    assert.equal(s.wizard.steps[3].status, 'done', JSON.stringify(s.wizard.steps[3]));
    // Report senza dati personali.
    const report = await api.get(`${BASE}/runs/${verify.id}/report`, { auth: 'admin', query: { format: 'json' } });
    assert.equal(report.status, 200);
    assert.ok(!report.text.toLowerCase().includes(email) && !report.text.includes(PHONE), 'report senza email né telefono');
  });

  // ─── 4. Kill a metà apply e ripresa ───────────────────────────────

  test('4. kill simulato a metà apply: run ripreso dal lease scaduto, intento pendente adottato senza scrivere, poi zero scritture', async () => {
    // Sei eventi nuovi in personale dall'admin: l'apply deve crearli.
    const personale = await sql<Array<{ id: string }>>`SELECT id::text AS id FROM calendars WHERE slug = 'personale'`;
    const newIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const day = weekdayOnOrAfter(new Date(Date.now() + (40 + i) * DAY_MS));
      const r = await api.post('/api/admin/calendar/events', {
        auth: 'admin',
        body: { calendar_id: personale[0].id, summary: fx.name(`Allenamento ${i + 1}`), start_time: rome(day, '18:00'), end_time: rome(day, '19:00') },
      });
      assert.equal(r.status, 200, r.text);
      newIds.push(r.json.event.id);
      fx.track('eventIds', r.json.event.id);
    }
    const plan = await runToEnd('/plan', {});
    assert.equal(plan.summary.writes, 6);
    assert.equal(plan.summary.totals.create, 6);

    // Alla terza PUT di creazione in personale la risposta si perde e il worker viene fermato.
    const killer = new AbortController();
    let creates = 0;
    runtime.inject({
      match: (req) => req.method === 'PUT' && req.headers['If-None-Match'] === '*' && decodeURIComponent(req.url.pathname).startsWith(`/${P}/personale/`) && ++creates === 3,
      after: () => killer.abort(new Error('processo API ucciso (test)')),
    });
    const run = await startRun('/apply', { plan_run_id: plan.id, confirm: MIGRATION_CONFIRMATIONS.apply }, key('apply-kill'));
    killRunId = run.id;
    await runCalendarJobsOnce({ limit: 1, signal: killer.signal });
    // L'esecuzione in corso si ferma al primo punto sicuro e rilascia il lock.
    for (let i = 0; i < 100 && (await migrationLockHeld()); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(await migrationLockHeld(), false, 'lock cal-migration rilasciato');

    const interrupted = await getRun(run.id);
    assert.equal(interrupted.status, 'running', 'il run resta running: lo riprende il prossimo esecutore');
    assert.equal(interrupted.attempts, 1);
    const rows = await Promise.all(newIds.map((id) => sql<Array<{ href: string; written_etag: string | null; intent_op: string | null }>>`
      SELECT href, written_etag, intent_op FROM cal_migration_ledger WHERE legacy_key = ${`event:${id}`} AND deleted_at IS NULL
    `));
    const written = rows.filter((r) => r[0]?.written_etag).length;
    const pending = rows.filter((r) => r[0]?.intent_op === 'create' && !r[0].written_etag).map((r) => r[0]);
    assert.equal(written, 2, 'due create completate prima del kill');
    assert.equal(pending.length, 1, 'un intento pendente: la PUT è arrivata, l\'esito no');
    assert.ok(await getObject('personale', pending[0].href), 'la risorsa dell\'intento pendente esiste su Radicale');
    const pendingPath = pathOf('personale', pending[0].href);

    // Stato che lascia un processo ucciso: job in lease (scaduto), run running senza battito recente.
    await sql`
      UPDATE cal_jobs SET status = 'running', lease_token = gen_random_uuid(), locked_by = 'api-uccisa:1',
                          locked_until = now() - interval '1 second', finished_at = NULL
      WHERE kind = ${MIGRATION_RUN_JOB_KIND} AND key = ${run.id}
    `;
    await sql`UPDATE cal_migration_runs SET heartbeat_at = now() - interval '10 minutes' WHERE id = ${run.id}::uuid`;
    assert.equal(await reapInterruptedRuns(), 0, 'il reaper non chiude un run il cui job può ancora riprendere');

    // Riavvio: il lease scaduto torna in coda e lo stesso run riprende (tentativo 2).
    const mark = runtime.log.length;
    await drainJobs();
    const resumed = await getRun(run.id);
    assert.equal(resumed.status, 'succeeded', JSON.stringify(resumed.error));
    assert.equal(resumed.attempts, 2);
    assert.equal(resumed.summary.attempt, 2);
    assert.equal(resumed.summary.previous_attempt_writes, 2);
    assert.equal(resumed.summary.adopted, 1, JSON.stringify(resumed.summary));
    assert.equal(resumed.summary.writes.create, 5, 'cinque create in tutto: l\'oggetto adottato non si riscrive');
    assert.equal(resumed.summary.failed, 0);
    const resumedPuts = runtime.log.slice(mark).filter((r) => r.method === 'PUT');
    assert.equal(resumedPuts.length, 3);
    assert.ok(!resumedPuts.some((r) => r.path === pendingPath), 'nessuna PUT sull\'oggetto adottato');
    for (const id of newIds) {
      const row = await liveRow(`event:${id}`);
      assert.equal(row.intent_op, null);
      assert.ok(row.written_etag);
    }
    const personaleObjects = await svc.propfind(`/${P}/personale/`, { depth: 1 });
    assert.equal(personaleObjects.responses.filter((r) => r.path.endsWith('.ics')).length, 7, 'nessun duplicato: il giorno intero di prima più i sei nuovi');

    // Riesecuzione: anteprima e apply a zero scritture.
    const plan2 = await runToEnd('/plan', {});
    assert.equal(plan2.summary.writes, 0);
    const again = await runToEnd('/apply', { plan_run_id: plan2.id, confirm: MIGRATION_CONFIRMATIONS.apply }, key('apply-after-kill'));
    assert.equal(again.summary.zero_writes, true);
    await assertPostgresAuthoritative('dopo la ripresa');
  });

  // ─── 5. Shadow, VALARM del device e parità ───────────────────────────────

  test('5. shadow attivo: modifica legacy su un evento con VALARM del device, VALARM preservato, parità verde', async () => {
    // Verifica completa dopo gli ultimi apply (lo shadow la richiede verde o con i gialli accettati).
    const verify = await runToEnd('/verify', {});
    assert.equal(verify.summary.acceptable, true, `accettazioni riportate per firma: ${JSON.stringify(verify.summary.calendars)}`);

    const on = await api.post(`${BASE}/shadow`, { auth: 'admin', body: { enabled: true, confirm: MIGRATION_CONFIRMATIONS.shadowOn } });
    assert.equal(on.status, 200, on.text);
    assert.equal(on.json.shadow_enabled, true);
    assert.ok(on.json.catch_up_run, 'apply di recupero accodato');
    await drainJobs();
    const catchUp = await getRun(on.json.catch_up_run.id);
    assert.equal(catchUp.status, 'succeeded', JSON.stringify(catchUp.error));
    assert.equal(catchUp.trigger, 'shadow');
    assert.equal(catchUp.summary.zero_writes, true);

    // Il device aggiunge un promemoria e una X-prop all'evento (PUT con If-Match come un client CalDAV).
    const legacyKey = `event:${clientEvent.id}`;
    const row = await liveRow(legacyKey);
    const current = await svc.get(pathOf(row.collection_name, row.href));
    await svc.put(pathOf(row.collection_name, row.href), current.body.replace(/END:VEVENT\r?\n/, `${DEVICE_XPROP}${VALARM}END:VEVENT\r\n`), { ifMatch: current.etag! });

    // Modifica legacy dall'admin: titolo, luogo e orario spostato di un'ora.
    await sql`DELETE FROM cal_jobs WHERE kind = ${SHADOW_MIRROR_JOB_KIND}`;
    const newStart = new Date(Date.parse(clientEvent.start_time) + 3_600_000).toISOString();
    const newEnd = new Date(Date.parse(clientEvent.end_time) + 3_600_000).toISOString();
    const put = await api.put(`/api/admin/calendar/events/${clientEvent.id}`, {
      auth: 'admin', body: { summary: fx.name('Riunione con il cliente (spostata)'), location: 'Sala riunioni', start_time: newStart, end_time: newEnd },
    });
    assert.equal(put.status, 200, put.text);
    const queued = await sql<Array<{ status: string }>>`SELECT status FROM cal_jobs WHERE kind = ${SHADOW_MIRROR_JOB_KIND} AND key = ${legacyKey}`;
    assert.equal(queued.length, 1, 'il trigger della 165 accoda un job shadow_mirror');
    await runShadowJobsNow();
    const [job] = await sql<Array<{ status: string; result: { items?: Array<{ action: string; outcome: string; fields: string[] }> } | null; last_error: string | null }>>`
      SELECT status, result, last_error FROM cal_jobs WHERE kind = ${SHADOW_MIRROR_JOB_KIND} AND key = ${legacyKey}
    `;
    assert.equal(job.status, 'done', job.last_error ?? '');
    const items = job.result?.items ?? [];
    assert.equal(items.length, 1);
    assert.equal(items[0].action, 'update');
    assert.equal(items[0].outcome, 'done');
    for (const field of ['summary', 'location', 'start', 'end']) assert.ok(items[0].fields.includes(field), `campo ${field} nella patch: ${items[0].fields.join(', ')}`);

    const got = await svc.get(pathOf(row.collection_name, row.href));
    const parsed = parseCalendarObject(got.body);
    assert.ok(parsed.ok && parsed.value.master);
    assert.equal(getTextValue(parsed.value.master, 'SUMMARY'), fx.name('Riunione con il cliente (spostata)'));
    assert.equal(getTextValue(parsed.value.master, 'LOCATION'), 'Sala riunioni');
    const moved = expandObject(parsed.value, { from: Date.parse(newStart) - DAY_MS, to: Date.parse(newStart) + DAY_MS, tz: 'Europe/Rome', computeRangeEnd: false });
    assert.deepEqual(moved.occurrences.map((o) => new Date(o.startUtc).toISOString()), [newStart], 'nuovo orario su Radicale');
    assert.equal(parsed.value.master.components.filter((c) => c.name === 'VALARM').length, 1, 'VALARM del device preservato');
    assert.ok(got.body.includes('X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC'), 'X-prop del device preservata');
    const after = await liveRow(legacyKey);
    assert.equal(after.written_etag, got.etag, 'ledger aggiornato con l\'etag scritto');
    assert.equal(after.adopted, true, 'riga adottata: i campi fuori dal piano restano anche negli apply successivi');

    // Giro notturno: apply completo (nessuna scrittura: non insegue il testo del device) e verifica V1-V5.
    await runShadowNightly();
    await drainJobs();
    // Giro orario: V4 sui prossimi 14 giorni. L'ora passata esplicitamente (mezzogiorno locale) tiene il giro fuori
    // dalla finestra del notturno (02:55-03:15 locali), dove resta fermo: il test non dipende dall'ora in cui gira.
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    await runShadowHourlyParity({ now: noon });
    await drainJobs();
    const parity = (await api.get(`${BASE}/parity`, { auth: 'admin' })).json;
    assert.equal(parity.shadow_enabled, true);
    assert.ok(parity.last_nightly?.verify_run_id, JSON.stringify(parity.last_nightly));
    const nightly = await getRun(parity.last_nightly.verify_run_id);
    assert.equal(nightly.summary.acceptable, true, `giro notturno non verde: ${JSON.stringify(nightly.summary.calendars)}`);
    const nightlyApply = await getRun(parity.last_nightly.apply_run_id);
    assert.equal(nightlyApply.summary.zero_writes, true, JSON.stringify(nightlyApply.summary.writes));
    assert.notEqual(parity.last_nightly.color, 'red');
    assert.equal(parity.last_nightly.green, true, 'giro notturno verde per la parità (gialli accettati)');
    assert.equal(parity.last_hourly?.color, 'green');
    assert.ok(parity.green_since, 'serie verde iniziata');
    assert.equal(parity.days_green, 0);
    assert.equal(parity.satisfied, false, 'i 7 giorni di parità si osservano nel tempo');
    assert.equal(parity.open_conflicts, 0);
    assert.equal(parity.queue.pending, 0);
    assert.equal(parity.queue.dead, 0);
    const s = await wizard();
    assert.equal(s.wizard.steps[4].status, 'running', JSON.stringify(s.wizard.steps[4]));
    assert.equal(s.wizard.steps[5].status, 'locked');
    assert.equal(s.cutover.available, false);
    // F4: il passaggio esiste ma i criteri lo rifiutano (parità di 7 giorni non ancora osservata).
    const cutover = await api.post(`${BASE}/cutover`, { auth: 'admin', body: { confirm: MIGRATION_CONFIRMATIONS.cutover }, headers: { 'Idempotency-Key': key('cutover') } });
    assert.equal(cutover.status, 409, cutover.text);
    assert.equal(cutover.json.code, 'PRECONDITION_FAILED');
    assert.ok(cutover.json.details.reasons.includes('SHADOW_PARITY_REQUIRED'), cutover.text);
    await assertPostgresAuthoritative('con lo shadow attivo');
  });

  // ─── 5b. Iscrizioni ───────────────────────────────

  test('5b. iscrizione: flag per singola iscrizione dal wizard, sidecar invisibile al legacy, collezione creata solo dall\'init', async () => {
    const list = await api.get(`${BASE}/subscriptions`, { auth: 'admin' });
    assert.equal(list.status, 200, list.text);
    assert.equal(list.json.subscriptions.length, 1);
    const [view] = list.json.subscriptions;
    assert.equal(view.subscription_id, subscriptionId);
    assert.equal(view.url_host, `${FEED_HOST}:${feedPort}`, 'solo l\'host del feed');
    assert.ok(!list.text.includes('segreto-del-feed'), 'mai percorso o query del feed (possono contenere un token)');
    assert.equal(view.blocks_availability, false, 'default della decisione 5: non bloccante');
    assert.equal(view.device_visible, false, 'default della decisione 5: nascosta ai device');
    assert.ok(view.impact && view.impact.busy_hours_per_week > 0, `impatto di "blocca disponibilità": ${JSON.stringify(view.impact)}`);
    const calendarsBefore = (await api.get('/api/admin/calendar/calendars', { auth: 'admin' })).json.calendars.length;

    // "Blocca disponibilità": il sidecar nasce (origin migration) e il pull porta gli impegni nell'indice.
    const blocks = await api.patch(`${BASE}/subscriptions/${subscriptionId}`, { auth: 'admin', body: { blocks_availability: true } });
    assert.equal(blocks.status, 200, blocks.text);
    assert.equal(blocks.json.subscription.blocks_availability, true);
    assert.ok(blocks.json.subscription.sidecar_calendar_id, 'sidecar creato');
    assert.equal(blocks.json.subscription.events_index, 2);
    const [sidecar] = await sql<Array<{ role: string; origin: string; collection_name: string }>>`
      SELECT role, origin, collection_name FROM calendars WHERE id = ${blocks.json.subscription.sidecar_calendar_id}
    `;
    assert.deepEqual({ role: sidecar.role, origin: sidecar.origin }, { role: 'subscription', origin: 'migration' });
    // Il legacy non vede il sidecar: stessa lista dei calendari dell'admin.
    const calendarsAfter = (await api.get('/api/admin/calendar/calendars', { auth: 'admin' })).json.calendars;
    assert.equal(calendarsAfter.length, calendarsBefore);
    assert.ok(!calendarsAfter.some((c: { id: string }) => c.id === blocks.json.subscription.sidecar_calendar_id));

    // Visibile ai device: la collezione sub-* non c'è e lo strumento non la crea fuori dall'init.
    const visible = await api.patch(`${BASE}/subscriptions/${subscriptionId}`, { auth: 'admin', body: { device_visible: true } });
    assert.equal(visible.status, 200, visible.text);
    assert.equal(visible.json.collection_missing, true);
    // "Crea collezioni mancanti" (init create_missing, con conferma) la crea, e solo quella.
    const { created } = await runInitRoute({ action: 'create_missing', confirm: MIGRATION_CONFIRMATIONS.createCollections });
    assert.deepEqual(created, [sidecar.collection_name]);
    const refreshed = (await api.get(`${BASE}/subscriptions`, { auth: 'admin' })).json.subscriptions[0];
    assert.equal(refreshed.collection_exists, true);
    assert.equal(refreshed.device_visible, true);
    await assertPostgresAuthoritative('dopo i flag dell\'iscrizione');
  });

  // ─── 6. Feed ICS pubblici ───────────────────────────────

  test('6. feed ICS: lo stesso token pubblica gli stessi UID e le stesse istanze dallo store legacy e dallo store Radicale', async () => {
    const now = Date.now();
    const from = now - FEED_PAST_DAYS * DAY_MS;
    const to = now + FEED_FUTURE_DAYS * DAY_MS;
    const legacy = new Map<string, Map<string, Set<string>>>();
    for (const [slug, token] of feedTokens) {
      const res = await fetchFeed(token);
      assert.equal(res.status, 200, `feed legacy di ${slug}`);
      assert.equal(res.etag, null, 'feed legacy senza ETag, come prima');
      legacy.set(slug, feedInstances(res.body, from, to));
    }

    // Indice sincronizzato da Radicale e facade forzata sullo store Radicale (com'è dopo il cutover).
    overrideCalendarStore('radicale');
    invalidateBackendModeCache();
    clearIndexFeedCache();
    try {
      await syncIndexFromRadicale();
      // Id legacy preassegnati: l'indice usa per ogni risorsa l'id della riga legacy.
      const seriesRow = await liveRow(`event:${shape.infiniteSeries.id}`);
      const [obj] = await sql<Array<{ id: string }>>`SELECT id::text AS id FROM cal_objects WHERE calendar_id = ${shape.c.id} AND href = ${seriesRow.href}`;
      assert.equal(obj?.id, shape.infiniteSeries.id, 'stesso id dell\'evento legacy nell\'indice');

      const [{ uid: overrideUid }] = await sql<Array<{ uid: string }>>`SELECT uid FROM calendar_events WHERE id = ${dstOverrideId}`;
      const [{ uid: seriesUid }] = await sql<Array<{ uid: string }>>`SELECT uid FROM calendar_events WHERE id = ${shape.infiniteSeries.id}`;
      const legacyOverrideUids = (await sql<Array<{ uid: string }>>`SELECT uid FROM calendar_events WHERE recurrence_master_id IS NOT NULL`).map((r) => r.uid);
      const isOverrideUid = (published: string): boolean => legacyOverrideUids.some((u) => published === u || published.startsWith(`${u}@`));
      // Come V5: contano gli UID con almeno un'istanza nella finestra del feed.
      const visible = (m: Map<string, Set<string>>): Map<string, Set<string>> => new Map([...m].filter(([, set]) => set.size > 0));
      const range = (date: string, from: string, to: string): string => `${date}T${from}:00:00.000Z/${date}T${to}:00:00.000Z`;
      const monday = dstExdate.slice(0, 10);
      for (const [slug, token] of feedTokens) {
        const res = await fetchFeed(token);
        assert.equal(res.status, 200, `feed Radicale di ${slug}: ${res.body.slice(0, 200)}`);
        assert.ok(res.etag, 'feed dall\'indice con ETag forte');
        const L = visible(legacy.get(slug)!);
        const T = visible(feedInstances(res.body, from, to));
        // Il feed legacy pubblica gli override come VEVENT a sé, con il proprio UID; Radicale li tiene
        // nell'oggetto della serie (OVERRIDE_UID_MASTER, differenza attesa di V5).
        const legacyUids = [...L.keys()].filter((u) => !isOverrideUid(u)).sort();
        assert.deepEqual([...T.keys()].sort(), legacyUids, `stessi UID pubblicati nel feed di ${slug}`);
        for (const uid of legacyUids) {
          const l = L.get(uid)!;
          const t = T.get(uid)!;
          const onlyL = [...l].filter((i) => !t.has(i)).sort();
          const onlyT = [...t].filter((i) => !l.has(i)).sort();
          if (slug === 'c' && uid.startsWith(`${seriesUid}@`)) {
            // Serie infinita: le eccezioni DST riallineate sulla griglia di Roma (DST_REALIGNED). Nel legacy
            // l'EXDATE e l'override salvati alle 07:00Z non colpiscono l'occorrenza delle 08:00Z.
            assert.deepEqual({ onlyL, onlyT }, {
              onlyL: [range(monday, '08', '09'), range(dstThursday, '08', '09')].sort(),
              onlyT: [range(dstThursday, '10', '11')],
            }, 'serie infinita: differenze solo sulle eccezioni DST riallineate');
            continue;
          }
          assert.deepEqual({ uid, onlyL, onlyT }, { uid, onlyL: [], onlyT: [] }, `stesse istanze nel feed di ${slug}`);
        }
        const legacyOverrides = [...L.keys()].filter(isOverrideUid);
        if (slug === 'c') {
          assert.deepEqual(legacyOverrides.map((u) => u.startsWith(`${overrideUid}@`)), [true], 'il feed legacy pubblica l\'override con il suo UID');
          assert.deepEqual([...L.get(legacyOverrides[0])!], [range(dstThursday, '10', '11')]);
        } else {
          assert.deepEqual(legacyOverrides, [], `nessun override nel feed di ${slug}`);
        }
      }
    } finally {
      overrideCalendarStore(null);
      invalidateBackendModeCache();
      clearIndexFeedCache();
    }
    // Token dei feed invariati: gli abbonati non devono cambiare nulla.
    const tokens = await sql<Array<{ slug: string; ics_feed_token: string; ics_feed_enabled: boolean }>>`SELECT slug, ics_feed_token, ics_feed_enabled FROM calendars WHERE role <> 'subscription'`;
    for (const t of tokens) {
      assert.equal(t.ics_feed_token, feedTokens.get(t.slug), `token del feed di ${t.slug} invariato`);
      assert.equal(t.ics_feed_enabled, true);
    }
  });

  // ─── 7. Erasure GDPR ───────────────────────────────

  test('7. erasure GDPR dalla route: prenotazione, eventi, audit_logs, ledger, run, job, indice e Radicale senza dati personali', async () => {
    const before = await api.get(`/api/gdpr-requests/export/${encodeURIComponent(email)}`, { auth: 'admin' });
    assert.equal(before.status, 200, before.text);

    const res = await api.delete(`/api/gdpr-requests/erase/${encodeURIComponent(email)}`, { auth: 'admin' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.erased, true);
    const report = res.json.calendar;
    assert.equal(report.bookings, 1);
    assert.equal(report.projections_legacy, 1);
    assert.ok(report.events_redacted >= 2, `eventi redatti: ${report.events_redacted}`);
    assert.ok(report.audit_logs_redacted > 0);
    assert.ok(report.ledger_redacted >= 3, `righe del ledger redatte: ${report.ledger_redacted}`);
    assert.ok(report.jobs_enqueued >= 3, `job accodati: ${report.jobs_enqueued}`);
    assert.ok(!JSON.stringify(report).toLowerCase().includes(email), 'report senza email');

    // Lo shadow riscrive la destinazione: proiezione minimizzata, email tolta, VALARM sempre preservato.
    await runShadowJobsNow();
    const dead = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM cal_jobs WHERE kind = ${SHADOW_MIRROR_JOB_KIND} AND status <> 'done'`;
    assert.equal(dead[0].n, 0, 'job dell\'erasure conclusi');

    const [booking] = await sql<Array<{ attendee_name: string; attendee_email: string; attendee_phone: string | null }>>`
      SELECT attendee_name, attendee_email, attendee_phone FROM calendar_bookings WHERE uid = ${shape.confirmedBookingUid}
    `;
    assert.equal(booking.attendee_name, 'Dato cancellato (GDPR)');
    assert.match(booking.attendee_email, /^erased-.+@deleted\.invalid$/);
    assert.equal(booking.attendee_phone, null);
    const [projRow] = await sql<Array<{ summary: string; description: string | null }>>`
      SELECT summary, description FROM calendar_events WHERE source = 'booking' AND source_id = ${shape.confirmedBookingUid}
    `;
    assert.equal(projRow.summary, 'Prenotazione');
    assert.equal(projRow.description, null);
    const like = `%${email}%`;
    const phoneLike = `%${PHONE}%`;
    const [legacyLeft] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM calendar_events
      WHERE summary ILIKE ${like} OR description ILIKE ${like} OR location ILIKE ${like}
    `;
    assert.equal(legacyLeft.n, 0, 'nessuna email nelle righe legacy');
    const [redacted] = await sql<Array<{ description: string }>>`SELECT description FROM calendar_events WHERE id = ${clientEvent.id}`;
    assert.match(redacted.description, /\[dato rimosso\]/);
    const [audit] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM audit_logs
      WHERE created_at >= ${startedAt}::timestamptz
        AND (COALESCE(old_data::text, '') ILIKE ${like} OR COALESCE(new_data::text, '') ILIKE ${like}
             OR (table_name IN ('calendar_events', 'calendar_bookings')
                 AND (COALESCE(old_data::text, '') ILIKE ${phoneLike} OR COALESCE(new_data::text, '') ILIKE ${phoneLike})))
    `;
    assert.equal(audit.n, 0, 'audit_logs senza email né telefono');
    const [ledger] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM cal_migration_ledger
      WHERE COALESCE(legacy_snapshot::text, '') ILIKE ${like} OR COALESCE(intent_snapshot::text, '') ILIKE ${like}
         OR COALESCE(legacy_snapshot::text, '') ILIKE ${phoneLike} OR COALESCE(intent_snapshot::text, '') ILIKE ${phoneLike}
    `;
    assert.equal(ledger.n, 0, 'ledger senza dati personali');
    const [items] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM cal_migration_items WHERE detail::text ILIKE ${like} OR detail::text ILIKE ${phoneLike}
    `;
    assert.equal(items.n, 0, 'righe dei run senza dati personali');
    const [runs] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM cal_migration_runs
      WHERE COALESCE(summary::text, '') ILIKE ${like} OR COALESCE(summary::text, '') ILIKE ${phoneLike}
         OR COALESCE(params::text, '') ILIKE ${like} OR COALESCE(error, '') ILIKE ${like}
    `;
    assert.equal(runs.n, 0, 'riassunti dei run senza dati personali');
    const [jobs] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM cal_jobs
      WHERE COALESCE(payload::text, '') ILIKE ${like} OR COALESCE(result::text, '') ILIKE ${like} OR COALESCE(last_error, '') ILIKE ${like}
    `;
    assert.equal(jobs.n, 0, 'job senza email');
    // Il ledger torna allineato: le chiavi redatte sono state riscritte dallo shadow.
    const proj = await liveRow(`booking:${shape.confirmedBookingUid}`);
    assert.ok(proj.legacy_hash, 'sorgente redatta riscritta');

    // Radicale: proiezione "Prenotazione" senza nome né telefono, eventi senza email.
    const projObj = await svc.get(pathOf(proj.collection_name, proj.href));
    const pm = parseCalendarObject(projObj.body);
    assert.ok(pm.ok && pm.value.master);
    assert.equal(getTextValue(pm.value.master, 'SUMMARY'), 'Prenotazione');
    assert.equal(getTextValue(pm.value.master, 'DESCRIPTION'), null);
    assert.equal(proj.written_etag, projObj.etag);
    assert.ok(!projObj.body.includes(PHONE) && !projObj.body.includes('Cliente Prova'), 'nome e telefono spariti dal volume');
    for (const id of [clientEvent.id, clientCopyId]) {
      const row = await liveRow(`event:${id}`);
      const obj = await svc.get(pathOf(row.collection_name, row.href));
      assert.ok(!obj.body.toLowerCase().includes(email), `email tolta dall'oggetto di ${id}`);
      assert.match(obj.body, /\[dato rimosso\]/);
      if (id === clientEvent.id) assert.match(obj.body, /BEGIN:VALARM/, 'VALARM del device preservato anche dall\'erasure');
    }

    // Indice: dopo la sync nessuna copia dei dati personali (oggetti e versioni).
    overrideCalendarStore('radicale');
    invalidateBackendModeCache();
    try {
      await syncIndexFromRadicale();
    } finally {
      overrideCalendarStore(null);
      invalidateBackendModeCache();
      clearIndexFeedCache();
    }
    const [index] = await sql<Array<{ n: number }>>`
      SELECT (SELECT count(*) FROM cal_objects WHERE raw_ics ILIKE ${like} OR raw_ics ILIKE ${phoneLike})::int
           + (SELECT count(*) FROM cal_object_versions WHERE raw_ics ILIKE ${like} OR raw_ics ILIKE ${phoneLike})::int AS n
    `;
    assert.equal(index.n, 0, 'indice senza dati personali');

    // Feed pubblici legacy senza dati personali.
    for (const slug of ['bookings', 'lavoro']) {
      const feed = await fetchFeed(feedTokens.get(slug)!);
      assert.equal(feed.status, 200);
      assert.ok(!feed.body.toLowerCase().includes(email) && !feed.body.includes(PHONE), `feed di ${slug} senza dati personali`);
    }

    // Idempotente: una seconda richiesta non trova più nulla.
    const again = await api.delete(`/api/gdpr-requests/erase/${encodeURIComponent(email)}`, { auth: 'admin' });
    assert.equal(again.status, 200, again.text);
    for (const k of ['bookings', 'projections_legacy', 'events_redacted', 'audit_logs_redacted', 'ledger_redacted', 'jobs_enqueued']) {
      assert.equal(again.json.calendar[k], 0, `seconda erasure: ${k}`);
    }
  });

  // ─── Invarianti di tutto il percorso ───────────────────────────────

  test('invarianti: Postgres autorevole, nessuna collezione creata fuori dall\'init, nessuna riga legacy scritta dallo strumento', async () => {
    await assertPostgresAuthoritative('a fine percorso');
    assert.ok(initWindows.length >= 2);
    const outside = runtime.log
      .map((r, i) => ({ ...r, i }))
      .filter((r) => (r.method === 'MKCOL' || r.method === 'MKCALENDAR') && !initWindows.some(([a, b]) => r.i >= a && r.i < b));
    assert.deepEqual(outside, [], 'nessuna MKCOL o MKCALENDAR fuori dai run di inizializzazione');
    // Le uniche righe legacy nuove sono quelle create dall'admin durante il percorso (sei eventi della prova del kill).
    const [{ n }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM calendar_events`;
    assert.equal(n, legacyRowsAtStart + 6);
    const [runs] = await sql<Array<{ active: number; failed: number }>>`
      SELECT count(*) FILTER (WHERE status IN ('queued', 'running'))::int AS active,
             count(*) FILTER (WHERE status IN ('failed', 'interrupted'))::int AS failed
      FROM cal_migration_runs
    `;
    assert.deepEqual(runs, { active: 0, failed: 0 }, 'nessun run attivo né fallito');
    assert.ok(killRunId);
    const audits = await sql<Array<{ op: string }>>`SELECT metadata->>'operation' AS op FROM audit_logs WHERE table_name = 'calendar_migration'`;
    const ops = new Set(audits.map((a) => a.op));
    for (const op of ['inventory', 'preflight', 'init_initialize', 'declare', 'plan', 'apply', 'verify', 'shadow_on']) assert.ok(ops.has(op), `audit di ${op}: ${[...ops].join(', ')}`);
  });
});
