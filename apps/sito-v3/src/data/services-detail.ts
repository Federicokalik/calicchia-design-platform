// Service detail data per le pagine /servizi/[slug].
//
// Refactor 2026-05: ogni servizio ha il suo file content sotto
// `services-content/<slug>.ts`, generato via scripts/generate-services-copy.mjs.
// Questo file mantiene le interface + esporta SERVICES_DETAIL come unione
// dei file generati. Tono voice-aligned (anti-agenzia, anti-marketing,
// niente prezzi, niente "preventivo" come hook commerciale).

export interface ServiceFeature {
  title: string;
  description: string;
}

export interface ProcessStep {
  step: number;
  title: string;
  description: string;
}

export interface AwarenessItem {
  icon: string; // Phosphor icon class
  title: string;
  desc: string;
}

export interface ServiceAwareness {
  title: string;
  subtitle: string;
  problems: AwarenessItem[];
}

export interface ServiceFaq {
  question: string;
  answer: string;
}

/**
 * Storyline item: rhetorical "non X / ma Y" pair used by the Storyline
 * section on /servizi/[slug] (replaces the old marquee).
 */
export interface ServiceStoryItem {
  /** What you DON'T get — muted prose. E.g. "Non un sito carino." */
  before: string;
  /** What you DO get — display heading. E.g. "Un sito che converte." */
  after: string;
  /** Short supporting detail under the affirmation. */
  detail?: string;
}

export interface ServiceExpandedScope {
  eyebrow: string;
  title: string;
  body: string;
}

export interface ServiceDeliverable {
  title: string;
  format: string;
  timeline: string;
}

export interface RelatedService {
  slug: string;
  title: string;
  shortPitch: string;
}

export type ServiceRelated = RelatedService;

export interface ServiceLeadMagnetCopy {
  eyebrow: string;
  title: string;
  body: string;
}

export interface ServiceDetail {
  slug: string;
  title: string;
  description: string;
  longDescription: string;
  icon: string; // Phosphor icon class e.g. "ph-globe"
  features: ServiceFeature[];
  benefits: string[];
  process: ProcessStep[];
  faqs: ServiceFaq[];
  awareness: ServiceAwareness;
  /**
   * Optional narrative add-on for post-launch or expanded project scope.
   * Keeps adjacent services searchable without adding catalog entries.
   */
  expandedScope?: ServiceExpandedScope;
  deliverables?: readonly ServiceDeliverable[];
  related?: readonly ServiceRelated[];
  leadMagnetCopy?: ServiceLeadMagnetCopy;
}

// ─── Generated content imports (refactor 2026-05) ──────────────────
// Matrix services (4)
import { WEB_DESIGN_SERVICE } from './services-content/web-design';
import { E_COMMERCE_SERVICE } from './services-content/e-commerce';
import { SVILUPPO_WEB_SERVICE } from './services-content/sviluppo-web';
import { SEO_SERVICE } from './services-content/seo';
import { WEB_DESIGN_EXTRAS } from './services-content/web-design-extras';
import { E_COMMERCE_EXTRAS } from './services-content/e-commerce-extras';
import { SVILUPPO_WEB_EXTRAS } from './services-content/sviluppo-web-extras';
import { SEO_EXTRAS } from './services-content/seo-extras';
// Standalone services (6) — branding rimosso 2026-05-08 (fuori positioning).
import { MANUTENZIONE_SITI_SERVICE } from './services-content/manutenzione-siti';
import { ASSISTENZA_WORDPRESS_SERVICE } from './services-content/assistenza-wordpress';
import { WORDPRESS_MIGRAZIONE_SERVICE } from './services-content/wordpress-migrazione';
import { PERFORMANCE_CWV_SERVICE } from './services-content/performance-cwv';
import { ACCESSIBILITY_WCAG_SERVICE } from './services-content/accessibility-wcag';
import { ANALYTICS_SETUP_SERVICE } from './services-content/analytics-setup';
import { MANUTENZIONE_SITI_EXTRAS } from './services-content/manutenzione-siti-extras';
import { ASSISTENZA_WORDPRESS_EXTRAS } from './services-content/assistenza-wordpress-extras';
import { WORDPRESS_MIGRAZIONE_EXTRAS } from './services-content/wordpress-migrazione-extras';
import { PERFORMANCE_CWV_EXTRAS } from './services-content/performance-cwv-extras';
import { ACCESSIBILITY_WCAG_EXTRAS } from './services-content/accessibility-wcag-extras';
import { ANALYTICS_SETUP_EXTRAS } from './services-content/analytics-setup-extras';

export const SERVICES_DETAIL: ServiceDetail[] = [
  // Matrix (4) — anche pagine matrice puntano a questi via serviceDetailSlug
  { ...WEB_DESIGN_SERVICE, ...WEB_DESIGN_EXTRAS },
  { ...E_COMMERCE_SERVICE, ...E_COMMERCE_EXTRAS },
  { ...SVILUPPO_WEB_SERVICE, ...SVILUPPO_WEB_EXTRAS },
  { ...SEO_SERVICE, ...SEO_EXTRAS },
  // Standalone (6) — fuori matrice, raggiungibili solo da /servizi/<slug>
  { ...MANUTENZIONE_SITI_SERVICE, ...MANUTENZIONE_SITI_EXTRAS },
  { ...ASSISTENZA_WORDPRESS_SERVICE, ...ASSISTENZA_WORDPRESS_EXTRAS },
  { ...WORDPRESS_MIGRAZIONE_SERVICE, ...WORDPRESS_MIGRAZIONE_EXTRAS },
  { ...PERFORMANCE_CWV_SERVICE, ...PERFORMANCE_CWV_EXTRAS },
  { ...ACCESSIBILITY_WCAG_SERVICE, ...ACCESSIBILITY_WCAG_EXTRAS },
  { ...ANALYTICS_SETUP_SERVICE, ...ANALYTICS_SETUP_EXTRAS },
];

