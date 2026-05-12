/**
 * Seed script: creates the initial admin user.
 * Run ONCE after `pnpm migrate`:
 *   ADMIN_EMAIL=me@example.com ADMIN_PASSWORD=secret pnpm seed
 * Or set them in .env — the script reads from process.env.
 */
import bcrypt from 'bcrypt';
import postgres from 'postgres';
import { randomUUID } from 'crypto';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL not set');
  process.exit(1);
}

const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_NAME = process.env.ADMIN_NAME || 'Admin';

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('❌ ADMIN_EMAIL and ADMIN_PASSWORD are required');
  console.error('   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=secret pnpm seed');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { onnotice: () => {} });

async function main() {
  console.log('🌱 Seeding admin user...\n');

  const email = ADMIN_EMAIL!.toLowerCase().trim();

  // Check if user already exists
  const existing = await sql`SELECT id FROM users WHERE email = ${email} LIMIT 1`;
  if (existing.length > 0) {
    console.log(`⚠️  User ${email} already exists — skipping.`);
    await sql.end();
    return;
  }

  const id = randomUUID();
  const password_hash = await bcrypt.hash(ADMIN_PASSWORD!, 12);

  // Insert into users table
  await sql`
    INSERT INTO users (id, email, password_hash, full_name, role)
    VALUES (${id}, ${email}, ${password_hash}, ${ADMIN_NAME}, 'admin')
  `;

  // Insert matching profile
  await sql`
    INSERT INTO profiles (id, email, full_name, role)
    VALUES (${id}, ${email}, ${ADMIN_NAME}, 'admin')
    ON CONFLICT (id) DO NOTHING
  `;

  console.log(`✅ Admin user created:`);
  console.log(`   Email: ${email}`);
  console.log(`   Name:  ${ADMIN_NAME}`);
  console.log(`   Role:  admin`);

  await sql.end();
}

main().catch((err) => {
  console.error('\n❌ Seed failed:', err.message);
  process.exit(1);
});
