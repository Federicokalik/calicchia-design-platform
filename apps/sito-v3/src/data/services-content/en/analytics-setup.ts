// EN translation of analytics-setup.ts — Round 5a manual continuation.

import type { ServiceDetail } from '../../services-detail';
import { PROCESS_STEPS_EN } from '../_shared/process';

export const ANALYTICS_SETUP_SERVICE_EN: ServiceDetail = {
  slug: 'analytics-setup',
  title: 'Analytics & Tag Manager',
  icon: 'ph-chart-line-up',
  description:
    "You have a site but you don't know who buys, who bounces, where they come from.\nCorrect GA4 + GTM setup, conversion events tracked, dashboard read in 5 minutes.",
  longDescription:
    "Universal Analytics is dead since July 2023.\nMost sites have \"something\" on GA4: a default setup imported badly, events not configured, conversions that don't trigger, missing consent mode.\nResult: every month you look at numbers that mean nothing.\n\nHow many added to cart? How many completed the form? Which traffic source actually converts?\nWithout a serious setup, the site is a black box.\n\nYou don't need to install 30 tags: you need a clean GA4 property, a tidy GTM container, the right events for your business model (e-commerce, lead gen, content, SaaS), Consent Mode v2 to not break tracking and stay GDPR-compliant, a Looker Studio dashboard that reads in 5 minutes without opening 12 screens.\n\nI configure everything, document every event, teach you what to look at.\nNo decorative \"executive reports\": just the numbers that let you decide whether to change the site, the ad, the funnel.",
  features: [
    {
      title: 'Clean GA4 property',
      description:
        'New property or cleanup of an existing one: data stream configured, internal traffic filter, cross-domain tracking if needed, debug mode, retention set to 14 months (max non-paid).\nNo \"enhanced ecommerce\" account with 50 events disabled by default.'
    },
    {
      title: 'Tidy GTM container',
      description:
        "Tag Manager with logical folders by type (analytics, ads, conversion API), clear naming convention (TY1-Pageview, AY2-Click-CTA, EY3-Form-Submit), reusable triggers, centralized variables.\nWhoever comes after understands the logic in 10 minutes, not after 2 weeks."
    },
    {
      title: 'Conversion events that matter',
      description:
        'Events specific to your business: e-commerce (view_item, add_to_cart, begin_checkout, purchase), lead gen (form_submit, phone_click, whatsapp_click), content (scroll_depth, video_engagement).\nNo generic \"click\" event that says nothing.'
    },
    {
      title: 'Consent Mode v2 (GDPR)',
      description:
        'Cookiebot / Iubenda / custom banner integration with Google Consent Mode v2.\nActive tracking with aggregated data even before consent (modeled conversions), full tracking after accept.\nNo \"tracking turned off under banner\" that loses you 40% of data.'
    },
    {
      title: 'Looker Studio dashboard',
      description:
        "Personalized dashboard that shows only what matters: traffic source by conversion, checkout/lead funnel, top-performing pages, on-site searches, device + zone.\nSingle page readable in 5 minutes, daily refresh, shared access with the team."
    },
    {
      title: 'Documentation + handoff',
      description:
        'Spreadsheet with every tracked event: name, trigger, variable, business meaning, where it gets read.\nPlus a \"5 numbers to check every Monday\" guide.\nIf you change consultant or add one, they pick up where I left off without reverse engineering.'
    }
  ],
  benefits: [
    'You know who converts, where they come from, what actually works.',
    'GA4 + GTM tidy, reusable, maintainable even after my handoff.',
    'Consent Mode v2 active: GDPR-compliant without losing modeled tracking.',
    'Looker Studio dashboard readable in 5 minutes, shared with the team.',
    'Documentation that avoids \"but what does this event do?\" in the months after.'
  ],
  process: PROCESS_STEPS_EN,
  faqs: [
    {
      question: 'Is Universal Analytics still useful?',
      answer:
        "No, it's been dismissed since July 2023.\nHistorical UA data was still consultable until July 1, 2024 (now in 2026 it's already been deleted in free properties).\nIf someone tells you \"we keep Universal Analytics\", run. We work only on GA4."
    },
    {
      question: 'Do I have to use GTM or can I put GA4 code on the site?',
      answer:
        "Technically you can, but it's a terrible idea.\nWithout GTM every new event requires code modification + deploy.\nWith GTM you add an event in 5 minutes without touching the site.\nPlus GTM unifies Google Ads conversion, Meta Pixel, LinkedIn Insight, whatever else ads need. It's the standard."
    },
    {
      question: 'Is Consent Mode v2 really mandatory?',
      answer:
        "For who runs Google Ads in EEA + UK, yes, since March 6, 2024.\nWithout Consent Mode v2 Google Ads campaigns don't see conversions and automatic optimization degrades.\nFor who doesn't run Google Ads but uses only GA4, it's not strictly \"mandatory\", but it's the correct GDPR-compliant practice. I always configure it."
    },
    {
      question: 'Is the Looker Studio dashboard included or extra?',
      answer:
        "Included in the setup.\nLooker Studio (ex Data Studio) is free and connects natively to GA4.\nThe dashboard is personalized on your KPIs: e-commerce will have checkout funnel, lead gen will have form funnel + traffic source, content will have scroll depth + time on page. Single page readable."
    },
    {
      question: 'Can I integrate Meta Pixel, TikTok Ads, LinkedIn Insight?',
      answer:
        "Yes, all via GTM.\nMeta Pixel + Conversion API setup (server-side to overcome iOS 14.5 and ad blockers) is included if needed.\nTikTok Pixel, LinkedIn Insight, Pinterest, Reddit Ads: all managed via GTM with consent gating. No direct code in the site."
    },
    {
      question: 'What happens after handoff? If I want to add an event?',
      answer:
        "You have admin access to GTM container and GA4 property.\nThe documentation explains how to duplicate an existing trigger to add a similar event.\nFor bigger changes (new funnel, new domain, CRM integration) I can do a quarterly retainer, or on-demand intervention."
    }
  ],
  awareness: {
    title: 'Without serious analytics, you decide on feeling',
    subtitle:
      "A default GA4 imported badly is worse than nothing: it gives you wrong numbers and makes you take wrong decisions.\nYou need clean setup, business-driven events, managed consent.",
    problems: [
      {
        icon: 'ph-warning-circle',
        title: 'Default GA4',
        desc: 'Property created in 5 minutes without configuration, 2-month retention (default max), zero internal traffic filters, zero custom events.\nYou see \"pageview\" and that\'s it.\nWhen marketing asks \"which ad converts?\", silence.'
      },
      {
        icon: 'ph-cookie',
        title: 'Cookie banner that turns everything off',
        desc: 'Banner installed badly: without consent, GTM doesn\'t start, GA4 receives nothing, Google Ads doesn\'t see conversions.\nResult: 40-60% of EU visitors (who click \"reject\") aren\'t tracked at all.\nModeled conversions never activated.'
      },
      {
        icon: 'ph-clipboard-text',
        title: 'Undocumented events',
        desc: 'GTM container with 47 tags, random naming (\"tag_2024_test\", \"click-ok\"), no owner.\nWhoever comes after spends 3 weeks understanding what does what.\nOften the setup gets redone from scratch because it\'s faster than reverse engineering.'
      }
    ]
  },
  expandedScope: {
    eyebrow: 'POST-SETUP',
    title: 'Analytics is for deciding, not filling dashboards',
    body:
      "GA4 + GTM configured, dashboard up.\nNow the point is using them. Every month (or quarter if you're small) we look at: what converts, what bounces, where you lose money in the funnel.\nDecisions depend on numbers, not feeling.\n\nWithout a periodic check, the dashboard becomes decoration and the setup degrades (new tags added without naming, duplicate events, Consent Mode broken by a banner update).\n\nFor sites with significant ads investment or e-commerce, I activate a quarterly retainer: dashboard review, identification of the 3 most impactful levers, operational action plan.\nNo \"we grew 12%\": you need to know why, where, what to do now."
  }
};
