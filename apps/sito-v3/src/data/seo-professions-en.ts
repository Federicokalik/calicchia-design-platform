// EN translation of seo-professions.ts → PROFESSION_CATEGORIES only.
// Voice anti-marketing preserved. NO PRICES anywhere (memory: feedback_no_prezzi_in_copy).
//
// EN translation status (audit 2026-05-15):
//   - Category labels + descriptions: HERE (PROFESSION_CATEGORIES_EN).
//   - Profession `label`: seo-professions-labels-en.ts (PROFESSION_LABELS_EN).
//   - Profession tagline/searchExample: seo-profession-content-en.ts
//     (PROFESSION_CONTENT_EN).
//   All three are exposed via locale-aware getters in seo-professions.ts
//   (getProfessionCategories, getAllProfessionsLocalized,
//   getProfessionContentLocalized). Consumers MUST use those getters; do not
//   import the EN constants directly outside of the getters.
//
// EN route availability for the SEO matrix:
//   - /sito-web-per-<professione>            → works (EN rendered as
//     /en/website-for-<prof-en> via [...matrix] page; content + metadata are
//     locale-aware).
//   - /sito-web-per-<professione>-a-<città>  → BLOCKED on EN (notFound in
//     [...matrix]/page.tsx parseMatrix — matrix+città IT-only).
//   - /zone/<comune>/<service>               → BLOCKED on EN (notFound guard
//     in /zone/[comune]/[service]/page.tsx — zone+service IT-only).
//   - /zone/<comune>                         → accessible on EN routing-wise
//     but content is still hardcoded IT (not yet translated).
// There is NO Next.js middleware in this app; the blocks above are explicit
// notFound() guards inside the page modules.

import type { ProfessionCategory } from './seo-professions';

