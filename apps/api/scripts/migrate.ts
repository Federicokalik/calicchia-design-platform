/**
 * CLI wrapper for the migration runner.
 *
 * Usage:  pnpm --filter @calicchia/api migrate
 *
 * The actual logic (ledger, apply order, RLS pass) lives in
 * src/lib/db-migrate.ts, shared with the api boot sequence (AUTO_MIGRATE in
 * src/index.ts) so the schema can never lag behind deployed code. This script
 * remains for manual runs and the one-off `migrate` compose service.
 */
import { runPendingMigrations } from '../src/lib/db-migrate';

console.log('🗄️  Migration runner (ledger-based)\n');

runPendingMigrations()
  .then(({ applied, total }) => {
    if (applied === 0) {
      console.log(`✓ Up to date — all ${total} migrations already applied.`);
    } else {
      console.log(`\n✅ Migration complete — ${applied} of ${total} file(s) applied this run.`);
    }
    process.exit(0);
  })
  .catch((err) => {
    // postgres-js connection failures are AggregateErrors with an empty
    // message — fall back to code/cause so the log is never blank.
    const e = err as { message?: string; code?: string };
    console.error('\n❌ Migration failed:', e.message || e.code || String(err));
    process.exit(1);
  });
