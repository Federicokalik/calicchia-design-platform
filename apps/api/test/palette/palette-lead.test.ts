/**
 * Palette sul lead: brand_palette scritta come oggetto jsonb su contacts e
 * leads, sequenza email palette-onboarding (pianificazione, disiscrizione,
 * template IT/EN) e query del job.
 *
 * Nessuna email parte davvero: helpers/env.ts rimuove SMTP_* e RESEND_*,
 * quindi sendEmail risponde { success: false } e la riga resta in coda.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrandPalette } from '@calicchia/shared/palette';
import { onBeforeDatabaseClose, onDatabaseReady, sql, useTestDatabase } from '../helpers/db';
import { api } from '../helpers/http';
import {
  paletteUnsubscribeUrl,
  runLeadPaletteSequence,
  schedulePaletteOnboardingSequence,
  signPaletteUnsubscribe,
  verifyPaletteUnsubscribe,
} from '../../src/jobs/lead-palette-sequence';
import { renderPaletteEmail1 } from '../../src/templates/palette-email-1';
import { renderPaletteEmail2 } from '../../src/templates/palette-email-2';
import { renderPaletteEmail3 } from '../../src/templates/palette-email-3';

useTestDatabase();

const EMAIL_DOMAIN = 'palette-lead.caldes.test';
/** Forma inviata dal sito; 'c63d2b' prova la normalizzazione degli hex. */
const PALETTE: BrandPalette = {
  v: 1,
  sector: 'pizzerie',
  preset: 'morbido',
  colors: ['c63d2b', '#EFE5D2', '#2B2B2B'],
  primary: 0,
  locale: 'it',
};

async function cleanup(): Promise<void> {
  // email_sequences cade in cascata con contacts.
  await sql`DELETE FROM leads WHERE email LIKE ${`%@${EMAIL_DOMAIN}`}`;
  await sql`DELETE FROM contacts WHERE email LIKE ${`%@${EMAIL_DOMAIN}`}`;
}

// Non before/after: l'after di useTestDatabase chiude il pool prima dei nostri.
onDatabaseReady(cleanup);
onBeforeDatabaseClose(cleanup);

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 3_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error('condizione non raggiunta in tempo');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function contactBody(local: string, extra: Record<string, unknown> = {}) {
  return {
    name: 'Lead Palette',
    email: `${local}@${EMAIL_DOMAIN}`,
    message: 'Ho creato una palette con lo strumento e vorrei usarla per il mio sito.',
    gdpr_consent: true,
    lead_source: 'palette-di-settore',
    source_profession: 'pizzerie',
    turnstile_token: 'test',
    ...extra,
  };
}

test('contatti: brand_palette salvata come oggetto jsonb su contacts e leads, sequenza pianificata', async () => {
  const res = await api.post('/api/contacts', { body: contactBody('con-palette', { brand_palette: PALETTE }) });
  assert.equal(res.status, 200, res.text);
  const contactId: string = res.json.id;

  const [contact] = await sql<Array<{ kind: string; palette: Record<string, unknown> }>>`
    SELECT jsonb_typeof(brand_palette) AS kind, brand_palette AS palette FROM contacts WHERE id = ${contactId}
  `;
  assert.equal(contact.kind, 'object', 'jsonb() e non JSON.stringify: niente scalare stringa');
  // Hex normalizzati da brandPaletteSchema.
  assert.deepEqual(contact.palette.colors, ['#C63D2B', '#EFE5D2', '#2B2B2B']);
  assert.equal(contact.palette.locale, 'it');
  assert.equal(contact.palette.sector, 'pizzerie');

  const [lead] = await sql<Array<{ kind: string; colors: string }>>`
    SELECT jsonb_typeof(brand_palette) AS kind, brand_palette->>'preset' AS colors
    FROM leads WHERE source_id = ${contactId}
  `;
  assert.equal(lead.kind, 'object');
  assert.equal(lead.colors, 'morbido');

  // La pianificazione è asincrona rispetto alla risposta.
  const step = await waitFor(async () => {
    const [row] = await sql<Array<{ step: number }>>`
      SELECT step FROM email_sequences WHERE contact_id = ${contactId} AND sequence_type = 'palette-onboarding'
    `;
    return row;
  });
  assert.equal(step.step, 1);
});

test('contatti: palette non valida scartata senza bloccare il contatto, niente sequenza', async () => {
  const res = await api.post('/api/contacts', {
    body: contactBody('palette-rotta', { brand_palette: { v: 1, preset: 'boh', colors: ['zzz'], primary: 9, locale: 'it' } }),
  });
  assert.equal(res.status, 200, res.text);
  const [row] = await sql<Array<{ palette: unknown }>>`SELECT brand_palette AS palette FROM contacts WHERE id = ${res.json.id}`;
  assert.equal(row.palette, null);
  await new Promise((r) => setTimeout(r, 200));
  const seq = await sql`SELECT 1 FROM email_sequences WHERE contact_id = ${res.json.id}`;
  assert.equal(seq.length, 0);
});

test('contatti: senza lead_source palette la sequenza non parte', async () => {
  const contact = await api.post('/api/contacts', {
    body: contactBody('altra-fonte', { lead_source: 'audit-nope', brand_palette: PALETTE }),
  });
  assert.equal(contact.status, 200);
  assert.equal(await schedulePaletteOnboardingSequence(contact.json.id, 'audit-nope', PALETTE), false);
  const seq = await sql`
    SELECT 1 FROM email_sequences WHERE contact_id = ${contact.json.id} AND sequence_type = 'palette-onboarding'
  `;
  assert.equal(seq.length, 0);
});

