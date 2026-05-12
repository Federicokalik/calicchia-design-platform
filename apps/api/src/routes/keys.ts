import { Hono } from 'hono';
import { sql } from '../db';
import { randomBytes, createHash } from 'crypto';

export const keys = new Hono();

keys.get('/', async (c) => {
  const keys = await sql`
    SELECT id, name, description, key_prefix, scopes, rate_limit_per_minute,
           is_active, expires_at, last_used_at, usage_count, created_at
    FROM api_keys
    ORDER BY created_at DESC
  `;
  return c.json(keys);
});

keys.post('/', async (c) => {
  const { name, description, scopes, rate_limit_per_minute, expires_in_days } = await c.req.json();

  if (!name) {
    return c.json({ error: 'Nome richiesto' }, 400);
  }

  const key = `sk_${randomBytes(32).toString('hex')}`;
  const keyPrefix = key.substring(0, 12);
  const keyHash = createHash('sha256').update(key).digest('hex');

  let expiresAt: string | null = null;
  if (expires_in_days) {
    const d = new Date();
    d.setDate(d.getDate() + expires_in_days);
    expiresAt = d.toISOString();
  }

  const [apiKey] = await sql`
    INSERT INTO api_keys (name, description, key_hash, key_prefix, scopes, rate_limit_per_minute, expires_at, is_active)
    VALUES (${name}, ${description || null}, ${keyHash}, ${keyPrefix}, ${scopes || []}, ${rate_limit_per_minute || 60}, ${expiresAt}, true)
    RETURNING id, name, key_prefix
  `;

  return c.json({ key, id: apiKey.id, name: apiKey.name, key_prefix: apiKey.key_prefix }, 201);
});

keys.delete('/', async (c) => {
  const { id, revoke } = await c.req.json();
  if (!id) return c.json({ error: 'ID richiesto' }, 400);

  if (revoke) {
    await sql`UPDATE api_keys SET is_active = false WHERE id = ${id}`;
    return c.json({ success: true, message: 'Chiave revocata' });
  } else {
    await sql`DELETE FROM api_keys WHERE id = ${id}`;
    return c.json({ success: true, message: 'Chiave eliminata' });
  }
});

keys.delete('/:id', async (c) => {
  await sql`DELETE FROM api_keys WHERE id = ${c.req.param('id')}`;
  return c.json({ success: true });
});
