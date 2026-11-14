/**
 * Sequenza email "palette-onboarding" per i lead del tool "Palette di
 * settore" (lead_source = 'palette-di-settore', vedi routes/contacts.ts).
 *
 * Stesso meccanismo della sequenza audit (jobs/lead-audit-sequence.ts):
 * tabella email_sequences, cron orario in cron/index.ts, step successivo
 * pianificato solo dopo un invio riuscito, stop se il lead prenota una call
 * o risponde. In più ogni email porta un link di disiscrizione firmato
 * (GET/POST /api/palette/unsubscribe) e gli header List-Unsubscribe.
 *
 * Step: 1 subito (la palette applicata), 2 dopo 48 h (un caso studio),
 * 3 dopo altre 72 h (invito alla call). La lingua viene da
 * brand_palette.locale: contacts non salva la lingua del visitatore.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { brandPaletteSchema, encodeSharedPalette, type BrandPalette } from '@calicchia/shared/palette';
import { sql } from '../db';
import { sendEmail } from '../lib/email';
import { logger } from '../lib/logger';
import { hasClientRespondedOrBooked } from './lead-audit-sequence';
import type { PaletteEmailBase } from '../templates/_palette';
import { renderPaletteEmail1 } from '../templates/palette-email-1';
import { renderPaletteEmail2, type PaletteCaseStudy } from '../templates/palette-email-2';
import { renderPaletteEmail3 } from '../templates/palette-email-3';

const log = logger.child({ scope: 'lead-palette-sequence' });

const SEQUENCE_TYPE = 'palette-onboarding';
const LAST_STEP = 3;

/** lead_source del modulo contatti quando il visitatore arriva dal tool palette. */
export const PALETTE_LEAD_SOURCE = 'palette-di-settore';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Letti a ogni chiamata (non all'import) come nel resto dei job recenti.
function siteUrl(): string {
  return (process.env.PUBLIC_SITE_URL || process.env.SITE_URL || 'https://calicchia.design').replace(/\/$/, '');
}

function apiUrl(): string {
  return (process.env.API_URL || 'http://localhost:3001').replace(/\/$/, '');
}

/** Stessa pagina di prenotazione della sequenza audit. */
function bookingUrl(): string {
  const slug = process.env.CONTACT_FORM_EVENT_TYPE || 'consulenza-gratuita-30min';
  return process.env.AUDIT_BOOKING_URL || `${siteUrl()}/prenota/${slug}`;
}

/** Prefisso di lingua del sito: IT senza prefisso, EN con /en. */
const localePrefix = (locale: 'it' | 'en'): string => (locale === 'en' ? '/en' : '');

export function isPaletteLeadSource(source: string | null | undefined): boolean {
  return source === PALETTE_LEAD_SOURCE;
}

// ─── Disiscrizione ───────────────────────────────

function unsubscribeSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET richiesto per firmare i link di disiscrizione');
  return secret;
}

function unsubscribeSignature(contactId: string): Buffer {
  // Prefisso di dominio: la stessa chiave firma anche altri token (JWT, file privati).
  return createHmac('sha256', unsubscribeSecret()).update(`palette-unsubscribe:${contactId.toLowerCase()}`).digest();
}

export function signPaletteUnsubscribe(contactId: string): string {
  return unsubscribeSignature(contactId).toString('base64url');
}

