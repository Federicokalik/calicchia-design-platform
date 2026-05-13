import { Hono } from 'hono';
import { sql } from '../db';
import { computeTaxes, type FreelancerStudioConfig } from '../lib/tax/forfettario';

export const tax = new Hono();

tax.get('/forecast', async (c) => {
  const [row] = (await sql`
    SELECT value
    FROM site_settings
    WHERE key = 'freelancer.studio'
    LIMIT 1
  `) as Array<{ value: unknown }>;
  const config: FreelancerStudioConfig = (row?.value as FreelancerStudioConfig) ?? {};

  const rows = (await sql`
    SELECT COALESCE(SUM(total), 0)::numeric AS gross
    FROM invoices
    WHERE status IN ('paid', 'open', 'draft')
      AND issue_date >= date_trunc('year', now() AT TIME ZONE 'Europe/Rome')
  `) as Array<{ gross: string | number }>;
  // Forecast: include fatture pagate, aperte e bozze come ricavi attesi.
  const gross = Number(rows[0]?.gross ?? 0);

  const taxes = computeTaxes(gross, config);
  const year = Number(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
  }).format(new Date()));

  // Acconti calcolati su imposta dell'anno precedente, qui semplificati.
  const deadlines = [
    {
      label: 'Saldo + 1° acconto',
      date: `${year}-06-30`,
      amount_eur: Math.round((taxes.total_due_eur + taxes.total_due_eur * 0.5) * 100) / 100,
    },
    {
      label: '2° acconto',
      date: `${year}-11-30`,
      amount_eur: Math.round((taxes.total_due_eur * 0.5) * 100) / 100,
    },
  ];

  const monthly = (await sql`
    SELECT date_trunc('month', issue_date) AS month, COALESCE(SUM(total), 0)::numeric AS total
    FROM invoices
    WHERE status IN ('paid','open','draft')
      AND issue_date >= date_trunc('year', now() AT TIME ZONE 'Europe/Rome')
    GROUP BY 1 ORDER BY 1
  `) as Array<{ month: string | Date; total: string | number }>;

  return c.json({
    year,
    taxes,
    deadlines,
    monthly_revenue: monthly.map((m) => ({ month: m.month, total: Number(m.total) })),
  });
});
