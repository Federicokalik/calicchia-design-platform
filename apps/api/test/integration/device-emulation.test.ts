/**
 * Emulazione del traffico dei device (fase F3 del passaggio del calendario a
 * Radicale, piano attività 6; matrice docs/calendar-radicale/matrice-device.md;
 * contratto f3-modules §14.2): le sequenze di richieste tipiche di iOS e macOS
 * (dataaccessd, CalendarAgent), DAVx5 e Thunderbird contro un Radicale 3.7.8
 * con il config di PRODUZIONE e i plugin del repository:
 *
 *  - apps/radicale/config/config con i soli percorsi sostituiti e
 *    strict_preconditions = True, il valore che la matrice propone (vedi
 *    decisioni.md, "da confermare dall'utente");
 *  - caldes_auth (verify-credentials simulato da mock_verify.py, per poterne
 *    provocare i guasti), caldes_rights e caldes_vobject_fix (sitecustomize);
 *  - policy.json e heartbeat.json scritti dal control-plane dell'API
 *    (startCalendarControlPlane) dallo stato in Postgres, con il volume
 *    inizializzato da initializeVolume() come caldes-svc dal peer di caldav-int;
 *  - i calendari con gli slug e i ruoli della produzione (c, f festività,
 *    lavoro, personale, bookings, scadenze).
 *
 * Rete simulata sul loopback /8 (Linux), come integration/radicale-f1-e2e:
 * 127.0.0.2 è l'API su caldav-int (CALDES_SVC_CIDR), 127.0.0.3 il gateway della
 * porta pubblicata da cui arrivano i device con X-Remote-Addr.
 *
 * Casi (righe della matrice):
 *  1. discovery di ogni client (/.well-known/caldav, principal canonico per
 *     qualsiasi username, calendar-home-set, elenco senza _canary, privilegi);
 *  2. sincronizzazione: sync-collection iniziale e incrementale, multiget,
 *     ctag, calendar-query con expand attraverso il cambio dell'ora;
 *  3. shadow: ogni scrittura 403 senza WWW-Authenticate, password mai
 *     invalidata;
 *  4. live temporaneo (come lo stack di prova della matrice, mai in
 *     produzione in F3): If-Match con strict_preconditions = True (ETag vecchio
 *     → 412, PUT senza If-Match su un oggetto esistente → 412), collezioni
 *     protette in sola lettura, MKCALENDAR dal device con il badge della
 *     decisione 4 dopo la discovery dell'API, X-prop e VALARM intatti, TRANSP
 *     degli all-day con le due regole della decisione 6, fusi orari;
 *  5. backend di autenticazione giù: 500 senza ritardo e senza challenge
 *     (nessun client scarta la password), credenziali in cache accettate,
 *     401 solo per una password davvero sbagliata.
 *
 * Non sostituisce la prova sui device veri (procedura in staging nella
 * matrice): fissa le attese lato server, così un esito diverso sul telefono si
 * attribuisce al client e non a Radicale o ai plugin. Gira solo con
 * RADICALE_BIN e Python; senza 127.0.0.2/127.0.0.3 utilizzabili come indirizzi
 * sorgente la suite è saltata con il motivo. Lo stato del backend torna alla
 * baseline a fine file.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  classifyOccurrenceKind,
  computeBlocks,
  expandObject,
  parseCalendarObject,
} from '@calicchia/calendar-core';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';
import {
  type CalDavClient,
  type DavPropName,
  type DavResponse,
  type DavResponseEntry,
  DAV_PROPS,
  type IcsComponent,
  NS,
  parseIcsTree,
  pythonAvailability,
  RADICALE_PLUGINS_DIR,
  radicaleAvailability,
  resolvePython,
  TEST_PRINCIPAL,
  unfoldIcs,
  useMockVerify,
  useRadicale,
  xmlChild,
  xmlChildren,
  xmlText,
} from '../helpers/radicale';
import { invalidateBackendModeCache } from '../../src/lib/calendar/backend-mode';
import { createCalendar } from '../../src/lib/calendar/calendars';
import { objectPath, RadicaleClient } from '../../src/lib/calendar/radicale/client';
import { discoverCollections, listRadicaleCollections } from '../../src/lib/calendar/radicale/discovery';
import { readHeartbeatFile, startCalendarControlPlane, stopCalendarControlPlane } from '../../src/lib/calendar/radicale/heartbeat';
import { initializeVolume } from '../../src/lib/calendar/radicale/identity';
import { allDayOpaqueBlocksFromEnv } from '../../src/lib/calendar/radicale/indexer';
import { readPolicyFile } from '../../src/lib/calendar/radicale/policy';
import { configureRadicaleRuntime } from '../../src/lib/calendar/radicale/sync';
import type { CaldesPolicy } from '../../src/lib/calendar/radicale/types';

const radicale = radicaleAvailability();
const python = pythonAvailability();
const fx = useFixtures('device-emu', { resetBaseline: true });
onBeforeDatabaseClose(() => resetCalendarBaseline());

const P = TEST_PRINCIPAL;
const SVC_PASSWORD = 'test-only-svc-password-device-emu';
const PROBE_PASSWORD = 'test-only-probe-password-device-emu';
const AUTHCACHE_KEY = 'test-only-authcache-key-device-emu-0123456789abcdef';
/** API sulla rete interna caldav-int: l'unico peer ammesso per caldes-svc. */
const SVC_PEER = '127.0.0.2';
/** Gateway della porta pubblicata: da qui arriva il traffico dei device (CloudPanel). */
const GATEWAY = '127.0.0.3';
/** Ricontrollo di policy, heartbeat e props nei plugin: al massimo una volta al secondo. */
const PLUGIN_RELOAD_MS = 1_100;
const API_VERSION = 'sha-deviceemu';
const PRODUCTION_CONFIG = join(RADICALE_PLUGINS_DIR, '..', 'config', 'config');
const ROME = 'Europe/Rome';

/** 127.0.0.2/127.0.0.3 utilizzabili come indirizzi sorgente (Linux): prova sincrona per lo skip della suite. */
function peersAvailable(): string | null {
  for (const address of [SVC_PEER, GATEWAY]) {
    const res = spawnSync(resolvePython(), ['-I', '-c', 'import socket,sys; s=socket.socket(); s.bind((sys.argv[1], 0)); s.close()', address], { timeout: 10_000 });
    if (res.status !== 0) return `${address} non utilizzabile come indirizzo sorgente`;
  }
  return null;
}
const PEERS_SKIP = radicale.skip || python.skip ? null : peersAvailable();

// ─── Profili dei client ─────────────────────────────────────

type DeviceId = 'ios' | 'macos' | 'davx5' | 'thunderbird';

