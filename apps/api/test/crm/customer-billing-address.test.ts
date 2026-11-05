/**
 * Bug 3 — `billing_address.vat_number` cancellato.
 *
 * Causa: POST/PUT /api/customers sincronizzano il cliente su Stripe
 * (customers.create/update). Stripe risponde con i webhook customer.created /
 * customer.updated e routes/stripe-webhook.ts faceva
 *   ON CONFLICT (stripe_customer_id) DO UPDATE SET billing_address = EXCLUDED.billing_address
 * con il solo indirizzo Stripe (via, città, CAP, provincia, paese): P.IVA,
 * codice fiscale, SDI e PEC sparivano, e contact_name veniva sovrascritto con
 * il "name" Stripe (cioè la ragione sociale). In più il PUT con
 * billing_address lo sostituiva in blocco.
 *
 * Contratto dopo il fix:
 *  - un PUT senza billing_address non lo tocca;
 *  - un PUT con billing_address fa merge profondo (JSON Merge Patch, RFC 7396:
 *    chiave a null = rimozione);
 *  - il webhook su un cliente esistente applica solo i campi che Stripe dice
 *    cambiati (previous_attributes) e non tocca le chiavi che Stripe non
 *    gestisce; customer.created su un cliente esistente riempie solo i vuoti.
 */
import { TEST_STRIPE_SECRET_KEY, TEST_STRIPE_WEBHOOK_SECRET } from './_stripe-env';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import Stripe from 'stripe';
import { onBeforeDatabaseClose, sql, useTestDatabase } from '../helpers/db';
import { useCrmFixtures } from '../helpers/crm';
import { withEnv } from '../helpers/env';
import { api } from '../helpers/http';

useTestDatabase();
const crm = useCrmFixtures('crm-billing-address');

const FULL_ADDRESS = {
  street: 'Via Roma 1',
  postal_code: '00100',
  city: 'Roma',
  province: 'RM',
  country: 'IT',
  vat_number: 'IT01234567890',
  fiscal_code: 'RSSMRA80A01H501U',
  sdi_code: 'M5UXCR1',
  pec: 'crimatek@pec.example.test',
};

const eventIds: string[] = [];
onBeforeDatabaseClose(async () => {
  await sql`DELETE FROM stripe_webhook_logs WHERE event_id = ANY(${eventIds})`;
});

const stripeSigner = new Stripe(TEST_STRIPE_SECRET_KEY, { apiVersion: '2025-02-24.acacia' });

async function stripeWebhook(type: string, object: Record<string, unknown>, previousAttributes?: Record<string, unknown>) {
  const id = `evt_${crm.prefix.replace(/-/g, '_')}_${randomBytes(4).toString('hex')}`;
  eventIds.push(id);
  const payload = JSON.stringify({
    id,
    object: 'event',
    type,
    api_version: '2025-02-24.acacia',
    created: Math.floor(Date.now() / 1000),
    data: { object, ...(previousAttributes ? { previous_attributes: previousAttributes } : {}) },
  });
  const signature = stripeSigner.webhooks.generateTestHeaderString({ payload, secret: TEST_STRIPE_WEBHOOK_SECRET });
  return withEnv({ STRIPE_SECRET_KEY: TEST_STRIPE_SECRET_KEY }, () =>
    api.post('/api/stripe/webhook', { body: payload, headers: { 'content-type': 'application/json', 'stripe-signature': signature } }),
  );
}

function stripeCustomer(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    object: 'customer',
    name: 'Crimatek Srl',
    email: null,
    phone: null,
    metadata: { company_name: 'Crimatek Srl' },
    address: { line1: 'Via Roma 1', line2: null, city: 'Roma', postal_code: '00100', state: 'RM', country: 'IT' },
    ...overrides,
  };
}

async function readCustomer(id: string) {
  const res = await api.get(`/api/customers/${id}`, { auth: 'admin' });
  assert.equal(res.status, 200, res.text);
  return res.json.customer;
}

describe('PUT /api/customers/:id', () => {
  test('senza billing_address non lo tocca (riproduzione: PUT {email, notes})', async () => {
    const c = await crm.customer({ billing_address: FULL_ADDRESS });
    const res = await api.put(`/api/customers/${c.id}`, { auth: 'admin', body: { email: crm.email('nuova'), notes: 'nota' } });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.customer.billing_address, FULL_ADDRESS);
    assert.deepEqual((await readCustomer(c.id)).billing_address, FULL_ADDRESS);
  });

  test('con billing_address fa merge profondo; null rimuove la chiave', async () => {
    const c = await crm.customer({ billing_address: FULL_ADDRESS });
    const res = await api.put(`/api/customers/${c.id}`, { auth: 'admin', body: { billing_address: { street: 'Via Milano 2', sdi_code: null } } });
    assert.equal(res.status, 200, res.text);
    const { sdi_code: _removed, ...rest } = FULL_ADDRESS;
    assert.deepEqual(res.json.customer.billing_address, { ...rest, street: 'Via Milano 2' });
  });

  test('billing_address non oggetto → 400', async () => {
    const c = await crm.customer({ billing_address: FULL_ADDRESS });
    const res = await api.put(`/api/customers/${c.id}`, { auth: 'admin', body: { billing_address: 'Via Roma 1' } });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /billing_address/);
  });

  test('campo sconosciuto → 400 con il nome del campo (prima: 500)', async () => {
    const c = await crm.customer();
    const res = await api.put(`/api/customers/${c.id}`, { auth: 'admin', body: { vat: 'IT1', notes: 'x' } });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /vat/);
    assert.match(res.json.error, /billing_address\.vat_number/);
  });
});

