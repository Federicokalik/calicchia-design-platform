import type {
  ServiceDeliverable,
  ServiceLeadMagnetCopy,
  ServiceRelated,
} from '../../services-detail';

export const SEO_EXTRAS_EN = {
  deliverables: [
    { title: 'Technical SEO audit', format: 'PDF report', timeline: 'week 1' },
    { title: 'Crawl error map', format: 'CSV + .md', timeline: 'week 1' },
    { title: 'Revised XML sitemap', format: 'XML', timeline: 'week 1-2' },
    { title: 'Base schema markup', format: 'JSON-LD', timeline: 'week 2' },
    { title: 'Local keyword research', format: '.xlsx', timeline: 'week 2' },
    { title: 'Content gap analysis', format: '.xlsx + .md', timeline: 'week 2-3' },
    { title: 'Priority pages plan', format: '.md', timeline: 'week 3' },
    { title: 'GSC and GA4 setup', format: 'Console config', timeline: 'week 3' },
    { title: 'Link building shortlist', format: '.xlsx', timeline: 'ongoing' },
    { title: 'Readable monthly report', format: 'PDF + dashboard', timeline: 'monthly' },
  ] satisfies readonly ServiceDeliverable[],
  related: [
    {
      slug: 'web-design',
      title: 'Web Design',
      shortPitch:
        "If the site structure is confused, SEO works with weight strapped to it.",
    },
    {
      slug: 'sviluppo-web',
      title: 'Web Development',
      shortPitch:
        "Performance, markup and dirty routing are SEO problems before aesthetic ones.",
    },
    {
      slug: 'analytics-setup',
      title: 'Analytics & Tag Manager',
      shortPitch:
        "Without GA4 + GTM properly configured, every SEO decision is blind.",
    },
  ] satisfies readonly ServiceRelated[],
  leadMagnetCopy: {
    eyebrow: 'Free audit · 15 minutes',
    title: 'Want to see where Google is penalizing you?',
    body:
      "I look at indexing, queries, weak pages and Google Business. 15 minutes on Meet, no first-page promises.",
  } satisfies ServiceLeadMagnetCopy,
} as const;
