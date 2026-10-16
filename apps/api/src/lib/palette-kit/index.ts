/**
 * Brand kit in PDF del tool "Palette di settore" (fase 2).
 *
 * Flusso:
 *  1. requestBrandKit: il visitatore lascia l'email e accetta l'iscrizione
 *     alla newsletter (testo versionato in @calicchia/shared/palette). Il
 *     contatto entra in mkt_contacts come 'unconfirmed', la richiesta in
 *     palette_kit_requests con un token suo; parte l'email di conferma.
 *  2. confirmBrandKit: il clic sul link (POST dalla pagina di conferma, così
 *     gli antivirus che aprono i link non confermano da soli) conferma il
 *     consenso, iscrive alla lista della newsletter e mette in coda l'invio.
 *  3. runPaletteKitSender: genera il PDF e lo allega all'email di benvenuto
 *     (transport marketing, List-Unsubscribe). Riprova con attesa crescente,
 *     al massimo MAX_ATTEMPTS volte. Il PDF non viene salvato.
 *  4. cleanupPaletteKit: richieste mai confermate e contatti nati solo da
 *     quelle cancellati dopo 7 giorni; palette dei disiscritti dopo 30.
 */

import {
  brandPaletteSchema,
  encodeSharedPalette,
  KIT_CONSENT_VERSION,
  normalizeHex,
  type BrandPalette,
  type KitRequest,
} from '@calicchia/shared/palette';
import { jsonb, sql } from '../../db';
import { sendEmail } from '../email';
import { logger } from '../logger';
import { fireTrigger } from '../marketing/automation';
import { renderPaletteKitConfirmEmail, renderPaletteKitEmail } from '../../templates/palette-kit-email';
import { renderBrandKitPdf, type BrandKitPdfInput } from './pdf';

const log = logger.child({ scope: 'palette-kit' });

/** Lista della newsletter dedicata: si crea da sola al primo uso (cercata per nome). */
export const PALETTE_KIT_LIST_NAME = 'Newsletter · Palette di settore';
export const PALETTE_KIT_TAG = 'palette-kit';
const CONSENT_SOURCE = 'palette-kit';
const MAX_ATTEMPTS = 5;
const BATCH = 5;
/** Nessuna nuova email di conferma allo stesso indirizzo prima di questo intervallo. */
const CONFIRM_COOLDOWN_MINUTES = 10;

let renderPdf: (input: BrandKitPdfInput) => Promise<Buffer> = renderBrandKitPdf;
let mailer: typeof sendEmail = sendEmail;
let senderRunning = false;
let cachedListId: string | null = null;

/** Solo per i test: PDF e invio finti (niente Chromium né SMTP) e cache azzerate. */
export const paletteKitTesting = {
  setPdfRenderer(fn: (input: BrandKitPdfInput) => Promise<Buffer>): void {
    renderPdf = fn;
  },
  setMailer(fn: typeof sendEmail): void {
    mailer = fn;
  },
  reset(): void {
    renderPdf = renderBrandKitPdf;
    mailer = sendEmail;
    cachedListId = null;
    senderRunning = false;
  },
};

function apiUrl(): string {
  return (process.env.API_URL || 'http://localhost:3001').replace(/\/$/, '');
}

function siteUrl(): string {
  return (process.env.PUBLIC_SITE_URL || process.env.SITE_URL || 'https://calicchia.design').replace(/\/$/, '');
}

function shareUrl(palette: BrandPalette): string {
  const qs = encodeSharedPalette({
    v: palette.v,
    sector: palette.sector,
    preset: palette.preset,
    colors: palette.colors,
    primary: palette.primary,
  });
  return `${siteUrl()}${palette.locale === 'en' ? '/en' : ''}/risorse/palette-di-settore/condividi?${qs}`;
}

export function paletteKitConfirmUrl(token: string): string {
  return `${apiUrl()}/api/palette/kit/confirm?t=${encodeURIComponent(token)}`;
}

export async function ensureKitList(): Promise<string> {
  if (cachedListId) return cachedListId;
  const [found] = await sql<Array<{ id: string }>>`
    SELECT id FROM mkt_lists WHERE name = ${PALETTE_KIT_LIST_NAME} ORDER BY created_at LIMIT 1`;
  if (found) {
    cachedListId = found.id;
    return found.id;
  }
  const [created] = await sql<Array<{ id: string }>>`
    INSERT INTO mkt_lists (name, description, kind, default_legal_basis)
    VALUES (${PALETTE_KIT_LIST_NAME}, ${'Iscritti dal tool Palette di settore (brand kit in PDF), double opt-in.'}, 'static', 'consent')
    RETURNING id`;
  cachedListId = created.id;
  return created.id;
}

export type KitRequestOutcome = 'queued' | 'cooldown' | 'suppressed';

/**
 * Registra la richiesta e manda l'email di conferma. La rotta risponde sempre
 * allo stesso modo: l'esito serve solo a log e test (niente enumerazione
 * degli indirizzi).
 */
