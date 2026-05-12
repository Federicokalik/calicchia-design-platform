import { sql } from '../db';
import { sendTelegramMessage, isTelegramConfigured } from '../lib/telegram';

export async function runDailyDigest() {
  if (!isTelegramConfigured()) return;

  const today = new Date().toISOString().split('T')[0];

  const [bookings, dueTasks, newLeads, pendingQuotes, revenue, staleLeads] = await Promise.all([
    sql`SELECT COUNT(*)::int AS c FROM cal_bookings WHERE DATE(start_time) = ${today} AND status != 'cancelled'`,
    sql`SELECT COUNT(*)::int AS c FROM project_tasks WHERE DATE(due_date) = ${today} AND status != 'done'`,
    sql`SELECT COUNT(*)::int AS c FROM leads WHERE DATE(created_at) = ${today}`,
    sql`SELECT COUNT(*)::int AS c FROM quotes_v2 WHERE status IN ('sent', 'viewed')`,
    sql`SELECT COALESCE(SUM(amount), 0)::numeric AS t FROM payment_tracker WHERE status = 'emessa'`,
    sql`SELECT COUNT(*)::int AS c FROM leads WHERE status IN ('new','contacted','proposal','negotiation') AND updated_at < NOW() - INTERVAL '3 days'`,
  ]);

  const b = bookings[0]?.c || 0;
  const t = dueTasks[0]?.c || 0;
  const l = newLeads[0]?.c || 0;
  const q = pendingQuotes[0]?.c || 0;
  const r = parseFloat(revenue[0]?.t || '0');
  const s = staleLeads[0]?.c || 0;

  const text = `📊 <b>${today}</b>

${b} appuntamenti | ${t} task scadenza | ${l} nuovi lead
${q} preventivi in attesa | €${r.toLocaleString('it-IT')} da incassare
${s > 0 ? `⚠️ ${s} lead senza follow-up` : '✅ Lead ok'}`;

  await sendTelegramMessage(text, undefined, { parse_mode: 'HTML' });
}