// ─── EN translations (Round 5a, 2026-05-08) ─────────────────────────
// Pattern: file paralleli `services-content/en/<slug>.ts` con stesso schema
// ServiceDetail. Quando un servizio non è ancora tradotto, il helper
// getServiceDetail(slug, 'en') cade su SERVICES_DETAIL canonical IT.
//
// Codex Round 5a deve completare gli altri 10 servizi (web-design, e-commerce,
// sviluppo-web, seo, manutenzione-siti, assistenza-wordpress, wordpress-migrazione,
// performance-cwv, accessibility-wcag, analytics-setup).
import { WEB_DESIGN_SERVICE_EN } from './services-content/en/web-design';
import { WEB_DESIGN_EXTRAS_EN } from './services-content/en/web-design-extras';
import { E_COMMERCE_SERVICE_EN } from './services-content/en/e-commerce';
import { E_COMMERCE_EXTRAS_EN } from './services-content/en/e-commerce-extras';
import { SVILUPPO_WEB_SERVICE_EN } from './services-content/en/sviluppo-web';
import { SVILUPPO_WEB_EXTRAS_EN } from './services-content/en/sviluppo-web-extras';
import { SEO_SERVICE_EN } from './services-content/en/seo';
import { SEO_EXTRAS_EN } from './services-content/en/seo-extras';
import { MANUTENZIONE_SITI_SERVICE_EN } from './services-content/en/manutenzione-siti';
import { MANUTENZIONE_SITI_EXTRAS_EN } from './services-content/en/manutenzione-siti-extras';
import { ASSISTENZA_WORDPRESS_SERVICE_EN } from './services-content/en/assistenza-wordpress';
import { ASSISTENZA_WORDPRESS_EXTRAS_EN } from './services-content/en/assistenza-wordpress-extras';
import { WORDPRESS_MIGRAZIONE_SERVICE_EN } from './services-content/en/wordpress-migrazione';
import { WORDPRESS_MIGRAZIONE_EXTRAS_EN } from './services-content/en/wordpress-migrazione-extras';
import { PERFORMANCE_CWV_SERVICE_EN } from './services-content/en/performance-cwv';
import { PERFORMANCE_CWV_EXTRAS_EN } from './services-content/en/performance-cwv-extras';
import { ACCESSIBILITY_WCAG_SERVICE_EN } from './services-content/en/accessibility-wcag';
import { ACCESSIBILITY_WCAG_EXTRAS_EN } from './services-content/en/accessibility-wcag-extras';
import { ANALYTICS_SETUP_SERVICE_EN } from './services-content/en/analytics-setup';
import { ANALYTICS_SETUP_EXTRAS_EN } from './services-content/en/analytics-setup-extras';

export const SERVICES_DETAIL_EN: ServiceDetail[] = [
  // Matrix (4) — tutti tradotti EN
  { ...WEB_DESIGN_SERVICE_EN, ...WEB_DESIGN_EXTRAS_EN },
  { ...E_COMMERCE_SERVICE_EN, ...E_COMMERCE_EXTRAS_EN },
  { ...SVILUPPO_WEB_SERVICE_EN, ...SVILUPPO_WEB_EXTRAS_EN },
  { ...SEO_SERVICE_EN, ...SEO_EXTRAS_EN },
  // Standalone (6) — tutti tradotti EN
  { ...MANUTENZIONE_SITI_SERVICE_EN, ...MANUTENZIONE_SITI_EXTRAS_EN },
  { ...ASSISTENZA_WORDPRESS_SERVICE_EN, ...ASSISTENZA_WORDPRESS_EXTRAS_EN },
  { ...WORDPRESS_MIGRAZIONE_SERVICE_EN, ...WORDPRESS_MIGRAZIONE_EXTRAS_EN },
  { ...PERFORMANCE_CWV_SERVICE_EN, ...PERFORMANCE_CWV_EXTRAS_EN },
  { ...ACCESSIBILITY_WCAG_SERVICE_EN, ...ACCESSIBILITY_WCAG_EXTRAS_EN },
  { ...ANALYTICS_SETUP_SERVICE_EN, ...ANALYTICS_SETUP_EXTRAS_EN },
];

type ServicesLocale = 'it' | 'en';

/**
 * Locale-aware lookup. Se locale='en' e la traduzione esiste in SERVICES_DETAIL_EN,
 * restituisce quella. Altrimenti fallback su IT canonical (SERVICES_DETAIL).
 *
 * Pattern usage:
 *   const svc = getServiceDetail(slug, locale);  // locale arriva da page params
 */
export function getServiceDetail(
  slug: string,
  locale: ServicesLocale = 'it',
): ServiceDetail | undefined {
  if (locale === 'en') {
    const en = SERVICES_DETAIL_EN.find((s) => s.slug === slug);
    if (en) return en;
  }
  return SERVICES_DETAIL.find((s) => s.slug === slug);
}

/** Lista servizi nel locale richiesto, con merge IT fallback per slug non tradotti. */
export function getAllServiceDetails(locale: ServicesLocale = 'it'): ServiceDetail[] {
  if (locale !== 'en') return SERVICES_DETAIL;
  // Merge: per ogni IT, usa EN se esiste, altrimenti fallback IT.
  return SERVICES_DETAIL.map(
    (it) => SERVICES_DETAIL_EN.find((en) => en.slug === it.slug) ?? it,
  );
}
