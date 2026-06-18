/**
 * GEO Audit — deterministic site analysis.
 *
 * Fetches the RAW HTML of a target URL (no JS execution: this is exactly what an
 * AI retrieval bot sees) plus /robots.txt and /sitemap.xml, then scores the page
 * against the evidence-based factors from the GEO white paper
 * (/risorse/dalla-seo-alla-geo). The scoring is deliberately HONEST: it does not
 * reward llms.txt / special schema / markdown (the paper rates them low/unproven)
 * and weights the factors with measured uplift (server-side rendering, retrieval
 * bot access, answer-first semantic structure, citability, freshness).
 *
 * No LLM here — the qualitative action plan is generated separately at /unlock.
 */

import { assertSafeHttpUrl } from './workflow/nodes';
import { logger } from './logger';

const log = logger.child({ scope: 'geo-audit' });

const FETCH_TIMEOUT_MS = 12_000;
const MAX_HTML_BYTES = 2_000_000; // 2 MB cap to bound parsing cost
const UA = 'CalicchiaGeoAudit/1.0 (+https://calicchia.design/audit-geo)';

// Anchors into the white paper sections, used by the frontend to deep-link each
// failed check to the relevant passage ("come si risolve →").
export type WhitepaperAnchor = 's1' | 's2' | 's3' | 's4' | 's5' | 's6';

export interface GeoCheck {
  id: string;
  label: string;
  /** true = pass, false = fail, null = informational (not scored). */
  passed: boolean | null;
  weight: number;
  detail: string;
  anchor: WhitepaperAnchor;
}

export interface GeoAuditResult {
  url: string;
  finalUrl: string;
  score: number; // 0–100
  checks: GeoCheck[];
  /** Compact extract fed to the LLM at unlock; never returned to the public teaser. */
  context: {
    title: string;
    h1: string[];
    excerpt: string;
  };
}

// ── fetch helpers ────────────────────────────────────────────────────────────

async function safeFetchText(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; text: string; finalUrl: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: '*/*', ...(init?.headers || {}) },
      redirect: 'follow',
    });
    const buf = await res.arrayBuffer();
    const sliced = buf.byteLength > MAX_HTML_BYTES ? buf.slice(0, MAX_HTML_BYTES) : buf;
    const text = new TextDecoder('utf-8', { fatal: false }).decode(sliced);
    return { ok: res.ok, status: res.status, text, finalUrl: res.url || url };
  } finally {
    clearTimeout(timer);
  }
}

// ── HTML text extraction (regex-based; cheerio/jsdom unavailable) ─────────────

function stripToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchAll(re: RegExp, s: string): RegExpMatchArray[] {
  return [...s.matchAll(re)];
}

function metaContent(html: string, nameOrProp: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=["']${nameOrProp}["'][^>]*>`,
    'i',
  );
  const tag = html.match(re)?.[0];
  if (!tag) return null;
  return tag.match(/content=["']([^"']*)["']/i)?.[1]?.trim() ?? null;
}

// ── robots.txt parsing ───────────────────────────────────────────────────────

const AI_RETRIEVAL_BOTS = [
  'OAI-SearchBot',
  'ChatGPT-User',
  'PerplexityBot',
  'Perplexity-User',
  'Claude-SearchBot',
  'Claude-User',
  'Google-Extended',
];

/**
 * Returns true if the given user-agent is blocked from the whole site (Disallow: /)
 * either by an explicit group or by the wildcard `*` group.
 */
function isBotBlocked(robots: string, bot: string): boolean {
  const lines = robots.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim());
  let appliesToAll = false;
  let appliesToBot = false;
  let blockedAll = false;
  let blockedBot = false;
  let current: 'none' | 'all' | 'bot' | 'other' = 'none';

  for (const line of lines) {
    const ua = line.match(/^user-agent:\s*(.+)$/i);
    if (ua) {
      const agent = ua[1].trim().toLowerCase();
      if (agent === '*') { current = 'all'; appliesToAll = true; }
      else if (agent === bot.toLowerCase()) { current = 'bot'; appliesToBot = true; }
      else current = 'other';
      continue;
    }
    const dis = line.match(/^disallow:\s*(.*)$/i);
    if (dis) {
      const path = dis[1].trim();
      const blocksRoot = path === '/' ;
      if (current === 'all' && blocksRoot) blockedAll = true;
      if (current === 'bot' && blocksRoot) blockedBot = true;
    }
  }
  // A bot-specific group overrides the wildcard group.
  if (appliesToBot) return blockedBot;
  if (appliesToAll) return blockedAll;
  return false;
}

