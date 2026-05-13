import { Hono } from 'hono';
import { sql } from '../db';

export const clientProjects = new Hono();

clientProjects.get('/', async (c) => {
  const status = c.req.query('status');
  const customerId = c.req.query('customer_id');
  const projectType = c.req.query('type');
  const category = c.req.query('category');
  const search = c.req.query('search');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const offset = parseInt(c.req.query('offset') || '0');

  const statusFilter = status && status !== 'all' ? sql`AND status = ${status}` : sql``;
  const customerFilter = customerId ? sql`AND customer_id = ${customerId}` : sql``;
  const typeFilter = projectType && projectType !== 'all' ? sql`AND project_type = ${projectType}` : sql``;
  const categoryFilter = category && category !== 'all' ? sql`AND project_category = ${category}` : sql``;
  const searchFilter = search
    ? sql`AND (name ILIKE ${'%' + search + '%'} OR customer_name ILIKE ${'%' + search + '%'} OR customer_company ILIKE ${'%' + search + '%'})`
    : sql``;

  const [projects, allProjects] = await Promise.all([
    sql`
      SELECT *, COUNT(*) OVER() AS _total_count
      FROM client_projects_view
      WHERE 1=1 ${statusFilter} ${customerFilter} ${typeFilter} ${categoryFilter} ${searchFilter}
      ORDER BY updated_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `,
    sql`SELECT status, is_overdue FROM client_projects_view`,
  ]);

  const count = projects[0]?._total_count ? parseInt(projects[0]._total_count as string) : 0;
  const cleaned = projects.map((p) => ({ ...p, _total_count: undefined }));

  const stats = {
    total: allProjects.length,
    in_progress: allProjects.filter((p) => p.status === 'in_progress').length,
    completed: allProjects.filter((p) => p.status === 'completed').length,
    overdue: allProjects.filter((p) => p.is_overdue).length,
  };

  return c.json({ projects: cleaned, count, stats });
});

clientProjects.get('/:id/profitability', async (c) => {
  const id = c.req.param('id');

  const projectRows = await sql`
    SELECT id, budget_amount, hourly_rate, currency
    FROM client_projects
    WHERE id = ${id}
  `;
  const project = projectRows[0];
  if (!project) return c.json({ error: 'Project not found' }, 404);

  const [settingsRows, timeRows] = await Promise.all([
    sql`
      SELECT (value->>'default_hourly_rate_cents')::int AS cents
      FROM site_settings
      WHERE key = 'freelancer.studio'
    `,
    sql`
      SELECT
        COALESCE(SUM(duration_minutes) FILTER (WHERE is_billable AND end_time IS NOT NULL), 0)::int AS billable_minutes,
        COALESCE(SUM(duration_minutes) FILTER (WHERE NOT is_billable AND end_time IS NOT NULL), 0)::int AS non_billable_minutes,
        COUNT(*) FILTER (WHERE end_time IS NULL)::int AS running_count
      FROM time_entries
      WHERE project_id = ${id}
    `,
  ]);

  const round2 = (value: number) => Math.round(value * 100) / 100;
  const projectHourlyRate = project.hourly_rate === null ? null : Number(project.hourly_rate);
  const defaultCents =
    settingsRows[0]?.cents === null || settingsRows[0]?.cents === undefined
      ? 5000
      : Number(settingsRows[0].cents);
  const defaultHourlyRate = defaultCents / 100;

  const hourlyRateSource =
    projectHourlyRate !== null
      ? 'project'
      : settingsRows[0]?.cents !== null && settingsRows[0]?.cents !== undefined
        ? 'freelancer_default'
        : 'hardcoded_fallback';
  const rateEur = round2(projectHourlyRate ?? defaultHourlyRate ?? 50);

  const timeMetrics = timeRows[0];
  const billableMinutes = Number(timeMetrics?.billable_minutes ?? 0);
  const nonBillableMinutes = Number(timeMetrics?.non_billable_minutes ?? 0);
  const hoursBillable = round2(billableMinutes / 60);
  const hoursNonBillable = round2(nonBillableMinutes / 60);
  const hoursTotal = round2(hoursBillable + hoursNonBillable);
  const timeCostEur = round2(hoursBillable * rateEur);
  const quotedEur = round2(project.budget_amount === null ? 0 : Number(project.budget_amount));
  const expensesEur = 0;
  const netEur = round2(quotedEur - timeCostEur - expensesEur);

  return c.json({
    project_id: project.id,
    currency: project.currency,
    hourly_rate_eur: rateEur,
    hourly_rate_source: hourlyRateSource,
    quoted_eur: quotedEur,
    time_cost_eur: timeCostEur,
    expenses_eur: expensesEur,
    net_eur: netEur,
    hours_billable: hoursBillable,
    hours_non_billable: hoursNonBillable,
    hours_total: hoursTotal,
    running_timers: Number(timeMetrics?.running_count ?? 0),
  });
});

