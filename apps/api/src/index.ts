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

// JWT_SECRET length floor — same key signs HS256 JWTs, HMACs booking-cancel
// tokens (lib/calendar/token.ts), HMACs private-file URLs (lib/private-files.ts)
// and keys the OTP hashes (lib/signing). HMAC-SHA256 with a <32-byte key drops
// well below the algorithm's security margin. Fail fast in any mode — letting a
// dev secret like "changeme" through has been the root cause of two prior
// near-incidents (audit E-003). Set BOOKING_TOKEN_SECRET +
// PRIVATE_FILE_SIGNING_SECRET when you want to rotate per-purpose.
if ((process.env.JWT_SECRET ?? '').length < 32) {
  console.error('FATAL: JWT_SECRET must be at least 32 characters (HMAC-SHA256 key floor).');
  process.exit(1);
}

// MAIL_ENC_KEY is not strictly required (mail-sync silently skips and so does
// the admin mailbox UI), but a non-development deploy without it means the
// inbox feature is silently dead. Warn at boot so it's visible (audit E-012).
if (process.env.NODE_ENV !== 'development' && !process.env.MAIL_ENC_KEY) {
  console.warn('⚠️  MAIL_ENC_KEY not set — mail-sync cron will skip and the admin mailbox UI will fail at every account open. Run scripts/generate-mail-enc-key.ts and add to .env if mail features are needed.');
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

// Validate AI knowledge bases are present and well-formed. Soft-fail by design:
// the container starts anyway and the admin gets a banner + "Import from S4"
// + "Upload .md" in /impostazioni/knowledge-base. Per-request, the AI quote
// generator throws a clear error when called without valid KBs.
try {
  assertKBsValid();
  console.log('✅ AI knowledge bases validated');
} catch (err) {
  console.warn(`⚠️  AI knowledge base validation failed: ${(err as Error).message}`);
  console.warn('   AI quote generation will be unavailable until KBs are loaded.');
  console.warn('   Use admin → Impostazioni → Knowledge Base to import from S4 or upload manually.');
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
