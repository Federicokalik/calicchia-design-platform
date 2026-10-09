/**
 * Harness Radicale per i test (fase F0 del passaggio del calendario a
 * Radicale: docs/calendar-radicale/piano.md, F0 attività 6, e design §15).
 *
 * Contiene:
 *  - `radicaleAvailability()`: trova il binario (RADICALE_BIN, altrimenti
 *    `radicale` nel PATH) e decide se i test vanno saltati o devono fallire;
 *  - `startRadicale()` / `useRadicale()`: un Radicale reale (3.7.8, pin del
 *    design §3.1) su una porta effimera, con storage multifilesystem in una
 *    directory temporanea, config generata (auth htpasswd o un plugin di prova)
 *    e arresto a fine suite;
 *  - `startMockVerify()` / `useMockVerify()`: il mock di
 *    POST /api/caldav-backend/verify-credentials (helpers/mock_verify.py) per
 *    i plugin di autenticazione di F1;
 *  - riesportati da helpers/caldav.ts: `CalDavClient`, client CalDAV minimale
 *    via fetch (PUT, GET, DELETE, PROPFIND, PROPPATCH, MKCOL, MKCALENDAR,
 *    REPORT calendar-query, calendar-multiget e sync-collection) con parser
 *    del multistatus, e le utilità iCalendar (unfold/fold e albero dei
 *    componenti). Con `fromAddress('127.0.0.2')` il client si connette da un
 *    altro indirizzo di loopback, così i test del peer TCP di F1 (rete interna
 *    contro gateway, design §3.3) non richiedono una rete Docker con subnet fissa.
 *
 * Isolamento: ogni server ha la propria directory temporanea (config, utenti,
 * collezioni, log), rimossa allo stop; la porta la sceglie il sistema
 * (`hosts = 127.0.0.1:0`) e viene letta dal log "Listening on", quindi non ci
 * sono corse sulla porta. Se il processo dei test muore, i figli vengono
 * uccisi all'uscita. Il server non legge nulla dall'ambiente della shell oltre
 * a quanto passato esplicitamente (niente RADICALE_CONFIG, nessun config di
 * sistema: `--config` punta sempre al file generato).
 *
 * Variabili d'ambiente:
 *  - RADICALE_BIN: percorso del binario `radicale` (es. il venv con 3.7.8). Se
 *    è impostata, un binario mancante o rotto è un errore, non uno skip;
 *  - RADICALE_REQUIRED=1: anche senza RADICALE_BIN l'assenza di Radicale è un
 *    errore (job CI calendar-integration);
 *  - RADICALE_PYTHON: interprete per mock_verify.py (default: il python del
 *    venv di RADICALE_BIN se esiste, altrimenti python3);
 *  - TEST_RADICALE_LOG=1: inoltra i log di Radicale e del mock su stderr;
 *  - TEST_RADICALE_KEEP=1: non cancella la directory temporanea allo stop
 *    (il percorso viene stampato) per ispezionare storage e log.
 */

import './env';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdtempSync, rmSync, writeFileSync, type WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CalDavClient } from './caldav';
import { TEST_ENV } from './env';

// I test importano tutto da qui: client CalDAV, XML e iCalendar compresi.
export * from './caldav';

// ─── Costanti ───────────────────────────────

/** Versione di Radicale fissata dal design (§3.1): i test di integrazione la verificano. */
export const RADICALE_PINNED_VERSION = '3.7.8';

/** Principal canonico del progetto (design §3.3): ogni app-password vede /federico/. */
export const TEST_PRINCIPAL = 'federico';

/** Credenziali htpasswd di default: solo il principal canonico, password nota e fittizia. */
export const DEFAULT_RADICALE_USERS: Readonly<Record<string, string>> = Object.freeze({
  [TEST_PRINCIPAL]: 'test-only-radicale-password',
});

const HELPERS_DIR = dirname(fileURLToPath(import.meta.url));

/** Percorso del mock di verify-credentials. */
export const MOCK_VERIFY_SCRIPT = join(HELPERS_DIR, 'mock_verify.py');

/** Plugin Radicale del repository (oggi caldes_auth e caldes_storage, riscritti in F1). */
export const RADICALE_PLUGINS_DIR = resolve(HELPERS_DIR, '../../../radicale/plugins');

const envFlag = (name: string): boolean => /^(1|true|yes)$/i.test(process.env[name]?.trim() ?? '');

