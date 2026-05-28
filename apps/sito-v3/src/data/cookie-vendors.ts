/**
 * Single source of truth for vendor disclosure shown both in the cookie
 * consent banner (preferences view) and in the public cookie policy page.
 *
 * Per GDPR art. 13 + Garante Italia 2021 §10.f, each non-strictly-technical
 * vendor must be disclosed with: name, cookies/identifiers, purpose, retention,
 * controller/processor, link to the vendor's own privacy policy.
 *
 * Pure data file — no React, importable from server and client components.
 */

export type ConsentCategory = 'necessary' | 'analytics' | 'marketing';

export interface VendorDisclosure {
  id: string;
  name: string;
  category: ConsentCategory;
  /** Cookie/storage identifiers. Empty array + `serverProcessing: true` for server-only vendors. */
  cookies: readonly string[];
  purpose: { it: string; en: string };
  duration: { it: string; en: string };
  /** Legal entity acting as controller or processor. */
  processor: string;
  /** URL to the vendor's own privacy policy (external) or an in-site anchor. */
  policyUrl: string;
  /** True when the vendor processes data only server-side (no browser cookies). */
  serverProcessing?: boolean;
}

export const VENDOR_DISCLOSURE: readonly VendorDisclosure[] = [
  // ───── Necessary (art. 6(1)(f) GDPR — legitimate interest / strict technical need) ─────
  {
    id: 'cookie-consent',
    name: 'Consent storage',
    category: 'necessary',
    cookies: ['cookie_consent'],
    purpose: {
      it: 'Memorizza le preferenze cookie espresse, evita di mostrare nuovamente il banner entro la finestra di silenzio.',
      en: 'Stores the cookie preferences you set; suppresses the banner within the silence window.',
    },
    duration: { it: '6 mesi', en: '6 months' },
    processor: 'calicchia.design (self-hosted)',
    policyUrl: '/cookie-policy',
  },
  {
    id: 'next-locale',
    name: 'Language preference',
    category: 'necessary',
    cookies: ['NEXT_LOCALE'],
    purpose: {
      it: "Ricorda la lingua scelta (IT/EN) per le visite successive.",
      en: 'Remembers the language you chose (IT/EN) for subsequent visits.',
    },
    duration: { it: '1 anno', en: '1 year' },
    processor: 'calicchia.design (self-hosted)',
    policyUrl: '/cookie-policy',
  },
  {
    id: 'lang-banner-dismissed',
    name: 'Language banner dismissal',
    category: 'necessary',
    cookies: ['LANG_BANNER_DISMISSED'],
    purpose: {
      it: "Memorizza la chiusura del suggerimento di passare alla versione inglese, per non riproporlo a ogni visita.",
      en: 'Stores the dismissal of the English-version suggestion so it is not shown again on every visit.',
    },
    duration: { it: '1 anno', en: '1 year' },
    processor: 'calicchia.design (self-hosted)',
    policyUrl: '/cookie-policy',
  },
  {
    id: 'cloudflare-turnstile',
    name: 'Cloudflare Turnstile',
    category: 'necessary',
    cookies: ['__cf_bm'],
    purpose: {
      it: "Verifica anti-bot sui form pubblici. Token transitorio, nessun tracking marketing.",
      en: 'Anti-bot verification on public forms. Transient token, no marketing tracking.',
    },
    duration: { it: '30 minuti', en: '30 minutes' },
    processor: 'Cloudflare, Inc. (Ireland branch)',
    policyUrl: 'https://www.cloudflare.com/privacypolicy/',
  },
  {
    id: 'bugsink',
    name: 'Bugsink (error tracking)',
    category: 'necessary',
    cookies: [],
    serverProcessing: true,
    purpose: {
      it: "Raccoglie stack trace e breadcrumb tecnici per il debug. Email, telefono, token e IP sono filtrati lato client prima dell'invio (beforeSend scrubber). Base giuridica: interesse legittimo, art. 6(1)(f) GDPR.",
      en: 'Collects stack traces and technical breadcrumbs for debugging. Email, phone, tokens and IP are filtered client-side before transmission (beforeSend scrubber). Legal basis: legitimate interest, GDPR art. 6(1)(f).',
    },
    duration: { it: '90 giorni', en: '90 days' },
    processor: 'calicchia.design (self-hosted Bugsink instance)',
    policyUrl: '/cookie-policy',
  },

  // ───── Analytics (art. 6(1)(a) GDPR — explicit consent required) ─────
  {
    id: 'google-analytics',
    name: 'Google Analytics 4',
    category: 'analytics',
    cookies: ['_ga', '_ga_<measurement-id>'],
    purpose: {
      it: "Misurazione aggregata del traffico (pagine viste, eventi). IP anonimizzato, no profilazione.",
      en: 'Aggregate traffic measurement (page views, events). IP anonymised, no profiling.',
    },
    duration: { it: '13 mesi', en: '13 months' },
    processor: 'Google Ireland Ltd. (Dublin)',
    policyUrl: 'https://policies.google.com/privacy',
  },
  {
    id: 'mouseflow',
    name: 'Mouseflow',
    category: 'analytics',
    cookies: ['mf_user'],
    purpose: {
      it: "Heatmap e session replay aggregati per analisi di usabilità. Click, scroll e movimenti del cursore. Input dei form mascherati di default.",
      en: 'Aggregate heatmaps and session replays for usability analysis. Clicks, scrolls and cursor movements. Form inputs masked by default.',
    },
    duration: { it: '12 mesi', en: '12 months' },
    processor: 'Mouseflow ApS (Denmark)',
    policyUrl: 'https://mouseflow.com/privacy/',
  },

  // ───── Marketing & third-party embeds (art. 6(1)(a) GDPR — explicit consent required) ─────
  {
    id: 'google-maps',
    name: 'Google Maps',
    category: 'marketing',
    cookies: ['NID'],
    purpose: {
      it: "Visualizzazione mappa interattiva nel footer. Caricata solo dopo consenso. Google può ricevere il tuo IP e dati tecnici del browser.",
      en: 'Interactive map embed in the footer. Loaded only after consent. Google may receive your IP and technical browser data.',
    },
    duration: { it: '6 mesi', en: '6 months' },
    processor: 'Google Ireland Ltd. (Dublin)',
    policyUrl: 'https://policies.google.com/privacy',
  },
  {
    id: 'trustindex',
    name: 'TrustIndex',
    category: 'marketing',
    cookies: ['ti-cookie'],
    purpose: {
      it: "Widget recensioni verificate. Carica contenuto dalla CDN TrustIndex.",
      en: 'Verified reviews widget. Loads content from the TrustIndex CDN.',
    },
    duration: { it: 'Sessione', en: 'Session' },
    processor: 'Trustindex Innovacios Kft. (Hungary)',
    policyUrl: 'https://www.trustindex.io/privacy-policy/',
  },
];

export const VENDORS_BY_CATEGORY: Record<ConsentCategory, readonly VendorDisclosure[]> = {
  necessary: VENDOR_DISCLOSURE.filter((v) => v.category === 'necessary'),
  analytics: VENDOR_DISCLOSURE.filter((v) => v.category === 'analytics'),
  marketing: VENDOR_DISCLOSURE.filter((v) => v.category === 'marketing'),
};
