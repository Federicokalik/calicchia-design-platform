import { Hono } from 'hono';
import { sql } from '../db';

export const websites = new Hono();

type Row = Record<string, unknown>;

const WEBSITE_TYPES = new Set(['landing_page', 'brochure', 'ecommerce', 'blog', 'portfolio', 'webapp', 'other']);
const STATUSES = new Set(['discovery', 'design', 'development', 'content', 'review', 'testing', 'ready_to_launch', 'live']);
const PAGE_TYPES = new Set(['home', 'about', 'services', 'portfolio', 'blog', 'contact', 'legal', 'standard', 'custom']);
const PAGE_STATUSES = new Set(['pending', 'in_progress', 'done']);
const CHECKLIST_CATEGORIES = new Set(['design', 'content', 'seo', 'performance', 'security', 'legal', 'testing']);

// Default checklist items per category
const DEFAULT_CHECKLIST: Array<{ category: string; item_description: string; sort_order: number }> = [
  // design
  { category: 'design', item_description: 'Responsive su mobile, tablet e desktop', sort_order: 0 },
  { category: 'design', item_description: 'Favicon e icone configurati', sort_order: 1 },
  { category: 'design', item_description: 'Tutti i font caricati correttamente', sort_order: 2 },
  { category: 'design', item_description: 'Dark mode testata (se prevista)', sort_order: 3 },
  // content
  { category: 'content', item_description: 'Tutti i testi finalizzati e approvati', sort_order: 0 },
  { category: 'content', item_description: 'Immagini ottimizzate (WebP, dimensioni corrette)', sort_order: 1 },
  { category: 'content', item_description: 'Pagina 404 personalizzata', sort_order: 2 },
  { category: 'content', item_description: 'Privacy Policy e Cookie Policy aggiornate', sort_order: 3 },
  // seo
  { category: 'seo', item_description: 'Meta title e description su tutte le pagine', sort_order: 0 },
  { category: 'seo', item_description: 'Open Graph tags configurati', sort_order: 1 },
  { category: 'seo', item_description: 'Sitemap XML generata e sottomessa', sort_order: 2 },
  { category: 'seo', item_description: 'Robots.txt configurato', sort_order: 3 },
  // performance
  { category: 'performance', item_description: 'Lighthouse score > 90 su Performance', sort_order: 0 },
  { category: 'performance', item_description: 'Core Web Vitals nella norma', sort_order: 1 },
  { category: 'performance', item_description: 'CDN configurato', sort_order: 2 },
  { category: 'performance', item_description: 'Caching headers impostati', sort_order: 3 },
  // security
  { category: 'security', item_description: 'HTTPS attivo e certificato SSL valido', sort_order: 0 },
  { category: 'security', item_description: 'Headers di sicurezza configurati (CSP, HSTS)', sort_order: 1 },
  { category: 'security', item_description: 'Form con CAPTCHA o protezione spam', sort_order: 2 },
  { category: 'security', item_description: 'Credenziali admin cambiate dai default', sort_order: 3 },
  // legal
  { category: 'legal', item_description: 'Cookie banner implementato e conforme GDPR', sort_order: 0 },
  { category: 'legal', item_description: 'Termini e condizioni presenti', sort_order: 1 },
  { category: 'legal', item_description: 'Dati aziendali corretti in footer', sort_order: 2 },
  { category: 'legal', item_description: 'Analytics anonimizzato o con consenso', sort_order: 3 },
  // testing
  { category: 'testing', item_description: 'Tutti i form testati e funzionanti', sort_order: 0 },
  { category: 'testing', item_description: 'Link interni ed esterni verificati', sort_order: 1 },
  { category: 'testing', item_description: 'Cross-browser testing (Chrome, Firefox, Safari)', sort_order: 2 },
  { category: 'testing', item_description: 'Integrazione analytics verificata', sort_order: 3 },
];

// =====================================================
// GET /api/websites
// =====================================================
websites.get('/', async (c) => {
  const { project_id, status, website_type } = c.req.query();

  const projectFilter = project_id ? sql`AND wp.project_id = ${project_id}` : sql``;
  const statusFilter = status ? sql`AND wp.status = ${status}` : sql``;
  const typeFilter = website_type ? sql`AND wp.website_type = ${website_type}` : sql``;

  const rows = await sql`
    SELECT
      wp.*,
      cp.name AS project_name,
      cu.id AS customer_id,
      cu.contact_name AS customer_name,
      cu.company_name AS customer_company,
      (SELECT COUNT(*)::int FROM website_pages p WHERE p.website_project_id = wp.id) AS page_count,
      (SELECT COUNT(*)::int FROM website_launch_checklist_items i WHERE i.website_project_id = wp.id AND i.is_completed = true) AS checklist_done,
      (SELECT COUNT(*)::int FROM website_launch_checklist_items i WHERE i.website_project_id = wp.id) AS checklist_total
    FROM website_projects wp
    LEFT JOIN client_projects cp ON cp.id = wp.project_id
    LEFT JOIN customers cu ON cu.id = cp.customer_id
    WHERE 1=1
      ${projectFilter}
      ${statusFilter}
      ${typeFilter}
    ORDER BY wp.created_at DESC
  ` as Row[];

  return c.json({ websites: rows });
});

