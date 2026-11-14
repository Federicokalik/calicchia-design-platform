import { Hono } from 'hono';
import { sql } from '../db';
import { sendDomainExpiringEmail } from '../lib/email';
import { verifyCronSecret } from '../lib/cron-auth';
import { logger } from '../lib/logger';
import { billingRecipients } from '../lib/customer-recipients';

const log = logger.child({ scope: 'domain-cron' });

export const domainCron = new Hono();

interface ExpiringDomain {
  id: string;
  full_domain: string;
  expiration_date: string;
  days_until_expiration: number;
  urgency_level: string;
  customer_id: string;
  customer_email: string | null;
  billing_emails: string[] | null;
  contact_name: string;
  company_name: string | null;
}

function getAlertType(days: number): string {
  if (days <= 0) return 'expired';
  if (days <= 1) return 'expiring_1_day';
  if (days <= 3) return 'expiring_3_days';
  if (days <= 7) return 'expiring_7_days';
  if (days <= 14) return 'expiring_14_days';
  return 'expiring_30_days';
}

export async function checkAndSendReminders(): Promise<{
  sent: number;
  skipped: number;
  errors: string[];
}> {
  const result = { sent: 0, skipped: 0, errors: [] as string[] };

  // billing_emails: destinatari amministrativi del cliente (vuoto = email).
  // Domini con una proforma di rinnovo già inviata e non pagata: il cliente
  // ha già la richiesta di pagamento, niente promemoria generico in più.
  const expiringDomains = await sql`
    SELECT ed.*, c.billing_emails
    FROM expiring_domains ed
    JOIN customers c ON c.id = ed.customer_id
    WHERE ed.urgency_level IN ('expired', 'critical', 'warning', 'upcoming')
      AND NOT EXISTS (SELECT 1 FROM proformas p WHERE p.domain_id = ed.id AND p.status = 'sent')
  ` as ExpiringDomain[];

  if (!expiringDomains.length) return result;

  const domainIds = expiringDomains.map((d) => d.id);
  const existingAlerts = await sql`
    SELECT domain_id, alert_type FROM domain_alerts WHERE domain_id = ANY(${domainIds})
  `;

  const alertSet = new Set(existingAlerts.map((a) => `${a.domain_id}:${a.alert_type}`));

  const domainsToAlert: (ExpiringDomain & { alertType: string })[] = [];
  for (const domain of expiringDomains) {
    const alertType = getAlertType(domain.days_until_expiration);
    if (!alertSet.has(`${domain.id}:${alertType}`)) {
      domainsToAlert.push({ ...domain, alertType });
    } else {
      result.skipped++;
    }
  }

  if (!domainsToAlert.length) return result;

  const byCustomer = new Map<string, (ExpiringDomain & { alertType: string })[]>();
  for (const domain of domainsToAlert) {
    const existing = byCustomer.get(domain.customer_id) || [];
    existing.push(domain);
    byCustomer.set(domain.customer_id, existing);
  }

  const contactUrl = process.env.SITE_URL
    ? `${process.env.SITE_URL}/contatti`
    : 'https://calicchia.design/contatti';

  for (const [, domains] of byCustomer) {
    const first = domains[0];
    const customerName = first.company_name || first.contact_name;
    const recipients = billingRecipients({ email: first.customer_email, billing_emails: first.billing_emails });
    if (!recipients.length) {
      result.errors.push(`${customerName}: nessun indirizzo email (né billing_emails né email)`);
      continue;
    }
    const sentTo = recipients.join(', ');

    const emailResult = await sendDomainExpiringEmail({
      to: recipients,
      customerName,
      domains: domains.map((d) => ({
        name: d.full_domain,
        expirationDate: new Date(d.expiration_date).toLocaleDateString('it-IT'),
        daysUntilExpiry: d.days_until_expiration,
      })),
      renewUrl: contactUrl,
    });

    if (emailResult.success) {
      result.sent++;

      const alertRecords = domains.map((d) => ({
        domain_id: d.id,
        alert_type: d.alertType,
        sent_via: 'email',
        sent_to: sentTo,
        metadata: { message_id: emailResult.messageId },
      }));

      await sql`INSERT INTO domain_alerts ${sql(alertRecords)}`;
      await sql`
        UPDATE domains SET alert_sent_at = NOW()
        WHERE id = ANY(${domains.map((d) => d.id)})
      `;

      // Notifica interna best-effort: un errore qui (prima: FK legacy verso
      // auth.users, migrazione 159) non deve interrompere il ciclo e lasciare
      // senza promemoria i clienti successivi.
      try {
        const adminRows = await sql`SELECT id FROM profiles WHERE role = 'admin' LIMIT 1`;
        if (adminRows.length) {
          const domainList = domains.map((d) => d.full_domain).join(', ');
          await sql`
            INSERT INTO notifications ${sql({
              user_id: adminRows[0].id,
              type: 'domain_expiring',
              title: `Reminder inviato a ${customerName}`,
              message: `Email scadenza domini inviata per: ${domainList}`,
              action_url: '/domini',
            })}
          `;
        }
      } catch (err) {
        log.warn({ err, customerName }, 'domain-cron: notifica interna non registrata');
      }
    } else {
      result.errors.push(`${customerName} (${sentTo}): ${emailResult.error}`);
    }
  }

  return result;
}

domainCron.post('/check-expiring', async (c) => {
  // Header-only: query strings leak into nginx access logs, referer headers,
  // browser history, and downstream proxies.
  const secret = c.req.header('x-cron-secret');
  if (!verifyCronSecret(secret)) {
    return c.json({ error: 'Non autorizzato' }, 401);
  }

  try {
    const result = await checkAndSendReminders();
    return c.json(result);
  } catch (error) {
    log.error({ err: error }, 'check-expiring failed');
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});
