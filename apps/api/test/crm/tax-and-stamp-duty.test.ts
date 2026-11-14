/**
 * Fase 2 — aliquota di default e bollo nell'XML SDI.
 *
 * - tax_rate: prima DEFAULT 22 sulle colonne e `?? 22` nelle route; in
 *   regime forfettario ora l'aliquota di default è 0 (lib/tax/default-rate.ts,
 *   migrazione 170). La fattura da milestone di progetto nasceva con imposta
 *   0 ma tax_rate 22.
 * - DatiBollo: l'XML FatturaPA non lo riportava mai. Sopra 77,47 € di
 *   operazioni senza IVA serve BolloVirtuale=SI / ImportoBollo 2.00; la
 *   rivalsa del bollo addebitata al cliente è una riga con Natura N1.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { sql, useTestDatabase } from '../helpers/db';
import { TEST_BUSINESS_PROFILE, useCrmFixtures, withSettings } from '../helpers/crm';
import { api } from '../helpers/http';
import { defaultTaxRate } from '../../src/lib/tax/default-rate';
import { generateFatturaPAXml, type FatturaPALineItem } from '../../src/lib/sdi/xml';

useTestDatabase();
const crm = useCrmFixtures('crm-tax-stamp');

const ORDINARIO = { 'freelancer.studio': { vat_regime: 'ordinario' }, 'billing.defaults': { default_tax_rate: 22 } };

async function cleanupInvoices(customerId: string) {
  await sql`DELETE FROM invoices WHERE customer_id = ${customerId}`;
}

describe('aliquota di default', () => {
  test('dal regime: forfettario 0, ordinario billing.defaults', async () => {
    assert.equal(await defaultTaxRate(), 0);
    assert.equal(await withSettings(ORDINARIO, () => defaultTaxRate()), 22);
  });

  test('POST /api/invoices senza tax_rate → 0 in forfettario (prima 22)', async () => {
    const c = await crm.customer();
    try {
      const res = await api.post('/api/invoices', {
        auth: 'admin',
        body: { customer_id: c.id, subtotal: 100, total: 100, line_items: [{ description: 'Sito', quantity: 1, unit_price: 100, amount: 100 }] },
      });
      assert.equal(res.status, 201, res.text);
      assert.equal(Number(res.json.invoice.tax_rate), 0);
    } finally {
      await cleanupInvoices(c.id);
    }
  });

  test('fattura da milestone di progetto: aliquota e imposta coerenti', async () => {
    const c = await crm.customer();
    const [project] = await sql<Array<{ id: string }>>`
      INSERT INTO client_projects (name, customer_id) VALUES (${crm.name('progetto')}, ${c.id}) RETURNING id
    `;
    try {
      const res = await api.post(`/api/client-projects/${project.id}/create-invoice`, { auth: 'admin', body: { amount: 500, milestone_name: 'Acconto' } });
      assert.equal(res.status, 201, res.text);
      assert.equal(Number(res.json.invoice.tax_rate), 0);
      assert.equal(Number(res.json.invoice.tax), 0);

      const ord = await withSettings(ORDINARIO, () =>
        api.post(`/api/client-projects/${project.id}/create-invoice`, { auth: 'admin', body: { amount: 500, milestone_name: 'Saldo' } }));
      assert.equal(Number(ord.json.invoice.tax_rate), 22);
      assert.equal(Number(ord.json.invoice.tax), 110);
    } finally {
      await cleanupInvoices(c.id);
      await sql`DELETE FROM client_projects WHERE id = ${project.id}`;
    }
  });

  test('preventivo v2: modificare le voci senza tax_rate mantiene l’aliquota salvata', async () => {
    const created = await api.post('/api/quotes-v2', { auth: 'admin', body: { title: crm.name('prev'), items: [{ title: 'Sito', quantity: 1, unit_price: 1000, total: 1000 }] } });
    assert.equal(created.status, 201, created.text);
    const id = created.json.quote.id;
    try {
      assert.equal(Number(created.json.quote.tax_rate), 0);
      assert.equal(Number(created.json.quote.tax_amount), 0);
      const updated = await api.put(`/api/quotes-v2/${id}`, { auth: 'admin', body: { items: [{ title: 'Sito', quantity: 2, unit_price: 1000, total: 2000 }] } });
      assert.equal(updated.status, 200, updated.text);
      assert.equal(Number(updated.json.quote.tax_amount), 0, 'prima veniva ricalcolata al 22%');
      assert.equal(Number(updated.json.quote.total), 2000);
    } finally {
      await sql`DELETE FROM quotes_v2 WHERE id = ${id}`;
    }
  });
});

describe('XML SDI: DatiBollo e rivalsa', () => {
  const customer = {
    name: 'Crimatek Srl',
    vat_number: '12345678903',
    address: { street: 'Via Roma 1', postal_code: '00100', city: 'Roma', province: 'RM' },
  };
  const config = {
    vat_number: '12345678903',
    fiscal_code: 'RSSMRA80A01H501U',
    company_name: 'Studio',
    address: { street: 'Via X', postal_code: '03023', city: 'Ceccano', province: 'FR' },
  };
  const xmlFor = (lines: FatturaPALineItem[]) =>
    generateFatturaPAXml(
      { id: '550e8400-e29b-41d4-a716-446655440000', invoice_number: 'FT 1/2026', issue_date: '2026-11-05', total: lines.reduce((n, l) => n + l.amount, 0), line_items: lines },
      customer,
      config,
    );

  test('soglia strettamente maggiore di 77,47 €', () => {
    assert.doesNotMatch(xmlFor([{ description: 'x', quantity: 1, unit_price: 77.47, amount: 77.47 }]), /DatiBollo/);
    const above = xmlFor([{ description: 'x', quantity: 1, unit_price: 77.48, amount: 77.48 }]);
    assert.match(above, /<DatiBollo>\s*<BolloVirtuale>SI<\/BolloVirtuale>\s*<ImportoBollo>2\.00<\/ImportoBollo>\s*<\/DatiBollo>/);
    // DatiBollo viene dopo Numero e prima di ImportoTotaleDocumento (ordine dello schema).
    assert.ok(above.indexOf('<Numero>') < above.indexOf('<DatiBollo>') && above.indexOf('</DatiBollo>') < above.indexOf('<ImportoTotaleDocumento>'));
  });

  test('rivalsa del bollo: Natura N1, esclusa dalla soglia, riepilogo separato', () => {
    const xml = xmlFor([
      { description: 'Rinnovo dominio', quantity: 1, unit_price: 100, amount: 100 },
      { description: 'Rivalsa imposta di bollo', quantity: 1, unit_price: 2, amount: 2, kind: 'stamp_duty' },
    ]);
    assert.match(xml, /<ImportoTotaleDocumento>102\.00<\/ImportoTotaleDocumento>/);
    assert.match(xml, /<Natura>N2\.2<\/Natura>\s*<ImponibileImporto>100\.00<\/ImponibileImporto>/);
    assert.match(xml, /<Natura>N1<\/Natura>\s*<ImponibileImporto>2\.00<\/ImponibileImporto>/);
    assert.match(xml, /<DatiBollo>/);
    // 76 € di servizi + 2 € di rivalsa: niente bollo (la rivalsa non conta).
    const below = xmlFor([
      { description: 'x', quantity: 1, unit_price: 76, amount: 76 },
      { description: 'Rivalsa imposta di bollo', quantity: 1, unit_price: 2, amount: 2, kind: 'stamp_duty' },
    ]);
    assert.doesNotMatch(below, /DatiBollo/);
  });

  test('GET /api/invoices/:id/sdi-xml: dati fiscali dalle colonne del cliente e DatiBollo', async () => {
    const c = await crm.customer({
      company_name: 'Crimatek Srl',
      vat_number: '12345678903',
      sdi_code: 'M5UXCR1',
      billing_address: { street: 'Via Roma 1', postal_code: '00100', city: 'Roma', province: 'RM', country: 'IT' },
    });
    const [inv] = await sql<Array<{ id: string }>>`
      INSERT INTO invoices ${sql({
        customer_id: c.id, status: 'open', invoice_number: `T-${crm.prefix}`, subtotal: 102, total: 102, amount_due: 102, tax_rate: 0,
        issue_date: '2026-11-05',
        line_items: sql.json([
          { description: 'Rinnovo dominio crimatek.com', quantity: 1, unit_price: 100, amount: 100 },
          { description: 'Rivalsa imposta di bollo', quantity: 1, unit_price: 2, amount: 2, kind: 'stamp_duty' },
        ]),
      })}
      RETURNING id
    `;
    try {
      const res = await withSettings({ 'business.profile': TEST_BUSINESS_PROFILE }, () => api.get(`/api/invoices/${inv.id}/sdi-xml`, { auth: 'admin' }));
      assert.equal(res.status, 200, res.text);
      assert.match(res.text, /<CodiceDestinatario>M5UXCR1<\/CodiceDestinatario>/);
      assert.match(res.text, /<CessionarioCommittente>[\s\S]*<IdCodice>12345678903<\/IdCodice>/);
      assert.match(res.text, /<DatiBollo>/);
      assert.match(res.text, /<Natura>N1<\/Natura>/);
    } finally {
      await cleanupInvoices(c.id);
    }
  });
});
