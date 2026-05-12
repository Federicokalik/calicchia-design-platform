/**
 * Helpers tipizzati per generare JSON-LD schema.org safe-by-construction.
 * Single source of truth per Person/Organization/LocalBusiness in modo
 * che i `@id` rimangano stabili e i riferimenti incrociati funzionino.
 *
 * Pattern: ogni helper torna un oggetto plain JSON. Lo wrappiamo in
 * `<StructuredData json={...}/>` (vedi components/seo/StructuredData.tsx).
 */

import { SITE } from './site';

const PERSON_ID = `${SITE.url}/#federico`;
const BUSINESS_ID = `${SITE.url}/#business`;
const WEBSITE_ID = `${SITE.url}/#website`;

type AreaServedInput = string | string[];

function normalizeAreaServed(area?: AreaServedInput) {
  if (!area) return { '@type': 'Country', name: 'Italy' };
  const entries = Array.isArray(area) ? area : [area];
  return entries.map((name) => ({ '@type': 'City', name }));
}

/* ------------------------------------------------------------------ */
/* Person — Federico Calicchia                                         */
/* ------------------------------------------------------------------ */
export function personSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Person',
    '@id': PERSON_ID,
    name: 'Federico Calicchia',
    alternateName: 'Calicchia Design',
    url: SITE.url,
    image: `${SITE.url}/img/federico-calicchia-ritratto-web-designer.webp`,
    jobTitle: 'Web Designer & Developer Freelance',
    description:
      'Web Designer & Developer Freelance.\nFaccio siti, e-commerce, sviluppo web, SEO, manutenzione e assistenza WordPress per professionisti e PMI.\nUn solo contatto, design + codice + SEO in casa.',
    worksFor: { '@id': BUSINESS_ID },
    sameAs: [
      'https://instagram.com/calicchia.design',
      'https://linkedin.com/in/federicocalicchia',
      'https://github.com/calicchiadesign'
    ],
    knowsAbout: [
      'Web Design',
      'Web Development',
      'E-Commerce',
      'SEO',
      'WordPress',
      'Manutenzione siti',
      'Assistenza WordPress',
      'Brand Identity',
      'Performance Web',
      'Next.js',
      'React'
    ],
    address: {
      '@type': 'PostalAddress',
      streetAddress: 'Via Scifelli 74',
      addressLocality: SITE.geo.city,
      addressRegion: SITE.geo.region,
      postalCode: SITE.geo.postalCode,
      addressCountry: SITE.geo.country
    }
  } as const;
}

/* ------------------------------------------------------------------ */
/* LocalBusiness / ProfessionalService                                 */
/* ------------------------------------------------------------------ */
export interface LocalBusinessArgs {
  comune?: string;
  areaServed?: string[];
}

export function localBusinessSchema(args: LocalBusinessArgs = {}) {
  const areaServed =
    args.areaServed && args.areaServed.length > 0
      ? args.areaServed
      : args.comune
        ? [args.comune]
        : undefined;

  return {
    '@context': 'https://schema.org',
    '@type': 'ProfessionalService',
    '@id': BUSINESS_ID,
    name: SITE.legalName,
    alternateName: SITE.brand,
    url: SITE.url,
    image: `${SITE.url}/img/federico-calicchia-ritratto-web-designer.webp`,
    description: SITE.description,
    founder: { '@id': PERSON_ID },
    provider: { '@id': PERSON_ID },
    telephone: SITE.contact.phone,
    email: SITE.contact.email,
    address: {
      '@type': 'PostalAddress',
      streetAddress: 'Via Scifelli 74',
      addressLocality: SITE.geo.city,
      addressRegion: SITE.geo.region,
      postalCode: SITE.geo.postalCode,
      addressCountry: SITE.geo.country
    },
    geo: {
      '@type': 'GeoCoordinates',
      latitude: SITE.geo.lat,
      longitude: SITE.geo.lng
    },
    areaServed: areaServed
      ? normalizeAreaServed(areaServed)
      : [
          { '@type': 'Country', name: 'Italy' },
          { '@type': 'AdministrativeArea', name: SITE.geo.region },
          { '@type': 'City', name: SITE.geo.city }
        ],
    sameAs: [
      'https://instagram.com/calicchia.design',
      'https://linkedin.com/in/federicocalicchia'
    ],
    hasOfferCatalog: {
      '@type': 'OfferCatalog',
      name: 'Servizi web',
      itemListElement: [
        { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Web Design' } },
        { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'E-Commerce' } },
        { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Sviluppo Web' } },
        { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'SEO' } },
        { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Branding' } }
      ]
    }
  } as const;
}

/* ------------------------------------------------------------------ */
/* WebSite + SearchAction (sitelinks searchbox eligibility)            */
/* ------------------------------------------------------------------ */
export function websiteSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': WEBSITE_ID,
    url: SITE.url,
    name: SITE.brand,
    description: SITE.description,
    publisher: { '@id': BUSINESS_ID },
    inLanguage: 'it-IT'
  } as const;
}

