/**
 * Ambiente dei test dell'API. Va valutato PRIMA di qualsiasi modulo di src/.
 *
 * Diversi moduli leggono process.env al momento dell'import, non della chiamata:
 *  - src/db/index.ts lancia senza DATABASE_URL e crea subito il pool;
 *  - src/app.ts lancia senza CORS_ORIGINS fuori da development, crea
 *    UPLOAD_DIR e attiva il logger HTTP di Hono se NODE_ENV != production;
 *  - src/lib/calendar/token.ts fissa il secret dei token di gestione
 *    (BOOKING_TOKEN_SECRET, fallback JWT_SECRET);
 *  - src/lib/turnstile.ts e src/lib/captcha/cap.ts leggono le chiavi del captcha;
 *  - src/lib/private-files.ts crea PRIVATE_UPLOAD_DIR;
 *  - src/lib/logger.ts sceglie livello e transport di pino.
 *
 * Per questo test/run.ts e lo script test:migrate lo precaricano con
 * `--import ./test/helpers/preload.mjs` (che lo importa nel solo thread
 * principale) e ogni helper che importa src/ lo importa per primo: l'import è
 * idempotente, il modulo viene valutato una volta per processo.
 *
 * Cosa garantisce:
 * 1. Protezione dai DB veri: TEST_DATABASE_URL è obbligatoria, deve puntare a
 *    localhost e il nome del database deve contenere 'test' oppure il
 *    marcatore di fase 'caldes_f<N>' (es. caldes_f0, caldes_f1_found).
 *    DATABASE_URL viene SEMPRE sovrascritta, mai ereditata dalla shell.
 * 2. Ambiente ermetico: rimuove le variabili dei servizi esterni (email,
 *    Telegram, captcha, pagamenti, AI, S4, WhatsApp...) così nessun test manda
 *    email vere o chiama API esterne, e fissa i secret a valori di test noti.
 * 3. Determinismo: TZ=UTC nel processo e TimeZone=UTC nella sessione Postgres,
 *    come il container di produzione; URL pubblici fissi su domini `.test`;
 *    log applicativi spenti (TEST_LOG_LEVEL e TEST_HTTP_LOG per riaccenderli).
 */

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Protezione del database ───────────────────────────────

/** Host ammessi per il database dei test: solo loopback. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Parametri di query ammessi nell'URL. postgres-js inoltra come parametri di
 * avvio della sessione tutti quelli che non riconosce: un `?database=` o un
 * `?user=` in coda potrebbero quindi spostare la connessione altrove.
 */
const ALLOWED_QUERY_PARAMS = new Set(['sslmode', 'ssl', 'application_name', 'connect_timeout', 'TimeZone']);

/**
 * Il nome del database deve contenere 'test' oppure il marcatore di fase
 * 'caldes_f<N>' (database locali delle fasi del piano: caldes_f0, caldes_f1_*).
 * Il database applicativo 'caldes' non corrisponde a nessuno dei due.
 */
const ALLOWED_DB_NAME_PATTERN = /test|caldes_f\d/;

export interface TestDatabaseTarget {
  /** URL normalizzato, con TimeZone=UTC aggiunto se assente. */
  url: string;
  /** Host (sempre loopback). */
  host: string;
  /** Nome del database. */
  database: string;
}

/** URL con la password oscurata, per i messaggi d'errore. */
function redactUrl(raw: string): string {
  return raw.replace(/\/\/([^:/@]+):([^@]*)@/, '//$1:***@');
}

/**
 * Valida l'URL del database dei test. Lancia con un messaggio esplicito se
 * l'URL manca, non è postgres, non punta a localhost o il nome del database
 * non contiene 'test' o 'caldes_f<N>'. Esportata per i test della protezione.
 */