interface DeviceProfile {
  id: DeviceId;
  /** Username dell'app-password (storico: diverso da federico per iOS, DAVx5 e Thunderbird). */
  username: string;
  password: string;
  userAgent: string;
  /** IP pubblico del device (X-Remote-Addr messo da CloudPanel). */
  ip: string;
  /** Configurazione: discovery dal server (iOS, macOS, DAVx5) o URL della collezione (Thunderbird). */
  discovery: 'server' | 'collection-url';
}

const DEVICES: Record<DeviceId, DeviceProfile> = {
  ios: { id: 'ios', username: 'iphone', password: 'tst-app-password-ios-1', userAgent: 'iOS/18.0 (22A3354) dataaccessd/1.0', ip: '203.0.113.10', discovery: 'server' },
  macos: { id: 'macos', username: 'federico', password: 'tst-app-password-macos-1', userAgent: 'macOS/15.0 (24A335) CalendarAgent/1000.1', ip: '203.0.113.11', discovery: 'server' },
  davx5: { id: 'davx5', username: 'davx5', password: 'tst-app-password-davx5-1', userAgent: 'DAVx5/4.4.3-ose (2024/09/19; dav4jvm; okhttp/4.12.0) Android/14', ip: '203.0.113.12', discovery: 'server' },
  thunderbird: { id: 'thunderbird', username: 'thunderbird', password: 'tst-app-password-tb-1', userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Thunderbird/128.3.0', ip: '203.0.113.13', discovery: 'collection-url' },
};
const ALL_DEVICES = Object.values(DEVICES);
/** Device mai visto da Radicale: serve al caso del backend giù senza cache. */
const NEW_DEVICE: DeviceProfile = { id: 'ios', username: 'ipad', password: 'tst-app-password-ipad-1', userAgent: 'iPadOS/18.0 (22A3354) dataaccessd/1.0', ip: '203.0.113.20', discovery: 'server' };

const CURRENT_USER_PRIVILEGE_SET: DavPropName = { ns: NS.DAV, name: 'current-user-privilege-set' };
const PRINCIPAL_URL: DavPropName = { ns: NS.DAV, name: 'principal-URL' };
const OWNER: DavPropName = { ns: NS.DAV, name: 'owner' };
/** Proprietà chieste da iOS e macOS sulla home dei calendari (Depth 1). */
const APPLE_HOME_PROPS: DavPropName[] = [
  DAV_PROPS.resourcetype, DAV_PROPS.displayname, DAV_PROPS.getctag, DAV_PROPS.syncToken, DAV_PROPS.calendarColor,
  DAV_PROPS.calendarOrder, DAV_PROPS.supportedComponents, CURRENT_USER_PRIVILEGE_SET, DAV_PROPS.calendarDescription,
];
/** Proprietà chieste da DAVx5 (dav4jvm) sulla home dei calendari. */
const DAVX5_HOME_PROPS: DavPropName[] = [
  DAV_PROPS.resourcetype, DAV_PROPS.displayname, DAV_PROPS.calendarColor, DAV_PROPS.calendarDescription,
  DAV_PROPS.calendarTimezone, DAV_PROPS.supportedComponents, CURRENT_USER_PRIVILEGE_SET, DAV_PROPS.getctag, DAV_PROPS.syncToken,
];
/** Proprietà chieste da Thunderbird sulla collezione configurata (Depth 0). */
const THUNDERBIRD_PROPS: DavPropName[] = [
  DAV_PROPS.resourcetype, OWNER, DAV_PROPS.currentUserPrincipal, CURRENT_USER_PRIVILEGE_SET, DAV_PROPS.supportedComponents,
  DAV_PROPS.getctag, DAV_PROPS.syncToken, DAV_PROPS.displayname,
];

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── iCalendar dei casi ─────────────────────────────────────

const VTIMEZONE_ROME = [
  'BEGIN:VTIMEZONE', 'TZID:Europe/Rome',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];

function vcal(prodid: string, body: string[], timezones: string[] = []): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${prodid}`, 'CALSCALE:GREGORIAN', ...timezones, ...body, 'END:VCALENDAR', ''].join('\r\n');
}

function vevent(lines: string[]): string[] {
  return ['BEGIN:VEVENT', 'DTSTAMP:20261001T080000Z', ...lines, 'END:VEVENT'];
}

/** Serie della produzione: lun-mar-gio-ven alle 09:00 di Roma, senza fine (inventario, calendario c). */
const SERIES_ICS = vcal('-//Calicchia Design//caldes migrazione//IT', vevent([
  'UID:gestione-creattivamente@caldes.test',
  'DTSTART;TZID=Europe/Rome:20261005T090000', 'DTEND;TZID=Europe/Rome:20261005T100000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR', 'SUMMARY:Gestione Creattivamente', 'LOCATION:Via Roma 1\\, Frosinone',
  'X-CALDES-SOURCE:admin',
]), VTIMEZONE_ROME);

const SINGLE_ICS = (uid: string, summary: string, extra: string[] = []) => vcal('-//Calicchia Design//caldes migrazione//IT', vevent([
  `UID:${uid}`, 'DTSTART:20270111T090000Z', 'DTEND:20270111T100000Z', `SUMMARY:${summary}`, ...extra,
]));

/** Evento come lo scrive un iPhone: X-prop Apple, VALARM con testo a virgole, ATTENDEE, URL geo. */
const APPLE_RICH_ICS = (uid: string) => vcal('-//Apple Inc.//iPhone OS 18.0//EN', vevent([
  `UID:${uid}`, 'DTSTART;TZID=Europe/Rome:20270112T150000', 'DTEND;TZID=Europe/Rome:20270112T160000',
  'SUMMARY:Pranzo\\, poi riunione', 'LOCATION:Piazza Garibaldi 3\\, Sora\\, FR',
  'DESCRIPTION:Portare: preventivo\\, contratto\\, chiavetta',
  'X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-APPLE-RADIUS=70;X-TITLE="Piazza Garibaldi 3":geo:41.719,13.612',
  'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC', 'X-MOZ-LASTACK:20270101T000000Z', 'X-FOO:a,b,c',
  'CONFERENCE;VALUE=URI;FEATURE=VIDEO;LABEL=Meet:https://meet.example.test/abc-defg-hij',
  'ATTENDEE;CN="Mario Rossi";PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:mario@example.test',
  'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Promemoria\\, tra poco', 'TRIGGER:-PT15M', 'X-WR-ALARMUID:1A2B3C4D', 'END:VALARM',
]), VTIMEZONE_ROME);

/** All-day creato da un device, con o senza TRANSP ("Mostra come"). */
const ALLDAY_ICS = (uid: string, transp: 'OPAQUE' | 'TRANSPARENT' | null) => vcal('-//Apple Inc.//iPhone OS 18.0//EN', vevent([
  `UID:${uid}`, 'DTSTART;VALUE=DATE:20270115', 'DTEND;VALUE=DATE:20270116', `SUMMARY:Giornata ${transp ?? 'senza TRANSP'}`,
  ...(transp ? [`TRANSP:${transp}`] : []),
]));

/** Evento con un TZID in stile Outlook/Exchange e la sua VTIMEZONE (fusi orari). */
const WINDOWS_TZ_ICS = (uid: string) => vcal('-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN', vevent([
  `UID:${uid}`, 'DTSTART;TZID="W. Europe Standard Time":20270113T100000', 'DTEND;TZID="W. Europe Standard Time":20270113T110000',
  'SUMMARY:Chiamata fornitore',
]), [
  'BEGIN:VTIMEZONE', 'TZID:W. Europe Standard Time',
  'BEGIN:STANDARD', 'DTSTART:16010101T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10', 'END:STANDARD',
  'BEGIN:DAYLIGHT', 'DTSTART:16010101T020000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3', 'END:DAYLIGHT',
  'END:VTIMEZONE',
]);

// ─── Utilità ────────────────────────────────────────────────

/** Chiavi del config di produzione che dipendono dall'ambiente, più la scelta proposta dalla matrice. */
function configOverrides(paths: { storageDir: string; policyFile: string; heartbeatFile: string }): Record<string, Record<string, string>> {
  return {
    server: { hosts: '127.0.0.1:0' },
    storage: { filesystem_folder: paths.storageDir, strict_preconditions: 'True' },
    rights: { caldes_policy_file: paths.policyFile, caldes_heartbeat_file: paths.heartbeatFile },
  };
}

/** apps/radicale/config/config con le sole chiavi di configOverrides() sostituite; lancia se ne manca una. */
function productionConfig(paths: { storageDir: string; policyFile: string; heartbeatFile: string }): string {
  const overrides = configOverrides(paths);
  const seen = new Set<string>();
  let section = '';
  const lines = readFileSync(PRODUCTION_CONFIG, 'utf8').split('\n').map((line) => {
    const header = /^\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      section = header[1];
      return line;
    }
    const entry = /^([A-Za-z0-9_]+)\s*=/.exec(line);
    const value = entry ? overrides[section]?.[entry[1]] : undefined;
    if (!entry || value === undefined) return line;
    const key = `${section}.${entry[1]}`;
    if (seen.has(key)) throw new Error(`chiave ripetuta nel config di produzione: ${key}`);
    seen.add(key);
    return `${entry[1]} = ${value}`;
  });
  const missing = Object.entries(overrides).flatMap(([s, values]) => Object.keys(values).map((k) => `${s}.${k}`)).filter((k) => !seen.has(k));
  if (missing.length) throw new Error(`config di produzione senza le chiavi attese: ${missing.join(', ')}`);
  return lines.join('\n');
}

async function waitFor<T>(what: string, probe: () => Promise<T | null | undefined | false>, timeoutMs = 10_000): Promise<T> {
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

/** Privilegi DAV (nomi locali, ordinati) di una response con current-user-privilege-set. */
function privileges(entry: DavResponseEntry): string[] {
  const el = entry.element(CURRENT_USER_PRIVILEGE_SET);
  if (!el) return [];
  return xmlChildren(el, NS.DAV, 'privilege').flatMap((p) => p.children.map((c) => c.name)).sort();
}

/** href di una proprietà con <href> (current-user-principal, calendar-home-set, principal-URL). */
function hrefOf(entry: DavResponseEntry | undefined, prop: DavPropName): string | null {
  const el = entry?.element(prop);
  const href = el ? xmlChild(el, NS.DAV, 'href') : undefined;
  return href ? xmlText(href).trim() : null;
}

/** Nome della collezione (secondo segmento) delle response di un PROPFIND Depth 1 sul principal. */
function collectionNames(res: DavResponse): string[] {
  return res.multistatus().responses.map((r) => r.path.split('/').filter(Boolean)).filter((s) => s.length === 2).map((s) => s[1]).sort();
}

function wwwAuthenticate(res: DavResponse): string | null {
  return res.headers.get('www-authenticate');
}

/**
 * Contenuto semantico di un oggetto per i confronti di andata e ritorno: una
 * voce `componente|NOME|parametri ordinati|valore` per proprietà, senza
 * DTSTAMP, PRODID, CREATED e LAST-MODIFIED. vobject riordina proprietà e
 * parametri e toglie le virgolette superflue (CN="Mario Rossi" → CN=Mario
 * Rossi, RFC 5545 §3.2): forme equivalenti; un valore troncato, una
 * proprietà o un parametro persi invece cambiano l'insieme.
 */
function semanticContent(ics: string): string[] {
  const out: string[] = [];
  const walk = (comp: IcsComponent, path: string): void => {
    for (const p of comp.properties) {
      if (['DTSTAMP', 'PRODID', 'CREATED', 'LAST-MODIFIED'].includes(p.name)) continue;
      const params = Object.entries(p.params).map(([k, v]) => `${k}=${v}`).sort().join(';');
      out.push(`${path}|${p.name}|${params}|${p.value}`);
    }
    for (const child of comp.components) walk(child, `${path}/${child.name}`);
  };
  walk(parseIcsTree(ics), 'VCALENDAR');
  return out.sort();
}

// ─── Suite ──────────────────────────────────────────────────

describe('emulazione dei device: config e plugin di produzione, control-plane dell\'API', {
  skip: radicale.skip || python.skip || PEERS_SKIP || false,
}, () => {
  let root = '';
  let policyFile = '';
  let heartbeatFile = '';
  let svc: RadicaleClient | null = null;
  let volumeId = '';
  const etags = new Map<string, string>();

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'caldes-device-emu-'));
    const controlDir = join(root, 'control');
    mkdirSync(controlDir, { mode: 0o755 });
    chmodSync(controlDir, 0o755);
    mkdirSync(join(root, 'authcache'), { mode: 0o700 });
    policyFile = join(controlDir, 'policy.json');
    heartbeatFile = join(controlDir, 'heartbeat.json');
  });
  after(async () => {
    await stopCalendarControlPlane();
    configureRadicaleRuntime(null);
    svc?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const verify = useMockVerify({
    users: [...ALL_DEVICES, NEW_DEVICE].map((d) => ({ username: d.username, password: d.password })),
  });

  const rad = useRadicale(() => ({
    label: 'device-emu',
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

  const policyNow = async (): Promise<CaldesPolicy | null> => {
    const read = await readPolicyFile(policyFile, P);
    return read.state === 'ok' ? read.value : null;
  };

  /** Client di un device: dal gateway della porta pubblicata, con l'IP vero in X-Remote-Addr e lo User-Agent del client. */
  const device = (d: DeviceProfile): CalDavClient =>
    rad.server.client(d.username, d.password).fromAddress(GATEWAY).withHeaders({ 'X-Remote-Addr': d.ip, 'User-Agent': d.userAgent });

  const seed = async (collection: string, name: string, ics: string): Promise<void> => {
    const res = await svc!.put(objectPath(P, collection, name), ics, { ifNoneMatch: '*' });
    if (res.etag) etags.set(`${collection}/${name}`, res.etag);
  };

  /** Stato del backend e policy live temporanea (come lo stack di prova della matrice), poi di nuovo shadow. */
  const setBackendMode = async (mode: 'postgres' | 'radicale'): Promise<void> => {
    await sql`UPDATE calendar_backend_state SET mode = ${mode} WHERE id`;
    invalidateBackendModeCache();
    const expected = mode === 'radicale' ? 'live' : 'shadow';
    await waitFor(`policy ${expected}`, async () => (await policyNow())?.mode === expected);
    await waitFor(`heartbeat del backend ${mode}`, async () => {
      const hb = await readHeartbeatFile(heartbeatFile);
      return hb.state === 'ok' && hb.value.mode === mode;
    });
    await sleep(PLUGIN_RELOAD_MS);
  };

  before(async () => {
    // Calendari della produzione (inventario 2026-10-09): c e f accanto ai seminati.
    const c = await createCalendar({ slug: 'c', name: fx.name('Creattivamente SRL'), timezone: ROME, blocks_availability: true });
    fx.track('calendarIds', c.id);
    await fx.holidayCalendar();
    svc = new RadicaleClient({ baseUrl: rad.server.url, password: SVC_PASSWORD, localAddress: SVC_PEER, timeoutMs: 10_000 });
    const init = await initializeVolume({ db: sql, client: svc, principal: P });
    volumeId = init.volumeId;
    assert.ok(await startCalendarControlPlane(controlPlaneEnv()), 'control-plane non avviato');
    await waitFor('policy con il volume inizializzato', async () => (await policyNow())?.volume_id === volumeId);
    // Oggetti come li lascia lo strumento di migrazione (scritti da caldes-svc).
    await seed('c', 'gestione.ics', SERIES_ICS);
    await seed('c', 'singolo.ics', SINGLE_ICS('singolo@caldes.test', 'Gestione'));
    await seed('c', 'da-cancellare.ics', SINGLE_ICS('da-cancellare@caldes.test', 'Gestione (copia)'));
    await seed('f', 'it-holiday-2027-01-06.ics', vcal('-//Calicchia Design//caldes//IT', vevent([
      'UID:it-holiday-2027-01-06@caldes.it', 'DTSTART;VALUE=DATE:20270106', 'DTEND;VALUE=DATE:20270107', 'SUMMARY:Epifania',
    ])));
    await seed('bookings', 'booking-tst-uid-1.ics', SINGLE_ICS('booking-tst-uid-1@caldes.test', 'Prenotazione: Mario R. (+39 333 0000000)'));
    await seed('bookings', 'promemoria.ics', SINGLE_ICS('promemoria@caldes.test', 'Promemoria manuale (decisione 8)'));
    await seed('lavoro', 'ferie-migrate.ics', ALLDAY_ICS('ferie-migrate@caldes.test', null));
    await seed('scadenze', 'scadenza.ics', SINGLE_ICS('scadenza@caldes.test', 'Scadenza dominio'));
    await sleep(PLUGIN_RELOAD_MS);
  });

  test('il config è quello di produzione, con i percorsi sostituiti e strict_preconditions = True (proposta della matrice)', () => {
    const original = readFileSync(PRODUCTION_CONFIG, 'utf8').split('\n');
    const used = readFileSync(rad.server.configPath, 'utf8').split('\n');
    assert.equal(used.length, original.length);
    const changed = original.map((line, i) => (line === used[i] ? null : line.split('=')[0].trim())).filter(Boolean);
    assert.deepEqual(changed.sort(), ['caldes_heartbeat_file', 'caldes_policy_file', 'filesystem_folder', 'hosts', 'strict_preconditions']);
    assert.ok(original.includes('strict_preconditions = False'), 'in produzione resta False fino alla decisione');
    assert.ok(used.includes('strict_preconditions = True'));
    for (const key of ['type = caldes_auth', 'type = caldes_rights', 'delay = 1', 'delay_on_error = 0', 'permit_delete_collection = False', 'permit_overwrite_collection = False']) {
      assert.ok(used.includes(key), `manca "${key}"`);
    }
  });

  test('policy shadow dal control-plane: bookings, f e scadenze in sola lettura, _canary nascosta', async () => {
    const policy = await policyNow();
    assert.ok(policy);
    assert.deepEqual(
      { backend_mode: policy.backend_mode, mode: policy.mode, reasons: policy.reasons, epoch: policy.epoch, readonly: policy.readonly, hidden: policy.hidden },
      { backend_mode: 'postgres', mode: 'shadow', reasons: [], epoch: 1, readonly: ['bookings', 'f', 'scadenze'], hidden: ['_canary'] },
    );
  });

  test('discovery di ogni client: /.well-known/caldav → /, principal canonico per qualsiasi username, home, collezioni senza _canary, sola lettura in shadow', async () => {
    const expected = ['bookings', 'c', 'f', 'lavoro', 'personale', 'scadenze'];
    for (const d of ALL_DEVICES) {
      const client = device(d);
      if (d.discovery === 'server') {
        // RFC 6764: i client provano /.well-known/caldav; Radicale risponde 301 verso la radice.
        const wk = await client.request('PROPFIND', '/.well-known/caldav', { depth: 0, body: '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><current-user-principal/></prop></propfind>' });
        assert.equal(wk.status, 301, `${d.id}: ${wk.describe()}`);
        assert.match(wk.headers.get('location') ?? '', /\/$/);

        const rootRes = await client.propfind('/', { depth: 0, props: [DAV_PROPS.currentUserPrincipal, PRINCIPAL_URL, DAV_PROPS.resourcetype] });
        assert.equal(rootRes.status, 207, `${d.id}: ${rootRes.describe()}`);
        assert.equal(hrefOf(rootRes.multistatus().responses[0], DAV_PROPS.currentUserPrincipal), `/${P}/`, `${d.id} (username ${d.username}) → principal canonico`);

        const home = await client.propfind(`/${P}/`, { depth: 0, props: [DAV_PROPS.calendarHomeSet, DAV_PROPS.displayname] });
        assert.equal(home.status, 207, `${d.id}: ${home.describe()}`);
        assert.equal(hrefOf(home.multistatus().find(`/${P}/`), DAV_PROPS.calendarHomeSet), `/${P}/`);

        const listing = await client.propfind(`/${P}/`, { depth: 1, props: d.id === 'davx5' ? DAVX5_HOME_PROPS : APPLE_HOME_PROPS });
        assert.equal(listing.status, 207, `${d.id}: ${listing.describe()}`);
        assert.deepEqual(collectionNames(listing), expected, `${d.id}: _canary mai elencata`);
        for (const entry of listing.multistatus().responses.filter((r) => r.path !== `/${P}/`)) {
          assert.deepEqual(privileges(entry), ['read'], `${d.id} ${entry.path}: in shadow solo lettura`);
          assert.ok(entry.text(DAV_PROPS.getctag), `${d.id} ${entry.path}: ctag`);
          assert.ok(entry.text(DAV_PROPS.syncToken), `${d.id} ${entry.path}: sync-token`);
        }
      } else {
        // Thunderbird: URL della collezione configurato a mano, PROPFIND Depth 0.
        const coll = await client.propfind(`/${P}/lavoro/`, { depth: 0, props: THUNDERBIRD_PROPS });
        assert.equal(coll.status, 207, `${d.id}: ${coll.describe()}`);
        const entry = coll.multistatus().find(`/${P}/lavoro/`);
        assert.ok(entry);
        assert.equal(hrefOf(entry, DAV_PROPS.currentUserPrincipal), `/${P}/`);
        assert.deepEqual(privileges(entry), ['read']);
        assert.ok(entry.element(DAV_PROPS.supportedComponents));
      }
      assert.equal((await client.propfind(`/${P}/_canary/`, { depth: 0 })).status, 403, `${d.id}: _canary inaccessibile`);
    }
    // Ogni login passa da verify-credentials con l'IP del device, mai con la password in chiaro.
    const calls = await verify.mock.calls();
    for (const d of ALL_DEVICES) {
      assert.ok(calls.some((c) => c.username === d.username && c.status === 200 && c.x_forwarded_for === d.ip), `${d.id}: verify-credentials con X-Forwarded-For`);
    }
  });

  test('sincronizzazione: sync-collection iniziale e incrementale, multiget, ctag; X-prop della migrazione intatte', async () => {
    for (const d of ALL_DEVICES) {
      const client = device(d);
      const first = await client.syncCollection(`/${P}/c/`, { props: [DAV_PROPS.getetag] });
      assert.equal(first.status, 207, `${d.id}: ${first.describe()}`);
      const ms = first.multistatus();
      assert.ok(ms.syncToken, `${d.id}: sync-token`);
      assert.deepEqual(ms.paths(), [`/${P}/c/da-cancellare.ics`, `/${P}/c/gestione.ics`, `/${P}/c/singolo.ics`]);
      const multi = await client.calendarMultiget(`/${P}/c/`, ms.responses.map((r) => r.href));
      const series = multi.multistatus().find(`/${P}/c/gestione.ics`)?.text(DAV_PROPS.calendarData) ?? '';
      assert.match(series, /RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR/);
      assert.match(series, /LOCATION:Via Roma 1\\, Frosinone/);
      assert.match(series, /X-CALDES-SOURCE:admin/);
    }

    // Il servizio (shadow mirror) modifica, aggiunge e cancella: ogni client vede il delta con il proprio token.
    const tokens = new Map<DeviceId, string>();
    const ctagBefore = (await device(DEVICES.ios).propfind(`/${P}/c/`, { depth: 0, props: [DAV_PROPS.getctag] })).multistatus().responses[0].text(DAV_PROPS.getctag);
    for (const d of ALL_DEVICES) tokens.set(d.id, (await device(d).syncCollection(`/${P}/c/`)).multistatus().syncToken as string);
    const etag = etags.get('c/singolo.ics');
    assert.ok(etag);
    const updated = await svc!.put(objectPath(P, 'c', 'singolo.ics'), SINGLE_ICS('singolo@caldes.test', 'Gestione (spostato)'), { ifMatch: etag });
    etags.set('c/singolo.ics', updated.etag as string);
    await seed('c', 'nuovo.ics', SINGLE_ICS('nuovo@caldes.test', 'Gestione (nuovo)'));
    await svc!.delete(objectPath(P, 'c', 'da-cancellare.ics'), { ifMatch: etags.get('c/da-cancellare.ics') as string });
    const ctagAfter = (await device(DEVICES.ios).propfind(`/${P}/c/`, { depth: 0, props: [DAV_PROPS.getctag] })).multistatus().responses[0].text(DAV_PROPS.getctag);
    assert.notEqual(ctagAfter, ctagBefore, 'ctag cambiato: i client senza sync-collection rileggono');
    for (const d of ALL_DEVICES) {
      const delta = await device(d).syncCollection(`/${P}/c/`, { syncToken: tokens.get(d.id) });
      assert.equal(delta.status, 207, `${d.id}: ${delta.describe()}`);
      const rows = delta.multistatus().responses.map((r) => [r.path.split('/').pop(), r.status ?? 200]).sort();
      assert.deepEqual(rows, [['da-cancellare.ics', 404], ['nuovo.ics', 200], ['singolo.ics', 200]], d.id);
    }
  });

  test('fusi orari: calendar-query con expand attraverso il cambio dell\'ora (09:00 di Roma resta 09:00)', async () => {
    const res = await device(DEVICES.thunderbird).calendarQuery(`/${P}/c/`, {
      start: '2026-10-22T00:00:00Z', end: '2026-10-28T00:00:00Z', expand: true,
    });
    const data = res.multistatus().find(`/${P}/c/gestione.ics`)?.text(DAV_PROPS.calendarData) ?? '';
    const starts = unfoldIcs(data).filter((l) => l.startsWith('DTSTART')).map((l) => l.split(':')[1]).sort();
    // gio 22 e ven 23 in ora legale (07:00Z), lun 26 e mar 27 in ora solare (08:00Z).
    assert.deepEqual(starts, ['20261022T070000Z', '20261023T070000Z', '20261026T080000Z', '20261027T080000Z']);
  });

  test('shadow: ogni scrittura dei device → 403 senza WWW-Authenticate; la password resta valida anche con il backend giù', async () => {
    const d = DEVICES.ios;
    const client = device(d);
    const attempts: Array<[string, Promise<DavResponse>]> = [
      ['PUT nuova', client.put(`/${P}/lavoro/dal-telefono.ics`, SINGLE_ICS('dal-telefono@caldes.test', 'Dal telefono'), { ifNoneMatch: '*' })],
      ['PUT con If-Match', client.put(`/${P}/c/singolo.ics`, SINGLE_ICS('singolo@caldes.test', 'Modifica dal telefono'), { ifMatch: etags.get('c/singolo.ics') })],
      ['DELETE', client.delete(`/${P}/c/singolo.ics`)],
      ['MKCALENDAR', client.mkcalendar(`/${P}/nuovo-shadow/`, { displayName: 'Nuovo' })],
      ['PROPPATCH', client.proppatch(`/${P}/lavoro/`, { set: [{ ...DAV_PROPS.displayname, value: 'Rinominato' }] })],
    ];
    for (const [label, pending] of attempts) {
      const res = await pending;
      assert.equal(res.status, 403, `${label}: ${res.describe()}`);
      assert.equal(wwwAuthenticate(res), null, `${label}: nessuna challenge, il client non chiede la password`);
    }
    assert.equal(existsSync(rad.server.fsPath(P, 'nuovo-shadow')), false);
    assert.equal((await client.propfind(`/${P}/`, { depth: 0 })).status, 207, 'stessa password, di nuovo 207');
    // Dopo i 403 la credenziale resta in cache: con il backend giù il device continua a leggere.
    await verify.mock.setState({ mode: 'error' });
    try {
      assert.equal((await client.propfind(`/${P}/c/`, { depth: 1, props: [DAV_PROPS.getetag] })).status, 207);
    } finally {
      await verify.mock.setState({ mode: 'ok' });
    }
  });

  test('backend di autenticazione giù: device mai visto → 500 subito e senza challenge, device in cache → 207; password sbagliata → 401', async () => {
    const cached = device(DEVICES.macos);
    assert.equal((await cached.propfind(`/${P}/`, { depth: 0 })).status, 207, 'credenziale verificata e in cache');
    const fresh = device(NEW_DEVICE);
    for (const mode of ['error', 'unavailable', 'drop'] as const) {
      await verify.mock.setState({ mode });
      try {
        const t0 = Date.now();
        const res = await fresh.propfind(`/${P}/`, { depth: 0 });
        const ms = Date.now() - t0;
        assert.equal(res.status, 500, `${mode}: ${res.describe()}`);
        assert.equal(wwwAuthenticate(res), null, `${mode}: un 500 non fa scartare la password`);
        assert.ok(ms < 450, `${mode}: risposta senza il ritardo del login fallito (${ms} ms)`);
        assert.equal((await cached.propfind(`/${P}/`, { depth: 0 })).status, 207, `${mode}: credenziale in cache accettata (stale-if-error)`);
      } finally {
        await verify.mock.setState({ mode: 'ok' });
      }
    }
    // Backend di nuovo su: la stessa password del device nuovo funziona (nessuno l'ha invalidata).
    assert.equal((await fresh.propfind(`/${P}/`, { depth: 0 })).status, 207);
    // L'unico caso in cui un client deve chiedere la password: credenziale rifiutata dall'API.
    const wrong = device({ ...NEW_DEVICE, password: 'password-sbagliata' });
    const denied = await wrong.propfind(`/${P}/`, { depth: 0 });
    assert.equal(denied.status, 401);
    assert.match(wwwAuthenticate(denied) ?? '', /^Basic/i);
  });

  describe('policy live temporanea (stack di prova della matrice, mai in produzione in F3)', () => {
    before(async () => {
      await setBackendMode('radicale');
    });
    after(async () => {
      await setBackendMode('postgres');
    });

    test('privilegi in live: c, lavoro e personale scrivibili; bookings, f e scadenze in sola lettura; _canary assente', async () => {
      const listing = await device(DEVICES.ios).propfind(`/${P}/`, { depth: 1, props: APPLE_HOME_PROPS });
      const byName = new Map(listing.multistatus().responses.map((r) => [r.path.split('/').filter(Boolean)[1], r]));
      assert.ok(!byName.has('_canary'));
      for (const name of ['c', 'lavoro', 'personale']) assert.ok(privileges(byName.get(name)!).includes('write'), `${name} scrivibile`);
      for (const name of ['bookings', 'f', 'scadenze']) assert.deepEqual(privileges(byName.get(name)!), ['read'], `${name} in sola lettura`);
    });

    test('If-Match con strict_preconditions = True: ETag corrente 204, ETag vecchio 412, senza If-Match 412; If-None-Match: * 201 e poi 412', async () => {
      for (const d of ALL_DEVICES) {
        const client = device(d);
        const path = `/${P}/lavoro/${d.id}-evento.ics`;
        const uid = `${d.id}-evento@device.test`;
        // Creazione: tutti i client mandano If-None-Match: * (o nessuna precondizione su un href nuovo).
        const created = await client.put(path, SINGLE_ICS(uid, `Creato da ${d.id}`), { ifNoneMatch: '*' });
        assert.equal(created.status, 201, `${d.id}: ${created.describe()}`);
        assert.ok(created.etag, `${d.id}: ETag nella risposta della PUT`);
        assert.equal((await client.put(path, SINGLE_ICS(uid, 'Doppione'), { ifNoneMatch: '*' })).status, 412, `${d.id}: creazione ripetuta`);
        // Aggiornamento con l'ETag ricevuto: riuscito, nuovo ETag.
        const updated = await client.put(path, SINGLE_ICS(uid, `Modificato da ${d.id}`), { ifMatch: created.etag as string });
        assert.equal(updated.status, 204, `${d.id}: ${updated.describe()}`);
        assert.notEqual(updated.etag, created.etag);
        // Un secondo device ha modificato nel frattempo: la PUT con l'ETag vecchio non sovrascrive.
        const stale = await client.put(path, SINGLE_ICS(uid, 'Modifica persa'), { ifMatch: created.etag as string });
        assert.equal(stale.status, 412, `${d.id}: ETag vecchio → 412, nessun lost update`);
        // Senza If-Match su un oggetto esistente: con strict_preconditions = True la PUT è rifiutata.
        assert.equal((await client.put(path, SINGLE_ICS(uid, 'Cieca'))).status, 412, `${d.id}: PUT cieca → 412`);
        // Il client rilegge e riprova: riesce.
        const fresh = await client.get(path);
        assert.match(fresh.text, new RegExp(`SUMMARY:Modificato da ${d.id}`));
        assert.equal(fresh.etag, updated.etag);
        assert.equal((await client.put(path, SINGLE_ICS(uid, `Riprova di ${d.id}`), { ifMatch: fresh.etag as string })).status, 204);
        // DELETE con l'ETag vecchio → 412; con quello corrente → riuscita.
        assert.equal((await client.delete(path, { ifMatch: created.etag as string })).status, 412);
        const current = (await client.get(path)).etag as string;
        assert.ok([200, 204].includes((await client.delete(path, { ifMatch: current })).status));
      }
    });

    test('collezioni protette anche in live: PUT, DELETE e PROPPATCH su bookings, f e scadenze → 403; DELETE di una collezione → 403', async () => {
      const client = device(DEVICES.davx5);
      const cases: Array<[string, Promise<DavResponse>]> = [
        ['PUT in bookings', client.put(`/${P}/bookings/dal-device.ics`, SINGLE_ICS('b-dev@device.test', 'Sopra una prenotazione'), { ifNoneMatch: '*' })],
        ['modifica di un evento non di prenotazione in bookings (decisione 8)', client.put(`/${P}/bookings/promemoria.ics`, SINGLE_ICS('promemoria@caldes.test', 'Modificato'), { ifMatch: etags.get('bookings/promemoria.ics') })],
        ['DELETE di una festività in f', client.delete(`/${P}/f/it-holiday-2027-01-06.ics`)],
        ['PUT in scadenze', client.put(`/${P}/scadenze/dal-device.ics`, SINGLE_ICS('s-dev@device.test', 'Scadenza'), { ifNoneMatch: '*' })],
        ['PROPPATCH di bookings', client.proppatch(`/${P}/bookings/`, { set: [{ ...DAV_PROPS.displayname, value: 'Mie' }] })],
        ['DELETE della collezione lavoro', client.delete(`/${P}/lavoro/`)],
      ];
      for (const [label, pending] of cases) {
        const res = await pending;
        assert.equal(res.status, 403, `${label}: ${res.describe()}`);
        assert.equal(wwwAuthenticate(res), null, `${label}: nessuna challenge`);
      }
      assert.equal((await client.get(`/${P}/bookings/promemoria.ics`)).status, 200, 'gli eventi di bookings restano leggibili');
      assert.ok(existsSync(rad.server.fsPath(P, 'lavoro')));
    });

    test('MKCALENDAR dal telefono (corpo di iOS) → 201, scrivibile; la discovery dell\'API la adotta con origin device, bloccante e badge "nuovo dal dispositivo" (decisione 4)', async () => {
      const client = device(DEVICES.ios);
      const name = '4F3C1A2B-9D8E-4C7B-A6F5-0E1D2C3B4A59';
      const body = '<?xml version="1.0" encoding="UTF-8"?>'
        + '<B:mkcalendar xmlns:B="urn:ietf:params:xml:ns:caldav"><A:set xmlns:A="DAV:"><A:prop>'
        + `<B:calendar-timezone>${['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//iPhone OS 18.0//EN', ...VTIMEZONE_ROME, 'END:VCALENDAR'].join('\r\n')}</B:calendar-timezone>`
        + '<D:calendar-order xmlns:D="http://apple.com/ns/ical/">7</D:calendar-order>'
        + '<B:supported-calendar-component-set><B:comp name="VEVENT"/></B:supported-calendar-component-set>'
        + '<D:calendar-color xmlns:D="http://apple.com/ns/ical/" symbolic-color="purple">#CC73E1FF</D:calendar-color>'
        + '<A:displayname>Palestra</A:displayname>'
        // Un device (o un'app) può scrivere le dead prop dell'applicazione: l'API non se ne fida.
        + '<E:role xmlns:E="urn:calicchia:caldes">bookings</E:role>'
        + '</A:prop></A:set></B:mkcalendar>';
      const created = await client.request('MKCALENDAR', `/${P}/${name}/`, { body });
      assert.equal(created.status, 201, created.describe());
      assert.equal((await client.put(`/${P}/${name}/allenamento.ics`, SINGLE_ICS('allenamento@device.test', 'Allenamento'), { ifNoneMatch: '*' })).status, 201);
      const listing = await client.propfind(`/${P}/`, { depth: 1, props: APPLE_HOME_PROPS });
      const entry = listing.multistatus().find(`/${P}/${name}/`);
      assert.ok(entry, 'la collezione nuova compare agli altri device');
      assert.equal(entry.text(DAV_PROPS.displayname), 'Palestra');
      assert.ok(privileges(entry).includes('write'));
      // Una collezione esistente non si sovrascrive (permit_overwrite_collection = False).
      const overwrite = await client.mkcalendar(`/${P}/lavoro/`, { displayName: 'Sovrascritta' });
      assert.ok(overwrite.status >= 400, overwrite.describe());

      // La discovery dell'API (come caldes-svc) vede la collezione con il nome esatto e la adotta.
      const seen = await listRadicaleCollections(svc!, P);
      assert.ok(seen.some((c) => c.name === name), 'listRadicaleCollections');
      configureRadicaleRuntime({ client: svc!, dataDir: rad.server.storageDir, principal: P, identitySource: 'file' });
      const seedRows = await sql<Array<{ id: string; dav_props: unknown; missing_since: Date | null; needs_review: boolean; review_reason: string | null }>>`
        SELECT id, dav_props, missing_since, needs_review, review_reason FROM calendars
      `;
      try {
        const result = await discoverCollections({ db: sql });
        assert.equal(result.identity, 'ok');
        assert.ok(result.created.includes(name), JSON.stringify(result));
        assert.deepEqual(result.missing, []);
        const [row] = await sql<Array<Record<string, unknown>>>`
          SELECT id, name, origin, role, lifecycle, blocks_availability, needs_review, review_reason, ics_feed_enabled, color, dav_props
          FROM calendars WHERE collection_name = ${name}
        `;
        assert.ok(row, 'riga del sidecar creata dalla discovery');
        fx.track('calendarIds', row.id as string);
        assert.deepEqual(
          { name: row.name, origin: row.origin, role: row.role, lifecycle: row.lifecycle, blocks_availability: row.blocks_availability, needs_review: row.needs_review, review_reason: row.review_reason, ics_feed_enabled: row.ics_feed_enabled },
          { name: 'Palestra', origin: 'device', role: 'user', lifecycle: 'active', blocks_availability: true, needs_review: true, review_reason: 'device_new', ics_feed_enabled: false },
          'decisione 4: blocca di default, badge "nuovo dal dispositivo", ruolo mai preso dalla dead prop del device',
        );
        assert.ok(Object.keys((row.dav_props ?? {}) as Record<string, unknown>).every((k) => !k.startsWith('{urn:calicchia:caldes}')));
      } finally {
        configureRadicaleRuntime(null);
        // Le righe seminate tornano come prima della discovery (la baseline non tocca dav_props).
        for (const r of seedRows) {
          await sql`
            UPDATE calendars SET dav_props = ${sql.json((r.dav_props ?? {}) as Record<string, string>)}, missing_since = ${r.missing_since},
              needs_review = ${r.needs_review}, review_reason = ${r.review_reason}
            WHERE id = ${r.id}
          `;
        }
      }
    });

    test('andata e ritorno: X-prop Apple e Mozilla, VALARM, ATTENDEE, CONFERENCE e testi con virgole restano identici', async () => {
      for (const d of [DEVICES.ios, DEVICES.davx5, DEVICES.thunderbird]) {
        const client = device(d);
        const path = `/${P}/personale/${d.id}-ricco.ics`;
        const ics = APPLE_RICH_ICS(`${d.id}-ricco@device.test`);
        assert.equal((await client.put(path, ics, { ifNoneMatch: '*' })).status, 201, d.id);
        const back = await client.get(path);
        assert.equal(back.status, 200);
        assert.deepEqual(semanticContent(back.text), semanticContent(ics), `${d.id}: proprietà perse, aggiunte o alterate`);
        // I valori che vobject senza patch troncherebbe alla prima virgola (design §3.3), verbatim.
        for (const fragment of ['geo:41.719,13.612', 'X-FOO:a,b,c', 'SUMMARY:Pranzo\\, poi riunione', 'DESCRIPTION:Promemoria\\, tra poco', 'https://meet.example.test/abc-defg-hij']) {
          assert.ok(unfoldIcs(back.text).some((l) => l.includes(fragment)), `${d.id}: ${fragment}`);
        }
        // Anche dall'altro lato: un secondo device legge lo stesso testo.
        const other = await device(DEVICES.macos).get(path);
        assert.equal(other.text, back.text);
      }
    });

    test('TRANSP degli all-day creati dal device (decisione 6): Radicale lo conserva; never_block → nessuno blocca, opaque_blocks → solo TRANSP:OPAQUE', async () => {
      const client = device(DEVICES.ios);
      const cases: Array<['OPAQUE' | 'TRANSPARENT' | null, string]> = [['OPAQUE', 'occupato.ics'], ['TRANSPARENT', 'libero.ics'], [null, 'senza-transp.ics']];
      const read: Array<{ transp: string | null; text: string; href: string }> = [];
      for (const [transp, href] of cases) {
        assert.equal((await client.put(`/${P}/lavoro/${href}`, ALLDAY_ICS(`allday-${href}@device.test`, transp), { ifNoneMatch: '*' })).status, 201);
        const back = await client.get(`/${P}/lavoro/${href}`);
        assert.equal(/^TRANSP:(\w+)/m.exec(back.text)?.[1] ?? null, transp, `${href}: TRANSP conservato`);
        read.push({ transp, text: back.text, href });
      }
      // L'all-day migrato (senza TRANSP, come lo scrive il serializer) e un timed libero.
      read.push({ transp: null, text: (await client.get(`/${P}/lavoro/ferie-migrate.ics`)).text, href: 'ferie-migrate.ics' });

      // Regola blocks dell'indicizzatore (calendar-core computeBlocks) con le due scelte della matrice.
      const blocks = (text: string, href: string, allDayOpaqueBlocks: boolean): boolean => {
        const parsed = parseCalendarObject(text);
        assert.ok(parsed.ok, href);
        const exp = expandObject(parsed.value, { from: Date.UTC(2027, 0, 1), to: Date.UTC(2027, 1, 1), tz: ROME });
        assert.equal(exp.occurrences.length, 1, href);
        const occ = exp.occurrences[0];
        assert.equal(occ.allDay, true);
        return computeBlocks(
          { componentType: 'VEVENT', status: occ.status, transp: occ.transp, allDay: occ.allDay, kind: classifyOccurrenceKind('user', href, occ.kind) },
          { allDayOpaqueBlocks },
        );
      };
      const neverBlock = read.map((r) => [r.href, blocks(r.text, r.href, false)]);
      const opaqueBlocks = read.map((r) => [r.href, blocks(r.text, r.href, true)]);
      assert.deepEqual(neverBlock, [['occupato.ics', false], ['libero.ics', false], ['senza-transp.ics', false], ['ferie-migrate.ics', false]]);
      assert.deepEqual(opaqueBlocks, [['occupato.ics', true], ['libero.ics', false], ['senza-transp.ics', false], ['ferie-migrate.ics', false]],
        'decisione 6: blocca solo "Mostra come: occupato"; gli all-day migrati restano non bloccanti');
      // La dichiarazione allday_transp_rule = opaque_blocks si applica con CAL_ALLDAY_OPAQUE_BLOCKS=on.
      assert.equal(allDayOpaqueBlocksFromEnv({ CAL_ALLDAY_OPAQUE_BLOCKS: 'on' }), true);
      assert.equal(allDayOpaqueBlocksFromEnv({}), false, 'default della F2: never_block');
    });

    test('fusi orari dai device: TZID in stile Outlook con la sua VTIMEZONE accettato e trovato all\'ora giusta', async () => {
      const client = device(DEVICES.davx5);
      assert.equal((await client.put(`/${P}/personale/outlook.ics`, WINDOWS_TZ_ICS('outlook-tz@device.test'), { ifNoneMatch: '*' })).status, 201);
      const hit = await client.calendarQuery(`/${P}/personale/`, { start: '2027-01-13T09:00:00Z', end: '2027-01-13T09:30:00Z' });
      assert.ok(hit.multistatus().find(`/${P}/personale/outlook.ics`), '10:00 W. Europe = 09:00Z');
      const miss = await client.calendarQuery(`/${P}/personale/`, { start: '2027-01-13T10:00:00Z', end: '2027-01-13T10:30:00Z' });
      assert.equal(miss.multistatus().find(`/${P}/personale/outlook.ics`), undefined);
    });
  });

  test('di nuovo shadow dopo la prova live: le scritture tornano 403', async () => {
    const policy = await policyNow();
    assert.equal(policy?.mode, 'shadow');
    const res = await device(DEVICES.thunderbird).put(`/${P}/lavoro/dopo-live.ics`, SINGLE_ICS('dopo-live@device.test', 'Dopo'), { ifNoneMatch: '*' });
    assert.equal(res.status, 403);
  });
});

// ─── strict_preconditions: confronto True/False ─────────────

describe('strict_preconditions: cosa cambia per un client che non manda If-Match', { skip: radicale.skip || false }, () => {
  for (const strict of [true, false]) {
    describe(`strict_preconditions = ${strict ? 'True' : 'False'}`, () => {
      const rad = useRadicale({ label: `strict-${strict}`, strictPreconditions: strict, predefinedCollections: {} });

      test(strict
        ? 'PUT senza If-Match su un oggetto esistente → 412: nessuna sovrascrittura cieca fra device'
        : 'PUT senza If-Match su un oggetto esistente → 204: l\'ultima scrittura vince (lost update possibile)', async () => {
        const client = rad.client();
        assert.equal((await client.mkcalendar(`/${P}/prova/`)).status, 201);
        const created = await client.put(`/${P}/prova/e.ics`, SINGLE_ICS('strict@device.test', 'Prima'), { ifNoneMatch: '*' });
        assert.equal(created.status, 201);
        const blind = await client.put(`/${P}/prova/e.ics`, SINGLE_ICS('strict@device.test', 'Sovrascritta'));
        assert.equal(blind.status, strict ? 412 : 204);
        const afterBlind = await client.get(`/${P}/prova/e.ics`);
        assert.match(afterBlind.text, strict ? /SUMMARY:Prima/ : /SUMMARY:Sovrascritta/);
        // Creazione senza precondizioni su un href nuovo e DELETE senza If-Match: ammesse in entrambi i casi.
        assert.equal((await client.put(`/${P}/prova/nuovo.ics`, SINGLE_ICS('strict-nuovo@device.test', 'Nuovo'))).status, 201);
        assert.ok([200, 204].includes((await client.delete(`/${P}/prova/nuovo.ics`)).status));
        // Un client aggiorna con l'ETag corrente; un altro con l'ETag ormai vecchio riceve 412 in entrambi
        // i casi: la protezione dei client che mandano If-Match non dipende dall'opzione.
        const current = afterBlind.etag as string;
        assert.equal((await client.put(`/${P}/prova/e.ics`, SINGLE_ICS('strict@device.test', 'Aggiornata'), { ifMatch: current })).status, 204);
        assert.equal((await client.put(`/${P}/prova/e.ics`, SINGLE_ICS('strict@device.test', 'Vecchio'), { ifMatch: current })).status, 412);
        assert.match((await client.get(`/${P}/prova/e.ics`)).text, /SUMMARY:Aggiornata/);
      });
    });
  }
});