/* ------------------------------------------------------------------ */
/* BreadcrumbList                                                      */
/* ------------------------------------------------------------------ */
export interface BreadcrumbItem {
  name: string;
  url: string;
}

export function breadcrumbSchema(items: BreadcrumbItem[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: item.url.startsWith('http') ? item.url : `${SITE.url}${item.url}`
    }))
  } as const;
}

/* ------------------------------------------------------------------ */
/* FAQPage                                                             */
/* ------------------------------------------------------------------ */
export interface FaqEntry {
  question: string;
  answer: string;
}

export function faqPageSchema(faqs: FaqEntry[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((faq) => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: { '@type': 'Answer', text: faq.answer }
    }))
  } as const;
}

/* ------------------------------------------------------------------ */
/* Article (blog, pillar, cluster)                                     */
/* ------------------------------------------------------------------ */
export interface ArticleArgs {
  title: string;
  description: string;
  url: string;
  image?: string;
  datePublished?: string; // ISO
  dateModified?: string; // ISO
  section?: string;
}

export function articleSchema(args: ArticleArgs) {
  const url = args.url.startsWith('http') ? args.url : `${SITE.url}${args.url}`;
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: args.title,
    description: args.description,
    image: args.image
      ? args.image.startsWith('http')
        ? args.image
        : `${SITE.url}${args.image}`
      : `${SITE.url}/img/federico-calicchia-ritratto-web-designer.webp`,
    author: { '@id': PERSON_ID },
    publisher: { '@id': BUSINESS_ID },
    datePublished: args.datePublished,
    dateModified: args.dateModified ?? args.datePublished,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    articleSection: args.section,
    inLanguage: 'it-IT'
  } as const;
}

/* ------------------------------------------------------------------ */
/* Service (per servizi/[slug])                                        */
/* ------------------------------------------------------------------ */
export interface ServiceArgs {
  name: string;
  description: string;
  url?: string;
  slug?: string;
  serviceType?: string;
  profession?: string;
  comune?: string;
  areaServed?: AreaServedInput;
}

export function serviceSchema(args: ServiceArgs) {
  const url = args.url
    ? args.url.startsWith('http')
      ? args.url
      : `${SITE.url}${args.url}`
    : args.slug
      ? `${SITE.url}/servizi/${args.slug}`
      : SITE.url;
  const areaServed = args.areaServed ?? args.comune;

  return {
    '@context': 'https://schema.org',
    '@type': 'Service',
    '@id': `${url}#service`,
    name: args.name,
    description: args.description,
    url,
    serviceType: args.serviceType ?? args.name,
    provider: { '@id': BUSINESS_ID },
    areaServed: normalizeAreaServed(areaServed),
    ...(args.profession
      ? {
          audience: {
            '@type': 'Audience',
            audienceType: args.profession
          }
        }
      : {})
  };
}

/* ------------------------------------------------------------------ */
/* CollectionPage                                                      */
/* ------------------------------------------------------------------ */
export interface CollectionPageArgs {
  name: string;
  description: string;
  url: string;
  items?: Array<{ name: string; url: string }>;
}

export function collectionPageSchema(args: CollectionPageArgs) {
  const url = args.url.startsWith('http') ? args.url : `${SITE.url}${args.url}`;
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    '@id': `${url}#collection`,
    name: args.name,
    description: args.description,
    url,
    isPartOf: { '@id': WEBSITE_ID },
    publisher: { '@id': BUSINESS_ID },
    ...(args.items && args.items.length > 0
      ? {
          mainEntity: {
            '@type': 'ItemList',
            itemListElement: args.items.map((item, i) => ({
              '@type': 'ListItem',
              position: i + 1,
              name: item.name,
              url: item.url.startsWith('http') ? item.url : `${SITE.url}${item.url}`
            }))
          }
        }
      : {})
  };
}

/* ------------------------------------------------------------------ */
/* ItemList con DefinedTerm (glossario)                                */
/* ------------------------------------------------------------------ */
export interface DefinedTermArgs {
  name: string;
  description: string;
  /** URL slug fragment (e.g., "lcp") used as #anchor */
  slug: string;
}

export function definedTermListSchema(
  terms: DefinedTermArgs[],
  pageUrl: string
) {
  const url = pageUrl.startsWith('http') ? pageUrl : `${SITE.url}${pageUrl}`;
  return {
    '@context': 'https://schema.org',
    '@type': 'DefinedTermSet',
    '@id': `${url}#glossary`,
    name: 'Glossario Web Design',
    inDefinedTermSet: url,
    hasDefinedTerm: terms.map((t) => ({
      '@type': 'DefinedTerm',
      name: t.name,
      description: t.description,
      url: `${url}#${t.slug}`,
      inDefinedTermSet: `${url}#glossary`
    }))
  } as const;
}