export function parseTestDatabaseUrl(raw: string | undefined): TestDatabaseTarget {
  const refuse = (reason: string): never => {
    throw new Error(
      `Rifiuto di avviare i test: ${reason}. ` +
        'Imposta TEST_DATABASE_URL su un Postgres locale dedicato ai test, ' +
        'es. postgresql://caldes:caldes@localhost:5432/caldes_test',
    );
  };

  if (!raw || !raw.trim()) return refuse('TEST_DATABASE_URL non impostata');

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return refuse(`TEST_DATABASE_URL non è un URL valido (${redactUrl(raw)})`);
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    return refuse(`protocollo non supportato "${url.protocol}" (atteso postgres: o postgresql:)`);
  }

  const host = url.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    return refuse(`l'host "${host || '(vuoto)'}" non è localhost (${redactUrl(raw)})`);
  }

  let database: string;
  try {
    database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    return refuse(`nome del database non decodificabile (${redactUrl(raw)})`);
  }
  if (!database || database.includes('/')) {
    return refuse(`nome del database mancante o non valido (${redactUrl(raw)})`);
  }
  const lower = database.toLowerCase();
  if (!ALLOWED_DB_NAME_PATTERN.test(lower)) {
    return refuse(`il database "${database}" non contiene 'test' né 'caldes_f<N>' nel nome`);
  }

  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_QUERY_PARAMS.has(key)) {
      return refuse(`parametro "${key}" non ammesso nell'URL (ammessi: ${[...ALLOWED_QUERY_PARAMS].join(', ')})`);
    }
  }

  // Sessione Postgres in UTC come in produzione: date_trunc e i cast da
  // timestamptz a date dipendono dal TimeZone della sessione.
  if (!url.searchParams.has('TimeZone')) url.searchParams.set('TimeZone', 'UTC');

  return { url: url.toString(), host, database };
}

// ─── Valori fissi dell'ambiente di test ───────────────────────────────

/** Directory temporanee per upload e file privati (le crea app.ts all'import). */
const TMP_ROOT = join(tmpdir(), 'caldes-api-test');

/**
 * Valori imposti a ogni avvio. I secret sono noti e fissi (mai usati fuori dai
 * test) così token e snapshot sono riproducibili; gli URL pubblici usano il
 * TLD riservato `.test` (RFC 6761) e non risolvono mai verso servizi veri.
 */
export const TEST_ENV = Object.freeze({
  NODE_ENV: 'test',
  TZ: 'UTC',
  JWT_SECRET: 'test-only-jwt-secret-0123456789abcdef0123456789abcdef',
  BOOKING_TOKEN_SECRET: 'test-only-booking-token-secret-0123456789abcdef012345',
  WEBHOOK_ENCRYPTION_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  CALDAV_SERVICE_TOKEN: 'test-only-caldav-service-token-0123456789abcdef',
  SITE_URL: 'https://sito.caldes.test',
  PUBLIC_SITE_URL: 'https://sito.caldes.test',
  ADMIN_URL: 'https://admin.caldes.test',
  PORTAL_URL: 'https://portale.caldes.test',
  API_URL: 'https://api.caldes.test',
  PUBLIC_API_URL: 'https://api.caldes.test',
  CORS_ORIGINS: 'https://sito.caldes.test,https://admin.caldes.test',
  UPLOAD_DIR: join(TMP_ROOT, 'uploads'),
  PRIVATE_UPLOAD_DIR: join(TMP_ROOT, 'private-uploads'),
  // Le chiavi dei rate limit arrivano da X-Forwarded-For (vedi helpers/http.ts).
  TRUST_PROXY_HEADERS: 'true',
  // Le migrazioni le applica helpers/db.ts, mai il boot di src/index.ts.
  AUTO_MIGRATE: 'false',
});

/**
 * Variabili rimosse per rendere l'ambiente ermetico: servizi esterni (nessuna
 * email, nessun Telegram, captcha disattivato come in sviluppo), credenziali,
 * percorsi e URL che cambierebbero l'output. Chi deve provare un ramo che le
 * usa le imposta per il solo test con `withEnv()`.
 */
