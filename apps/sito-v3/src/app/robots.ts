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
export default function robots(): MetadataRoute.Robots {
  const base = SITE.url.replace(/\/$/, '');
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/api/',
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
          '/en/privacy-request',
          '/en/faq',
          '/en/prenota',
          '/en/prenotazione',
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
