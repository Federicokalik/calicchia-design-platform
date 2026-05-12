import type {
  ServiceDeliverable,
  ServiceLeadMagnetCopy,
  ServiceRelated,
} from '../../services-detail';

export const MANUTENZIONE_SITI_EXTRAS_EN = {
  deliverables: [
    { title: 'Daily backup setup', format: 'Backup job', timeline: 'week 1' },
    { title: 'Backup restore test', format: 'Checklist', timeline: 'week 1' },
    { title: 'Uptime monitoring', format: 'Alert dashboard', timeline: 'week 1' },
    { title: 'Planned updates', format: 'Maintenance log', timeline: 'monthly' },
    { title: 'Base security hardening', format: 'Config report', timeline: 'week 1-2' },
    { title: 'Access and error logs', format: 'Log review', timeline: 'monthly' },
    { title: 'Monthly technical report', format: 'PDF report', timeline: 'monthly' },
    { title: 'Emergency intervention', format: 'Ticket + log', timeline: 'on-demand' },
    { title: 'Tested rollback', format: 'Restore note', timeline: 'post-update' },
    { title: 'Critical renewal monitoring', format: 'Schedule', timeline: 'ongoing' },
  ] satisfies readonly ServiceDeliverable[],
  related: [
    {
      slug: 'assistenza-wordpress',
      title: 'WordPress support',
      shortPitch:
        "If WordPress is already slow, broken or compromised, first you fix, then you oversee.",
    },
    {
      slug: 'sviluppo-web',
      title: 'Web Development',
      shortPitch:
        "Web apps and dashboards need real monitoring, logs and backups.",
    },
    {
      slug: 'seo',
      title: 'SEO & Visibility',
      shortPitch:
        "Downtime, server errors and broken redirects eat organic traffic without asking permission.",
    },
  ] satisfies readonly ServiceRelated[],
  leadMagnetCopy: {
    eyebrow: 'Free audit · 15 minutes',
    title: 'When was the last backup tested?',
    body:
      "I check backups, updates, uptime, SSL and fragile points. 15 minutes on Meet, no maintenance package pushed by force.",
  } satisfies ServiceLeadMagnetCopy,
} as const;
