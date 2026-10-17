/**
 * Prova generale della F4 emulata (piano F4 attività 8 e criterio di uscita;
 * design §13.9-§13.13 e §16.6; contratto docs/calendar-radicale/contracts/
 * f4-modules.md §11), su una copia sintetica della produzione, contro
 * Radicale 3.7.8 reale con il config e i plugin di produzione, passando dalle
 * route del wizard (/api/admin/calendar/migration) e dall'esecutore reale dei
 * run (job migration_run).
 *
 * Stack come integration/migration-rollback: caldes_auth con
 * verify-credentials simulato, caldes_rights con policy.json e heartbeat.json
 * scritti dal control-plane dell'API, caldes-svc dal peer di caldav-int
 * (127.0.0.2), device dal gateway (127.0.0.3), probe da 127.0.0.1.
 *
 * Copia sintetica (buildProductionShape, come l'e2e della F3): `c` con la
 * serie infinita e le copie "Duplica", `f` con 91 festività e la chiusura,
 * Prenotazioni con una proiezione, una riunione in lavoro, un giorno intero in
 * personale, una scadenza, feed ICS attivi su ogni calendario e una
 * prenotazione dal sito presa prima del passaggio.
 *
 * Percorso:
 *  1. migrazione F3 dalle route fino allo shadow verde: inizializzazione,
 *     dichiarazioni, anteprima, apply, seconda esecuzione a zero scritture,
 *     verifica accettata, shadow attivo; i 7 giorni di parità sono emulati con
 *     giri notturni verdi retrodatati (non si aspettano 7 giorni in un test),
 *     la matrice device dalla route e il backup coordinato registrato;
 *  2. cutover dal wizard con un kill prima della verifica del delta (prima del
 *     punto di non ritorno: Postgres autorevole, scritture admin 503, device in
 *     sola lettura, annullamento possibile) e uno prima della proiezione
 *     inversa (dopo l'epoch: annullamento rifiutato), ripresa dal wizard fino
 *     in fondo: mode radicale, policy live, smoke verdi;
 *  3. uso misto nella finestra: il device crea, modifica e cancella; admin e
 *     MCP scrivono; prenotazione dal sito; casi del red-team del design §15.4:
 *     A (UID dell'invito duplicato da iPhone, durata zero, evento senza
 *     titolo, override con l'UID del master, UID con chiocciola) e C
 *     (prenotazione presa prima del cutover annullata nella finestra);
 *     proiezione inversa dal giro di backstop e dai job, nessun REVERSE_FAILED;
 *  4. rollback dal wizard: anteprima (busy identico), kill prima della
 *     proiezione finale e prima del control-plane, ripresa: busy legacy
 *     identico a quello di Radicale, anteprima ricalcolata uguale a quella
 *     confermata (degradi pari all'anteprima), caso C con lo slot di nuovo
 *     libero, prenotazione della finestra in PG;
 *  5. nuovo cutover dal wizard (caso B): verifica accettabile dopo il rollback
 *     e delta a zero scritture per gli oggetti non toccati, compresi l'oggetto
 *     dell'iPhone con il suo href e quelli toccati da admin e MCP;
 *  6. rollback d'immagine API simulato: heartbeat fermo → device frozen;
 *     scritture legacy di un'immagine vecchia bloccate dalla guardia 166 in
 *     mode radicale; un'immagine con un livello più basso non serve il
 *     calendario; ripristino del heartbeat → device di nuovo live.
 * Feed ICS: in ogni stato (postgres, transizione, radicale, dopo il rollback,
 * dopo il nuovo cutover) lo stesso token pubblica le stesse istanze, con le
 * sole differenze dei degradi documentati della proiezione inversa.
 *
 * Senza RADICALE_BIN, Python o gli indirizzi 127.0.0.2/127.0.0.3 la suite è
 * saltata con il motivo. Lo stato del backend torna alla baseline a fine file.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  expandObject,
  FEED_FUTURE_DAYS,
  FEED_PAST_DAYS,
  getTextValue,
  parseIcs,
  splitCalendar,
} from '@calicchia/calendar-core';
import { databaseNow, onBeforeDatabaseClose, resetCalendarBaseline, sql } from '../helpers/db';
import { romeIso, useFixtures } from '../helpers/fixtures';
import { api } from '../helpers/http';
import {
  type CalDavClient,
  pythonAvailability,
  RADICALE_PLUGINS_DIR,
  radicaleAvailability,
  resolvePython,
  TEST_PRINCIPAL,
  useMockVerify,
  useRadicale,
} from '../helpers/radicale';
import { buildProductionShape, type ProductionShape } from '../calendar/_migration-init-shared';
import { executeTool } from '../../src/lib/agent/tools';
import { calendarApiLevelBlocked, enforceCalendarApiLevelAtBoot, resetCalendarApiLevelForTests } from '../../src/lib/calendar/api-level';
import { invalidateBackendModeCache } from '../../src/lib/calendar/backend-mode';
import { registerBookingJobs } from '../../src/lib/calendar/booking';
import { indexBusyRanges } from '../../src/lib/calendar/busy';
import { clearIndexFeedCache } from '../../src/lib/calendar/feed-builder';
import { runCalendarJobsOnce, unregisterCalendarJobHandler } from '../../src/lib/calendar/jobs';
import { createEvent as legacyCreateEvent, getBusyRanges as legacyBusyRanges } from '../../src/lib/calendar/legacy/events-pg';
import {
  REVERSE_PROJECTION_JOB_KIND,
  registerReverseProjectionJob,
  runReverseProjectionSweep,
} from '../../src/lib/calendar/migration/reverse-projector';
import { sameBusy } from '../../src/lib/calendar/migration/rollback';
import { registerMigrationRunJob } from '../../src/lib/calendar/migration/runs';
import { registerShadowMirrorJob } from '../../src/lib/calendar/migration/shadow';
import { getActiveTransition, setTransitionTestHooks } from '../../src/lib/calendar/migration/transition';
import {
  CALENDAR_API_LEVEL,
  MIGRATION_CONFIRMATIONS,
  MIGRATION_RUN_JOB_KIND,
  SHADOW_MIRROR_JOB_KIND,
  type VerifyParams,
} from '../../src/lib/calendar/migration/types';
import { objectPath, RadicaleClient } from '../../src/lib/calendar/radicale/client';
import { readHeartbeatFile, startCalendarControlPlane, stopCalendarControlPlane } from '../../src/lib/calendar/radicale/heartbeat';
import { stopIndexWorker } from '../../src/lib/calendar/radicale/indexer';
import { readVolumeMarkerRemote } from '../../src/lib/calendar/radicale/identity';
import { readPolicyFile } from '../../src/lib/calendar/radicale/policy';
import { registerStoreJobs } from '../../src/lib/calendar/radicale/store';
import { configureRadicaleRuntime, drainSyncs, invalidateIdentityCache, syncAllCollections, updateWatchMode } from '../../src/lib/calendar/radicale/sync';
import type { CaldesPolicy } from '../../src/lib/calendar/radicale/types';
import { startCalendarWatcher, stopCalendarWatcher } from '../../src/lib/calendar/radicale/watcher';
import { calendarStore } from '../../src/lib/calendar/store';

const radicale = radicaleAvailability();
const python = pythonAvailability();
const fx = useFixtures('f4-prova', { resetBaseline: true });

const P = TEST_PRINCIPAL;
const SVC_PASSWORD = 'test-only-svc-password-f4-prova';
const PROBE_PASSWORD = 'test-only-probe-password-f4-prova';
const AUTHCACHE_KEY = 'test-only-authcache-key-f4-prova-0123456789abcdef01';
const SVC_PEER = '127.0.0.2';
const GATEWAY = '127.0.0.3';
const PLUGIN_RELOAD_MS = 1_100;
const API_VERSION = 'sha-f4prova';
const PRODUCTION_CONFIG = join(RADICALE_PLUGINS_DIR, '..', 'config', 'config');
const DEVICE = { username: 'iphone', password: 'tst-app-password-f4-prova', ip: '203.0.113.43', userAgent: 'iOS/18.0 (22A3354) dataaccessd/1.0' };
const BASE = '/api/admin/calendar/migration';
const DAY_MS = 86_400_000;
const FULL_VERIFY: VerifyParams = { scope: {}, levels: ['V1', 'V2', 'V3', 'V4', 'V5'], v4_days: 180 };
const KILL = 'kill simulato del processo';
const BUSY_FROM = new Date(Date.now() - DAY_MS).toISOString();
const BUSY_TO = new Date(Date.now() + 170 * DAY_MS).toISOString();
/**
 * Oggetti del caso A il cui UID pubblicato cambia per un degrado documentato
 * della proiezione inversa (SANITIZED_UID: UID duplicato → `<UID>@<collezione>`;
 * UID del device con '@': il feed legacy aggiunge sempre il dominio) o la cui
 * durata cambia (SANITIZED_DURATION: durata zero → +1 minuto). Nel confronto
 * dei feed contano solo gli inizi delle loro istanze nel calendario.
 */
