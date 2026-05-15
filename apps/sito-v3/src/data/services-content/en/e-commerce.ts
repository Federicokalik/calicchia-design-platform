// EN translation of e-commerce.ts — Round 5a manual continuation.

import type { ServiceDetail } from '../../services-detail';
import { PROCESS_STEPS_EN } from '../_shared/process';

export const E_COMMERCE_SERVICE_EN: ServiceDetail = {
  slug: 'e-commerce',
  title: 'E-Commerce',
  icon: 'ph-shopping-cart',
  description:
    'E-commerce with catalog, checkout, payments, shipping and emails under control.\nNo plugins thrown in.',
  longDescription:
    "A physical store works when the shutter is up.\nOnline, competitors sell while you're closing the till.\n\nThe problem isn't \"build a site with a cart\": it's avoiding the chain of providers that puts in a heavy theme, three random plugins, shared hosting and a fragile checkout.\n\nHere we build an e-commerce with clear structure: catalog, variants, inventory, payments, shipping, transactional emails and cart recovery.\nWooCommerce when it makes sense, headless when the case demands it.\n\nIn a 180-SKU catalog, one wrong shipping rule is enough to burn orders every week.\nFewer hand-offs, more control on the points that block sales.\nPeriod.",
  features: [
    {
      title: 'Catalog under control',
      description:
        'Products, categories, variants, attributes and inventory get set up with commercial logic, not loaded in blocks without criteria.\nSizes, colors, availability and SKUs have to be readable for buyers and manageable for sellers.'
    },
    {
      title: 'Frictionless checkout',
      description:
        "Checkout stays clean: necessary data, clear payment methods, understandable errors, no useless steps.\nIf 9 fields are needed to buy a simple product, the cart is already losing people."
    },
    {
      title: 'Multi-courier shipping',
      description:
        "Zones, thresholds, shipping classes, couriers and operational rules get put in order before launch.\nIf shipping is confused, the cart dies right there. End of story."
    },
    {
      title: 'Emails that arrive',
      description:
        "Order confirmations, payments, shipping, password resets and cart recovery can't depend on luck.\nWe set up a serious email flow, with correct senders, readable templates and tracking on critical events."
    },
    {
      title: 'Schema for Shopping',
      description:
        'Product, Offer, price, availability, brand and identifiers get prepared for Google Shopping and organic search.\nThe catalog has to be understood by platforms, not just seen in the browser.'
    },
    {
      title: 'Stack without mess',
      description:
        'No bloated theme, plugins installed because "maybe useful", and cheap hosting.\nThe platform is chosen on the case: WooCommerce for fast editorial management, headless when performance and integrations matter more.'
    }
  ],
  benefits: [
    'You sell even when the physical store is closed.',
    'You bring customers to your channel, not just to marketplaces.',
    'You manage catalog, orders and availability without scattered spreadsheets.',
    'You reduce abandoned carts from slow or confusing checkout.',
    'You prepare the catalog for Google Shopping and targeted campaigns.'
  ],
  process: PROCESS_STEPS_EN,
  faqs: [
    {
      question: 'Better WooCommerce or headless e-commerce?',
      answer:
        "Depends on catalog, internal management and integrations.\nWooCommerce works when you need editorial autonomy, fast product management and a familiar panel.\nHeadless makes sense when performance, dedicated frontend and connections with external systems matter more.\nThe choice is made on real work, not on current fashion."
    },
    {
      question: 'Can I sell online if I already have a physical store?',
      answer:
        "Yes, and it's often the most sensible case.\nThe physical store stays the strong point, but online covers people who don't pass through your area, who buy outside hours, and who look for you after seeing you on social or Google.\nSelling only to those who come through the door is a technical limit, not a law."
    },
    {
      question: 'Can products already in a management system be imported?',
      answer:
        'Yes, if the management system exposes clean data or reliable exports.\nFirst we check fields, codes, variants, stock, images and categories.\nImporting a catalog badly creates chaos: duplicate products, wrong availability, useless filters.\nBetter to fix the structure first, then automate.'
    },
    {
      question: 'How are payments and security handled?',
      answer:
        "Stripe, PayPal, bank transfer and cash on delivery get configured according to the company flow.\nPayment data can't pass through improvised paths: we use serious gateways, HTTPS, correct roles, controlled updates and limited access.\nCheckout is where amateurism costs lost orders."
    },
    {
      question: 'Does cart recovery really work?',
      answer:
        "It works when set up properly.\nIt's not enough to send a generic email to whoever abandons.\nYou have to distinguish registered customer, real cart, consent, sending times and useful content.\nCart recovery doesn't save a terrible checkout, but it recovers sales that would otherwise disappear."
    },
    {
      question: 'What happens after launch?',
      answer:
        "After launch we look at what really happens: orders, payment errors, undelivered emails, most-viewed products, abandoned carts, Shopping feeds and slow pages.\nAn e-commerce doesn't end when it goes online.\nIt begins when traffic, questions and real orders arrive."
    }
  ],
  awareness: {
    title: 'The marketplace takes customers who could be yours',
    subtitle:
      "If you don't have a direct channel, somebody else intercepts demand in your place.",
    problems: [
      {
        icon: 'ph-storefront',
        title: 'Shutter vs 24/7',
        desc: "The physical store sells when it's open.\nOnline, competitors take in money in the evening, on holidays, and while you're doing inventory."
      },
      {
        icon: 'ph-shopping-cart',
        title: 'Customers handed to marketplaces',
        desc: "Amazon and generic platforms don't wait.\nIf your catalog isn't directly purchasable, they take traffic, customer data and the commercial relationship."
      },
      {
        icon: 'ph-warning-circle',
        title: 'Plugins without control',
        desc: 'Heavy theme, shared hosting, plugins picked at random, slow checkout.\nThe classic six-handed chain where nobody really owns the problem.'
      }
    ]
  },
  expandedScope: {
    eyebrow: 'AFTER LAUNCH',
    title: 'The online store has to stay under pressure',
    body:
      "Launch isn't the finish line.\nIt's the first moment when the store meets real orders, declined cards, undecided customers, out-of-zone shipments, emails ending up in spam and products Google misinterprets.\n\nHere we look at the dirty part of e-commerce: Shopping feed, Product and Offer schema, abandoned carts, checkout performance, error logs, WooCommerce updates, plugin compatibility, inventory and email flows.\n\nThe chain of providers is the poison: one handles the theme, one the server, one the tracking, one the payments, and when something breaks the blame-passing starts.\nBetter to have clear technical direction and targeted interventions on the points that block orders and management.\nYou decide."
  }
};
