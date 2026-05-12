/**
 * Compatibility shim for layout consumers.
 *
 * The source of truth lives in seo-professions.ts and seo-service-matrix.ts.
 * Keep this module's public shape stable for MorphTicker (which now also
 * drives the mobile bottom sheet — Swiss compliance unification 2026-05-09,
 * ServiceFinderMobile rimosso).
 */

import {
  getAllProfessions,
  PROFESSION_CATEGORIES,
  type SeoProfession,
} from './seo-professions';
import {
  SEO_SERVICES,
  getProfessionsForService,
  isProfessionValidForService,
  type SeoService,
} from './seo-service-matrix';

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

function getCategoryLabel(categoryId: string): string {
  return PROFESSION_CATEGORIES[categoryId]?.label ?? categoryId;
}

function toMatrixProfession(profession: SeoProfession): MatrixProfession {
  return {
    slug: profession.slug,
    label: profession.label,
    category: getCategoryLabel(profession.categoryId),
  };
}

export const SERVICES: MatrixService[] = SEO_SERVICES.map(toMatrixService);
export const PROFESSIONS: MatrixProfession[] = getAllProfessions().map(
  toMatrixProfession
);

const serviceBySlug = new Map<string, SeoService>(
  SEO_SERVICES.map((service) => [service.slug, service])
);

const professionBySlug = new Map<string, MatrixProfession>(
  PROFESSIONS.map((profession) => [profession.slug, profession])
);

const orderedCategoryLabels = Object.values(PROFESSION_CATEGORIES).map(
  (category) => category.label
);

function mapSeoProfessions(professions: SeoProfession[]): MatrixProfession[] {
  return professions
    .map((profession) => professionBySlug.get(profession.slug))
    .filter((profession): profession is MatrixProfession => Boolean(profession));
}

export function getValidProfessions(
  serviceSlug: string | null
): MatrixProfession[] {
  if (serviceSlug === null) return PROFESSIONS;

  const service = serviceBySlug.get(serviceSlug);
  if (!service) return [];

  return mapSeoProfessions(getProfessionsForService(service.slug));
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
  professionSlug: string
): string | null {
  const service = serviceBySlug.get(serviceSlug);
  if (!service) return null;

  if (!isProfessionValidForService(service.slug, professionSlug)) return null;

  return `/${service.urlPrefix}-${professionSlug}`;
}

/** Group professions by category for dropdown sectioning. */
export function groupProfessionsByCategory(
  profs: MatrixProfession[]
): Array<{ category: string; items: MatrixProfession[] }> {
  const map = new Map<string, MatrixProfession[]>();

  for (const profession of profs) {
    const items = map.get(profession.category) ?? [];
    items.push(profession);
    map.set(profession.category, items);
  }

  const grouped = orderedCategoryLabels
    .map((category) => {
      const items = map.get(category);
      return items ? { category, items } : null;
    })
    .filter(
      (group): group is { category: string; items: MatrixProfession[] } =>
        Boolean(group)
    );

  for (const [category, items] of map.entries()) {
    if (!orderedCategoryLabels.includes(category)) {
      grouped.push({ category, items });
    }
  }

  return grouped;
}
