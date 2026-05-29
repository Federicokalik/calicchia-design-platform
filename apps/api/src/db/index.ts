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
