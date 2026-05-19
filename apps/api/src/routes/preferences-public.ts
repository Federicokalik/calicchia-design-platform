/**
 * Public preferences endpoint — accesso senza login tramite preferences_token.
 *
 * Pattern: come il link unsubscribe della newsletter (newsletter.ts:50-62), ma
 * granulare per canale/categoria. Rate limit applicato in app.ts.
 *
 * GET   /api/preferences/:token  → ritorna riga corrente (404 se token invalido)
 * PATCH /api/preferences/:token  → aggiorna toggle (transactional non scrivibile)
 */

import { Hono } from 'hono';
import { sql } from '../db';

export const preferencesPublic = new Hono();

const TOKEN_RE = /^[a-f0-9]{48}$/i;

interface PrefsRow {
  id: string;
  whatsapp_transactional: boolean;
  whatsapp_operational: boolean;
  whatsapp_marketing: boolean;
  email_operational: boolean;
  email_marketing: boolean;
  sms_transactional: boolean;
  preferences_token: string;
}

preferencesPublic.get('/:token', async (c) => {
  const token = c.req.param('token');
  if (!TOKEN_RE.test(token)) return c.json({ error: 'Not Found' }, 404);
  const rows = await sql`
    SELECT id, whatsapp_transactional, whatsapp_operational, whatsapp_marketing,
           email_operational, email_marketing, sms_transactional, preferences_token
    FROM communication_preferences
    WHERE preferences_token = ${token}
    LIMIT 1
  ` as PrefsRow[];
  if (!rows.length) return c.json({ error: 'Not Found' }, 404);
  return c.json({ preferences: rows[0] });
});

preferencesPublic.patch('/:token', async (c) => {
  const token = c.req.param('token');
  if (!TOKEN_RE.test(token)) return c.json({ error: 'Not Found' }, 404);
  const body = await c.req.json().catch(() => ({} as any));
  const allowed = ['whatsapp_operational', 'whatsapp_marketing', 'email_operational', 'email_marketing'] as const;
  const updates: Record<string, boolean> = {};
  for (const key of allowed) {
    if (typeof body[key] === 'boolean') updates[key as string] = body[key];
  }
  if (!Object.keys(updates).length) return c.json({ error: 'no_changes' }, 400);

  const updated = await sql`
    UPDATE communication_preferences
    SET ${sql(updates)}, updated_via = 'public-token', updated_at = now()
    WHERE preferences_token = ${token}
    RETURNING id, whatsapp_transactional, whatsapp_operational, whatsapp_marketing,
              email_operational, email_marketing, sms_transactional, preferences_token
  ` as PrefsRow[];
  if (!updated.length) return c.json({ error: 'Not Found' }, 404);
  return c.json({ preferences: updated[0] });
});