export const PROFESSION_CATEGORIES_EN: Record<string, ProfessionCategory> = {
  'beauty-wellness': {
    id: 'beauty-wellness',
    label: 'Beauty & Wellness',
    description:
      "In beauty and wellness, the first impression matters — and today that first impression happens online.\nYour customers search Google before booking. If they cannot find you, they book with someone else.",
    problems: [
      {
        icon: 'ph-instagram-logo',
        title: "Instagram is not enough",
        desc: "You have a polished profile but the leads are not coming in.\nSocial media on its own is not enough: you need a solid base, your own site, that does not depend on the algorithm.",
      },
      {
        icon: 'ph-calendar-blank',
        title: "Zero bookings from the web",
        desc: "Customers want to book from their phone in 30 seconds.\nIf they cannot do it from your site, they go where they can.",
      },
      {
        icon: 'ph-magnifying-glass',
        title: "Invisible on Google",
        desc: "Someone searches for a service near them and you do not show up.\nYou are handing customers to the competitor every single day.",
      },
    ],
    features: [
      {
        title: 'Showcase site with work gallery',
        description: "Show your best work with before/after photos that speak for themselves. Customers want to see what you can do.",
      },
      {
        title: 'Online or WhatsApp booking',
        description: "One button to book right away — via form, WhatsApp, or hooked into your existing system. Convenient for you, convenient for them.",
      },
      {
        title: 'Local SEO',
        description: "I make you findable on Google when people search for your service in your area. Real results, not promises.",
      },
      {
        title: 'Social integration',
        description: "Your Instagram feed embedded in the site. Your work always visible without making the customer hunt for it.",
      },
      {
        title: 'Optimized Google Business',
        description: "Complete Google profile, with photos, hours, reviews and a link to the site. So you also show up on Google Maps.",
      },
    ],
    faqs: [
      {
        question: "Do I really need a site if I already have Instagram?",
        answer: "Yes. Instagram is rented space — the rules can change tomorrow. The site is yours, you control it, and it makes you findable on Google. They are two things that work together, not one instead of the other.",
      },
      {
        question: "How much does a site for my industry cost?",
        answer: "We talk numbers after we talk scope. First a 15-minute call, then a written quote with what you get and the timeline. No price lists, no surprises.",
      },
      {
        question: "Can I manage the site myself?",
        answer: "Yes. I show you how to swap photos, add services and update prices. And if you get stuck, you write me.",
      },
      {
        question: "How long does it take?",
        answer: "A showcase site: 10–15 working days. With extra functionality (booking, product e-commerce): up to 30 days.",
      },
      {
        question: "Will the site help me get more customers?",
        answer: "If it is built well, yes. A site optimized for your area gets you found by people who are already searching for what you offer. Not magic — strategy.",
      },
    ],
    ctaText: "Want your next customers to find you online?",
  },

  'sanita-salute': {
    id: 'sanita-salute',
    label: 'Healthcare',
    description:
      "For a healthcare professional, the website is not a vanity item — it is a trust tool.\nPatients search online, read, compare. Whoever has a clear, professional site starts ahead.",
    problems: [
      {
        icon: 'ph-magnifying-glass',
        title: "Patients cannot find you",
        desc: "They search for a specialist in your city and find your colleagues.\nWithout an optimized site, you are invisible exactly when they look for you.",
      },
      {
        icon: 'ph-phone-disconnect',
        title: "Too many contacts lost",
        desc: "Phone busy, voicemail full, hours closed.\nWithout a way to reach you online, patients give up.",
      },
      {
        icon: 'ph-warning-circle',
        title: "Outdated image",
        desc: "An old or absent website does not communicate professionalism.\nPatients want to feel they are in good hands — also from the site.",
      },
    ],
    features: [
      {
        title: 'Professional presentation',
        description: "Who you are, what you do, where you work, your specializations. All clear, all readable, all in the right place.",
      },
      {
        title: 'Contact / booking system',
        description: "Contact form, appointment request, or integration with your existing system. Patients reach you when they want.",
      },
      {
        title: 'Treatment pages',
        description: "Each service explained clearly and accessibly — without jargon, without fear. Patients arrive already informed.",
      },
      {
        title: 'Local medical SEO',
        description: 'Optimization for searches in your area. "Physiotherapist in [city]" leads to your site, not the competitor.',
      },
      {
        title: 'Code-of-conduct compliance',
        description: "The site respects your professional order's rules. No misleading communication, no risk.",
      },
    ],
    faqs: [
      {
        question: "Does the site comply with my professional order?",
        answer: "Yes. I know the deontological guidelines for doctors, dentists, psychologists and other healthcare professionals. The site is built in compliance.",
      },
      {
        question: "Can I show prices and fees?",
        answer: "It depends on your professional order. In many cases you can indicate price ranges or invite people to request a quote. We work it out together.",
      },
      {
        question: "Do I need online booking?",
        answer: "It is not mandatory, but it makes a difference. A simple contact form or integration with your existing system cuts phone calls and saves you time.",
      },
      {
        question: "How much does it cost?",
        answer: "We talk price after we talk scope. First a short call to understand what you actually need, then a written quote with deliverables and timing.",
      },
      {
        question: "Can I update it myself?",
        answer: "Yes. I leave you a simple panel to edit text and photos. For structural changes, I am there.",
      },
    ],
    ctaText: "Want your patients to find you easily online?",
  },

  'studi-professionali': {
    id: 'studi-professionali',
    label: 'Professional Services',
    description:
      "Lawyers, accountants, consultants: word-of-mouth still works, but today it also passes through Google.\nWhoever looks for a professional, looks online. And expects to find a serious, clear, up-to-date website.",
    problems: [
      {
        icon: 'ph-user-circle',
        title: "No online presence",
        desc: "You are an excellent professional but online you do not exist.\nPotential clients look for you, do not find you, and go to someone else.",
      },
      {
        icon: 'ph-scales',
        title: "Generic, dated site",
        desc: "A site built years ago, with generic text and old design, does not communicate the expertise you have.\nWorse, it pushes people away.",
      },
      {
        icon: 'ph-chart-line-down',
        title: "No lead generation",
        desc: "The site is there but you never receive enquiries.\nIt is probably not built to convert. It is a static business card, not an active tool.",
      },
    ],
    features: [
      {
        title: 'Firm presentation',
        description: "Who you are, what you do, how you work. All told professionally but accessibly — not a wall of legalese.",
      },
      {
        title: 'Areas of practice',
        description: "Each service has its own page, with clear explanations. Whoever finds you knows immediately if you can help.",
      },
      {
        title: 'Structured contact system',
        description: "Smart forms that gather the right information. So you reply already prepared and the client feels taken seriously.",
      },
      {
        title: 'Local professional SEO',
        description: 'I get you found for searches in your city. "Divorce lawyer in [city]" leads to your site.',
      },
      {
        title: 'Blog and resources',
        description: "Articles that show your expertise and that Google rewards. Online authority that translates into offline trust.",
      },
    ],
    faqs: [
      {
        question: "Do you really need a site for a professional firm?",
        answer: "Yes. Even if you live off referrals, the first thing a potential client does is search you on Google. If they find nothing (or an old site), the impression is negative.",
      },
      {
        question: "Can I show case histories?",
        answer: "You can talk about your areas of practice and the results obtained in general terms, respecting professional confidentiality. I help you find the right way.",
      },
      {
        question: "How much does a site for a firm cost?",
        answer: "Pricing comes after the brief. We have a short call, I write up a fixed quote with everything in scope and the timeline. No rate cards, no surprises.",
      },
      {
        question: "Who writes the copy?",
        answer: "I can help write it or rewrite what you have. The point is that it sounds professional without being incomprehensible.",
      },
      {
        question: "Does it work for small firms too?",
        answer: "Especially for small firms. A well-built site levels the field: you communicate the same professionalism as a large practice.",
      },
    ],
    ctaText: "Want your firm to be found online?",
  },

  'casa-edilizia': {
    id: 'casa-edilizia',
    label: 'Home, Trades & Construction',
    description:
      "Plumbers, electricians, building contractors: when someone has a problem at home, they search online.\nIf they do not find you, they call someone else. A simple, well-made site changes everything.",
    problems: [
      {
        icon: 'ph-phone',
        title: "Word-of-mouth only",
        desc: "Word-of-mouth is great but has a limit: it does not scale.\nA site makes you visible to anyone searching for your service in your area.",
      },
      {
        icon: 'ph-magnifying-glass',
        title: "Invisible on emergencies",
        desc: '"Urgent plumber [city]" — if you do not show up on Google for these searches, you are losing the highest-paid jobs.',
      },
      {
        icon: 'ph-image',
        title: "No proof of your work",
        desc: "You do excellent work but never show it.\nWithout an online portfolio, customers have no way to trust you before calling.",
      },
    ],
    features: [
      {
        title: 'Showcase site with portfolio',
        description: "Your best work on display: before and after, types of intervention, areas served. Photos say more than a thousand words.",
      },
      {
        title: 'Direct contact',
        description: '"Call now" button, quote request form, WhatsApp. The customer reaches you the way they prefer.',
      },
      {
        title: 'Local SEO for emergencies',
        description: "You appear when people search for your service in your area — including urgent searches. The most urgent jobs pay better.",
      },
      {
        title: 'Areas served',
        description: "A clear map of where you work. The customer knows immediately if you can reach them.",
      },
      {
        title: 'Reviews and references',
        description: "Opinions from satisfied customers directly on the site. The strongest social proof there is.",
      },
    ],
    faqs: [
      {
        question: "Does a tradesperson really need a site?",
        answer: "Yes, absolutely. People search Google even for the plumber. Whoever has a site (even a simple one) gets the jobs that whoever does not, loses.",
      },
      {
        question: "How much does it cost?",
        answer: "We talk price after we talk scope. First a quick call, then a written quote that lists deliverables, timing and what is included. No moving targets.",
      },
      {
        question: "I am not great with computers...",
        answer: "No problem. I build the site, explain how it works in plain words, and if you need updates I take care of them.",
      },
      {
        question: "How do I get found in my area?",
        answer: "Local SEO optimization + Google Business profile. I get you to show up when people search for your service in your city.",
      },
      {
        question: "Can I show my work?",
        answer: "Of course, and I recommend it. A gallery with photos of your interventions is worth more than any description.",
      },
    ],
    ctaText: "Want customers in your area to find you on Google?",
  },

  'auto-mobilita': {
    id: 'auto-mobilita',
    label: 'Auto & Mobility',
    description:
      "Workshops, body shops, tyre shops: when the car has a problem, the first thing people do is search Google.\nIf you do not have a site, you are leaving those customers to your competitors.",
    problems: [
      {
        icon: 'ph-magnifying-glass',
        title: "No online visibility",
        desc: 'People search "workshop near me" and you do not show up.\nThat customer goes to someone else — even if you are better.',
      },
      {
        icon: 'ph-star',
        title: "Reviews scattered or absent",
        desc: "You have happy customers but no one knows.\nWithout visible reviews, new customers have no way to trust you.",
      },
      {
        icon: 'ph-clock',
        title: "No easy way to contact you",
        desc: "Phone busy, hours closed.\nIf the customer cannot reach you in 30 seconds, they call the next one on the list.",
      },
    ],
    features: [
      {
        title: 'Site with services and pricing',
        description: "All your services explained clearly, with indicative pricing if you want. The customer arrives already informed.",
      },
      {
        title: 'Online quote request',
        description: "Simple form for a quote. Even out of hours, even on Sunday. You reply when you can.",
      },
      {
        title: 'Local SEO',
        description: 'I get you found for "workshop in [city]", "tyre shop near me", "body shop [area]". The searches that matter.',
      },
      {
        title: 'Work gallery',
        description: "Photos of your best interventions. Customers see the quality of your work before they even call.",
      },
      {
        title: 'Google Maps and reviews',
        description: "Optimized Google profile with address, hours, photos and reviews. You also appear on the map.",
      },
    ],
    faqs: [
      {
        question: "Do I need a site if I already work well?",
        answer: "If you work well, imagine how you would do with more visibility. The site brings new customers — the ones who do not know you yet.",
      },
      {
        question: "How much does it cost?",
        answer: "We talk numbers after we talk scope. A short call, then a written quote with everything in. No rate cards.",
      },
      {
        question: "Can I publish prices?",
        answer: "Sure. You can put indicative pricing or invite people to request a tailored quote. We decide together what works best.",
      },
      {
        question: "How do I handle the requests?",
        answer: "You receive them by email or WhatsApp. No complicated dashboard — requests land where you already see them.",
      },
      {
        question: "Does it work for small businesses too?",
        answer: "Especially for small ones. A simple, well-built site puts you on the same level as the chains, at least online.",
      },
    ],
    ctaText: "Want your next customers to find you online?",
  },

  'food-hospitality': {
    id: 'food-hospitality',
    label: 'Food, Hospitality & Tourism',
    description:
      "Restaurants, bars, hotels, B&Bs: your customers decide where to go looking at their phones.\nMenu, photos, reviews, booking. If they do not find all of this on your site, they go elsewhere.",
    problems: [
      {
        icon: 'ph-fork-knife',
        title: "You depend only on third-party platforms",
        desc: "TripAdvisor, TheFork, Booking take commissions and control your visibility.\nYour own site makes you independent.",
      },
      {
        icon: 'ph-image',
        title: "No online identity",
        desc: "People want to see real photos, the menu, the atmosphere.\nIf they do not find this, they pick someone who shows them.",
      },
      {
        icon: 'ph-calendar-blank',
        title: "Bookings only by voice",
        desc: "Phone ringing during service, missed messages, forgotten bookings.\nAn online system solves all of it.",
      },
    ],
    features: [
      {
        title: 'Site with menu and photos',
        description: "Always-updated menu, professional photos of the rooms and dishes. Customers arrive already hungry.",
      },
      {
        title: 'Table / room booking',
        description: "Integrated booking system — form, WhatsApp or hooked into your existing system. Zero commissions.",
      },
      {
        title: 'Local SEO',
        description: '"Restaurant in [city]", "B&B [area]" — I get you to show up where tourists and locals search.',
      },
      {
        title: 'Complete Google Business',
        description: "Google profile with hours, photos, menu, booking link. The business card everyone sees.",
      },
      {
        title: 'Social integration',
        description: "Your photos from Instagram embedded in the site. Everything connected with no extra work.",
      },
    ],
    faqs: [
      {
        question: "Is the page on TripAdvisor / Booking not enough?",
        answer: "Those pages are not yours — tomorrow they change the rules and there is nothing you can do. The site is yours, pays no commissions and works for you 24/7.",
      },
      {
        question: "Can I update the menu myself?",
        answer: "Yes, easily. New dish? Price change? You do it in 2 minutes from your phone or computer.",
      },
      {
        question: "How much does it cost?",
        answer: "Pricing comes after a short call. I write up a fixed quote with deliverables and timing. No price lists, no surprises.",
      },
      {
        question: "Does it work for events or catering too?",
        answer: "Absolutely. We add an events section, a form for custom requests, and a gallery of past setups.",
      },
      {
        question: "Will it help me get more bookings?",
        answer: "A site optimized for your area gets you found by people actively searching where to eat or sleep. More visibility = more bookings.",
      },
    ],
    ctaText: "Want to fill the tables (or rooms) with customers who find you online?",
  },

  'retail-negozi': {
    id: 'retail-negozi',
    label: 'Retail & Shops',
    description:
      "Even the shop down the road needs to be findable online.\nNot necessarily to sell on the internet — but to let people know you exist, what you sell, and why it is worth coming to you.",
    problems: [
      {
        icon: 'ph-storefront',
        title: "You exist offline only",
        desc: "If someone searches for your kind of shop in your city, they do not find you.\nThey go to whoever is findable — even if they are worse.",
      },
      {
        icon: 'ph-shopping-bag',
        title: "No digital storefront",
        desc: "Customers want to see what you have before coming in.\nWithout a site, they skip the trip.",
      },
      {
        icon: 'ph-phone-disconnect',
        title: "Information impossible to find",
        desc: "Hours, address, availability: if the customer has to dig too much, they lose patience and go elsewhere.",
      },
    ],
    features: [
      {
        title: 'Online product showcase',
        description: "Your best products on display: categories, photos, prices. The customer arrives at the shop already convinced.",
      },
      {
        title: 'Always-updated info',
        description: 'Hours, address, parking, contacts — all clear and accessible. No more "are you open today?".',
      },
      {
        title: 'Local SEO',
        description: 'I get you found for searches in your area. "Florist in [city]", "hardware [neighborhood]" — the searches that bring customers in-store.',
      },
      {
        title: 'WhatsApp and direct contact',
        description: "The customer sees a product on the site and writes to you immediately. No useless steps.",
      },
      {
        title: 'Google Maps and Google profile',
        description: "Your shop visible on the map, with photos, reviews and hours. Whoever searches near you, finds you.",
      },
    ],
    faqs: [
      {
        question: "If I have a physical shop, do I need a site?",
        answer: "Yes. The site does not replace the shop — it makes it more visible. People also Google the bakery. Whoever shows up, wins.",
      },
      {
        question: "I do not want to sell online, just be known.",
        answer: "Perfect. A showcase site does exactly that: shows what you do, where you are and how to reach you. Simple and effective.",
      },
      {
        question: "How much does it cost?",
        answer: "We talk numbers after we talk scope. Short call, then a written quote. No price lists in the open.",
      },
      {
        question: "Can I add products myself?",
        answer: "Yes. I leave you a panel where you can add photos, descriptions and prices in full autonomy.",
      },
      {
        question: "And if later I want to sell online too?",
        answer: "The site can grow into an e-commerce when you want. We start from the showcase and grow together.",
      },
    ],
    ctaText: "Want people in your area to discover your shop?",
  },

  'creativita-eventi': {
    id: 'creativita-eventi',
    label: 'Creative & Events',
    description:
      "Photographers, videomakers, wedding planners, event organizers: your work is visual, emotional, experiential.\nYour site has to make people feel the same things — and bring you the right clients.",
    problems: [
      {
        icon: 'ph-image',
        title: "Portfolio scattered everywhere",
        desc: "A bit on Instagram, a bit on Behance, a bit on Google Drive.\nWithout a site that pulls it together, your work loses impact.",
      },
      {
        icon: 'ph-tag',
        title: "Picked only on price",
        desc: "If the client does not understand the value of what you do, they only compare prices.\nA well-built site communicates the why before the how-much.",
      },
      {
        icon: 'ph-megaphone-simple',
        title: "Hard to find new clients",
        desc: "Word-of-mouth has a limit.\nThe site opens you up to a new audience — people who are searching for exactly you, but have not found you yet.",
      },
    ],
    features: [
      {
        title: 'Professional portfolio',
        description: "Your best work, organized by category, with the visual quality it deserves. Full screen, no distractions.",
      },
      {
        title: 'Service / package pages',
        description: "Each service explained clearly: what is included, how it works, who it is for. The client knows immediately if you fit.",
      },
      {
        title: 'Quote request',
        description: "Structured form that gathers the right information. You reply already prepared and save time for both.",
      },
      {
        title: 'SEO for your industry',
        description: '"Wedding photographer [city]", "videomaker [area]" — I get you found by people already searching for what you do.',
      },
      {
        title: 'Social and video integration',
        description: "YouTube, Vimeo, Instagram embedded in the site. Your work always visible, in one place.",
      },
    ],
    faqs: [
      {
        question: "Is an Instagram / Behance profile not enough?",
        answer: "Social media is rented space. The site is yours, you control it, and it positions you on Google. Together they work better than alone.",
      },
      {
        question: "Can the site handle a very large portfolio?",
        answer: "Yes. We design it with categories, filters and optimized loading. Even with hundreds of works, it stays fast.",
      },
      {
        question: "How much does it cost?",
        answer: "Pricing comes after a short call. I send a written quote with deliverables and timing. No rate card up front.",
      },
      {
        question: "Can I update the portfolio myself?",
        answer: "Sure. Uploading a new project is as simple as posting on Instagram. I show you how.",
      },
      {
        question: "Does it work for event organizers too?",
        answer: "Absolutely. Event galleries, available-date calendar, info request — all customizable for your business.",
      },
    ],
    ctaText: "Want a site that does justice to your work?",
  },
};
