// EN translation of wordpress-migrazione.ts — Round 5a manual continuation.

import type { ServiceDetail } from '../../services-detail';
import { PROCESS_STEPS_EN } from '../_shared/process';

export const WORDPRESS_MIGRAZIONE_SERVICE_EN: ServiceDetail = {
  slug: 'wordpress-migrazione',
  title: 'WordPress migration & hosting',
  icon: 'ph-cloud-arrow-up',
  description:
    "I move WordPress to serious hosting without taking the site offline,\nbreaking links, or leaving DNS to chance.",
  longDescription:
    "Slow WordPress is rarely the theme's fault alone.\nOften it's a dirty chain: saturated shared hosting, cache plugins thrown in randomly, DNS managed by someone who doesn't reply, forgotten SSL.\n\nMigration removes the site from that swamp without making it disappear online.\nWe work on staging, prepare the new hosting, replicate the site, check links, images, redirects, certificates, cache and CDN before the final switch.\n\nThen we monitor the transition, we don't launch and run.\nThe result is a faster, more stable WordPress with fewer providers passing the blame. Period.",
  features: [
    {
      title: 'Migration without darkness',
      description:
        "The site gets copied and tested on staging before the switch.\nThe transition happens when hosting, database, files, redirects and SSL are ready, so visitors don't find broken pages or white screens."
    },
    {
      title: 'Tuned WordPress hosting',
      description:
        "I choose and configure an environment suited to the site: WP Engine, SiteGround or optimized hosting.\nNo shared servers full of unknown sites slowing every request and wasting visitors' time."
    },
    {
      title: 'DNS and SSL handled',
      description:
        "DNS switch planned with TTL, correct records and active SSL certificates.\nNo domain hanging between old and new host while everyone says it depends on someone else."
    },
    {
      title: 'Clean CDN and cache',
      description:
        "I configure Cloudflare, WP Rocket or equivalent stack without piling up random plugins.\nPage cache, browser, images and exclusion rules get set up readably, so they don't break carts, forms or restricted areas."
    },
    {
      title: 'Redirects under control',
      description:
        "I check URLs, media, permalinks and redirects after the migration.\nSwitching hosts shouldn't burn indexed pages, images, tracking or internal links because someone moved files by hand."
    },
    {
      title: 'Clear final documentation',
      description:
        "At the end, credentials, access, hosting, DNS, CDN and technical notes stay in a tidy document.\nWhoever manages the site afterwards doesn't have to dig through old emails and chats with vanished providers."
    }
  ],
  benefits: [
    "Site transferred without offline windows visible to clients.",
    'Faster loads on hosting suited to WordPress.',
    'DNS, SSL and CDN documented in a single place.',
    'Redirects and links checked before Google finds errors.',
    'Fewer hand-offs between hosting, agency and technician.'
  ],
  process: PROCESS_STEPS_EN,
  faqs: [
    {
      question: 'Does the site stay online during migration?',
      answer:
        "Yes, the goal is avoiding visible downtime.\nWe work on staging, prepare new hosting, and switch DNS only when the copy is ready.\nThere can be a few minutes of technical settling during propagation, but the site doesn't shut down for hours like in improvised transitions."
    },
    {
      question: 'What happens if the site has lots of images or heavy plugins?',
      answer:
        "We analyze the real weight first: media, database, plugins, old backups, cache and useless folders.\nMigration shouldn't carry junk from one server to another without looking at it.\nCritical parts get copied, tested, and when needed lightened before release."
    },
    {
      question: 'Do you also handle domain, DNS and SSL certificate?',
      answer:
        "Yes.\nDNS and SSL are often the point where the site ends up offline because nobody considers them their own.\nRecords, TTL, certificate, HTTPS redirects and CDN get treated as part of the work, not as a side detail to push onto hosting."
    },
    {
      question: 'Can migration damage SEO?',
      answer:
        "It can happen if links, redirects, media or permalinks get broken.\nThat's why I check main URLs, existing redirects, images, canonicals and HTTP responses after the switch.\nChanging host shouldn't mean making Google find a pile of errors."
    },
    {
      question: 'Can I choose the new hosting myself?',
      answer:
        "Yes, if the hosting is suited to the site and doesn't create predictable technical problems.\nIf instead the plan is too weak, too closed or full of limits, I tell you upfront.\nBetter to clarify immediately than migrate to another bottleneck."
    },
    {
      question: 'After migration, who keeps the access?',
      answer:
        "Access stays yours.\nI deliver tidy documentation with hosting, domain, DNS, CDN, WordPress and important technical notes.\nEnd of treasure hunt between personal accounts, past agencies and panels nobody knows how to open anymore. You decide."
    }
  ],
  awareness: {
    title: "The problem isn't WordPress, it's the chain",
    subtitle:
      "When hosting, DNS, cache and plugins get managed in pieces, every slowdown becomes a blame hunt.",
    problems: [
      {
        icon: 'ph-clock',
        title: 'Slow shared hosting',
        desc: 'The site loads in eight or ten seconds because it lives on a packed server, with contended resources and random cache.\nThen someone says WordPress is heavy. Convenient.'
      },
      {
        icon: 'ph-warning-circle',
        title: 'Badly done migration',
        desc: 'A host switch without staging can break images, permalinks, redirects and tracking.\nThe site comes back online, but with dead pages and wounded organic traffic.'
      },
      {
        icon: 'ph-lock',
        title: 'SSL and DNS ignored',
        desc: "When certificates, records and domain don't have a clear owner, one expiration or one wrong change is enough to take everything offline."
      }
    ]
  },
  expandedScope: {
    eyebrow: 'AFTER LIVE',
    title: 'The serious work starts after the DNS switch',
    body:
      "A WordPress migration doesn't end when the domain points to the new server. That's just the moment hidden problems try to come out: cache serving old pages, CDN blocking files, misaligned SSL, missing redirects, images with absolute paths, plugins still writing to the old host.\n\nThat's why post-migration matters as much as the transfer.\nI check page response, static resources, forms, login, admin panel, sitemap, redirects and real speed.\n\nIf needed, we tweak cache, clean the database, fix Cloudflare and put access in order.\n\nNo six-handed hand-offs between agency, hosting, DNS technician and plugin left there to bill a fee. One technical owner, one checklist, a site that stays standing. Period."
  }
};
