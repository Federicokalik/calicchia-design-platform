// EN translation of seo.ts — Round 5a manual continuation.

import type { ServiceDetail } from '../../services-detail';
import { PROCESS_STEPS_EN } from '../_shared/process';

export const SEO_SERVICE_EN: ServiceDetail = {
  slug: 'seo',
  title: 'SEO & Visibility',
  icon: 'ph-magnifying-glass',
  description:
    "If Google doesn't bring traffic, more smoke won't help:\nwe need to understand what's blocking crawl, content and local trust.",
  longDescription:
    "A site can be online, nice to look at and completely invisible.\nIt happens when technical SEO, content and local presence get split between agencies, random plugins, shared hosting and reports full of useless graphs.\n\nHere we start from facts: Core Web Vitals, crawlability, indexing, Search Console, content, Google Business Profile, citations and reviews.\nThen we put things in order: pages readable by Google, correct schema markup, sector-specific editorial plan and monthly monitoring that says what's going up, what's standing still, and why.\n\nNo televendor promises about page one.\nJust trackable work on what's preventing the site from being found. Period.",
  features: [
    {
      title: 'Technical SEO audit',
      description:
        "Analysis of Core Web Vitals, crawl, indexing, sitemap, robots, redirects, canonicals, server errors and slow templates.\nFirst we discover where Google gets stuck, then we decide what to fix."
    },
    {
      title: 'Keywords and content',
      description:
        "Keyword research connected to the industry, not to the fantasy of the month.\nWe build a content plan with clear priorities: service pages, articles, search intents, cannibalizations and truly defensible opportunities."
    },
    {
      title: 'Concrete local SEO',
      description:
        "Google Business Profile, NAP citations, categories, descriptions, photos, services, reviews and consistency between directories.\nIf the business works on a territory, the local listing can't stay abandoned."
    },
    {
      title: 'On-page and schema',
      description:
        'Titles, headings, meta, internal linking, content, structured data and schema markup get fixed page by page.\nNo plugins left to generate code at random without control.'
    },
    {
      title: 'White-hat link building',
      description:
        "Clean link acquisition, consistent with industry and reputation.\nNo toxic packages, recycled domains or shortcuts that look smart today and become a problem tomorrow."
    },
    {
      title: 'Readable monthly monitoring',
      description:
        "Rank tracking, Google Search Console, GA4 and understandable monthly reports.\nWe look at what's changing, which queries are coming in, which pages are growing, and which interventions make sense next."
    }
  ],
  benefits: [
    "You understand why the site doesn't generate organic traffic.",
    "You reduce waste on smoky SEO reports.",
    "You bring order between site, content and local presence.",
    "You see readable metrics, not screenshots without context.",
    "You build organic visibility without theatrical-agency promises."
  ],
  process: PROCESS_STEPS_EN,
  faqs: [
    {
      question: 'Do you guarantee page one on Google?',
      answer:
        "No.\nWhoever promises page one is selling a comfortable phrase, not real control over Google.\nYou can work on technical SEO, content, authority, local SEO and measurement.\nYou can increase the probability of ranking well on sensible queries.\nBut promising a precise position is agency theater, not serious SEO."
    },
    {
      question: "My site is online but doesn't get organic traffic. Where do we start?",
      answer:
        "We start from Search Console, crawl, indexing, performance, page structure and content.\nOften the site doesn't get found because Google crawls badly, indexes the wrong pages, finds weak content or receives inconsistent local signals.\nFirst we measure the block, then we intervene. Skipping this phase means working blind."
    },
    {
      question: 'Do I need to publish articles every week?',
      answer:
        "Not necessarily.\nPublishing a lot doesn't compensate for a wrong strategy.\nFirst you need solid service pages, clear keywords, clean internal structure and content that answers real searches.\nThen we decide if the blog makes sense, with what topics and with what frequency.\nThe editorial calendar shouldn't become a filler factory."
    },
    {
      question: 'Does Google Business Profile really matter for local SEO?',
      answer:
        "Yes, especially if you work on a precise geographic area.\nAn incomplete listing, frozen reviews, wrong categories and inconsistent NAP between directories send weak signals.\nGoogle Business isn't a window to open and forget: it has to be kept tidy, updated and consistent with site, services and territory."
    },
    {
      question: "What if I already have an SEO agency?",
      answer:
        "We look at what's been done, what's measurable and what's standing still.\nIf there are monthly reports without data access, vague activities or unverifiable promises, the problem isn't personal: it's operational.\nSerious SEO leaves controllable traces in GSC, GA4, rankings, optimized pages and documented decisions."
    },
    {
      question: 'How long does it take to see results?',
      answer:
        "Depends on technical state, competition, domain authority, site history and content solidity.\nSEO isn't a switch.\nSome technical problems produce fast effects after correction, other activities require continuity.\nThe important thing is to read the right signals: queries, impressions, clicks, positions and conversions. You decide."
    }
  ],
  awareness: {
    title: "Organic traffic doesn't disappear by chance",
    subtitle:
      'Usually it gets choked by neglected tech, weak content and half-built local presence.',
    problems: [
      {
        icon: 'ph-warning-circle',
        title: 'Invisible site',
        desc: "The site exists, but Google reads it badly or doesn't consider it relevant.\nSlow pages, confused structure, copied content and dirty indexing block traffic before keywords even matter."
      },
      {
        icon: 'ph-chart-line-down',
        title: 'Reports without proof',
        desc: "Colorful graphs, English words and no clear decision.\nIf the report doesn't connect activities, data and impact, it's not driving SEO: it's filling a meeting."
      },
      {
        icon: 'ph-storefront',
        title: 'Abandoned local',
        desc: 'Google Business not updated, frozen reviews, addresses written different ways and directories left to chance.\nFor who works on the territory, this neglect costs visibility every day.'
      }
    ]
  },
  expandedScope: {
    eyebrow: 'AFTER LAUNCH',
    title: "SEO doesn't end when you publish",
    body:
      "The problem with broken-up SEO is always the same: someone touches the site, someone writes copy, someone installs plugins, someone looks at Google Business occasionally, and nobody answers for results.\n\nAfter launch we keep everything in the same frame: performance, crawl, indexed pages, keywords, content, schema markup, links, local listing, citations and reviews.\nEvery month we check what Google sees, what it rewards, what it ignores and what's getting worse.\n\nIf shared hosting slows everything down, we flag it.\nIf a plugin dirties the markup, we remove or replace it.\nIf the content plan produces useless pages, we cut.\nSEO doesn't need theater: it needs technical responsibility, editorial judgment and continuity. Period."
  }
};
