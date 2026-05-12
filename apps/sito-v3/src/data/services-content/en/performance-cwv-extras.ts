import type {
  ServiceDeliverable,
  ServiceLeadMagnetCopy,
  ServiceRelated,
} from '../../services-detail';

export const PERFORMANCE_CWV_EXTRAS_EN = {
  deliverables: [
    { title: '5-10 page baseline audit', format: 'PDF report + JSON', timeline: 'week 1' },
    { title: 'Bottleneck map per metric', format: 'Notion / Markdown', timeline: 'week 1' },
    { title: 'Image pipeline (AVIF/WebP + lazy)', format: 'Code + CI script', timeline: 'week 2' },
    { title: 'Optimized font loading', format: 'Code + preload', timeline: 'week 2' },
    { title: 'JavaScript splitting + tree-shake', format: 'Bundle analyzer report', timeline: 'week 2-3' },
    { title: 'Layout shift fix (CLS)', format: 'Code', timeline: 'week 3' },
    { title: 'INP optimization (yield + idle)', format: 'Code', timeline: 'week 3' },
    { title: 'Re-audit + waterfall comparison', format: 'PDF before/after', timeline: 'week 3-4' },
    { title: 'Maintenance checklist', format: 'Markdown', timeline: 'pre-handoff' },
    { title: 'Continuous monitoring setup (optional)', format: 'PageSpeed API + alert', timeline: 'post-handoff' },
  ] satisfies readonly ServiceDeliverable[],
  related: [
    {
      slug: 'web-design',
      title: 'Web Design',
      shortPitch:
        "A fast site is born from design, not chased afterward. Performance enters at the wireframe stage.",
    },
    {
      slug: 'sviluppo-web',
      title: 'Web Development',
      shortPitch:
        "Modern stack, smart hydration, tuned build pipeline. Performance isn't a layer applied later.",
    },
    {
      slug: 'manutenzione-siti',
      title: 'Website maintenance',
      shortPitch:
        "Continuous monitoring to catch regressions before Google sees them.",
    },
  ] satisfies readonly ServiceRelated[],
  leadMagnetCopy: {
    eyebrow: 'Free audit · 20 minutes',
    title: 'Find out if your site passes the Core Web Vitals check',
    body:
      "I measure LCP, CLS, INP on the 3 most important pages of your site and send a report with the 3 most impactful fixes. No sales pitch: just numbers.",
  } satisfies ServiceLeadMagnetCopy,
} as const;
