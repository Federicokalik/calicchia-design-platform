import { Hono } from 'hono';
import { sql } from '../db';

export const expenses = new Hono();

const EXPENSE_CATEGORIES = [
  'software',
  'hardware',
  'office',
  'travel',
  'meals',
  'training',
  'marketing',
  'professional_services',
  'utilities',
  'other',
] as const;

type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

type ExpenseRow = Record<string, unknown> & {
  amount?: unknown;
  vat_amount?: unknown;
  deductible_percent?: unknown;
  _total_count?: unknown;
};

type ExpenseMutation = {
  occurred_on?: string;
  vendor?: string | null;
  amount?: number;
  vat_amount?: number;
  category?: ExpenseCategory;
  description?: string | null;
  receipt_path?: string | null;
  ocr_raw_json?: unknown;
  linked_invoice_id?: string | null;
  project_id?: string | null;
  customer_id?: string | null;
  deductible_percent?: number;
  currency?: string | null;
  notes?: string | null;
};

const categorySet = new Set<string>(EXPENSE_CATEGORIES);

function isExpenseCategory(value: unknown): value is ExpenseCategory {
  return typeof value === 'string' && categorySet.has(value);
}

function parseLimit(value: string | undefined): number {
  const parsed = Number.parseInt(value || '50', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.min(parsed, 200);
}

function parseOffset(value: string | undefined): number {
  const parsed = Number.parseInt(value || '0', 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function parseMoney(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parsePercent(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeExpense(row: ExpenseRow): Record<string, unknown> {
  const { _total_count: _totalCount, ...expense } = row;
  return {
    ...expense,
    amount: Number(row.amount ?? 0),
    vat_amount: Number(row.vat_amount ?? 0),
    deductible_percent: Number(row.deductible_percent ?? 100),
  };
}

function buildExpensePayload(
  body: Record<string, unknown>,
  options: { requireRequiredFields: boolean },
): { payload?: ExpenseMutation; error?: string } {
  const payload: ExpenseMutation = {};

  if (options.requireRequiredFields || body.occurred_on !== undefined) {
    if (typeof body.occurred_on !== 'string' || !body.occurred_on.trim()) {
      return { error: 'occurred_on richiesto' };
    }
    payload.occurred_on = body.occurred_on.trim();
  }

  if (options.requireRequiredFields || body.amount !== undefined) {
    const amount = parseMoney(body.amount);
    if (amount === null || amount < 0) return { error: 'amount non valido' };
    payload.amount = amount;
  }

  if (options.requireRequiredFields || body.category !== undefined) {
    if (!isExpenseCategory(body.category)) return { error: 'category non valida' };
    payload.category = body.category;
  }

  if (body.vat_amount !== undefined) {
    const vatAmount = parseMoney(body.vat_amount);
    if (vatAmount === null || vatAmount < 0) return { error: 'vat_amount non valido' };
    payload.vat_amount = vatAmount;
  }

  if (body.deductible_percent !== undefined) {
    const deductiblePercent = parsePercent(body.deductible_percent);
    if (deductiblePercent === null || deductiblePercent < 0 || deductiblePercent > 100) {
      return { error: 'deductible_percent non valido' };
    }
    payload.deductible_percent = deductiblePercent;
  } else if (options.requireRequiredFields) {
    payload.deductible_percent = 100;
  }

  const stringFields = [
    'vendor',
    'description',
    'receipt_path',
    'linked_invoice_id',
    'project_id',
    'customer_id',
    'currency',
    'notes',
  ] as const;

  for (const field of stringFields) {
    const value = optionalString(body[field]);
    if (value !== undefined) payload[field] = value;
  }

  if (body.ocr_raw_json !== undefined) payload.ocr_raw_json = body.ocr_raw_json;

  return { payload };
}

expenses.get('/', async (c) => {
  const category = c.req.query('category');
  const dateFrom = c.req.query('date_from');
  const dateTo = c.req.query('date_to');
  const projectId = c.req.query('project_id');
  const customerId = c.req.query('customer_id');
  const search = c.req.query('search');
  const limit = parseLimit(c.req.query('limit'));
  const offset = parseOffset(c.req.query('offset'));

  if (category && category !== 'all' && !isExpenseCategory(category)) {
    return c.json({ error: 'category non valida' }, 400);
  }

  const categoryFilter = category && category !== 'all' ? sql`AND e.category = ${category}` : sql``;
  const dateFromFilter = dateFrom ? sql`AND e.occurred_on >= ${dateFrom}` : sql``;
  const dateToFilter = dateTo ? sql`AND e.occurred_on <= ${dateTo}` : sql``;
  const projectFilter = projectId ? sql`AND e.project_id = ${projectId}` : sql``;
  const customerFilter = customerId ? sql`AND e.customer_id = ${customerId}` : sql``;
  const searchFilter = search
    ? sql`AND (
        e.vendor ILIKE ${'%' + search + '%'}
        OR e.description ILIKE ${'%' + search + '%'}
        OR e.notes ILIKE ${'%' + search + '%'}
        OR COALESCE(c.company_name, c.contact_name) ILIKE ${'%' + search + '%'}
        OR p.name ILIKE ${'%' + search + '%'}
      )`
    : sql``;

  const [expenseRows, statsRows] = await Promise.all([
    sql`
      SELECT
        e.*,
        COALESCE(c.company_name, c.contact_name) AS customer_name,
        p.name AS project_name,
        COUNT(*) OVER() AS _total_count
      FROM expenses e
      LEFT JOIN customers c ON c.id = e.customer_id
      LEFT JOIN client_projects p ON p.id = e.project_id
      WHERE 1=1
        ${categoryFilter}
        ${dateFromFilter}
        ${dateToFilter}
        ${projectFilter}
        ${customerFilter}
        ${searchFilter}
      ORDER BY e.occurred_on DESC
      LIMIT ${limit} OFFSET ${offset}
    `,
    sql`
      SELECT
        COUNT(*)::int AS total_count,
        COALESCE(SUM(amount), 0)::numeric AS total_amount,
        COALESCE(SUM(amount * deductible_percent / 100.0), 0)::numeric AS total_deductible,
        category,
        COUNT(*) FILTER (WHERE deductible_percent > 0)::int AS deductible_count
      FROM expenses
      WHERE occurred_on >= date_trunc('year', now())
      GROUP BY category
    `,
  ]);

  const rows = expenseRows as ExpenseRow[];
  const count = rows[0]?._total_count ? Number(rows[0]._total_count) : 0;
  const byCategory = statsRows.map((row) => ({
    category: row.category,
    total_count: Number(row.total_count ?? 0),
    total_amount: Number(row.total_amount ?? 0),
    total_deductible: Number(row.total_deductible ?? 0),
    deductible_count: Number(row.deductible_count ?? 0),
  }));

  const stats = {
    total_count: byCategory.reduce((acc, row) => acc + row.total_count, 0),
    total_amount: byCategory.reduce((acc, row) => acc + row.total_amount, 0),
    total_deductible: byCategory.reduce((acc, row) => acc + row.total_deductible, 0),
    by_category: byCategory,
  };

  return c.json({ expenses: rows.map(normalizeExpense), count, stats });
});

expenses.get('/:id', async (c) => {
  const id = c.req.param('id');

  const [expense] = await sql`
    SELECT
      e.*,
      COALESCE(c.company_name, c.contact_name) AS customer_name,
      p.name AS project_name
    FROM expenses e
    LEFT JOIN customers c ON c.id = e.customer_id
    LEFT JOIN client_projects p ON p.id = e.project_id
    WHERE e.id = ${id}
  ` as ExpenseRow[];

  if (!expense) return c.json({ error: 'Spesa non trovata' }, 404);
  return c.json({ expense: normalizeExpense(expense) });
});

expenses.post('/', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const { payload, error } = buildExpensePayload(body, { requireRequiredFields: true });
  if (error || !payload) return c.json({ error: error || 'Dati non validi' }, 400);

  const [expense] = await sql`
    INSERT INTO expenses ${sql(payload as Record<string, unknown>)}
    RETURNING *
  ` as ExpenseRow[];

  return c.json({ expense: normalizeExpense(expense) }, 201);
});

expenses.put('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const { payload, error } = buildExpensePayload(body, { requireRequiredFields: false });
  if (error || !payload) return c.json({ error: error || 'Dati non validi' }, 400);
  if (Object.keys(payload).length === 0) return c.json({ error: 'Nessun campo da aggiornare' }, 400);

  const [expense] = await sql`
    UPDATE expenses SET ${sql(payload as Record<string, unknown>)}
    WHERE id = ${id}
    RETURNING *
  ` as ExpenseRow[];

  if (!expense) return c.json({ error: 'Spesa non trovata' }, 404);
  return c.json({ expense: normalizeExpense(expense) });
});

expenses.delete('/:id', async (c) => {
  const [expense] = await sql`
    DELETE FROM expenses
    WHERE id = ${c.req.param('id')}
    RETURNING id
  `;

  if (!expense) return c.json({ error: 'Spesa non trovata' }, 404);
  return c.json({ success: true });
});
