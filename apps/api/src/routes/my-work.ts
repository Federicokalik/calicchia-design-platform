import { Hono } from 'hono';
import { sql } from '../db';

export const myWork = new Hono();

// GET /api/my-work — personal "today" landing
// Returns 4 buckets:
// - today: tasks due today
// - week: tasks due in next 7 days (excl. today)
// - overdue: tasks past due date
// - recontact: leads contacted > 7 days ago with no update, status not won/lost
myWork.get('/', async (c) => {
  const [today, week, overdue, recontact] = await Promise.all([
    sql`
      SELECT pt.id, pt.title, pt.status, pt.priority, pt.due_date, pt.project_id,
             cp.name AS project_name, cp.customer_id
      FROM project_tasks pt
      LEFT JOIN client_projects cp ON cp.id = pt.project_id
      WHERE pt.due_date IS NOT NULL
        AND pt.due_date::date = CURRENT_DATE
        AND pt.status NOT IN ('done', 'blocked')
      ORDER BY pt.priority ASC NULLS LAST, pt.created_at ASC
      LIMIT 30
    `,
    sql`
      SELECT pt.id, pt.title, pt.status, pt.priority, pt.due_date, pt.project_id,
             cp.name AS project_name
      FROM project_tasks pt
      LEFT JOIN client_projects cp ON cp.id = pt.project_id
      WHERE pt.due_date IS NOT NULL
        AND pt.due_date::date > CURRENT_DATE
        AND pt.due_date::date <= CURRENT_DATE + INTERVAL '7 days'
        AND pt.status NOT IN ('done', 'blocked')
      ORDER BY pt.due_date ASC, pt.priority ASC NULLS LAST
      LIMIT 30
    `,
    sql`
      SELECT pt.id, pt.title, pt.status, pt.priority, pt.due_date, pt.project_id,
             cp.name AS project_name,
             (CURRENT_DATE - pt.due_date::date) AS days_overdue
      FROM project_tasks pt
      LEFT JOIN client_projects cp ON cp.id = pt.project_id
      WHERE pt.due_date IS NOT NULL
        AND pt.due_date::date < CURRENT_DATE
        AND pt.status NOT IN ('done', 'blocked')
      ORDER BY pt.due_date ASC
      LIMIT 30
    `,
    sql`
      SELECT id, name, email, phone, company, status, estimated_value, updated_at,
             (CURRENT_DATE - updated_at::date) AS days_since_contact
      FROM leads
      WHERE status IN ('contacted', 'proposal', 'negotiation')
        AND updated_at < now() - INTERVAL '7 days'
      ORDER BY updated_at ASC
      LIMIT 20
    `,
  ]);

  return c.json({
    counts: {
      today: today.length,
      week: week.length,
      overdue: overdue.length,
      recontact: recontact.length,
    },
    today,
    week,
    overdue,
    recontact,
  });
});
