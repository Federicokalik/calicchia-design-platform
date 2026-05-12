// EN translation of services.ts — voice anti-marketing preserved.
// Pattern mirrors services-content/en/web-design.ts (Round 5a, 2026-05-08).

import type { Service } from './types';

export const MATRIX_SERVICES_EN: Service[] = [
  {
    slug: 'web-design',
    title: 'Web Design',
    lead:
      "Your website is not an online brochure.\nIt is the first place people decide whether to trust you.\nI build it starting from you — no templates, no shortcuts.",
    deliverables: [
      'Design tailored to your identity',
      'Technical SEO already configured',
      'GDPR privacy / cookies in order',
      'One year of support included',
    ],
    icon: 'globe',
  },
  {
    slug: 'e-commerce',
    title: 'E-Commerce',
    lead:
      "Opening an e-commerce store does not mean putting products on a page and hoping someone buys.\nI build stores that convert, manageable without an IT team.",
    deliverables: [
      'Catalogue, cart and checkout that flow',
      'Payment integration (Stripe / PayPal)',
      'Inventory sync',
      'Transactional emails done with care',
    ],
    icon: 'shopping-cart',
  },
  {
    slug: 'sviluppo-web',
    title: 'Web Development',
    lead:
      "Sometimes a brochure site is not enough.\nYou need a platform that does things: back-office tools, bookings, client areas, integrations with your stack.",
    deliverables: [
      'Custom applications built to fit',
      'APIs and third-party integrations',
      'Client areas and admin panels',
      'Performance of a modern SaaS',
    ],
    icon: 'code',
  },
  {
    slug: 'seo',
    title: 'SEO & Visibility',
    lead:
      "No tricks, no empty promises.\nI make sure the people searching for what you offer find you and understand right away why you are the right pick.",
    deliverables: [
      'Full technical audit',
      'Keyword and content strategy',
      'Local SEO (Google Business)',
      'Monthly monitoring',
    ],
    icon: 'magnifying-glass',
  },
];

export const STANDALONE_SERVICES_EN: Service[] = [
  // NB: branding removed 2026-05-08 — out of Web Designer & Developer positioning.
  {
    slug: 'manutenzione-siti',
    title: 'Site Maintenance',
    lead:
      "Your site is online — but who is watching it?\nUpdates, backups, monitoring, urgent fixes.\nA clear monthly fee, no surprises.",
    deliverables: [
      'Backup and restore',
      'CMS, plugin and dependency updates',
      'Uptime and performance monitoring',
      'Urgent fixes within 24h',
    ],
    icon: 'wrench',
  },
  {
    slug: 'assistenza-wordpress',
    title: 'WordPress Support',
    lead:
      "WordPress is powerful — and fragile.\nI clean up compromised sites, sort out conflicting plugins, and block attacks before they do damage.",
    deliverables: [
      'Security hardening (firewall, 2FA)',
      'Malware cleanup and restore',
      'Plugin conflict resolution',
      'Performance tuning (cache, queries)',
    ],
    icon: 'shield-check',
  },
  {
    slug: 'wordpress-migrazione',
    title: 'WordPress Migration & Hosting',
    lead:
      "Slow site or a host that lets you down?\nI move WordPress with no downtime, configure performant hosting, and cut load times.",
    deliverables: [
      'Zero-downtime migration',
      'WP-tuned hosting setup',
      'CDN and cache configured',
      'DNS migration and SSL certificates',
    ],
    icon: 'cloud-arrow-up',
  },
  {
    slug: 'performance-cwv',
    title: 'Performance & Core Web Vitals',
    lead:
      "The site looks good but loads in 8 seconds.\nOn mobile it pushes customers away, on Google it slips down the page.\nI fix LCP, CLS, INP until they pass the check.",
    deliverables: [
      'Lighthouse + WebPageTest audit',
      'LCP < 2.5s, CLS < 0.1, INP < 200ms',
      'Image optimization + lazy loading',
      'Measurable before/after report',
    ],
    icon: 'gauge',
  },
  {
    slug: 'accessibility-wcag',
    title: 'WCAG Accessibility',
    lead:
      "From 28 June 2025 the European Accessibility Act is in force.\nIf you sell online, the site must be accessible or you pay fines.\nWCAG 2.1 AA audit + remediation.",
    deliverables: [
      'Screen reader audit (NVDA + VoiceOver)',
      'Contrast + keyboard navigation check',
      'ARIA fixes + semantic HTML',
      'Publishable accessibility statement',
    ],
    icon: 'wheelchair',
  },
  {
    slug: 'analytics-setup',
    title: 'Analytics & Tag Manager',
    lead:
      "You have a site but no idea who buys, who bounces, where they come from.\nProper GA4 + GTM setup, conversion events tracked, dashboard readable in 5 minutes.",
    deliverables: [
      'GA4 property + GTM container',
      'E-commerce / lead form events',
      'Consent Mode v2 (GDPR-compliant)',
      'Custom Looker Studio dashboard',
    ],
    icon: 'chart-line-up',
  },
];

/** @deprecated Use MATRIX_SERVICES_EN or STANDALONE_SERVICES_EN. Kept for back-compat. */
export const SERVICES_EN: Service[] = [...MATRIX_SERVICES_EN, ...STANDALONE_SERVICES_EN];
