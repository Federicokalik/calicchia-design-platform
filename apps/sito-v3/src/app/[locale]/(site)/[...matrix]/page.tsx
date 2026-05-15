import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import {
  parseServiceUrl,
  isProfessionValidForService,
  getAllSeoServicesLocalized,
  getServiceUrlPrefix,
  getProfessionSlugForLocale,
  type SeoService,
} from '@/data/seo-service-matrix';
import {
  getProfessionBySlug,
  getCategoryForProfessionLocalized,
  getProfessionContentLocalized,
  getProfessionLabel,
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
import { buildCanonical, buildOgLocale } from '@/lib/canonical';
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n';
import { SITE } from '@/data/site';

const SITE_URL = SITE.url.replace(/\/$/, '');

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
 *   1. parseServiceUrl → { service, remainder, locale } (auto-detects IT/EN prefix)
 *   2. Try the whole remainder as a profession slug. If matches AND valid for the service → no city.
 *   3. Otherwise iteratively split on "-a-" (right-to-left) to handle hyphenated city slugs.
 *   4. Validate that the profession is in the service whitelist.
 *   5. **Block city on EN**: matrix + città è IT-only (decisione 2026-05-15). Se l'URL
 *      è prefisso EN ("website-for-...") o il route locale è EN E parsiamo una città →
 *      return null (notFound).
 *
 * Returns null if no valid combination is found.
 */
function parseMatrix(segment: string, routeLocale: Locale): ParsedMatrix | null {
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
      // Block matrix+city su EN locale (sia URL EN-prefixed che locale EN su URL IT).
      if (routeLocale === 'en' || head.locale === 'en') return null;
      return { service, profession: prof, city };
    }
  }

  return null;
}

/**
 * Costruisce l'URL canonical della matrix per un dato locale.
 * - IT: /<urlPrefix-IT>-<profSlug-IT>[-a-<citySlug>]
 * - EN: /en/<urlPrefix-EN>-<profSlug-EN> (no city — bloccata su EN)
 */
function buildMatrixCanonicalUrl(
  service: SeoService,
  profession: SeoProfession,
  city: SeoCity | null,
  locale: Locale,
): string {
  const prefix = getServiceUrlPrefix(service, locale);
  const profSlug = getProfessionSlugForLocale(profession.slug, locale);
  const slug = city && locale === 'it' ? `${profSlug}-a-${city.slug}` : profSlug;
  return locale === 'en'
    ? `${SITE_URL}/en/${prefix}-${slug}`
    : `${SITE_URL}/${prefix}-${slug}`;
}

/**
 * Helper: la versione localizzata di un service (label EN su EN locale).
 */
