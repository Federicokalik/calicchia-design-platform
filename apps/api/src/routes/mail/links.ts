import { Hono } from 'hono';
import { sql } from '../../db';
import { extractToken } from '../../middleware/auth';
import { jwtVerify } from 'jose';
import { getJwtSecret } from '../../lib/jwt';

export const mailLinks = new Hono();

async function getUserId(c: any): Promise<string | null> {
  const token = extractToken(c);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    return payload.sub as string;
  } catch {
    return null;
  }
}

const VALID_ENTITY_TYPES = ['cliente', 'lead', 'preventivo', 'progetto', 'collaboratore'] as const;
type EntityType = typeof VALID_ENTITY_TYPES[number];

// GET /api/mail/links/entity/:type/:id — messages linked to a CRM entity
mailLinks.get('/entity/:type/:id', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const type = c.req.param('type') as EntityType;
  const id = c.req.param('id');

  if (!VALID_ENTITY_TYPES.includes(type)) {
    return c.json({ error: 'entity_type non valido' }, 400);
  }

  const rows = await sql`
    SELECT m.id, m.from_addr, m.from_name, m.subject, m.snippet, m.received_at, m.flags,
           l.auto AS link_auto
    FROM email_links l
    JOIN email_messages m ON m.id = l.message_id
    JOIN email_accounts a ON a.id = m.account_id AND a.user_id = ${userId}
    WHERE l.entity_type = ${type} AND l.entity_id = ${id}
    ORDER BY m.received_at DESC NULLS LAST
    LIMIT 100
  `;

  return c.json({ messages: rows });
});

// POST /api/mail/links — manually link a message to an entity
// Body: { message_id, entity_type, entity_id }
mailLinks.post('/', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const body = await c.req.json();
  const { message_id, entity_type, entity_id } = body;

  if (!VALID_ENTITY_TYPES.includes(entity_type)) {
    return c.json({ error: 'entity_type non valido' }, 400);
  }
  if (!message_id || !entity_id) {
    return c.json({ error: 'message_id ed entity_id richiesti' }, 400);
  }

  // Verify the message belongs to the user
  const [msg] = await sql`
    SELECT m.id FROM email_messages m
    JOIN email_accounts a ON a.id = m.account_id AND a.user_id = ${userId}
    WHERE m.id = ${message_id}
    LIMIT 1
  `;
  if (!msg) return c.json({ error: 'Messaggio non trovato' }, 404);

  const [link] = await sql`
    INSERT INTO email_links (message_id, entity_type, entity_id, auto)
    VALUES (${message_id}, ${entity_type}, ${entity_id}, false)
    ON CONFLICT (message_id, entity_type, entity_id) DO UPDATE SET auto = false
    RETURNING *
  `;
  return c.json({ link }, 201);
});

// DELETE /api/mail/links/:id
mailLinks.delete('/:id', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const id = c.req.param('id');
  const res = await sql`
    DELETE FROM email_links
    WHERE id = ${id}
      AND message_id IN (
        SELECT m.id FROM email_messages m
        JOIN email_accounts a ON a.id = m.account_id AND a.user_id = ${userId}
      )
    RETURNING id
  `;
  if (res.length === 0) return c.json({ error: 'Link non trovato' }, 404);
  return c.json({ success: true });
});
