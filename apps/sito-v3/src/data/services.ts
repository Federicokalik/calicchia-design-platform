import type { Service } from './types';

/**
 * Servizi catalogo — divisi in MATRIX (4 core verticali con landing pagina×professione)
 * e STANDALONE (servizi specifici fuori matrice: Branding, Manutenzione, WordPress).
 *
 * `SERVICES` rimane esportato come unione per back-compat con i consumer esistenti
 * (es. ServicesGrid, sitemap, footer). Nuovi consumer dovrebbero usare
 * `MATRIX_SERVICES` o `STANDALONE_SERVICES` per il giusto routing/gerarchia.
 */

export const MATRIX_SERVICES: Service[] = [
  {
    slug: 'web-design',
    title: 'Web Design',
    lead:
      'Il tuo sito non è una brochure online.\nÈ il primo posto dove le persone decidono se fidarsi di te.\nLo costruisco partendo da te — niente template, niente scorciatoie.',
    deliverables: [
      'Design cucito sulla tua identità',
      'SEO tecnica già configurata',
      'Privacy/cookie GDPR a posto',
      'Un anno di assistenza inclusa',
    ],
    icon: 'globe',
  },
  {
    slug: 'e-commerce',
    title: 'E-Commerce',
    lead:
      'Aprire un e-commerce non vuol dire mettere prodotti su una pagina e sperare che qualcuno compri.\nCostruisco store che convertono, gestibili senza un team IT.',
    deliverables: [
      'Catalogo + carrello + checkout fluidi',
      'Integrazione pagamenti (Stripe / PayPal)',
      'Sincronizzazione magazzino',
      'Email transazionali curate',
    ],
    icon: 'shopping-cart',
  },
  {
    slug: 'sviluppo-web',
    title: 'Sviluppo Web',
    lead:
      'A volte un sito vetrina non basta.\nTi serve una piattaforma che fa cose: gestionali, prenotazioni, area clienti, integrazioni con i tuoi strumenti.',
    deliverables: [
      'Applicazioni custom su misura',
      'API e integrazioni terze parti',
      'Aree riservate e gestionali',
      'Performance da SaaS moderno',
    ],
    icon: 'code',
  },
  {
    slug: 'seo',
    title: 'SEO & Visibilità',
    lead:
      'Niente trucchi, niente promesse vuote.\nFaccio in modo che chi cerca quello che offri ti trovi e capisca al volo perché sei tu la scelta giusta.',
    deliverables: [
      'Audit tecnico completo',
      'Strategia keyword & contenuti',
      'Local SEO (Google Business)',
      'Monitoraggio mensile',
    ],
    icon: 'magnifying-glass',
  },
];

export const STANDALONE_SERVICES: Service[] = [
  // NB: branding rimosso 2026-05-08 — fuori positioning Web Designer & Developer.
  // Redirect /servizi/branding → /servizi configurato in next.config.ts.
  {
    slug: 'manutenzione-siti',
    title: 'Manutenzione siti',
    lead:
      'Il tuo sito è online — ma chi lo controlla?\nAggiornamenti, backup, monitoring, fix urgenti.\nUn canone mensile chiaro, senza sorprese.',
    deliverables: [
      'Backup e ripristino',
      'Update CMS, plugin, dipendenze',
      'Monitoring uptime e performance',
      'Fix urgenti entro 24h',
    ],
    icon: 'wrench',
  },
  {
    slug: 'assistenza-wordpress',
    title: 'Assistenza WordPress',
    lead:
      'WordPress è potente — e fragile.\nPulisco siti compromessi, sistemo plugin in conflitto, blocco gli attacchi prima che facciano danni.',
    deliverables: [
      'Security hardening (firewall, 2FA)',
      'Pulizia malware e ripristino',
      'Risoluzione conflitti plugin',
      'Performance tuning (cache, query)',
    ],
    icon: 'shield-check',
  },
  {
    slug: 'wordpress-migrazione',
    title: 'Migrazione & Hosting WordPress',
    lead:
      'Sito lento o host che ti tradisce?\nTrasloco WordPress senza downtime, configuro hosting performante, taglio i tempi di caricamento.',
    deliverables: [
      'Migrazione zero-downtime',
      'Setup hosting tuned per WP',
      'CDN e cache configurati',
      'Migrazione DNS e certificati SSL',
    ],
    icon: 'cloud-arrow-up',
  },
  {
    slug: 'performance-cwv',
    title: 'Performance & Core Web Vitals',
    lead:
      'Il sito è bello ma carica in 8 secondi.\nSu mobile fa sparire i clienti, su Google scivola in fondo.\nSistemo LCP, CLS, INP fino a passare il check.',
    deliverables: [
      'Audit Lighthouse + WebPageTest',
      'LCP < 2.5s, CLS < 0.1, INP < 200ms',
      'Image optimization + lazy loading',
      'Report before/after misurabile',
    ],
    icon: 'gauge',
  },
  {
    slug: 'accessibility-wcag',
    title: 'Accessibilità WCAG',
    lead:
      'Dal 28 giugno 2025 l\'European Accessibility Act è in vigore.\nSe vendi online, il sito deve essere accessibile o paghi multe.\nAudit WCAG 2.1 AA + remediation.',
    deliverables: [
      'Audit screen reader (NVDA + VoiceOver)',
      'Contrast + keyboard navigation check',
      'ARIA fixes + semantic HTML',
      'Accessibility statement pubblicabile',
    ],
    icon: 'wheelchair',
  },
  {
    slug: 'analytics-setup',
    title: 'Analytics & Tag Manager',
    lead:
      'Hai un sito ma non sai chi compra, chi rimbalza, da dove vengono.\nSetup GA4 + GTM corretto, eventi conversione tracciati, dashboard letta in 5 minuti.',
    deliverables: [
      'GA4 property + GTM container',
      'Eventi e-commerce / lead form',
      'Consent Mode v2 (GDPR-compliant)',
      'Dashboard Looker Studio personalizzata',
    ],
    icon: 'chart-line-up',
  },
];

/** @deprecated Usa MATRIX_SERVICES o STANDALONE_SERVICES. Mantenuto per back-compat. */
export const SERVICES: Service[] = [...MATRIX_SERVICES, ...STANDALONE_SERVICES];

// ─── EN locale helpers (Round 5b, 2026-05-08) ────────────────────────
import { MATRIX_SERVICES_EN, STANDALONE_SERVICES_EN, SERVICES_EN } from './services-en';
import type { Locale } from '@/lib/i18n';

/** Locale-aware getter for matrix services (web-design, e-commerce, sviluppo-web, seo). */
export function getMatrixServices(locale: Locale = 'it'): Service[] {
  return locale === 'en' ? MATRIX_SERVICES_EN : MATRIX_SERVICES;
}

/** Locale-aware getter for standalone services (manutenzione, wordpress, performance, ecc.). */
export function getStandaloneServices(locale: Locale = 'it'): Service[] {
  return locale === 'en' ? STANDALONE_SERVICES_EN : STANDALONE_SERVICES;
}

/** Locale-aware getter for the union (back-compat with ServicesGrid, footer, sitemap). */
export function getServices(locale: Locale = 'it'): Service[] {
  return locale === 'en' ? SERVICES_EN : SERVICES;
}