function getLocalizedService(service: SeoService, locale: Locale): SeoService {
  if (locale === 'it') return service;
  const all = getAllSeoServicesLocalized(locale);
  return all.find((s) => s.slug === service.slug) ?? service;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { matrix, locale = DEFAULT_LOCALE } = await params;
  if (matrix.length !== 1) {
    return { title: locale === 'en' ? 'Page not found' : 'Pagina non trovata' };
  }
  const parsed = parseMatrix(matrix[0], locale);
  if (!parsed) {
    return { title: locale === 'en' ? 'Page not found' : 'Pagina non trovata' };
  }
  const { service, profession, city } = parsed;
  const localizedService = getLocalizedService(service, locale);
  const profLabel = getProfessionLabel(profession, locale);
  const profLower = profLabel.toLowerCase();

  const title = locale === 'en'
    ? `${localizedService.label} for ${profLower}`
    : (city
        ? `${localizedService.label} per ${profLower} ${getPreposizione(city.nome)} ${city.nome}`
        : `${localizedService.label} per ${profLower}`);

  const fallbackDescription = locale === 'en'
    ? `${localizedService.label} for ${profLower}. Design, development, SEO across Italy and abroad.`
    : `${localizedService.label} per ${profLower}. Progettazione, sviluppo, SEO ${city ? `nella zona di ${city.nome}` : 'in tutta Italia'}.`;

  const description =
    getProfessionContentLocalized(profession.slug, locale)?.tagline ?? fallbackDescription;

  // Tier-based indexing.
  const indexable = profession.tier <= 2 && (!city || city.tier <= 2);
  const ogImageUrl = `/api/og/matrix/${encodeURIComponent(matrix[0])}?locale=${locale}`;

  // Canonical + hreflang alternates. Matrix con città è IT-only quindi niente
  // EN alternate; matrix profession-only emette entrambi gli alternates.
  const canonical = buildMatrixCanonicalUrl(service, profession, city, locale);
  const alternates: Metadata['alternates'] = city
    ? { canonical }
    : {
        canonical,
        languages: {
          it: buildMatrixCanonicalUrl(service, profession, null, 'it'),
          en: buildMatrixCanonicalUrl(service, profession, null, 'en'),
          'x-default': buildMatrixCanonicalUrl(service, profession, null, 'it'),
        },
      };

  return {
    title,
    description,
    alternates,
    robots: indexable
      ? { index: true, follow: true }
      : { index: false, follow: true },
    openGraph: {
      title,
      description,
      url: canonical,
      type: 'article',
      images: [{ url: ogImageUrl, width: 1200, height: 630 }],
      ...buildOgLocale(locale),
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

  const parsed = parseMatrix(matrix[0], locale);
  if (!parsed) notFound();

  const { service, profession, city } = parsed;
  const localizedService = getLocalizedService(service, locale);
  const category = getCategoryForProfessionLocalized(profession, locale);
  const content = getProfessionContentLocalized(profession.slug, locale);

  const profLabel = getProfessionLabel(profession, locale);
  const profLower = profLabel.toLowerCase();
  const prep = city ? getPreposizione(city.nome) : null;

  // Hero title varies by combo + locale.
  const heroTitle = locale === 'en'
    ? `${localizedService.label} for ${profLower}.`
    : (city
        ? `${localizedService.label} per ${profLower} ${prep} ${city.nome}.`
        : `${localizedService.label} per ${profLower}.`);

  // Service-specific content (problems/features/faqs) per category.
  // For "sito-web" the legacy uses the profession-category content for problems/features,
  // but we still pull microStory + caseStudyRef from the seo-content/web-design.ts file.
  const fullServiceContent = getServiceContent(service.slug, profession.categoryId, locale);
  const serviceCategoryContent =
    service.slug === 'sito-web' ? null : fullServiceContent;
  const microStory = fullServiceContent?.microStory;
  const caseStudyRef = fullServiceContent?.caseStudyRef;

  const renderProblems = serviceCategoryContent?.problems ?? category.problems;
  const renderFeatures = serviceCategoryContent?.features ?? category.features;
  const renderFaqs = serviceCategoryContent?.faqs ?? category.faqs;
  const renderCta = serviceCategoryContent?.ctaText ?? category.ctaText;
  const renderHeading = serviceCategoryContent?.solutionTitle;
  const renderDescription =
    serviceCategoryContent?.description ?? category.description;

  // Combo angle (deterministic per comune × service) — only when city is present
  // AND city is in the COMUNE_ATTRIBUTES set. Solo su IT (city blocked su EN).
  const showComboAngle = city && !!COMUNE_ATTRIBUTES[city.slug] && locale === 'it';
  const combo = showComboAngle && city ? getComboMeta(city.slug, service.slug) : null;
  const canonical = buildMatrixCanonicalUrl(service, profession, city, locale);

  const breadcrumbHomeLabel = locale === 'en' ? 'Home' : 'Home';
  const breadcrumbServicesLabel =
    locale === 'en' ? 'Services by profession' : 'Servizi per professioni';
  const breadcrumbServicesUrl = locale === 'en'
    ? buildCanonical('/servizi-per-professioni', 'it') // IT-only page
    : buildCanonical('/servizi-per-professioni', locale);

  const schemas = [
    serviceSchema({
      slug: service.serviceDetailSlug,
      name: heroTitle.replace(/\.$/, ''),
      description: renderDescription,
      url: canonical,
      serviceType: localizedService.label,
      profession: profLabel,
      comune: city?.nome,
      locale,
    }),
    breadcrumbSchema([
      { name: breadcrumbHomeLabel, url: buildCanonical('/', locale) },
      {
        name: breadcrumbServicesLabel,
        url: breadcrumbServicesUrl,
      },
      { name: heroTitle.replace(/\.$/, ''), url: canonical },
    ]),
    faqPageSchema(renderFaqs),
  ];

  // Problems heading: gender-aware in IT ("Se sei una/un X"), simpler in EN.
  const problemsHeading = locale === 'en'
    ? `If you're ${profLower.startsWith('a') || profLower.startsWith('e') || profLower.startsWith('i') || profLower.startsWith('o') || profLower.startsWith('u') ? 'an' : 'a'} ${profLower.replace(/s$/, '')}, sound familiar?`
    : (city
        ? `${profLabel} ${prep} ${city.nome}: ti riconosci?`
        : `Se sei un${profLower.endsWith('a') ? 'a' : ''} ${profLower}, ti riconosci?`);

  const backLabel = locale === 'en'
    ? `${localizedService.label} service`
    : `Servizio ${localizedService.label}`;

  return (
    <article>
      <StructuredData json={schemas} />

      <LandingHero
        eyebrow={`${localizedService.label} · ${category.label}`}
        title={heroTitle}
        intro={renderDescription}
        tagline={content?.tagline}
        backHref={`/servizi/${service.serviceDetailSlug}`}
        backLabel={backLabel}
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
        heading={problemsHeading}
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