// ─── Disponibilità del binario ───────────────────────────────

export interface RadicaleAvailability {
  /** Il binario risponde a --version. */
  available: boolean;
  /** Comando o percorso usato (RADICALE_BIN o `radicale`). */
  bin: string;
  /** Versione riportata da `radicale --version` (null se non disponibile). */
  version: string | null;
  /** RADICALE_BIN impostata o RADICALE_REQUIRED=1: l'assenza è un errore, non uno skip. */
  required: boolean;
  /** Motivo dell'indisponibilità (null se disponibile). */
  reason: string | null;
  /**
   * Valore per l'opzione `skip` di describe/test: il motivo se i test vanno
   * saltati (Radicale assente e non richiesto), altrimenti false. Se Radicale
   * è richiesto ma assente vale false: i test partono e falliscono allo start
   * con `reason`, invece di passare in verde senza aver girato.
   */
  skip: string | false;
}

let availabilityCache: RadicaleAvailability | null = null;

/**
 * Verifica (una volta per processo, in modo sincrono per poterla usare nelle
 * opzioni di describe) che Radicale sia eseguibile: `<bin> --version` con
 * exit 0. Non controlla il pin di versione: lo fanno i test che ne dipendono.
 */
export function radicaleAvailability(): RadicaleAvailability {
  if (availabilityCache) return availabilityCache;
  const fromEnv = process.env.RADICALE_BIN?.trim();
  const bin = fromEnv || 'radicale';
  const required = !!fromEnv || envFlag('RADICALE_REQUIRED');

  const probe = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 30_000, env: radicaleEnv({}) });
  let reason: string | null = null;
  let version: string | null = null;
  if (probe.error) {
    const code = (probe.error as NodeJS.ErrnoException).code;
    reason = code === 'ENOENT'
      ? fromEnv
        ? `RADICALE_BIN="${fromEnv}" non esiste o non è eseguibile`
        : 'Radicale non disponibile: RADICALE_BIN non impostata e "radicale" non è nel PATH'
      : `"${bin} --version" non eseguibile: ${probe.error.message}`;
  } else if (probe.status !== 0) {
    reason = `"${bin} --version" è uscito con codice ${probe.status}: ${(probe.stderr || probe.stdout || '').trim().slice(0, 300)}`;
  } else {
    version = probe.stdout.trim().split(/\s+/).pop() || null;
    if (!version) reason = `"${bin} --version" non ha stampato una versione`;
  }

  const available = reason === null;
  availabilityCache = Object.freeze({
    available,
    bin,
    version,
    required,
    reason,
    skip: !available && !required ? `${reason} (impostare RADICALE_BIN per eseguire questi test)` : false,
  });
  return availabilityCache;
}

/** Disponibilità dell'interprete per mock_verify.py (stesse regole di skip di Radicale). */
export interface PythonAvailability {
  available: boolean;
  python: string;
  version: string | null;
  required: boolean;
  reason: string | null;
  skip: string | false;
}

let pythonCache: PythonAvailability | null = null;

/**
 * Verifica (una volta per processo) che l'interprete di resolvePython() sia
 * un Python 3.9+. Richiesto, cioè errore invece di skip, nelle stesse
 * condizioni di Radicale (RADICALE_BIN o RADICALE_REQUIRED=1).
 */
export function pythonAvailability(): PythonAvailability {
  if (pythonCache) return pythonCache;
  const python = resolvePython();
  const required = !!process.env.RADICALE_BIN?.trim() || envFlag('RADICALE_REQUIRED');
  const probe = spawnSync(python, ['-I', '-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: radicaleEnv({}),
  });
  let reason: string | null = null;
  let version: string | null = null;
  if (probe.error || probe.status !== 0) {
    reason = `interprete Python "${python}" non disponibile: ${probe.error?.message ?? probe.stderr.trim()}`;
  } else {
    version = probe.stdout.trim();
    const [major, minor] = version.split('.').map(Number);
    if (major !== 3 || minor < 9) reason = `serve Python 3.9 o successivo per mock_verify.py (trovato ${version})`;
  }
  const available = reason === null;
  pythonCache = Object.freeze({
    available,
    python,
    version,
    required,
    reason,
    skip: !available && !required ? `${reason} (impostare RADICALE_PYTHON)` : false,
  });
  return pythonCache;
}

/**
 * Interprete Python per mock_verify.py: RADICALE_PYTHON, poi il python del
 * venv che contiene RADICALE_BIN (stesso interprete di Radicale), poi python3.
 */
