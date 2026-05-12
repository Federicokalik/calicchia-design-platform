/**
 * Esegue solo le migration nuove (range parametrizzato), saltando quelle storiche
 * già applicate. Le migration legacy (004_*.sql) usano ruoli Supabase (anon,
 * authenticated, service_role) non presenti in questo Postgres plain.
 *
 * Uso:
 *   tsx --env-file=../../.env scripts/migrate-new.ts 070 073
 */

import { readFileSync, readdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL not set');
  process.exit(1);
}

const fromArg = parseInt(process.argv[2] || '70', 10);
const toArg = parseInt(process.argv[3] || '999', 10);

const sql = postgres(DATABASE_URL, { onnotice: () => {} });

async function ensureSupabaseRolesExist() {
  // Le migration storiche usano ruoli Supabase (anon, authenticated, service_role).
  // In Postgres plain non esistono — li creiamo come placeholder NOLOGIN senza permessi.
  // Le policy RLS che li referenziano sono comunque inattive perché disabilitiamo RLS.
  const roles = ['anon', 'authenticated', 'service_role'];
  for (const role of roles) {
    try {
      await sql.unsafe(`CREATE ROLE ${role} NOLOGIN`);
      console.log(`  + Ruolo ${role} creato (placeholder)`);
    } catch (err: any) {
      if (err.code === '42710' || err.message?.includes('already exists')) {
        // già esiste
      } else {
        throw err;
      }
    }
  }
}

async function main() {
  console.log('🔐 Verifico ruoli Supabase placeholder:');
  await ensureSupabaseRolesExist();
  console.log();

  const dir = resolve(__dirname, '../../../database/migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => {
      const match = f.match(/^(\d+)_/);
      if (!match) return false;
      const n = parseInt(match[1], 10);
      return n >= fromArg && n <= toArg;
    })
    .sort();

  if (!files.length) {
    console.log(`⚠️  Nessuna migration nel range ${fromArg}-${toArg}`);
    await sql.end();
    return;
  }

  console.log(`🗄️  Eseguo ${files.length} migration (range ${fromArg}-${toArg}):\n`);

  for (const file of files) {
    const content = readFileSync(join(dir, file), 'utf-8');
    process.stdout.write(`  → ${file}... `);
    try {
      await sql.unsafe(content);
      console.log('✓');
    } catch (err: any) {
      // Idempotenza: ignora errori di "already exists"
      if (
        err.code === '42P07' || // duplicate_table
        err.code === '42P16' || // invalid_table_definition (duplicate trigger)
        err.code === '42710' || // duplicate_object (index/constraint)
        err.code === '42701' || // duplicate_column
        err.message?.includes('already exists')
      ) {
        console.log('~ (già applicata, skip)');
      } else {
        console.log(`✗ ${err.code || ''} ${err.message}`);
        throw err;
      }
    }
  }

  // Disabilita RLS sulle nuove tabelle (security via Hono middleware, come per le altre)
  console.log('\n🔓 Disabilito RLS sulle tabelle calendars/calendar_events:');
  for (const tbl of ['calendars', 'calendar_events']) {
    try {
      await sql.unsafe(`ALTER TABLE ${tbl} DISABLE ROW LEVEL SECURITY`);
      console.log(`  ✓ ${tbl}`);
    } catch (err: any) {
      console.log(`  ~ ${tbl}: ${err.message}`);
    }
  }

  console.log('\n✅ Done');
  await sql.end();
}

main().catch((err) => {
  console.error('\n❌ Failed:', err.message);
  process.exit(1);
});
