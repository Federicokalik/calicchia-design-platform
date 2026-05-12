import { Hono } from 'hono';
import { sql } from '../db';
import { getAdminLocale, type AdminLocale } from '../lib/admin-locale';

export const dashboard = new Hono();

function timeAgo(dateStr: string, locale: AdminLocale): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return locale === 'en' ? 'now' : 'adesso';
  if (minutes < 60) return locale === 'en' ? `${minutes} min ago` : `${minutes} min fa`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return locale === 'en' ? `${hours}h ago` : `${hours}h fa`;
  const days = Math.floor(hours / 24);
  if (days < 7) return locale === 'en' ? `${days}d ago` : `${days}g fa`;
  return new Date(dateStr).toLocaleDateString(locale === 'en' ? 'en-US' : 'it-IT', { day: 'numeric', month: 'short' });
}

const tableLabels: Record<AdminLocale, Record<string, string>> = {
  it: {
    customers: 'Cliente',
    invoices: 'Fattura',
    quotes: 'Preventivo',
    client_projects: 'Progetto',
    domains: 'Dominio',
    subscriptions: 'Abbonamento',
    profiles: 'Profilo',
    customer_users: 'Utente portale',
    invoice_settings: 'Impostazioni fatture',
  },
  en: {
    customers: 'Client',
    invoices: 'Invoice',
    quotes: 'Quote',
    client_projects: 'Project',
    domains: 'Domain',
    subscriptions: 'Subscription',
    profiles: 'Profile',
    customer_users: 'Portal user',
    invoice_settings: 'Invoice settings',
  },
};

const actionVerbs: Record<AdminLocale, Record<string, string>> = {
  it: {
    INSERT: 'ha creato',
    UPDATE: 'ha modificato',
    DELETE: 'ha eliminato',
  },
  en: {
    INSERT: 'created',
    UPDATE: 'updated',
    DELETE: 'deleted',
  },
};

dashboard.get('/counts', async (c) => {
  const [
    customersRow, invoicesRow, quotesRow,
    projectsRow, domainsRow, subscriptionsRow,
    postsRow, contactsRow, collaboratorsRow,
  ] = await Promise.all([
    sql`SELECT COUNT(*) AS count FROM customers WHERE status = 'active'`,
    sql`SELECT COUNT(*) AS count FROM invoices WHERE status NOT IN ('paid', 'void')`,
    sql`SELECT COUNT(*) AS count FROM quotes WHERE status IN ('draft', 'sent', 'viewed')`,
    sql`SELECT COUNT(*) AS count FROM client_projects WHERE status = 'in_progress'`,
    sql`SELECT COUNT(*) AS count FROM domains WHERE status = 'active'`,
    sql`SELECT COUNT(*) AS count FROM subscriptions WHERE status = 'active'`,
    sql`SELECT COUNT(*) AS count FROM blog_posts`,
    sql`SELECT COUNT(*) AS count FROM contacts WHERE is_read = false`,
    sql`SELECT COUNT(*) AS count FROM collaborators WHERE status = 'active'`,
  ]);

  return c.json({
    customers: parseInt(customersRow[0].count as string),
    invoices: parseInt(invoicesRow[0].count as string),
    quotes: parseInt(quotesRow[0].count as string),
    projects: parseInt(projectsRow[0].count as string),
    domains: parseInt(domainsRow[0].count as string),
    subscriptions: parseInt(subscriptionsRow[0].count as string),
    posts: parseInt(postsRow[0].count as string),
    unread_contacts: parseInt(contactsRow[0].count as string),
    collaborators: parseInt(collaboratorsRow[0].count as string),
  });
});

dashboard.get('/revenue', async (c) => {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString();

  const [
    monthly,
    subscriptions,
    timeEntriesData,
    tasksCompletedData,
    paymentLinksPaid,
    trackerPaid,
    invoicedThisMonth,
  ] = await Promise.all([
    sql`SELECT * FROM monthly_invoices_report LIMIT 12`,
    sql`SELECT amount FROM subscriptions WHERE status = 'active'`,
    sql`SELECT duration_minutes FROM time_entries WHERE start_time >= ${monthStart} AND start_time <= ${monthEnd}`,
    sql`SELECT COUNT(*) AS count FROM project_tasks WHERE status = 'done' AND updated_at >= ${monthStart} AND updated_at <= ${monthEnd}`,
    // Pagamenti automatici incassati nel mese (Stripe/PayPal/Revolut/Bonifico via payment_links)
    sql`
      SELECT COALESCE(SUM(amount - COALESCE(refunded_amount, 0)), 0) AS total
      FROM payment_links
      WHERE status IN ('paid', 'partially_refunded')
        AND paid_at >= ${monthStart} AND paid_at <= ${monthEnd}
    `,
    // Pagamenti tracciati manualmente nel mese (contanti, bonifici manuali, ecc.)
    sql`
      SELECT COALESCE(SUM(COALESCE(paid_amount, amount)), 0) AS total
      FROM payment_tracker
      WHERE status IN ('pagata', 'parziale')
        AND (paid_date >= ${monthStart.slice(0, 10)} OR (paid_date IS NULL AND updated_at >= ${monthStart}))
        AND (paid_date <= ${monthEnd.slice(0, 10)} OR paid_date IS NULL)
    `,
    // Totale fatturato emesso nel mese
    sql`
      SELECT COALESCE(SUM(total), 0) AS total
      FROM invoices
      WHERE issue_date >= ${monthStart.slice(0, 10)} AND issue_date <= ${monthEnd.slice(0, 10)}
        AND status != 'void'
    `,
  ]);

  const mrr = subscriptions.reduce((acc, s) => acc + ((s.amount as number) || 0), 0);
  const hoursWorked = Math.round(timeEntriesData.reduce((acc, t) => acc + ((t.duration_minutes as number) || 0), 0) / 60);
  const collectedAuto = Number((paymentLinksPaid[0] as { total: string | number })?.total ?? 0);
  const collectedManual = Number((trackerPaid[0] as { total: string | number })?.total ?? 0);
  const invoicedMonth = Number((invoicedThisMonth[0] as { total: string | number })?.total ?? 0);

  return c.json({
    monthly,
    mrr,
    hoursWorked,
    tasksCompleted: parseInt(tasksCompletedData[0].count as string) || 0,
    // Nuovi: vista unificata incassi
    collected: {
      auto: collectedAuto,         // via Stripe/PayPal/Revolut/Bonifico (payment_links paid)
      manual: collectedManual,     // via tracker manuale (contanti, bonifici offline)
      total: collectedAuto + collectedManual,
    },
    invoicedThisMonth: invoicedMonth,
  });
});

