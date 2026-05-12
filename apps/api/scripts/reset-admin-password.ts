/**
 * Reset password for an existing admin user.
 * Usage:
 *   ADMIN_EMAIL=you@example.com NEW_PASSWORD=your-new-pass \
 *     pnpm --filter @caldes/api exec tsx --env-file=../../.env scripts/reset-admin-password.ts
 *
 * Exits non-zero if:
 *   - ADMIN_EMAIL or NEW_PASSWORD missing
 *   - NEW_PASSWORD shorter than 8 chars
 *   - No user found with that email
 *   - User is not an admin
 */
import bcrypt from 'bcrypt';
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const NEW_PASSWORD = process.env.NEW_PASSWORD;

if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}
if (!ADMIN_EMAIL || !NEW_PASSWORD) {
  console.error('ADMIN_EMAIL and NEW_PASSWORD required');
  process.exit(1);
}
if (NEW_PASSWORD.length < 8) {
  console.error('NEW_PASSWORD must be at least 8 chars');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { onnotice: () => {} });

async function main() {
  const email = ADMIN_EMAIL!.toLowerCase().trim();

  const rows = await sql`SELECT id, role FROM users WHERE email = ${email} LIMIT 1`;
  if (rows.length === 0) {
    console.log('\nNo user found for that email. Existing admins:');
    const admins = await sql`SELECT email FROM users WHERE role = 'admin' ORDER BY email`;
    admins.forEach((a) => console.log('  -', a.email));
    await sql.end();
    process.exit(2);
  }

  const user = rows[0];
  if (user.role !== 'admin') {
    console.error(`User ${email} exists but is not admin (role=${user.role})`);
    await sql.end();
    process.exit(3);
  }

  const password_hash = await bcrypt.hash(NEW_PASSWORD!, 12);
  const result = await sql`UPDATE users SET password_hash = ${password_hash} WHERE id = ${user.id}`;

  console.log(`Password updated for ${email} (${result.count} row)`);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