export async function requestBrandKit(
  req: KitRequest,
  meta: { ip: string | null; userAgent: string | null },
): Promise<KitRequestOutcome> {
  const email = req.email;
  const [suppressed] = await sql`SELECT 1 FROM mkt_suppression WHERE email_norm = ${email} LIMIT 1`;
  if (suppressed) return 'suppressed';

  const name = req.name?.trim() || null;
  const [contact] = await sql<Array<{ id: string; email_consent: string }>>`
    INSERT INTO mkt_contacts
      (email, first_name, email_consent, email_legal_basis, consent_source,
       consent_ip, consent_user_agent, consent_collected_at, tags)
    VALUES
      (${email}, ${name}, 'unconfirmed', 'consent', ${CONSENT_SOURCE},
       ${meta.ip}, ${meta.userAgent}, now(), ${[PALETTE_KIT_TAG]})
    ON CONFLICT (email_norm) WHERE email IS NOT NULL DO UPDATE SET
      first_name = COALESCE(mkt_contacts.first_name, EXCLUDED.first_name),
      tags = CASE WHEN ${PALETTE_KIT_TAG} = ANY(mkt_contacts.tags) THEN mkt_contacts.tags
                  ELSE array_append(mkt_contacts.tags, ${PALETTE_KIT_TAG}) END,
      updated_at = now()
    RETURNING id, email_consent`;

  // Chi si è disiscritto (o ha un indirizzo che rimbalza) non riceve nulla da qui.
  if (['unsubscribed', 'bounced', 'complained'].includes(contact.email_consent)) return 'suppressed';

  const [recent] = await sql`
    SELECT 1 FROM palette_kit_requests
    WHERE contact_id = ${contact.id} AND confirmed_at IS NULL
      AND created_at > now() - make_interval(mins => ${CONFIRM_COOLDOWN_MINUTES})
    LIMIT 1`;
  if (recent) return 'cooldown';

  const palette: BrandPalette = {
    ...req.palette,
    colors: req.palette.colors.map((c) => normalizeHex(c) ?? c),
    locale: req.locale,
  };
  const [row] = await sql<Array<{ confirm_token: string }>>`
    INSERT INTO palette_kit_requests
      (contact_id, palette, locale, sector_label, consent_version, request_ip, request_user_agent)
    VALUES
      (${contact.id}, ${jsonb(palette)}, ${req.locale}, ${req.sector_label ?? null}, ${KIT_CONSENT_VERSION},
       ${meta.ip}, ${meta.userAgent})
    RETURNING confirm_token`;

  const mail = await renderPaletteKitConfirmEmail({ locale: req.locale, confirmUrl: paletteKitConfirmUrl(row.confirm_token) });
  // 'critical' come le altre conferme di iscrizione: la prima email deve arrivare.
  const res = await mailer({ to: email, subject: mail.subject, html: mail.html, text: mail.text, transport: 'critical' });
  if (!res.success) log.warn({ err: res.error }, 'email di conferma del brand kit non inviata');
  return 'queued';
}

export type KitConfirmOutcome = 'confirmed' | 'already' | 'invalid';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Stato del token senza modificarlo (pagina di conferma in GET). */
export async function peekBrandKitToken(token: string): Promise<'pending' | 'already' | 'invalid'> {
  if (!UUID_RE.test(token)) return 'invalid';
  const [row] = await sql<Array<{ confirmed_at: Date | null }>>`
    SELECT confirmed_at FROM palette_kit_requests WHERE confirm_token = ${token}::uuid`;
  if (!row) return 'invalid';
  return row.confirmed_at ? 'already' : 'pending';
}

export async function confirmBrandKit(token: string, ip: string | null): Promise<KitConfirmOutcome> {
  if (!UUID_RE.test(token)) return 'invalid';
  const [req] = await sql<Array<{ id: string; contact_id: string }>>`
    UPDATE palette_kit_requests
    SET confirmed_at = now(), confirm_ip = ${ip}, next_attempt_at = now()
    WHERE confirm_token = ${token}::uuid AND confirmed_at IS NULL
    RETURNING id, contact_id`;
  if (!req) {
    const state = await peekBrandKitToken(token);
    return state === 'already' ? 'already' : 'invalid';
  }

  const [confirmed] = await sql<Array<{ id: string }>>`
    UPDATE mkt_contacts
    SET email_consent = 'confirmed', consent_collected_at = now(), updated_at = now()
    WHERE id = ${req.contact_id} AND email_consent = 'unconfirmed'
    RETURNING id`;
  const listId = await ensureKitList();
  await sql`INSERT INTO mkt_list_members (list_id, contact_id, source)
            VALUES (${listId}, ${req.contact_id}, 'form') ON CONFLICT DO NOTHING`;

  if (confirmed) void fireTrigger('contact_created', req.contact_id);
  void fireTrigger('list_joined', req.contact_id, { listId });
  // Invio subito; se fallisce ci riprova il cron.
  void runPaletteKitSender().catch((err) => log.warn({ err }, 'invio del brand kit dopo la conferma fallito'));
  return 'confirmed';
}

