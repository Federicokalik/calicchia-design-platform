import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import {
  getAllProfessionsLocalized,
  getProfessionCategories,
} from '@/data/seo-professions';
import {
  getProfessionSlugForLocale,
  getServiceByLandingSlug,
  getServiceUrlPrefix,
} from '@/data/seo-service-matrix';
import type { Locale } from '@/lib/i18n';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { Heading } from '@/components/ui/Heading';
import { Section } from '@/components/ui/Section';

interface RelatedProfessionsProps {
  /** Slug della professione corrente: viene esclusa. */
  currentSlug?: string;
  /** Forzare una categoria specifica (alternativa a currentSlug). */
  categoryId?: string;
  /** Massimo voci. */
  limit?: number;
}

/**
 * RelatedProfessions — lista hairline di professioni della stessa categoria.
 *
 * Strategia:
 *   - Se `currentSlug` è dato, deriva la categoria e mostra altre professioni
 *     nella stessa categoria (esclude il corrente).
 *   - Altrimenti se `categoryId` è passato, mostra le tier ≤ 2 di quella categoria.
 *   - Se entrambi mancano, ritorna null.
 *
 * Pattern Swiss: 12-col, hairline, mono numbering, NO 3-col simmetrico.
 * Link verso `/sito-web-per-<profession>` (matrice [...matrix]).
 */
export async function RelatedProfessions({
  currentSlug,
  categoryId,
  limit = 5,
}: RelatedProfessionsProps) {
  const [locale, t] = await Promise.all([
    getLocale() as Promise<Locale>,
    getTranslations('landing.relatedProfessions'),
  ]);

  // Locale-aware lookups so EN pages show "Healthcare" / "Dentists" instead of
  // "Sanità e Salute" / "Dentisti". Matrix landing routes themselves are
  // IT-only (blocked by middleware on EN), but the labels rendered here are
  // chrome and must follow the page locale.
  const allProfessions = getAllProfessionsLocalized(locale);
  const categories = getProfessionCategories(locale);

  const current = currentSlug
    ? allProfessions.find((p) => p.slug === currentSlug)
    : undefined;
  const targetCategoryId = categoryId ?? current?.categoryId;
  if (!targetCategoryId) return null;

  const category = categories[targetCategoryId];
  if (!category) return null;

  const related = allProfessions
    .filter(
      (p) =>
        p.categoryId === targetCategoryId &&
        p.slug !== currentSlug &&
        p.tier <= 2,
    )
    .slice(0, limit);

  if (related.length === 0) return null;

  // Locale-aware href: on EN we build /website-for-<en-slug>; the @/i18n
  // Link auto-prefixes /en. The catch-all [...matrix] page parses both
  // IT and EN url prefixes, but using the canonical EN URL keeps SEO clean
  // and avoids redirects.
  const sitoWebService = getServiceByLandingSlug('sito-web');
  const matrixPrefix = sitoWebService
    ? getServiceUrlPrefix(sitoWebService, locale)
    : 'sito-web-per';
  const matrixHref = (profSlug: string) =>
    `/${matrixPrefix}-${getProfessionSlugForLocale(profSlug, locale)}`;

  return (
    <Section spacing="compact" bordered="top">
      <div className="grid grid-cols-12 gap-6 md:gap-8">
        <div className="col-span-12 md:col-span-4">
          <MonoLabel as="p" className="mb-4">
            {t('heading')}
          </MonoLabel>
          <Heading
            as="h2"
            size="display-sm"
            style={{ maxWidth: '22ch' }}
          >
            {category.label}.
          </Heading>
        </div>

        <ul role="list" className="col-span-12 md:col-span-8 flex flex-col">
          {related.map((p, i) => (
            <li
              key={p.slug}
              className="border-t"
              style={{ borderColor: 'var(--color-border)' }}
            >
              <Link
                href={matrixHref(p.slug)}
                className="grid grid-cols-12 gap-4 py-5 transition-opacity hover:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                <span
                  aria-hidden="true"
                  className="col-span-2 md:col-span-1 tabular-nums"
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--text-mono-xs)',
                    letterSpacing: '0.05em',
                    color: 'var(--color-text-tertiary)',
                  }}
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span
                  className="col-span-7 md:col-span-9"
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 'var(--text-card-title)',
                    fontWeight: 500,
                    letterSpacing: '-0.02em',
                    lineHeight: 1.1,
                    color: 'var(--color-text-primary)',
                  }}
                >
                  {p.label}
                </span>
                <span
                  aria-hidden="true"
                  className="col-span-3 md:col-span-2 self-center text-right"
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--text-mono-xs)',
                    letterSpacing: '0.05em',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}
