import type {
  ServiceDeliverable,
  ServiceLeadMagnetCopy,
  ServiceRelated,
} from '../../services-detail';

export const ANALYTICS_SETUP_EXTRAS_EN = {
  deliverables: [
    { title: 'Existing GA4 + GTM setup audit', format: 'Markdown report', timeline: 'week 1' },
    { title: 'Business-driven event map', format: 'Shared spreadsheet', timeline: 'week 1' },
    { title: 'Clean GA4 property + filters', format: 'Configuration', timeline: 'week 1' },
    { title: 'Tidy GTM container (folder + naming)', format: 'Configuration', timeline: 'week 1-2' },
    { title: 'E-commerce / lead form / content events', format: 'GTM tag + trigger', timeline: 'week 2' },
    { title: 'Consent Mode v2 + banner integration', format: 'Tag + script', timeline: 'week 2' },
    { title: 'Google Ads conversion + Meta CAPI (optional)', format: 'GTM tag + server-side', timeline: 'week 2-3' },
    { title: 'Personalized Looker Studio dashboard', format: 'Shared dashboard', timeline: 'week 3' },
    { title: 'Events + variables documentation', format: 'Spreadsheet', timeline: 'pre-handoff' },
    { title: 'Handoff session (30 min)', format: 'Meet + recording', timeline: 'post-launch' },
  ] satisfies readonly ServiceDeliverable[],
  related: [
    {
      slug: 'seo',
      title: 'SEO & Visibility',
      shortPitch:
        "Without analytics you don't know which keyword converts. Without SEO you have no traffic to analyze. They go together.",
    },
    {
      slug: 'performance-cwv',
      title: 'Performance & CWV',
      shortPitch:
        "Performance and analytics measure together: a slow site loses conversions and data proves it.",
    },
    {
      slug: 'e-commerce',
      title: 'E-Commerce',
      shortPitch:
        "Without correctly tracked e-commerce events, optimizing an online store is pure feeling.",
    },
  ] satisfies readonly ServiceRelated[],
  leadMagnetCopy: {
    eyebrow: 'Free audit · 20 minutes',
    title: 'Does your GA4 actually track what you need?',
    body:
      "I look at your GA4 + GTM setup (even just event names via GTM Preview) and send you a mini-analysis: what's broken, what's missing, the 3 fix priorities. No sales pitch.",
  } satisfies ServiceLeadMagnetCopy,
} as const;
