import { Hono } from 'hono';
import { sql } from '../db';

export const deliverables = new Hono();

type DeliverableRow = Record<string, unknown>;

// -----------------------------------------------
// GET /api/deliverables — list with filters
// -----------------------------------------------
deliverables.get('/', async (c) => {
  const { project_id, quote_id, status } = c.req.query();

  const projectFilter = project_id ? sql`AND pd.project_id = ${project_id}` : sql``;
  const quoteFilter = quote_id ? sql`AND pd.quote_id = ${quote_id}` : sql``;
  const statusFilter = status ? sql`AND pd.status = ${status}` : sql``;

  const rows = await sql`
    SELECT
      pd.*,
      cp.name AS project_name,
      cu.id AS customer_id,
      cu.contact_name AS customer_name,
      cu.company_name AS customer_company,
      (
        SELECT json_agg(v ORDER BY v.version_number)
        FROM deliverable_versions v
        WHERE v.deliverable_id = pd.id
      ) AS versions,
      (
        SELECT COUNT(*)::int FROM deliverable_feedback f
        WHERE f.deliverable_id = pd.id AND f.is_resolved = false
      ) AS open_feedback_count
    FROM project_deliverables pd
    LEFT JOIN client_projects cp ON cp.id = pd.project_id
    LEFT JOIN customers cu ON cu.id = cp.customer_id
    WHERE 1=1
      ${projectFilter}
      ${quoteFilter}
      ${statusFilter}
    ORDER BY pd.sort_order, pd.created_at DESC
  ` as DeliverableRow[];

  return c.json({ deliverables: rows });
});

// -----------------------------------------------
// GET /api/deliverables/:id
// -----------------------------------------------
deliverables.get('/:id', async (c) => {
  const { id } = c.req.param();

  const rows = await sql`
    SELECT
      pd.*,
      cp.name AS project_name,
      cu.id AS customer_id,
      cu.contact_name AS customer_name,
      cu.company_name AS customer_company,
      (
        SELECT json_agg(v ORDER BY v.version_number)
        FROM deliverable_versions v
        WHERE v.deliverable_id = pd.id
      ) AS versions,
      (
        SELECT json_agg(f ORDER BY f.created_at)
        FROM deliverable_feedback f
        WHERE f.deliverable_id = pd.id
      ) AS feedback
    FROM project_deliverables pd
    LEFT JOIN client_projects cp ON cp.id = pd.project_id
    LEFT JOIN customers cu ON cu.id = cp.customer_id
    WHERE pd.id = ${id}
  ` as DeliverableRow[];

  if (!rows.length) return c.json({ error: 'Not found' }, 404);
  return c.json({ deliverable: rows[0] });
});

// -----------------------------------------------
// POST /api/deliverables
// -----------------------------------------------
deliverables.post('/', async (c) => {
  const body = await c.req.json();
  const {
    project_id, quote_id, title, description,
    deliverable_type = 'design', status = 'pending',
    revision_limit = 2, sort_order = 0, due_date,
  } = body;

  if (!title) return c.json({ error: 'title required' }, 400);
  if (!project_id) return c.json({ error: 'project_id required' }, 400);

  const insertData: Record<string, unknown> = {
    project_id,
    title,
    deliverable_type,
    status,
    revision_limit,
    sort_order,
  };
  if (quote_id) insertData.quote_id = quote_id;
  if (description) insertData.description = description;
  if (due_date) insertData.due_date = due_date;

  const rows = await sql`INSERT INTO project_deliverables ${sql(insertData)} RETURNING *` as DeliverableRow[];
  return c.json({ deliverable: rows[0] }, 201);
});

// -----------------------------------------------
// PATCH /api/deliverables/:id
// -----------------------------------------------
deliverables.patch('/:id', async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();

  const allowed = [
    'title', 'description', 'deliverable_type', 'status',
    'revision_limit', 'sort_order', 'due_date',
  ];
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) updates[key] = body[key];
  }

  // Auto-set timestamps on status transitions
  if (updates.status === 'delivered' && !updates['delivered_at']) {
    updates['delivered_at'] = new Date().toISOString();
  }
  if (updates.status === 'approved' && !updates['approved_at']) {
    updates['approved_at'] = new Date().toISOString();
  }

  if (!Object.keys(updates).length) return c.json({ error: 'No valid fields' }, 400);
  updates.updated_at = new Date().toISOString();

  const rows = await sql`
    UPDATE project_deliverables SET ${sql(updates)} WHERE id = ${id} RETURNING *
  ` as DeliverableRow[];
  if (!rows.length) return c.json({ error: 'Not found' }, 404);
  return c.json({ deliverable: rows[0] });
});

