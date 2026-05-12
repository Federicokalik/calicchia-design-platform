import type {
  ServiceDeliverable,
  ServiceLeadMagnetCopy,
  ServiceRelated,
} from '../../services-detail';

export const E_COMMERCE_EXTRAS_EN = {
  deliverables: [
    { title: 'Catalog and variants map', format: '.xlsx + .md', timeline: 'week 1' },
    { title: 'Base store setup', format: 'CMS config', timeline: 'week 1-2' },
    { title: 'Payment gateways configured', format: 'Stripe/PayPal', timeline: 'week 2' },
    { title: 'Shipping rules and taxes', format: 'Config + .md', timeline: 'week 2' },
    { title: 'Structured product cards', format: 'CMS + CSV', timeline: 'week 2-3' },
    { title: 'Product and Offer schema', format: 'JSON-LD', timeline: 'week 3' },
    { title: 'Google Shopping feed', format: 'XML/CSV feed', timeline: 'week 3' },
    { title: 'Transactional emails', format: 'MJML/HTML', timeline: 'week 3' },
    { title: 'Orders dashboard', format: 'Admin panel', timeline: 'pre-launch' },
    { title: '12-scenario checkout test', format: 'Checklist', timeline: 'pre-launch' },
    { title: 'Catalog management training', format: 'Meet + .md', timeline: 'post-launch' },
  ] satisfies readonly ServiceDeliverable[],
  related: [
    {
      slug: 'web-design',
      title: 'Web Design',
      shortPitch:
        "Before the cart, you need a structure that makes clear what you sell and why.",
    },
    {
      slug: 'seo',
      title: 'SEO & Visibility',
      shortPitch:
        'Product schema, feed and clean categories decide how the catalog gets read.',
    },
    {
      slug: 'sviluppo-web',
      title: 'Web Development',
      shortPitch:
        "When inventory, ERP and marketplaces don't talk, you need real integration.",
    },
  ] satisfies readonly ServiceRelated[],
  leadMagnetCopy: {
    eyebrow: 'Free audit · 15 minutes',
    title: 'How many orders are you losing at checkout?',
    body:
      "I check cart, payments, emails and product feed. 15 minutes on Meet, no detour and no quote before problems.",
  } satisfies ServiceLeadMagnetCopy,
} as const;
