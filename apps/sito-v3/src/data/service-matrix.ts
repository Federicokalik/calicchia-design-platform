/**
 * Compatibility shim for layout consumers.
 *
 * The source of truth lives in seo-professions.ts and seo-service-matrix.ts.
 * Keep this module's public shape stable for MorphTicker (which now also
 * drives the mobile bottom sheet — Swiss compliance unification 2026-05-09,
 * ServiceFinderMobile rimosso).
 *
 * Locale awareness (2026-05-15): le label di servizi e professioni nel
 * selettore matrix (MorphTicker, PerChiLavoro) seguono il locale corrente.
 * Le matrix landing pages /sito-web-per-* restano IT-only (route guard EN),
 * ma il SELETTORE appare anche su pagine EN bilingual e deve mostrare label EN.
 */

import {
  getAllProfessions,
  getAllProfessionsLocalized,
  getProfessionCategories,
  PROFESSION_CATEGORIES,
  type SeoProfession,
} from './seo-professions';
import {
  SEO_SERVICES,
  getAllSeoServicesLocalized,
  getProfessionsForService,
  getProfessionSlugForLocale,
  getServiceUrlPrefix,
  isProfessionValidForService,
  type SeoService,
} from './seo-service-matrix';
import type { Locale } from '@/lib/i18n';

export interface MatrixService {
  slug: string;
  urlPrefix: string;
  label: string;
}

export interface MatrixProfession {
  slug: string;
  label: string;
  category: string;
}

function toMatrixService(service: SeoService): MatrixService {
  return {
    slug: service.slug,
    urlPrefix: service.urlPrefix,
    label: service.label,
  };
}

function makeCategoryLabelGetter(locale: Locale = 'it') {
  const categories = getProfessionCategories(locale);
  return (categoryId: string): string =>
    categories[categoryId]?.label ?? categoryId;
}

function toMatrixProfession(
  profession: SeoProfession,
  getCategoryLabel: (id: string) => string,
): MatrixProfession {
  return {
    slug: profession.slug,
    label: profession.label,
    category: getCategoryLabel(profession.categoryId),
  };
}

// IT-default exports for backward compatibility (call site senza locale).
export const SERVICES: MatrixService[] = SEO_SERVICES.map(toMatrixService);
export const PROFESSIONS: MatrixProfession[] = (() => {
  const getCategoryLabel = makeCategoryLabelGetter('it');
  return getAllProfessions().map((p) => toMatrixProfession(p, getCategoryLabel));
})();

/**
 * Locale-aware getter per il MorphTicker e altri consumer del selettore.
 */
export function getMatrixServices(locale: Locale = 'it'): MatrixService[] {
  return getAllSeoServicesLocalized(locale).map(toMatrixService);
}

export function getMatrixProfessions(locale: Locale = 'it'): MatrixProfession[] {
  const getCategoryLabel = makeCategoryLabelGetter(locale);
  return getAllProfessionsLocalized(locale).map((p) =>
    toMatrixProfession(p, getCategoryLabel),
  );
}

const serviceBySlug = new Map<string, SeoService>(
  SEO_SERVICES.map((service) => [service.slug, service])
);

const professionBySlug = new Map<string, MatrixProfession>(
  PROFESSIONS.map((profession) => [profession.slug, profession])
);

const orderedCategoryLabels = Object.values(PROFESSION_CATEGORIES).map(
  (category) => category.label
);

function mapSeoProfessions(
  professions: SeoProfession[],
  matrixList: MatrixProfession[],
): MatrixProfession[] {
  const bySlug = new Map(matrixList.map((p) => [p.slug, p]));
  return professions
    .map((profession) => bySlug.get(profession.slug))
    .filter((profession): profession is MatrixProfession => Boolean(profession));
}

export function getValidProfessions(
  serviceSlug: string | null,
  locale: Locale = 'it',
): MatrixProfession[] {
  const matrixList = getMatrixProfessions(locale);
  if (serviceSlug === null) return matrixList;

  const service = serviceBySlug.get(serviceSlug);
  if (!service) return [];

  return mapSeoProfessions(getProfessionsForService(service.slug), matrixList);
}

export function isCombinationValid(
  serviceSlug: string,
  professionSlug: string
): boolean {
  const service = serviceBySlug.get(serviceSlug);
  if (!service) return false;

  return isProfessionValidForService(service.slug, professionSlug);
}

export function buildMatrixUrl(
  serviceSlug: string,
  professionSlug: string,
  locale: Locale = 'it',
): string | null {
  const service = serviceBySlug.get(serviceSlug);
  if (!service) return null;

  if (!isProfessionValidForService(service.slug, professionSlug)) return null;

  const prefix = getServiceUrlPrefix(service, locale);
  const profSlug = getProfessionSlugForLocale(professionSlug, locale);
  return `/${prefix}-${profSlug}`;
}

/** Group professions by category for dropdown sectioning. */
export function groupProfessionsByCategory(
  profs: MatrixProfession[],
  locale: Locale = 'it',
): Array<{ category: string; items: MatrixProfession[] }> {
  const map = new Map<string, MatrixProfession[]>();

  for (const profession of profs) {
    const items = map.get(profession.category) ?? [];
    items.push(profession);
    map.set(profession.category, items);
  }

  const categories = getProfessionCategories(locale);
  const localizedOrder =
    locale === 'it'
      ? orderedCategoryLabels
      : Object.values(categories).map((c) => c.label);

  const grouped = localizedOrder
    .map((category) => {
      const items = map.get(category);
      return items ? { category, items } : null;
    })
    .filter(
      (group): group is { category: string; items: MatrixProfession[] } =>
        Boolean(group)
    );

  for (const [category, items] of map.entries()) {
    if (!localizedOrder.includes(category)) {
      grouped.push({ category, items });
    }
  }

  return grouped;
}