dashboard.get('/activity', async (c) => {
  const locale = getAdminLocale(c);
  const limit = Math.min(parseInt(c.req.query('limit') || '15'), 50);

  const logs = await sql`
    SELECT id, user_email, action, table_name, record_id, created_at
    FROM audit_logs
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;

  const activity = logs.map((log) => ({
    id: log.id,
    user: log.user_email || (locale === 'en' ? 'System' : 'Sistema'),
    action: actionVerbs[locale][log.action as string] || log.action,
    action_raw: log.action,
    entity: tableLabels[locale][log.table_name as string] || log.table_name,
    table_name: log.table_name,
    record_id: log.record_id,
    time_ago: timeAgo(log.created_at as string, locale),
    created_at: log.created_at,
  }));

  return c.json({ activity });
});

dashboard.get('/expiring-domains', async (c) => {
  const domains = await sql`
    SELECT * FROM expiring_domains
    WHERE urgency_level IN ('expired', 'critical', 'warning', 'upcoming')
    LIMIT 20
  `;
  return c.json({ domains });
});

dashboard.get('/collaborators-summary', async (c) => {
  const [activeData, linkedData] = await Promise.all([
    sql`SELECT COUNT(*) AS count FROM collaborators WHERE status = 'active'`,
    sql`SELECT COUNT(*) AS count FROM client_projects WHERE collaborator_id IS NOT NULL`,
  ]);

  return c.json({
    active: parseInt(activeData[0].count as string) || 0,
    linked_projects: parseInt(linkedData[0].count as string) || 0,
  });
});

dashboard.get('/upcoming-bookings', async (c) => {
  const bookings = await sql`
    SELECT id, booking_uid, title, start_time, end_time, attendee_name, attendee_email, meeting_url, duration_minutes
    FROM cal_bookings
    WHERE status = 'upcoming' AND start_time >= ${new Date().toISOString()}
    ORDER BY start_time ASC
    LIMIT 5
  `;
  return c.json({ bookings });
});

dashboard.get('/task-stats', async (c) => {
  const rows = await sql`
    SELECT status, COUNT(*)::int AS count
    FROM project_tasks
    GROUP BY status
  ` as Array<{ status: string; count: number }>;

  const result: Record<string, number> = {
    todo: 0, in_progress: 0, review: 0, done: 0, blocked: 0,
  };
  for (const row of rows) {
    if (row.status in result) result[row.status] = row.count;
  }
  return c.json(result);
});

dashboard.get('/entity-timeseries', async (c) => {
  const entity = c.req.query('entity') || 'customers';
  const period = c.req.query('period') || '90d';

  const tableMap: Record<string, string> = {
    customers: 'customers',
    invoices: 'invoices',
    quotes: 'quotes',
  };

  const table = tableMap[entity];
  if (!table) return c.json({ error: getAdminLocale(c) === 'en' ? 'invalid entity' : 'entity non valido' }, 400);

  const periodMap: Record<string, string> = {
    '30d': '30 days',
    '90d': '90 days',
    '1y': '1 year',
  };
  const interval = periodMap[period] || '90 days';

  const rows = await sql`
    SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month, COUNT(*)::int AS count
    FROM ${sql(table)}
    WHERE created_at >= NOW() - CAST(${interval} AS INTERVAL)
    GROUP BY month
    ORDER BY month
  ` as Array<{ month: string; count: number }>;

  return c.json({ timeseries: rows });
});

dashboard.get('/quotes-summary', async (c) => {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const [pendingQuotes, acceptedData] = await Promise.all([
    sql`
      SELECT q.status, q.total, q.customer_id, q.title, q.quote_number, q.created_at,
        COALESCE(c.company_name, c.contact_name) AS customer_name
      FROM quotes q
      LEFT JOIN customers c ON c.id = q.customer_id
      WHERE q.status IN ('draft', 'sent', 'viewed')
    `,
    sql`SELECT COUNT(*) AS count FROM quotes WHERE status = 'accepted' AND created_at >= ${monthStart}`,
  ]);

  const pendingTotal = pendingQuotes.reduce((acc, q) => acc + ((q.total as number) || 0), 0);

  return c.json({
    pending_count: pendingQuotes.length,
    pending_total: pendingTotal,
    accepted_this_month: parseInt(acceptedData[0].count as string) || 0,
    recent_pending: pendingQuotes.slice(0, 3).map((q) => ({
      title: q.title,
      quote_number: q.quote_number,
      total: q.total,
      customer_name: (q.customer_name as string) || '-',
      created_at: q.created_at,
    })),
  });
});
