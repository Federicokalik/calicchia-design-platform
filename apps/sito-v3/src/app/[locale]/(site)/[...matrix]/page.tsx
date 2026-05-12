import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import {
  parseServiceUrl,
  isProfessionValidForService,
  type SeoService,
} from '@/data/seo-service-matrix';
import {
  getProfessionBySlug,
  getCategoryForProfession,
  getProfessionContent,
  type SeoProfession,
} from '@/data/seo-professions';
import { getCityBySlug, type SeoCity } from '@/data/seo-cities';
import { getServiceContent } from '@/data/seo-service-content';
import { getComboMeta } from '@/data/comune-service-content';
import { COMUNE_ATTRIBUTES, getPreposizione } from '@/lib/comune-attributes';
import { LandingHero } from '@/components/seo-landing/LandingHero';
import { LandingComboAngle } from '@/components/seo-landing/LandingComboAngle';
import { LandingProblems } from '@/components/seo-landing/LandingProblems';
import { LandingFeatures } from '@/components/seo-landing/LandingFeatures';
import { LandingMicroStory } from '@/components/seo-landing/LandingMicroStory';
import { LandingFaq } from '@/components/seo-landing/LandingFaq';
import { LandingCta } from '@/components/seo-landing/LandingCta';
import { RelatedProfessions } from '@/components/seo-landing/RelatedProfessions';
import { StructuredData } from '@/components/seo/StructuredData';
import { breadcrumbSchema, faqPageSchema, serviceSchema } from '@/data/structured-data';
import { buildCanonical } from '@/lib/canonical';
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n';

interface Params {
  locale?: Locale;
  matrix: string[];
}

interface ParsedMatrix {
  service: SeoService;
  profession: SeoProfession;
  city: SeoCity | null;
}

/**
 * Parse a legacy SEO URL like:
 *   "comunicazione-offline-per-palestre"
 *   "sito-web-per-avvocati-a-roma"
 *   "e-commerce-per-gioiellerie-a-l-aquila"
 *
 * Strategy:
 *   1. parseServiceUrl → { service, remainder }
 *   2. Try the whole remainder as a profession slug. If matches AND valid for the service → no city.
 *   3. Otherwise iteratively split on "-a-" (right-to-left) to handle hyphenated city slugs
 *      (e.g. "l-aquila", "reggio-di-calabria"). Pick the first valid (profession, city) pair.
 *   4. Validate that the profession is in the service whitelist.
 *
 * Returns null if no valid combination is found — caller calls notFound().
 */
