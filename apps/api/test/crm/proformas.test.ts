/**
 * Fase 2 — proforma (docs/proforma/design.md) con le decisioni confermate:
 *  1. numero all'emissione, salvo numero indicato a mano;
 *  2. formato "PF 3/2026";
 *  3. rivalsa del bollo nel totale;
 *  4. al pagamento la fattura nasce in bozza, "paid" solo se richiesto.
 * Più il flusso di rinnovo dominio: proforma dal dominio, PDF, invio ai
 * billing_emails, niente promemoria generico mentre è inviata, pagamento →
 * fattura + nuova scadenza.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import { simpleParser } from 'mailparser';
import { onBeforeDatabaseClose, onDatabaseClosing, onDatabaseReady, sql, useTestDatabase } from '../helpers/db';
import { fakePdf, findChrome, useCrmFixtures, withSettings } from '../helpers/crm';
import { api } from '../helpers/http';
import { startFakeImap, startFakeSmtp, type FakeImapServer, type FakeSmtpServer } from '../helpers/mail-servers';
import { executeTool } from '../../src/lib/agent/tools';
import { savePrivateFile } from '../../src/lib/private-files';
import { assignProformaNumber, parseProformaNumber } from '../../src/lib/proforma/numbering';
import { renderProformaHtml } from '../../src/lib/proforma/render';
import { createProformaDraft, issueProformaTx as issueTxWithSettings, loadIssueSettings, renderInputFor, getProforma } from '../../src/lib/proforma/service';
import { computeProformaTotals } from '../../src/lib/proforma/totals';

useTestDatabase();
const crm = useCrmFixtures('crm-proformas');
const chrome = findChrome();
const NO_CHROME = chrome ? false : 'Chrome/Chromium non disponibile: PDF reale non generabile';

/** Anni riservati ai test (le sequenze reali non vengono toccate). */
const TEST_YEARS = [2091, 2092, 2093];

const QUOTE_SETTINGS = {
  ragione_sociale: 'Studio di test',
  indirizzo: 'Via dei Test 1, 03023 Ceccano (FR)',
  piva: '12345678903',
  email_fornitore: 'studio@example.test',
  iban: 'IT60X0542811101000000123456',
  colore_primario: '#f57f44',
  nota_iva: "Regime forfettario ai sensi dell'art. 1, commi 54–89, L. 190/2014. Operazione senza applicazione IVA.",
  marca_bollo_nota: 'Su importi superiori a € 77,47 verrà applicata marca da bollo da € 2,00.',
  soglia_bollo: 77.47,
  importo_bollo: 2,
};

let smtp: FakeSmtpServer;
let imap: FakeImapServer;
let restoreSettings: (() => Promise<void>) | null = null;
/** Casella dei test: passata sempre esplicitamente (la "prima attiva" potrebbe essere di un altro run). */
let accountId = '';

