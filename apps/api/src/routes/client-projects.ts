import { Hono } from 'hono';
import { sql } from '../db';

export const clientProjects = new Hono();

const PREVIEW_PROVIDERS = ['netlify', 'vercel', 'wordpress', 'custom'] as const;
const PREVIEW_STATUSES = ['draft', 'review', 'approved', 'archived'] as const;
type PreviewProvider = typeof PREVIEW_PROVIDERS[number];
type PreviewStatus = typeof PREVIEW_STATUSES[number];

interface ProjectPreviewRow {
  id: string;
  project_id: string;
  title: string;
  url: string;
  provider: PreviewProvider;
  status: PreviewStatus;
  visible_to_client: boolean;
  sort_order: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function derivePreviewProvider(hostname: string): PreviewProvider {
  const host = hostname.toLowerCase();
  if (host.endsWith('.netlify.app') || host.includes('netlify')) return 'netlify';
  if (host.endsWith('.vercel.app') || host.includes('vercel')) return 'vercel';
  if (host.endsWith('.wordpress.com') || host.includes('wpengine') || host.includes('wordpress')) return 'wordpress';
  return 'custom';
}

function isPrivateIpv4(hostname: string): boolean {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((n) => n < 0 || n > 255)) return true;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function normalizePreviewUrl(value: unknown): { url?: string; provider?: PreviewProvider; error?: string } {
  if (typeof value !== 'string' || !value.trim()) return { error: 'URL richiesto' };
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return { error: 'URL non valido' };
  }

  if (parsed.protocol !== 'https:') return { error: 'Sono ammessi solo URL https' };
  if (parsed.username || parsed.password) return { error: 'URL con credenziali non ammessi' };

  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const blockedHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
  if (
    blockedHosts.has(host) ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.lan') ||
    host.endsWith('.internal') ||
    host.endsWith('.test') ||
    host.endsWith('.invalid') ||
    host.endsWith('.example') ||
    isPrivateIpv4(host) ||
    (host.includes(':') && (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')))
  ) {
    return { error: 'URL non pubblico non ammesso' };
  }
  if (!host.includes('.') && !host.includes(':')) return { error: 'Hostname pubblico richiesto' };

  parsed.hash = '';
  return { url: parsed.toString(), provider: derivePreviewProvider(host) };
}

function previewPayload(body: Record<string, unknown>, partial = false) {
  const out: Record<string, unknown> = {};

  if (!partial || body.title !== undefined) {
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 160) : '';
    if (!title) return { error: 'Titolo richiesto' };
    out.title = title;
  }

  let derivedProvider: PreviewProvider | undefined;
  if (!partial || body.url !== undefined) {
    const normalized = normalizePreviewUrl(body.url);
    if (normalized.error) return { error: normalized.error };
    out.url = normalized.url;
    derivedProvider = normalized.provider;
  }

  if (!partial || body.provider !== undefined || derivedProvider) {
    const provider = typeof body.provider === 'string' && PREVIEW_PROVIDERS.includes(body.provider as PreviewProvider)
      ? body.provider as PreviewProvider
      : derivedProvider || 'custom';
    out.provider = provider;
  }

  if (!partial || body.status !== undefined) {
    const status = typeof body.status === 'string' && PREVIEW_STATUSES.includes(body.status as PreviewStatus)
      ? body.status
      : 'draft';
    out.status = status;
  }

  if (!partial || body.visible_to_client !== undefined) {
    out.visible_to_client = body.visible_to_client !== false;
  }
  if (!partial || body.sort_order !== undefined) {
    const n = Number(body.sort_order);
    out.sort_order = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
  }
  if (!partial || body.notes !== undefined) {
    out.notes = typeof body.notes === 'string' && body.notes.trim()
      ? body.notes.trim().slice(0, 1000)
      : null;
  }

  return { data: out };
}

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

clientProjects.get('/:id/previews', async (c) => {
  const id = c.req.param('id');
  const [project] = await sql`SELECT id FROM client_projects WHERE id = ${id} LIMIT 1`;
  if (!project) return c.json({ error: 'Progetto non trovato' }, 404);

  const previews = await sql<ProjectPreviewRow[]>`
    SELECT *
    FROM project_previews
    WHERE project_id = ${id}
    ORDER BY sort_order ASC, created_at ASC
  `;
  return c.json({ previews });
});

clientProjects.post('/:id/previews', async (c) => {
  const id = c.req.param('id');
  const [project] = await sql`SELECT id FROM client_projects WHERE id = ${id} LIMIT 1`;
  if (!project) return c.json({ error: 'Progetto non trovato' }, 404);

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const payload = previewPayload(body);
  if (payload.error) return c.json({ error: payload.error }, 400);

  const [preview] = await sql<ProjectPreviewRow[]>`
    INSERT INTO project_previews ${sql({ ...payload.data, project_id: id })}
    RETURNING *
  `;
  return c.json({ preview }, 201);
});

clientProjects.put('/:id/previews/:previewId', async (c) => {
  const id = c.req.param('id');
  const previewId = c.req.param('previewId');
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const payload = previewPayload(body, true);
  if (payload.error) return c.json({ error: payload.error }, 400);
  if (!payload.data || Object.keys(payload.data).length === 0) {
    return c.json({ error: 'Nessun campo da aggiornare' }, 400);
  }

  const [preview] = await sql<ProjectPreviewRow[]>`
    UPDATE project_previews
    SET ${sql(payload.data)}
    WHERE id = ${previewId} AND project_id = ${id}
    RETURNING *
  `;
  if (!preview) return c.json({ error: 'Anteprima non trovata' }, 404);
  return c.json({ preview });
});

clientProjects.delete('/:id/previews/:previewId', async (c) => {
  const id = c.req.param('id');
  const previewId = c.req.param('previewId');
  const [deleted] = await sql`
    DELETE FROM project_previews
    WHERE id = ${previewId} AND project_id = ${id}
    RETURNING id
  `;
  if (!deleted) return c.json({ error: 'Anteprima non trovata' }, 404);
  return c.json({ success: true });
});

clientProjects.get('/:id', async (c) => {
  const id = c.req.param('id');

  const projectRows = await sql`SELECT * FROM client_projects_view WHERE id = ${id}`;
  if (!projectRows.length) return c.json({ error: 'Progetto non trovato' }, 404);

  const [tasks, milestones, hasQuoteRows] = await Promise.all([
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
    sql`
      SELECT (
        EXISTS (SELECT 1 FROM quotes WHERE project_id = ${id})
        OR EXISTS (SELECT 1 FROM quotes_v2 WHERE project_id = ${id})
      ) AS has_quote
    `,
  ]);

  const has_quote = Boolean((hasQuoteRows[0] as { has_quote?: boolean })?.has_quote);
  const project = { ...(projectRows[0] as Record<string, unknown>), has_quote };

  return c.json({ project, tasks, milestones });
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
