/**
 * Brand kit in PDF (fase 2 della Palette di settore): richiesta con consenso
 * versionato, double opt-in con conferma in POST, invio del PDF allegato,
 * export GDPR, pulizia dei dati e HTML del documento.
 *
 * Niente Chromium né SMTP: paletteKitTesting sostituisce il PDF con pochi
 * byte e cattura le email invece di spedirle.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KIT_CONSENT_VERSION, type SharedPalette } from '@calicchia/shared/palette';
import { onBeforeDatabaseClose, onDatabaseReady, sql, useTestDatabase } from '../helpers/db';
import { api } from '../helpers/http';
import {
  cleanupPaletteKit,
  paletteKitTesting,
  PALETTE_KIT_LIST_NAME,
  runPaletteKitSender,
} from '../../src/lib/palette-kit';
import { renderBrandKitHtml } from '../../src/lib/palette-kit/document';

useTestDatabase();

const EMAIL_DOMAIN = 'palette-kit.caldes.test';
const PALETTE: SharedPalette = {
  v: 1,
  sector: 'dentisti',
  preset: 'netto',
  colors: ['8DE8B3', '#C1CCCA', '#52A4E3', '#3D474F', '#152027'],
  primary: 2,
};

interface SentMail {
  to: string | string[];
  subject: string;
  transport?: string;
  headers?: Record<string, string>;
  attachments?: Array<{ filename: string; content: Buffer | string; contentType?: string }>;
  html: string;
}
const sent: SentMail[] = [];

paletteKitTesting.setPdfRenderer(async () => Buffer.from('%PDF-1.4 finto'));
paletteKitTesting.setMailer(async (opts) => {
  sent.push(opts as SentMail);
  return { success: true, messageId: `m-${sent.length}` };
});

async function cleanup(): Promise<void> {
  await sql`DELETE FROM mkt_contacts WHERE email LIKE ${`%@${EMAIL_DOMAIN}`}`;
  await sql`DELETE FROM mkt_suppression WHERE email_norm LIKE ${`%@${EMAIL_DOMAIN}`}`;
}
onDatabaseReady(cleanup);
onBeforeDatabaseClose(async () => {
  await cleanup();
  paletteKitTesting.reset();
});

function body(local: string, extra: Record<string, unknown> = {}) {
  return {
    email: `${local}@${EMAIL_DOMAIN}`,
    name: 'Giulia',
    palette: PALETTE,
    sector_label: 'Dentisti',
    locale: 'it',
    consent: true,
    consent_version: KIT_CONSENT_VERSION,
    turnstile_token: 'test',
    ...extra,
  };
}

function tokenFrom(mail: SentMail): string {
  const m = mail.html.match(/kit\/confirm\?t=([0-9a-f-]{36})/);
  assert.ok(m, 'link di conferma nell’email');
  return m[1];
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 3_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error('condizione non raggiunta in tempo');
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('richiesta: senza consenso o con versione del testo diversa → 400', async () => {
  const noConsent = await api.post('/api/palette/kit', { body: body('no-consenso', { consent: false }) });
  assert.equal(noConsent.status, 400);
  const oldText = await api.post('/api/palette/kit', { body: body('vecchio-testo', { consent_version: '2020-01-01' }) });
  assert.equal(oldText.status, 400);
  const badLabel = await api.post('/api/palette/kit', { body: body('etichetta', { sector_label: '<b>x</b>' }) });
  assert.equal(badLabel.status, 400);
});

test('richiesta → conferma → PDF allegato all’email di benvenuto', async () => {
  sent.length = 0;
  const res = await api.post('/api/palette/kit', { body: body('flusso') });
  assert.equal(res.status, 202, res.text);

  const [contact] = await sql<Array<{ id: string; email_consent: string; consent_source: string; tags: string[]; first_name: string }>>`
    SELECT id, email_consent, consent_source, tags, first_name FROM mkt_contacts WHERE email_norm = ${`flusso@${EMAIL_DOMAIN}`}`;
  assert.equal(contact.email_consent, 'unconfirmed');
  assert.equal(contact.consent_source, 'palette-kit');
  assert.ok(contact.tags.includes('palette-kit'));
  assert.equal(contact.first_name, 'Giulia');

  const [req] = await sql<Array<{ kind: string; palette: Record<string, unknown>; consent_version: string; sector_label: string }>>`
    SELECT jsonb_typeof(palette) AS kind, palette, consent_version, sector_label FROM palette_kit_requests WHERE contact_id = ${contact.id}`;
  assert.equal(req.kind, 'object', 'jsonb() e non JSON.stringify');
  assert.deepEqual(req.palette.colors, ['#8DE8B3', '#C1CCCA', '#52A4E3', '#3D474F', '#152027'], 'hex normalizzati');
  assert.equal(req.palette.locale, 'it');
  assert.equal(req.consent_version, KIT_CONSENT_VERSION);
  assert.equal(req.sector_label, 'Dentisti');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].transport, 'critical');
  assert.ok(!sent[0].html.includes('Giulia'), 'niente testo del visitatore nella conferma');
  const token = tokenFrom(sent[0]);

  // GET: pagina con il bottone, nessuna modifica (gli antivirus aprono i link).
  const page = await api.get('/api/palette/kit/confirm', { query: { t: token } });
  assert.equal(page.status, 200);
  assert.match(page.text, /method="post"/);
  const [still] = await sql`SELECT confirmed_at FROM palette_kit_requests WHERE confirm_token = ${token}::uuid`;
  assert.equal(still.confirmed_at, null);

  const form = new FormData();
  form.set('t', token);
  const confirmed = await api.post('/api/palette/kit/confirm', { body: form });
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.match(confirmed.text, /Iscrizione confermata/);

  const [after] = await sql<Array<{ email_consent: string }>>`SELECT email_consent FROM mkt_contacts WHERE id = ${contact.id}`;
  assert.equal(after.email_consent, 'confirmed');
  const [member] = await sql`
    SELECT 1 FROM mkt_list_members m JOIN mkt_lists l ON l.id = m.list_id
    WHERE m.contact_id = ${contact.id} AND l.name = ${PALETTE_KIT_LIST_NAME}`;
  assert.ok(member, 'iscritto alla lista della newsletter');

  // L'invio parte subito dopo la conferma.
  const welcome = await waitFor(async () => sent.find((m) => m.transport === 'marketing'));
  assert.equal(welcome.attachments?.[0].filename, 'brand-kit-dentisti.pdf');
  assert.equal(welcome.attachments?.[0].contentType, 'application/pdf');
  assert.match(welcome.headers?.['List-Unsubscribe'] ?? '', /\/api\/mkt-track\/u\//);
  assert.match(welcome.html, /Giulia/);
  const [done] = await sql`SELECT sent_at, attempts FROM palette_kit_requests WHERE contact_id = ${contact.id}`;
  assert.ok(done.sent_at, 'sent_at valorizzato');
  assert.equal(done.attempts, 1);

  // Secondo POST con lo stesso token: già confermata, nessun nuovo invio.
  const again = await api.post('/api/palette/kit/confirm', { body: form });
  assert.equal(again.status, 200);
  assert.match(again.text, /Già confermata/);
  await runPaletteKitSender();
  assert.equal(sent.filter((m) => m.transport === 'marketing').length, 1);

  // Export GDPR: la richiesta c'è.
  const exp = await api.get(`/api/gdpr-requests/export/${encodeURIComponent(`flusso@${EMAIL_DOMAIN}`)}`, { auth: 'admin' });
  assert.equal(exp.status, 200, exp.text);
  assert.equal(exp.json.palette_brand_kits.length, 1);
  assert.equal(exp.json.palette_brand_kits[0].palette.preset, 'netto');
});

test('stessa email entro 10 minuti: una sola email di conferma', async () => {
  sent.length = 0;
  await api.post('/api/palette/kit', { body: body('doppia') });
  await api.post('/api/palette/kit', { body: body('doppia') });
  const rows = await sql`
    SELECT r.id FROM palette_kit_requests r JOIN mkt_contacts c ON c.id = r.contact_id
    WHERE c.email_norm = ${`doppia@${EMAIL_DOMAIN}`}`;
  assert.equal(rows.length, 1);
  assert.equal(sent.length, 1);
});

test('indirizzo in suppression o disiscritto: 202 ma niente email né richiesta', async () => {
  sent.length = 0;
  await sql`INSERT INTO mkt_suppression (email_norm, reason) VALUES (${`soppresso@${EMAIL_DOMAIN}`}, 'unsubscribed')`;
  const res = await api.post('/api/palette/kit', { body: body('soppresso') });
  assert.equal(res.status, 202);
  await sql`INSERT INTO mkt_contacts (email, email_consent) VALUES (${`disiscritto@${EMAIL_DOMAIN}`}, 'unsubscribed')`;
  const res2 = await api.post('/api/palette/kit', { body: body('disiscritto') });
  assert.equal(res2.status, 202);
  assert.equal(sent.length, 0);
  const rows = await sql`
    SELECT r.id FROM palette_kit_requests r JOIN mkt_contacts c ON c.id = r.contact_id
    WHERE c.email_norm IN (${`soppresso@${EMAIL_DOMAIN}`}, ${`disiscritto@${EMAIL_DOMAIN}`})`;
  assert.equal(rows.length, 0);
});

test('richiesta in inglese: link con l=en e pagina di conferma in inglese', async () => {
  sent.length = 0;
  await api.post('/api/palette/kit', { body: body('inglese', { locale: 'en', sector_label: 'Dentists' }) });
  assert.match(sent[0].html, /kit\/confirm\?t=[0-9a-f-]{36}&(amp;)?l=en/);
  const token = tokenFrom(sent[0]);
  const page = await api.get('/api/palette/kit/confirm', { query: { t: token, l: 'en' } });
  assert.equal(page.status, 200);
  assert.match(page.text, /lang="en"/);
  assert.match(page.text, /Confirm my subscription/);
  assert.match(page.text, /name="l" value="en"/);
});

test('token sconosciuto o malformato: 404 in GET e in POST', async () => {
  const get = await api.get('/api/palette/kit/confirm', { query: { t: 'non-un-token' } });
  assert.equal(get.status, 404);
  const form = new FormData();
  form.set('t', '00000000-0000-4000-8000-000000000000');
  const post = await api.post('/api/palette/kit/confirm', { body: form });
  assert.equal(post.status, 404);
});

test('invio fallito: errore registrato e nuovo tentativo più tardi', async () => {
  sent.length = 0;
  await api.post('/api/palette/kit', { body: body('fallisce') });
  const token = tokenFrom(sent[0]);
  paletteKitTesting.setMailer(async (opts) => {
    if ((opts as SentMail).transport === 'marketing') return { success: false, error: 'smtp giù' };
    sent.push(opts as SentMail);
    return { success: true };
  });
  try {
    const form = new FormData();
    form.set('t', token);
    await api.post('/api/palette/kit/confirm', { body: form });
    const row = await waitFor(async () => {
      const [r] = await sql<Array<{ attempts: number; last_error: string | null; sent_at: Date | null; due: boolean }>>`
        SELECT attempts, last_error, sent_at, next_attempt_at > now() AS due FROM palette_kit_requests WHERE confirm_token = ${token}::uuid`;
      return r.last_error ? r : undefined;
    });
    assert.equal(row.sent_at, null);
    assert.equal(row.attempts, 1);
    assert.equal(row.last_error, 'smtp giù');
    assert.equal(row.due, true, 'prossimo tentativo nel futuro');
  } finally {
    paletteKitTesting.setMailer(async (opts) => {
      sent.push(opts as SentMail);
      return { success: true };
    });
  }
});

test('pulizia: richieste non confermate e contatti nati solo da quelle spariscono dopo 7 giorni', async () => {
  sent.length = 0;
  await api.post('/api/palette/kit', { body: body('vecchia') });
  await sql`
    UPDATE mkt_contacts SET created_at = now() - interval '8 days' WHERE email_norm = ${`vecchia@${EMAIL_DOMAIN}`}`;
  await sql`
    UPDATE palette_kit_requests SET created_at = now() - interval '8 days'
    WHERE contact_id = (SELECT id FROM mkt_contacts WHERE email_norm = ${`vecchia@${EMAIL_DOMAIN}`})`;
  await cleanupPaletteKit();
  const [left] = await sql`SELECT id FROM mkt_contacts WHERE email_norm = ${`vecchia@${EMAIL_DOMAIN}`}`;
  assert.equal(left, undefined);
});

test('documento: 5 pagine, codici dei colori, testo escapato, EN', () => {
  const html = renderBrandKitHtml({
    palette: PALETTE,
    locale: 'it',
    sectorLabel: 'Bar & caffè',
    shareUrl: 'https://example.test/condividi?v=1',
    date: new Date('2026-10-16T10:00:00Z'),
    fontCss: '',
  });
  assert.equal(html.match(/<section class="page/g)?.length, 5);
  assert.match(html, /#52A4E3/);
  assert.match(html, /RGB/);
  assert.match(html, /La palette per bar &amp; caffè/);
  assert.match(html, /Contrasti \(WCAG 2\.2\)/);

  const en = renderBrandKitHtml({
    palette: PALETTE,
    locale: 'en',
    sectorLabel: null,
    shareUrl: 'https://example.test/condividi?v=1',
    date: new Date('2026-10-16T10:00:00Z'),
    fontCss: '',
  });
  assert.match(en, /lang="en"/);
  assert.match(en, /Your palette/);
});
