/**
 * Re-run the classifier on all stored email messages.
 * Usage: pnpm --filter @caldes/api exec tsx --env-file=../../.env scripts/reclassify-mail.ts
 */
import postgres from 'postgres';
import { classifyMail } from '../src/lib/mail/classifier';

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
  const rows = await sql<Array<{ id: string; from_addr: string | null; subject: string | null; flags: string[] }>>`
    SELECT id, from_addr, subject, flags FROM email_messages
  `;
  let changed = 0;
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const cat = classifyMail({ fromAddr: r.from_addr, subject: r.subject, flags: r.flags });
    counts[cat] = (counts[cat] || 0) + 1;
    const res = await sql`UPDATE email_messages SET category = ${cat} WHERE id = ${r.id} AND category <> ${cat} RETURNING id`;
    if (res.length > 0) changed++;
  }
  console.log(`Scanned: ${rows.length}, Updated: ${changed}`);
  console.log('Distribution:', counts);
  await sql.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