function parseMatrix(segment: string): ParsedMatrix | null {
  const head = parseServiceUrl(segment);
  if (!head) return null;
  const { service, remainder } = head;

  // No city: try the whole remainder as profession.
  const directProf = getProfessionBySlug(remainder);
  if (directProf && isProfessionValidForService(service.slug, directProf.slug)) {
    return { service, profession: directProf, city: null };
  }

  // City variant: split on "-a-" right-to-left to disambiguate hyphenated city slugs.
  const sepIndices: number[] = [];
  let idx = remainder.indexOf('-a-');
  while (idx !== -1) {
    sepIndices.push(idx);
    idx = remainder.indexOf('-a-', idx + 1);
  }

  // Try right-to-left first (longest possible city slug).
  for (let i = sepIndices.length - 1; i >= 0; i--) {
    const splitAt = sepIndices[i];
    const profSlug = remainder.slice(0, splitAt);
    const citySlug = remainder.slice(splitAt + 3); // +3 for "-a-"
    const prof = getProfessionBySlug(profSlug);
    const city = getCityBySlug(citySlug);
    if (prof && city && isProfessionValidForService(service.slug, prof.slug)) {
      return { service, profession: prof, city };
    }
  }

  return null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { matrix, locale = DEFAULT_LOCALE } = await params;
  if (matrix.length !== 1) return { title: 'Pagina non trovata' };
  const parsed = parseMatrix(matrix[0]);
  if (!parsed) return { title: 'Pagina non trovata' };
  const { service, profession, city } = parsed;
  const profLower = profession.label.toLowerCase();
  const title = city
    ? `${service.label} per ${profLower} ${getPreposizione(city.nome)} ${city.nome}`
    : `${service.label} per ${profLower}`;
  const description = getProfessionContent(profession.slug)?.tagline ??
    `${service.label} per ${profLower}. Progettazione, sviluppo, SEO ${city ? `nella zona di ${city.nome}` : 'in tutta Italia'}.`;
  // Tier-based indexing: top combos indexed, long-tail noindex by default.
  const indexable =
    profession.tier <= 2 && (!city || city.tier <= 2);
  // OG image generato da route handler dedicato (Next.js non permette
  // metadata files dentro catch-all segment).
  const ogImageUrl = `/api/og/matrix/${encodeURIComponent(matrix[0])}?locale=${locale}`;
  return {
    title,
    description,
    alternates: { canonical: buildCanonical(`/${matrix[0]}`, locale) },
    robots: indexable
      ? { index: true, follow: true }
      : { index: false, follow: true },
    openGraph: {
      title,
      description,
      url: buildCanonical(`/${matrix[0]}`, locale),
      type: 'article',
      images: [{ url: ogImageUrl, width: 1200, height: 630 }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [ogImageUrl],
    },
  };
}

export default async function SeoMatrixPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { matrix, locale = DEFAULT_LOCALE } = await params;

  // Catch-all should be exactly 1 segment for these legacy URLs.
  if (matrix.length !== 1) notFound();

  const parsed = parseMatrix(matrix[0]);
  if (!parsed) notFound();

  const { service, profession, city } = parsed;
  const category = getCategoryForProfession(profession);
  const content = getProfessionContent(profession.slug);

  const profLower = profession.label.toLowerCase();
  const prep = city ? getPreposizione(city.nome) : null;

  // Hero title varies by combo.
  const heroTitle = city
    ? `${service.label} per ${profLower} ${prep} ${city.nome}.`
    : `${service.label} per ${profLower}.`;

  // Service-specific content (problems/features/faqs) per category.
  // For "sito-web" the legacy uses the profession-category content for problems/features
  // (default service, broader profession coverage), but we still pull the new
  // seo-content/web-design.ts microStory + caseStudyRef when available.
  const fullServiceContent = getServiceContent(service.slug, profession.categoryId);
  const serviceCategoryContent =
    service.slug === 'sito-web' ? null : fullServiceContent;
  const microStory = fullServiceContent?.microStory;
  const caseStudyRef = fullServiceContent?.caseStudyRef;

  // Decide which dataset to render: prefer service-specific content when available,
  // fall back to profession category (used by sito-web).
  const renderProblems = serviceCategoryContent?.problems ?? category.problems;
  const renderFeatures = serviceCategoryContent?.features ?? category.features;
  const renderFaqs = serviceCategoryContent?.faqs ?? category.faqs;
  const renderCta = serviceCategoryContent?.ctaText ?? category.ctaText;
  const renderHeading = serviceCategoryContent?.solutionTitle;
  const renderDescription =
    serviceCategoryContent?.description ?? category.description;

  // Combo angle (deterministic per comune × service) — only when city is present
  // AND city is in the COMUNE_ATTRIBUTES set (capoluoghi tier ≤ 2 + ciociaria-top).
  const showComboAngle = city && !!COMUNE_ATTRIBUTES[city.slug];
  const combo = showComboAngle ? getComboMeta(city.slug, service.slug) : null;
  const canonical = buildCanonical(`/${matrix[0]}`, locale);
  const schemas = [
    serviceSchema({
      slug: service.serviceDetailSlug,
      name: heroTitle.replace(/\.$/, ''),
      description: renderDescription,
      url: canonical,
      serviceType: service.label,
      profession: profession.label,
      comune: city?.nome,
    }),
    breadcrumbSchema([
      { name: 'Home', url: buildCanonical('/', locale) },
      {
        name: 'Servizi per professioni',
        url: buildCanonical('/servizi-per-professioni', locale),
      },
      { name: heroTitle.replace(/\.$/, ''), url: canonical },
    ]),
    faqPageSchema(renderFaqs),
  ];

  return (
    <article>
      <StructuredData json={schemas} />

      <LandingHero
        eyebrow={`${service.label} · ${category.label}`}
        title={heroTitle}
        intro={renderDescription}
        tagline={content?.tagline}
        backHref={`/servizi/${service.serviceDetailSlug}`}
        backLabel={`Servizio ${service.label}`}
      />

      {combo && (
        <LandingComboAngle
          intro={combo.content.intro}
          angle={combo.content.localAngle}
          index="00"
        />
      )}

      <LandingProblems
        problems={renderProblems}
        index="01"
        heading={
          city
            ? `${profession.label} ${prep} ${city.nome}: ti riconosci?`
            : `Se sei un${profLower.endsWith('a') ? 'a' : ''} ${profLower}, ti riconosci?`
        }
      />

      <LandingFeatures
        features={renderFeatures}
        index="02"
        heading={renderHeading}
        profession={profLower}
      />

      {microStory ? (
        <LandingMicroStory
          story={microStory}
          caseStudyRef={caseStudyRef}
          index="03"
        />
      ) : null}

      <LandingFaq faqs={renderFaqs} index={microStory ? '04' : '03'} />

      <RelatedProfessions currentSlug={profession.slug} limit={5} />

      <LandingCta
        text={renderCta}
        href={`/contatti?service=${service.serviceDetailSlug}&profession=${profession.slug}${city ? `&city=${city.slug}` : ''}`}
        index={microStory ? '05' : '04'}
      />
    </article>
  );
}
