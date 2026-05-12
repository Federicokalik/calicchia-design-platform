// Service × Profession matrix for multi-service SEO landing pages
// Maps each service to valid professions (by slug or '*' for all)

import { getAllProfessions, getProfessionBySlug, type SeoProfession } from './seo-professions';

// ─── Service definitions ───────────────────────────────

export type ServiceSlug =
  | 'sito-web'
  | 'e-commerce'
  | 'seo'
  | 'sviluppo-web';

export interface SeoService {
  slug: ServiceSlug;
  urlPrefix: string;    // e.g. "e-commerce-per"
  label: string;        // Human-readable name
  labelPlural: string;  // For titles like "Servizi di E-Commerce per..."
  icon: string;         // Phosphor icon
  /** Slug in /servizi/ detail page (if different from landing slug) */
  serviceDetailSlug: string;
}

export const SEO_SERVICES: SeoService[] = [
  {
    slug: 'sito-web',
    urlPrefix: 'sito-web-per',
    label: 'Web Design',
    labelPlural: 'Siti Web',
    icon: 'ph-globe',
    serviceDetailSlug: 'web-design',
  },
  {
    slug: 'e-commerce',
    urlPrefix: 'e-commerce-per',
    label: 'E-Commerce',
    labelPlural: 'E-Commerce',
    icon: 'ph-shopping-cart',
    serviceDetailSlug: 'e-commerce',
  },
  {
    slug: 'sviluppo-web',
    urlPrefix: 'sviluppo-web-per',
    label: 'Sviluppo Web',
    labelPlural: 'Sviluppo Web',
    icon: 'ph-code',
    serviceDetailSlug: 'sviluppo-web',
  },
  {
    slug: 'seo',
    urlPrefix: 'seo-per',
    label: 'SEO',
    labelPlural: 'SEO',
    icon: 'ph-magnifying-glass',
    serviceDetailSlug: 'seo',
  },
];

// ─── Service → Professions mapping ───────────────────────────────
// '*' = all professions, otherwise array of slugs

const SERVICE_PROFESSIONS: Record<ServiceSlug, '*' | string[]> = {
  'sito-web': '*', // all 130
  'seo': '*',      // all 130

  'e-commerce': [
    // retail-negozi (18)
    'negozi-di-abbigliamento', 'arredamenti', 'gioiellerie', 'fiorai', 'ferramenta',
    'elettrodomestici', 'boutique', 'librerie', 'mobili', 'materassi',
    'telefonia', 'informatica', 'copisterie', 'tipografie', 'ricamifici',
    'mercerie', 'tabaccherie', 'cartolerie',
    // food-hospitality (8)
    'pasticcerie', 'panifici', 'gelaterie', 'enoteche', 'wine-bar',
    'catering', 'agriturismi', 'case-vacanza',
    // beauty-wellness (5)
    'centri-estetici', 'saloni-di-bellezza', 'palestre', 'centri-sportivi', 'piscine',
    // sanita-salute (4)
    'farmacie', 'parafarmacie', 'ottici', 'audioprotesisti',
    // auto-mobilita (2)
    'concessionarie-auto', 'autonoleggi',
    // creativita-eventi (3)
    'fotografi', 'agenzie-viaggi', 'centri-di-formazione',
  ],

  'sviluppo-web': [
    // food-hospitality (4) — gestionali prenotazioni, integrazioni POS
    'hotel', 'b-b', 'ristoranti', 'case-vacanza',
    // studi-professionali (4) — gestionali pratiche, aree clienti, automazioni
    'agenzie-immobiliari', 'avvocati', 'commercialisti', 'architetti',
    // beauty-wellness (3) — gestionali prenotazioni
    'palestre', 'centri-sportivi', 'piscine',
    // sanita-salute (5) — agende, cartelle, area pazienti
    'dentisti', 'medici', 'fisioterapisti', 'psicologi', 'farmacie',
    // creativita-eventi (3) — piattaforme corsi, prenotazioni, gestionali tour
    'scuole-private', 'centri-di-formazione', 'agenzie-viaggi',
    // auto-mobilita (2) — gestionali concessionari, noleggi
    'concessionarie-auto', 'autonoleggi',
    // retail-negozi (4) — integrazioni gestionale, sync inventario
    'negozi-di-abbigliamento', 'arredamenti', 'gioiellerie', 'elettrodomestici',
  ],
};

// ─── Precomputed sets for fast lookup ───────────────────────────────

const serviceProfessionSets = new Map<ServiceSlug, Set<string> | '*'>();
for (const [slug, profs] of Object.entries(SERVICE_PROFESSIONS)) {
  serviceProfessionSets.set(
    slug as ServiceSlug,
    profs === '*' ? '*' : new Set(profs),
  );
}

const serviceBySlug = new Map<ServiceSlug, SeoService>();
for (const s of SEO_SERVICES) serviceBySlug.set(s.slug, s);

const serviceByPrefix = new Map<string, SeoService>();
for (const s of SEO_SERVICES) serviceByPrefix.set(s.urlPrefix, s);

// ─── Public API ───────────────────────────────

export function getServiceByLandingSlug(slug: ServiceSlug): SeoService | undefined {
  return serviceBySlug.get(slug);
}

export function getServiceByUrlPrefix(prefix: string): SeoService | undefined {
  return serviceByPrefix.get(prefix);
}

export function getAllSeoServices(): SeoService[] {
  return SEO_SERVICES;
}

/** Check if a profession is valid for a given service */
export function isProfessionValidForService(serviceSlug: ServiceSlug, profSlug: string): boolean {
  const set = serviceProfessionSets.get(serviceSlug);
  if (!set) return false;
  if (set === '*') return !!getProfessionBySlug(profSlug);
  return set.has(profSlug);
}

/** Get all professions valid for a service */
export function getProfessionsForService(serviceSlug: ServiceSlug): SeoProfession[] {
  const mapping = SERVICE_PROFESSIONS[serviceSlug];
  if (!mapping) return [];
  if (mapping === '*') return getAllProfessions();
  return mapping
    .map(slug => getProfessionBySlug(slug))
    .filter((p): p is SeoProfession => !!p);
}

/** Get all services available for a given profession */
export function getServicesForProfession(profSlug: string): SeoService[] {
  return SEO_SERVICES.filter(s => isProfessionValidForService(s.slug, profSlug));
}

/** Get other services for a profession (excluding current) */
export function getOtherServicesForProfession(profSlug: string, currentServiceSlug: ServiceSlug): SeoService[] {
  return SEO_SERVICES.filter(
    s => s.slug !== currentServiceSlug && isProfessionValidForService(s.slug, profSlug),
  );
}

/**
 * Parse a URL segment like "e-commerce-per-dentisti-a-roma" into service + profession + city parts.
 * Returns null if no service prefix matches.
 */
export function parseServiceUrl(rawSlug: string): { service: SeoService; remainder: string } | null {
  // Sort prefixes by length desc to match longer first
  const prefixes = SEO_SERVICES
    .map(s => ({ prefix: s.urlPrefix, service: s }))
    .sort((a, b) => b.prefix.length - a.prefix.length);

  for (const { prefix, service } of prefixes) {
    if (rawSlug.startsWith(prefix + '-')) {
      return {
        service,
        remainder: rawSlug.slice(prefix.length + 1), // +1 for the '-' after prefix
      };
    }
  }
  return null;
}
