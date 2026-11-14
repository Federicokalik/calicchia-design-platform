/**
 * Fase 2, decisione 6 — P.IVA, codice fiscale, SDI e PEC come colonne di
 * customers (migrazione 169), con validazione (cifra di controllo) e
 * compatibilità con billing_address.vat_number & co.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { sql, useTestDatabase } from '../helpers/db';
import { useCrmFixtures } from '../helpers/crm';
import { api } from '../helpers/http';
import { executeTool } from '../../src/lib/agent/tools';
import { effectiveFiscal, isValidItalianVat, isValidPersonalFiscalCode } from '../../src/lib/customers/fiscal';

useTestDatabase();
const crm = useCrmFixtures('crm-customer-fiscal');

async function dbRow(id: string) {
  const [row] = await sql<Array<{ vat_number: string | null; fiscal_code: string | null; sdi_code: string | null; pec: string | null; billing_address: Record<string, unknown> }>>`
    SELECT vat_number, fiscal_code, sdi_code, pec, billing_address FROM customers WHERE id = ${id}
  `;
  return row;
}

describe('validatori', () => {
  test('P.IVA italiana e codice fiscale con carattere di controllo', () => {
    assert.equal(isValidItalianVat('12345678903'), true);
    assert.equal(isValidItalianVat('12345678901'), false);
    assert.equal(isValidItalianVat('00000000000'), false);
    assert.equal(isValidPersonalFiscalCode('RSSMRA80A01H501U'), true);
    assert.equal(isValidPersonalFiscalCode('RSSMRA80A01H501Z'), false);
  });
});

describe('PUT /api/customers/:id', () => {
  test('colonne top-level: normalizzate, validate e restituite anche in billing_address', async () => {
    const c = await crm.customer({ billing_address: { street: 'Via Roma 1', city: 'Roma' } });
    const res = await api.put(`/api/customers/${c.id}`, {
      auth: 'admin',
      body: { vat_number: 'IT 123 456 789 03', fiscal_code: 'rssmra80a01h501u', sdi_code: 'm5uxcr1', pec: 'ACME@PEC.EXAMPLE.TEST' },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.customer.vat_number, '12345678903');
    assert.equal(res.json.customer.fiscal_code, 'RSSMRA80A01H501U');
    assert.equal(res.json.customer.sdi_code, 'M5UXCR1');
    assert.equal(res.json.customer.pec, 'acme@pec.example.test');
    assert.equal(res.json.customer.billing_address.vat_number, '12345678903', 'compatibilità per chi legge billing_address');
    assert.equal(res.json.customer.billing_address.street, 'Via Roma 1');

    const row = await dbRow(c.id);
    assert.equal(row.vat_number, '12345678903');
    assert.deepEqual(row.billing_address, { street: 'Via Roma 1', city: 'Roma' }, 'nel jsonb resta solo l’indirizzo');
  });

  test('P.IVA o codice fiscale non validi → 400 con il motivo', async () => {
    const c = await crm.customer();
    const vat = await api.put(`/api/customers/${c.id}`, { auth: 'admin', body: { vat_number: '12345678901' } });
    assert.equal(vat.status, 400);
    assert.match(vat.json.error, /vat_number: .*cifra di controllo/);
    const cf = await api.put(`/api/customers/${c.id}`, { auth: 'admin', body: { fiscal_code: 'RSSMRA80A01H501Z' } });
    assert.equal(cf.status, 400);
    assert.match(cf.json.error, /fiscal_code/);
    const sdi = await api.put(`/api/customers/${c.id}`, { auth: 'admin', body: { sdi_code: 'ABC' } });
    assert.equal(sdi.status, 400);
    assert.match(sdi.json.error, /sdi_code/);
  });

  test('billing_address.vat_number (client esistenti) finisce nella colonna', async () => {
    const c = await crm.customer({ billing_address: { street: 'Via Roma 1' } });
    const res = await api.put(`/api/customers/${c.id}`, {
      auth: 'admin',
      body: { billing_address: { vat_number: 'IT12345678903', pec_email: 'x@pec.example.test', city: 'Roma' } },
    });
    assert.equal(res.status, 200, res.text);
    const row = await dbRow(c.id);
    assert.equal(row.vat_number, '12345678903');
    assert.equal(row.pec, 'x@pec.example.test');
    assert.deepEqual(row.billing_address, { street: 'Via Roma 1', city: 'Roma' });

    const bad = await api.put(`/api/customers/${c.id}`, { auth: 'admin', body: { billing_address: { vat_number: '123' } } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /billing_address\.vat_number/);
  });

  test('valore legacy non migrato: resta letto come fallback finché non viene sostituito', async () => {
    // Come un cliente con P.IVA scritta male prima della 169: resta nel jsonb.
    const c = await crm.customer({ billing_address: { street: 'Via Roma 1', vat_number: 'n/d' } });
    let got = await api.get(`/api/customers/${c.id}`, { auth: 'admin' });
    assert.equal(got.json.customer.billing_address.vat_number, 'n/d');
    assert.equal(effectiveFiscal(await dbRow(c.id)).vat_number, 'n/d');

    const fixed = await api.put(`/api/customers/${c.id}`, { auth: 'admin', body: { vat_number: '12345678903' } });
    assert.equal(fixed.status, 200, fixed.text);
    const row = await dbRow(c.id);
    assert.equal(row.billing_address.vat_number, undefined, 'il valore legacy esce dal jsonb');
    got = await api.get(`/api/customers/${c.id}`, { auth: 'admin' });
    assert.equal(got.json.customer.billing_address.vat_number, '12345678903');

    const cleared = await api.put(`/api/customers/${c.id}`, { auth: 'admin', body: { vat_number: '' } });
    assert.equal(cleared.status, 200);
    assert.equal((await dbRow(c.id)).vat_number, null);
  });

  test('POST /api/customers con dati fiscali', async () => {
    const res = await api.post('/api/customers', {
      auth: 'admin',
      body: { contact_name: crm.name('fiscale'), email: crm.email('fiscale'), vat_number: '12345678903', billing_address: { street: 'Via X', fiscal_code: '12345678903' }, createOnStripe: false },
    });
    assert.equal(res.status, 201, res.text);
    const row = await dbRow(res.json.customer.id);
    assert.equal(row.vat_number, '12345678903');
    assert.equal(row.fiscal_code, '12345678903');
    assert.deepEqual(row.billing_address, { street: 'Via X' });
  });
});

describe('tool MCP', () => {
  test('update_customer accetta vat_number e la P.IVA dentro billing_address', async () => {
    const c = await crm.customer();
    const ok = JSON.parse(await executeTool('update_customer', { customer_id: c.id, vat_number: 'IT12345678903', billing_address: { street: 'Via Roma 9' } }));
    assert.equal(ok.updated.vat_number, '12345678903', JSON.stringify(ok));
    assert.equal(ok.updated.billing_address.vat_number, '12345678903');
    const bad = JSON.parse(await executeTool('update_customer', { customer_id: c.id, vat_number: '12345678901' }));
    assert.match(String(bad.error), /vat_number/);
  });
});