onDatabaseReady(async () => {
  smtp = await startFakeSmtp();
  imap = await startFakeImap();
  accountId = (await crm.mailAccount({ smtpPort: smtp.port, imapPort: imap.port })).id;
  // quote.settings per tutto il file, ripristinate alla fine.
  const [prev] = await sql<Array<{ value: unknown }>>`SELECT value FROM site_settings WHERE key = 'quote.settings'`;
  await sql`INSERT INTO site_settings (key, value) VALUES ('quote.settings', ${sql.json(QUOTE_SETTINGS)})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  restoreSettings = async () => {
    if (prev) await sql`UPDATE site_settings SET value = ${sql.json(prev.value as never)} WHERE key = 'quote.settings'`;
    else await sql`DELETE FROM site_settings WHERE key = 'quote.settings'`;
  };
  await cleanupProformas();
});
onBeforeDatabaseClose(async () => {
  await cleanupProformas();
  await restoreSettings?.();
});
onDatabaseClosing(async () => {
  await smtp?.close();
  await imap?.close();
});

async function cleanupProformas() {
  const like = `${crm.prefix}%`;
  const ids = (await sql<Array<{ id: string }>>`SELECT id FROM customers WHERE contact_name LIKE ${like} OR email LIKE ${like}`).map((r) => r.id);
  if (ids.length) {
    await sql`DELETE FROM proformas WHERE customer_id = ANY(${ids}::uuid[])`;
    await sql`DELETE FROM domain_renewals WHERE domain_id IN (SELECT id FROM domains WHERE customer_id = ANY(${ids}::uuid[]))`;
    await sql`DELETE FROM invoices WHERE customer_id = ANY(${ids}::uuid[])`;
    await sql`DELETE FROM email_drafts WHERE subject LIKE 'Proforma PF%' AND to_addrs::text LIKE ${'%' + crm.prefix + '%'}`;
  }
  await sql`DELETE FROM document_sequences WHERE kind = 'proforma' AND year = ANY(${TEST_YEARS})`;
}

function isoDate(daysFromToday: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromToday);
  return d.toISOString().slice(0, 10);
}

/** issueProformaTx con le impostazioni caricate prima della transazione (come issueProforma). */
async function issueProformaTxSettings() {
  return loadIssueSettings();
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tx di postgres-js
type Tx = any;
let cachedSettings: Awaited<ReturnType<typeof loadIssueSettings>> | null = null;
async function settingsOnce() {
  cachedSettings ??= await issueProformaTxSettings();
  return cachedSettings;
}
async function issueInTx(id: string, input: { issue_date?: string; number?: string | number } = {}, inside?: (tx: Tx) => Promise<void>) {
  const settings = await settingsOnce();
  return sql.begin(async (tx: Tx) => {
    const row = await issueTxWithSettings(tx, id, input, settings);
    if (inside) await inside(tx);
    return row;
  });
}

async function draftFor(customerId: string, euros = 50) {
  return createProformaDraft({ customer_id: customerId, lines: [{ description: 'Assistenza', quantity: 1, unit_price_cents: euros * 100 }] });
}

/** PDF della proforma: vero se c'è Chrome, altrimenti un PDF minimo scritto a mano (per i test di invio). */
async function ensurePdf(id: string): Promise<void> {
  const row = await getProforma(id);
  if (row?.pdf_path) return;
  const name = `test-${id}.pdf`;
  await savePrivateFile('proformas', name, fakePdf(1500));
  await sql`UPDATE proformas SET pdf_path = ${`proformas/${name}`} WHERE id = ${id}`;
}

describe('importi (forfettario)', () => {
  const rule = { threshold_cents: 7747, amount_cents: 200 };
  test('bollo sopra 77,47 € (strettamente maggiore), incluso nel totale', () => {
    const at = (cents: number) => computeProformaTotals([{ description: 'x', quantity: 1, unit_price_cents: cents }], { applyStampDuty: true, stampDuty: rule });
    assert.equal(at(7746).stamp_duty_cents, 0);
    assert.equal(at(7747).stamp_duty_cents, 0);
    const above = at(7748);
    assert.equal(above.stamp_duty_cents, 200);
    assert.equal(above.total_cents, 7948);
    assert.equal(above.lines.at(-1)?.kind, 'stamp_duty');
  });

  test('più righe, quantità decimali e arrotondamento al centesimo', () => {
    const t = computeProformaTotals([
      { description: 'Ore', quantity: 1.5, unit_price_cents: 1999 },
      { description: 'Dominio', quantity: 2, unit_price_cents: 1500, kind: 'domain_renewal', domain_id: 'd', years: 2 },
    ], { applyStampDuty: true, stampDuty: rule });
    assert.deepEqual(t.lines.slice(0, 2).map((l) => l.amount_cents), [2999, 3000]);
    assert.equal(t.subtotal_cents, 5999);
    assert.equal(t.stamp_duty_cents, 0);
  });
});

describe('numerazione PF n/anno', () => {
  test('parse del numero indicato a mano', () => {
    assert.deepEqual(parseProformaNumber(3), { seq: 3 });
    assert.deepEqual(parseProformaNumber('3/2026'), { seq: 3, year: 2026 });
    assert.deepEqual(parseProformaNumber(' PF 12 / 2026 '), { seq: 12, year: 2026 });
    assert.equal(parseProformaNumber('3-2026'), null);
    assert.equal(parseProformaNumber(0), null);
  });

  test('20 emissioni concorrenti: numeri 1..20 senza duplicati né buchi, formato "PF n/anno"', async () => {
    const c = await crm.customer();
    const drafts = await Promise.all(Array.from({ length: 20 }, () => draftFor(c.id)));
    const issued = await Promise.all(drafts.map((d) => issueInTx(d.id, { issue_date: '2091-03-01' })));
    const seqs = issued.map((p) => p.seq!).sort((a, b) => a - b);
    assert.deepEqual(seqs, Array.from({ length: 20 }, (_, i) => i + 1));
    assert.ok(issued.every((p) => p.number === `PF ${p.seq}/2091`));
  });

  test('numero indicato a mano: avanza la sequenza, conflitto 409, i buchi si possono riempire', async () => {
    const c = await crm.customer();
    const issue = (id: string, body: Record<string, unknown>) => api.post(`/api/proformas/${id}/issue`, { auth: 'admin', body: { issue_date: '2092-05-10', ...body } });
    const a = await draftFor(c.id);
    const first = await issue(a.id, { number: 7 });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.proforma.number, 'PF 7/2092');
    const b = await draftFor(c.id);
    assert.equal((await issue(b.id, {})).json.proforma.number, 'PF 8/2092', 'il successivo automatico continua dopo il 7');
    const dup = await draftFor(c.id);
    const conflict = await issue(dup.id, { number: '7/2092' });
    assert.equal(conflict.status, 409);
    assert.match(conflict.json.error, /PF 7\/2092/);
    assert.equal((await issue(dup.id, { number: 'PF 3/2092' })).json.proforma.number, 'PF 3/2092');
    const d = await draftFor(c.id);
    assert.equal((await issue(d.id, {})).json.proforma.number, 'PF 9/2092');
  });

  test('rollback dell’emissione: il numero non viene bruciato', async () => {
    const c = await crm.customer();
    const a = await draftFor(c.id);
    await assert.rejects(issueInTx(a.id, { issue_date: '2093-01-10' }, async () => {
      throw new Error('boom');
    }), /boom/);
    assert.equal((await getProforma(a.id))!.status, 'draft');
    const res = await api.post(`/api/proformas/${a.id}/issue`, { auth: 'admin', body: { issue_date: '2093-01-10' } });
    assert.equal(res.json.proforma.number, 'PF 1/2093');
  });

  test('assignProformaNumber diretto: GREATEST e conflitto', async () => {
    await sql.begin(async (tx) => {
      assert.equal(await assignProformaNumber(tx, 2093, 50), 50);
      assert.equal(await assignProformaNumber(tx, 2093), 51);
      throw new Error('rollback voluto');
    }).catch(() => {});
    const [row] = await sql`SELECT last_number FROM document_sequences WHERE kind = 'proforma' AND year = 2093`;
    assert.equal(row.last_number, 1, 'la transazione annullata non lascia traccia');
  });
});

describe('API /api/proformas', () => {
  test('bozza: validazione strict con suggerimenti, modifica, eliminazione', async () => {
    const c = await crm.customer();
    const bad = await api.post('/api/proformas', { auth: 'admin', body: { customer_id: c.id, lines: [{ description: 'x', price: 10 }] } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /price: campo non riconosciuto: usa unit_price/);
    assert.match(bad.json.error, /unit_price: campo obbligatorio mancante/);

    const created = await api.post('/api/proformas', { auth: 'admin', body: { customer_id: c.id, lines: [{ description: 'Assistenza', quantity: 2, unit_price: '45,50' }], due_days: 30 } });
    assert.equal(created.status, 201, created.text);
    const p = created.json.proforma;
    assert.equal(p.status, 'draft');
    assert.equal(p.number, null);
    assert.equal(p.subtotal_cents, 9100);
    assert.equal(p.stamp_duty_cents, 200);
    assert.equal(p.total, 93);

    const patched = await api.patch(`/api/proformas/${p.id}`, { auth: 'admin', body: { lines: [{ description: 'Assistenza', unit_price: 40 }] } });
    assert.equal(patched.json.proforma.total_cents, 4000, 'sotto soglia: niente bollo');
    const del = await api.delete(`/api/proformas/${p.id}`, { auth: 'admin' });
    assert.equal(del.status, 200);
  });

  test('regime ordinario → 422', async () => {
    const c = await crm.customer();
    const res = await withSettings({ 'freelancer.studio': { vat_regime: 'ordinario' } }, () =>
      api.post('/api/proformas', { auth: 'admin', body: { customer_id: c.id, lines: [{ description: 'x', unit_price: 10 }] } }));
    assert.equal(res.status, 422);
  });

  test('dopo l’emissione: righe non modificabili, non eliminabile, annullabile', async () => {
    const c = await crm.customer();
    const d = await draftFor(c.id);
    await issueInTx(d.id);
    assert.equal((await api.patch(`/api/proformas/${d.id}`, { auth: 'admin', body: { notes: 'x' } })).status, 409);
    assert.equal((await api.delete(`/api/proformas/${d.id}`, { auth: 'admin' })).status, 409);
    const cancelled = await api.post(`/api/proformas/${d.id}/cancel`, { auth: 'admin', body: { reason: 'errore' } });
    assert.equal(cancelled.json.proforma.status, 'cancelled');
    assert.equal((await api.post(`/api/proformas/${d.id}/send`, { auth: 'admin' })).status, 409);
    assert.equal((await api.post(`/api/proformas/${d.id}/mark-paid`, { auth: 'admin' })).status, 409);
  });

  test('HTML della proforma: numero, diciture, bollo, IBAN, causale, escape', async () => {
    const c = await crm.customer({ company_name: 'Rossi & <Figli> Srl', vat_number: '12345678903', billing_address: { street: 'Via Roma 1', postal_code: '00100', city: 'Roma', province: 'RM' } });
    const d = await createProformaDraft({ customer_id: c.id, lines: [{ description: 'Sito', quantity: 1, unit_price_cents: 10000 }] });
    const issued = await issueInTx(d.id, { issue_date: '2091-06-01' });
    const html = renderProformaHtml(renderInputFor(issued));
    assert.match(html, /Proforma <span class="num">\d+\/2091<\/span>/);
    assert.match(html, /Documento non valido ai fini fiscali/);
    assert.match(html, /L\. 190\/2014/);
    assert.match(html, /Rivalsa imposta di bollo/);
    assert.match(html, /102,00/);
    assert.match(html, /IT60X0542811101000000123456/);
    assert.match(html, /Saldo proforma PF \d+\/2091/);
    assert.match(html, /Rossi &amp; &lt;Figli&gt; Srl/);
    assert.match(html, /P\.IVA 12345678903/);
  });

  test('PDF reale con Chrome', { skip: NO_CHROME }, async () => {
    const c = await crm.customer({ company_name: 'Crimatek Srl' });
    const d = await draftFor(c.id, 100);
    const issued = await api.post(`/api/proformas/${d.id}/issue`, { auth: 'admin', body: { issue_date: '2091-07-01' } });
    assert.equal(issued.status, 200, issued.text);
    assert.equal(issued.json.pdf_error, undefined, issued.json.pdf_error);
    assert.match(issued.json.proforma.pdf_url, /\/api\/files\/proformas\//);
    const pdf = await api.get(`/api/proformas/${d.id}/pdf`, { auth: 'admin' });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.contentType, 'application/pdf');
    assert.ok(pdf.text.startsWith('%PDF-'));
  });
});

describe('flusso rinnovo dominio', () => {
  async function scenario(opts: { renewal_cost?: number } = {}) {
    const amm = crm.email('amm');
    const gmail = crm.email('titolare');
    const customer = await crm.customer({
      company_name: 'Crimatek Srl', billing_emails: [amm, gmail], vat_number: '12345678903',
      billing_address: { street: 'Via Roma 1', postal_code: '00100', city: 'Roma', province: 'RM' },
    });
    const label = crm.domainLabel();
    const domain = (await crm.domain(customer.id, { domain_name: label, tld: 'com', expiration_date: isoDate(20), renewal_cost: opts.renewal_cost ?? 15, last_alert_milestone: 30 })) as { id: string; expiration_date: Date };
    return { customer, domain, amm, gmail, fullDomain: `${label}.com` };
  }

  test('dominio → proforma emessa con bozza email (PDF allegato) → invio → pagamento → fattura in bozza e nuova scadenza', async () => {
    const { customer, domain, amm, gmail, fullDomain } = await scenario();

    const created = await api.post(`/api/domains/${domain.id}/proforma`, { auth: 'admin', body: { delivery: 'draft', account_id: accountId } });
    assert.equal(created.status, 201, created.text);
    const p = created.json.proforma;
    assert.match(p.number, /^PF \d+\/\d{4}$/);
    assert.equal(p.status, 'issued');
    assert.equal(p.total, 15, 'sotto 77,47 €: niente bollo');
    assert.equal(p.domain_id, domain.id);
    assert.match(p.line_items[0].description, new RegExp(`Rinnovo dominio ${fullDomain.replace(/\./g, '\\.')} – 1 anno`));
    assert.deepEqual(p.customer_snapshot.recipients, [amm, gmail]);
    assert.equal(p.customer_snapshot.vat_number, '12345678903');
    if (NO_CHROME) await ensurePdf(p.id);

    // Bozza email (anche senza Chrome: se il PDF manca la route lo segnala in pdf_error).
    if (!created.json.pdf_error) {
      assert.deepEqual(created.json.draft.to_addrs, [amm, gmail]);
      assert.equal(created.json.draft.attachments[0].content_type, 'application/pdf');
      assert.match(created.json.draft.attachments[0].filename, /^Proforma \d+-\d{4}\.pdf$/);
    }

    // Una seconda proforma per lo stesso dominio mentre la prima è aperta → 409.
    const dup = await api.post(`/api/domains/${domain.id}/proforma`, { auth: 'admin', body: {} });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.existing.number, p.number);

    // Invio: ai billing_emails, PDF allegato, copia in Inviati, stato sent.
    smtp.messages.length = 0;
    imap.appended.length = 0;
    const sent = await api.post(`/api/proformas/${p.id}/send`, { auth: 'admin', body: { account_id: accountId } });
    assert.equal(sent.status, 200, sent.text);
    assert.equal(sent.json.proforma.status, 'sent');
    assert.deepEqual([...smtp.messages[0].rcpt].sort(), [amm, gmail].sort());
    const mail = await simpleParser(smtp.messages[0].raw);
    assert.match(mail.subject ?? '', new RegExp(`Proforma ${p.number.replace('/', '\\/')} – rinnovo dominio`));
    assert.match(mail.text ?? '', /Saldo proforma/);
    assert.equal(mail.attachments.length, 1);
    assert.equal(mail.attachments[0].contentType, 'application/pdf');
    const [{ pdf_path }] = await sql<Array<{ pdf_path: string }>>`SELECT pdf_path FROM proformas WHERE id = ${p.id}`;
    assert.ok(pdf_path);
    assert.equal(imap.appended.length, 1, 'copia in Inviati');

    // Con la proforma inviata il promemoria generico non parte per quel dominio.
    smtp.messages.length = 0;
    await withSettings({}, async () => {
      Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'false', SMTP_USER: 'x', SMTP_PASS: 'x' });
      const reminders = await api.post('/api/domains/send-reminders', { auth: 'admin' });
      assert.equal(reminders.status, 200, reminders.text);
    });
    assert.ok(!smtp.messages.some((m) => m.rcpt.includes(amm)), 'nessun promemoria al cliente che ha già la proforma');

    // Pagamento → fattura in BOZZA (decisione 4), dominio rinnovato, proforma convertita.
    const before = domain.expiration_date as Date;
    const paid = await api.post(`/api/proformas/${p.id}/mark-paid`, { auth: 'admin', body: { paid_at: isoDate(0), payment_method: 'bonifico' } });
    assert.equal(paid.status, 200, paid.text);
    assert.equal(paid.json.proforma.status, 'converted');
    assert.equal(paid.json.invoice.status, 'draft');
    assert.equal(Number(paid.json.invoice.tax_rate), 0);
    assert.equal(Number(paid.json.invoice.total), 15);
    assert.equal(paid.json.invoice.source, 'proforma');
    assert.equal(paid.json.invoice.invoice_number, null);
    assert.equal(paid.json.renewals.length, 1);

    const [d] = await sql<Array<{ expiration_date: string; last_alert_milestone: number | null }>>`
      SELECT expiration_date::text AS expiration_date, last_alert_milestone FROM domains WHERE id = ${domain.id}
    `;
    const expected = new Date(before);
    expected.setUTCFullYear(expected.getUTCFullYear() + 1);
    assert.equal(d.expiration_date, expected.toISOString().slice(0, 10));
    assert.equal(d.last_alert_milestone, null, 'milestone degli alert azzerata per la prossima scadenza');
    const [renewal] = await sql`SELECT invoice_id, cost FROM domain_renewals WHERE domain_id = ${domain.id}`;
    assert.equal(renewal.invoice_id, paid.json.invoice.id);
    assert.equal(Number(renewal.cost), 15);

    // Idempotenza: seconda chiamata → stessa fattura, nessun secondo rinnovo.
    const again = await api.post(`/api/proformas/${p.id}/mark-paid`, { auth: 'admin' });
    assert.equal(again.json.already_converted, true);
    assert.equal(again.json.invoice.id, paid.json.invoice.id);
    const renewals = await sql`SELECT id FROM domain_renewals WHERE domain_id = ${domain.id}`;
    assert.equal(renewals.length, 1);
    assert.equal((await api.post(`/api/proformas/${p.id}/cancel`, { auth: 'admin' })).status, 409);

    // Dopo il pagamento si può creare la proforma dell'anno dopo.
    const next = await api.post(`/api/domains/${domain.id}/proforma`, { auth: 'admin', body: { issue: false } });
    assert.equal(next.status, 201, next.text);
    assert.equal(customer.id, next.json.proforma.customer_id);
  });

  test('rinnovo pluriennale sopra soglia: bollo nella proforma e riga stamp_duty nella fattura pagata su richiesta', async () => {
    const { domain } = await scenario({ renewal_cost: 15 });
    const created = await api.post(`/api/domains/${domain.id}/proforma`, { auth: 'admin', body: { years: 6, number: undefined } });
    assert.equal(created.status, 201, created.text);
    const p = created.json.proforma;
    assert.equal(p.subtotal_cents, 9000);
    assert.equal(p.stamp_duty_cents, 200);
    assert.equal(p.total, 92);
    assert.match(p.legal_notes, /marca da bollo/);

    const paid = await api.post(`/api/proformas/${p.id}/mark-paid`, { auth: 'admin', body: { invoice_status: 'paid', invoice_number: `FT ${crm.prefix}` } });
    assert.equal(paid.status, 200, paid.text);
    assert.equal(paid.json.invoice.status, 'paid');
    assert.equal(paid.json.invoice.invoice_number, `FT ${crm.prefix}`);
    assert.equal(Number(paid.json.invoice.amount_due), 0);
    const stamp = paid.json.invoice.line_items.find((l: { kind: string }) => l.kind === 'stamp_duty');
    assert.equal(stamp.amount, 2);
    assert.equal(paid.json.renewals[0].expiration_after.slice(0, 4), String(Number(paid.json.renewals[0].expiration_before.slice(0, 4)) + 6));
  });

  test('dominio senza renewal_cost: serve unit_price', async () => {
    const { domain } = await scenario();
    await sql`UPDATE domains SET renewal_cost = NULL WHERE id = ${domain.id}`;
    const res = await api.post(`/api/domains/${domain.id}/proforma`, { auth: 'admin', body: {} });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /unit_price/);
    const ok = await api.post(`/api/domains/${domain.id}/proforma`, { auth: 'admin', body: { unit_price: 18, issue: false } });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.json.proforma.total, 18);
  });
});

describe('POST /api/domains/:id/renew', () => {
  test('validazione, scadenza dalla precedente, milestone azzerata, invoice_id registrato', async () => {
    const c = await crm.customer();
    const domain = (await crm.domain(c.id, { expiration_date: '2027-02-28', last_alert_milestone: 7 })) as { id: string };
    assert.equal((await api.post(`/api/domains/${domain.id}/renew`, { auth: 'admin', body: { years: 0 } })).status, 400);
    assert.equal((await api.post(`/api/domains/${domain.id}/renew`, { auth: 'admin', body: { anni: 1 } })).status, 400);
    const res = await api.post(`/api/domains/${domain.id}/renew`, { auth: 'admin', body: { years: 2, cost: 30 } });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.renewal.new_expiration, '2029-02-28');
    const [d] = await sql`SELECT last_alert_milestone FROM domains WHERE id = ${domain.id}`;
    assert.equal(d.last_alert_milestone, null);
    assert.equal((await api.post('/api/domains/00000000-0000-4000-8000-000000000000/renew', { auth: 'admin', body: {} })).status, 404);
  });
});

describe('tool MCP', () => {
  test('create_domain_renewal_proforma → mark_proforma_paid (fattura in bozza)', async () => {
    const c = await crm.customer({ billing_emails: [crm.email('mcp-amm')] });
    const domain = (await crm.domain(c.id, { expiration_date: isoDate(15), renewal_cost: 20 })) as { id: string };
    const created = JSON.parse(await executeTool('create_domain_renewal_proforma', { domain_id: domain.id }));
    assert.match(created.number, /^PF \d+\/\d{4}$/, JSON.stringify(created));
    assert.deepEqual(created.recipients, [crm.email('mcp-amm')]);
    const list = JSON.parse(await executeTool('list_proformas', { domain_id: domain.id }));
    assert.equal(list.proformas[0].number, created.number);
    const paid = JSON.parse(await executeTool('mark_proforma_paid', { proforma_id: created.proforma_id, payment_method: 'bonifico' }));
    assert.equal(paid.invoice.status, 'draft', JSON.stringify(paid));
    assert.equal(paid.renewals.length, 1);
    const wrong = JSON.parse(await executeTool('create_domain_renewal_proforma', { domain_id: domain.id, prezzo: 1 }));
    assert.match(String(wrong.error), /prezzo/);
  });

  test('send_proforma: PDF allegato lato server ai billing_emails', async () => {
    const amm = crm.email('mcp-send');
    const c = await crm.customer({ billing_emails: [amm] });
    const d = await draftFor(c.id, 30);
    await issueInTx(d.id);
    await ensurePdf(d.id);
    smtp.messages.length = 0;
    const r = JSON.parse(await executeTool('send_proforma', { proforma_id: d.id, account_id: accountId }));
    assert.equal(r.sent, true, JSON.stringify(r));
    assert.deepEqual(r.to, [amm]);
    const mail = await simpleParser(smtp.messages[0].raw);
    const [row] = await sql<Array<{ pdf_path: string }>>`SELECT pdf_path FROM proformas WHERE id = ${d.id}`;
    assert.ok(row.pdf_path);
    assert.equal(mail.attachments[0].contentType, 'application/pdf');
    assert.ok(createHash('sha256').update(mail.attachments[0].content).digest('hex'));
  });
});
