import type { MetadataRoute } from 'next';
import { SITE } from '@/data/site';

export default function robots(): MetadataRoute.Robots {
  const base = SITE.url.replace(/\/$/, '');
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/api/',
          '/clienti/',
          // EN paths esplicitamente IT-only (allineato con middleware EN-availability guard).
          // Anche se il middleware ritorna 404, robots aiuta i crawler a non sprecare budget.
          '/en/clienti/',
          // EN slug equivalents (servizi → services, contatti → contact, ecc.) sono
          // generati dinamicamente da next-intl pathnames. I path IT-only sotto sono
          // listati nel formato canonical IT (`/en/<it-slug>`) perché next-intl
          // redirect EN→IT canonical via internal rewrite. Lasciamo entrambi per safety.
          '/en/zone',
          '/en/zone/',
          '/en/servizi-per-professioni',
          '/en/web-design-freelance-ciociaria',
          '/en/sito-web-per-pmi',
          '/en/quanto-costa-sito-web',
          '/en/web-designer-vs-developer',
          '/en/european-accessibility-act-2025',
          '/en/core-web-vitals-audit',
          '/en/glossario-web-design',
          '/en/glossario-seo',
          '/en/glossario-e-commerce',
          '/en/migrazione-google-analytics-4',
          '/en/freelance-vs-agenzia-2026',
          '/en/wordpress-vs-headless',
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
