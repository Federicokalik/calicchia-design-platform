import type { MetadataRoute } from 'next';
import { SITE } from '@/data/site';

/**
 * robots.txt — only paths that actually serve content but should NOT be indexed
 * are listed here.
 *
 * Two kinds of entries:
 *   1. Always-private content (e.g. `/clienti/`, `/api/`) — IT + EN both
 *      respond 200 but must stay out of the index.
 *   2. EN routes serving IT-content fallback (e.g. `/en/privacy-policy`) —
 *      translation deferred Phase 2. The route 200s so the link doesn't break,
 *      but we hide it from crawlers until the EN copy ships. Remove the entry
 *      when its translated version is published.
 *
 * 404-only paths (IT-only pillars where `proxy.ts` returns 404 on EN) do NOT
 * belong here — listing them would imply existence and waste signal. Manage
 * those exclusively via `EN_PATH_DISALLOWED_PREFIXES` in `proxy.ts`.
 */
const DISALLOW = [
  '/api/',
  // Internal markdown mirror handler. The public URLs are `/<path>.md`
  // (allowed by `Allow: /`). The rewrite destination `/md/*` is an
  // implementation detail — keep crawlers out so they don't index a
  // parallel non-canonical URL space.
  '/md/',
  // Portal: serves 200 with IT content on EN (Phase 2 traduzione full
  // deferred). Routes respond to avoid 404 at login from
  // Accept-Language redirects, but stay hidden from crawlers.
  '/clienti/',
  '/en/clienti/',
  // EN routes that serve 200 with IT-content fallback (translation
  // deferred Phase 2 — legal docs, FAQ, booking flow). The IT versions
  // are intentionally indexable; only the /en/* variants are hidden
  // until properly translated. Remove an entry when its EN version
  // ships.
  '/en/privacy-policy',
  '/en/cookie-policy',
  '/en/termini-e-condizioni',
  '/en/dpa-clienti',
  '/en/privacy-request',
  '/en/faq',
  '/en/prenota',
  '/en/prenotazione',
];

/**
 * Crawler AI dichiarati esplicitamente benvenuti (strategia GEO: visibilità
 * su AI Overviews, ChatGPT, Claude, Perplexity). Stessi disallow di `*`:
 * l'allow esplicito è un segnale di consenso, non un perimetro più ampio.
 */
const AI_CRAWLERS = [
  // OpenAI: training, search index, fetch on-demand da ChatGPT
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  // Anthropic: training, fetch on-demand, search
  'ClaudeBot',
  'Claude-User',
  'Claude-SearchBot',
  // Perplexity: index + fetch on-demand
  'PerplexityBot',
  'Perplexity-User',
  // Google: opt-in uso AI (Gemini/AI Overviews grounding)
  'Google-Extended',
  // Apple Intelligence
  'Applebot-Extended',
  // Meta AI
  'Meta-ExternalAgent',
  // Common Crawl (dataset usato da molti LLM)
  'CCBot',
];

export default function robots(): MetadataRoute.Robots {
  const base = SITE.url.replace(/\/$/, '');
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: DISALLOW,
      },
      {
        userAgent: AI_CRAWLERS,
        allow: '/',
        disallow: DISALLOW,
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