test('disiscrizione: token firmato, chiude tutti gli step anche futuri', async () => {
  const [contact] = await sql<Array<{ id: string }>>`
    INSERT INTO contacts (name, email, message, lead_source, brand_palette)
    VALUES ('Lead Disiscritto', ${`unsub@${EMAIL_DOMAIN}`}, 'messaggio di prova', 'palette-di-settore', ${sql.json(PALETTE)})
    RETURNING id
  `;
  assert.equal(await schedulePaletteOnboardingSequence(contact.id, 'palette-di-settore', PALETTE), true);

  const token = signPaletteUnsubscribe(contact.id);
  assert.equal(verifyPaletteUnsubscribe(contact.id, token), true);
  assert.equal(verifyPaletteUnsubscribe(contact.id, `${token.slice(0, -2)}xx`), false);
  assert.equal(verifyPaletteUnsubscribe('non-un-uuid', token), false);
  assert.match(paletteUnsubscribeUrl(contact.id), /^https:\/\/api\.caldes\.test\/api\/palette\/unsubscribe\?c=/);

  const bad = await api.get('/api/palette/unsubscribe', { query: { c: contact.id, t: 'sbagliato' } });
  assert.equal(bad.status, 400);

  const ok = await api.get('/api/palette/unsubscribe', { query: { c: contact.id, t: token } });
  assert.equal(ok.status, 200);
  assert.match(ok.text, /Disiscrizione completata/);

  const rows = await sql<Array<{ step: number; closed: boolean }>>`
    SELECT step, sent_at IS NOT NULL AS closed FROM email_sequences
    WHERE contact_id = ${contact.id} AND sequence_type = 'palette-onboarding' ORDER BY step
  `;
  assert.deepEqual(rows.map((r) => [r.step, r.closed]), [
    [1, true],
    [2, true],
    [3, true],
  ]);

  // One-click (RFC 8058): idempotente.
  const oneClick = await api.post('/api/palette/unsubscribe', { query: { c: contact.id, t: token } });
  assert.equal(oneClick.status, 200);
});

test('job: legge la coda palette senza errori; senza trasporto email la riga resta in coda', async () => {
  const [contact] = await sql<Array<{ id: string }>>`
    INSERT INTO contacts (name, email, message, lead_source, brand_palette)
    VALUES ('Lead Job', ${`job@${EMAIL_DOMAIN}`}, 'messaggio di prova', 'palette-di-settore', ${sql.json(PALETTE)})
    RETURNING id
  `;
  await schedulePaletteOnboardingSequence(contact.id, 'palette-di-settore', PALETTE);
  await runLeadPaletteSequence();
  const [row] = await sql<Array<{ pending: boolean }>>`
    SELECT sent_at IS NULL AS pending FROM email_sequences
    WHERE contact_id = ${contact.id} AND sequence_type = 'palette-onboarding' AND step = 1
  `;
  assert.equal(row.pending, true);
});

test('template: le tre email IT/EN con fasce colore, link condividi e disiscrizione', async () => {
  const base = {
    name: 'Mario <Rossi>',
    colors: ['#C63D2B', '#EFE5D2', '#2B2B2B'],
    primary: 0,
    preset: 'morbido' as const,
    sectorLabel: 'pizzerie',
    shareUrl: 'https://sito.caldes.test/risorse/palette-di-settore/condividi?v=1&k=pizzerie&c=C63D2B,EFE5D2,2B2B2B&s=morbido&p=0',
    unsubscribeUrl: 'https://api.caldes.test/api/palette/unsubscribe?c=x&t=y',
  };
  for (const locale of ['it', 'en'] as const) {
    const e1 = await renderPaletteEmail1({ ...base, locale });
    const e2 = await renderPaletteEmail2({
      ...base,
      locale,
      worksUrl: 'https://sito.caldes.test/lavori',
      caseStudy: { title: 'Pizzeria Da Test', description: 'Un sito per una pizzeria.', url: 'https://sito.caldes.test/lavori/pizzeria-test' },
    });
    const e2NoCase = await renderPaletteEmail2({ ...base, locale, worksUrl: 'https://sito.caldes.test/lavori', caseStudy: null });
    const e3 = await renderPaletteEmail3({ ...base, locale, bookingUrl: 'https://sito.caldes.test/prenota/consulenza' });

    for (const email of [e1, e2, e2NoCase, e3]) {
      assert.ok(email.subject.length > 5);
      assert.match(email.html, /#C63D2B/i);
      assert.ok(email.html.includes('api/palette/unsubscribe'), 'link di disiscrizione');
      assert.ok(!email.html.includes('Mario <Rossi>'), 'nome escapato');
      assert.ok(email.text.length > 50);
    }
    assert.ok(e1.html.includes('condividi?v=1'));
    assert.ok(e2.html.includes('lavori/pizzeria-test'));
    assert.ok(e3.html.includes('prenota/consulenza'));
  }
  assert.match((await renderPaletteEmail1({ ...base, locale: 'en' })).subject, /palette/i);
  assert.equal((await renderPaletteEmail1({ ...base, locale: 'it' })).subject, 'La tua palette, applicata');
});
