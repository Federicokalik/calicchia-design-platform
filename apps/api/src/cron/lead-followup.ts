import { sql } from '../db';
import { notifyTelegram } from '../lib/telegram';

/**
 * Check leads without activity for 3+ days and notify via Telegram
 */
export async function runLeadFollowup() {
  const staleLeads = await sql`
    SELECT name, email, company, status, estimated_value, created_at, updated_at
    FROM leads
    WHERE status IN ('new', 'contacted', 'proposal', 'negotiation')
      AND updated_at < NOW() - INTERVAL '3 days'
    ORDER BY estimated_value DESC NULLS LAST
  `;

  if (staleLeads.length === 0) return;

  const lines = staleLeads.map((l) => {
    const days = Math.floor((Date.now() - new Date(l.updated_at).getTime()) / (1000 * 60 * 60 * 24));
    const value = l.estimated_value ? ` — €${parseFloat(l.estimated_value).toLocaleString('it-IT')}` : '';
    return `• ${l.name}${value} (${l.status}, ${days}gg fa)`;
  }).join('\n');

  await notifyTelegram(
    `📋 ${staleLeads.length} lead senza follow-up`,
    `Lead inattivi da 3+ giorni:\n${lines}`
  );
}
