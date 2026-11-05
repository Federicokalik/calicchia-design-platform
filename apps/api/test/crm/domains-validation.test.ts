/**
 * Bug 4 — POST /api/domains: validazione ed errori.
 *
 * Riproduzione (prima del fix):
 *  - un campo sconosciuto (renewal_price, domain) arrivava a Postgres come
 *    colonna inesistente → 42703 → 500 Internal Server Error;
 *  - un obbligatorio mancante → 23502 → "Dati incompleti: manca un campo
 *    obbligatorio." senza dire quale;
 *  - domain_name "crimatek.com" + tld "com" → full_domain "crimatek.com.com";
 *  - auto_renew mancante → true per default.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import postgres from 'postgres';
import { useTestDatabase } from '../helpers/db';
import { useCrmFixtures } from '../helpers/crm';
import { api } from '../helpers/http';
import { mapDbError } from '../../src/lib/db-errors';

useTestDatabase();
const crm = useCrmFixtures('crm-domains-validation');

async function baseBody(overrides: Record<string, unknown> = {}) {
  const customer = await crm.customer();
  return {
    customer_id: customer.id,
    domain_name: crm.domainLabel(),
    tld: 'it',
    registration_date: '2024-03-01',
    expiration_date: '2027-03-01',
    auto_renew: false,
    ...overrides,
  };
}

describe('POST /api/domains', () => {
  test('campo sconosciuto → 400 con il nome del campo e il suggerimento (prima: 500)', async () => {
    const res = await api.post('/api/domains', { auth: 'admin', body: await baseBody({ renewal_price: 15, domain: 'x.it' }) });
    assert.equal(res.status, 400, res.text);
    assert.match(res.json.error, /renewal_price/);
    assert.match(res.json.error, /renewal_cost/);
    assert.match(res.json.error, /\bdomain\b/);
    assert.ok(res.json.details.some((d: { path: string[] }) => d.path.includes('renewal_price')));
  });

  test('obbligatorio mancante → 400 che dice QUALE campo', async () => {
    const { expiration_date: _e, ...body } = await baseBody();
    const res = await api.post('/api/domains', { auth: 'admin', body });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /expiration_date/);
  });

  test('auto_renew è obbligatorio in creazione', async () => {
    const { auto_renew: _a, ...body } = await baseBody();
    const res = await api.post('/api/domains', { auth: 'admin', body });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /auto_renew/);
  });

  test('domain_name "crimatek.com" + tld "com" → crimatek.com (non .com.com)', async () => {
    const label = crm.domainLabel('crimatek');
    const res = await api.post('/api/domains', { auth: 'admin', body: await baseBody({ domain_name: `${label}.com`, tld: 'com' }) });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.domain.domain_name, label);
    assert.equal(res.json.domain.tld, 'com');
    assert.equal(res.json.domain.full_domain, `${label}.com`);
    assert.equal(res.json.domain.auto_renew, false);
  });

  test('full_domain con suffisso a più livelli (PSL): crimatek.co.uk', async () => {
    const label = crm.domainLabel('uk');
    const { domain_name: _d, tld: _t, ...body } = await baseBody();
    const res = await api.post('/api/domains', { auth: 'admin', body: { ...body, full_domain: `${label}.co.uk` } });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.domain.domain_name, label);
    assert.equal(res.json.domain.tld, 'co.uk');
  });

  test('dominio completo nel solo domain_name', async () => {
    const label = crm.domainLabel('solo');
    const { tld: _t, ...body } = await baseBody({ domain_name: `${label}.IT` });
    const res = await api.post('/api/domains', { auth: 'admin', body });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.domain.full_domain, `${label}.it`);
  });

  test('casi incoerenti → 400', async () => {
    const label = crm.domainLabel('bad');
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ domain_name: `${label}.com`, tld: 'it' }, /incoerent/i],
      [{ full_domain: `${label}.com`, domain_name: 'altro', tld: undefined }, /incoerent/i],
      [{ domain_name: `www.${label}.com`, tld: 'com' }, /sottodominio|registrabile/i],
      [{ domain_name: label, tld: 'nonesiste' }, /TLD/],
      [{ domain_name: 'nome con spazi', tld: 'it' }, /domain_name/],
    ];
    for (const [overrides, pattern] of cases) {
      const res = await api.post('/api/domains', { auth: 'admin', body: await baseBody(overrides) });
      assert.equal(res.status, 400, `${JSON.stringify(overrides)} → ${res.text}`);
      assert.match(res.json.error, pattern, JSON.stringify(overrides));
    }
  });

  test('tipi non validi → 400 sul campo', async () => {
    const res = await api.post('/api/domains', { auth: 'admin', body: await baseBody({ expiration_date: '31/12/2027', renewal_cost: 'quindici' }) });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /expiration_date/);
    assert.match(res.json.error, /renewal_cost/);
  });
});

describe('PUT /api/domains/:id', () => {
  test('campo sconosciuto → 400; full_domain ricalcola nome e TLD', async () => {
    const customer = await crm.customer();
    const domain = await crm.domain(customer.id);
    const unknown = await api.put(`/api/domains/${domain.id}`, { auth: 'admin', body: { expiry_date: '2030-01-01' } });
    assert.equal(unknown.status, 400);
    assert.match(unknown.json.error, /expiry_date/);
    assert.match(unknown.json.error, /expiration_date/);

    const label = crm.domainLabel('rename');
    const ok = await api.put(`/api/domains/${domain.id}`, { auth: 'admin', body: { full_domain: `${label}.eu`, renewal_cost: 12.5 } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.domain.full_domain, `${label}.eu`);
    assert.equal(Number(ok.json.domain.renewal_cost), 12.5);
  });

  test('come il form admin: tutti i campi del form', async () => {
    const customer = await crm.customer();
    const domain = await crm.domain(customer.id);
    const res = await api.put(`/api/domains/${domain.id}`, {
      auth: 'admin',
      body: {
        domain_name: domain.domain_name, tld: 'it', registrar: 'aruba', registration_date: '2020-01-01',
        expiration_date: '2031-01-01', auto_renew: true, customer_id: customer.id, hosting_server: null,
        ssl_status: 'none', notes: null,
      },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.domain.expiration_date.slice(0, 10), '2031-01-01');
  });

  test('dominio inesistente → 404', async () => {
    const res = await api.put('/api/domains/00000000-0000-4000-8000-000000000000', { auth: 'admin', body: { notes: 'x' } });
    assert.equal(res.status, 404);
  });
});

describe('parseDomainInput (PSL)', () => {
  test('nome e TLD ricavati dalla Public Suffix List', async () => {
    // Import dinamico: il modulo è nuovo, il resto del file deve girare anche sul codice prima del fix.
    const { parseDomainInput } = await import('../../src/lib/domains/parse');
    assert.deepEqual(parseDomainInput({ full_domain: 'Crimatek.co.uk' }), { ok: true, domain_name: 'crimatek', tld: 'co.uk' });
    assert.deepEqual(parseDomainInput({ domain_name: 'crimatek.com', tld: 'com' }), { ok: true, domain_name: 'crimatek', tld: 'com' });
    assert.deepEqual(parseDomainInput({ domain_name: 'crimatek', tld: '.IT' }), { ok: true, domain_name: 'crimatek', tld: 'it' });
    assert.equal(parseDomainInput({ domain_name: 'crimatek.com', tld: 'it' }).ok, false);
    assert.equal(parseDomainInput({ domain_name: 'blog.crimatek.it' }).ok, false);
  });
});

describe('mapDbError', () => {
  test('23502 dice quale colonna manca', () => {
    const err = new (postgres.PostgresError as unknown as new (x: Record<string, unknown>) => Error)({
      message: 'null value in column "expiration_date" violates not-null constraint',
      code: '23502',
      column_name: 'expiration_date',
    });
    const mapped = mapDbError(err);
    assert.equal(mapped?.status, 400);
    assert.match(mapped!.message, /expiration_date/);
  });
});
