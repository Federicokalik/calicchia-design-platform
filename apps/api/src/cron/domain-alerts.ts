import { sql } from '../db';
import { sendTelegramMessage, isTelegramConfigured } from '../lib/telegram';
import { fireEvent, WORKFLOW_EVENTS } from '../lib/workflow/triggers';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'domain-alerts' });

// Milestone di anticipo (giorni). Per ogni dominio in scadenza, il cron
// emette un fireEvent('dominio_scadenza', ...) la prima volta che entra
// in una di queste finestre, poi lo memorizza in domains.last_alert_milestone
// per non emetterlo di nuovo.
const MILESTONES = [30, 14, 7, 1] as const;

interface ExpiringDomain {
  domain_id: string;
  domain_name: string;
  tld: string;
  full_domain: string;
  expiration_date: string;
  auto_renew: boolean;
  last_alert_milestone: number | null;
  customer_id: string | null;
  customer_name: string | null;
  company_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
}

/**
 * Cron domain-alerts:
 *   1. Per ogni dominio cliente in scadenza entro 30 giorni che e' entrato in
 *      una nuova milestone (30/14/7/1), emette `fireEvent('dominio_scadenza')`.
 *      I workflow attivi che ascoltano questo evento si scatenano (es. invia
 *      WhatsApp + email al cliente, notifica Telegram all'admin).
 *   2. Aggiorna `domains.last_alert_milestone` per dedup.
 *   3. Manda comunque un riepilogo Telegram per l'admin con la lista dei
 *      domini in scadenza (digest interno, indipendente dai workflow).
 */
export async function runDomainAlerts() {
  const expiring = (await sql`
    SELECT
      d.id            AS domain_id,
      d.domain_name,
      d.tld,
      d.full_domain,
      d.expiration_date,
      d.auto_renew,
      d.last_alert_milestone,
      c.id            AS customer_id,
      c.contact_name  AS customer_name,
      c.company_name,
      c.email         AS customer_email,
      c.phone         AS customer_phone
    FROM domains d
    LEFT JOIN customers c ON c.id = d.customer_id
    WHERE d.expiration_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
    ORDER BY d.expiration_date ASC
  `) as ExpiringDomain[];

  if (expiring.length === 0) return;

  let firedCount = 0;
  for (const d of expiring) {
    const days = Math.ceil(
      (new Date(d.expiration_date).getTime() - Date.now()) / 86400000,
    );
    if (days < 0) continue; // gia' scaduto, non emettere nuovi alert

    // Trova la milestone piu' piccola tra quelle in cui il dominio e'
    // entrato (days <= milestone) e che NON e' gia' stata notificata
    // (last_alert_milestone === null o > milestone).
    const milestone = MILESTONES.find(
      (m) => days <= m && (d.last_alert_milestone === null || d.last_alert_milestone > m),
    );
    if (!milestone) continue;

    try {
      await fireEvent(WORKFLOW_EVENTS.DOMINIO_SCADENZA, {
        domain_id: d.domain_id,
        domain_name: d.full_domain,
        expiration_date: d.expiration_date,
        days_remaining: days,
        milestone,
        auto_renew: d.auto_renew,
        customer_id: d.customer_id,
        customer_name: d.customer_name || d.company_name,
        customer_company: d.company_name,
        customer_email: d.customer_email,
        customer_phone: d.customer_phone,
      });
      await sql`UPDATE domains SET last_alert_milestone = ${milestone} WHERE id = ${d.domain_id}`;
      firedCount++;
    } catch (err) {
      log.error({ err, domain: d.full_domain }, 'fireEvent dominio_scadenza failed');
    }
  }

  // Riepilogo Telegram (digest interno per admin, sempre inviato finche'
  // Telegram e' configurato; indipendente dai workflow).
  if (isTelegramConfigured()) {
    const lines = expiring
      .map((d) => {
        const days = Math.ceil(
          (new Date(d.expiration_date).getTime() - Date.now()) / 86400000,
        );
        return `${days <= 7 ? '🚨' : '🌐'} ${d.full_domain} — ${days}gg ${d.auto_renew ? '(auto)' : '⚠️ MANUALE'}`;
      })
      .join('\n');
    await sendTelegramMessage(
      `🌐 <b>Domini in scadenza</b>\n\n${lines}` +
        (firedCount ? `\n\n<i>${firedCount} workflow attivati</i>` : ''),
      undefined,
      { parse_mode: 'HTML' },
    );
  }
}
