import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

// Load root monorepo .env (single source of truth)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../../../.env') });

// NOTE (BK-14): boot/shutdown messages below intentionally stay on console.*.
// They run outside the request lifecycle and several are immediately followed
// by process.exit(), where pino's async transport could truncate the write.
// console.* is synchronous and guaranteed to flush — exactly what fail-fast
// boot diagnostics need. The structured logger covers the running server.

// Validate required environment variables before starting.
// WEBHOOK_ENCRYPTION_KEY: needed for envelope-encrypting stored webhook secrets;
// without it the server used to boot and crash at the first webhook event —
// fail fast here instead (finding BK-07).
const REQUIRED_ENV = ['JWT_SECRET', 'DATABASE_URL', 'WEBHOOK_ENCRYPTION_KEY'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`FATAL: Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// Fetch the gitignored AI knowledge bases from object storage (MEGA S4) BEFORE
// any module that reads them is loaded. The dynamic imports below guarantee
// that lib/agent (which reads the pricing KB at module load) is evaluated only
// after bootstrapKBs() has placed the files. No-op in local dev (S4_* unset).
const { bootstrapKBs } = await import('./lib/agent/kb-bootstrap');
await bootstrapKBs();

const { serve } = await import('@hono/node-server');
const { app } = await import('./app');
const { startCronEngine, stopCronEngine } = await import('./cron');
const { assertKBsValid } = await import('./lib/quotes/generate');
const { sql } = await import('./db');

// Validate AI knowledge bases are present and well-formed (fail-fast).
// Without these files the AI quote generator cannot run; refusing to start
// here is better than failing silently per-request or, worse, falling back
// to a stale or hardcoded price list.
try {
  assertKBsValid();
} catch (err) {
  console.error(`FATAL: AI knowledge base validation failed: ${(err as Error).message}`);
  console.error('Hint: copy *.example.md templates from apps/api/src/lib/agent/ to *_knowledge_base.md and fill with real data, or configure S4_* to deliver them from the bucket.');
  process.exit(1);
}

const port = parseInt(process.env.PORT || '3001');

console.log(`🚀 API server starting on port ${port}`);

const server = serve({
  fetch: app.fetch,
  port,
});

// Start cron jobs
startCronEngine();

console.log(`✅ API server running at http://localhost:${port}`);

// Graceful shutdown
function shutdown(signal: string) {
  console.log(`\n${signal} received — shutting down gracefully...`);
  stopCronEngine();
  server.close(async () => {
    // Drain the Postgres pool so in-flight queries finish before exit (DBX-01).
    await sql.end({ timeout: 5 }).catch(() => {});
    console.log('Server closed.');
    process.exit(0);
  });
  // Force exit after 10s if shutdown hangs
  setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
