import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getCityBySlug } from '@/data/seo-cities';
import {
  SEO_SERVICES,
  getServiceByLandingSlug,
  type ServiceSlug,
} from '@/data/seo-service-matrix';
import { getServiceContent } from '@/data/seo-service-content';
import { getComboMeta } from '@/data/comune-service-content';
import { COMUNE_ATTRIBUTES, getPreposizione } from '@/lib/comune-attributes';
import { LandingHero } from '@/components/seo-landing/LandingHero';
import { LandingComboAngle } from '@/components/seo-landing/LandingComboAngle';
import { LandingProblems } from '@/components/seo-landing/LandingProblems';
import { LandingFeatures } from '@/components/seo-landing/LandingFeatures';
import { LandingFaq } from '@/components/seo-landing/LandingFaq';
import { LandingCta } from '@/components/seo-landing/LandingCta';
import { RelatedZones } from '@/components/seo-landing/RelatedZones';
import { ServiceShowcase } from '@/components/service-detail/ServiceShowcase';
import { StructuredData } from '@/components/seo/StructuredData';
import { breadcrumbSchema, faqPageSchema, serviceSchema } from '@/data/structured-data';
import { buildCanonical } from '@/lib/canonical';
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n';

interface Params {
  locale?: Locale;
  comune: string;
  service: string;
}

export function generateStaticParams(): Params[] {
  // Tier-1 comuni only × all SEO services. Tier-2 lazy on-demand via revalidate.
  const params: Params[] = [];
  for (const comune of Object.keys(COMUNE_ATTRIBUTES)) {
    const c = getCityBySlug(comune);
    if (!c || c.tier > 1) continue;
    for (const s of SEO_SERVICES) {
      params.push({ comune, service: s.slug });
    }
  }
  return params;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { comune, service, locale = DEFAULT_LOCALE } = await params;
  // zone + comune + service è IT-only (decisione 2026-05-15, in linea col blocco
  // matrix+città). I contenuti sono hardcoded IT e i target sono attività della
  // zona italiana — niente fallback EN.
  if (locale === 'en') return { title: 'Page not found' };
  const city = getCityBySlug(comune);
  const svc = getServiceByLandingSlug(service as ServiceSlug);
  if (!city || !svc) return { title: 'Combinazione non trovata' };
  const prep = getPreposizione(city.nome);
  return {
    title: `${svc.label} ${prep} ${city.nome}`,
    description: `${svc.label} a ${city.nome}. Progettazione, sviluppo, SEO locale per professionisti e attività della zona.`,
    alternates: { canonical: buildCanonical(`/zone/${comune}/${service}`, locale) },
    robots: city.tier === 1 ? { index: true, follow: true } : { index: false, follow: false },
  };
}

export default async function ZonaComuneServicePage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { comune, service, locale = DEFAULT_LOCALE } = await params;
  // EN guard — vedi nota in generateMetadata.
  if (locale === 'en') notFound();
  const city = getCityBySlug(comune);
  const svc = getServiceByLandingSlug(service as ServiceSlug);
  if (!city || !svc) notFound();

  const attrs = COMUNE_ATTRIBUTES[comune];
  if (!attrs) notFound();

  const combo = getComboMeta(comune, svc.slug);
  const content = getServiceContent(svc.slug, '_default');

  const prep = getPreposizione(city.nome);
  const canonical = buildCanonical(`/zone/${city.slug}/${svc.slug}`, locale);
  const schemas = [
    serviceSchema({
      slug: svc.serviceDetailSlug,
      name: `${svc.label} ${prep} ${city.nome}`,
      description:
        content?.description ??
        `${svc.label} a ${city.nome}. Progettazione, sviluppo e SEO locale per chi lavora qui.`,
      url: canonical,
      serviceType: svc.label,
      comune: city.nome,
    }),
    breadcrumbSchema([
      { name: 'Home', url: buildCanonical('/', locale) },
      { name: 'Zone', url: buildCanonical('/zone', locale) },
      { name: city.nome, url: buildCanonical(`/zone/${city.slug}`, locale) },
      { name: svc.label, url: canonical },
    ]),
    ...(content?.faqs?.length ? [faqPageSchema(content.faqs)] : []),
  ];

  return (
    <article>
      <StructuredData json={schemas} />

      <LandingHero
        eyebrow={`${svc.label} · ${city.nome}`}
        title={`${svc.label} ${prep} ${city.nome}.`}
        intro={
          content?.description ??
          `${svc.label} a ${city.nome}. Progettazione, sviluppo, SEO locale per chi lavora qui.`
        }
        backHref={`/zone/${comune}`}
        backLabel={`Tutti i servizi ${prep} ${city.nome}`}
      />

      <LandingComboAngle intro={combo.content.intro} angle={combo.content.localAngle} index="00" />

      {content && (
        <>
          <LandingProblems problems={content.problems} index="01" />
          <LandingFeatures
            features={content.features}
            index="02"
            heading={content.solutionTitle}
          />
          <ServiceShowcase
            serviceSlug={svc.serviceDetailSlug}
            limit={3}
            index="03"
            heading={`Lavori ${svc.label.toLowerCase()} ${prep} territorio.`}
          />
          <RelatedZones currentSlug={city.slug} serviceSlug={svc.serviceDetailSlug} limit={4} />
          <LandingFaq faqs={content.faqs} index="04" />
          <LandingCta
            text={content.ctaText}
            href={`/contatti?service=${svc.serviceDetailSlug}&city=${city.slug}`}
            index="05"
          />
        </>
      )}
      {!content && (
        <LandingCta
          text={`Vuoi parlare di ${svc.label.toLowerCase()} ${prep} ${city.nome}?`}
          href={`/contatti?service=${svc.serviceDetailSlug}&city=${city.slug}`}
          index="01"
        />
      )}
    </article>
  );
}