// -----------------------------------------------
// DELETE /api/deliverables/:id
// -----------------------------------------------
deliverables.delete('/:id', async (c) => {
  const { id } = c.req.param();
  const rows = await sql`DELETE FROM project_deliverables WHERE id = ${id} RETURNING id` as DeliverableRow[];
  if (!rows.length) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

// =====================================================
// VERSIONS
// =====================================================

// POST /api/deliverables/:id/versions — upload new version
deliverables.post('/:id/versions', async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();
  const { title, notes, file_url, file_name, file_size, mime_type, preview_url } = body;

  if (!file_url) return c.json({ error: 'file_url required' }, 400);

  // Get next version number
  const existing = await sql`
    SELECT COALESCE(MAX(version_number), 0) AS max_v
    FROM deliverable_versions WHERE deliverable_id = ${id}
  ` as Array<{ max_v: number }>;
  const nextVersion = (existing[0]?.max_v ?? 0) + 1;

  // Mark previous versions as not current
  await sql`UPDATE deliverable_versions SET is_current = false WHERE deliverable_id = ${id}`;

  const insertData: Record<string, unknown> = {
    deliverable_id: id,
    version_number: nextVersion,
    file_url,
    is_current: true,
  };
  if (title) insertData.title = title;
  if (notes) insertData.notes = notes;
  if (file_name) insertData.file_name = file_name;
  if (file_size !== undefined) insertData.file_size = file_size;
  if (mime_type) insertData.mime_type = mime_type;
  if (preview_url) insertData.preview_url = preview_url;

  const rows = await sql`INSERT INTO deliverable_versions ${sql(insertData)} RETURNING *` as DeliverableRow[];

  // Update deliverable status to client_review and increment revision count
  await sql`
    UPDATE project_deliverables
    SET status = 'client_review', revision_count = revision_count + 1, updated_at = NOW()
    WHERE id = ${id} AND status NOT IN ('approved', 'delivered')
  `;

  return c.json({ version: rows[0] }, 201);
});

// =====================================================
// FEEDBACK
// =====================================================

// GET /api/deliverables/:id/feedback
deliverables.get('/:id/feedback', async (c) => {
  const { id } = c.req.param();
  const rows = await sql`
    SELECT * FROM deliverable_feedback
    WHERE deliverable_id = ${id}
    ORDER BY created_at DESC
  ` as DeliverableRow[];
  return c.json({ feedback: rows });
});

// POST /api/deliverables/:id/feedback
deliverables.post('/:id/feedback', async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();
  const {
    version_id, author_type = 'client', author_name,
    feedback_text, feedback_type = 'revision',
  } = body;

  if (!feedback_text) return c.json({ error: 'feedback_text required' }, 400);

  const insertData: Record<string, unknown> = {
    deliverable_id: id,
    author_type,
    feedback_text,
    feedback_type,
  };
  if (version_id) insertData.version_id = version_id;
  if (author_name) insertData.author_name = author_name;

  const rows = await sql`INSERT INTO deliverable_feedback ${sql(insertData)} RETURNING *` as DeliverableRow[];

  // If feedback is a revision request, update deliverable status
  if (feedback_type === 'revision') {
    await sql`
      UPDATE project_deliverables
      SET status = 'revision_requested', updated_at = NOW()
      WHERE id = ${id} AND status = 'client_review'
    `;
  }
  // If approval, update status
  if (feedback_type === 'approval') {
    await sql`
      UPDATE project_deliverables
      SET status = 'approved', approved_at = NOW(), updated_at = NOW()
      WHERE id = ${id}
    `;
  }

  return c.json({ feedback: rows[0] }, 201);
});

// PATCH /api/deliverables/feedback/:feedbackId/resolve
deliverables.patch('/feedback/:feedbackId/resolve', async (c) => {
  const { feedbackId } = c.req.param();
  const rows = await sql`
    UPDATE deliverable_feedback SET is_resolved = true WHERE id = ${feedbackId} RETURNING *
  ` as DeliverableRow[];
  if (!rows.length) return c.json({ error: 'Not found' }, 404);
  return c.json({ feedback: rows[0] });
});
