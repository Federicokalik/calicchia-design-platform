import type { MetadataRoute } from 'next';
import { SITE } from '@/data/site';

/**
 * robots.txt — coordinato con proxy.ts EN-availability route guard.
 *
 * Convenzione: i path `/en/...` listati in `disallow` corrispondono a route
 * che il middleware (`apps/sito-v3/src/proxy.ts`) restituisce 404 per locale
 * EN (paths in `EN_PATH_DISALLOWED_PREFIXES` o IT-only landing). Robots aiuta
 * i crawler a non sprecare budget su 404. Le route in `EN_PATH_PREFIXES_ENABLED`
 * (bilingual con content EN reale) NON sono qui — devono essere crawlable in
 * entrambi i locale.
 *
 * Update flow: quando un nuovo path viene aggiunto a EN_PATH_DISALLOWED_PREFIXES,
 * aggiungere anche qui. Quando un path passa da DISALLOWED → ENABLED (es. EN
 * content tradotto), rimuoverlo da qui.
 *
 * NOTA: i path usano slug IT canonical (es. `/en/zone`) perché next-intl fa
 * rewrite EN→IT internal: l'URL pubblico `/en/zone` matcha il filesystem
 * `[locale]/(site)/zone/`. Non normalizzare a slug EN tradotti se il path
 * non è in PATHNAMES.
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
          // Portal: content IT-only (Phase 2 traduzione full deferred); le route
          // EN rispondono 200 per evitare 404 al login da redirect Accept-Language
          // ma sono nascoste ai crawler.
          '/clienti/',
          '/en/clienti/',
          // EN paths esplicitamente IT-only — il middleware ritorna 404 ma il
          // disallow risparmia crawl budget.
          // Tieni sincronizzato con EN_PATH_DISALLOWED_PREFIXES in proxy.ts.
          '/en/zone',
          '/en/zone/',
          '/en/servizi-per-professioni',
          '/en/web-design-freelance-ciociaria',
          '/en/sito-web-per-pmi',
          '/en/quanto-costa-sito-web',
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