interface PendingRow {
  id: string;
  palette: unknown;
  sector_label: string | null;
  attempts: number;
  email: string;
  first_name: string | null;
  email_consent: string;
  unsubscribe_token: string;
  suppressed: boolean;
}

function slugForFile(palette: BrandPalette): string {
  return palette.sector ? `brand-kit-${palette.sector}.pdf` : 'brand-kit.pdf';
}

async function sendOne(row: PendingRow): Promise<void> {
  if (row.email_consent !== 'confirmed' || row.suppressed) {
    await sql`UPDATE palette_kit_requests SET attempts = ${MAX_ATTEMPTS}, last_error = 'contatto non iscritto'
              WHERE id = ${row.id}`;
    return;
  }
  const parsed = brandPaletteSchema.safeParse(row.palette);
  if (!parsed.success) {
    await sql`UPDATE palette_kit_requests SET attempts = ${MAX_ATTEMPTS}, last_error = 'palette non valida'
              WHERE id = ${row.id}`;
    return;
  }
  const palette = parsed.data;
  try {
    const pdf = await renderPdf({
      palette,
      locale: palette.locale,
      sectorLabel: row.sector_label,
      shareUrl: shareUrl(palette),
      date: new Date(),
    });
    const unsubscribeUrl = `${apiUrl()}/api/mkt-track/u/${row.unsubscribe_token}`;
    const mail = await renderPaletteKitEmail({
      locale: palette.locale,
      name: row.first_name,
      colors: palette.colors,
      shareUrl: shareUrl(palette),
      unsubscribeUrl,
    });
    const res = await mailer({
      to: row.email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      transport: 'marketing',
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      attachments: [{ filename: slugForFile(palette), content: pdf, contentType: 'application/pdf' }],
    });
    if (!res.success) throw new Error(res.error || 'invio non riuscito');
    await sql`UPDATE palette_kit_requests SET sent_at = now(), last_error = NULL WHERE id = ${row.id}`;
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 500) : 'errore';
    log.warn({ err, requestId: row.id }, 'brand kit non inviato');
    await sql`UPDATE palette_kit_requests SET last_error = ${message} WHERE id = ${row.id}`;
  }
}

/** Cron (ogni minuto) e subito dopo una conferma. Non si sovrappone a sé stesso. */
export async function runPaletteKitSender(): Promise<void> {
  if (senderRunning) return;
  senderRunning = true;
  try {
    // Prenota le righe prima di lavorarle: attempts+1 e prossimo tentativo
    // spostato in avanti (5, 20, 45, 80 minuti), così un secondo giro non le
    // riprende mentre questo è ancora in corso.
    const rows = await sql<PendingRow[]>`
      WITH picked AS (
        SELECT r.id FROM palette_kit_requests r
        WHERE r.confirmed_at IS NOT NULL AND r.sent_at IS NULL AND r.attempts < ${MAX_ATTEMPTS}
          AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= now())
        ORDER BY r.confirmed_at
        LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE palette_kit_requests r
      SET attempts = r.attempts + 1,
          next_attempt_at = now() + make_interval(mins => 5 * (r.attempts + 1) * (r.attempts + 1))
      FROM picked, mkt_contacts c
      WHERE r.id = picked.id AND c.id = r.contact_id
      RETURNING r.id, r.palette, r.sector_label, r.attempts, c.email, c.first_name, c.email_consent,
                c.unsubscribe_token,
                EXISTS (SELECT 1 FROM mkt_suppression s WHERE s.email_norm = c.email_norm) AS suppressed`;
    for (const row of rows) await sendOne(row);
  } finally {
    senderRunning = false;
  }
}

/** Cron orario: minimizzazione dei dati. */
export async function cleanupPaletteKit(): Promise<void> {
  // Contatti nati solo da una richiesta mai confermata (nessuna lista, nessun
  // altro canale): via insieme alle richieste (cascata).
  await sql`
    DELETE FROM mkt_contacts c
    WHERE c.consent_source = ${CONSENT_SOURCE} AND c.email_consent = 'unconfirmed'
      AND c.created_at < now() - interval '7 days'
      AND c.lead_id IS NULL AND c.customer_id IS NULL AND c.subscriber_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM mkt_list_members m WHERE m.contact_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM palette_kit_requests r WHERE r.contact_id = c.id AND r.confirmed_at IS NOT NULL)`;
  await sql`DELETE FROM palette_kit_requests WHERE confirmed_at IS NULL AND created_at < now() - interval '7 days'`;
  await sql`
    DELETE FROM palette_kit_requests r USING mkt_contacts c
    WHERE r.contact_id = c.id AND c.email_consent IN ('unsubscribed', 'bounced', 'complained')
      AND c.updated_at < now() - interval '30 days'`;
}