const LOOSE_SUMMARY = /Invito duplicato|Durata zero|UID con chiocciola/;
/**
 * Prenotazioni prese nella finestra di rollback: la risorsa booking-<uid>.ics
 * ha UID `<uid>@caldes.it` e il feed dell'indice lo pubblica così; dopo il
 * rollback la riga legacy ha quell'UID e il feed legacy aggiunge sempre il
 * dominio (`<uid>@caldes.it@<dominio>`). Differenza nota, segnalata nel report
 * dell'integrazione F4 come questione aperta: contano solo gli inizi.
 */
const looseUidPrefixes: string[] = [];

function peersAvailable(): string | null {
  for (const address of [SVC_PEER, GATEWAY]) {
    const res = spawnSync(resolvePython(), ['-I', '-c', 'import socket,sys; s=socket.socket(); s.bind((sys.argv[1], 0)); s.close()', address], { timeout: 10_000 });
    if (res.status !== 0) return `${address} non utilizzabile come indirizzo sorgente`;
  }
  return null;
}
const PEERS_SKIP = radicale.skip || python.skip ? null : peersAvailable();

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function productionConfig(paths: { storageDir: string; policyFile: string; heartbeatFile: string }): string {
  const overrides: Record<string, Record<string, string>> = {
    server: { hosts: '127.0.0.1:0' },
    storage: { filesystem_folder: paths.storageDir },
    rights: { caldes_policy_file: paths.policyFile, caldes_heartbeat_file: paths.heartbeatFile },
  };
  let section = '';
  const seen = new Set<string>();
  const out = readFileSync(PRODUCTION_CONFIG, 'utf8').split('\n').map((line) => {
    const header = /^\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      section = header[1];
      return line;
    }
    const entry = /^([A-Za-z0-9_]+)\s*=/.exec(line);
    const value = entry ? overrides[section]?.[entry[1]] : undefined;
    if (!entry || value === undefined) return line;
    seen.add(`${section}.${entry[1]}`);
    return `${entry[1]} = ${value}`;
  });
  const missing = Object.entries(overrides).flatMap(([s, v]) => Object.keys(v).map((k) => `${s}.${k}`)).filter((k) => !seen.has(k));
  if (missing.length) throw new Error(`config di produzione senza le chiavi attese: ${missing.join(', ')}`);
  return out.join('\n');
}

async function waitFor<T>(what: string, probe: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() > deadline) throw new Error(`timeout in attesa di: ${what}${lastError ? ` (${(lastError as Error).message})` : ''}`);
    await sleep(50);
  }
}

/** VCALENDAR di un iPhone con uno o più VEVENT (righe già pronte). */
function deviceIcs(...events: string[][]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//iPhone OS 18.0//EN', ...events.flatMap((e) => ['BEGIN:VEVENT', ...e, 'END:VEVENT']), 'END:VCALENDAR', ''].join('\r\n');
}

/** Primo giorno feriale (lun-ven) da `from` in poi (YYYY-MM-DD). */
function weekdayOnOrAfter(from: Date): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 12));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Istanze pubblicate da un feed: per UID normalizzato (strette) e per inizio (oggetti dei degradi documentati). */
interface FeedView {
  strict: Map<string, string[]>;
  loose: string[];
}

/**
 * Le righe derivate e gli override che la proiezione inversa scrive con UID
 * `<UID>#<chiave>` si pubblicano nel feed legacy come VEVENT a sé: si
 * riconducono all'UID dell'oggetto d'origine (classe SEMANTIC_EXPANDED).
 */
