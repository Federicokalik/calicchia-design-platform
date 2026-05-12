/**
 * Migration runner for apps/api
 * Runs SQL files in order:
 *   1. apps/api/database/*.sql (custom clean files: 000_init, 001_schema)
 *   2. database/migrations/003_*.sql ... 027_*.sql (original, skipping 002 and 028)
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL not set');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { onnotice: () => {} });

// Skip these original migration files (replaced or Supabase-specific)
const SKIP_ORIGINALS = new Set([
  '002_rls_policies.sql',  // pure RLS - no longer needed
  '028_supabase_storage.sql', // Supabase storage bucket
]);

async function runFile(filePath: string, label: string) {
  const content = readFileSync(filePath, 'utf-8');
  console.log(`  → Running ${label}...`);
  try {
    await sql.unsafe(content);
    console.log(`  ✓ ${label}`);
  } catch (err: any) {
    // Ignore "already exists" type errors for idempotency
    if (
      err.code === '42P07' || // duplicate_table
      err.code === '42P16' || // invalid_table_definition (duplicate trigger)
      err.code === '42710' || // duplicate_object (index/constraint)
      err.message?.includes('already exists')
    ) {
      console.log(`  ~ ${label} (already applied, skipping)`);
    } else {
      console.error(`  ✗ ${label}: ${err.message}`);
      throw err;
    }
  }
}

async function main() {
  console.log('🗄️  Starting migration...\n');

  // 1. Run custom clean files
  const apiDbDir = resolve(__dirname, '../database');
  const apiFiles = readdirSync(apiDbDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  console.log('📁 Custom migrations (apps/api/database/):');
  for (const file of apiFiles) {
    await runFile(join(apiDbDir, file), file);
  }

  // 2. Run original migrations (003-027, skipping 002 and 028)
  const originalDir = resolve(__dirname, '../../../database/migrations');
  if (!existsSync(originalDir)) {
    console.log('\n⚠️  No database/migrations/ directory found, skipping original migrations');
  } else {
    const originalFiles = readdirSync(originalDir)
      .filter(f => f.endsWith('.sql') && !SKIP_ORIGINALS.has(f))
      .sort();

    console.log('\n📁 Original migrations (database/migrations/):');
    for (const file of originalFiles) {
      await runFile(join(originalDir, file), file);
    }
  }

  // Disable RLS on all public tables — security is handled by Hono middleware
  console.log('\n🔓 Disabling RLS on all public tables...');
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

  console.log('\n✅ Migration complete!');
  await sql.end();
}

main().catch((err) => {
  console.error('\n❌ Migration failed:', err.message);
  process.exit(1);
});
