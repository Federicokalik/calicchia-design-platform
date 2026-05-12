import { Hono } from 'hono';
import { sql } from '../../db';
import { extractToken } from '../../middleware/auth';
import { jwtVerify } from 'jose';
import { getJwtSecret } from '../../lib/jwt';
import { loadUserRules, applyRules } from '../../lib/mail/rules';
import { classifyMail } from '../../lib/mail/classifier';

export const mailRules = new Hono();

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

const VALID_CATEGORIES = ['importanti', 'normali', 'aggiornamenti', 'marketing', 'spam'] as const;

// GET /api/mail/rules — list user rules
mailRules.get('/', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const rules = await sql`
    SELECT id, name, priority, active,
           match_from, match_subject, match_has_unsubscribe,
           set_category, created_at
    FROM email_rules
    WHERE user_id = ${userId}
    ORDER BY priority ASC, created_at ASC
  `;
  return c.json({ rules });
});

// POST /api/mail/rules
mailRules.post('/', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const body = await c.req.json();
  const { name, priority, active, match_from, match_subject, match_has_unsubscribe, set_category } = body;

  if (!name || !set_category) return c.json({ error: 'name e set_category richiesti' }, 400);
  if (!VALID_CATEGORIES.includes(set_category)) return c.json({ error: 'set_category non valido' }, 400);

  if (!match_from && !match_subject && match_has_unsubscribe == null) {
    return c.json({ error: 'Almeno una condizione richiesta (from/subject/unsubscribe)' }, 400);
  }

  const [row] = await sql`
    INSERT INTO email_rules (user_id, name, priority, active, match_from, match_subject, match_has_unsubscribe, set_category)
    VALUES (
      ${userId}, ${name}, ${priority ?? 100}, ${active ?? true},
      ${match_from || null}, ${match_subject || null},
      ${match_has_unsubscribe ?? null},
      ${set_category}
    )
    RETURNING *
  `;
  return c.json({ rule: row }, 201);
});

// PUT /api/mail/rules/:id
mailRules.put('/:id', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const id = c.req.param('id');
  const body = await c.req.json();
  const { name, priority, active, match_from, match_subject, match_has_unsubscribe, set_category } = body;

  if (set_category && !VALID_CATEGORIES.includes(set_category)) {
    return c.json({ error: 'set_category non valido' }, 400);
  }

  const [row] = await sql`
    UPDATE email_rules SET
      name = COALESCE(${name ?? null}, name),
      priority = COALESCE(${priority ?? null}, priority),
      active = COALESCE(${active ?? null}, active),
      match_from = ${match_from !== undefined ? match_from || null : null},
      match_subject = ${match_subject !== undefined ? match_subject || null : null},
      match_has_unsubscribe = ${match_has_unsubscribe !== undefined ? match_has_unsubscribe : null},
      set_category = COALESCE(${set_category ?? null}, set_category),
      updated_at = now()
    WHERE id = ${id} AND user_id = ${userId}
    RETURNING *
  `;
  if (!row) return c.json({ error: 'Regola non trovata' }, 404);
  return c.json({ rule: row });
});

// DELETE /api/mail/rules/:id
mailRules.delete('/:id', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const id = c.req.param('id');
  const res = await sql`DELETE FROM email_rules WHERE id = ${id} AND user_id = ${userId} RETURNING id`;
  if (res.length === 0) return c.json({ error: 'Regola non trovata' }, 404);
  return c.json({ success: true });
});

// POST /api/mail/rules/apply — re-run rules + classifier on all user's messages
mailRules.post('/apply', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const rules = await loadUserRules(userId);

  const rows = await sql<Array<{ id: string; from_addr: string | null; subject: string | null; flags: string[] }>>`
    SELECT m.id, m.from_addr, m.subject, m.flags
    FROM email_messages m
    JOIN email_accounts a ON a.id = m.account_id AND a.user_id = ${userId}
  `;

  const dist: Record<string, number> = {};
  let updated = 0;
  for (const m of rows) {
    const ruleHit = applyRules(
      { fromAddr: m.from_addr, subject: m.subject },
      rules,
    );
    const cat =
      ruleHit ??
      classifyMail({ fromAddr: m.from_addr, subject: m.subject, flags: m.flags });
    dist[cat] = (dist[cat] || 0) + 1;
    const res = await sql`
      UPDATE email_messages SET category = ${cat}
      WHERE id = ${m.id} AND category <> ${cat}
      RETURNING id
    `;
    if (res.length > 0) updated++;
  }

  return c.json({ scanned: rows.length, updated, distribution: dist });
});