const normalizeUid = (uid: string): string => uid.replace(/#[^@]*/, '');

function feedView(body: string): FeedView {
  const now = Date.now();
  const from = now - FEED_PAST_DAYS * DAY_MS;
  const to = now + FEED_FUTURE_DAYS * DAY_MS;
  const parsed = parseIcs(body);
  assert.ok(parsed.ok, `feed illeggibile: ${parsed.ok ? '' : parsed.error.message}`);
  const strict = new Map<string, Set<string>>();
  const loose: string[] = [];
  for (const obj of splitCalendar(parsed.value, { duplicateMasters: 'keep-first' }).objects) {
    const head = obj.master ?? obj.overrides[0];
    const summary = head ? getTextValue(head, 'SUMMARY') ?? '' : '';
    const res = expandObject(obj, { from, to, tz: 'Europe/Rome', computeRangeEnd: false });
    for (const o of res.occurrences) {
      if ((o.status ?? '').toUpperCase() === 'CANCELLED') continue;
      const start = o.allDay && o.startDate ? `D${o.startDate}` : new Date(o.startUtc).toISOString();
      const end = o.allDay && o.endDate ? `D${o.endDate}` : new Date(o.endUtc).toISOString();
      if (LOOSE_SUMMARY.test(summary) || (looseUidPrefixes.length > 0 && looseUidPrefixes.some((p) => obj.uid.startsWith(p)))) {
        loose.push(start);
        continue;
      }
      const key = normalizeUid(obj.uid);
      const set = strict.get(key) ?? new Set<string>();
      set.add(`${start}/${end}`);
      strict.set(key, set);
    }
  }
  return {
    strict: new Map([...strict].filter(([, s]) => s.size > 0).map(([k, s]) => [k, [...s].sort()])),
    loose: loose.sort(),
  };
}

describe('prova generale della F4 dalle route del wizard, con Radicale reale e la config di produzione', {
  skip: radicale.skip || python.skip || PEERS_SKIP || false,
}, () => {
  let root = '';
  let policyFile = '';
  let heartbeatFile = '';
  let svc: RadicaleClient | null = null;
  let volumeId = '';
  let epoch0 = 0;
  let startedAt = '';
  let shape: ProductionShape | null = null;
  let feedTokens = new Map<string, string>();
  let eventTypeSlug = '';
  /** Prenotazione dal sito presa in mode postgres prima del passaggio (caso C). */
  const preBooking = { uid: '', start: '', date: '' };
  /** Prenotazione dal sito presa nella finestra di rollback. */
  const windowBooking = { uid: '', start: '' };
  const win = {
    iphoneHref: '', iphoneUid: '', editedHref: '', deletedHref: '', deletedId: '',
    adminEventId: '', mcpEventId: '', recurringUid: '', zeroUid: '', untitledUid: '', duplicateUid: '',
  };
  const kills = new Set<string>();
  const previousProbe = process.env.RADICALE_PROBE_PASSWORD;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'caldes-f4-prova-'));
    const controlDir = join(root, 'control');
    mkdirSync(controlDir, { mode: 0o755 });
    chmodSync(controlDir, 0o755);
    mkdirSync(join(root, 'authcache'), { mode: 0o700 });
    policyFile = join(controlDir, 'policy.json');
    heartbeatFile = join(controlDir, 'heartbeat.json');
    process.env.RADICALE_PROBE_PASSWORD = PROBE_PASSWORD;
  });
  onBeforeDatabaseClose(async () => {
    setTransitionTestHooks(null);
    resetCalendarApiLevelForTests();
    await stopCalendarWatcher();
    await stopCalendarControlPlane();
    await drainSyncs(5_000).catch(() => undefined);
    await stopIndexWorker();
    configureRadicaleRuntime(null);
    unregisterCalendarJobHandler(MIGRATION_RUN_JOB_KIND);
    unregisterCalendarJobHandler(SHADOW_MIRROR_JOB_KIND);
    unregisterCalendarJobHandler(REVERSE_PROJECTION_JOB_KIND);
    invalidateBackendModeCache();
    clearIndexFeedCache();
    await resetCalendarBaseline();
    if (startedAt) {
      await sql`
        DELETE FROM audit_logs
        WHERE created_at >= ${startedAt}::timestamptz
          AND table_name IN ('calendars', 'calendar_events', 'calendar_subscriptions', 'calendar_bookings', 'calendar_migration')
      `;
    }
  });
  after(async () => {
    setTransitionTestHooks(null);
    await stopCalendarWatcher();
    await stopCalendarControlPlane();
    configureRadicaleRuntime(null);
    updateWatchMode('off', 'test concluso');
    svc?.close();
    if (previousProbe === undefined) delete process.env.RADICALE_PROBE_PASSWORD;
    else process.env.RADICALE_PROBE_PASSWORD = previousProbe;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const verify = useMockVerify({ users: [{ username: DEVICE.username, password: DEVICE.password }] });
  const rad = useRadicale(() => ({
    label: 'f4-prova',
    auth: { type: 'plugin', module: 'caldes_auth' },
    configText: ({ storageDir }) => productionConfig({ storageDir, policyFile, heartbeatFile }),
    pythonPath: [RADICALE_PLUGINS_DIR],
    env: {
      RADICALE_PRINCIPAL: P,
      CALDAV_BACKEND_URL: verify.mock.backendUrl,
      CALDAV_SERVICE_TOKEN: verify.mock.token,
      CALDES_SVC_CIDR: `${SVC_PEER}/32`,
      CALDES_XRA_PEER_CIDR: `${GATEWAY}/32`,
      CALDES_SVC_PASSWORD_SHA256: sha256(SVC_PASSWORD),
      CALDES_PROBE_PASSWORD_SHA256: sha256(PROBE_PASSWORD),
      CALDES_AUTHCACHE_KEY: AUTHCACHE_KEY,
      CALDES_AUTHCACHE_DIR: join(root, 'authcache'),
      CALDES_POLICY_FILE: policyFile,
      TAKE_FILE_OWNERSHIP: 'false',
    },
  }));

  const controlPlaneEnv = (): NodeJS.ProcessEnv => ({
    CALDES_CONTROL_PLANE: 'on',
    CALDES_POLICY_FILE: policyFile,
    CALDES_HEARTBEAT_FILE: heartbeatFile,
    RADICALE_PRINCIPAL: P,
    RADICALE_DATA_DIR: rad.server.storageDir,
    CALDES_IDENTITY_SOURCE: 'file',
    CALDES_API_VERSION: API_VERSION,
  });

  // ─── Utilità ───────────────────────────────

  const key = (label: string): string => `f4-prova-${label}-${randomUUID()}`;
  const policyNow = async (): Promise<CaldesPolicy | null> => {
    const read = await readPolicyFile(policyFile, P);
    return read.state === 'ok' ? read.value : null;
  };
  const device = (): CalDavClient =>
    rad.server.client(DEVICE.username, DEVICE.password).fromAddress(GATEWAY).withHeaders({ 'X-Remote-Addr': DEVICE.ip, 'User-Agent': DEVICE.userAgent });
  const devicePut = async (collection: string, href: string, ics: string, opts: { ifMatch?: string } = {}): Promise<number> =>
    (await device().put(`/${P}/${collection}/${href}`, ics, opts.ifMatch ? { ifMatch: opts.ifMatch } : { ifNoneMatch: '*' })).status;
  const deviceProbe = async (what: string): Promise<number> => {
    const href = `${what}-${randomUUID().slice(0, 8)}.ics`;
    return devicePut('c', href, deviceIcs([`UID:${randomUUID().toUpperCase()}`, 'DTSTAMP:20261016T080000Z', 'DTSTART:20270601T090000Z', 'DTEND:20270601T100000Z', `SUMMARY:Prova ${what}`]));
  };
  const backend = async () => {
    const [row] = await sql`
      SELECT mode, write_freeze, epoch, api_min_version, rollback_until, cutover_at FROM calendar_backend_state WHERE id
    `;
    return row as { mode: string; write_freeze: boolean; epoch: number; api_min_version: number; rollback_until: Date | null; cutover_at: Date | null };
  };
  const markerEpoch = async (): Promise<number | null> => {
    const read = await readVolumeMarkerRemote(svc!, P);
    return read.state === 'ok' ? read.marker.epoch : null;
  };

  async function drainJobs(max = 60): Promise<void> {
    for (let i = 0; i < max; i++) {
      // Debounce e rinvii dei job (shadow mirror, proiezione inversa): eseguiti subito.
      await sql`UPDATE cal_jobs SET run_after = now() WHERE status = 'pending' AND run_after > now()`;
      const r = await runCalendarJobsOnce({ limit: 5 });
      if (r.claimed === 0) return;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function getRun(id: string): Promise<any> {
    const res = await api.get(`${BASE}/runs/${id}`, { auth: 'admin' });
    assert.equal(res.status, 200, res.text);
    return res.json;
  }

  /**
   * Avvia un run dalla route (202, sempre con una chiave d'idempotenza nuova come fa il wizard) e lo
   * esegue con l'esecutore reale; restituisce il run concluso.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function runRoute(path: string, body: object): Promise<any> {
    const res = await api.post(`${BASE}${path}`, { auth: 'admin', body, headers: { 'Idempotency-Key': key(path.replace(/\W+/g, '-')) } });
    assert.equal(res.status, 202, `${path}: ${res.text}`);
    await drainJobs();
    return getRun(res.json.run.id);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function runRouteOk(path: string, body: object): Promise<any> {
    const run = await runRoute(path, body);
    assert.equal(run.status, 'succeeded', `${path}: ${JSON.stringify(run.error)}`);
    return run;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function wizard(): Promise<any> {
    invalidateIdentityCache();
    const res = await api.get(`${BASE}/state`, { auth: 'admin' });
    assert.equal(res.status, 200, res.text);
    return res.json;
  }

  async function step6Action(id: string): Promise<{ id: string; enabled: boolean; reason: string | null; confirm: string | null }> {
    const s = await wizard();
    const step = s.wizard.steps[5];
    const found = step.actions.find((a: { id: string }) => a.id === id);
    assert.ok(found, `azione ${id} nel passo 6: ${JSON.stringify(step.actions.map((a: { id: string }) => a.id))}`);
    return found;
  }

  async function feedSnapshot(): Promise<Map<string, FeedView>> {
    invalidateBackendModeCache();
    clearIndexFeedCache();
    const out = new Map<string, FeedView>();
    for (const [slug, token] of feedTokens) {
      const res = await api.get(`/api/calendar/feed/${token}.ics`);
      assert.equal(res.status, 200, `feed di ${slug} con il token di sempre: ${res.text.slice(0, 200)}`);
      out.set(slug, feedView(res.text));
    }
    return out;
  }

  function assertSameFeeds(a: Map<string, FeedView>, b: Map<string, FeedView>, what: string): void {
    assert.deepEqual([...b.keys()].sort(), [...a.keys()].sort(), `${what}: stessi feed`);
    for (const [slug, va] of a) {
      const vb = b.get(slug)!;
      assert.deepEqual([...vb.strict.keys()].sort(), [...va.strict.keys()].sort(), `${what}: stessi UID nel feed di ${slug}`);
      for (const [uid, inst] of va.strict) assert.deepEqual(vb.strict.get(uid), inst, `${what}: stesse istanze di ${uid} nel feed di ${slug}`);
      assert.deepEqual(vb.loose, va.loose, `${what}: stessi inizi degli oggetti con degradi documentati nel feed di ${slug}`);
    }
  }

  async function hrefOf(legacyKey: string): Promise<string> {
    const [row] = await sql<Array<{ href: string }>>`
      SELECT href FROM cal_migration_ledger WHERE legacy_key = ${legacyKey} AND deleted_at IS NULL
    `;
    assert.ok(row, `riga viva del ledger per ${legacyKey}`);
    return row.href;
  }

  /** Busy legacy, indice e slot del sito per la prenotazione del caso C. */
  async function slotFree(date: string, startIso: string): Promise<boolean> {
    const res = await api.get(`/api/calendar/event-types/${eventTypeSlug}/slots`, { query: { from: date, to: date } });
    assert.equal(res.status, 200, res.text);
    return (res.json.slots as Array<{ start: string }>).some((s) => new Date(s.start).getTime() === new Date(startIso).getTime());
  }

  async function siteBooking(label: string, avoid: string[] = []): Promise<{ uid: string; start: string }> {
    const from = weekdayOnOrAfter(new Date(Date.now() + 9 * DAY_MS));
    const to = new Date(Date.parse(`${from}T12:00:00Z`) + 20 * DAY_MS).toISOString().slice(0, 10);
    const res = await api.get(`/api/calendar/event-types/${eventTypeSlug}/slots`, { query: { from, to } });
    assert.equal(res.status, 200, res.text);
    const slot = (res.json.slots as Array<{ start: string }>).find((s) => !avoid.includes(new Date(s.start).toISOString()));
    assert.ok(slot, `slot libero per la prenotazione ${label}`);
    const booked = await api.post('/api/calendar/bookings', {
      body: {
        event_type_slug: eventTypeSlug,
        start: slot.start,
        attendee: { name: `Cliente ${label}`, email: fx.email(label), timezone: 'Europe/Rome' },
        gdpr_consent: true,
        turnstile_token: 'token-captcha-di-prova',
        source_page: '/prenota/consulenza',
      },
    });
    assert.equal(booked.status, 200, booked.text);
    assert.equal(booked.json.booking.status, 'confirmed');
    return { uid: booked.json.booking.uid as string, start: new Date(slot.start).toISOString() };
  }

  async function legacyRowOfBooking(uid: string): Promise<{ id: string; status: string } | null> {
    const [row] = await sql<Array<{ id: string; status: string }>>`
      SELECT id::text AS id, status FROM calendar_events WHERE source = 'booking' AND source_id = ${uid}
    `;
    return row ?? null;
  }

  /** Esegue un run di transizione dal wizard fino alla fine, con la ripresa dopo ogni kill. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function transitionToEnd(start: { path: string; body: object }, resumeConfirm: string, onKilled: (run: any, n: number) => Promise<void>): Promise<any> {
    let run = await runRoute(start.path, start.body);
    for (let n = 1; n <= 10 && run.status !== 'succeeded'; n++) {
      // Un errore inatteso (il kill simulato) chiude il run come INTERNAL con un messaggio generico; la
      // transizione resta attiva con il passo da riprendere nel journal.
      assert.equal(run.status, 'failed', `run ${n}: ${run.status}`);
      assert.equal(run.error?.code, 'INTERNAL', `run ${n} interrotto dal kill simulato: ${JSON.stringify(run.error)}`);
      const transition = await api.get(`${BASE}/transition`, { auth: 'admin' });
      assert.equal(transition.status, 200);
      assert.equal(transition.json?.status, 'active', `transizione attiva dopo il kill ${n}`);
      assert.equal((await step6Action('transition_resume')).enabled, true, 'ripresa proposta dal wizard');
      await onKilled(run, n);
      run = await runRoute('/transition/resume', { confirm: resumeConfirm });
    }
    assert.equal(run.status, 'succeeded', JSON.stringify(run.error));
    return run;
  }

  // ─── Copia sintetica della produzione ───────────────────────────────

  before(async () => {
    startedAt = await databaseNow();
    svc = new RadicaleClient({ baseUrl: rad.server.url, password: SVC_PASSWORD, localAddress: SVC_PEER, timeoutMs: 15_000 });
    configureRadicaleRuntime({ client: svc, principal: P, dataDir: rad.server.storageDir, watch: 'off', identitySource: 'remote' });

    await resetCalendarBaseline();
    shape = await buildProductionShape(fx);
    assert.equal(shape.holidays, 91);
    await sql`UPDATE calendars SET ics_feed_enabled = true WHERE role <> 'subscription'`;

    // Lavoro: riunione dell'admin (il suo UID è quello dell'"invito" che l'iPhone duplicherà in c).
    const meetingDay = weekdayOnOrAfter(new Date(Date.now() + 20 * DAY_MS));
    const meeting = await api.post('/api/admin/calendar/events', {
      auth: 'admin',
      body: { calendar_id: shape.lavoro.id, summary: fx.name('Riunione di lavoro'), location: 'Studio', start_time: romeIso(meetingDay, '10:00'), end_time: romeIso(meetingDay, '11:00') },
    });
    assert.equal(meeting.status, 200, meeting.text);
    fx.track('eventIds', meeting.json.event.id);
    win.duplicateUid = meeting.json.event.uid;
    // Personale e scadenze: un giorno intero e una scadenza.
    const allDay = weekdayOnOrAfter(new Date(Date.now() + 30 * DAY_MS));
    const allDayEnd = new Date(Date.parse(`${allDay}T12:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
    for (const [slug, summary] of [['personale', 'Visita medica'], ['scadenze', 'Scadenza F24']] as const) {
      const [cal] = await sql<Array<{ id: string }>>`SELECT id::text AS id FROM calendars WHERE slug = ${slug}`;
      const r = await api.post('/api/admin/calendar/events', {
        auth: 'admin',
        body: { calendar_id: cal.id, summary: fx.name(summary), all_day: true, start_time: romeIso(allDay), end_time: romeIso(allDayEnd) },
      });
      assert.equal(r.status, 200, r.text);
      fx.track('eventIds', r.json.event.id);
    }

    // Tipo di prenotazione pubblico con orari settimanali; prenotazione dal sito prima del passaggio (caso C).
    const schedule = await fx.schedule();
    const et = await fx.eventType({ key: 'prova-generale', durationMinutes: 30, schedule });
    eventTypeSlug = et.slug;
    const pre = await siteBooking('prima-del-passaggio');
    preBooking.uid = pre.uid;
    preBooking.start = pre.start;
    preBooking.date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date(pre.start));
    assert.ok(await legacyRowOfBooking(pre.uid), 'proiezione legacy della prenotazione dal sito');

    feedTokens = new Map(
      (await sql<Array<{ slug: string; ics_feed_token: string }>>`SELECT slug, ics_feed_token FROM calendars WHERE role <> 'subscription' AND origin <> 'migration'`)
        .map((r) => [r.slug, r.ics_feed_token]),
    );
    assert.deepEqual([...feedTokens.keys()].sort(), ['bookings', 'c', 'f', 'lavoro', 'personale', 'scadenze']);

    // Esecutore reale dei run e handler dei job; campanello e control-plane come in produzione.
    registerMigrationRunJob();
    registerShadowMirrorJob();
    registerReverseProjectionJob();
    registerBookingJobs();
    registerStoreJobs();
    configureRadicaleRuntime({ client: svc, principal: P, dataDir: rad.server.storageDir, watch: 'auto', identitySource: 'remote' });
    updateWatchMode('mount', null);
    await startCalendarWatcher({ intervalMs: 200 });
    assert.ok(await startCalendarControlPlane(controlPlaneEnv()), 'control-plane non avviato');
    invalidateBackendModeCache();
  });

  // ─── 1. Migrazione F3 fino allo shadow verde ───────────────────────────────

  let feedsPostgres: Map<string, FeedView> | null = null;

  test('1. migrazione F3 dalle route fino allo shadow verde: il wizard abilita il passaggio', async () => {
    let s = await wizard();
    assert.equal(s.backend.mode, 'postgres');
    assert.equal(s.wizard.steps[5].status, 'locked', 'passo 6 bloccato prima della migrazione');
    feedsPostgres = await feedSnapshot();

    const init = await runRouteOk('/init', { action: 'initialize', confirm: MIGRATION_CONFIRMATIONS.initialize });
    assert.equal(init.summary.epoch, 1);
    const [state] = await sql`SELECT volume_id, epoch FROM calendar_backend_state WHERE id`;
    volumeId = String(state.volume_id);
    epoch0 = Number(state.epoch);
    await waitFor('policy shadow con il volume', async () => {
      const p = await policyNow();
      return p?.volume_id === volumeId && p.mode === 'shadow';
    });
    for (const body of [
      { key: 'phase0', value: { status: 'absent', note: 'nessun volume della Fase 0' }, confirm: MIGRATION_CONFIRMATIONS.declare },
      // Il campanello del test non ha un canary in mount: si dichiara la remote mode come nell'e2e della F3.
      { key: 'remote_mode_accepted', value: { reason: 'stack di test senza canary del mount' }, confirm: MIGRATION_CONFIRMATIONS.declare },
      { key: 'public_401_verified', value: { method: 'curl' }, confirm: MIGRATION_CONFIRMATIONS.declare },
      { key: 'backup_verified', value: { note: 'backup coordinato della copia' }, confirm: MIGRATION_CONFIRMATIONS.declare },
    ]) {
      const res = await api.post(`${BASE}/declarations`, { auth: 'admin', body });
      assert.equal(res.status, 200, res.text);
    }
    // Preflight con le dipendenze di produzione: probe reale, control-plane e campanello avviati.
    const pf = await runRouteOk('/preflight', { probe_public_url: false });
    const notReady = pf.summary.checks.filter((c: { status: string }) => c.status === 'fail' || c.status === 'confirm');
    assert.equal(pf.summary.ready, true, JSON.stringify(notReady));

    const plan = await runRouteOk('/plan', { options: {} });
    assert.equal(plan.summary.totals.conflict, 0, JSON.stringify(plan.summary.conflicts));
    const apply = await runRouteOk('/apply', { plan_run_id: plan.id, confirm: MIGRATION_CONFIRMATIONS.apply });
    assert.equal(apply.summary.failed, 0);
    const plan2 = await runRouteOk('/plan', {});
    assert.equal(plan2.summary.writes, 0, 'seconda anteprima a zero scritture');

    const verified = await runRouteOk('/verify', {});
    assert.notEqual(verified.summary.overall, 'red', JSON.stringify(verified.summary.calendars));
    if (verified.summary.overall === 'yellow') {
      const accepted = await api.post(`${BASE}/runs/${verified.id}/accept`, { auth: 'admin', body: { all_expected: true, confirm: MIGRATION_CONFIRMATIONS.accept } });
      assert.equal(accepted.status, 200, accepted.text);
      assert.equal(accepted.json.acceptable, true);
    }

    const shadow = await api.post(`${BASE}/shadow`, { auth: 'admin', body: { enabled: true, confirm: MIGRATION_CONFIRMATIONS.shadowOn } });
    assert.equal(shadow.status, 200, shadow.text);
    await drainJobs();
    // Sette giorni di parità verde emulati: giri notturni verdi retrodatati (il test non aspetta una settimana).
    const now = Date.now();
    await sql`UPDATE calendar_backend_state SET shadow_since = ${new Date(now - 9 * DAY_MS)} WHERE id`;
    for (let d = 7; d >= 1; d--) {
      const at = new Date(now - d * DAY_MS - 2 * 3_600_000);
      await sql`
        INSERT INTO cal_migration_runs (kind, status, trigger, requested_by, params, summary, created_at, started_at, finished_at, attempts)
        VALUES ('verify', 'succeeded', 'schedule', 'system:shadow', ${sql.json(FULL_VERIFY as never)}, ${sql.json({ acceptable: true, overall: 'green' } as never)}, ${at}, ${at}, ${at}, 1)
      `;
    }
    const nightly = await runRouteOk('/verify', {});
    await sql`UPDATE cal_migration_runs SET trigger = 'schedule', requested_by = 'system:shadow' WHERE id = ${nightly.id}::uuid`;
    if (nightly.summary.overall === 'yellow') {
      const accepted = await api.post(`${BASE}/runs/${nightly.id}/accept`, { auth: 'admin', body: { all_expected: true, confirm: MIGRATION_CONFIRMATIONS.accept } });
      assert.equal(accepted.status, 200, accepted.text);
    }
    const parity = await api.get(`${BASE}/parity`, { auth: 'admin' });
    assert.equal(parity.status, 200, parity.text);
    assert.equal(parity.json.satisfied, true, `parità soddisfatta: ${JSON.stringify(parity.json)}`);

    // Matrice device dalla route; backup coordinato registrato (come lo registra backup-calendar-stack.sh).
    const matrix = await api.post(`${BASE}/declarations`, {
      auth: 'admin',
      body: { key: 'device_matrix', value: { result: 'passed', devices: ['ios', 'macos', 'davx5', 'thunderbird'], strict_preconditions: true, allday_transp_rule: 'opaque_blocks' } },
    });
    assert.equal(matrix.status, 200, matrix.text);
    await sql`
      UPDATE calendar_backend_state
      SET last_stack_backup = ${sql.json({ id: 'b-prova', at: new Date().toISOString(), complete: true, volume_id: volumeId, epoch: epoch0, manifest_sha256: null } as never)}
      WHERE id
    `;

    s = await wizard();
    const criteria = s.wizard?.cutover?.criteria ?? s.cutover?.criteria ?? null;
    const cutover = s.wizard.steps[5].actions.find((a: { id: string }) => a.id === 'cutover');
    assert.ok(cutover?.enabled, `passaggio abilitato: ${JSON.stringify({ step: s.wizard.steps[5], criteria })}`);
    assert.equal(cutover.confirm, MIGRATION_CONFIRMATIONS.cutover);
    await sleep(PLUGIN_RELOAD_MS);
    assert.equal(await deviceProbe('prima-del-passaggio'), 403, 'in mode postgres i device sono in sola lettura');
    // Postgres autorevole: nessun cambio di comportamento prima della conferma.
    const st = await backend();
    assert.deepEqual({ mode: st.mode, write_freeze: st.write_freeze, cutover_at: st.cutover_at }, { mode: 'postgres', write_freeze: false, cutover_at: null });
    assertSameFeeds(feedsPostgres, await feedSnapshot(), 'feed dopo la migrazione F3 (ancora dallo store legacy)');
  });

  // ─── 2. Cutover con kill e ripresa ───────────────────────────────

  test('2. cutover dal wizard con un kill prima e uno dopo il punto di non ritorno, ripresa fino in fondo', async () => {
    assert.ok(feedsPostgres);
    // Conferma sbagliata: rifiutata senza effetti.
    const wrong = await api.post(`${BASE}/cutover`, { auth: 'admin', body: { confirm: 'passa a radicale' }, headers: { 'Idempotency-Key': key('wrong') } });
    assert.equal(wrong.status, 400, wrong.text);
    assert.equal((await backend()).mode, 'postgres');

    kills.add('cutover:delta_verify');
    kills.add('cutover:reverse_start');
    setTransitionTestHooks({
      beforeStep: async (kind, step) => {
        if (!kills.delete(`${kind}:${step}`)) return;
        throw new Error(KILL);
      },
    });
    let cutoverRun;
    try {
      cutoverRun = await transitionToEnd(
        { path: '/cutover', body: { confirm: MIGRATION_CONFIRMATIONS.cutover, rollback_window_days: 30 } },
        MIGRATION_CONFIRMATIONS.cutover,
        async (_run, n) => {
          const st = await backend();
          if (n === 1) {
            // Prima dell'epoch: Postgres autorevole, scritture ferme, annullamento ancora possibile.
            assert.deepEqual({ mode: st.mode, write_freeze: st.write_freeze, epoch: st.epoch }, { mode: 'cutover', write_freeze: true, epoch: epoch0 });
            assert.equal(await markerEpoch(), epoch0);
            await waitFor('policy frozen', async () => (await policyNow())?.mode === 'frozen');
            await sleep(PLUGIN_RELOAD_MS);
            assert.equal(await deviceProbe('durante-il-passaggio'), 403, 'device in sola lettura durante il passaggio');
            const admin = await api.post('/api/admin/calendar/events', {
              auth: 'admin',
              body: { calendar_id: shape!.c.id, summary: fx.name('Durante il passaggio'), start_time: '2027-04-06T08:00:00Z', end_time: '2027-04-06T09:00:00Z' },
            });
            assert.equal(admin.status, 503, `scritture dell'admin ferme durante il passaggio: ${admin.text}`);
            assert.equal((await step6Action('cutover_abort')).enabled, true, 'annullamento possibile prima dell\'epoch');
            assertSameFeeds(feedsPostgres!, await feedSnapshot(), 'feed durante il passaggio');
          } else {
            // Dopo l'epoch: mode radicale con il freeze, annullamento rifiutato.
            assert.deepEqual({ mode: st.mode, write_freeze: st.write_freeze, epoch: st.epoch }, { mode: 'radicale', write_freeze: true, epoch: epoch0 + 1 });
            assert.equal(await markerEpoch(), epoch0 + 1);
            const abort = await api.post(`${BASE}/cutover/abort`, { auth: 'admin', body: { confirm: MIGRATION_CONFIRMATIONS.cutoverAbort }, headers: { 'Idempotency-Key': key('abort') } });
            assert.equal(abort.status, 409, abort.text);
            assert.ok(JSON.stringify(abort.json).includes('TRANSITION_NOT_ABORTABLE'), abort.text);
          }
        },
      );
    } finally {
      setTransitionTestHooks(null);
    }
    assert.equal(kills.size, 0, 'entrambi i kill eseguiti');
    assert.equal(cutoverRun.summary.outcome, 'completed');
    assert.equal(cutoverRun.summary.smoke?.ok, true, JSON.stringify(cutoverRun.summary.smoke));
    assert.equal(cutoverRun.summary.reverse?.failed ?? 0, 0);

    const st = await backend();
    assert.deepEqual({ mode: st.mode, write_freeze: st.write_freeze, epoch: st.epoch, api_min_version: st.api_min_version },
      { mode: 'radicale', write_freeze: false, epoch: epoch0 + 1, api_min_version: CALENDAR_API_LEVEL });
    assert.ok(st.rollback_until && st.rollback_until.getTime() > Date.now() + 29 * DAY_MS, 'finestra di rollback di 30 giorni');
    await waitFor('policy live con il nuovo epoch', async () => {
      const p = await policyNow();
      return p?.mode === 'live' && p.epoch === epoch0 + 1;
    });
    await sleep(PLUGIN_RELOAD_MS);
    invalidateBackendModeCache();
    assert.equal((await calendarStore()).kind, 'radicale');
    for (const id of ['rollback_preview', 'export_v2']) assert.equal((await step6Action(id)).enabled, true, `${id} nel passo 6 dopo il passaggio`);
    assert.equal((await step6Action('finalize')).enabled, false, 'finalize non prima di 14 giorni');
    assertSameFeeds(feedsPostgres, await feedSnapshot(), 'feed dopo il passaggio (store Radicale, stessi token)');
  });

  // ─── 3. Uso misto nella finestra di rollback ───────────────────────────────

  let feedsBeforeRollback: Map<string, FeedView> | null = null;

  test('3. uso misto: device, admin, MCP, prenotazione dal sito e casi A e C del red-team', async () => {
    assert.ok(shape);
    // Device: crea con un href proprio (diverso dall'UID) e un VALARM.
    win.iphoneUid = randomUUID().toUpperCase();
    win.iphoneHref = `${randomUUID().toUpperCase()}.ics`;
    assert.equal(await devicePut('c', win.iphoneHref, deviceIcs([
      `UID:${win.iphoneUid}`, 'DTSTAMP:20261016T080000Z', 'DTSTART:20270301T090000Z', 'DTEND:20270301T100000Z', 'SUMMARY:Dentista (iPhone)',
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Promemoria', 'TRIGGER:-PT15M', 'END:VALARM',
    ])), 201);
    // Device: modifica un oggetto migrato (copia "Duplica") e ne cancella un altro.
    win.editedHref = await hrefOf(`event:${shape.duplicateCopy.id}`);
    const edited = await svc!.get(objectPath(P, 'c', win.editedHref));
    const editStatus = await devicePut('c', win.editedHref, edited.body.replace(/^SUMMARY:.*$/m, 'SUMMARY:Copia rinominata dal telefono'), { ifMatch: edited.etag as string });
    assert.ok(editStatus >= 200 && editStatus < 300, `modifica del device: ${editStatus}`);
    win.deletedId = shape.occurrenceDuplicate.id;
    win.deletedHref = await hrefOf(`event:${win.deletedId}`);
    const toDelete = await svc!.get(objectPath(P, 'c', win.deletedHref));
    const deleteStatus = (await device().delete(`/${P}/c/${win.deletedHref}`, { ifMatch: toDelete.etag as string })).status;
    assert.ok(deleteStatus >= 200 && deleteStatus < 300, `cancellazione del device: ${deleteStatus}`);

    // Caso A: UID dell'invito duplicato in c, durata zero, evento senza titolo, override con l'UID del master, UID con '@'.
    assert.equal(await devicePut('c', `${randomUUID().toUpperCase()}.ics`, deviceIcs([
      `UID:${win.duplicateUid}`, 'DTSTAMP:20261016T080000Z', 'DTSTART:20270302T140000Z', 'DTEND:20270302T150000Z', 'SUMMARY:Invito duplicato (iPhone)',
    ])), 201);
    win.zeroUid = randomUUID().toUpperCase();
    assert.equal(await devicePut('c', `${win.zeroUid}.ics`, deviceIcs([
      `UID:${win.zeroUid}`, 'DTSTAMP:20261016T080000Z', 'DTSTART:20270303T090000Z', 'DTEND:20270303T090000Z', 'SUMMARY:Durata zero (iPhone)',
    ])), 201);
    win.untitledUid = randomUUID().toUpperCase();
    assert.equal(await devicePut('c', `${win.untitledUid}.ics`, deviceIcs([
      `UID:${win.untitledUid}`, 'DTSTAMP:20261016T080000Z', 'DTSTART:20270304T090000Z', 'DTEND:20270304T100000Z',
    ])), 201);
    win.recurringUid = randomUUID().toUpperCase();
    assert.equal(await devicePut('c', `${win.recurringUid}.ics`, deviceIcs(
      [`UID:${win.recurringUid}`, 'DTSTAMP:20261016T080000Z', 'DTSTART:20270308T100000Z', 'DTEND:20270308T110000Z', 'RRULE:FREQ=WEEKLY;COUNT=4', 'SUMMARY:Corso settimanale (iPhone)'],
      [`UID:${win.recurringUid}`, 'DTSTAMP:20261016T080000Z', 'RECURRENCE-ID:20270315T100000Z', 'DTSTART:20270315T120000Z', 'DTEND:20270315T130000Z', 'SUMMARY:Corso settimanale (spostato)'],
    )), 201);
    assert.equal(await devicePut('c', `${randomUUID().toUpperCase()}.ics`, deviceIcs([
      `UID:${randomUUID()}@iphone.test`, 'DTSTAMP:20261016T080000Z', 'DTSTART:20270305T090000Z', 'DTEND:20270305T100000Z', 'SUMMARY:UID con chiocciola (iPhone)',
    ])), 201);

    // Admin v1 e MCP sullo store Radicale: creazione e modifica.
    const created = await api.post('/api/admin/calendar/events', {
      auth: 'admin',
      body: { calendar_id: shape.c.id, summary: fx.name('Admin nella finestra'), start_time: '2027-03-08T08:00:00Z', end_time: '2027-03-08T09:00:00Z' },
    });
    assert.equal(created.status, 200, created.text);
    win.adminEventId = created.json.event.id;
    const adminEdit = await api.put(`/api/admin/calendar/events/${shape.singles[0].id}`, { auth: 'admin', body: { summary: fx.name('Modificato dall\'admin nella finestra') } });
    assert.equal(adminEdit.status, 200, adminEdit.text);
    const mcpCreated = JSON.parse(await executeTool('create_event', { calendar: 'c', summary: fx.name('Da MCP nella finestra'), start: '2027-03-09T09:00:00Z', end: '2027-03-09T10:00:00Z' }));
    assert.equal(mcpCreated.error, undefined, JSON.stringify(mcpCreated));
    win.mcpEventId = String(mcpCreated.event?.id ?? mcpCreated.id ?? '');
    const mcpEdited = JSON.parse(await executeTool('update_event', { id_or_uid: (shape.singles[1] ?? shape.singles[0]).id, location: 'Sala riunioni (MCP)' }));
    assert.equal(mcpEdited.error, undefined, JSON.stringify(mcpEdited));

    // Prenotazione dal sito nella finestra; caso C: la prenotazione di prima del passaggio annullata dall'admin.
    const booked = await siteBooking('nella-finestra', [preBooking.start]);
    windowBooking.uid = booked.uid;
    windowBooking.start = booked.start;
    looseUidPrefixes.push(booked.uid);
    const cancelled = await api.post(`/api/admin/calendar/bookings/${preBooking.uid}/cancel`, { auth: 'admin', body: { reason: 'Annullata nella finestra di rollback' } });
    assert.equal(cancelled.status, 200, cancelled.text);
    await drainJobs();

    // Proiezione inversa: sync dell'indice, giro di backstop (cron calendar-reverse-sweep) e job per collezione.
    await syncAllCollections({ reason: 'manual', actor: 'test' });
    const sweep = await runReverseProjectionSweep();
    assert.ok(sweep.enqueued >= 1, 'collezioni accodate dal giro di backstop');
    await drainJobs();
    const health = await api.get(`${BASE}/reverse`, { auth: 'admin' });
    assert.equal(health.status, 200, health.text);
    assert.equal(health.json.active, true);
    assert.equal(health.json.by_status.failed ?? 0, 0, `nessun REVERSE_FAILED: ${JSON.stringify(health.json)}`);
    assert.equal(health.json.queue.dead, 0);
    const [{ dead }] = await sql`SELECT count(*)::int AS dead FROM cal_jobs WHERE status = 'dead'`;
    assert.equal(dead, 0, 'nessun job in dead letter');

    // Caso A in PG: righe classificate e sanificate, mai un job fallito.
    const [dup] = await sql`
      SELECT e.uid FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id
      WHERE c.slug = 'c' AND e.summary LIKE 'Invito duplicato%'
    `;
    assert.ok(dup, 'invito duplicato proiettato in c');
    assert.notEqual(dup.uid, win.duplicateUid, 'UID duplicato sanificato');
    const [zero] = await sql`SELECT start_time, end_time FROM calendar_events WHERE summary LIKE 'Durata zero%'`;
    assert.ok(zero && new Date(zero.end_time).getTime() > new Date(zero.start_time).getTime(), 'durata zero portata a una durata positiva');
    const [untitled] = await sql`SELECT summary FROM calendar_events WHERE uid = ${win.untitledUid}`;
    assert.equal(untitled?.summary, '(senza titolo)');
    const recurring = await sql`SELECT uid FROM calendar_events WHERE uid LIKE ${`${win.recurringUid}%`} ORDER BY uid`;
    assert.ok(recurring.length >= 2, 'serie del device con l\'override proiettata');
    assert.equal(new Set(recurring.map((r) => r.uid)).size, recurring.length, 'UID distinti per master e override');
    // Caso C nella finestra: la riga legacy segue la prenotazione annullata.
    assert.equal((await legacyRowOfBooking(preBooking.uid))?.status, 'cancelled');
    assert.equal((await legacyRowOfBooking(windowBooking.uid))?.status, 'confirmed', 'prenotazione della finestra proiettata in PG');

    feedsBeforeRollback = await feedSnapshot();
  });

  // ─── 4. Rollback con kill e ripresa ───────────────────────────────

  let previewHash = '';

  test('4. rollback dal wizard: anteprima, kill prima e dopo il punto di non ritorno, busy identico, degradi pari all\'anteprima', async () => {
    assert.ok(feedsBeforeRollback);
    const preview = await runRouteOk('/rollback/preview', {});
    const s = preview.summary;
    previewHash = s.preview_hash;
    assert.match(previewHash, /^[0-9a-f]{64}$/);
    assert.equal(s.reverse_failed, 0);
    assert.equal(s.busy_identical, true, 'busy legacy previsto identico a quello di Radicale');
    for (const cls of ['SANITIZED_UID', 'REPR_LOSS_VALARM']) assert.ok((s.by_class[cls] ?? 0) >= 1, `degrado ${cls} in anteprima: ${JSON.stringify(s.by_class)}`);
    assert.ok(s.changes_since_cutover.created >= 6, JSON.stringify(s.changes_since_cutover));
    const degradations = await api.get(`${BASE}/runs/${preview.id}/items`, { auth: 'admin', query: { item_type: 'degradation', limit: 500 } });
    assert.equal(degradations.status, 200, degradations.text);
    assert.ok(degradations.json.items.length >= 2, 'righe dei degradi nel run dell\'anteprima');
    const action = await step6Action('rollback');
    assert.equal(action.enabled, true, JSON.stringify(action));
    assert.equal(action.confirm, MIGRATION_CONFIRMATIONS.rollback);

    const indexBusy = await indexBusyRanges(sql, BUSY_FROM, BUSY_TO, { includeBookingProjections: true });
    kills.add('rollback:reverse_final');
    kills.add('rollback:control_plane');
    setTransitionTestHooks({
      beforeStep: async (kind, step) => {
        if (!kills.delete(`${kind}:${step}`)) return;
        throw new Error(KILL);
      },
    });
    let rollbackRun;
    try {
      rollbackRun = await transitionToEnd(
        { path: '/rollback', body: { preview_run_id: preview.id, expect_preview_hash: previewHash, confirm: MIGRATION_CONFIRMATIONS.rollback } },
        MIGRATION_CONFIRMATIONS.rollback,
        async (_run, n) => {
          const st = await backend();
          if (n === 1) {
            // Prima dell'epoch: freeze, device fermi prima della fotografia finale.
            assert.deepEqual({ mode: st.mode, write_freeze: st.write_freeze, epoch: st.epoch }, { mode: 'rollback', write_freeze: true, epoch: epoch0 + 1 });
            await waitFor('policy frozen', async () => (await policyNow())?.mode === 'frozen');
            await sleep(PLUGIN_RELOAD_MS);
            assert.equal(await deviceProbe('durante-il-rollback'), 403, 'device fermi durante il rollback');
            assert.equal((await step6Action('cutover_abort')).enabled, true, 'annullamento del rollback possibile prima dell\'epoch');
          } else {
            assert.deepEqual({ mode: st.mode, epoch: st.epoch }, { mode: 'postgres', epoch: epoch0 + 2 });
            const abort = await api.post(`${BASE}/rollback/abort`, { auth: 'admin', body: { confirm: MIGRATION_CONFIRMATIONS.cutoverAbort }, headers: { 'Idempotency-Key': key('abort-rb') } });
            assert.equal(abort.status, 409, abort.text);
            assert.ok(JSON.stringify(abort.json).includes('TRANSITION_NOT_ABORTABLE'), abort.text);
          }
        },
      );
    } finally {
      setTransitionTestHooks(null);
    }
    assert.equal(kills.size, 0, 'entrambi i kill eseguiti');
    const summary = rollbackRun.summary;
    assert.equal(summary.outcome, 'completed');
    assert.equal(summary.final_preview_hash, previewHash, 'anteprima ricalcolata dopo la quiescenza uguale a quella confermata: degradi pari all\'anteprima');
    assert.equal(summary.reverse?.failed ?? 0, 0);

    const st = await backend();
    assert.deepEqual({ mode: st.mode, write_freeze: st.write_freeze, epoch: st.epoch, rollback_until: st.rollback_until, cutover_at: st.cutover_at },
      { mode: 'postgres', write_freeze: false, epoch: epoch0 + 2, rollback_until: null, cutover_at: null });
    assert.equal(await markerEpoch(), epoch0 + 2);
    await waitFor('policy shadow con il nuovo epoch', async () => {
      const p = await policyNow();
      return p?.mode === 'shadow' && p.epoch === epoch0 + 2;
    });
    await waitFor('heartbeat postgres', async () => {
      const hb = await readHeartbeatFile(heartbeatFile);
      return hb.state === 'ok' && hb.value.mode === 'postgres' && hb.value.epoch === epoch0 + 2;
    });
    await sleep(PLUGIN_RELOAD_MS);
    assert.equal(await deviceProbe('dopo-il-rollback'), 403, 'device di nuovo in sola lettura');
    invalidateBackendModeCache();
    assert.equal((await calendarStore()).kind, 'postgres');

    // Busy identico; caso C: slot di nuovo libero; prenotazione della finestra e scritture della finestra in PG.
    assert.ok(sameBusy(await legacyBusyRanges(BUSY_FROM, BUSY_TO), indexBusy), 'busy legacy dopo il rollback identico a quello di Radicale');
    assert.equal((await legacyRowOfBooking(preBooking.uid))?.status, 'cancelled');
    assert.equal(await slotFree(preBooking.date, preBooking.start), true, 'slot della prenotazione annullata nella finestra di nuovo libero');
    assert.equal((await legacyRowOfBooking(windowBooking.uid))?.status, 'confirmed');
    for (const id of [win.adminEventId, win.mcpEventId].filter(Boolean)) {
      const [row] = await sql`SELECT id FROM calendar_events WHERE id = ${id}::uuid`;
      assert.ok(row, `evento ${id} della finestra in PG con lo stesso id`);
    }
    const [gone] = await sql`SELECT status FROM calendar_events WHERE id = ${win.deletedId}::uuid`;
    assert.ok(!gone || gone.status === 'cancelled', 'evento cancellato dal device assente dal legacy');
    const [{ jobs }] = await sql`SELECT count(*)::int AS jobs FROM cal_jobs WHERE kind = 'reverse_projection' AND status = 'pending'`;
    assert.equal(jobs, 0, 'proiezione inversa ferma');
    assert.equal((await step6Action('cutover')).id, 'cutover');
    assertSameFeeds(feedsBeforeRollback, await feedSnapshot(), 'feed dopo il rollback (store legacy)');
  });

  // ─── 5. Nuovo cutover a zero scritture ───────────────────────────────

  test('5. nuovo cutover dal wizard (caso B): verifica accettabile dopo il rollback, delta a zero scritture', async () => {
    assert.ok(feedsBeforeRollback);
    const feedsAfterRollback = await feedSnapshot();
    const plan = await runRouteOk('/plan', {});
    assert.equal(plan.summary.writes, 0, `nessuna scrittura per gli oggetti non toccati: ${JSON.stringify(plan.summary.totals)}`);
    assert.equal(plan.summary.totals.conflict, 0, JSON.stringify(plan.summary.conflicts));
    const verified = await runRouteOk('/verify', {});
    const unexpected = await api.get(`${BASE}/runs/${verified.id}/items`, { auth: 'admin', query: { item_type: 'diff', limit: 500 } });
    assert.notEqual(verified.summary.overall, 'red',
      JSON.stringify(unexpected.json.items.filter((d: { expected: boolean }) => !d.expected).map((d: { level: string; code: string; href: string; detail: unknown }) => ({ level: d.level, code: d.code, href: d.href, detail: d.detail }))));
    if (verified.summary.overall === 'yellow') {
      const accepted = await api.post(`${BASE}/runs/${verified.id}/accept`, { auth: 'admin', body: { all_expected: true, confirm: MIGRATION_CONFIRMATIONS.accept } });
      assert.equal(accepted.status, 200, accepted.text);
      assert.equal(accepted.json.acceptable, true, 'verifica dopo il rollback accettabile');
    }
    // Backup coordinato fresco con l'epoch dopo il rollback.
    await sql`
      UPDATE calendar_backend_state
      SET last_stack_backup = ${sql.json({ id: 'b-prova-2', at: new Date().toISOString(), complete: true, volume_id: volumeId, epoch: epoch0 + 2, manifest_sha256: null } as never)}
      WHERE id
    `;
    const action = await step6Action('cutover');
    assert.equal(action.enabled, true, `nuovo passaggio abilitato: ${JSON.stringify(action)}`);

    const second = await runRouteOk('/cutover', { confirm: MIGRATION_CONFIRMATIONS.cutover, rollback_window_days: 14 });
    assert.equal(second.summary.outcome, 'completed');
    assert.deepEqual(second.summary.delta?.writes, { create: 0, update: 0, delete: 0 }, `delta del nuovo cutover: ${JSON.stringify(second.summary.delta)}`);
    assert.equal(second.summary.smoke?.ok, true, JSON.stringify(second.summary.smoke));
    const st = await backend();
    assert.deepEqual({ mode: st.mode, epoch: st.epoch, write_freeze: st.write_freeze }, { mode: 'radicale', epoch: epoch0 + 3, write_freeze: false });
    await waitFor('policy live', async () => {
      const p = await policyNow();
      return p?.mode === 'live' && p.epoch === epoch0 + 3;
    });
    await sleep(PLUGIN_RELOAD_MS);
    // L'oggetto dell'iPhone resta al suo href con il VALARM del device.
    const iphone = await svc!.get(objectPath(P, 'c', win.iphoneHref));
    assert.match(iphone.body, /BEGIN:VALARM/);
    assertSameFeeds(feedsAfterRollback, await feedSnapshot(), 'feed dopo il nuovo passaggio');
  });

  // ─── 6. Rollback d'immagine API simulato ───────────────────────────────

  test('6. rollback d\'immagine simulato: heartbeat fermo → device frozen, scritture legacy bloccate, livello dell\'API', async () => {
    assert.ok(shape);
    assert.equal(await deviceProbe('live'), 201, 'device live in mode radicale');

    // Immagine vecchia: non scrive il heartbeat (fermo da più di 10 minuti) → device frozen.
    await stopCalendarControlPlane();
    const hb = await readHeartbeatFile(heartbeatFile);
    assert.equal(hb.state, 'ok');
    if (hb.state !== 'ok') return;
    writeFileSync(heartbeatFile, JSON.stringify({ ...hb.value, ts: new Date(Date.now() - 11 * 60_000).toISOString() }), { mode: 0o644 });
    await sleep(PLUGIN_RELOAD_MS);
    assert.equal(await deviceProbe('heartbeat-fermo'), 403, 'device frozen con il heartbeat fermo');

    // Le scritture legacy di un'immagine vecchia (PgLegacyStore) falliscono sulla guardia 166.
    await assert.rejects(
      legacyCreateEvent({ calendar_id: shape.c.id, summary: 'Scrittura di un\'immagine vecchia', start_time: '2027-05-03T08:00:00Z', end_time: '2027-05-03T09:00:00Z' } as never),
      (err: unknown) => (err as { code?: string }).code === 'CD166',
    );

    // Un'immagine F4 con un livello più basso di api_min_version non serve il calendario.
    await sql`UPDATE calendar_backend_state SET api_min_version = ${CALENDAR_API_LEVEL + 1} WHERE id`;
    try {
      assert.equal(await enforceCalendarApiLevelAtBoot(), false);
      assert.equal(calendarApiLevelBlocked(), true);
      const res = await api.get(`/api/calendar/feed/${feedTokens.get('c')}.ics`);
      assert.equal(res.status, 503, `feed non servito da un'immagine di livello insufficiente: ${res.status}`);
    } finally {
      await sql`UPDATE calendar_backend_state SET api_min_version = ${CALENDAR_API_LEVEL} WHERE id`;
      resetCalendarApiLevelForTests();
    }
    assert.equal(await enforceCalendarApiLevelAtBoot(), true);

    // Ritorno all'immagine giusta: heartbeat di nuovo scritto, device live.
    assert.ok(await startCalendarControlPlane(controlPlaneEnv()), 'control-plane riavviato');
    await waitFor('heartbeat fresco', async () => {
      const now = await readHeartbeatFile(heartbeatFile);
      return now.state === 'ok' && Date.now() - Date.parse(now.value.ts) < 60_000;
    });
    await sleep(PLUGIN_RELOAD_MS);
    assert.equal(await deviceProbe('di-nuovo-live'), 201, 'device di nuovo live');
    assert.equal(await getActiveTransition(sql), null);
    // Token dei feed invariati in tutta la prova.
    const tokens = await sql<Array<{ slug: string; ics_feed_token: string }>>`SELECT slug, ics_feed_token FROM calendars WHERE role <> 'subscription' AND origin <> 'migration'`;
    for (const t of tokens) assert.equal(t.ics_feed_token, feedTokens.get(t.slug), `token del feed di ${t.slug} invariato`);
  });
});
