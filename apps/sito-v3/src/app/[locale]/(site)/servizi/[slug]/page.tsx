import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { SERVICES_DETAIL, getServiceDetail } from '@/data/services-detail';
import { ServiceHero } from '@/components/service-detail/ServiceHero';
import { ServiceAwareness } from '@/components/service-detail/ServiceAwareness';
import { ServiceFeatures } from '@/components/service-detail/ServiceFeatures';
import { ServiceProcess } from '@/components/service-detail/ServiceProcess';
import { ServiceFaq } from '@/components/service-detail/ServiceFaq';
import { ServiceCta } from '@/components/service-detail/ServiceCta';
import { ServiceCrossLinking } from '@/components/service-detail/ServiceCrossLinking';
import { ServiceDeliverables } from '@/components/service-detail/ServiceDeliverables';
import { ServiceExpandedScope } from '@/components/service-detail/ServiceExpandedScope';
import { ServiceLeadMagnet } from '@/components/service-detail/ServiceLeadMagnet';
import { ServiceShowcase } from '@/components/service-detail/ServiceShowcase';
import { StructuredData } from '@/components/seo/StructuredData';
import { breadcrumbSchema, faqPageSchema, serviceSchema } from '@/data/structured-data';
import { buildCanonical, buildI18nAlternates, buildOgLocale } from '@/lib/canonical';
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n';
import { serviceOfferCatalogSchema } from '@/lib/seo/service-schemas';

interface Params {
  locale?: Locale;
  slug: string;
}

export function generateStaticParams(): Params[] {
  return SERVICES_DETAIL.map((s) => ({ slug: s.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug, locale = DEFAULT_LOCALE } = await params;
  const svc = getServiceDetail(slug, locale === 'en' ? 'en' : 'it');
  if (!svc) return { title: 'Servizio non trovato' };
  return {
    title: svc.title,
    description: svc.description,
    alternates: buildI18nAlternates(`/servizi/${slug}`, locale),
    openGraph: {
      title: `${svc.title} — Caldes`,
      description: svc.description,
      type: 'article',
      url: buildCanonical(`/servizi/${slug}`, locale),
      ...buildOgLocale(locale),
    },
  };
}

export default async function ServiceDetailPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { slug, locale = DEFAULT_LOCALE } = await params;
  const svc = getServiceDetail(slug, locale === 'en' ? 'en' : 'it');
  if (!svc) notFound();
  const canonical = buildCanonical(`/servizi/${svc.slug}`, locale);
  const deliverables = svc.deliverables ?? [];
  const hasDeliverables = deliverables.length > 0;
  const related = svc.related ?? [];
  const hasRelated = related.length > 0;
  const hasLeadMagnet = Boolean(svc.leadMagnetCopy);
  const formatIndex = (value: number) => String(value).padStart(2, '0');
  const expandedIndex = 4;
  const deliverablesIndex = expandedIndex + (svc.expandedScope ? 1 : 0);
  const showcaseIndex = deliverablesIndex + (hasDeliverables ? 1 : 0);
  const relatedIndex = showcaseIndex + 1;
  const leadMagnetIndex = relatedIndex + (hasRelated ? 1 : 0);
  const faqIndex = leadMagnetIndex + (hasLeadMagnet ? 1 : 0);
  const ctaIndex = faqIndex + 1;

  return (
    <article>
      <StructuredData
        json={[
          serviceSchema({
            slug: svc.slug,
            name: svc.title,
            description: svc.description,
            url: canonical,
            serviceType: svc.title,
            locale,
          }),
          ...(hasDeliverables ? [serviceOfferCatalogSchema(deliverables)] : []),
          faqPageSchema(svc.faqs),
          breadcrumbSchema([
            { name: 'Home', url: buildCanonical('/', locale) },
            { name: 'Servizi', url: buildCanonical('/servizi', locale) },
            { name: svc.title, url: canonical },
          ]),
        ]}
      />

      <ServiceHero
        eyebrow={`Servizio · ${svc.title}`}
        title={svc.title}
        longDescription={svc.longDescription}
        slug={svc.slug}
      />
      <ServiceAwareness data={svc.awareness} index="01" />
      <ServiceFeatures features={svc.features} index="02" />
      <ServiceProcess steps={svc.process} index="03" />
      {svc.expandedScope && (
        <ServiceExpandedScope scope={svc.expandedScope} index={formatIndex(expandedIndex)} />
      )}
      {hasDeliverables && (
        <ServiceDeliverables
          deliverables={deliverables}
          index={formatIndex(deliverablesIndex)}
        />
      )}
      <ServiceShowcase
        serviceSlug={svc.slug}
        index={formatIndex(showcaseIndex)}
        heading={`Lavori in ${svc.title.toLowerCase()}.`}
      />
      {hasRelated && (
        <ServiceCrossLinking related={related} index={formatIndex(relatedIndex)} />
      )}
      {svc.leadMagnetCopy && (
        <ServiceLeadMagnet
          serviceSlug={svc.slug}
          {...svc.leadMagnetCopy}
          index={formatIndex(leadMagnetIndex)}
        />
      )}
      <ServiceFaq faqs={svc.faqs} index={formatIndex(faqIndex)} />
      <ServiceCta
        serviceTitle={svc.title}
        serviceSlug={svc.slug}
        index={formatIndex(ctaIndex)}
      />
    </article>
  );
}
