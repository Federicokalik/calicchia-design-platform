/**
 * One-shot backfill: bcrypt-hash all existing customers.portal_access_code
 * into customers.portal_access_code_hash. Idempotent — skip already-hashed.
 *
 * Run AFTER migration 079.
 */
import postgres from 'postgres';
import bcrypt from 'bcrypt';

const BCRYPT_ROUNDS = 12;

const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });

async function main() {
  const rows = (await sql`
    SELECT id, email, portal_access_code
    FROM customers
    WHERE portal_access_code IS NOT NULL
      AND portal_access_code != ''
      AND portal_access_code_hash IS NULL
  `) as Array<{ id: string; email: string; portal_access_code: string }>;

  console.log(`Found ${rows.length} customers to backfill.`);
  if (rows.length === 0) {
    await sql.end();
    return;
  }

  let ok = 0;
  for (const r of rows) {
    const hash = await bcrypt.hash(r.portal_access_code, BCRYPT_ROUNDS);
    await sql`
      UPDATE customers
      SET portal_access_code_hash = ${hash},
          portal_access_code_rotated_at = COALESCE(portal_access_code_rotated_at, NOW())
      WHERE id = ${r.id}
    `;
    ok++;
    console.log(`  ✓ ${r.email}`);
  }

  console.log(`\nDone. Hashed ${ok}/${rows.length} customers.`);
  await sql.end();
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
