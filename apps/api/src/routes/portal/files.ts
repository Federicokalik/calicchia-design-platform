import { Hono } from 'hono';
import { sql } from '../../db';
import { portalAuth, type PortalEnv } from './auth';

export const filesRoutes = new Hono<PortalEnv>();

// ── List all files uploaded by this customer ─────────────
filesRoutes.get('/', portalAuth, async (c) => {
  const customerId = c.get('customer_id') as string;
  const projectId = c.req.query('project_id');
  const page = Math.max(1, Number(c.req.query('page') || '1'));
  const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') || '20')));
  const offset = (page - 1) * limit;

  const projectFilter = projectId
    ? sql`AND cu.project_id = ${projectId}`
    : sql``;

  const files = await sql`
    SELECT cu.id, cu.key, cu.original_name, cu.content_type, cu.size, cu.status,
           cu.project_id, cu.uploaded_at,
           cp.name AS project_name
    FROM client_uploads cu
    LEFT JOIN client_projects cp ON cp.id = cu.project_id
    WHERE cu.customer_id = ${customerId}
      AND cu.status != 'deleted'
      ${projectFilter}
    ORDER BY cu.uploaded_at DESC
    LIMIT ${limit} OFFSET ${offset}
  ` as Array<Record<string, unknown>>;

  const [countResult] = await sql`
    SELECT COUNT(*) AS total FROM client_uploads
    WHERE customer_id = ${customerId} AND status != 'deleted'
    ${projectFilter}
  ` as Array<{ total: string }>;

  return c.json({
    files,
    pagination: {
      page, limit,
      total: Number(countResult?.total || 0),
      total_pages: Math.ceil(Number(countResult?.total || 0) / limit),
    },
  });
});