// ── the audit ─────────────────────────────────────────────────────────────────

function scoreFrom(checks: GeoCheck[]): number {
  const scored = checks.filter((c) => c.weight > 0 && c.passed !== null);
  const total = scored.reduce((s, c) => s + c.weight, 0);
  if (total === 0) return 0;
  const earned = scored.reduce((s, c) => s + (c.passed ? c.weight : 0), 0);
  return Math.round((earned / total) * 100);
}

export async function runDeterministicAudit(rawUrl: string): Promise<GeoAuditResult> {
  // Normalize: allow users to paste "example.com" without scheme.
  const normalized = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  const safe = await assertSafeHttpUrl(normalized); // throws on SSRF / invalid

  const page = await safeFetchText(safe.toString());
  if (!page.ok) {
    throw new Error(`Il sito ha risposto con stato ${page.status}`);
  }
  // Re-validate the post-redirect URL: redirect:'follow' would otherwise let a
  // public host bounce the request to an internal target (redirect-based SSRF).
  await assertSafeHttpUrl(page.finalUrl);
  const html = page.text;
  const origin = new URL(page.finalUrl).origin;

  // Sub-fetches (best-effort; failures degrade gracefully).
  const [robotsRes, sitemapRes] = await Promise.allSettled([
    safeFetchText(`${origin}/robots.txt`),
    safeFetchText(`${origin}/sitemap.xml`),
  ]);
  const robots = robotsRes.status === 'fulfilled' && robotsRes.value.ok ? robotsRes.value.text : '';
  const sitemapOk = sitemapRes.status === 'fulfilled' && sitemapRes.value.ok;
  const sitemapText = sitemapRes.status === 'fulfilled' ? sitemapRes.value.text : '';

  const text = stripToText(html);
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '';
  const h1s = matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, html).map((m) => stripToText(m[1])).filter(Boolean);
  const h2count = matchAll(/<h2[\b>]/gi, html).length;

  const checks: GeoCheck[] = [];

  // 1 — Retrieval access (robots.txt + sitemap)
  {
    const blocked = AI_RETRIEVAL_BOTS.filter((b) => robots && isBotBlocked(robots, b));
    const hasSitemap = sitemapOk || /sitemap:/i.test(robots);
    const passed = blocked.length === 0 && hasSitemap;
    const parts: string[] = [];
    parts.push(
      blocked.length === 0
        ? 'I bot di retrieval AI (ChatGPT, Perplexity, Claude) non sono bloccati da robots.txt.'
        : `robots.txt blocca questi bot di retrieval: ${blocked.join(', ')}.`,
    );
    parts.push(hasSitemap ? 'Sitemap presente.' : 'Nessuna sitemap trovata (robots.txt né /sitemap.xml).');
    checks.push({ id: 'retrieval_access', label: 'Accesso ai motori AI', passed, weight: 25, detail: parts.join(' '), anchor: 's2' });
  }

  // 2 — Server-side rendering (meaningful text in raw HTML)
  {
    const len = text.length;
    const passed = len >= 600;
    checks.push({
      id: 'ssr_content',
      label: 'Rendering server-side',
      passed,
      weight: 20,
      detail: passed
        ? `L'HTML grezzo contiene ~${len} caratteri di testo: i bot AI (che spesso non eseguono JavaScript) vedono il contenuto.`
        : `L'HTML grezzo contiene solo ~${len} caratteri: il contenuto è probabilmente reso via JavaScript e invisibile a molti bot AI.`,
      anchor: 's2',
    });
  }

  // 3 — Semantic structure (single H1 + H2 hierarchy)
  {
    const passed = h1s.length === 1 && h2count >= 1;
    let detail: string;
    if (h1s.length === 0) detail = 'Manca un <h1>: la pagina non dichiara un argomento principale chiaro.';
    else if (h1s.length > 1) detail = `Ci sono ${h1s.length} <h1>: meglio un solo titolo principale + <h2> per le sezioni.`;
    else if (h2count === 0) detail = 'Un solo <h1> ma nessun <h2>: manca una gerarchia di sezioni per il chunking.';
    else detail = `Struttura chiara: un <h1> e ${h2count} <h2>.`;
    checks.push({ id: 'semantic_structure', label: 'Struttura semantica', passed, weight: 15, detail, anchor: 's2' });
  }

  // 4 — Answer-first (substantial sentence early in the body)
  {
    const head = text.slice(0, 400);
    const firstSentence = head.split(/(?<=[.!?])\s/)[0] ?? '';
    const passed = firstSentence.length >= 80;
    checks.push({
      id: 'answer_first',
      label: 'Struttura answer-first',
      passed,
      weight: 10,
      detail: passed
        ? 'Il contenuto entra subito nel merito: una risposta sostanziosa appare nelle prime righe.'
        : 'Le prime righe non contengono una risposta sostanziosa: i motori premiano i contenuti che rispondono subito.',
      anchor: 's2',
    });
  }

  // 5 — Citability (statistics + outbound citations + quotations)
  {
    const hasStats = /\b\d{1,3}([.,]\d+)?\s?%/.test(text) || /\b\d{4}\b/.test(text);
    const externalLinks = matchAll(/<a[^>]+href=["']https?:\/\/([^"'/]+)/gi, html)
      .map((m) => m[1].toLowerCase())
      .filter((host) => !host.endsWith(new URL(origin).hostname));
    const hasCitations = new Set(externalLinks).size >= 1;
    const hasQuotes = /[«»“”]/.test(text) || /<blockquote/i.test(html);
    const signals = [hasStats, hasCitations, hasQuotes].filter(Boolean).length;
    const passed = signals >= 2;
    const present: string[] = [];
    if (hasStats) present.push('statistiche/dati');
    if (hasCitations) present.push('citazioni a fonti esterne');
    if (hasQuotes) present.push('virgolettati');
    checks.push({
      id: 'citability',
      label: 'Segnali di citabilità',
      passed,
      weight: 20,
      detail: present.length
        ? `Segnali presenti: ${present.join(', ')}. ${passed ? '' : 'Aggiungere statistiche e fonti esterne aumenta le citazioni AI (uplift misurato +31/+28%).'}`.trim()
        : 'Nessuna statistica, fonte esterna o virgolettato: sono le leve con maggiore uplift di citabilità (+31/+41/+28%).',
      anchor: 's3',
    });
  }

  // 6 — Freshness (modified date within ~18 months)
  {
    const modified = metaContent(html, 'article:modified_time') || metaContent(html, 'article:published_time');
    let lastmod = '';
    const lm = sitemapText.match(/<lastmod>([^<]+)<\/lastmod>/i);
    if (lm) lastmod = lm[1];
    const dateStr = modified || lastmod;
    let passed = false;
    let detail = 'Nessuna data di aggiornamento rilevabile (meta article:modified_time o sitemap lastmod).';
    if (dateStr) {
      const t = Date.parse(dateStr);
      if (!Number.isNaN(t)) {
        const months = (Date.now() - t) / (1000 * 60 * 60 * 24 * 30);
        passed = months <= 18;
        detail = passed
          ? `Contenuto aggiornato di recente (${dateStr.slice(0, 10)}). La freschezza pesa molto su Perplexity.`
          : `Ultimo aggiornamento rilevato il ${dateStr.slice(0, 10)}: oltre 18 mesi. La freschezza incide sulle citazioni.`;
      }
    }
    checks.push({ id: 'freshness', label: 'Freschezza del contenuto', passed, weight: 10, detail, anchor: 's3' });
  }

  // 7 — Baseline meta hygiene (low weight: marginal per §7)
  {
    const hasTitle = title.length >= 10;
    const hasDesc = (metaContent(html, 'description') || '').length >= 30;
    const hasCanonical = /<link[^>]+rel=["']canonical["']/i.test(html);
    const ok = [hasTitle, hasDesc, hasCanonical].filter(Boolean).length;
    const passed = ok >= 2;
    const missing: string[] = [];
    if (!hasTitle) missing.push('title');
    if (!hasDesc) missing.push('meta description');
    if (!hasCanonical) missing.push('canonical');
    checks.push({
      id: 'meta_hygiene',
      label: 'Igiene meta di base',
      passed,
      weight: 5,
      detail: missing.length ? `Manca/incompleto: ${missing.join(', ')}.` : 'Title, meta description e canonical presenti.',
      anchor: 's5',
    });
  }

  // Informational (not scored): off-page brand/authority cannot be checked here.
  checks.push({
    id: 'brand_authority',
    label: 'Brand mention & autorità',
    passed: null,
    weight: 0,
    detail: 'Le menzioni del brand (G2, Trustpilot, Wikipedia, Reddit, YouTube) sono off-page e non verificabili automaticamente, ma sono il predittore più forte di visibilità AI.',
    anchor: 's3',
  });

  const score = scoreFrom(checks);

  log.info({ url: safe.toString(), score }, 'geo audit completed');

  return {
    url: normalized,
    finalUrl: page.finalUrl,
    score,
    checks,
    context: {
      title,
      h1: h1s,
      excerpt: text.slice(0, 3000),
    },
  };
}
