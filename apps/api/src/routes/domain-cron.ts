import { Hono } from 'hono';
import { sql } from '../db';
import { sendDomainExpiringEmail } from '../lib/email';

export const domainCron = new Hono();

interface ExpiringDomain {
  id: string;
  full_domain: string;
  expiration_date: string;
  days_until_expiration: number;
  urgency_level: string;
  customer_id: string;
  customer_email: string;
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

  const expiringDomains = await sql`
    SELECT * FROM expiring_domains
    WHERE urgency_level IN ('expired', 'critical', 'warning', 'upcoming')
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

    const emailResult = await sendDomainExpiringEmail({
      to: first.customer_email,
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
        sent_to: first.customer_email,
        metadata: { message_id: emailResult.messageId },
      }));

      await sql`INSERT INTO domain_alerts ${sql(alertRecords)}`;
      await sql`
        UPDATE domains SET alert_sent_at = NOW()
        WHERE id = ANY(${domains.map((d) => d.id)})
      `;

      const adminRows = await sql`SELECT id FROM profiles WHERE role = 'admin' LIMIT 1`;
      if (adminRows.length) {
        const domainList = domains.map((d) => d.full_domain).join(', ');
        await sql`
          INSERT INTO notifications ${sql({
            user_id: adminRows[0].id,
            type: 'domain_expiring',
            title: `Reminder inviato a ${customerName}`,
            message: `Email scadenza domini inviata per: ${domainList}`,
            action_url: '/domains',
          })}
        `;
      }
    } else {
      result.errors.push(`${customerName} (${first.customer_email}): ${emailResult.error}`);
    }
  }

  return result;
}

domainCron.post('/check-expiring', async (c) => {
  // Header-only: query strings leak into nginx access logs, referer headers,
  // browser history, and downstream proxies.
  const secret = c.req.header('x-cron-secret');
  if (!process.env.CRON_SECRET || !secret || secret !== process.env.CRON_SECRET) {
    return c.json({ error: 'Non autorizzato' }, 401);
  }

  try {
    const result = await checkAndSendReminders();
    return c.json(result);
  } catch (error) {
    console.error('[domain-cron] check-expiring failed:', error);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});
