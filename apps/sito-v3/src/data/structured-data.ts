/**
 * Helpers tipizzati per generare JSON-LD schema.org safe-by-construction.
 * Single source of truth per Person/Organization/LocalBusiness in modo
 * che i `@id` rimangano stabili e i riferimenti incrociati funzionino.
 *
 * Pattern: ogni helper torna un oggetto plain JSON. Lo wrappiamo in
 * `<StructuredData json={...}/>` (vedi components/seo/StructuredData.tsx).
 *
 * Locale awareness: helper accettano `locale` opzionale (default 'it'). Setta
 * `inLanguage` BCP-47 (it-IT / en-US) e seleziona descrizioni/knowsAbout
 * tradotti dalle costanti sottostanti. Per caso d'uso bilingual, callers
 * passano locale corrente da `getLocale()` / `useLocale()`.
 */

import { SITE } from './site';
import type { Locale } from '@/lib/i18n';

const PERSON_ID = `${SITE.url}/#federico`;
const BUSINESS_ID = `${SITE.url}/#business`;
const WEBSITE_ID = `${SITE.url}/#website`;

function bcp47(locale: Locale): string {
  return locale === 'en' ? 'en-US' : 'it-IT';
}

const PERSON_DESCRIPTION: Record<Locale, string> = {
  it: 'Web Designer & Developer Freelance.\nFaccio siti, e-commerce, sviluppo web, SEO, manutenzione e assistenza WordPress per professionisti e PMI.\nUn solo contatto, design + codice + SEO in casa.',
  en: 'Freelance Web Designer & Developer.\nI build websites, e-commerce, web development, SEO, WordPress maintenance and support for professionals and SMBs.\nOne point of contact, design + code + SEO in-house.',
};

const PERSON_JOB_TITLE: Record<Locale, string> = {
  it: 'Web Designer & Developer Freelance',
  en: 'Freelance Web Designer & Developer',
};

const PERSON_KNOWS_ABOUT: Record<Locale, readonly string[]> = {
  it: [
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
    'React',
  ],
  en: [
    'Web Design',
    'Web Development',
    'E-Commerce',
    'SEO',
    'WordPress',
    'Website maintenance',
    'WordPress support',
    'Brand Identity',
    'Web Performance',
    'Next.js',
    'React',
  ],
};

const SERVICE_CATALOG_NAME: Record<Locale, string> = {
  it: 'Servizi web',
  en: 'Web services',
};

const SERVICE_CATALOG_ITEMS: Record<Locale, readonly string[]> = {
  it: ['Web Design', 'E-Commerce', 'Sviluppo Web', 'SEO', 'Branding'],
  en: ['Web Design', 'E-Commerce', 'Web Development', 'SEO', 'Branding'],
};

type AreaServedInput = string | string[];

function normalizeAreaServed(area?: AreaServedInput) {
  if (!area) return { '@type': 'Country', name: 'Italy' };
  const entries = Array.isArray(area) ? area : [area];
  return entries.map((name) => ({ '@type': 'City', name }));
}

/* ------------------------------------------------------------------ */
/* Person — Federico Calicchia                                         */
/* ------------------------------------------------------------------ */
export function personSchema(locale: Locale = 'it') {
  return {
    '@context': 'https://schema.org',
    '@type': 'Person',
    '@id': PERSON_ID,
    name: 'Federico Calicchia',
    alternateName: 'Calicchia Design',
    url: SITE.url,
    image: `${SITE.url}/img/federico-calicchia-ritratto-web-designer.webp`,
    jobTitle: PERSON_JOB_TITLE[locale],
    description: PERSON_DESCRIPTION[locale],
    worksFor: { '@id': BUSINESS_ID },
    sameAs: [
      'https://instagram.com/calicchia.design',
      'https://linkedin.com/in/federicocalicchia',
      'https://github.com/calicchiadesign'
    ],
    knowsAbout: PERSON_KNOWS_ABOUT[locale],
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
  locale?: Locale;
  /**
   * Catalogo servizi dinamico dal CMS. Quando passato, popola
   * `hasOfferCatalog` con un Offer per ciascun servizio, con `Service` come
   * itemOffered e URL canonico → dà a Google materiale ricco per i sitelinks
   * della sezione "Servizi". Se omesso, ricade sulla lista hardcoded
   * `SERVICE_CATALOG_ITEMS` (default safe per pagine senza accesso al CMS).
   */
  services?: ReadonlyArray<{ slug: string; title: string; lead?: string }>;
}

export function localBusinessSchema(args: LocalBusinessArgs = {}) {
  const locale = args.locale ?? 'it';
  const areaServed =
    args.areaServed && args.areaServed.length > 0
      ? args.areaServed
      : args.comune
        ? [args.comune]
        : undefined;
  const servicesSegment = locale === 'en' ? 'services' : 'servizi';
  const localePrefix = locale === 'en' ? '/en' : '';
  const dynamicCatalog =
    args.services && args.services.length > 0
      ? args.services.map((svc) => ({
          '@type': 'Offer' as const,
          itemOffered: {
            '@type': 'Service' as const,
            name: svc.title,
            ...(svc.lead ? { description: svc.lead } : {}),
            url: `${SITE.url}${localePrefix}/${servicesSegment}/${svc.slug}`,
            provider: { '@id': BUSINESS_ID },
          },
        }))
      : SERVICE_CATALOG_ITEMS[locale].map((name) => ({
          '@type': 'Offer' as const,
          itemOffered: { '@type': 'Service' as const, name },
        }));

  return {
    '@context': 'https://schema.org',
    '@type': 'ProfessionalService',
    '@id': BUSINESS_ID,
    name: SITE.legalName,
    alternateName: SITE.brand,
    url: SITE.url,
    image: `${SITE.url}/img/federico-calicchia-ritratto-web-designer.webp`,
    // Brand mark (the `~` tilde on dark) as the Organization logo. This is the
    // Google-recognized logo source (knowledge panel / SERP), unlike the
    // non-standard og:logo meta. ImageObject so Google has explicit dimensions.
    logo: {
      '@type': 'ImageObject',
      url: `${SITE.url}/img/favicon/apple-touch-icon.png`,
      width: 180,
      height: 180,
    },
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
      name: SERVICE_CATALOG_NAME[locale],
      itemListElement: dynamicCatalog,
    },
    inLanguage: bcp47(locale),
  };
}

