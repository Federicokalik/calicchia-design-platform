// EN translation of performance-cwv.ts — Round 5a manual continuation.

import type { ServiceDetail } from '../../services-detail';

export const PERFORMANCE_CWV_SERVICE_EN: ServiceDetail = {
  slug: 'performance-cwv',
  title: 'Performance & Core Web Vitals',
  icon: 'ph-gauge',
  description:
    "The site loads slow, bounces on mobile, slips down Google rankings.\nI fix LCP, CLS, INP until the check passes.",
  longDescription:
    "A site that loads in 6-8 seconds isn't a slow site, it's an invisible site.\nSince May 2021 Google uses Core Web Vitals as a ranking signal: if LCP, CLS and INP don't pass the threshold, you fall behind tidier competitors.\n\nOn mobile, half the users leave before seeing the first heading.\nThe problem isn't \"buy a more expensive host\": it's understanding where the site wastes milliseconds and cutting.\n\n4MB hero loaded as PNG, fonts loaded without preload, render-blocking JavaScript, layout shifts caused by a badly placed cookie banner, images served without optimization.\n\nNo magic: I measure with Lighthouse + WebPageTest + CrUX, identify real bottlenecks, apply fixes, re-measure.\nIf hosting, CDN, cache layer or build pipeline need touching, I do it. The Google check passes or it doesn't close. Period.",
  features: [
    {
      title: 'Lighthouse + WebPageTest + CrUX audit',
      description:
        "Measurement on 3 cross-checking sources.\nLighthouse for lab data, WebPageTest for filmstrip and waterfall, CrUX for real user data over the last 28 days.\nOnly after that we touch code."
    },
    {
      title: 'LCP < 2.5s',
      description:
        "Largest Contentful Paint below threshold.\nHero images served in modern format (AVIF/WebP), display font preload, fetchpriority on the cover, render-blocking CSS eliminated.\nFirst the content shows, then everything else."
    },
    {
      title: 'CLS < 0.1',
      description:
        "No annoying layout shift.\nExplicit dimensions on every image and iframe, height reserved for cookie banner and sticky header, font-display swap without jumps.\nThe site stops \"jumping\" while loading."
    },
    {
      title: 'INP < 200ms',
      description:
        "Interaction to Next Paint below threshold.\nLong tasks broken with yield, heavy events moved to requestIdleCallback, optimized hydration.\nClicks respond immediately, not after waiting for an 800KB JS bundle."
    },
    {
      title: 'Image + asset pipeline',
      description:
        'Images re-encoded in AVIF/WebP with fallback, native lazy loading, responsive srcset.\nFont preload only for above-the-fold weights.\nJS bundle analyzed and tree-shaken without dead dependencies.\nNo "secret optimizations": measurable and replicable.'
    },
    {
      title: 'Before/after report',
      description:
        "Lighthouse + WebPageTest snapshot before and after, with waterfalls compared and numbers on key metrics.\nIf the delta isn't visible in data, the work isn't done.\nNo decorative screenshots: numbers."
    }
  ],
  benefits: [
    'The site passes the Core Web Vitals check without compromises.',
    'Mobile bounce rate drops because the first paint arrives in time.',
    'Google stops penalizing for Page Experience.',
    'TTFB drops below 600ms, perceived as instant.',
    'The report is readable by non-technical people, with comparable before/after.'
  ],
  process: [
    {
      step: 1,
      title: 'Baseline audit',
      description:
        "I measure current state on 5-10 critical pages: home, products/work list, detail, checkout (if e-commerce), main landing.\nLighthouse + WebPageTest + CrUX.\nI identify bottlenecks per metric."
    },
    {
      step: 2,
      title: 'Priority diagnosis',
      description:
        "I order fixes by impact/effort.\nLCP is almost always the first target because it unlocks ranking. CLS and INP come later.\nNo full-stack refactor: only fixes that move the needle."
    },
    {
      step: 3,
      title: 'Fix implementation',
      description:
        'I apply fixes in order: image pipeline, font loading, render-blocking cleanup, JavaScript splitting, layout reservation.\nEvery fix gets tested in isolation to avoid regressions.'
    },
    {
      step: 4,
      title: 'Verification + re-audit',
      description:
        "I re-measure on Lighthouse + WebPageTest.\nCompare numbers before/after. If a metric doesn't pass, I identify why and iterate.\nNo \"we did our best\": the check passes."
    },
    {
      step: 5,
      title: 'Handoff + monitoring',
      description:
        'Delivery of report with numbers, waterfall snapshots and maintenance checklist.\nOptional setup of continuous monitoring (PageSpeed Insights API or equivalent) to catch regressions before Google sees them.'
    }
  ],
  faqs: [
    {
      question: 'How long does it take to pass the Core Web Vitals check?',
      answer:
        'Depends on how badly the starting site is set up.\nA modern site with some targeted fixes gets sorted in 1-2 weeks.\nA legacy site with monolithic jQuery, outdated WordPress plugins and 4MB PNGs takes longer, because hosting or build pipeline often need touching.\nThe first audit clarifies the real size of the work.'
    },
    {
      question: 'Can I do it without changing hosting?',
      answer:
        'Almost always yes.\nMost problems are in code and assets, not the server.\nBut if hosting is shared and TTFB stays above 1 second even after cache + CDN, the only way is to change it.\nPromising "miraculous performance" on €3/month shared hosting is worthless.'
    },
    {
      question: 'My site is on WordPress: does anything change?',
      answer:
        'No, the metrics are the same.\nThe toolkit changes: caching plugin (W3 Total Cache, WP Rocket), image optimizer, WP_Query optimization, possible migration to WP-tuned hosting.\nFor more serious cases, I flag headless migration or alternative CMS, but it\'s rare.'
    },
    {
      question: 'Do you guarantee the check always passes?',
      answer:
        "No, and whoever guarantees it lies.\nI guarantee applying measurable best practices and documenting every fix with before/after.\nOn very large sites or with constraints (third parties, heavy tracking, video embeds) some metrics can stay borderline.\nIn that case I say so upfront, not at project end."
    },
    {
      question: 'What happens if I change the site after optimization?',
      answer:
        "Without maintenance, metrics degrade within months: new plugins, unoptimized photos, added tracking scripts.\nThat's why I deliver an operational checklist and, if needed, a quarterly monitoring retainer."
    },
    {
      question: 'Do you only work on sito-v3 / Next.js or other stacks too?',
      answer:
        "I work on any stack: WordPress, Shopify, Webflow, custom React/Vue/Next, static Hugo/Astro.\nThe principle doesn't change: I measure, identify, fix, re-measure.\nThe toolkit changes, the metrics stay LCP, CLS, INP."
    }
  ],
  awareness: {
    title: 'A slow site is an invisible site',
    subtitle:
      "Google penalizes sites that fail the Core Web Vitals check.\nMobile is where everything happens: if the first paint arrives in 4 seconds, users leave.",
    problems: [
      {
        icon: 'ph-clock-countdown',
        title: 'Hero taking 6 seconds',
        desc: 'Cover image served as 3-4MB PNG, without fetchpriority, behind a cookie banner that blocks render.\nLCP out of threshold, first visitors already bounced before seeing the title.'
      },
      {
        icon: 'ph-arrows-vertical',
        title: 'Layout jumping while you read',
        desc: "Cookie banner without reserved height, hero without explicit dimensions, fonts changing weight mid-render.\nCLS over 0.25, the user clicks where they didn't want and the site loses trust immediately."
      },
      {
        icon: 'ph-spinner-gap',
        title: 'Clicks that respond after 1 second',
        desc: 'Blocking JavaScript, hydration in a single block, listeners causing layout reflow.\nINP over 500ms.\nThe user presses "Add to cart" twice because the first click looks ignored.'
      }
    ]
  },
  expandedScope: {
    eyebrow: 'POST-AUDIT',
    title: "Performance isn't a one-shot fix",
    body:
      "The Core Web Vitals check is green today.\nThe next deploy arrives with another heavy image, a new tracking plugin, an embedded video added on the fly.\nWithout continuous monitoring, metrics degrade in months.\n\nThat's why after the audit I deliver an operational checklist: what to check before publishing every new page, how to optimize images autonomously, when to re-audit.\n\nFor sites with significant traffic or critical e-commerce, I activate quarterly monitoring: PageSpeed Insights API + alerts on real regressions.\nNo smoky dashboards: just the numbers needed to intervene before Google sees them."
  }
};