describe('webhook Stripe sui clienti esistenti', () => {
  test('customer.created dopo la POST: non cancella P.IVA/CF/SDI e non sovrascrive contact_name', async () => {
    const stripeId = `cus_${randomBytes(6).toString('hex')}`;
    const c = await crm.customer({ billing_address: FULL_ADDRESS, contact_name: crm.name('Mario Rossi'), company_name: 'Crimatek Srl', stripe_customer_id: stripeId });

    const res = await stripeWebhook('customer.created', stripeCustomer(stripeId, { email: c.email }));
    assert.equal(res.status, 200, res.text);

    const after = await readCustomer(c.id);
    assert.deepEqual(after.billing_address, FULL_ADDRESS);
    assert.equal(after.contact_name, crm.name('Mario Rossi'));
    assert.equal(after.company_name, 'Crimatek Srl');
  });

  test('customer.updated scatenato dal PUT dell’email: aggiorna solo l’email', async () => {
    const stripeId = `cus_${randomBytes(6).toString('hex')}`;
    const c = await crm.customer({ billing_address: FULL_ADDRESS, contact_name: crm.name('Anna'), stripe_customer_id: stripeId });
    const newEmail = crm.email('dopo-put');

    const res = await stripeWebhook('customer.updated', stripeCustomer(stripeId, { email: newEmail, name: 'Altro Nome' }), { email: c.email });
    assert.equal(res.status, 200, res.text);

    const after = await readCustomer(c.id);
    assert.equal(after.email, newEmail);
    assert.equal(after.contact_name, crm.name('Anna'), 'il name Stripe non sovrascrive i nomi del gestionale');
    assert.deepEqual(after.billing_address, FULL_ADDRESS);
  });

  test('customer.updated con indirizzo cambiato: applica via/città ma conserva le chiavi fiscali', async () => {
    const stripeId = `cus_${randomBytes(6).toString('hex')}`;
    const c = await crm.customer({ billing_address: FULL_ADDRESS, stripe_customer_id: stripeId });

    const address = { line1: 'Corso Italia 10', line2: null, city: 'Milano', postal_code: '20100', state: 'MI', country: 'IT' };
    const res = await stripeWebhook('customer.updated', stripeCustomer(stripeId, { address }), { address: { line1: 'Via Roma 1' } });
    assert.equal(res.status, 200, res.text);

    const after = await readCustomer(c.id);
    assert.deepEqual(after.billing_address, { ...FULL_ADDRESS, street: 'Corso Italia 10', city: 'Milano', postal_code: '20100', province: 'MI' });
  });

  test('customer.updated con address null non azzera billing_address', async () => {
    const stripeId = `cus_${randomBytes(6).toString('hex')}`;
    const c = await crm.customer({ billing_address: FULL_ADDRESS, stripe_customer_id: stripeId });
    const res = await stripeWebhook('customer.updated', stripeCustomer(stripeId, { address: null }), { address: { line1: 'x' } });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual((await readCustomer(c.id)).billing_address, FULL_ADDRESS);
  });

  test('customer.created di un cliente nuovo creato su Stripe: inserito con billing_address oggetto', async () => {
    const stripeId = `cus_${randomBytes(6).toString('hex')}`;
    const email = crm.email('da-stripe');
    const res = await stripeWebhook('customer.created', stripeCustomer(stripeId, { email, name: crm.name('Da Stripe'), metadata: {}, address: null }));
    assert.equal(res.status, 200, res.text);
    const [row] = await sql<Array<{ billing_address: unknown; contact_name: string }>>`
      SELECT billing_address, contact_name FROM customers WHERE stripe_customer_id = ${stripeId}
    `;
    assert.ok(row, 'il cliente nato su Stripe va creato');
    assert.deepEqual(row.billing_address, {});
    assert.equal(row.contact_name, crm.name('Da Stripe'));
  });

  test('customer.created di un cliente creato dal gestionale ma non ancora salvato: nessun duplicato', async () => {
    const stripeId = `cus_${randomBytes(6).toString('hex')}`;
    const res = await stripeWebhook('customer.created', stripeCustomer(stripeId, { email: crm.email('race'), metadata: { company_name: 'X', caldes_origin: 'admin' } }));
    assert.equal(res.status, 200, res.text);
    const rows = await sql`SELECT id FROM customers WHERE stripe_customer_id = ${stripeId}`;
    assert.equal(rows.length, 0, 'la riga la inserisce la POST del gestionale');
  });
});