export function resolvePython(): string {
  const explicit = process.env.RADICALE_PYTHON?.trim();
  if (explicit) return explicit;
  const bin = process.env.RADICALE_BIN?.trim();
  if (bin) {
    for (const name of ['python3', 'python']) {
      const candidate = join(dirname(bin), name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return 'python3';
}

/**
 * Ambiente dei processi Python (Radicale e mock): quello del processo dei
 * test senza le variabili che cambierebbero il comportamento di Radicale,
 * più i valori fissi del harness.
 */
function radicaleEnv(extra: Record<string, string>, pythonPath: string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // --config è sempre esplicito; PYTHONPATH lo decide il harness.
  delete env.RADICALE_CONFIG;
  delete env.PYTHONPATH;
  delete env.PYTHONHOME;
  Object.assign(env, {
    // Nessun __pycache__ accanto ai plugin del repository o dei test.
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    // Come il container di produzione (design §3.5).
    TZ: 'UTC',
  });
  if (pythonPath.length) env.PYTHONPATH = pythonPath.map((p) => resolve(p)).join(':');
  return Object.assign(env, extra);
}

// ─── Configurazione ───────────────────────────────

/** Autenticazione del server di prova. */
export type RadicaleAuth =
  /** htpasswd in chiaro generato dal harness (utente → password). */
  | { type: 'htpasswd'; users?: Record<string, string> }
  /**
   * Plugin Python: `module` è il nome importabile (es. 'caldes_auth'),
   * `pythonPath` le directory che lo contengono, `options` le chiavi extra
   * della sezione [auth] (Radicale le accetta senza validarle per i tipi non
   * interni), `env` le variabili lette dal plugin.
   */
  | { type: 'plugin'; module: string; pythonPath?: string[]; options?: Record<string, ConfigValue>; env?: Record<string, string> };

/** Diritti: tipi interni di Radicale, oppure `from_file` con il testo delle regole, oppure un plugin. */
export type RadicaleRights =
  | 'owner_only'
  | 'owner_write'
  | 'authenticated'
  | { type: 'from_file'; rules: string }
  | { type: 'plugin'; module: string; pythonPath?: string[]; options?: Record<string, ConfigValue>; env?: Record<string, string> };

export type ConfigValue = string | number | boolean;

export interface StartRadicaleOptions {
  /** Binario (default: radicaleAvailability().bin). */
  bin?: string;
  /** Etichetta per la directory temporanea e i messaggi. */
  label?: string;
  /** Default: htpasswd con DEFAULT_RADICALE_USERS. */
  auth?: RadicaleAuth;
  /** Default: owner_only (ogni utente vede solo il proprio principal). */
  rights?: RadicaleRights;
  /**
   * Opzioni di [server], [rights] e [storage] che i test toccano più spesso.
   * I default replicano la config di produzione del design §3.2 dove cambiano
   * la semantica (limite delle occorrenze, cache, token di sync, item rotti,
   * precondizioni, cancellazione e sovrascrittura delle collezioni);
   * `auth.delay` e `server.delay_on_error` sono a 0 per velocità e si alzano
   * con `config` nei test che misurano i ritardi.
   */
  maxVeventRruleOccurrence?: number;
  strictPreconditions?: boolean;
  /** DELETE di una collezione (default false come in produzione: 403). */
  permitDeleteCollection?: boolean;
  /** MKCALENDAR/PUT sopra una collezione esistente (default false come in produzione: 409). */
  permitOverwriteCollection?: boolean;
  skipBrokenItem?: boolean;
  maxSyncTokenAge?: number;
  /** Collezioni create automaticamente per ogni utente (default nessuna). */
  predefinedCollections?: Record<string, Record<string, string>>;
  /** Sezioni e chiavi aggiuntive o sovrascritte, applicate per ultime. */
  config?: Record<string, Record<string, ConfigValue>>;
  /** Variabili d'ambiente aggiuntive del processo Radicale. */
  env?: Record<string, string>;
  /** Directory aggiunte a PYTHONPATH (oltre a quelle di auth e rights). */
  pythonPath?: string[];
  /** Livello dei log di Radicale (default info: serve per leggere la porta). */
  logLevel?: 'debug' | 'info' | 'warning' | 'error' | 'critical';
  /** Tempo massimo per l'avvio (default 30 s). */
  startTimeoutMs?: number;
  /** Non cancellare la directory allo stop (default: TEST_RADICALE_KEEP=1). */
  keepData?: boolean;
}

/** Config INI generata per un server di prova (esportata per ispezione nei test). */
export function buildRadicaleConfig(opts: {
  storageDir: string;
  htpasswdPath: string;
  rightsPath: string;
  options: StartRadicaleOptions;
}): string {
  const { options } = opts;
  const auth = options.auth ?? { type: 'htpasswd' };
  const rights = options.rights ?? 'owner_only';

  const sections: Record<string, Record<string, ConfigValue>> = {
    server: {
      hosts: '127.0.0.1:0',
      max_connections: 16,
      max_content_length: 20_000_000,
      timeout: 30,
      delay_on_error: 0,
      // Vale anche in lettura: mai abbassarlo dopo che ci sono dati (design §3.2).
      max_vevent_rrule_occurrence: options.maxVeventRruleOccurrence ?? 50_000,
    },
    auth: auth.type === 'htpasswd'
      ? { type: 'htpasswd', htpasswd_filename: opts.htpasswdPath, htpasswd_encryption: 'plain', delay: 0 }
      : { type: auth.module, delay: 0, ...(auth.options ?? {}) },
    rights: {
      ...(typeof rights === 'string'
        ? { type: rights }
        : rights.type === 'from_file'
          ? { type: 'from_file', file: opts.rightsPath }
          : { type: rights.module, ...(rights.options ?? {}) }),
      permit_delete_collection: options.permitDeleteCollection ?? false,
      permit_overwrite_collection: options.permitOverwriteCollection ?? false,
    },
    storage: {
      type: 'multifilesystem',
      filesystem_folder: opts.storageDir,
      use_mtime_and_size_for_item_cache: true,
      max_sync_token_age: options.maxSyncTokenAge ?? 5_184_000,
      skip_broken_item: options.skipBrokenItem ?? true,
      strict_preconditions: options.strictPreconditions ?? false,
      predefined_collections: JSON.stringify(options.predefinedCollections ?? {}),
    },
    hook: { type: 'none' },
    sharing: { type: 'none' },
    web: { type: 'none' },
    logging: { level: options.logLevel ?? 'info', mask_passwords: true },
  };
  for (const [section, values] of Object.entries(options.config ?? {})) {
    sections[section] = { ...(sections[section] ?? {}), ...values };
  }

  const lines = [`# Generata da apps/api/test/helpers/radicale.ts (${options.label ?? 'radicale'})`];
  for (const [section, values] of Object.entries(sections)) {
    lines.push('', `[${section}]`);
    for (const [key, value] of Object.entries(values)) {
      const text = typeof value === 'boolean' ? (value ? 'True' : 'False') : String(value);
      if (/[\r\n]/.test(text)) throw new Error(`Valore multiriga non ammesso per ${section}.${key}`);
      lines.push(`${key} = ${text}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function htpasswdContent(users: Record<string, string>): string {
  return Object.entries(users)
    .map(([user, password]) => {
      if (!user || /[:\s]/.test(user)) throw new Error(`Username htpasswd non valido: "${user}"`);
      if (/[\r\n]/.test(password)) throw new Error(`Password htpasswd non valida per "${user}"`);
      return `${user}:${password}`;
    })
    .join('\n') + '\n';
}

// ─── Processi figli ───────────────────────────────

const runningChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

/** Registra un figlio da uccidere se il processo dei test esce senza stop (crash, timeout). */
function trackChild(child: ChildProcess): void {
  runningChildren.add(child);
  child.once('exit', () => runningChildren.delete(child));
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const c of runningChildren) c.kill('SIGKILL');
  });
}

/**
 * Termina un figlio: SIGTERM, poi SIGKILL dopo `graceMs`. Attende 'close'
 * (processo uscito e stdout/stderr chiusi), così nessun dato arriva al log
 * dopo la chiusura del file.
 */
async function terminate(child: ChildProcess, graceMs = 5_000): Promise<void> {
  const closed = new Promise<void>((resolveClose) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      // Già uscito: 'close' può essere arrivato o arrivare a breve.
      if (!child.stdout?.readable && !child.stderr?.readable) resolveClose();
      else child.once('close', () => resolveClose());
      return;
    }
    child.once('close', () => resolveClose());
  });
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
  try {
    await closed;
  } finally {
    clearTimeout(timer);
  }
}

/** Buffer delle righe di log di un figlio (stdout e stderr), con file e inoltro opzionale. */
class LogBuffer {
  private readonly lines: string[] = [];
  /** Righe scartate dalla testa del buffer (i mark restano validi). */
  private dropped = 0;
  private partial = '';
  private closed = false;
  private readonly listeners = new Set<(line: string) => void>();
  private readonly file: WriteStream | null;

  constructor(private readonly tag: string, filePath: string | null) {
    this.file = filePath ? createWriteStream(filePath, { flags: 'a' }) : null;
  }

  attach(child: ChildProcess): void {
    // setEncoding usa uno StringDecoder: un carattere UTF-8 diviso fra due chunk resta intero.
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding('utf8');
      stream?.on('data', (text: string) => this.push(text));
    }
  }

  private push(text: string): void {
    if (this.closed) return;
    this.file?.write(text);
    const parts = (this.partial + text).split(/\r?\n/);
    this.partial = parts.pop() ?? '';
    for (const line of parts) {
      this.lines.push(line);
      if (this.lines.length > 20_000) {
        this.lines.splice(0, 5_000);
        this.dropped += 5_000;
      }
      if (envFlag('TEST_RADICALE_LOG')) process.stderr.write(`[${this.tag}] ${line}\n`);
      for (const listener of this.listeners) listener(line);
    }
  }

  onLine(listener: (line: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Posizione corrente nel log: da passare a `since()` per leggere solo le righe successive. */
  mark(): number {
    return this.dropped + this.lines.length;
  }

  since(mark: number): string {
    return this.lines.slice(Math.max(0, mark - this.dropped)).join('\n');
  }

  tail(count = 40): string {
    return [...this.lines.slice(-count), this.partial].filter(Boolean).join('\n');
  }

  all(): string {
    return [...this.lines, this.partial].filter(Boolean).join('\n');
  }

  close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    const file = this.file;
    return file ? new Promise((done) => file.end(() => done())) : Promise.resolve();
  }
}

// ─── Server Radicale ───────────────────────────────

export interface RadicaleServer {
  /** URL base, es. http://127.0.0.1:43523 (senza / finale). */
  readonly url: string;
  readonly port: number;
  /** Versione riportata da `radicale --version`. */
  readonly version: string;
  readonly bin: string;
  /** Directory temporanea del server (config, utenti, log, storage). */
  readonly rootDir: string;
  /** `filesystem_folder` di [storage]. */
  readonly storageDir: string;
  /** `<storageDir>/collection-root`: le collezioni sono sotto `<principal>/<slug>/`. */
  readonly collectionRoot: string;
  readonly configPath: string;
  readonly logPath: string;
  /** Utenti htpasswd (vuoto con un plugin di autenticazione). */
  readonly users: Readonly<Record<string, string>>;
  /**
   * Client autenticato. Senza argomenti usa il primo utente htpasswd; con un
   * plugin vanno passate le credenziali.
   */
  client(username?: string, password?: string): CalDavClient;
  /** Client senza Authorization. */
  anonymous(): CalDavClient;
  /** Percorso sul filesystem di una collezione o di un oggetto, es. fsPath('federico', 'lavoro', 'a.ics'). */
  fsPath(...segments: string[]): string;
  /** Righe di log finora (per leggere solo le successive con `logsSince`). */
  logMark(): number;
  logsSince(mark: number): string;
  logs(): string;
  /** Il processo è ancora vivo. */
  isRunning(): boolean;
  /** Ferma il server e (salvo keepData) cancella la directory temporanea. Idempotente. */
  stop(): Promise<void>;
}

/**
 * Avvia un Radicale reale con config generata e attende che risponda.
 * Lancia con il motivo e la coda del log se il binario manca, il processo
 * esce o l'avvio supera il timeout.
 */
export async function startRadicale(options: StartRadicaleOptions = {}): Promise<RadicaleServer> {
  const availability = radicaleAvailability();
  const bin = options.bin ?? availability.bin;
  if (!options.bin && !availability.available) {
    throw new Error(`Impossibile avviare Radicale: ${availability.reason}`);
  }
  const version = options.bin ? probeVersion(options.bin) : (availability.version as string);

  const label = (options.label ?? 'radicale').replace(/[^a-z0-9-]+/gi, '-').slice(0, 40) || 'radicale';
  const rootDir = mkdtempSync(join(tmpdir(), `caldes-radicale-${label}-`));
  const storageDir = join(rootDir, 'collections');
  const configPath = join(rootDir, 'config');
  const htpasswdPath = join(rootDir, 'users');
  const rightsPath = join(rootDir, 'rights');
  const logPath = join(rootDir, 'radicale.log');

  const auth = options.auth ?? { type: 'htpasswd' };
  const users = auth.type === 'htpasswd' ? { ...(auth.users ?? DEFAULT_RADICALE_USERS) } : {};
  const rights = options.rights ?? 'owner_only';

  writeFileSync(htpasswdPath, htpasswdContent(users), { mode: 0o600 });
  if (typeof rights !== 'string' && rights.type === 'from_file') writeFileSync(rightsPath, rights.rules);
  writeFileSync(configPath, buildRadicaleConfig({ storageDir, htpasswdPath, rightsPath, options }));

  const pythonPath = [
    ...(auth.type === 'plugin' ? auth.pythonPath ?? [] : []),
    ...(typeof rights !== 'string' && rights.type === 'plugin' ? rights.pythonPath ?? [] : []),
    ...(options.pythonPath ?? []),
  ];
  const extraEnv = {
    ...(auth.type === 'plugin' ? auth.env ?? {} : {}),
    ...(typeof rights !== 'string' && rights.type === 'plugin' ? rights.env ?? {} : {}),
    ...(options.env ?? {}),
  };

  const log = new LogBuffer(`radicale:${label}`, logPath);
  const child = spawn(bin, ['--config', configPath], {
    cwd: rootDir,
    env: radicaleEnv(extraEnv, pythonPath),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  trackChild(child);
  log.attach(child);

  const keepData = options.keepData ?? envFlag('TEST_RADICALE_KEEP');
  let stopped: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopped ??= (async () => {
      await terminate(child);
      await log.close();
      if (keepData) {
        process.stderr.write(`[radicale:${label}] directory conservata: ${rootDir}\n`);
      } else {
        rmSync(rootDir, { recursive: true, force: true });
      }
    })();
    return stopped;
  };

  let port: number;
  try {
    port = await waitForListening(child, log, options.startTimeoutMs ?? 30_000);
  } catch (err) {
    const tail = log.tail();
    await stop();
    throw new Error(`Avvio di Radicale (${bin}) fallito: ${(err as Error).message}\n--- log ---\n${tail}`);
  }
  const url = `http://127.0.0.1:${port}`;

  try {
    await waitForHttp(url, child, options.startTimeoutMs ?? 30_000);
  } catch (err) {
    const tail = log.tail();
    await stop();
    throw new Error(`Radicale non risponde su ${url}: ${(err as Error).message}\n--- log ---\n${tail}`);
  }

  const firstUser = Object.keys(users)[0];
  return {
    url,
    port,
    version,
    bin,
    rootDir,
    storageDir,
    collectionRoot: join(storageDir, 'collection-root'),
    configPath,
    logPath,
    users,
    client(username?: string, password?: string): CalDavClient {
      const user = username ?? firstUser;
      if (!user) throw new Error('Nessun utente htpasswd: passare username e password al client');
      const pass = password ?? users[user];
      if (pass === undefined) throw new Error(`Password sconosciuta per "${user}": passarla al client`);
      return new CalDavClient(url, { username: user, password: pass });
    },
    anonymous: () => new CalDavClient(url, null),
    fsPath: (...segments: string[]) => join(storageDir, 'collection-root', ...segments),
    logMark: () => log.mark(),
    logsSince: (mark: number) => log.since(mark),
    logs: () => log.all(),
    isRunning: () => child.exitCode === null && child.signalCode === null,
    stop,
  };
}

function probeVersion(bin: string): string {
  const probe = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 30_000, env: radicaleEnv({}) });
  if (probe.error || probe.status !== 0) {
    throw new Error(`"${bin} --version" non eseguibile: ${probe.error?.message ?? probe.stderr}`);
  }
  return probe.stdout.trim();
}

/** Attende "Listening on '<host>:<porta>'" e "Radicale server ready" nel log. */
function waitForListening(child: ChildProcess, log: LogBuffer, timeoutMs: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    let port: number | null = null;
    const cleanup = (): void => {
      clearTimeout(timer);
      unsubscribe();
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`processo uscito durante l'avvio (code=${code}, signal=${signal})`));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const unsubscribe = log.onLine((line) => {
      const listening = /Listening on '(?:\[[^\]]+\]|[^':]+):(\d+)'/.exec(line);
      if (listening) port = Number(listening[1]);
      if (/Radicale server ready/.test(line)) {
        cleanup();
        if (port) resolvePort(port);
        else reject(new Error('"Radicale server ready" senza "Listening on" nel log'));
      }
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout di ${timeoutMs} ms`));
    }, timeoutMs);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

/** Sonda HTTP (OPTIONS /, senza credenziali): pronto alla prima risposta non 5xx. */
async function waitForHttp(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'nessuna risposta';
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('processo terminato');
    try {
      const res = await fetch(`${url}/`, { method: 'OPTIONS', signal: AbortSignal.timeout(2_000) });
      await res.arrayBuffer();
      if (res.status < 500) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout di ${timeoutMs} ms (${lastError})`);
}

/** Handle di `useRadicale`: il server esiste fra il before e l'after della suite. */
export interface RadicaleHandle {
  readonly server: RadicaleServer;
  client(username?: string, password?: string): CalDavClient;
}

/**
 * Avvia un Radicale prima dei test della suite (o del file, se chiamata a
 * livello di modulo) e lo ferma dopo l'ultimo. Usare dentro un describe con
 * `{ skip: radicaleAvailability().skip }` così, senza Radicale, la suite viene
 * saltata con un motivo esplicito e il server non viene avviato.
 *
 * Le opzioni possono essere una funzione, valutata nel before: serve quando
 * dipendono da qualcosa avviato da un hook registrato prima (es. l'URL del
 * mock di useMockVerify per CALDAV_BACKEND_URL; gli hook girano in ordine di
 * registrazione).
 */
export function useRadicale(
  options: StartRadicaleOptions | (() => StartRadicaleOptions | Promise<StartRadicaleOptions>) = {},
): RadicaleHandle {
  let current: RadicaleServer | null = null;
  before(async () => {
    current = await startRadicale(typeof options === 'function' ? await options() : options);
  });
  after(async () => {
    await current?.stop();
    current = null;
  });
  const handle: RadicaleHandle = {
    get server(): RadicaleServer {
      if (!current) throw new Error('Radicale non avviato: usare il server dentro i test della suite di useRadicale()');
      return current;
    },
    client: (username?: string, password?: string) => handle.server.client(username, password),
  };
  return handle;
}

// ─── Mock di verify-credentials ───────────────────────────────

/** Modalità del mock: risposta normale o guasto simulato (vedi mock_verify.py). */
export type MockVerifyMode = 'ok' | 'deny' | 'error' | 'unavailable' | 'rate_limited' | 'slow' | 'garbage' | 'drop';

export interface MockVerifyUser {
  username: string;
  password: string;
  /** Principal restituito per questo utente (default: quello canonico o lo username, secondo principalMode). */
  principal?: string;
}

export interface MockVerifyState {
  mode: MockVerifyMode;
  /** Ritardo prima della risposta in modalità 'slow' (ms). */
  delay_ms: number;
  /** Bearer atteso (CALDAV_SERVICE_TOKEN). */
  token: string;
  /** 'canonical': ogni credenziale valida → `principal` (F1); 'username': come l'API di oggi. */
  principal_mode: 'canonical' | 'username';
  principal: string;
  /** Username con prefisso caldes- rifiutati con 401 (username riservati, design §3.3). */
  reject_reserved: boolean;
  /** Solo gli username: le password non escono mai dal mock. */
  usernames: string[];
}

export interface MockVerifyCall {
  ts: number;
  method: string;
  path: string;
  mode: MockVerifyMode;
  status: number | null;
  username: string | null;
  /** sha256 esadecimale della password ricevuta (mai la password in chiaro). */
  password_sha256: string | null;
  authorization_valid: boolean;
  x_forwarded_for: string | null;
  x_remote_addr: string | null;
  user_agent: string | null;
  content_type: string | null;
}

export interface MockVerifyOptions {
  /** Interprete (default resolvePython()). */
  python?: string;
  /** Bearer atteso (default TEST_ENV.CALDAV_SERVICE_TOKEN). */
  token?: string;
  users?: MockVerifyUser[];
  principal?: string;
  principalMode?: 'canonical' | 'username';
  rejectReserved?: boolean;
  mode?: MockVerifyMode;
  delayMs?: number;
  startTimeoutMs?: number;
}

export interface MockVerifyServer {
  /** http://127.0.0.1:<porta> */
  readonly url: string;
  readonly port: number;
  /** Valore per CALDAV_BACKEND_URL dei plugin: `<url>/api/caldav-backend`. */
  readonly backendUrl: string;
  /** Bearer atteso dal mock (da passare al plugin come CALDAV_SERVICE_TOKEN). */
  readonly token: string;
  state(): Promise<MockVerifyState>;
  /** Cambia modalità, ritardo, utenti o principal a runtime (patch). */
  setState(patch: Partial<Omit<MockVerifyState, 'usernames'>> & { users?: MockVerifyUser[] }): Promise<MockVerifyState>;
  calls(): Promise<MockVerifyCall[]>;
  clearCalls(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Avvia helpers/mock_verify.py su una porta effimera e attende la riga di
 * readiness su stdout (`{"event": "ready", "port": N}`).
 */
export async function startMockVerify(options: MockVerifyOptions = {}): Promise<MockVerifyServer> {
  const python = options.python ?? resolvePython();
  const token = options.token ?? TEST_ENV.CALDAV_SERVICE_TOKEN;
  const initial = {
    mode: options.mode ?? 'ok',
    delay_ms: options.delayMs ?? 0,
    token,
    principal: options.principal ?? TEST_PRINCIPAL,
    principal_mode: options.principalMode ?? 'canonical',
    reject_reserved: options.rejectReserved ?? true,
    users: options.users ?? [],
  };

  const log = new LogBuffer('mock-verify', null);
  // -I: modalità isolata (niente site-packages dell'utente né directory corrente nel path).
  const child = spawn(python, ['-I', MOCK_VERIFY_SCRIPT, '--host', '127.0.0.1', '--port', '0'], {
    env: radicaleEnv({ MOCK_VERIFY_STATE: JSON.stringify(initial) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  trackChild(child);
  log.attach(child);

  let port: number;
  try {
    port = await new Promise<number>((resolvePort, reject) => {
      const timer = setTimeout(() => done(new Error(`timeout di ${options.startTimeoutMs ?? 15_000} ms`)), options.startTimeoutMs ?? 15_000);
      const onExit = (code: number | null): void => done(new Error(`processo uscito durante l'avvio (code=${code})`));
      const onError = (err: Error): void => done(err);
      const unsubscribe = log.onLine((line) => {
        if (!line.startsWith('{')) return;
        try {
          const event = JSON.parse(line) as { event?: string; port?: number };
          if (event.event === 'ready' && typeof event.port === 'number') done(null, event.port);
        } catch {
          /* riga non JSON: log del mock */
        }
      });
      function done(err: Error | null, value?: number): void {
        clearTimeout(timer);
        unsubscribe();
        child.off('exit', onExit);
        child.off('error', onError);
        if (err) reject(err);
        else resolvePort(value as number);
      }
      child.once('exit', onExit);
      child.once('error', onError);
    });
  } catch (err) {
    await terminate(child);
    throw new Error(`Avvio del mock verify-credentials (${python}) fallito: ${(err as Error).message}\n--- log ---\n${log.tail()}`);
  }

  const url = `http://127.0.0.1:${port}`;
  const control = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`mock ${method} ${path}: HTTP ${res.status} ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  };

  let stopped: Promise<void> | null = null;
  return {
    url,
    port,
    backendUrl: `${url}/api/caldav-backend`,
    token,
    state: () => control<MockVerifyState>('GET', '/__mock/state'),
    setState: (patch) => control<MockVerifyState>('POST', '/__mock/state', patch),
    calls: () => control<MockVerifyCall[]>('GET', '/__mock/calls'),
    clearCalls: async () => {
      await control<void>('DELETE', '/__mock/calls');
    },
    stop: () => {
      stopped ??= (async () => {
        await terminate(child);
        await log.close();
      })();
      return stopped;
    },
  };
}

/** Handle di `useMockVerify`. */
export interface MockVerifyHandle {
  readonly mock: MockVerifyServer;
}

/** Avvia il mock prima dei test della suite e lo ferma dopo l'ultimo. */
export function useMockVerify(options: MockVerifyOptions = {}): MockVerifyHandle {
  let current: MockVerifyServer | null = null;
  before(async () => {
    current = await startMockVerify(options);
  });
  after(async () => {
    await current?.stop();
    current = null;
  });
  return {
    get mock(): MockVerifyServer {
      if (!current) throw new Error('Mock verify-credentials non avviato: usarlo dentro i test della suite');
      return current;
    },
  };
}