const SCRUB_EXACT = new Set([
  'ADMIN_EMAIL',
  'ANALYTICS_PEPPER',
  'ANTHROPIC_API_KEY',
  'AUDIT_BOOKING_URL',
  'BUGSINK_DSN',
  'CALCOM_API_KEY',
  'CHROME_PATH',
  'CONTACT_FORM_EVENT_TYPE',
  'COOKIE_DOMAIN',
  'CRON_SECRET',
  'GOOGLE_AI_API_KEY',
  'KB_DIR',
  'KIE_API_KEY',
  'MAIL_ENC_KEY',
  'MAXMIND_MMDB_PATH',
  'OPENAI_API_KEY',
  'ORGANIZER_NAME',
  'PERPLEXITY_API_KEY',
  'PORT',
  'PRIVATE_URL_TTL_DAYS',
  'PUBLIC_BASE_URL',
  'QUOTE_PUBLIC_URL',
  // Peer TCP ammessi su /api/caldav-backend: le richieste in-process non hanno
  // un socket, quindi con la variabile impostata risponderebbero 404.
  'CALDAV_BACKEND_ALLOWED_PEERS',
  // Client CalDAV di servizio e control-plane di Radicale (contratto
  // control-plane §1.3): i test passano i valori in modo esplicito. Restano
  // RADICALE_BIN, RADICALE_PYTHON e RADICALE_REQUIRED, che sono del harness.
  'RADICALE_DATA_DIR',
  'RADICALE_PRINCIPAL',
  'RADICALE_PROBE_PASSWORD',
  'RADICALE_SVC_PASSWORD',
  'RADICALE_SVC_USER',
  'RADICALE_TIMEOUT_MS',
  'RADICALE_URL',
  'UNSPLASH_ACCESS_KEY',
  'WORKFLOW_HTTP_ALLOWLIST',
]);

const SCRUB_PREFIXES = [
  // CALDES_POLICY_FILE, CALDES_CONTROL_PLANE, CALDES_IDENTITY_SOURCE... (control-plane).
  'CALDES_',
  'CAP_',
  'CAPTCHA_PROVIDER',
  'CAPTURE_',
  'DB_POOL_',
  'EMAIL_',
  'GOWA_',
  'INFOMANIAK_',
  'PAYPAL_',
  'PORTAL_',
  'RESEND_',
  'REVOLUT_',
  'S4_',
  'SITO_REVALIDATE_',
  'SMTP_',
  'STRIPE_',
  'TELEGRAM_',
  'TURNSTILE_',
  'TWILIO_',
  'WA_',
  'WHATSAPP_',
];

// ─── Applicazione (una sola volta per processo) ───────────────────────────────

const APPLIED = Symbol.for('caldes.test.env.applied');
type GlobalWithFlag = typeof globalThis & { [APPLIED]?: TestDatabaseTarget };
const globalRef = globalThis as GlobalWithFlag;

function applyTestEnvironment(): TestDatabaseTarget {
  const target = parseTestDatabaseUrl(process.env.TEST_DATABASE_URL);

  for (const key of Object.keys(process.env)) {
    if (SCRUB_EXACT.has(key) || SCRUB_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      delete process.env[key];
    }
  }

  Object.assign(process.env, TEST_ENV);
  process.env.DATABASE_URL = target.url;
  // pino: 'silent' salvo richiesta esplicita (TEST_LOG_LEVEL=debug per indagare).
  process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL || 'silent';

  mkdirSync(TEST_ENV.UPLOAD_DIR, { recursive: true });
  mkdirSync(TEST_ENV.PRIVATE_UPLOAD_DIR, { recursive: true });

  // Il logger HTTP di Hono (attivo fuori da production) stampa ogni richiesta
  // con console.log, catturato al momento dell'import di app.ts: filtrarlo qui
  // tiene leggibile l'output dei test. TEST_HTTP_LOG=1 lo lascia passare.
  if (!process.env.TEST_HTTP_LOG) {
    const original = console.log.bind(console);
    const HONO_LINE = /^(<--|-->) [A-Z]+ /;
    console.log = (...args: unknown[]): void => {
      if (typeof args[0] === 'string' && HONO_LINE.test(args[0])) return;
      original(...args);
    };
  }

  return target;
}

/** Database dei test validato (host loopback, nome con 'test' o 'caldes_f<N>'). */
export const TEST_DATABASE: TestDatabaseTarget = globalRef[APPLIED] ?? (globalRef[APPLIED] = applyTestEnvironment());

// ─── Override temporanei ───────────────────────────────

/**
 * Esegue `fn` con alcune variabili d'ambiente cambiate e le ripristina sempre
 * dopo (anche su eccezione). `undefined` rimuove la variabile.
 *
 * Vale solo per i moduli che leggono env al momento della chiamata (es.
 * NODE_ENV nel ramo captcha, ADMIN_EMAIL, ORGANIZER_NAME, CALDAV_SERVICE_TOKEN);
 * non per quelli che la leggono all'import (vedi l'elenco in testa al file).
 * Non usarlo con test concorrenti nello stesso processo.
 */
export async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
