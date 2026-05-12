import type {
  ServiceDeliverable,
  ServiceLeadMagnetCopy,
  ServiceRelated,
} from '../../services-detail';

export const ACCESSIBILITY_WCAG_EXTRAS_EN = {
  deliverables: [
    { title: 'Automatic audit (axe + WAVE + Lighthouse)', format: 'PDF report + JSON', timeline: 'week 1' },
    { title: 'Manual screen reader audit (NVDA + VoiceOver)', format: 'Video walkthrough + report', timeline: 'week 1' },
    { title: 'Violation map per Level (A/AA/AAA)', format: 'Notion / spreadsheet', timeline: 'week 1' },
    { title: 'Level A remediation (blocking)', format: 'Code', timeline: 'week 2' },
    { title: 'Level AA remediation (mandatory EAA)', format: 'Code', timeline: 'week 2-3' },
    { title: 'Contrast + color fix', format: 'Design tokens + code', timeline: 'week 3' },
    { title: 'Form errors + ARIA validation', format: 'Code', timeline: 'week 3' },
    { title: 'Re-audit + verification', format: 'PDF before/after', timeline: 'week 3-4' },
    { title: 'Accessibility statement', format: 'Publishable HTML/MD', timeline: 'pre-handoff' },
    { title: 'Operational content checklist', format: 'Markdown', timeline: 'pre-handoff' },
  ] satisfies readonly ServiceDeliverable[],
  related: [
    {
      slug: 'web-design',
      title: 'Web Design',
      shortPitch:
        "An accessible site is born from design, not the final patch. Components designed for keyboard + screen reader from the wireframe stage.",
    },
    {
      slug: 'sviluppo-web',
      title: 'Web Development',
      shortPitch:
        "React/Next components with correct semantics, ARIA where needed, focus management built-in.",
    },
    {
      slug: 'manutenzione-siti',
      title: 'Website maintenance',
      shortPitch:
        "Quarterly re-audit to catch regressions before fines or complaints arrive.",
    },
  ] satisfies readonly ServiceRelated[],
  leadMagnetCopy: {
    eyebrow: 'Free audit · 30 minutes',
    title: 'Is your site compliant with the European Accessibility Act?',
    body:
      "I run an automatic scan + 10 minutes of manual screen reader testing on the 3 most critical pages. I send a mini-report with Level A violations that block the site for users with disabilities. No compliance-washing.",
  } satisfies ServiceLeadMagnetCopy,
} as const;
