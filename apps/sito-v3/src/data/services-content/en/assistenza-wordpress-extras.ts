import type {
  ServiceDeliverable,
  ServiceLeadMagnetCopy,
  ServiceRelated,
} from '../../services-detail';

export const ASSISTENZA_WORDPRESS_EXTRAS_EN = {
  deliverables: [
    { title: 'WordPress admin hardening', format: 'Config report', timeline: 'day 1' },
    { title: 'Plugin audit', format: 'PDF report', timeline: 'day 1' },
    { title: 'Malware cleanup if needed', format: 'Fix log', timeline: 'on-demand' },
    { title: 'Configured backups', format: 'Backup job', timeline: 'day 1-2' },
    { title: 'WAF and firewall', format: 'Security config', timeline: 'day 2' },
    { title: 'Performance audit', format: 'Lighthouse + log', timeline: 'day 2' },
    { title: 'Recovery plan', format: '.md', timeline: 'post-fix' },
    { title: 'Correct file permissions', format: 'Server config', timeline: 'post-fix' },
    { title: 'Intervention report', format: 'PDF report', timeline: 'post-fix' },
    { title: 'Basic management training', format: 'Meet + .md', timeline: 'post-fix' },
  ] satisfies readonly ServiceDeliverable[],
  related: [
    {
      slug: 'manutenzione-siti',
      title: 'Website maintenance',
      shortPitch:
        "After the repair you need oversight, otherwise WordPress goes back to chaos.",
    },
    {
      slug: 'wordpress-migrazione',
      title: 'WordPress migration & hosting',
      shortPitch:
        "If hosting is the bottleneck, cleaning plugins isn't enough.",
    },
    {
      slug: 'web-design',
      title: 'Web Design',
      shortPitch:
        "When the site is unrecoverable, it's worth redoing structure and technical base.",
    },
  ] satisfies readonly ServiceRelated[],
  leadMagnetCopy: {
    eyebrow: 'Free audit · 15 minutes',
    title: 'Is your WordPress compromised?',
    body:
      "I check plugins, admin, redirects, backups and compromise signals. 15 minutes on Meet, diagnosis before panic.",
  } satisfies ServiceLeadMagnetCopy,
} as const;
