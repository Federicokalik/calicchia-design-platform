import { Hono } from 'hono';
import { sql } from '../../db';
import { applyTranslations, getRequestLocale } from '../../lib/portal-i18n';
import { portalAuth, type PortalEnv } from './auth';

export const renewalsRoutes = new Hono<PortalEnv>();

// ── Unified renewals: subscriptions + domains ────────────
renewalsRoutes.get('/', portalAuth, async (c) => {
  const customerId = c.get('customer_id') as string;

  // Active subscriptions
  const subscriptions = (await sql`
    SELECT id, name, description, amount, currency, billing_interval,
           status, auto_renew, next_billing_date,
           current_period_start, current_period_end,
           'subscription' AS renewal_type
    FROM subscriptions
    WHERE customer_id = ${customerId}
      AND status IN ('active', 'past_due')
    ORDER BY next_billing_date ASC NULLS LAST
  `) as Array<Record<string, unknown>>;

  await applyTranslations(
    subscriptions,
    'subscriptions_translations',
    'id',
    ['name', 'description'],
    getRequestLocale(c)
  );

  // Active domains
  const domains = await sql`
    SELECT id, full_domain AS name,
           'Dominio ' || full_domain AS description,
           renewal_cost AS amount, currency,
           'year' AS billing_interval,
           status, auto_renew, expiration_date AS next_billing_date,
           registration_date AS current_period_start,
           expiration_date AS current_period_end,
           'domain' AS renewal_type,
           ssl_status, ssl_expiration, registrar
    FROM domains
    WHERE customer_id = ${customerId}
      AND status IN ('active', 'expiring_soon')
    ORDER BY expiration_date ASC
  ` as Array<Record<string, unknown>>;

  // Merge and sort by next billing date
  const renewals = [...subscriptions, ...domains].sort((a, b) => {
    const dateA = a.next_billing_date ? new Date(String(a.next_billing_date)).getTime() : Infinity;
    const dateB = b.next_billing_date ? new Date(String(b.next_billing_date)).getTime() : Infinity;
    return dateA - dateB;
  });

  return c.json({ renewals });
});
