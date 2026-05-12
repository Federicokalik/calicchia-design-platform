// EN translation of manutenzione-siti.ts — Round 5a manual continuation.

import type { ServiceDetail } from '../../services-detail';

export const MANUTENZIONE_SITI_SERVICE_EN: ServiceDetail = {
  slug: 'manutenzione-siti',
  title: 'Website maintenance',
  icon: 'ph-wrench',
  description:
    "The site shouldn't disappear while someone hunts for the right backup.\nMonitoring, updates, fixes and security under control.",
  longDescription:
    "A site left in the hands of the agency-hosting-freelance-plugin chain becomes a blind spot: it breaks, nobody sees, then the blame hunt starts.\nMaintenance removes that chaos from the table.\n\nDaily backups, uptime monitoring, controlled updates, security patches, base WAF and urgent fixes within 24 working hours.\nIf a form stays broken for 6 days, that's not a technical detail: those are lost inquiries.\n\nIt's not technical theater, it's operational oversight.\nYou know who intervenes, what's been done, and where the restore points are.\nThe site stays governed even after launch, without waiting for clients to flag the disaster. Period.",
  features: [
    {
      title: 'Backup and restore',
      description:
        'Automatic daily backups of site and database, with on-demand restore when you need to roll back.\nNo hunting for scattered files, old zips, or half-broken copies saved somewhere.'
    },
    {
      title: 'Continuous uptime monitoring',
      description:
        "24/7 uptime monitoring with alerts when the site doesn't respond.\nThe problem gets seen before it becomes an angry client phone call or a day lost figuring out what happened."
    },
    {
      title: 'Updates without chaos',
      description:
        "CMS, plugin and dependency updates handled with judgment, not clicked at random in production.\nFirst we look at what changes, then we intervene.\nRandom plugins left behind become technical debt, not destiny."
    },
    {
      title: 'Tracked urgent fixes',
      description:
        "For blocking failures, intervention within 24 working hours with clear priority.\nBroken forms, blank pages, server errors, frozen checkout: diagnosis, fix, documentation. End of story."
    },
    {
      title: 'Patches and base WAF',
      description:
        "Security patches applied when known vulnerabilities emerge, with base WAF to filter dirty traffic and trivial attempts.\nIt doesn't make the site invincible, but it cuts many doors left open through neglect."
    },
    {
      title: 'Readable monthly report',
      description:
        "Every month you receive a comprehensible report: uptime, backups, updates, anomalies, interventions, and points to keep an eye on.\nNo jargon to cover the void. Just real technical state and next priorities."
    }
  ],
  benefits: [
    'You discover problems before clients flag them.',
    'You have restorable backups, not promises lost in chat.',
    'You reduce known vulnerabilities from old plugins and dependencies.',
    'You know who intervenes when the site breaks.',
    'You receive a clear, readable monthly technical picture.'
  ],
  process: [
    {
      step: 1,
      title: 'Initial audit',
      description:
        "I check CMS, hosting, plugins, domain, SSL, existing backups and access.\nBefore touching anything, we understand how much technical chaos is really under the site."
    },
    {
      step: 2,
      title: 'Securing the foundation',
      description:
        'Backups, monitoring, alerts and base checks get activated.\nCredentials get organized, fragile points marked, urgencies separated from deferrable work.'
    },
    {
      step: 3,
      title: 'Controlled updates',
      description:
        "Updates and patches get handled with attention, verifying compatibility and impact.\nThe point isn't to update everything blindly: it's not breaking production."
    },
    {
      step: 4,
      title: 'Monthly oversight',
      description:
        "Every month we check technical state, uptime, errors, security and renewals.\nDomain and SSL shouldn't become emergencies because somebody ignored an email."
    },
    {
      step: 5,
      title: 'Rapid intervention',
      description:
        'When something breaks, there\'s an operational channel and defined priority.\nDiagnosis, fix, verification, final note. No endless relay races between providers.'
    }
  ],
  faqs: [
    {
      question: 'What happens if the site goes offline?',
      answer:
        "Monitoring sends an alert when the site doesn't respond.\nFrom there we verify if the problem is hosting, DNS, CMS, plugins, database or SSL certificate.\nIf it falls within the managed technical perimeter, we intervene within 24 working hours.\nThe point is to avoid the first alarm coming from an annoyed client."
    },
    {
      question: 'Do you also handle existing WordPress sites?',
      answer:
        "Yes, after an initial check.\nFirst we need access, plugin state, theme, hosting, backups, domain and SSL.\nIf the site is full of abandoned components or badly modified code, it gets flagged immediately.\nMaintenance shouldn't cover a technical bomb with a coat of paint."
    },
    {
      question: 'Can updates break the site?',
      answer:
        "Yes, they can.\nThat's why they shouldn't be done in bursts by clicking \"update all\".\nFirst we check versions, compatibility, critical plugins and backup state.\nIf something doesn't add up, we proceed cautiously or flag the risk.\nUpdating without judgment is roulette, not maintenance."
    },
    {
      question: 'What does the monthly report include?',
      answer:
        "The report includes uptime, backups performed, updates applied, anomalies detected, interventions made, security patches and notes on renewals.\nIt's written to be understood by who runs the business, not just by who reads server logs.\nIt has to clarify site state, not fill pages."
    },
    {
      question: 'Can you handle domain and SSL?',
      answer:
        "Yes, if access is available and the registrar allows it.\nWe monitor expirations, renewals and SSL certificates, so they don't become sudden emergencies.\nExpired domain and broken SSL are trivial problems, but when nobody monitors them they block everything.\nYou decide whether to leave them to chance."
    },
    {
      question: 'What if the site was made by another agency?',
      answer:
        'It can be managed, but first the real state of the project needs to be read.\nSome agencies deliver tidy sites, others leave duplicate plugins, saturated shared hosting and incomplete access.\nThe audit exists exactly to understand what can be overseen immediately and what needs fixing first.'
    }
  ],
  awareness: {
    title: "The site doesn't maintain itself",
    subtitle:
      'After launch come updates, expirations, bugs, vulnerabilities and technical responsibilities often left in the void.',
    problems: [
      {
        icon: 'ph-warning-circle',
        title: 'Invisible offline',
        desc: "The site goes down and nobody knows until a client calls.\nBy then it's no longer a technical problem: it's reputation, lost sales, and a panicked recovery race."
      },
      {
        icon: 'ph-shield-check',
        title: 'Vulnerable plugins',
        desc: "Outdated WordPress plugins, old themes and frozen dependencies open known holes.\nAutomated attacks don't wait for the meeting with the agency or the ticket with the provider."
      },
      {
        icon: 'ph-clock',
        title: 'Nobody responsible',
        desc: 'When a backup needs restoring, the relay starts: hosting, agency, developer, account manager.\nMeanwhile the site stays broken and nobody takes the problem in hand.'
      }
    ]
  },
  expandedScope: {
    eyebrow: 'AFTER LAUNCH',
    title: 'Maintenance is where the theater ends',
    body:
      "The site launch is just day zero.\nAfter come CMS updates, plugins that change behavior, expiring SSL certificates, shared hosting that slows down, public vulnerabilities, forms that stop sending emails and backups nobody ever tried to restore.\n\nThe chain of providers is the problem: whoever made the theme doesn't manage the server, whoever manages the server doesn't touch WordPress, whoever sold the project replies with three people in CC.\nMeanwhile the site is yours, the damage is yours, the rush is yours.\n\nMonthly or annual maintenance puts continuous technical oversight in place: monitoring, updates, backups, patches, alerts, urgent fixes and a readable report.\nIt doesn't promise magic. It removes improvisation. Period."
  }
};
