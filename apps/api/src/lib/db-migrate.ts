/**
 * Ledger-based migration runner — shared by the CLI (scripts/migrate.ts) and
 * the api boot sequence (src/index.ts, AUTO_MIGRATE).
 *
 * Incident 2026-07-16/17: the one-off `migrate` compose service is only
 * re-run when the orchestrator recreates its container — a deploy that skips
 * it leaves the running code AHEAD of its schema ("column does not exist" at
 * runtime). Running the same ledger check in-process at boot guarantees the
 * api serving traffic is the code that migrated the schema.
 *
 * Semantics (unchanged from the original scripts/migrate.ts):
 *   - Applied migrations tracked in `schema_migrations`; re-run is a no-op.
 *   - Apply order: apps/api/database/*.sql (base, keyed `base/<file>`) then
 *     database/migrations/*.sql (numbered). Supabase-only files skipped.
 *   - NO swallowing of "already exists": a failing migration throws and the
 *     caller decides (CLI: exit 1; boot: refuse to start).
 *   - RLS NOTE (DB-07): RLS is intentionally DISABLED on every public table —
 *     access control lives in the Hono auth middleware. The runner disables
 *     RLS on all public tables at the end of every run. See docs/database-rls.md.
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Supabase-specific files that are intentionally never applied.
const SKIP = new Set([
  '002_rls_policies.sql',     // pure RLS — disabled anyway (see RLS NOTE)
  '028_supabase_storage.sql', // Supabase storage bucket — not used
]);

// Advisory lock so two instances (rolling deploy) never apply concurrently.
// Arbitrary but stable app-wide key.
const MIGRATE_LOCK_KEY = 72019;

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
  //    src/lib/ → ../../database = apps/api/database (same layout in the
  //    container image: /app/apps/api/src/lib → /app/apps/api/database).
  const baseDir = resolve(__dirname, '../../database');
  for (const f of readdirSync(baseDir).filter((f) => f.endsWith('.sql')).sort()) {
    files.push({ version: `base/${f}`, path: join(baseDir, f) });
  }

  // 2. Numbered migrations (<repo>/database/migrations/) — keyed by filename.
  const migDir = resolve(__dirname, '../../../../database/migrations');
  if (existsSync(migDir)) {
    for (const f of readdirSync(migDir).filter((f) => f.endsWith('.sql') && !SKIP.has(f)).sort()) {
      files.push({ version: f, path: join(migDir, f) });
    }
  } else {
    console.warn('⚠️  database/migrations/ not found — applying base schema only');
  }
  return files;
}

/**
 * Apply all pending migrations. Throws on the first failing migration (the
 * ledger row commits atomically with each file, so a retry resumes from the
 * failed one). Returns how many files were applied this run.
 */
export async function runPendingMigrations(): Promise<{ applied: number; total: number }> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');

  // max: 1 — some migration files contain their own BEGIN/COMMIT blocks, which
  // postgres-js rejects on a pooled connection. Single session also makes the
  // advisory lock behave (lock and unlock on the same backend).
  const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {}, max: 1 });

  try {
    await sql`SELECT pg_advisory_lock(${MIGRATE_LOCK_KEY})`;

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
        console.log('✗');
        const e = err as { code?: string; message?: string };
        throw new Error(`migration ${f.version} failed: ${e.code ?? ''} ${e.message ?? String(err)}`);
      }
    }

    // RLS NOTE (DB-07): disable RLS on every public table — see header comment.
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

    return { applied: pending.length, total: files.length };
  } finally {
    // Session close releases the advisory lock even on error paths.
    await sql.end().catch(() => {});
  }
}
