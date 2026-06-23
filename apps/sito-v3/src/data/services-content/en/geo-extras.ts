import type { ServiceDeliverable, ServiceLeadMagnetCopy, ServiceRelated } from '../../services-detail';

export const GEO_EXTRAS_EN = {
  deliverables: [
    { title: 'Technical GEO Audit', format: 'PDF report + JSON', timeline: 'week 1' },
    { title: 'Bot access map', format: 'robots/sitemap review', timeline: 'week 1' },
    { title: 'Snippet directives review', format: 'Technical checklist', timeline: 'week 1' },
    { title: 'Citable pages plan', format: '.md', timeline: 'week 1-2' },
    { title: 'Answer-first rewrite', format: 'Copy + markup', timeline: 'week 2-3' },
    { title: 'Sources and statistics integration', format: 'Content pack', timeline: 'week 2-3' },
    { title: 'Measurement prompt set', format: '.xlsx + .md', timeline: 'week 3' },
    { title: 'Repeated citability report', format: 'PDF + operating notes', timeline: 'monthly' },
  ] satisfies readonly ServiceDeliverable[],
  related: [
    { slug: 'seo', title: 'SEO & Visibility', shortPitch: 'GEO does not replace SEO: without solid technical and content foundations, AI engines have little to cite.' },
    { slug: 'analytics-setup', title: 'Analytics & Tag Manager', shortPitch: 'AI visibility should be read alongside conversions, referrals and real queries, not as an isolated metric.' },
    { slug: 'performance-cwv', title: 'Performance & Core Web Vitals', shortPitch: 'Rendering, clean HTML and speed remain prerequisites even when the reader is a crawler.' },
  ] satisfies readonly ServiceRelated[],
  leadMagnetCopy: {
    eyebrow: 'Free audit · 2 minutes',
    title: 'Measure first, then decide what to fix',
    body: 'Enter a page in the GEO Audit: check bot access, SSR, structure, citability and snippet directives. No citation promises, only verifiable criteria.',
    href: '/audit-geo',
    buttonLabel: 'Run the GEO Audit',
  } satisfies ServiceLeadMagnetCopy,
} as const;
