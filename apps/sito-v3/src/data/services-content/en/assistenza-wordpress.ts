// EN translation of assistenza-wordpress.ts — Round 5a manual continuation.

import type { ServiceDetail } from '../../services-detail';
import { PROCESS_STEPS_EN } from '../_shared/process';

export const ASSISTENZA_WORDPRESS_SERVICE_EN: ServiceDetail = {
  slug: 'assistenza-wordpress',
  title: 'WordPress support',
  icon: 'ph-shield-check',
  description:
    'Recovery, hardening and performance for WordPress under attack, slow, or broken by plugins.',
  longDescription:
    "When WordPress ends up in the hands of too many providers, the problem is no longer just technical: it's a chain of offloaded responsibilities.\nA badly updated plugin, shared hosting pulled to the limit, a theme full of patches, backups never verified.\n\nI intervene on the precise point: malware, redirects, admin crashes, conflicts, slowness, SSL, permissions, database.\nFirst we isolate the damage, then restore, close the hole and leave a readable trace of what was done.\n\nNo agency theater. No six-handed meetings. Diagnosis, intervention, final check. Period.",
  features: [
    {
      title: 'Tracked malware cleanup',
      description:
        "Removal of infected files, malicious redirects, suspicious users, backdoors and code inserted in the worst spots.\nThe site gets restored starting from evidence, not from blind attempts."
    },
    {
      title: 'Serious security hardening',
      description:
        "Firewall, 2FA, file permissions, editor lockdown, login limitations and checks on sensitive areas.\nWordPress doesn't become invincible, but it stops being wide open."
    },
    {
      title: 'Isolated plugin conflicts',
      description:
        "Analysis of plugins, theme, PHP logs and browser console to understand who breaks what.\nWe intervene on the real conflict, without disabling half the site hoping it passes."
    },
    {
      title: 'Real performance tuning',
      description:
        "Cache, slow queries, heavy autoload, dirty tables, cron out of control and badly loaded assets.\nSlowness isn't covered by adding another plugin: it's measured and corrected."
    },
    {
      title: 'Readable security audit',
      description:
        "Check of access, plugins, theme, permissions, server configuration, HTTPS, backups and compromise signals.\nThe report says what's critical, what's fragile, what to do."
    },
    {
      title: 'Clean SSL migration',
      description:
        "Switch to HTTPS with mixed content verification, redirects, canonicals, images, forms and external calls.\nNo broken padlock, no pages losing resources along the way."
    }
  ],
  benefits: [
    'Admin accessible again without hunting for the culprit between plugins and theme.',
    'Site cleaned of redirects, payloads and hidden suspicious accounts.',
    'Faster loads with cache, queries and database under control.',
    'Less risk of relapses after updates or improvised interventions.',
    'Clear report to decide what to keep, change, or remove.'
  ],
  process: PROCESS_STEPS_EN,
  faqs: [
    {
      question: 'My WordPress site shows strange redirects: what do I do right now?',
      answer:
        "First thing: don't update plugins at random and don't install more security plugins in panic.\nServe it by blocking unnecessary access, verify files, database, admin users, cron, .htaccess and theme.\nIf the site sends traffic to suspicious pages, treat it as compromised until proven otherwise."
    },
    {
      question: 'Can you recover a hacked WordPress site without rebuilding from scratch?',
      answer:
        'Often yes, but it depends on the real state of files, database and available backups.\nRebuilding everything is the last choice, not the first.\nFirst we look for the compromise, remove backdoors and fake accounts, restore correct files and close weak access points.'
    },
    {
      question: 'A plugin broke admin or front-end: how do you intervene?',
      answer:
        "We start from logs, debug mode, PHP version, active theme and plugin list.\nThen we isolate the conflict without dismantling the entire site in front of clients.\nThe point isn't finding a convenient culprit, but understanding which combination creates the error and how to correct it."
    },
    {
      question: 'The site is slow even with a cache plugin: why?',
      answer:
        "Because cache doesn't cure slow queries, bloated database, weak hosting, runaway cron, oversized images, or plugins loading assets everywhere.\nIf TTFB is high, the problem is often before the browser.\nIt needs to be measured server-side, database-side and WordPress-side, not masked."
    },
    {
      question: 'What does the security audit really check?',
      answer:
        "It checks users, roles, plugins, theme, file permissions, WordPress configuration, HTTPS, backups, security headers, exposed endpoints and compromise signals.\nIt's not a decorative list.\nIt exists to understand where the site is fragile and which interventions have technical priority."
    },
    {
      question: 'After the intervention, is the site protected forever?',
      answer:
        "No.\nWhoever promises eternal protection on WordPress is selling air.\nAfter the intervention the site is more closed, clean and controllable, but it stays a living system: plugins, theme, PHP, hosting and access change.\nSensible maintenance and less improvisation are needed."
    }
  ],
  awareness: {
    title: "WordPress doesn't break by itself",
    subtitle:
      "Usually it gets broken by hand-offs, accumulated plugins, and hosting chosen out of inertia.",
    problems: [
      {
        icon: 'ph-warning-circle',
        title: 'Malicious redirects',
        desc: "The site looks online, but takes users and search engines to suspicious content.\nMeanwhile Google flags problems, reputation drops, and nobody knows where the infection started."
      },
      {
        icon: 'ph-prohibit',
        title: 'Plugins out of control',
        desc: 'Page builders, addons, cache plugins, security plugins, plugins to fix other plugins.\nAt some point one update is enough and admin, front-end or checkout breaks.'
      },
      {
        icon: 'ph-clock',
        title: 'Chronic slowness',
        desc: "TTFB over three seconds, pages exceeding five seconds, dirty database and heavy queries.\nIt's not the visitor's fault. It's WordPress left to grow without control."
      }
    ]
  },
  expandedScope: {
    eyebrow: 'AFTER INTERVENTION',
    title: 'WordPress has to be closed, not just put back online',
    body:
      "Putting a compromised WordPress back online is the easy part. The useful part is preventing it from returning identical to the starting point: same plugins left there, same saturated shared hosting, same forgotten admin accounts, same badly written permissions.\n\nAfter cleanup, recovery or tuning, the work expands where needed: hardening, backup verification, plugin review, HTTPS, database, logs, cache and access.\n\nIf multiple providers are involved, we cut the noise: who manages hosting, who manages domain, who touches WordPress, who has credentials.\nSix-handed chains produce technical blame-passing. I leave a more readable, more closed site, with clear priorities for what comes next. You decide."
  }
};