export function verifyPaletteUnsubscribe(contactId: string, token: string): boolean {
  if (!UUID_RE.test(contactId) || !token || token.length > 64) return false;
  let provided: Buffer;
  let expected: Buffer;
  try {
    provided = Buffer.from(token, 'base64url');
    expected = unsubscribeSignature(contactId);
  } catch {
    return false;
  }
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function paletteUnsubscribeUrl(contactId: string): string {
  const params = new URLSearchParams({ c: contactId, t: signPaletteUnsubscribe(contactId) });
  return `${apiUrl()}/api/palette/unsubscribe?${params}`;
}

/**
 * Chiude la sequenza per il contatto: segna come già inviati tutti gli step,
 * anche quelli non ancora pianificati, così scheduleNextStep (ON CONFLICT DO
 * NOTHING) non ne crea di nuovi. Restituisce false se il contatto non esiste
 * più (es. cancellato per GDPR).
 */
export async function unsubscribePaletteSequence(contactId: string): Promise<boolean> {
  const [contact] = await sql<{ id: string }[]>`SELECT id FROM contacts WHERE id = ${contactId}::uuid`;
  if (!contact) return false;
  await sql`
    INSERT INTO email_sequences (contact_id, sequence_type, step, scheduled_at, sent_at)
    SELECT ${contactId}::uuid, ${SEQUENCE_TYPE}, s, NOW(), NOW()
    FROM generate_series(1, ${LAST_STEP}::int) AS s
    ON CONFLICT (contact_id, sequence_type, step)
      DO UPDATE SET sent_at = COALESCE(email_sequences.sent_at, NOW())
  `;
  return true;
}

// ─── Pianificazione e invio ───────────────────────────────

/**
 * Pianifica lo step 1. Senza palette valida non parte: le email mostrano i
 * colori del lead e non avrebbero contenuto.
 */
export async function schedulePaletteOnboardingSequence(
  contactId: string,
  leadSource: string | null | undefined,
  brandPalette: BrandPalette | null | undefined,
): Promise<boolean> {
  if (!isPaletteLeadSource(leadSource) || !brandPalette) return false;
  await sql`
    INSERT INTO email_sequences (contact_id, sequence_type, step, scheduled_at)
    VALUES (${contactId}::uuid, ${SEQUENCE_TYPE}, 1, NOW())
    ON CONFLICT (contact_id, sequence_type, step) DO NOTHING
  `;
  return true;
}

interface PaletteSequenceRow {
  id: number;
  contact_id: string;
  step: number;
  name: string;
  email: string;
  brand_palette: unknown;
  cal_booking_uid: string | null;
  contact_created_at: string;
}

function sectorLabel(palette: BrandPalette): string | null {
  // Gli slug sono italiani (seo-professions.ts): in inglese meglio nessuna etichetta.
  if (!palette.sector || palette.locale !== 'it') return null;
  return palette.sector.replace(/-/g, ' ');
}

function shareUrl(palette: BrandPalette): string {
  const qs = encodeSharedPalette({
    v: palette.v,
    sector: palette.sector,
    preset: palette.preset,
    colors: palette.colors,
    primary: palette.primary,
  });
  return `${siteUrl()}${localePrefix(palette.locale)}/risorse/palette-di-settore/condividi?${qs}`;
}

function worksUrl(locale: 'it' | 'en', slug?: string): string {
  const base = `${siteUrl()}${localePrefix(locale)}/${locale === 'en' ? 'works' : 'lavori'}`;
  return slug ? `${base}/${encodeURIComponent(slug)}` : base;
}

/**
 * Caso studio: un progetto pubblicato del settore del lead se c'è (match
 * grezzo sulla radice dello slug in industries/tags), altrimenti il primo in
 * vetrina.
 */
async function pickCaseStudy(palette: BrandPalette): Promise<PaletteCaseStudy | null> {
  const firstWord = palette.sector?.split('-')[0] ?? '';
  const stem = firstWord.length > 5 ? firstWord.slice(0, 5) : firstWord;
  const pattern = stem.length >= 3 ? `%${stem}%` : null;
  const [project] = await sql<{ slug: string; title: string; description: string | null }[]>`
    SELECT
      p.slug,
      COALESCE(t_title.field_value, p.title) AS title,
      COALESCE(t_description.field_value, p.description) AS description
    FROM projects p
    LEFT JOIN projects_translations t_title
      ON t_title.project_id = p.id AND t_title.locale = ${palette.locale} AND t_title.field_name = 'title'
    LEFT JOIN projects_translations t_description
      ON t_description.project_id = p.id AND t_description.locale = ${palette.locale} AND t_description.field_name = 'description'
    WHERE p.is_published = true
    ORDER BY
      CASE
        WHEN ${pattern}::text IS NOT NULL
          AND (COALESCE(p.industries, '') ILIKE ${pattern} OR array_to_string(p.tags, ' ') ILIKE ${pattern})
        THEN 0 ELSE 1
      END,
      p.display_order ASC
    LIMIT 1
  `;
  if (!project) return null;
  const description = project.description?.trim() || null;
  return {
    title: project.title,
    description: description && description.length > 220 ? `${description.slice(0, 217)}…` : description,
    url: worksUrl(palette.locale, project.slug),
  };
}

async function renderStep(row: PaletteSequenceRow, palette: BrandPalette) {
  const base: PaletteEmailBase = {
    name: row.name,
    locale: palette.locale,
    colors: palette.colors,
    primary: palette.primary,
    preset: palette.preset,
    sectorLabel: sectorLabel(palette),
    shareUrl: shareUrl(palette),
    unsubscribeUrl: paletteUnsubscribeUrl(row.contact_id),
  };
  if (row.step === 1) return renderPaletteEmail1(base);
  if (row.step === 2) {
    return renderPaletteEmail2({ ...base, caseStudy: await pickCaseStudy(palette), worksUrl: worksUrl(palette.locale) });
  }
  return renderPaletteEmail3({ ...base, bookingUrl: bookingUrl() });
}

async function scheduleNextStep(row: PaletteSequenceRow): Promise<void> {
  if (row.step >= LAST_STEP) return;
  const delay = row.step === 1 ? sql`INTERVAL '48 hours'` : sql`INTERVAL '72 hours'`;
  await sql`
    INSERT INTO email_sequences (contact_id, sequence_type, step, scheduled_at)
    VALUES (${row.contact_id}::uuid, ${SEQUENCE_TYPE}, ${row.step + 1}, NOW() + ${delay})
    ON CONFLICT (contact_id, sequence_type, step) DO NOTHING
  `;
}

async function closePendingRow(rowId: number): Promise<void> {
  await sql`UPDATE email_sequences SET sent_at = NOW() WHERE id = ${rowId} AND sent_at IS NULL`;
}

async function processSequenceRow(row: PaletteSequenceRow): Promise<void> {
  const parsed = brandPaletteSchema.safeParse(row.brand_palette);
  if (!parsed.success) {
    log.warn({ contactId: row.contact_id, step: row.step }, 'brand_palette mancante o non valida: sequenza chiusa');
    await closePendingRow(row.id);
    return;
  }

  if (row.step > 1 && (await hasClientRespondedOrBooked(row))) {
    await closePendingRow(row.id);
    return;
  }

  const rendered = await renderStep(row, parsed.data);
  const unsubscribeUrl = paletteUnsubscribeUrl(row.contact_id);
  const result = await sendEmail({
    to: row.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });

  if (!result.success) {
    log.warn({ contactId: row.contact_id, step: row.step, error: result.error }, 'email not sent');
    return;
  }

  await closePendingRow(row.id);

  if (!(await hasClientRespondedOrBooked(row))) {
    await scheduleNextStep(row);
  }
}

export async function runLeadPaletteSequence(): Promise<void> {
  const pending = await sql<PaletteSequenceRow[]>`
    SELECT
      es.id,
      es.contact_id,
      es.step,
      c.name,
      c.email,
      c.brand_palette,
      c.cal_booking_uid,
      c.created_at AS contact_created_at
    FROM email_sequences es
    JOIN contacts c ON c.id = es.contact_id
    WHERE es.sequence_type = ${SEQUENCE_TYPE}
      AND es.scheduled_at <= NOW()
      AND es.sent_at IS NULL
    ORDER BY es.scheduled_at ASC
    LIMIT 25
  `;

  if (!pending.length) return;

  log.info(`${pending.length} email pending`);

  for (const row of pending) {
    try {
      await processSequenceRow(row);
    } catch (err) {
      log.error({ id: row.id, contactId: row.contact_id, step: row.step, err }, 'row error');
    }
  }
}
