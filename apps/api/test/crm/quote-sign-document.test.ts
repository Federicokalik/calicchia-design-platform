/**
 * Pagina di firma dei preventivi: il cliente deve poter LEGGERE il documento
 * che firma.
 *  - preventivi a template: GET /api/quote-sign/:token espone has_document /
 *    document_type 'pdf' quando il PDF esiste, e /document lo serve inline
 *    (o come allegato con ?download=1), incorporabile dalla pagina admin;
 *  - una modifica ai contenuti invalida il PDF salvato (pdf_path → NULL);
 *  - riepilogo_importo sostituisce il totale nei messaggi di invio;
 *  - l'invio rigenera il PDF, lo allega alla mail e apre con "Messaggio
 *    automatico" (richiede Chrome/Chromium per il PDF reale).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { simpleParser } from 'mailparser';
import { onBeforeDatabaseClose, onDatabaseClosing, onDatabaseReady, sql, useTestDatabase } from '../helpers/db';
import { fakePdf, findChrome, useCrmFixtures } from '../helpers/crm';
import { api } from '../helpers/http';
import { startFakeSmtp, type FakeSmtpServer } from '../helpers/mail-servers';
import { jsonb } from '../../src/db';
import { savePrivateFile } from '../../src/lib/private-files';
import { formatEuroAmount, quoteAmountSummary, quoteCustomAmountSummary } from '../../src/lib/quotes/format';

useTestDatabase();

const crm = useCrmFixtures('crm-quote-sign-doc');

// I preventivi referenziano i clienti: vanno tolti prima della pulizia CRM.
// I task di chiusura girano in ordine inverso, quindi questo (registrato dopo
// useCrmFixtures) parte per primo.
async function cleanupQuotes(): Promise<void> {
  const like = `${crm.prefix}%`;
  const ids = (await sql<Array<{ id: string }>>`SELECT id FROM quotes_v2 WHERE title LIKE ${like}`).map((r) => r.id);
  if (!ids.length) return;
  await sql`DELETE FROM signature_audit_log WHERE quote_id = ANY(${ids}::uuid[])`;
  await sql`DELETE FROM quotes_v2 WHERE id = ANY(${ids}::uuid[])`;
}
onBeforeDatabaseClose(cleanupQuotes);

const chrome = findChrome();
const NO_CHROME = chrome ? false : 'Chrome/Chromium non disponibile: PDF reale non generabile';

let smtp: FakeSmtpServer;
onDatabaseReady(async () => {
  smtp = await startFakeSmtp();
  // Il transporter di lib/email.ts è un singleton creato al primo invio.
  Object.assign(process.env, {
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_SECURE: 'false',
    SMTP_USER: 'sistema@example.test',
    SMTP_PASS: 'x',
    EMAIL_FROM: 'Calicchia Design <hi@example.test>',
  });
  if (chrome) process.env.PUPPETEER_EXECUTABLE_PATH ??= chrome;
});
onDatabaseClosing(async () => {
  await smtp?.close();
});

const SECTIONS = [
  { id: 'p1', type: 'premessa', data: { testo: 'Premessa di test', statistiche: [] } },
  {
    id: 'o1',
    type: 'offerte',
    data: { offerte: [{ id: 'o1a', nome: 'Sito di test', descrizione: '', prezzo: 1490, consigliata: false, include: ['Design'], esclude: [] }] },
  },
];

async function createQuote(extra: Record<string, unknown> = {}) {
  const customer = await crm.customer({ phone: null });
  const [q] = await sql<Array<{ id: string; signature_token: string }>>`
    INSERT INTO quotes_v2 (customer_id, title, items, subtotal, tax_rate, total, status, project_template)
    VALUES (
      ${customer.id}, ${crm.name('preventivo')},
      ${jsonb([{ description: 'Sito di test', quantity: 1, unit_price: 1490, total: 1490 }])},
      1490, 0, 1490, 'draft',
      ${jsonb({ sections: SECTIONS, ...extra })}
    )
    RETURNING id, signature_token
  `;
  return { ...q, customer };
}

async function attachFakePdf(quoteId: string): Promise<string> {
  const name = `test_${quoteId}_${Date.now()}.pdf`;
  await savePrivateFile('quotes', name, fakePdf(4096));
  await sql`UPDATE quotes_v2 SET pdf_path = ${`quotes/${name}`} WHERE id = ${quoteId}`;
  return name;
}

describe('quoteAmountSummary', () => {
  test('riepilogo_importo vince sul totale, anche da JSON doppiamente codificato', () => {
    assert.equal(quoteAmountSummary({ total: '6478.00', project_template: { riepilogo_importo: '  €540 al mese  per 12 mesi ' } }), '€540 al mese per 12 mesi');
    assert.equal(quoteAmountSummary({ total: '6478.00', project_template: JSON.stringify({ riepilogo_importo: '€540/mese' }) }), '€540/mese');
    assert.equal(quoteAmountSummary({ total: '6478.00', project_template: { riepilogo_importo: '   ' } }), '€6.478');
    assert.equal(quoteAmountSummary({ total: '149.5', project_template: null }), '€149,5');
    assert.equal(formatEuroAmount(1234.56), '1.234,56');
    assert.equal(formatEuroAmount(1250000), '1.250.000');
    assert.equal(formatEuroAmount(190.83), '190,83');
    assert.equal(quoteCustomAmountSummary({}), null);
    assert.equal(quoteCustomAmountSummary({ riepilogo_importo: 'x'.repeat(300) })?.length, 120);
  });
});

describe('documento nella pagina di firma (preventivo a template)', () => {
  test('senza PDF: nessun documento; con PDF: has_document e /document serve il PDF', async () => {
    const q = await createQuote({ riepilogo_importo: '€540 al mese per 12 mesi' });

    const before = await api.get(`/api/quote-sign/${q.signature_token}`);
    assert.equal(before.status, 200, before.text);
    assert.equal(before.json.quote.has_document, false);
    assert.equal(before.json.quote.document_type, null);
    assert.equal(before.json.quote.amount_summary, '€540 al mese per 12 mesi');
    assert.equal(before.json.quote.pdf_path, undefined, 'il percorso nello storage resta lato server');
    assert.equal((await api.get(`/api/quote-sign/${q.signature_token}/document`)).status, 404);

    await attachFakePdf(q.id);

    const after = await api.get(`/api/quote-sign/${q.signature_token}`);
    assert.equal(after.json.quote.has_document, true);
    assert.equal(after.json.quote.document_type, 'pdf');

    const doc = await api.get(`/api/quote-sign/${q.signature_token}/document`);
    assert.equal(doc.status, 200, doc.text);
    assert.equal(doc.contentType, 'application/pdf');
    assert.ok(doc.text.startsWith('%PDF'), 'corpo PDF');
    assert.match(doc.headers.get('content-disposition') ?? '', /^inline;/);
    assert.equal(doc.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.match(doc.headers.get('content-security-policy') ?? '', /frame-ancestors 'self'/);
    assert.equal(doc.headers.get('cache-control'), 'private, no-store');

    const dl = await api.get(`/api/quote-sign/${q.signature_token}/document`, { query: { download: '1' } });
    assert.match(dl.headers.get('content-disposition') ?? '', /^attachment;/);
  });

  test('PDF indicato ma assente dallo storage: nessun documento', async () => {
    const q = await createQuote();
    await sql`UPDATE quotes_v2 SET pdf_path = 'quotes/non_esiste.pdf' WHERE id = ${q.id}`;
    const res = await api.get(`/api/quote-sign/${q.signature_token}`);
    assert.equal(res.json.quote.has_document, false);
    assert.equal((await api.get(`/api/quote-sign/${q.signature_token}/document`)).status, 404);
  });

  test('modifica dei contenuti → PDF invalidato; note interne → PDF conservato', async () => {
    const q = await createQuote();
    await attachFakePdf(q.id);

    const internal = await api.put(`/api/quotes-v2/${q.id}`, { auth: 'admin', body: { internal_notes: 'solo per me' } });
    assert.equal(internal.status, 200, internal.text);
    assert.ok(internal.json.quote.pdf_path, 'le note interne non entrano nel documento');

    const edited = await api.put(`/api/quotes-v2/${q.id}`, { auth: 'admin', body: { title: crm.name('preventivo-modificato') } });
    assert.equal(edited.status, 200, edited.text);
    assert.equal(edited.json.quote.pdf_path, null);
    const res = await api.get(`/api/quote-sign/${q.signature_token}`);
    assert.equal(res.json.quote.has_document, false, 'un PDF superato non viene mostrato al cliente');
  });
});

describe('invio del preventivo', () => {
  test('rigenera il PDF, lo allega e usa il riepilogo importo', { skip: NO_CHROME }, async () => {
    const q = await createQuote({ riepilogo_importo: '€540 al mese per 12 mesi' });
    smtp.messages.length = 0;

    const sent = await api.post(`/api/quotes-v2/${q.id}/send`, { auth: 'admin', body: { channels: ['email'] } });
    assert.equal(sent.status, 200, sent.text);
    assert.deepEqual(sent.json.sent_via, ['email']);

    const [row] = await sql<Array<{ pdf_path: string | null; status: string }>>`SELECT pdf_path, status FROM quotes_v2 WHERE id = ${q.id}`;
    assert.ok(row.pdf_path, 'PDF generato prima dell\'invio');
    assert.equal(row.status, 'sent');

    assert.equal(smtp.messages.length, 1);
    const mail = await simpleParser(smtp.messages[0].raw);
    assert.equal(mail.attachments.length, 1);
    assert.equal(mail.attachments[0].contentType, 'application/pdf');
    assert.ok(mail.attachments[0].content.subarray(0, 4).toString() === '%PDF');
    const text = mail.text ?? '';
    assert.match(text, /^Messaggio automatico/);
    assert.match(text, /€540 al mese per 12 mesi/);
    assert.doesNotMatch(text, /€1\.490/, 'il totale grezzo non compare quando c\'è il riepilogo');

    const page = await api.get(`/api/quote-sign/${q.signature_token}`);
    assert.equal(page.json.quote.document_type, 'pdf');
  });
});