// =====================================================
// POST /api/websites
// =====================================================
websites.post('/', async (c) => {
  const body = await c.req.json();
  const {
    project_id, quote_id, website_type, cms_choice, domain,
    staging_url, production_url, hosting_provider, status = 'discovery',
    estimated_completion, notes,
  } = body;

  if (!website_type || !WEBSITE_TYPES.has(website_type)) {
    return c.json({ error: 'website_type non valido' }, 400);
  }

  const rows = await sql`
    INSERT INTO website_projects
      (project_id, quote_id, website_type, cms_choice, domain, staging_url, production_url,
       hosting_provider, status, estimated_completion, notes)
    VALUES
      (${project_id || null}, ${quote_id || null}, ${website_type}, ${cms_choice || null},
       ${domain || null}, ${staging_url || null}, ${production_url || null},
       ${hosting_provider || null}, ${status}, ${estimated_completion || null}, ${notes || null})
    RETURNING *
  ` as Row[];

  return c.json({ website: rows[0] }, 201);
});

// =====================================================
// GET /api/websites/:id
// =====================================================
websites.get('/:id', async (c) => {
  const { id } = c.req.param();

  const rows = await sql`
    SELECT
      wp.*,
      cp.name AS project_name,
      cu.id AS customer_id,
      cu.contact_name AS customer_name,
      cu.company_name AS customer_company,
      (SELECT json_agg(p ORDER BY p.sort_order) FROM website_pages p WHERE p.website_project_id = wp.id) AS pages,
      (SELECT json_agg(i ORDER BY i.category, i.sort_order) FROM website_launch_checklist_items i WHERE i.website_project_id = wp.id) AS checklist
    FROM website_projects wp
    LEFT JOIN client_projects cp ON cp.id = wp.project_id
    LEFT JOIN customers cu ON cu.id = cp.customer_id
    WHERE wp.id = ${id}
  ` as Row[];

  if (!rows.length) return c.json({ error: 'Not found' }, 404);
  return c.json({ website: rows[0] });
});

// =====================================================
// PATCH /api/websites/:id
// =====================================================
websites.patch('/:id', async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();

  const allowedFields = [
    'website_type', 'cms_choice', 'domain', 'staging_url', 'production_url',
    'hosting_provider', 'status', 'estimated_completion', 'notes', 'project_id', 'quote_id',
  ];

  if (body.status && !STATUSES.has(body.status)) {
    return c.json({ error: 'status non valido' }, 400);
  }

  // Build update dynamically
  const updates: Record<string, unknown> = {};
  for (const f of allowedFields) {
    if (f in body) updates[f] = body[f];
  }

  if (!Object.keys(updates).length) return c.json({ error: 'Nessun campo da aggiornare' }, 400);

  // We use a simple approach: fetch + update
  const rows = await sql`
    UPDATE website_projects SET
      website_type = COALESCE(${updates.website_type as string ?? null}, website_type),
      cms_choice = COALESCE(${updates.cms_choice as string ?? null}, cms_choice),
      domain = COALESCE(${updates.domain as string ?? null}, domain),
      staging_url = COALESCE(${updates.staging_url as string ?? null}, staging_url),
      production_url = COALESCE(${updates.production_url as string ?? null}, production_url),
      hosting_provider = COALESCE(${updates.hosting_provider as string ?? null}, hosting_provider),
      status = COALESCE(${updates.status as string ?? null}, status),
      estimated_completion = COALESCE(${updates.estimated_completion as string ?? null}, estimated_completion),
      notes = COALESCE(${updates.notes as string ?? null}, notes)
    WHERE id = ${id}
    RETURNING *
  ` as Row[];

  if (!rows.length) return c.json({ error: 'Not found' }, 404);
  return c.json({ website: rows[0] });
});

// =====================================================
// DELETE /api/websites/:id
// =====================================================
websites.delete('/:id', async (c) => {
  const { id } = c.req.param();
  await sql`DELETE FROM website_projects WHERE id = ${id}`;
  return c.json({ success: true });
});

// =====================================================
// GET /api/websites/:id/pages
// =====================================================
websites.get('/:id/pages', async (c) => {
  const { id } = c.req.param();
  const rows = await sql`
    SELECT * FROM website_pages WHERE website_project_id = ${id} ORDER BY sort_order, created_at
  ` as Row[];
  return c.json({ pages: rows });
});

