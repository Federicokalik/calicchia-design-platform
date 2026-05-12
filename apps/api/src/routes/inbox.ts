import { Hono } from 'hono';
import { sql } from '../db';

export const inbox = new Hono();

// GET /api/inbox — aggregate everything that needs attention
inbox.get('/', async (c) => {
  // Fire all queries in parallel
  const [tasksOverdue, tasksToday, quotesPending, invoicesOverdue, leadsNew] = await Promise.all([
    // Tasks: due_date < today and not done
    sql`
      SELECT pt.id, pt.title, pt.due_date, pt.status, pt.project_id,
             cp.name AS project_name
      FROM project_tasks pt
      LEFT JOIN client_projects cp ON cp.id = pt.project_id
      WHERE pt.due_date IS NOT NULL
        AND pt.due_date::date < CURRENT_DATE
        AND pt.status NOT IN ('done', 'blocked')
      ORDER BY pt.due_date ASC
      LIMIT 20
    `,
    // Tasks: due_date = today and not done
    sql`
      SELECT pt.id, pt.title, pt.due_date, pt.status, pt.project_id,
             cp.name AS project_name
      FROM project_tasks pt
      LEFT JOIN client_projects cp ON cp.id = pt.project_id
      WHERE pt.due_date IS NOT NULL
        AND pt.due_date::date = CURRENT_DATE
        AND pt.status != 'done'
      ORDER BY pt.created_at ASC
      LIMIT 20
    `,
    // Quotes: sent but not accepted/rejected
    sql`
      SELECT q.id, q.quote_number, q.title, q.total, q.sent_at,
             c.company_name, c.contact_name
      FROM quotes q
      LEFT JOIN customers c ON c.id = q.customer_id
      WHERE q.status = 'sent' AND q.accepted_at IS NULL
      ORDER BY q.sent_at DESC NULLS LAST
      LIMIT 20
    `,
    // Invoices: open and overdue
    sql`
      SELECT i.id, i.invoice_number, i.total, i.amount_due, i.due_date, i.status,
             c.company_name, c.contact_name
      FROM invoices i
      LEFT JOIN customers c ON c.id = i.customer_id
      WHERE i.status = 'open'
        AND i.due_date IS NOT NULL
        AND i.due_date::date < CURRENT_DATE
      ORDER BY i.due_date ASC
      LIMIT 20
    `,
    // Leads: new, not yet contacted
    sql`
      SELECT id, name, email, company, notes, created_at, status, source, estimated_value
      FROM leads
      WHERE status = 'new'
      ORDER BY created_at DESC
      LIMIT 20
    `,
  ]);

  const counts = {
    tasks_overdue: tasksOverdue.length,
    tasks_today: tasksToday.length,
    quotes_pending: quotesPending.length,
    invoices_overdue: invoicesOverdue.length,
    leads_new: leadsNew.length,
    total:
      tasksOverdue.length +
      tasksToday.length +
      quotesPending.length +
      invoicesOverdue.length +
      leadsNew.length,
  };

  return c.json({
    counts,
    tasks_overdue: tasksOverdue,
    tasks_today: tasksToday,
    quotes_pending: quotesPending,
    invoices_overdue: invoicesOverdue,
    leads_new: leadsNew,
  });
});
