import type {
  ServiceDeliverable,
  ServiceLeadMagnetCopy,
  ServiceRelated,
} from '../../services-detail';

export const WORDPRESS_MIGRAZIONE_EXTRAS_EN = {
  deliverables: [
    { title: 'Pre-migration audit', format: 'PDF report', timeline: 'week 1' },
    { title: 'URL and redirect mapping', format: '.xlsx', timeline: 'week 1' },
    { title: 'DB and files copy', format: 'Staging copy', timeline: 'week 1' },
    { title: 'Staging tests', format: 'Checklist', timeline: 'week 1-2' },
    { title: 'New hosting setup', format: 'Server config', timeline: 'week 2' },
    { title: 'Controlled DNS switch', format: 'DNS log', timeline: 'go-live' },
    { title: 'Post-migration check', format: 'Checklist', timeline: 'go-live' },
    { title: 'Performance baseline', format: 'Lighthouse report', timeline: 'post-launch' },
    { title: '7-day log monitoring', format: 'Log review', timeline: 'post-launch' },
    { title: 'Access documentation', format: '.md', timeline: 'post-launch' },
  ] satisfies readonly ServiceDeliverable[],
  related: [
    {
      slug: 'manutenzione-siti',
      title: 'Website maintenance',
      shortPitch:
        "After the DNS switch you need backups, alerts and controlled updates.",
    },
    {
      slug: 'assistenza-wordpress',
      title: 'WordPress support',
      shortPitch:
        "If migration reveals malware or broken plugins, first close the hole.",
    },
    {
      slug: 'web-design',
      title: 'Web Design',
      shortPitch:
        "If the site stays old on the new host too, the problem is just moved.",
    },
  ] satisfies readonly ServiceRelated[],
  leadMagnetCopy: {
    eyebrow: 'Free audit · 15 minutes',
    title: 'Bad migration = burned SEO?',
    body:
      "I check hosting, DNS, redirects, media and SEO risks before the switch. 15 minutes on Meet, no leap in the dark.",
  } satisfies ServiceLeadMagnetCopy,
} as const;
