/**
 * One-shot backfill: bcrypt-hash existing plaintext portal_access_code values.
 * Idempotent: rows with portal_access_code_hash already set are skipped.
 *
 * Run after migration 082 and before migration 083.
 */
import bcrypt from 'bcrypt';
import { sql } from '../src/db';

const BCRYPT_ROUNDS = 12;

type PortalCodeRow = {
  table_name: 'customers' | 'collaborators';
  id: string;
  email: string;
  portal_access_code: string;
};

async function fetchRows(): Promise<PortalCodeRow[]> {
  const customers = (await sql`
    SELECT 'customers' AS table_name, id, email, portal_access_code
    FROM customers
    WHERE portal_access_code IS NOT NULL
      AND portal_access_code != ''
      AND portal_access_code_hash IS NULL
  `) as PortalCodeRow[];

  const collaborators = (await sql`
    SELECT 'collaborators' AS table_name, id, email, portal_access_code
    FROM collaborators
    WHERE portal_access_code IS NOT NULL
      AND portal_access_code != ''
      AND portal_access_code_hash IS NULL
  `) as PortalCodeRow[];

  return [...customers, ...collaborators];
}

async function main() {
  const rows = await fetchRows();
  console.log(`Found ${rows.length} portal codes to backfill.`);

  let ok = 0;
  for (const row of rows) {
    const hash = await bcrypt.hash(row.portal_access_code, BCRYPT_ROUNDS);
    if (row.table_name === 'customers') {
      await sql`
        UPDATE customers
        SET portal_access_code_hash = ${hash},
            portal_access_code_rotated_at = COALESCE(portal_access_code_rotated_at, NOW())
        WHERE id = ${row.id}
          AND portal_access_code_hash IS NULL
      `;
    } else {
      await sql`
        UPDATE collaborators
        SET portal_access_code_hash = ${hash}
        WHERE id = ${row.id}
          AND portal_access_code_hash IS NULL
      `;
    }
    ok++;
    console.log(`  hashed ${row.table_name}:${row.email}`);
  }

  console.log(`Done. Hashed ${ok}/${rows.length} portal codes.`);
}

main()
  .catch((err) => {
    console.error('Fatal:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end();
  });
