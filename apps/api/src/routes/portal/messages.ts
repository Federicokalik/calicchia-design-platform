import { Hono } from 'hono';
import { sql } from '../../db';
import { fail } from '../../lib/responses';
import { portalAuth, type PortalEnv } from './auth';

export const messagesRoutes = new Hono<PortalEnv>();

// ── Get messages for a project ───────────────────────────
messagesRoutes.get('/projects/:id/messages', portalAuth, async (c) => {
  const customerId = c.get('customer_id') as string;
  const projectId = c.req.param('id');
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') || '50')));
  const before = c.req.query('before'); // cursor-based pagination

  // Verify project belongs to customer
  const [project] = await sql`
    SELECT id FROM client_projects
    WHERE id = ${projectId} AND customer_id = ${customerId} AND visible_to_client = true
    LIMIT 1
  ` as Array<{ id: string }>;

  if (!project) return c.json({ error: 'Progetto non trovato' }, 404);

  const beforeFilter = before
    ? sql`AND pc.created_at < ${before}`
    : sql``;

  const messages = await sql`
    SELECT pc.id, pc.content, pc.sender_name, pc.is_internal,
           pc.created_at, pc.updated_at,
           CASE
             WHEN pc.customer_id IS NOT NULL THEN 'client'
             ELSE 'admin'
           END AS sender_type,
           pc.attachments
    FROM project_comments pc
    WHERE pc.project_id = ${projectId}
      AND pc.is_internal = false
      ${beforeFilter}
    ORDER BY pc.created_at DESC
    LIMIT ${limit}
  ` as Array<Record<string, unknown>>;

  // Mark admin messages as read
  await sql`
    UPDATE project_comments SET is_read = true
    WHERE project_id = ${projectId}
      AND customer_id IS NULL
      AND is_internal = false
      AND is_read = false
  `;

  return c.json({ messages: messages.reverse() }); // chronological order
});

// ── Send a message as client ─────────────────────────────
messagesRoutes.post('/projects/:id/messages', portalAuth, async (c) => {
  const customerId = c.get('customer_id') as string;
  const projectId = c.req.param('id');
  const { content, attachment_url, attachment_name } = await c.req.json();

  if (!content?.trim()) fail('Il messaggio non puo\' essere vuoto', 400);
  if (content.length > 5000) fail('Messaggio troppo lungo (max 5000 caratteri)', 400);
  if (attachment_url && !/^https?:\/\//.test(attachment_url)) fail('URL allegato non valido', 400);

  // Verify project belongs to customer
  const [project] = await sql`
    SELECT cp.id, cp.name FROM client_projects cp
    WHERE cp.id = ${projectId} AND cp.customer_id = ${customerId} AND cp.visible_to_client = true
    LIMIT 1
  ` as Array<{ id: string; name: string }>;

  if (!project) fail('Progetto non trovato', 404);

  // Get customer name
  const [customer] = await sql`
    SELECT contact_name, company_name FROM customers WHERE id = ${customerId} LIMIT 1
  ` as Array<{ contact_name: string; company_name: string }>;

  const senderName = customer?.contact_name || 'Cliente';

  const attachments = attachment_url
    ? JSON.stringify([{ url: attachment_url, name: attachment_name || 'Allegato' }])
    : null;

  const [message] = await sql`
    INSERT INTO project_comments (project_id, customer_id, content, sender_name, is_internal, attachments)
    VALUES (${projectId}, ${customerId}, ${content.trim()}, ${senderName}, false, ${attachments})
    RETURNING id, content, sender_name, created_at
  ` as Array<Record<string, unknown>>;

  // Create timeline event
  await sql`
    INSERT INTO timeline_events (project_id, customer_id, type, title, description, actor_type)
    VALUES (${projectId}, ${customerId}, 'message', ${'Messaggio da ' + senderName}, ${content.trim().substring(0, 200)}, 'client')
  `;

  // Send Telegram notification
  try {
    const { notifyTelegram } = await import('../../lib/telegram');
    await notifyTelegram(
      'Nuovo messaggio dal cliente',
      `Cliente: ${customer?.company_name || senderName}\nProgetto: ${project.name}\n"${content.trim().substring(0, 300)}"`
    );
  } catch { /* non-blocking */ }

  return c.json({ message: { ...message, sender_type: 'client' } }, 201);
});