/* ------------------------------------------------------------------ */
/* WebSite + SearchAction (sitelinks searchbox eligibility)            */
/* ------------------------------------------------------------------ */
export function websiteSchema(locale: Locale = 'it') {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': WEBSITE_ID,
    url: SITE.url,
    name: SITE.brand,
    alternateName: SITE.legalName,
    description: SITE.description,
    publisher: { '@id': BUSINESS_ID },
    inLanguage: bcp47(locale),
  } as const;
}

/* ------------------------------------------------------------------ */
/* SiteNavigationElement — aiuta Google a costruire i sitelinks       */
/* ------------------------------------------------------------------ */
const NAV_ITEMS: Record<Locale, ReadonlyArray<{ name: string; path: string; description: string }>> = {
  it: [
    { name: 'Home', path: '/', description: 'Federico Calicchia — Web Designer & Developer Freelance' },
    { name: 'Portfolio', path: '/lavori', description: 'Case study e lavori di web design, sviluppo e SEO' },
    { name: 'Servizi', path: '/servizi', description: 'Web design, sviluppo, e-commerce, SEO, accessibilità, WordPress' },
    { name: 'Perché scegliermi', path: '/perche-scegliere-me', description: 'Approccio, metodo di lavoro, garanzie' },
    { name: 'Blog', path: '/blog', description: 'Approfondimenti su web design, SEO, accessibilità' },
    { name: 'Contatti', path: '/contatti', description: 'Email, telefono, prenota una consulenza gratuita' },
  ],
  en: [
    { name: 'Home', path: '/en', description: 'Federico Calicchia — Freelance Web Designer & Developer' },
    { name: 'Portfolio', path: '/en/works', description: 'Case studies and work in web design, development, SEO' },
    { name: 'Services', path: '/en/services', description: 'Web design, development, e-commerce, SEO, accessibility, WordPress' },
    { name: 'Why choose me', path: '/en/why-choose-me', description: 'Approach, working method, guarantees' },
    { name: 'Blog', path: '/en/blog', description: 'Insights on web design, SEO, accessibility' },
    { name: 'Contact', path: '/en/contact', description: 'Email, phone, book a free consultation' },
  ],
} as const;

export function siteNavigationSchema(locale: Locale = 'it') {
  const items = NAV_ITEMS[locale];
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    '@id': `${SITE.url}/#nav-${locale}`,
    name: locale === 'en' ? 'Main navigation' : 'Navigazione principale',
    itemListOrder: 'https://schema.org/ItemListOrderAscending',
    numberOfItems: items.length,
    itemListElement: items.map((item, i) => ({
      '@type': 'SiteNavigationElement',
      position: i + 1,
      name: item.name,
      description: item.description,
      url: `${SITE.url}${item.path}`,
    })),
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
  locale?: Locale;
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
    inLanguage: bcp47(args.locale ?? 'it'),
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
  locale?: Locale;
}

export function serviceSchema(args: ServiceArgs) {
  const locale = args.locale ?? 'it';
  const segment = locale === 'en' ? 'services' : 'servizi';
  const url = args.url
    ? args.url.startsWith('http')
      ? args.url
      : `${SITE.url}${args.url}`
    : args.slug
      ? `${SITE.url}${locale === 'en' ? '/en' : ''}/${segment}/${args.slug}`
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
    inLanguage: bcp47(locale),
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
  locale?: Locale;
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
    inLanguage: bcp47(args.locale ?? 'it'),
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
