// Per-service, per-category content for multi-service SEO landing pages.
//
// Refactor 2026-05: ogni servizio matrice ha il suo file content sotto
// `seo-content/<servizio>.ts`, generato via scripts/generate-matrix-copy.mjs.
// Ogni file esporta un Record<categoryId, ServiceCategoryContent> che copre
// tutte le 8 categorie professionali. Questo file è il barrel che li mappa al
// `ServiceSlug` per il consumer (matrix page, zone page).

import type { ServiceSlug } from './seo-service-matrix';
import { WEB_DESIGN_CONTENT } from './seo-content/web-design';
import { E_COMMERCE_CONTENT } from './seo-content/e-commerce';
import { SVILUPPO_WEB_CONTENT } from './seo-content/sviluppo-web';
import { SEO_CONTENT } from './seo-content/seo';

export interface ServiceCategoryContent {
  description: string;
  microStory: string;
  caseStudyRef?: string | undefined;
  problems: { icon: string; title: string; desc: string }[];
  features: { title: string; description: string }[];
  faqs: { question: string; answer: string }[];
  ctaText: string;
  /** Section title for "Cosa costruisco per te" */
  solutionTitle: string;
  /** Search example template (use [citta] as placeholder) */
  searchExamplePrefix: string;
}

const SERVICE_CONTENT_MAP: Record<ServiceSlug, Record<string, ServiceCategoryContent>> = {
  // sito-web (Web Design) usa i contenuti di seo-content/web-design.ts
  // L'urlPrefix in seo-service-matrix.ts resta `sito-web-per` per preservare
  // il SEO ranking esistente; il content è quello nuovo voice-aligned.
  'sito-web': WEB_DESIGN_CONTENT,
  'e-commerce': E_COMMERCE_CONTENT,
  'sviluppo-web': SVILUPPO_WEB_CONTENT,
  'seo': SEO_CONTENT,
};

/**
 * Get service content for a specific service + category combination.
 * Restituisce il content settoriale per la combo (servizio × categoria).
 * Se la categoria non ha content per quel servizio, ritorna undefined.
 */
export function getServiceContent(
  serviceSlug: ServiceSlug,
  categoryId: string,
): ServiceCategoryContent | undefined {
  const serviceMap = SERVICE_CONTENT_MAP[serviceSlug];
  if (!serviceMap) return undefined;
  return serviceMap[categoryId];
}

/**
 * Lista tutte le categorie con content disponibile per un dato servizio.
 * Utile per generateStaticParams o sitemap.
 */
export function getCategoriesForService(serviceSlug: ServiceSlug): string[] {
  const serviceMap = SERVICE_CONTENT_MAP[serviceSlug];
  if (!serviceMap) return [];
  return Object.keys(serviceMap);
}
