/**
 * Admin services catalog — CRUD + sync verso Stripe Product/Price e PayPal Catalog/Plan.
 *
 * Pattern:
 *  - Services sono il "catalogo prodotti riusabili" (es. Logo design, Hosting annuale).
 *  - Possono essere one_time o ricorrenti (month/year).
 *  - Sync con Stripe e/o PayPal è on-demand via admin button (POST /:id/sync-{stripe,paypal}).
 *    Una volta sync, `stripe_price_id` / `paypal_plan_id` sono usati da
 *    `POST /api/subscriptions` o dai line_items in fatturazione.
 *  - Sync è idempotente: se gli ID esistono già non ri-crea, ma può aggiornare prezzo
 *    creando un NUOVO price (Stripe non permette modifica di unit_amount su price esistente).
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../lib/z-validator';
import { HTTPException } from 'hono/http-exception';
import { sql } from '../db';
import {
  stripe,
  isStripeConfigured,
  createStripeProduct,
  createStripePrice,
} from '../lib/stripe';
import {
  createPaypalProduct,
  createPaypalPlan,
  isPaypalReady,
} from '../lib/paypal';

export const services = new Hono();

const BILLING_INTERVALS = ['month', 'year', 'one_time'] as const;
const SERVICE_CATEGORIES = ['hosting', 'domain', 'maintenance', 'development', 'other'] as const;

const createServiceSchema = z.object({
  name: z.string().min(1, 'name richiesto'),
  description: z.string().optional().nullable(),
  price: z.number().positive('price deve essere > 0'),
  currency: z.string().length(3).optional(),
  billing_interval: z.enum(BILLING_INTERVALS).default('one_time'),
  category: z.enum(SERVICE_CATEGORIES).default('other'),
  is_active: z.boolean().optional(),
});

const updateServiceSchema = createServiceSchema.partial();

// ─────────────────────────────────────────────────────────
// LIST
// ─────────────────────────────────────────────────────────
services.get('/', async (c) => {
  const isActive = c.req.query('active');
  const category = c.req.query('category');
  const recurring = c.req.query('recurring'); // 'true' | 'false'

  const activeFilter = isActive === 'true' ? sql`AND is_active = true`
    : isActive === 'false' ? sql`AND is_active = false`
    : sql``;
  const categoryFilter = category && category !== 'all' ? sql`AND category = ${category}` : sql``;
  const recurringFilter = recurring === 'true' ? sql`AND billing_interval IN ('month','year')`
    : recurring === 'false' ? sql`AND billing_interval = 'one_time'`
    : sql``;

  const rows = await sql`
    SELECT
      id, name, description, price, currency, billing_interval, category,
      is_active, stripe_product_id, stripe_price_id, paypal_product_id, paypal_plan_id,
      created_at, updated_at
    FROM services
    WHERE 1=1
      ${activeFilter}
      ${categoryFilter}
      ${recurringFilter}
    ORDER BY name ASC
  ` as Array<Record<string, unknown>>;

  return c.json({ services: rows });
});

// ─────────────────────────────────────────────────────────
// GET BY ID
// ─────────────────────────────────────────────────────────
services.get('/:id', async (c) => {
  const id = c.req.param('id');
  const [row] = await sql`
    SELECT * FROM services WHERE id = ${id} LIMIT 1
  ` as Array<Record<string, unknown>>;
  if (!row) throw new HTTPException(404, { message: 'Servizio non trovato' });
  return c.json({ service: row });
});

// ─────────────────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────────────────
services.post('/', zValidator('json', createServiceSchema), async (c) => {
  const body = (c.req as any).valid('json') as z.infer<typeof createServiceSchema>;

  const [row] = await sql`
    INSERT INTO services ${sql({
      name: body.name,
      description: body.description ?? null,
      price: body.price,
      currency: (body.currency ?? 'EUR').toUpperCase(),
      billing_interval: body.billing_interval,
      category: body.category,
      is_active: body.is_active ?? true,
    })}
    RETURNING *
  ` as Array<Record<string, unknown>>;

  return c.json({ service: row }, 201);
});

// ─────────────────────────────────────────────────────────
// UPDATE
// ─────────────────────────────────────────────────────────
services.patch('/:id', zValidator('json', updateServiceSchema), async (c) => {
  const id = c.req.param('id');
  const body = (c.req as any).valid('json') as z.infer<typeof updateServiceSchema>;

  const [existing] = await sql`
    SELECT id, price, billing_interval, currency
    FROM services WHERE id = ${id} LIMIT 1
  ` as Array<{ id: string; price: number; billing_interval: string; currency: string }>;
  if (!existing) throw new HTTPException(404, { message: 'Servizio non trovato' });

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;
  if (body.price !== undefined) updates.price = body.price;
  if (body.currency !== undefined) updates.currency = body.currency.toUpperCase();
  if (body.billing_interval !== undefined) updates.billing_interval = body.billing_interval;
  if (body.category !== undefined) updates.category = body.category;
  if (body.is_active !== undefined) updates.is_active = body.is_active;

  const [row] = await sql`
    UPDATE services SET ${sql(updates)} WHERE id = ${id} RETURNING *
  ` as Array<Record<string, unknown>>;

  // Cambio prezzo / intervallo invalida i sync ID — segnala in risposta ma NON
  // li azzera (admin decide se ri-sync).
  const priceChanged =
    body.price !== undefined && Number(body.price) !== Number(existing.price);
  const intervalChanged =
    body.billing_interval !== undefined && body.billing_interval !== existing.billing_interval;

  return c.json({
    service: row,
    warnings: priceChanged || intervalChanged
      ? ['Prezzo o intervallo cambiati — ri-esegui sync Stripe/PayPal per applicare i nuovi valori']
      : [],
  });
});

// ─────────────────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────────────────
services.delete('/:id', async (c) => {
  const id = c.req.param('id');

  const [used] = await sql`
    SELECT COUNT(*) AS cnt FROM subscriptions WHERE stripe_price_id IN (
      SELECT stripe_price_id FROM services WHERE id = ${id} AND stripe_price_id IS NOT NULL
    )
  ` as Array<{ cnt: string }>;

  if (Number(used?.cnt ?? 0) > 0) {
    throw new HTTPException(400, {
      message: 'Impossibile eliminare: il servizio è usato in abbonamenti attivi. Disattivalo invece.',
    });
  }

  await sql`DELETE FROM services WHERE id = ${id}`;
  return c.json({ success: true });
});

// Bulk delete — ignora i servizi linkati ad abbonamenti attivi e ritorna conteggi
const bulkDeleteSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
});

services.post('/bulk-delete', zValidator('json', bulkDeleteSchema), async (c) => {
  const { ids } = (c.req as any).valid('json') as z.infer<typeof bulkDeleteSchema>;

  // Identifica quali sono linkati ad abbonamenti attivi
  const blocked = await sql`
    SELECT DISTINCT s.id, s.name
    FROM services s
    JOIN subscriptions sub ON sub.stripe_price_id = s.stripe_price_id
    WHERE s.id = ANY(${sql.array(ids)})
      AND s.stripe_price_id IS NOT NULL
      AND sub.status IN ('active', 'trialing', 'past_due')
  ` as Array<{ id: string; name: string }>;

  const blockedIds = new Set(blocked.map((b) => b.id));
  const deletable = ids.filter((id) => !blockedIds.has(id));

  let deleted = 0;
  if (deletable.length > 0) {
    const result = await sql`DELETE FROM services WHERE id = ANY(${sql.array(deletable)}) RETURNING id` as Array<{ id: string }>;
    deleted = result.length;
  }

  return c.json({
    deleted,
    blocked: blocked.map((b) => ({ id: b.id, name: b.name })),
  });
});

// ─────────────────────────────────────────────────────────
// SYNC → STRIPE Product + Price
// ─────────────────────────────────────────────────────────
services.post('/:id/sync-stripe', async (c) => {
  const id = c.req.param('id');

  if (!isStripeConfigured()) {
    throw new HTTPException(503, {
      message: 'Stripe non configurato. Imposta STRIPE_SECRET_KEY in .env',
    });
  }

  const [svc] = await sql`
    SELECT * FROM services WHERE id = ${id} LIMIT 1
  ` as Array<Record<string, unknown>>;
  if (!svc) throw new HTTPException(404, { message: 'Servizio non trovato' });

  // 1. Product: riusa esistente o crea
  let productId = svc.stripe_product_id as string | null;
  if (!productId) {
    const product = await createStripeProduct(
      String(svc.name),
      (svc.description as string | null) ?? undefined,
    );
    productId = product.id;
  } else {
    // best-effort sync nome/description su product esistente
    try {
      await stripe.products.update(productId, {
        name: String(svc.name),
        description: (svc.description as string | null) ?? undefined,
      });
    } catch (err) {
      console.warn(`[services] Stripe product update failed (${productId}):`, (err as Error).message);
    }
  }

  // 2. Price: Stripe non permette modificare unit_amount → crea sempre nuovo
  //    e archive il vecchio (best-effort, per evitare confusione su dashboard).
  const oldPriceId = svc.stripe_price_id as string | null;
  const price = await createStripePrice(
    productId,
    Math.round(Number(svc.price) * 100),
    String(svc.currency ?? 'EUR'),
    svc.billing_interval === 'one_time'
      ? undefined
      : { interval: svc.billing_interval as 'month' | 'year' },
  );

  if (oldPriceId && oldPriceId !== price.id) {
    try {
      await stripe.prices.update(oldPriceId, { active: false });
    } catch (err) {
      console.warn(`[services] Stripe price archive failed (${oldPriceId}):`, (err as Error).message);
    }
  }

  await sql`
    UPDATE services
    SET stripe_product_id = ${productId}, stripe_price_id = ${price.id}, updated_at = NOW()
    WHERE id = ${id}
  `;

  return c.json({
    success: true,
    stripe_product_id: productId,
    stripe_price_id: price.id,
    archived_price: oldPriceId && oldPriceId !== price.id ? oldPriceId : null,
  });
});

// ─────────────────────────────────────────────────────────
// SYNC → PAYPAL Product + Plan (solo se ricorrente)
// ─────────────────────────────────────────────────────────
services.post('/:id/sync-paypal', async (c) => {
  const id = c.req.param('id');

  if (!(await isPaypalReady())) {
    throw new HTTPException(503, {
      message: 'PayPal non configurato. Imposta PAYPAL_CLIENT_ID/SECRET in .env',
    });
  }

  const [svc] = await sql`
    SELECT * FROM services WHERE id = ${id} LIMIT 1
  ` as Array<Record<string, unknown>>;
  if (!svc) throw new HTTPException(404, { message: 'Servizio non trovato' });

  if (svc.billing_interval === 'one_time') {
    throw new HTTPException(400, {
      message:
        'PayPal Plan è solo per servizi ricorrenti. Per pagamenti one-off PayPal usa direttamente Orders API in fatturazione.',
    });
  }

  let productId = svc.paypal_product_id as string | null;
  if (!productId) {
    const product = await createPaypalProduct({
      name: String(svc.name),
      description: (svc.description as string | null) ?? String(svc.name),
    });
    productId = product.id;
  }

  const plan = await createPaypalPlan({
    product_id: productId,
    name: String(svc.name),
    amount: Number(svc.price),
    currency: String(svc.currency ?? 'EUR'),
    interval: (svc.billing_interval === 'month' ? 'MONTH' : 'YEAR'),
  });

  await sql`
    UPDATE services
    SET paypal_product_id = ${productId}, paypal_plan_id = ${plan.id}, updated_at = NOW()
    WHERE id = ${id}
  `;

  return c.json({
    success: true,
    paypal_product_id: productId,
    paypal_plan_id: plan.id,
  });
});
