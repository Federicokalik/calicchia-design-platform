import type {
  ServiceDeliverable,
  ServiceLeadMagnetCopy,
  ServiceRelated,
} from '../../services-detail';

export const WEB_DESIGN_EXTRAS_EN = {
  deliverables: [
    { title: 'Main pages sitemap', format: 'Miro + .md', timeline: 'week 1' },
    { title: 'Lo-fi navigable wireframes', format: 'Figma', timeline: 'week 1' },
    { title: 'Base design tokens', format: 'Figma + .json', timeline: 'week 1' },
    { title: 'Hi-fi homepage design', format: 'Figma', timeline: 'week 2' },
    { title: 'Inner page templates', format: 'Figma', timeline: 'week 2-3' },
    { title: 'Documented UI components', format: 'Figma', timeline: 'week 3' },
    { title: 'Form and CTA microcopy', format: '.md', timeline: 'week 3' },
    { title: 'Responsive checklist 4 breakpoints', format: 'PDF report', timeline: 'pre-launch' },
    { title: 'Development handoff and assets', format: 'Figma + .zip', timeline: 'pre-launch' },
    { title: 'Post-launch check', format: 'Checklist', timeline: 'post-launch' },
  ] satisfies readonly ServiceDeliverable[],
  related: [
    {
      slug: 'seo',
      title: 'SEO & Visibility',
      shortPitch:
        "If the site is clean but Google doesn't read it, the problem stays outside design.",
    },
    {
      slug: 'performance-cwv',
      title: 'Performance & Core Web Vitals',
      shortPitch:
        'Pretty but slow is invisible. LCP, CLS, INP in line or Google penalizes.',
    },
    {
      slug: 'sviluppo-web',
      title: 'Web Development',
      shortPitch:
        "For dashboards, client areas and custom flows, web design alone isn't enough.",
    },
  ] satisfies readonly ServiceRelated[],
  leadMagnetCopy: {
    eyebrow: 'Free audit · 15 minutes',
    title: 'Want to know where you lose customers before starting?',
    body:
      "I look at structure, mobile, CTAs, forms and tracking. 15 minutes on Meet, no quote disguised as consulting.",
  } satisfies ServiceLeadMagnetCopy,
} as const;
