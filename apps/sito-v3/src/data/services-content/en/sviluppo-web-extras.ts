import type {
  ServiceDeliverable,
  ServiceLeadMagnetCopy,
  ServiceRelated,
} from '../../services-detail';

export const SVILUPPO_WEB_EXTRAS_EN = {
  deliverables: [
    { title: 'Operational process map', format: 'Miro + .md', timeline: 'week 1' },
    { title: 'API design', format: 'OpenAPI', timeline: 'week 1-2' },
    { title: 'Database schema', format: 'ERD + SQL', timeline: 'week 1-2' },
    { title: 'Custom dashboard', format: 'React app', timeline: 'week 2-4' },
    { title: 'Roles and permissions', format: 'Access matrix', timeline: 'week 2' },
    { title: 'CRM/ERP integrations', format: 'API/Webhook', timeline: 'week 3-5' },
    { title: 'Operational automations', format: 'Worker/jobs', timeline: 'week 4-5' },
    { title: 'CI/CD deployment', format: 'GitHub Actions', timeline: 'pre-launch' },
    { title: 'Monitoring and logs', format: 'Dashboard', timeline: 'pre-launch' },
    { title: 'Technical documentation', format: '.md repo', timeline: 'post-launch' },
  ] satisfies readonly ServiceDeliverable[],
  related: [
    {
      slug: 'web-design',
      title: 'Web Design',
      shortPitch:
        "If the app has real users, the interface has to cut steps, not decorate them.",
    },
    {
      slug: 'seo',
      title: 'SEO & Visibility',
      shortPitch:
        "Public apps have to be readable by Google too, not just by logged-in users.",
    },
    {
      slug: 'manutenzione-siti',
      title: 'Website maintenance',
      shortPitch:
        'After deployment you need logs, backups and ongoing technical responsibility.',
    },
  ] satisfies readonly ServiceRelated[],
  leadMagnetCopy: {
    eyebrow: 'Free audit · 15 minutes',
    title: 'How much does a fragile integration cost?',
    body:
      "We map a real flow: data, manual steps, tools involved and breaking point. 15 minutes on Meet, no useless document.",
  } satisfies ServiceLeadMagnetCopy,
} as const;
