/**
 * Portal route — gate accettazione T&C + DPA.
 * Auth: portalAuth (cookie portal_token, JWT con sv).
 *
 * GET  /api/portal/legal/status — ritorna {requires_acceptance, missing[], reason}
 * POST /api/portal/legal/accept — registra accettazione delle versioni correnti
 *                                 con IP + user-agent come prova art. 7 GDPR.
 *
 * Logica del gate (rispecchia il design in plans/tingly-finding-fox.md):
 *  - Si controllano le righe accettazione per (customer_id, slug, version)
 *    con `version = LEGAL_MAJOR_VERSIONS[slug]`.
 *  - Quote bypass: SE siamo ancora sulla BOOTSTRAP_VERSION (entrambi i doc
 *    a versione '1') E il customer ha almeno un preventivo accettato/firmato
 *    in `quotes` o `quotes_v2`, NIENTE gate (presunto consenso dato col
 *    preventivo, che richiama i T&C che includono il DPA come parte
 *    integrante — sez. 11 dei T&C, commit 37292d2).
 *  - Major version bump: chi non ha riga per la nuova versione viene
 *    riproposto il gate, anche se ha quotes accettati (l'accettazione
 *    della v1 non vale come consenso alla v2).
 */

import { Hono } from 'hono';
import { sql } from '../../db';
import { portalAuth, type PortalEnv } from './auth';
import { getClientIp } from '../../lib/client-ip';
import {
  BOOTSTRAP_VERSION,
  LEGAL_DOCUMENT_SLUGS,
  LEGAL_MAJOR_VERSIONS,
  isBootstrapPhase,
  type LegalDocumentSlug,
} from '../../lib/legal-versions';

export const legalRoutes = new Hono<PortalEnv>();

interface AcceptanceRow {
  document_slug: LegalDocumentSlug;
  document_version: string;
  accepted_at: Date;
}

const DOCUMENT_META: Record<LegalDocumentSlug, { title: string; url: string }> = {
  'termini-e-condizioni': { title: 'Termini e Condizioni', url: '/termini-e-condizioni' },
  'dpa-clienti': { title: 'Data Processing Agreement (DPA)', url: '/dpa-clienti' },
};

async function hasAcceptedQuoteOrSigned(customerId: string): Promise<boolean> {
  const [row] = (await sql`
    SELECT EXISTS (
      SELECT 1 FROM quotes
      WHERE customer_id = ${customerId}
        AND status IN ('accepted', 'converted')
    )
    OR EXISTS (
      SELECT 1 FROM quotes_v2
      WHERE customer_id = ${customerId}
        AND status = 'signed'
    ) AS has_any
  `) as Array<{ has_any: boolean }>;
  return Boolean(row?.has_any);
}

async function fetchAcceptances(customerId: string): Promise<Map<LegalDocumentSlug, string>> {
  const rows = (await sql`
    SELECT document_slug, document_version
    FROM customer_legal_acceptances
    WHERE customer_id = ${customerId}
  `) as Array<{ document_slug: LegalDocumentSlug; document_version: string }>;
  const map = new Map<LegalDocumentSlug, string>();
  for (const r of rows) {
    // Conserviamo la versione piu` recente accettata per documento (se l'admin
    // ha bumpato e poi rollback-ato, vincono comunque le righe esistenti).
    const prev = map.get(r.document_slug);
    if (!prev || r.document_version > prev) map.set(r.document_slug, r.document_version);
  }
  return map;
}

// GET /api/portal/legal/status
legalRoutes.get('/status', portalAuth, async (c) => {
  const customerId = c.get('customer_id') as string;

  // 1. Quali documenti mancano per la versione corrente?
  const acceptances = await fetchAcceptances(customerId);
  const missing: LegalDocumentSlug[] = [];
  for (const slug of LEGAL_DOCUMENT_SLUGS) {
    const accepted = acceptances.get(slug);
    if (accepted !== LEGAL_MAJOR_VERSIONS[slug]) missing.push(slug);
  }

  // 2. Determina la reason (utile per UI/log).
  let reason: 'never_accepted' | 'version_changed' | null = null;
  if (missing.length > 0) {
    reason = acceptances.size === 0 ? 'never_accepted' : 'version_changed';
  }

  // 3. Quote bypass — valido solo nel periodo bootstrap.
  let quoteBypass = false;
  if (missing.length > 0 && isBootstrapPhase()) {
    quoteBypass = await hasAcceptedQuoteOrSigned(customerId);
  }

  const requiresAcceptance = missing.length > 0 && !quoteBypass;

  return c.json({
    requires_acceptance: requiresAcceptance,
    missing,
    reason,
    quote_bypass: quoteBypass,
    documents: LEGAL_DOCUMENT_SLUGS.map((slug) => ({
      slug,
      version: LEGAL_MAJOR_VERSIONS[slug],
      title: DOCUMENT_META[slug].title,
      url: DOCUMENT_META[slug].url,
    })),
  });
});

// POST /api/portal/legal/accept
legalRoutes.post('/accept', portalAuth, async (c) => {
  const customerId = c.get('customer_id') as string;

  let body: { documents?: string[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body non valido' }, 400);
  }

  const documents = Array.isArray(body.documents) ? body.documents : [];
  const slugs = documents.filter(
    (d): d is LegalDocumentSlug => (LEGAL_DOCUMENT_SLUGS as readonly string[]).includes(d)
  );

  // Richiediamo l'accettazione di ENTRAMBI i documenti correnti — non si puo`
  // accettare solo T&C e non DPA (gate UI lo impedisce, qui lo enforciamo
  // anche server-side per non avere stati parziali).
  const requiredSet = new Set(LEGAL_DOCUMENT_SLUGS);
  for (const slug of slugs) requiredSet.delete(slug);
  if (requiredSet.size > 0) {
    return c.json({
      error: 'Accettazione incompleta',
      missing: Array.from(requiredSet),
    }, 400);
  }

  const ip = getClientIp(c);
  const userAgent = (c.req.header('user-agent') ?? '').slice(0, 512) || null;

  // Insert idempotente — ON CONFLICT no-op se la riga (customer, slug, version)
  // gia` esiste (es. doppio submit, retry rete).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inserted = await sql.begin(async (tx: any) => {
    const results: Array<{ slug: string; version: string }> = [];
    for (const slug of LEGAL_DOCUMENT_SLUGS) {
      const version = LEGAL_MAJOR_VERSIONS[slug];
      await tx`
        INSERT INTO customer_legal_acceptances
          (customer_id, document_slug, document_version, accepted_ip, accepted_user_agent)
        VALUES
          (${customerId}, ${slug}, ${version}, ${ip}, ${userAgent})
        ON CONFLICT (customer_id, document_slug, document_version) DO NOTHING
      `;
      results.push({ slug, version });
    }
    return results;
  });

  return c.json({
    accepted: true,
    accepted_at: new Date().toISOString(),
    documents: inserted,
    bootstrap_version: BOOTSTRAP_VERSION,
  });
});
