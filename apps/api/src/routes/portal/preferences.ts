/**
 * Portal route — preferenze di comunicazione del cliente loggato.
 * Auth: portalAuth (cookie portal_token, JWT con sv).
 *
 * GET   /api/portal/preferences  → ritorna riga communication_preferences
 *                                  (auto-create se manca).
 * PATCH /api/portal/preferences  → aggiorna solo i campi opt-out toggleable.
 *                                  whatsapp_transactional NON modificabile.
 */

import { Hono } from 'hono';
import { sql } from '../../db';
import { portalClientAuth, type PortalEnv } from './auth';

export const preferencesRoutes = new Hono<PortalEnv>();

interface PrefsRow {
  id: string;
  whatsapp_transactional: boolean;
  whatsapp_operational: boolean;
  whatsapp_marketing: boolean;
  email_operational: boolean;
  email_marketing: boolean;
  sms_transactional: boolean;
  preferences_token: string;
  updated_at: Date;
  updated_via: string | null;
}

async function ensureRow(customerId: string): Promise<PrefsRow> {
  const existing = await sql`
    SELECT id, whatsapp_transactional, whatsapp_operational, whatsapp_marketing,
           email_operational, email_marketing, sms_transactional,
           preferences_token, updated_at, updated_via
    FROM communication_preferences
    WHERE customer_id = ${customerId}
    LIMIT 1
  ` as PrefsRow[];
  if (existing[0]) return existing[0];

  // Inseriamo collegando il phone del cliente se disponibile (per cross-match
  // con i flussi STOP via WA e con il public token lookup).
  const cust = await sql`SELECT phone, email FROM customers WHERE id = ${customerId} LIMIT 1` as Array<{ phone: string | null; email: string | null }>;
  const phone = (cust[0]?.phone || '').replace(/[^0-9]/g, '') || null;
  const email = cust[0]?.email || null;
  const inserted = await sql`
    INSERT INTO communication_preferences (customer_id, phone, email)
    VALUES (${customerId}, ${phone}, ${email})
    RETURNING id, whatsapp_transactional, whatsapp_operational, whatsapp_marketing,
              email_operational, email_marketing, sms_transactional,
              preferences_token, updated_at, updated_via
  ` as PrefsRow[];
  return inserted[0];
}

preferencesRoutes.get('/', portalClientAuth, async (c) => {
  const customerId = c.get('customer_id') as string;
  const row = await ensureRow(customerId);
  return c.json({ preferences: row });
});

preferencesRoutes.patch('/', portalClientAuth, async (c) => {
  const customerId = c.get('customer_id') as string;
  const body = await c.req.json().catch(() => ({} as any));

  // Whitelist dei campi accettati. whatsapp_transactional e sms_transactional
  // sono read-only dall'area clienti.
  const allowed: Array<keyof PrefsRow> = [
    'whatsapp_operational',
    'whatsapp_marketing',
    'email_operational',
    'email_marketing',
  ];
  const updates: Record<string, boolean> = {};
  for (const key of allowed) {
    if (typeof body[key] === 'boolean') updates[key as string] = body[key];
  }
  if (!Object.keys(updates).length) return c.json({ error: 'no_changes' }, 400);

  await ensureRow(customerId); // safety

  // Update dinamico via sql tagged template.
  await sql`
    UPDATE communication_preferences
    SET ${sql(updates)}, updated_via = 'portal', updated_at = now()
    WHERE customer_id = ${customerId}
  `;
  const row = await ensureRow(customerId);
  return c.json({ preferences: row });
});
