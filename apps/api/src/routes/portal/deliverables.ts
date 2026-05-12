import { Hono } from 'hono';
import { sql } from '../../db';
import { fail } from '../../lib/responses';
import { portalAuth, type PortalEnv } from './auth';

export const deliverableRoutes = new Hono<PortalEnv>();

// ── Approve a deliverable ────────────────────────────────
deliverableRoutes.post('/deliverables/:id/approve', portalAuth, async (c) => {
  const customerId = c.get('customer_id') as string;
  const deliverableId = c.req.param('id');
  const { comment } = await c.req.json().catch(() => ({ comment: '' }));

  // Verify deliverable belongs to customer's project
  const [deliverable] = await sql`
    SELECT pd.id, pd.title, pd.project_id, cp.customer_id, cp.name AS project_name
    FROM project_deliverables pd
    JOIN client_projects cp ON cp.id = pd.project_id
    WHERE pd.id = ${deliverableId}
      AND cp.customer_id = ${customerId}
      AND pd.status = 'client_review'
    LIMIT 1
  ` as Array<Record<string, unknown>>;

  if (!deliverable) fail('Deliverable non trovato o non in revisione', 404);

  const projectId = String(deliverable.project_id);
  const deliverableTitle = String(deliverable.title);
  const projectName = String(deliverable.project_name);

  const customerName = (await sql`
    SELECT contact_name FROM customers WHERE id = ${customerId} LIMIT 1
  ` as Array<{ contact_name: string }>)[0]?.contact_name || 'Cliente';

  const feedbackText = comment || 'Approvato';
  const eventTitle = 'Deliverable approvato: ' + deliverableTitle;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await sql.begin(async (tx: any) => {
    await tx`
      UPDATE project_deliverables
      SET status = 'approved', approved_at = NOW(), updated_at = NOW()
      WHERE id = ${deliverableId}
    `;
    await tx`
      INSERT INTO deliverable_feedback (deliverable_id, author_type, author_name, feedback_text, feedback_type)
      VALUES (${deliverableId}, 'client', ${customerName}, ${feedbackText}, 'approval')
    `;
    await tx`
      INSERT INTO timeline_events (project_id, customer_id, type, title, description, actor_type)
      VALUES (${projectId}, ${customerId}, 'deliverable_approved', ${eventTitle}, ${comment || null}, 'client')
    `;
  });

  // Send Telegram notification
  try {
    const { notifyTelegram } = await import('../../lib/telegram');
    await notifyTelegram(
      'Deliverable approvato',
      `Progetto: ${projectName}\nDeliverable: ${deliverableTitle}${comment ? '\nCommento: ' + comment : ''}`
    );
  } catch { /* non-blocking */ }

  return c.json({ ok: true, status: 'approved' });
});

// ── Reject a deliverable (request revision) ──────────────
deliverableRoutes.post('/deliverables/:id/reject', portalAuth, async (c) => {
  const customerId = c.get('customer_id') as string;
  const deliverableId = c.req.param('id');
  const { comment } = await c.req.json().catch(() => ({ comment: '' }));

  if (!comment?.trim()) {
    fail('Il commento e\' obbligatorio per richiedere modifiche', 400);
  }

  // Verify deliverable belongs to customer's project
  const [deliverable] = await sql`
    SELECT pd.id, pd.title, pd.project_id, pd.revision_count, pd.revision_limit,
           cp.customer_id, cp.name AS project_name
    FROM project_deliverables pd
    JOIN client_projects cp ON cp.id = pd.project_id
    WHERE pd.id = ${deliverableId}
      AND cp.customer_id = ${customerId}
      AND pd.status = 'client_review'
    LIMIT 1
  ` as Array<Record<string, unknown>>;

  if (!deliverable) fail('Deliverable non trovato o non in revisione', 404);

  // Enforce revision limit
  const revLimit = Number(deliverable.revision_limit || 0);
  const revCount = Number(deliverable.revision_count || 0);
  if (revLimit > 0 && revCount >= revLimit) {
    fail(`Limite revisioni raggiunto (${revLimit}/${revLimit})`, 400);
  }

  const projectId = String(deliverable.project_id);
  const deliverableTitle = String(deliverable.title);
  const projectName = String(deliverable.project_name);

  const customerName2 = (await sql`
    SELECT contact_name FROM customers WHERE id = ${customerId} LIMIT 1
  ` as Array<{ contact_name: string }>)[0]?.contact_name || 'Cliente';

  const rejectTitle = 'Modifiche richieste: ' + deliverableTitle;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await sql.begin(async (tx: any) => {
    await tx`
      UPDATE project_deliverables
      SET status = 'revision_requested',
          revision_count = revision_count + 1,
          updated_at = NOW()
      WHERE id = ${deliverableId}
    `;
    await tx`
      INSERT INTO deliverable_feedback (deliverable_id, author_type, author_name, feedback_text, feedback_type)
      VALUES (${deliverableId}, 'client', ${customerName2}, ${comment}, 'revision')
    `;
    await tx`
      INSERT INTO timeline_events (project_id, customer_id, type, title, description, actor_type)
      VALUES (${projectId}, ${customerId}, 'deliverable_rejected', ${rejectTitle}, ${comment}, 'client')
    `;
  });

  // Send Telegram notification
  try {
    const { notifyTelegram } = await import('../../lib/telegram');
    await notifyTelegram(
      'Modifiche richieste',
      `Progetto: ${projectName}\nDeliverable: ${deliverableTitle}\nCommento: ${comment}`
    );
  } catch { /* non-blocking */ }

  return c.json({ ok: true, status: 'revision_requested' });
});
