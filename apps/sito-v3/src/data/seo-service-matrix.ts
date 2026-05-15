// Service × Profession matrix for multi-service SEO landing pages
// Maps each service to valid professions (by slug or '*' for all)

import { getAllProfessions, getProfessionBySlug, type SeoProfession } from './seo-professions';
import { PROFESSION_LABELS_EN } from './seo-professions-labels-en';
import type { Locale } from '@/lib/i18n';

const SERVICE_LABELS_EN: Record<ServiceSlug, { label: string; labelPlural: string; urlPrefix: string }> = {
  'sito-web': { label: 'Web Design', labelPlural: 'Websites', urlPrefix: 'website-for' },
  'e-commerce': { label: 'E-Commerce', labelPlural: 'E-Commerce', urlPrefix: 'e-commerce-for' },
  'sviluppo-web': { label: 'Web Development', labelPlural: 'Web Development', urlPrefix: 'web-development-for' },
  'seo': { label: 'SEO', labelPlural: 'SEO', urlPrefix: 'seo-for' },
};

/**
 * Slug-ify utility: "Hair Salons" → "hair-salons", "B&Bs" → "b-bs".
 * Usato per derivare profession slug EN dai label EN.
 */
function slugifyEn(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Cache: IT slug → EN slug derivato dai PROFESSION_LABELS_EN.
const PROFESSION_SLUG_IT_TO_EN = new Map<string, string>();
const PROFESSION_SLUG_EN_TO_IT = new Map<string, string>();
for (const [itSlug, enLabel] of Object.entries(PROFESSION_LABELS_EN)) {
  const enSlug = slugifyEn(enLabel);
  PROFESSION_SLUG_IT_TO_EN.set(itSlug, enSlug);
  PROFESSION_SLUG_EN_TO_IT.set(enSlug, itSlug);
}

export function getProfessionSlugForLocale(itSlug: string, locale: Locale = 'it'): string {
  if (locale === 'en') return PROFESSION_SLUG_IT_TO_EN.get(itSlug) ?? itSlug;
  return itSlug;
}

/** Reverse lookup: dato uno slug EN, ritorna lo slug IT canonical (per data lookup). */
export function getProfessionSlugFromEn(enSlug: string): string | undefined {
  return PROFESSION_SLUG_EN_TO_IT.get(enSlug);
}

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

// EN url prefix → service (es. 'website-for' → sito-web service object).
const serviceByPrefixEn = new Map<string, SeoService>();
for (const s of SEO_SERVICES) {
  const enPrefix = SERVICE_LABELS_EN[s.slug]?.urlPrefix;
  if (enPrefix) serviceByPrefixEn.set(enPrefix, s);
}

export function getServiceUrlPrefix(service: SeoService, locale: Locale = 'it'): string {
  if (locale === 'en') return SERVICE_LABELS_EN[service.slug]?.urlPrefix ?? service.urlPrefix;
  return service.urlPrefix;
}

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

/**
 * Locale-aware variant of `getAllSeoServices` — sostituisce `label` e
 * `labelPlural` con la versione EN per il selettore matrix su pagine EN.
 * Il `slug` / `urlPrefix` / `serviceDetailSlug` restano IT-canonical perché
 * le pagine matrix sono IT-only (route guard EN su /sito-web-per-*).
 */
export function getAllSeoServicesLocalized(locale: Locale = 'it'): SeoService[] {
  if (locale === 'it') return SEO_SERVICES;
  return SEO_SERVICES.map((s) => ({
    ...s,
    label: SERVICE_LABELS_EN[s.slug]?.label ?? s.label,
    labelPlural: SERVICE_LABELS_EN[s.slug]?.labelPlural ?? s.labelPlural,
  }));
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
 * Parse a URL segment like "e-commerce-per-dentisti-a-roma" (IT) or
 * "e-commerce-for-dentists" (EN) into service + profession + city parts.
 * Auto-detects locale via the prefix matched. La `remainder` ritornata è
 * normalizzata a slug IT canonical (es. EN "lawyers" → IT "avvocati").
 * Returns null if no service prefix matches.
 */
export function parseServiceUrl(rawSlug: string): { service: SeoService; remainder: string; locale: Locale } | null {
  // Combina prefissi IT + EN, ordinati per lunghezza desc (long-first match).
  const candidates: Array<{ prefix: string; service: SeoService; locale: Locale }> = [];
  for (const s of SEO_SERVICES) {
    candidates.push({ prefix: s.urlPrefix, service: s, locale: 'it' });
    const enPrefix = SERVICE_LABELS_EN[s.slug]?.urlPrefix;
    if (enPrefix) candidates.push({ prefix: enPrefix, service: s, locale: 'en' });
  }
  candidates.sort((a, b) => b.prefix.length - a.prefix.length);

  for (const { prefix, service, locale } of candidates) {
    if (rawSlug.startsWith(prefix + '-')) {
      const remainderRaw = rawSlug.slice(prefix.length + 1);
      // Su URL EN, prova a normalizzare la testa del remainder allo slug IT.
      // Strategia: split greedy — il remainder contiene profession[-a-city].
      // Tenta prima il match dell'intero remainder come EN profession slug,
      // poi prova split su "-" progressivamente.
      let remainder = remainderRaw;
      if (locale === 'en') {
        const itProfession = PROFESSION_SLUG_EN_TO_IT.get(remainderRaw);
        if (itProfession) {
          remainder = itProfession;
        } else {
          // Tenta split a "-" per gestire eventuali suffix (es. "lawyers-in-rome")
          const parts = remainderRaw.split('-');
          for (let i = parts.length; i > 0; i--) {
            const head = parts.slice(0, i).join('-');
            const tail = parts.slice(i).join('-');
            const it = PROFESSION_SLUG_EN_TO_IT.get(head);
            if (it) {
              remainder = tail ? `${it}-${tail}` : it;
              break;
            }
          }
        }
      }
      return { service, remainder, locale };
    }
  }
  return null;
}
