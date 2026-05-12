import { sql } from '../db';
import { sendTelegramMessage, isTelegramConfigured } from '../lib/telegram';

export async function runDomainAlerts() {
  if (!isTelegramConfigured()) return;

  const expiring = await sql`
    SELECT d.domain_name || '.' || d.tld AS dominio, d.expiration_date, d.auto_renew
    FROM domains d
    WHERE d.expiration_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
    ORDER BY d.expiration_date ASC
  `;

  if (expiring.length === 0) return;

  const lines = expiring.map((d) => {
    const days = Math.ceil((new Date(d.expiration_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    return `${days <= 7 ? '🚨' : '🌐'} ${d.dominio} — ${days}gg ${d.auto_renew ? '(auto)' : '⚠️ MANUALE'}`;
  }).join('\n');

  await sendTelegramMessage(`🌐 <b>Domini in scadenza</b>\n\n${lines}`, undefined, { parse_mode: 'HTML' });
}
