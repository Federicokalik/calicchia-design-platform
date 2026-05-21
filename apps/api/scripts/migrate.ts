/**
 * Migration runner for apps/api — ledger-based.
 *
 * Applied migrations are tracked in a `schema_migrations` table. Each run
 * applies only the SQL files not yet recorded, in order, then records them.
 * There is NO swallowing of "already exists" errors: a migration that fails
 * fails loudly and aborts the run.
 *
 * Apply order:
 *   1. apps/api/database/*.sql   — clean base schema (000_init, 001_schema)
 *   2. database/migrations/*.sql — numbered migrations (Supabase-only files skipped)
 *
 * Re-running is a no-op: files already in `schema_migrations` are skipped.
 * Adding a new numbered file and re-running applies only that file. This
 * replaces both the old `migrate.ts` (re-ran everything) and `migrate-new.ts`
 * (manual range arg) — one incremental runner now covers both (DB-08).
 *
 * Usage:  pnpm --filter @caldes/api migrate
 *
 * RLS NOTE (DB-07): Row Level Security is intentionally DISABLED on every
 * public table. Access control is enforced by the Hono auth middleware
 * (apps/api/src/middleware/auth.ts), not by Postgres RLS — the api connects
 * as a single trusted role and is the only layer that touches Postgres. The
 * legacy Supabase RLS policies that some historical migrations still create
 * are therefore inert. The runner disables RLS on all public tables at the
 * end of every run. See docs/database-rls.md.
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL not set');
  process.exit(1);
}

// max: 1 — some migration files contain their own BEGIN/COMMIT blocks, which
// postgres-js rejects on a pooled connection.
const sql = postgres(DATABASE_URL, { onnotice: () => {}, max: 1 });

// Supabase-specific files that are intentionally never applied.
const SKIP = new Set([
  '002_rls_policies.sql',     // pure RLS — disabled anyway (see RLS NOTE)
  '028_supabase_storage.sql', // Supabase storage bucket — not used
]);

interface MigrationFile {
  version: string; // ledger key — unique, stable
  path: string;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function collectFiles(): MigrationFile[] {
  const files: MigrationFile[] = [];

  // 1. Clean base schema (apps/api/database/) — keyed `base/<file>`.
  const baseDir = resolve(__dirname, '../database');
  for (const f of readdirSync(baseDir).filter((f) => f.endsWith('.sql')).sort()) {
    files.push({ version: `base/${f}`, path: join(baseDir, f) });
  }

  // 2. Numbered migrations (database/migrations/) — keyed by filename.
  const migDir = resolve(__dirname, '../../../database/migrations');
  if (existsSync(migDir)) {
    for (const f of readdirSync(migDir).filter((f) => f.endsWith('.sql') && !SKIP.has(f)).sort()) {
      files.push({ version: f, path: join(migDir, f) });
    }
  } else {
    console.warn('⚠️  database/migrations/ not found — applying base schema only');
  }
  return files;
}

async function main() {
  console.log('🗄️  Migration runner (ledger-based)\n');

  // Ledger table — created on first run, ahead of everything else.
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const ledger = new Map<string, string>(
    (await sql`SELECT version, checksum FROM schema_migrations`).map(
      (r) => [r.version as string, r.checksum as string],
    ),
  );

  const files = collectFiles();

  // Migrations are append-only: warn (don't fail) if an applied file changed.
  for (const f of files) {
    const recorded = ledger.get(f.version);
    if (recorded && recorded !== sha256(readFileSync(f.path, 'utf-8'))) {
      console.warn(`  ⚠️  ${f.version} changed since it was applied (checksum mismatch) — NOT re-running`);
    }
  }

  const pending = files.filter((f) => !ledger.has(f.version));

  if (!pending.length) {
    console.log(`✓ Up to date — all ${files.length} migrations already applied.`);
  } else {
    console.log(`Applying ${pending.length} new migration(s) — ${ledger.size} already applied:\n`);
    for (const f of pending) {
      const content = readFileSync(f.path, 'utf-8');
      const checksum = sha256(content);
      process.stdout.write(`  → ${f.version} ... `);
      try {
        // Append the ledger INSERT to the migration body and run as one simple
        // query. Postgres wraps a multi-statement simple query in a single
        // implicit transaction, so for files without their own BEGIN/COMMIT the
        // migration and its ledger row commit (or roll back) atomically.
        const body = content.trimEnd().replace(/;?\s*$/, ';');
        const ledgerInsert = `INSERT INTO schema_migrations (version, checksum) VALUES ('${f.version}', '${checksum}');`;
        await sql.unsafe(`${body}\n${ledgerInsert}`);
        console.log('✓');
      } catch (err) {
        const e = err as { code?: string; message?: string };
        console.log('✗');
        console.error(`\n❌ ${f.version} failed: ${e.code ?? ''} ${e.message ?? err}`);
        await sql.end();
        process.exit(1);
      }
    }
  }

  // RLS NOTE (DB-07): disable RLS on every public table — see header comment.
  console.log('\n🔓 Disabling RLS on all public tables (access control via Hono middleware)...');
  await sql.unsafe(`
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', r.tablename);
      END LOOP;
    END;
    $$;
  `);
  console.log('  ✓ RLS disabled');

  console.log('\n✅ Migration complete.');
  await sql.end();
}

main().catch(async (err) => {
  console.error('\n❌ Migration failed:', err instanceof Error ? err.message : err);
  try { await sql.end(); } catch { /* ignore */ }
  process.exit(1);
});
