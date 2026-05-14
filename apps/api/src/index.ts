import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

// Load root monorepo .env (single source of truth)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../../../.env') });

// Validate required environment variables before starting
const REQUIRED_ENV = ['JWT_SECRET', 'DATABASE_URL'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`FATAL: Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

import { serve } from '@hono/node-server';
import { app } from './app';
import { startCronEngine, stopCronEngine } from './cron';
import { assertKBsValid } from './lib/quotes/generate';

// Validate AI knowledge bases are present and well-formed (fail-fast).
// Without these files the AI quote generator cannot run; refusing to start
// here is better than failing silently per-request or, worse, falling back
// to a stale or hardcoded price list.
try {
  assertKBsValid();
} catch (err) {
  console.error(`FATAL: AI knowledge base validation failed: ${(err as Error).message}`);
  console.error('Hint: copy *.example.md templates from apps/api/src/lib/agent/ to *_knowledge_base.md and fill with real data.');
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
  server.close(() => {
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