clientProjects.post('/:id/create-invoice', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));

  if (
    typeof body.amount !== 'number' ||
    body.amount <= 0 ||
    typeof body.milestone_name !== 'string' ||
    !body.milestone_name.trim()
  ) {
    return c.json({ error: 'amount e milestone_name richiesti' }, 400);
  }

  const dueInDays =
    Number.isInteger(body.due_in_days) && body.due_in_days >= 0 ? body.due_in_days : 30;

  const result = await sql.begin(async (txSql: any) => {
    const [project] = await txSql`SELECT * FROM client_projects WHERE id = ${id}`;
    if (!project) return { __error: 'Progetto non trovato', __status: 404 };

    if (!project.customer_id) {
      return { __error: 'Progetto senza cliente', __status: 422 };
    }

    const [settings] = await txSql`
      SELECT (value->>'vat_regime') AS regime
      FROM site_settings
      WHERE key = 'freelancer.studio'
      LIMIT 1
    `;
    const regime = settings?.regime ?? 'forfettario';
    const subtotal = body.amount;
    const tax = regime === 'forfettario' || regime === 'none' ? 0 : Math.round(body.amount * 0.22 * 100) / 100;
    const total = subtotal + tax;
    const lineItems = [
      {
        description: body.milestone_name.trim(),
        quantity: 1,
        unit_price: body.amount,
        amount: body.amount,
      },
    ];

    const [invoice] = await txSql`
      INSERT INTO invoices (
        customer_id, project_id, subtotal, tax, total, amount_due,
        currency, status, issue_date, due_date, line_items, notes
      )
      VALUES (
        ${project.customer_id},
        ${project.id},
        ${subtotal},
        ${tax},
        ${total},
        ${total},
        COALESCE(${project.currency}, 'EUR'),
        'draft',
        CURRENT_DATE,
        CURRENT_DATE + (${dueInDays}::int || ' days')::interval,
        ${lineItems},
        ${body.notes ?? null}
      )
      RETURNING *
    `;

    return { invoice };
  });

  if (result.__error) {
    if (result.__status === 422) return c.json({ error: result.__error }, 422);
    return c.json({ error: result.__error }, 404);
  }
  return c.json(result, 201);
});

clientProjects.get('/:id', async (c) => {
  const id = c.req.param('id');

  const projectRows = await sql`SELECT * FROM client_projects_view WHERE id = ${id}`;
  if (!projectRows.length) return c.json({ error: 'Progetto non trovato' }, 404);

  const [tasks, milestones] = await Promise.all([
    sql`
      SELECT t.*,
        p.email AS assignee_email,
        m.name AS milestone_name
      FROM project_tasks t
      LEFT JOIN profiles p ON p.id = t.assigned_to
      LEFT JOIN project_milestones m ON m.id = t.milestone_id
      WHERE t.project_id = ${id}
      ORDER BY t.sort_order ASC
    `,
    sql`SELECT * FROM project_milestones WHERE project_id = ${id} ORDER BY sort_order ASC`,
  ]);

  return c.json({ project: projectRows[0], tasks, milestones });
});

clientProjects.post('/', async (c) => {
  const body = await c.req.json();

  if (!body.name || !body.customer_id) {
    return c.json({ error: 'Nome e cliente richiesti' }, 400);
  }

  const [project] = await sql`INSERT INTO client_projects ${sql(body)} RETURNING *`;
  return c.json({ project }, 201);
});

clientProjects.put('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();

  const [project] = await sql`
    UPDATE client_projects SET ${sql({ ...body, updated_at: new Date().toISOString() })}
    WHERE id = ${id} RETURNING *
  `;
  return c.json({ project });
});

clientProjects.delete('/:id', async (c) => {
  await sql`UPDATE client_projects SET status = 'cancelled' WHERE id = ${c.req.param('id')}`;
  return c.json({ success: true });
});