// =====================================================
// POST /api/websites/:id/pages
// =====================================================
websites.post('/:id/pages', async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();
  const {
    page_name, page_slug, page_type = 'standard',
    sort_order = 0, due_date, notes,
  } = body;

  if (!page_name || !page_slug) return c.json({ error: 'page_name e page_slug obbligatori' }, 400);
  if (!PAGE_TYPES.has(page_type)) return c.json({ error: 'page_type non valido' }, 400);

  const rows = await sql`
    INSERT INTO website_pages (website_project_id, page_name, page_slug, page_type, sort_order, due_date, notes)
    VALUES (${id}, ${page_name}, ${page_slug}, ${page_type}, ${sort_order}, ${due_date || null}, ${notes || null})
    RETURNING *
  ` as Row[];

  return c.json({ page: rows[0] }, 201);
});

// =====================================================
// PATCH /api/websites/:id/pages/:pageId
// =====================================================
websites.patch('/:id/pages/:pageId', async (c) => {
  const { pageId } = c.req.param();
  const body = await c.req.json();
  const {
    page_name, page_slug, page_type,
    content_status, design_status, dev_status, seo_status,
    sort_order, due_date, notes,
  } = body;

  for (const s of [content_status, design_status, dev_status, seo_status]) {
    if (s && !PAGE_STATUSES.has(s)) return c.json({ error: `Status non valido: ${s}` }, 400);
  }

  const rows = await sql`
    UPDATE website_pages SET
      page_name = COALESCE(${page_name ?? null}, page_name),
      page_slug = COALESCE(${page_slug ?? null}, page_slug),
      page_type = COALESCE(${page_type ?? null}, page_type),
      content_status = COALESCE(${content_status ?? null}, content_status),
      design_status = COALESCE(${design_status ?? null}, design_status),
      dev_status = COALESCE(${dev_status ?? null}, dev_status),
      seo_status = COALESCE(${seo_status ?? null}, seo_status),
      sort_order = COALESCE(${sort_order ?? null}, sort_order),
      due_date = COALESCE(${due_date ?? null}, due_date),
      notes = COALESCE(${notes ?? null}, notes)
    WHERE id = ${pageId}
    RETURNING *
  ` as Row[];

  if (!rows.length) return c.json({ error: 'Not found' }, 404);
  return c.json({ page: rows[0] });
});

// =====================================================
// DELETE /api/websites/:id/pages/:pageId
// =====================================================
websites.delete('/:id/pages/:pageId', async (c) => {
  const { pageId } = c.req.param();
  await sql`DELETE FROM website_pages WHERE id = ${pageId}`;
  return c.json({ success: true });
});

// =====================================================
// POST /api/websites/:id/checklist/seed
// =====================================================
websites.post('/:id/checklist/seed', async (c) => {
  const { id } = c.req.param();

  // Check if already seeded
  const existing = await sql`
    SELECT COUNT(*)::int AS cnt FROM website_launch_checklist_items WHERE website_project_id = ${id}
  ` as Array<{ cnt: number }>;

  if (existing[0].cnt > 0) {
    return c.json({ error: 'Checklist già presente. Elimina gli item esistenti prima di ri-generare.' }, 400);
  }

  const values = DEFAULT_CHECKLIST.map(item => ({
    website_project_id: id,
    category: item.category,
    item_description: item.item_description,
    sort_order: item.sort_order,
  }));

  await sql`INSERT INTO website_launch_checklist_items ${sql(values)}`;

  const rows = await sql`
    SELECT * FROM website_launch_checklist_items WHERE website_project_id = ${id} ORDER BY category, sort_order
  ` as Row[];

  return c.json({ checklist: rows }, 201);
});

// =====================================================
// PATCH /api/websites/:id/checklist/:itemId
// =====================================================
websites.patch('/:id/checklist/:itemId', async (c) => {
  const { itemId } = c.req.param();
  const { is_completed, notes } = await c.req.json();

  const rows = await sql`
    UPDATE website_launch_checklist_items SET
      is_completed = COALESCE(${is_completed ?? null}, is_completed),
      completed_at = CASE WHEN ${is_completed ?? null} = true THEN NOW() WHEN ${is_completed ?? null} = false THEN NULL ELSE completed_at END,
      notes = COALESCE(${notes ?? null}, notes)
    WHERE id = ${itemId}
    RETURNING *
  ` as Row[];

  if (!rows.length) return c.json({ error: 'Not found' }, 404);
  return c.json({ item: rows[0] });
});

// =====================================================
// GET /api/websites/:id/readiness
// =====================================================
websites.get('/:id/readiness', async (c) => {
  const { id } = c.req.param();

  const rows = await sql`
    SELECT
      category,
      COUNT(*)::int AS total,
      SUM(CASE WHEN is_completed THEN 1 ELSE 0 END)::int AS done
    FROM website_launch_checklist_items
    WHERE website_project_id = ${id}
    GROUP BY category
    ORDER BY category
  ` as Array<{ category: string; total: number; done: number }>;

  const totalItems = rows.reduce((a, r) => a + r.total, 0);
  const doneItems = rows.reduce((a, r) => a + r.done, 0);
  const pct = totalItems > 0 ? Math.round((doneItems / totalItems) * 100) : 0;

  return c.json({
    pct,
    ready: doneItems,
    total: totalItems,
    by_category: rows,
  });
});
