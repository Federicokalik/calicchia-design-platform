import { sql } from '../db';
import { sendTelegramMessage, isTelegramConfigured } from '../lib/telegram';

export async function runBrainAnalysis() {
  if (!isTelegramConfigured()) return;

  const lines: string[] = [];

  // 1. Stale leads
  const [stale] = await sql`SELECT COUNT(*)::int AS c FROM leads WHERE status IN ('new','contacted','proposal','negotiation') AND updated_at < NOW() - INTERVAL '5 days'`;
  if (stale?.c > 0) lines.push(`📋 ${stale.c} lead fermi 5+gg`);

  // 2. Projects at risk
  const [risky] = await sql`SELECT COUNT(*)::int AS c FROM client_projects WHERE status = 'in_progress' AND target_end_date < NOW() + INTERVAL '7 days' AND progress_percentage < 80`;
  if (risky?.c > 0) lines.push(`⚠️ ${risky.c} progetti a rischio`);

  // 3. Unseen quotes
  const [unseen] = await sql`SELECT COUNT(*)::int AS c FROM quotes_v2 WHERE status = 'sent' AND sent_at < NOW() - INTERVAL '3 days'`;
  if (unseen?.c > 0) lines.push(`📄 ${unseen.c} preventivi non aperti`);

  // 4. Revenue
  const [rev] = await sql`SELECT COALESCE(SUM(amount),0)::numeric AS t FROM payment_tracker WHERE status='pagata' AND DATE_TRUNC('month',paid_date)=DATE_TRUNC('month',CURRENT_DATE)`;
  const [avg] = await sql`SELECT COALESCE(AVG(mt),0)::numeric AS a FROM (SELECT SUM(amount) AS mt FROM payment_tracker WHERE status='pagata' AND paid_date > NOW()-INTERVAL '6 months' GROUP BY DATE_TRUNC('month',paid_date)) sub`;
  const r = parseFloat(rev?.t || '0');
  const a = parseFloat(avg?.a || '0');
  if (a > 0 && r < a * 0.7) lines.push(`📉 Revenue €${r.toFixed(0)} vs media €${a.toFixed(0)}`);

  // 5. Domains
  const [domains] = await sql`SELECT COUNT(*)::int AS c FROM domains WHERE expiration_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'`;
  if (domains?.c > 0) lines.push(`🌐 ${domains.c} domini scadono entro 30gg`);

  if (lines.length === 0) return;

  const text = `🧠 <b>Report</b>\n\n${lines.join('\n')}`;
  await sendTelegramMessage(text, undefined, { parse_mode: 'HTML' });
}
