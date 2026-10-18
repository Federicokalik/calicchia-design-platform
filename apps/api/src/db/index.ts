import postgres from 'postgres';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

// Pool sizing is tunable via env (DB-11). Defaults are sized for the single
// API replica (see DEPLOY.md: no horizontal scaling). max_lifetime caps how
// long a connection is reused so the pool recycles cleanly behind a proxy or
// after a DB failover, instead of leaning on the postgres-js default.
const intEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const sql = postgres(process.env.DATABASE_URL, {
  max: intEnv('DB_POOL_MAX', 10),
  idle_timeout: intEnv('DB_POOL_IDLE_TIMEOUT', 20),
  connect_timeout: intEnv('DB_POOL_CONNECT_TIMEOUT', 10),
  max_lifetime: intEnv('DB_POOL_MAX_LIFETIME', 60 * 30), // 30 min
  onnotice: () => {}, // silence NOTICE messages
});

/**
 * Pool dedicato al calendario (fase F2 del passaggio a Radicale, design §6.2 e
 * revisione red-team punto 30): indicizzatore, sync delle collezioni, gate
 * delle scritture (advisory lock cal-write), worker dei job e rebuild. Separato
 * dal pool principale perché quei lavori tengono connessioni durante l'I/O
 * verso Radicale: con un pool solo, un picco del calendario potrebbe esaurire
 * le connessioni delle route (e viceversa). Budget per processo nel contratto
 * docs/calendar-radicale/contracts/f2-modules.md §1.3: al massimo 2 sync, 1
 * gate delle scritture e 1 connessione per job e comandi brevi.
 *
 * Le connessioni si aprono alla prima query (postgres-js è pigro): in mode
 * postgres, senza Radicale né indice, il pool resta vuoto. Il pool principale
 * non cambia. Va chiuso nello shutdown con closeCalendarPool().
 */
export const calSql = postgres(process.env.DATABASE_URL, {
  max: intEnv('CAL_DB_POOL_MAX', 4),
  idle_timeout: intEnv('CAL_DB_POOL_IDLE_TIMEOUT', intEnv('DB_POOL_IDLE_TIMEOUT', 20)),
  connect_timeout: intEnv('DB_POOL_CONNECT_TIMEOUT', 10),
  max_lifetime: intEnv('DB_POOL_MAX_LIFETIME', 60 * 30),
  onnotice: () => {},
  // Riconoscibile in pg_stat_activity accanto alle connessioni delle route.
  connection: { application_name: 'caldes-api-calendar' },
});

/** Dimensione massima del pool calendario (CAL_DB_POOL_MAX, default 4). */
export const CAL_DB_POOL_MAX = intEnv('CAL_DB_POOL_MAX', 4);

/** Chiude il pool calendario attendendo le query in corso (shutdown, test). Idempotente. */
export async function closeCalendarPool(timeoutSeconds = 5): Promise<void> {
  await calSql.end({ timeout: timeoutSeconds });
}

/**
 * Valore per una colonna jsonb: oggetti, array e scalari vengono serializzati
 * una sola volta con tipo jsonb; null/undefined diventano SQL NULL.
 *
 * NON passare `JSON.stringify(x)` (nemmeno con `::jsonb`): postgres-js
 * ricodifica la stringa e la colonna riceve uno scalare stringa. Con
 * `col || ${JSON.stringify(obj)}::jsonb` il merge produce addirittura un
 * array [vecchio, "stringa"] e `col->>'chiave'` smette di funzionare.
 */
export const jsonb = (value: unknown): any =>
  value === null || value === undefined ? null : sql.json(value as Parameters<typeof sql.json>[0]);

// Helper to cast complex objects (Stripe/Google/external APIs) for sql() inserts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const sqlv = (obj: Record<string, unknown>): any => obj;

// Helper per la sintassi INSERT-shorthand di postgres-js 3.x:
//   sql`INSERT INTO foo ${sqlInsert({col1: val1, col2: val2})}`
// → genera `INSERT INTO foo (col1, col2) VALUES ($1, $2)`.
//
// Un raw object (es. `${sqlv(obj)}`) NON viene riconosciuto come "columns helper"
// e finisce trattato come singolo parametro `$1` → syntax error Postgres
// (incident 2026-05-29: createEvent crashava con "syntax error at or near \"$1\"").
// `sql(obj)` invocato come funzione (NON tagged template) produce il marker
// `is_insert` interno che il library espande nella forma corretta.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const sqlInsert = (obj: Record<string, unknown>): any => (sql as any)(obj);
