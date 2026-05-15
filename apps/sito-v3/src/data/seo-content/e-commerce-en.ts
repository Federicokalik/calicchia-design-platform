// EN mirror of apps/sito-v3/src/data/seo-content/e-commerce.ts. Translated 2026-05-15 via codex.
// Voice: idiomatic American English, second-person direct, marketing tone.

import type { ServiceCategoryContent } from '../seo-service-content';

export const E_COMMERCE_CONTENT_EN: Record<string, ServiceCategoryContent> = {
  'beauty-wellness': {
  "description": "In beauty and wellness, too much revenue ends when the client walks out of the salon: professional products sold only at the counter, gift cards handled by voice, orders scattered between Instagram and WhatsApp. An e-commerce flow puts catalog, payments, shipping, and cart recovery in one place.",
  "microStory": "A beauty center in Frosinone sold creams and vouchers only at the counter. Online it had a \"products\" page with no checkout, so every request ended up in chat and was handled by hand. The e-commerce store was built with short categories, simple variants, in-store pickup, and clear post-order emails. We did not turn the salon into a marketplace: we removed 6 repeated messages from every sale. In the first month, 38 orders came in for vouchers and products, almost all outside opening hours.",
  "caseStudyRef": undefined,
  "solutionTitle": "Your salon should not sell only when someone walks in",
  "problems": [
    {
      "icon": "ph-shopping-bag",
      "title": "The counter is too limited",
      "desc": "Shampoo, treatments, creams, and accessories stay tied to foot traffic in the salon. Someone follows you on Instagram but does not come in that week, so they buy somewhere else. The problem is not the product. It is the missing channel."
    },
    {
      "icon": "ph-receipt",
      "title": "Improvised gift cards",
      "desc": "At Christmas, Valentine's Day, or before a party, digital gift cards should be ready in two clicks. If you handle them with messages, bank transfers, and manual PDFs, you lose impulse buys. That is the whole story."
    },
    {
      "icon": "ph-chart-line-down",
      "title": "Revenue only in person",
      "desc": "If revenue depends only on appointments and visits, every empty slot hurts. E-commerce separates part of your sales from the occupied chair, the full treatment room, or the booked class."
    }
  ],
  "features": [
    {
      "title": "Organized beauty catalog",
      "description": "Products, kits, home treatments, and gift cards with clear categories, variants, photos, technical details, and availability. Not a confusing digital shelf copied from a random template."
    },
    {
      "title": "Payments and shipping",
      "description": "Stripe, PayPal, bank transfer, in-store pickup, and shipping configured around the way you actually work. The client buys without waiting for WhatsApp replies."
    },
    {
      "title": "Inventory under control",
      "description": "Stock, variants, sizes, colors, and sold-out products managed without random plug-ins. So you do not sell a cream online that is already gone in the salon."
    },
    {
      "title": "Emails that close orders",
      "description": "Purchase confirmations, receipts, cart recovery, and post-sale messages written for beauty clients, not for a generic store. Less manual chasing, more order."
    },
    {
      "title": "Data for Google Shopping",
      "description": "Product and Offer schema, clean product data, understandable titles, and pages ready for Google to read better. Uploading items is not enough. They need to be presented well."
    }
  ],
  "faqs": [
    {
      "question": "Can I sell both physical products and gift cards for treatments?",
      "answer": "Yes. Products, packages, gift cards, and kits can live in the same shop, with different rules for shipping, salon pickup, and digital delivery. The important part is to clearly separate what gets shipped from what gets redeemed by appointment."
    },
    {
      "question": "If I have only a few products, does an online shop make sense?",
      "answer": "It depends on what you sell and how often clients ask for it after a treatment. Even a small catalog can make sense if it includes professional products, recommended routines, and seasonal gift cards. A small, organized catalog beats a hundred badly loaded items."
    },
    {
      "question": "Can I connect the shop to Instagram?",
      "answer": "Yes. The shop can become the destination for your bio link, stories, campaigns, and messages. Instagram creates interest, but payment needs to happen in a clear place, with a product page, availability, and order confirmation. Otherwise everything stays fragile."
    },
    {
      "question": "How do I handle salon pickup?",
      "answer": "Salon pickup can be a delivery option separate from shipping. The client buys online, receives confirmation, and comes by when the order is ready. For salons, estheticians, and gyms, it is often the simplest way to start without complicating logistics."
    },
    {
      "question": "Is WooCommerce enough or do I need a custom platform?",
      "answer": "WooCommerce works when catalog, payments, and flows are standard. A custom platform makes sense if you have specific rules: subscriptions, customer credit, reserved price lists, management software integrations, or very specific gift cards. First you map the process, then you choose the tool. Period."
    }
  ],
  "ctaText": "Let's talk",
  "searchExamplePrefix": "esthetician gift card"
},
  'sanita-salute': {
  "description": "Selling parapharmacy products, supplements, or post-treatment kits online in healthcare is not a generic store. You need a clear catalog, informed consent where needed, a sober checkout, traceable payments, managed shipping, and content that respects professional rules. Without supplier chains turning everything into chaos.",
  "microStory": "A nutrition practice wanted to sell intro paths and preparation documents without routing everything through email. The old flow was fragile: request, manual reply, bank transfer, file delivery, appointment. The e-commerce flow separated preliminary consultation, digital materials, and guided request, with clear consent and automatic confirmations. The front desk cut about 4 steps from every intake. In 6 weeks, purchases and paid requests reached 21, without forcing healthcare promises or off-tone commercial language.",
  "caseStudyRef": undefined,
  "solutionTitle": "Healthcare e-commerce without improvised carts",
  "problems": [
    {
      "icon": "ph-shopping-bag",
      "title": "Products bought elsewhere",
      "desc": "The patient leaves your office with a specific recommendation, then searches online, ends up on anonymous marketplaces, and buys the wrong alternative. The problem is not selling more. It is losing control over what gets purchased after the visit."
    },
    {
      "icon": "ph-warning-circle",
      "title": "A cart that feels noncompliant",
      "desc": "A healthcare e-commerce site cannot talk like a sneaker store. Aggressive claims, copied product pages, and off-tone promises can create professional issues, especially for supplements, devices, post-treatment kits, or products recommended in-office."
    },
    {
      "icon": "ph-gear",
      "title": "Plug-ins with no direction",
      "desc": "WooCommerce installed by one person, payments by another, shipping pasted on later, emails never tested. Result: lost orders, confused inventory, fragile checkout, and a healthcare practice chasing technical issues instead of helping patients."
    }
  ],
  "features": [
    {
      "title": "Organized healthcare catalog",
      "description": "Products, variants, availability, and categories built for people who need to buy with clarity, without loud pages or generic supplier descriptions."
    },
    {
      "title": "Sober, traceable checkout",
      "description": "Payments with Stripe, PayPal, or bank transfer, clear confirmations, readable summaries, and only the steps that are needed. The cart should feel serious, not theatrical."
    },
    {
      "title": "Professionally careful content",
      "description": "Product copy, warnings, limits, and microcopy designed for the healthcare context. No miracle promises, no infomercial tone, no throwaway lines."
    },
    {
      "title": "Emails and recovered carts",
      "description": "Order confirmations, shipping notices, failed payment emails, and cart recovery written in clean English, with a professional tone and useful information for the patient."
    },
    {
      "title": "Google-ready data",
      "description": "Product and Offer schema, clean technical structure, and a manageable feed so search engines can correctly read products, availability, and commercial information."
    }
  ],
  "faqs": [
    {
      "question": "Can I sell online the supplements I already recommend in my practice?",
      "answer": "Yes, but it needs to be set up carefully. Product pages, claims, warnings, and the purchase path need to respect the healthcare context. Opening a catalog and uploading photos is not enough. You need to decide what to sell, how to present it, and which information must be clear before payment."
    },
    {
      "question": "Is WooCommerce or a custom platform better for a healthcare practice?",
      "answer": "It depends on the catalog, inventory, internal flows, and the level of control you need. WooCommerce can be enough for lean catalogs and ordinary management. A custom platform makes sense when you need specific rules, special integrations, or processes that standard plug-ins do not cover well."
    },
    {
      "question": "Does the patient need to register to buy?",
      "answer": "Not always. In many cases, guest checkout reduces friction and it is enough to collect the data needed for order, payment, and shipping. Registration makes sense if there are frequent reorders, purchase history, reserved products, or practice-specific logic."
    },
    {
      "question": "How do I keep the cart from looking unprofessional?",
      "answer": "Start by removing noise: no aggressive banners, fake urgency, invasive pop-ups, or marketplace-style copy. Then work on catalog, photos, descriptions, warnings, checkout, and email messages. In healthcare, trust also comes from what you do not shout."
    },
    {
      "question": "Can I sell only to my patients?",
      "answer": "Yes. You can set up a public, private, or mixed catalog. Some products can be visible to everyone, others accessible only through a link, private area, or code. The right choice depends on the product type, the patient relationship, and the practice rules."
    }
  ],
  "ctaText": "Let's talk",
  "searchExamplePrefix": "buy supplements"
},
  'studi-professionali': {
  "description": "For a professional firm, e-commerce is not a bazaar. It helps you sell standard consultations, operational packages, downloadable documents, and repeatable services without going through email, calls, and scattered attachments every time. Less supplier chain, more control over the sales flow.",
  "microStory": "A technical firm received repeated requests for preliminary checks, records, and short consultations. Everything went through phone calls, WhatsApp attachments, and invoices prepared afterward. E-commerce became an organized entry point: selected service, minimum data, uploaded document, automatic confirmation, and request status. The professional was not selling \"fake packages\": he was selling a controlled first step. After 2 months, 29 requests arrived already classified by type, and average triage time dropped from 18 to 6 minutes.",
  "caseStudyRef": undefined,
  "solutionTitle": "E-commerce for firms that sell expertise, not chaos",
  "problems": [
    {
      "icon": "ph-warning-circle",
      "title": "Consultations sold by hand",
      "desc": "The standard consultation already exists, but it is handled with messages, manual bank transfers, separate confirmations, and files sent later. Every purchase becomes a small administrative case. The problem is not the service. It is the broken path."
    },
    {
      "icon": "ph-receipt",
      "title": "Documents by email",
      "desc": "Templates, samples, checklists, and guides end up in attachments forwarded by hand. Different versions, untracked access, clients asking for the same file again. It is classic digital commerce done with office tools from the nineties."
    },
    {
      "icon": "ph-prohibit",
      "title": "No buy now",
      "desc": "For standard matters, quick consultations, or recurring packages, there is no clear page where the client can choose, pay, and receive instructions. So even what could be ordered in three minutes goes through a useless negotiation."
    }
  ],
  "features": [
    {
      "title": "Professional service catalog",
      "description": "Consultations, packages, documents, and standard services organized as purchasable products, with clear variants for duration, scope, format, or client category."
    },
    {
      "title": "Payments and confirmations",
      "description": "Stripe, PayPal, or bank transfer managed inside an orderly flow, with transactional emails, operational receipts, and automatic instructions after purchase."
    },
    {
      "title": "Protected downloads",
      "description": "Documents, templates, and digital materials delivered after payment, without manual forwards, improvised links, or shared folders left open."
    },
    {
      "title": "Serious cart recovery",
      "description": "Recovery emails for people who abandon a consultation or document before payment, without infomercial language and without invasive automations."
    },
    {
      "title": "Google-readable data",
      "description": "Product and Offer schema set up so Google understands what you sell: consultation, document, package, or standard service. Clean. Period."
    }
  ],
  "faqs": [
    {
      "question": "Does e-commerce make sense for a professional firm?",
      "answer": "Yes, when the firm has repeatable services: initial consultations, flat-fee packages, downloadable documents, preliminary analyses, or standard matters. It does not replace the professional relationship. It removes unnecessary steps before the engagement, especially when the client already knows what they need."
    },
    {
      "question": "Can I sell consultations without looking like a generic store?",
      "answer": "Yes. The structure should stay sober: a clear page, service scope, what is included, what is not included, response times, and operating method. No tacky carts, fake badges, or artificial urgency. A firm should sell with order, not noise."
    },
    {
      "question": "How do I manage downloadable documents and templates?",
      "answer": "Files can be tied to the order and made available only after payment. You can limit access, update versions, and send automatic emails with instructions. So you stop living inside a chain of attachments, duplicate requests, and lost links."
    },
    {
      "question": "Is WooCommerce better or a custom platform?",
      "answer": "It depends on the catalog type. WooCommerce works for packages, documents, consultations, and standard flows. A custom platform makes sense when there are special rules, reserved access, document logic, or internal integrations. First you map the process, then you choose the tool."
    },
    {
      "question": "Can I separate online purchase from the professional engagement?",
      "answer": "Yes, and it often makes sense. The payment can cover a preliminary consultation, a document, a check, or a specific phase. The main engagement stays separate, with its own terms and steps. E-commerce organizes the entry point. It does not trivialize the profession. That is the whole story."
    }
  ],
  "ctaText": "Let's talk",
  "searchExamplePrefix": "online consultation"
},
  'casa-edilizia': {
  "description": "For plumbers, electricians, locksmiths, and technical retailers, e-commerce is not a pretty showcase. It is catalog, availability, product pages, payments, and shipping. If the price list stays in a PDF or on the phone, every order starts crooked and goes through three useless confirmations.",
  "microStory": "A building materials retailer had 420 items in management software and no public catalog. Customers called for sizes, availability, and pickup, even for 30-second questions. The e-commerce flow started with a browsable catalog, availability requests, in-store pickup, and product pages with technical data. Not every item could be bought immediately. That was better, because some variants require verification. After 8 weeks, repetitive calls dropped by 32% and site requests were already split by category.",
  "caseStudyRef": undefined,
  "solutionTitle": "Construction e-commerce: clear catalog, fewer useless calls",
  "problems": [
    {
      "icon": "ph-shopping-bag",
      "title": "Sales stuck offline",
      "desc": "Materials, spare parts, tools, and technical accessories stay behind the counter or in the warehouse. Someone looking for a faucet, lock, switch, or window frame profile cannot buy it when they need it. In the meantime, they go elsewhere."
    },
    {
      "icon": "ph-clock",
      "title": "Availability by phone",
      "desc": "Every call asking whether a product is available burns operating time. Answer, check, call back, confirm: a useless chain when availability, variants, and in-store pickup can already be online, updated, and easy to read."
    },
    {
      "icon": "ph-database",
      "title": "Price lists out of control",
      "desc": "Old PDFs, Excel sheets, handwritten codes, and randomly chosen plug-ins create confusion. The customer sees one thing, the warehouse says another, the order starts badly. Then you have to fix it by phone."
    }
  ],
  "features": [
    {
      "title": "Organized technical catalog",
      "description": "Products split into real categories: plumbing fixtures, hardware, electrical, windows and doors, building materials. Pages with codes, sizes, variants, compatibility, and clean photos, without fake generic-template descriptions."
    },
    {
      "title": "Inventory visible online",
      "description": "Clear availability for purchase, in-store pickup, or dedicated request. The customer immediately understands whether they can order, pick up, or wait, without clogging the phone for every item."
    },
    {
      "title": "Payments and shipping",
      "description": "Checkout with Stripe, PayPal, bank transfer, and shipping rules aligned with weight, size, area, and product type. A pallet is not handled like a door handle. Period."
    },
    {
      "title": "Order and recovery emails",
      "description": "Transactional emails written in clear English: confirmation, payment, shipping, pickup, abandoned cart. No six-person agency phrases. Just useful instructions."
    },
    {
      "title": "Data for Google Shopping",
      "description": "Product and Offer schema, readable titles, availability, and product data ready for Google to understand. Not SEO magic: clean catalog, correct information, stable structure."
    }
  ],
  "faqs": [
    {
      "question": "Can I sell technical products with many variants online?",
      "answer": "Yes, but the variants need to be designed well: size, color, connection, material, compatibility, brand, and item code must be clear. If the customer buys the wrong part because the page is vague, e-commerce becomes just another problem to manage."
    },
    {
      "question": "Do I have to use WooCommerce or can I use a custom platform?",
      "answer": "It depends on catalog, inventory, and internal flows. WooCommerce works when the structure is manageable and you need to start with control. A custom platform makes sense if there are complex rules for availability, price lists, shipping, or management software integrations."
    },
    {
      "question": "Can I show the catalog without selling everything online right away?",
      "answer": "Yes. Some products can have direct purchase, others only technical request, in-store pickup, or dedicated contact. For building materials, windows and doors, and configurable items, this is often the cleanest choice: the customer sees what you carry without forcing wrong orders."
    },
    {
      "question": "How do I handle heavy products or items that are hard to ship?",
      "answer": "You set rules for weight, volume, area, in-store pickup, and dedicated shipping. Cement, long profiles, doors, tools, and small hardware cannot follow the same logic. The checkout needs to say that before the order, not after."
    },
    {
      "question": "My price list is in Excel. Can it be used?",
      "answer": "Yes, if the file is cleaned up: consistent codes, categories, descriptions, variants, availability, and linked images. Loading a messy Excel file into e-commerce only moves the chaos online. First you organize it, then you publish. That is the whole story."
    }
  ],
  "ctaText": "Let's talk",
  "searchExamplePrefix": "building materials online"
},
  'auto-mobilita': {
  "description": "Spare parts, accessories, tires, service kits, and shop products cannot stay locked behind the counter. People searching online compare availability, compatibility, in-store pickup, and shipping. If they only find giant marketplaces, the local relationship starts uphill.",
  "microStory": "An auto parts store managed counter orders, calls, and messages with codes written in different ways. The risk was shipping the wrong part or losing hours asking for plate number, model, and year. The e-commerce store was built with filters, clean SKUs, compatibility requests, and in-store pickup. Across the first 160 products, request errors dropped from 11 to 2 in the first month. The counter did not disappear. It stopped acting like a human search engine.",
  "caseStudyRef": undefined,
  "solutionTitle": "Auto parts online, without losing control of the counter",
  "problems": [
    {
      "icon": "ph-storefront",
      "title": "The counter is too closed",
      "desc": "The customer calls to ask whether you have that filter, that battery, or that set of tires. Every call interrupts the work, while the catalog stays invisible to someone who was already ready to buy or stop by."
    },
    {
      "icon": "ph-warning-circle",
      "title": "Improvised catalogs",
      "desc": "Badly copied product pages, confused variants, missing compatibility, and random plug-ins create wrong orders. In automotive, an error on model, year, or size is not a detail. It becomes a return, wasted time, and frustration."
    },
    {
      "icon": "ph-chart-line-down",
      "title": "Marketplaces ahead of you",
      "desc": "Norauto, Amazon, and big chains capture searches that could reach a local parts seller, tire shop, or dealership. Not because they are closer, but because Google understands their catalog better."
    }
  ],
  "features": [
    {
      "title": "Organized parts catalog",
      "description": "Products, categories, brands, codes, compatibility, variants, and availability are structured so people can browse without useless calls and without confusing the person looking for the right part."
    },
    {
      "title": "Inventory under control",
      "description": "Stock, sold-out products, in-store pickup, and shipping need to speak the same language. The site should not sell ghost inventory or hide items ready in storage."
    },
    {
      "title": "Payments and shipping",
      "description": "Stripe, PayPal, bank transfer, couriers, and local pickup are connected to the order flow clearly, with readable transactional emails and understandable order statuses."
    },
    {
      "title": "Lost cart recovery",
      "description": "Someone who adds a battery or accessory to the cart and disappears can receive a sensible reminder. Not aggressive spam. Just orderly recovery of purchases left halfway."
    },
    {
      "title": "Data for Google Shopping",
      "description": "Product and Offer schema help Google read price, availability, brand, and product. For auto parts and accessories, the technical structure matters as much as the design."
    }
  ],
  "faqs": [
    {
      "question": "Can I sell online even if many customers pick up at the shop?",
      "answer": "Yes. For parts, tires, and accessories, in-store pickup is often the most sensible flow. The customer checks availability, pays or reserves, then comes by when it is convenient. Fewer calls, fewer scattered messages, more order between counter and site. Period."
    },
    {
      "question": "How do you manage compatibility and part variants?",
      "answer": "They need to be designed before you load random products. Codes, brand, model, year, sizes, and technical notes need to be clear fields, not text dumped into the description. Otherwise wrong orders arrive and the site becomes another problem."
    },
    {
      "question": "Is WooCommerce or a custom platform better for an auto shop?",
      "answer": "It depends on the catalog and how you work. WooCommerce is suitable if you need to start with a manageable structure and common integrations. A custom platform makes sense when inventory, compatibility, or internal flows are too specific to be bent around random plug-ins."
    },
    {
      "question": "Do I need to upload the whole warehouse right away?",
      "answer": "No. It often makes sense to start with the most searched categories: batteries, tires, seasonal accessories, service kits, products with good margin or high turnover. A small but clean catalog beats a thousand confused pages imported without criteria. That is the whole story."
    },
    {
      "question": "Can e-commerce help even if I sell mostly offline?",
      "answer": "Yes, if you treat it as an operating catalog, not a decorative showcase. Someone looking for a nearby part wants to know whether it is available, compatible, and how to pick it up. If those answers are missing, they end up with the big chains. Your choice."
    }
  ],
  "ctaText": "Let's talk",
  "searchExamplePrefix": "auto parts online"
},
  'food-hospitality': {
  "description": "In food and hospitality, a restaurant, hotel, or agritourism business that sells only through portals and apps leaves margins, contacts, and reorders out of control. E-commerce supports direct takeout, baskets, local products, and vouchers, with catalog, payments, shipping, and readable data.",
  "microStory": "A place selling local products handled baskets and takeout only by phone. During busy periods, incomplete messages came in: date, pickup, allergens, and quantities were almost always missing. E-commerce introduced clear product pages, pickup windows, order notes, and confirmation emails. Table bookings stayed on the existing channel, without creating another useless dashboard. During the first holiday period, 54 direct orders came through the site and calls to fix details dropped below 1 in 10.",
  "caseStudyRef": undefined,
  "solutionTitle": "Sell tables, baskets, and takeout without being eaten by portals",
  "problems": [
    {
      "icon": "ph-chart-line-down",
      "title": "Commissions that bite",
      "desc": "If takeout and delivery go only through Glovo or Deliveroo, every order arrives already cut down. The customer remembers the app, not the restaurant. Margin stays fragile, especially during peaks."
    },
    {
      "icon": "ph-shopping-bag",
      "title": "Products never sold",
      "desc": "Gift baskets, preserves, wines, holiday cakes, tasting boxes, and gift cards sit still because they are shown on Instagram and then ordered in chat. Nice while three requests come in. Unmanageable as soon as they grow."
    },
    {
      "icon": "ph-calendar-blank",
      "title": "Tables with no deposit",
      "desc": "Special menus, brunches, tastings, and limited-seat nights are booked by voice, with scattered messages and no-shows. Without online payment or deposit, the calendar is full only on paper."
    }
  ],
  "features": [
    {
      "title": "Food catalog",
      "description": "Products, formats, allergens, availability, variants, and photos managed in an orderly way. A B&B can sell vouchers, a bakery seasonal boxes, an agritourism business mixed packages."
    },
    {
      "title": "Payments and shipping",
      "description": "Stripe, PayPal, bank transfer, in-store pickup, local delivery, and couriers configured without chains of plug-ins placed at random. Every order needs status, receipt, and tracking."
    },
    {
      "title": "Recoverable cart",
      "description": "Transactional emails, abandoned carts, and post-purchase messages written for people buying food, vouchers, or stays. No fake line recycled from an American template."
    },
    {
      "title": "Inventory without chaos",
      "description": "Stock, date-based availability, limited quantities, and sold-out products managed before the customer pays. Useful when a batch, a room, or a menu has real numbers."
    },
    {
      "title": "Data for Google",
      "description": "Product and Offer schema, compatible feeds, and clear information on price, availability, and shipping. Google needs to understand what you sell without interpreting pages full of slogans."
    }
  ],
  "faqs": [
    {
      "question": "Can I sell takeout without removing everything from Glovo or Deliveroo?",
      "answer": "Yes. Direct e-commerce can coexist with the apps, but its job is to bring part of the orders back to your domain. It makes sense to send regular customers, repeat orders, special boxes, and in-store pickup there. Apps stay channels, not owners of the business."
    },
    {
      "question": "For a restaurant, does e-commerce make sense or is a website with a menu enough?",
      "answer": "It depends on what you sell. If people only need to view the menu, a well-made page is enough. If you sell delivery, prepaid dinners, gift cards, tastings, packaged products, or occasion boxes, then you need a real purchase flow, not a contact form in disguise."
    },
    {
      "question": "Can gift vouchers for hotels, B&Bs, or agritourism businesses be managed?",
      "answer": "Yes, with vouchers that can be bought online, automatic email, unique code, and clear rules on validity, included services, and redemption. It is better to define them well first, because an ambiguous voucher creates calls, disputes, and manual reception work."
    },
    {
      "question": "How do I manage fresh products, limited availability, or scheduled pickup?",
      "answer": "You set up the catalog around real constraints: daily quantities, pickup windows, closed days, seasonal products, and per-order limits. A serious system should not accept twenty boxes when the kitchen can prepare twelve. Period."
    },
    {
      "question": "Is WooCommerce enough or do I need a custom platform?",
      "answer": "WooCommerce works when catalog, payments, shipping, and internal management stay fairly standard. A custom platform makes sense if there are special rules: prepaid bookings, date-based availability, management software integrations, or mixed flows between table, room, and product."
    }
  ],
  "ctaText": "Let's talk",
  "searchExamplePrefix": "buy online"
},
  'retail-negozi': {
  "description": "For a physical store, e-commerce should not erase the counter. It should keep a second storefront open when the shutter is already down. Catalog, stock, payments, shipping, and product pages need to be managed together, without supplier chains and random plug-ins.",
  "microStory": "A small-town boutique had 320 items managed between the register, Instagram, and private messages. Availability changed during the day and every online sale became a negotiation. E-commerce started with click and collect, size-color variants, and stock updates from the management system. The pages do not feel like an anonymous marketplace: they show materials, fit, and pickup. In the first month, 73 orders or product reservations came in, and the store cut \"do you still have it?\" messages by about half.",
  "caseStudyRef": undefined,
  "solutionTitle": "E-commerce for real stores, not marketplace templates",
  "problems": [
    {
      "icon": "ph-clock",
      "title": "The shutter is closed online",
      "desc": "The store sells when it is open, while someone looking for a bag, a vase, or a book after dinner ends up elsewhere. You do not need to become Amazon. You need a direct channel that works after hours too."
    },
    {
      "icon": "ph-database",
      "title": "Inventory out of control",
      "desc": "Without stock connected to the catalog, the customer buys an item that is already gone in the store. Then come calls, refunds, apologies, and wasted time. The problem is not selling online. It is selling without operating order."
    },
    {
      "icon": "ph-shopping-bag",
      "title": "Customers handed to marketplaces",
      "desc": "Amazon and similar platforms collect visibility, data, and repeat purchases. You ship, they stay in the customer's head. For an independent retailer, that means eroded margin and a relationship moved outside the store."
    }
  ],
  "features": [
    {
      "title": "Manageable catalog",
      "description": "Products, categories, sizes, colors, materials, and variants set up with judgment. A florist, a jewelry store, and a bookstore have different logic. The catalog needs to follow it, not flatten it."
    },
    {
      "title": "Stock and variants",
      "description": "Readable inventory, clear availability, and rules for sold-out items, unique pieces, or made-to-order products. Fewer wrong sales, less manual work after purchase."
    },
    {
      "title": "Payments and shipping",
      "description": "Stripe, PayPal, bank transfer, in-store pickup, local delivery, or courier: checkout is built around the real methods of the store, without unnecessary steps."
    },
    {
      "title": "Emails that close",
      "description": "Order confirmations, shipping updates, recovered carts, and receipts need to be clean, recognizable, and useful. Not loud newsletters: transactional messages that prevent doubts and repeated calls."
    },
    {
      "title": "Data for Google",
      "description": "Product and Offer schema prepared to make price, availability, brand, and product readable for Google Shopping. If the product page is confused, Google understands it badly. Period."
    }
  ],
  "faqs": [
    {
      "question": "Does e-commerce make sense if I already have a physical store?",
      "answer": "Yes, if you treat it as an extension of the counter, not a separate project. A clothing store can sell remaining sizes, a bookstore can manage local orders, a florist can receive after-hours requests. The physical store stays central. Online removes friction."
    },
    {
      "question": "Do I need to upload the whole catalog right away?",
      "answer": "No. It often makes sense to start with products that have more margin, more demand, or simpler management: best sellers, ongoing items, gift ideas, pieces available in stock. Uploading everything without criteria creates weak pages, mediocre photos, and heavy management."
    },
    {
      "question": "How do I avoid selling unavailable products?",
      "answer": "You need clear inventory logic: updated availability, thresholds, well-managed variants, and rules for sold-out products. For unique items, like jewelry or furniture, the system needs to block double sales and show when a piece is no longer purchasable."
    },
    {
      "question": "Is WooCommerce or a custom platform better?",
      "answer": "It depends on catalog, flows, and how much autonomy you need. WooCommerce works when you need to start with a strong, manageable base. A custom platform makes sense when there are special rules: configurations, complex price lists, syncing, or processes that a generic plug-in makes harder."
    },
    {
      "question": "Can I use e-commerce only for in-store pickup?",
      "answer": "Yes. For many stores, it is a smart choice: the customer orders online, pays or reserves, then picks up on site. It works well for bookstores, hardware stores, florists, and shops with local customers. Less shipping, more visits to the store. That is the whole story."
    }
  ],
  "ctaText": "Let's talk",
  "searchExamplePrefix": "buy online"
},
  'creativita-eventi': {
  "description": "Photographers, videographers, and event organizers sell prints, albums, workshops, and packages through DMs, Drive, and manual bank transfers. The client does not understand what they are buying, the deposit hangs in limbo, and the portfolio never becomes a catalog. Here, e-commerce needs to create order, payment, and confirmation. Period.",
  "microStory": "A photographer sold albums, prints, and event services only in DMs. Every request needed a price list, examples, timing, revision, address, and manual confirmation. E-commerce separated physical products, bookable services, and event requests, with essential data upload and summary emails. The catalog did not cheapen the creative work. It removed confusion. In 7 weeks, 26 orders came in for prints and albums, while event requests arrived already with date, venue, and estimated number of people.",
  "caseStudyRef": undefined,
  "solutionTitle": "Stop selling albums, prints, and event packages in DMs",
  "problems": [
    {
      "icon": "ph-instagram-logo",
      "title": "Sales scattered in DMs",
      "desc": "Prints, photo books, vouchers, and packages are requested on Instagram, confirmed on WhatsApp, and paid somewhere else. Every order becomes a small manual production job, with files, addresses, and confirmations scattered around."
    },
    {
      "icon": "ph-warning-circle",
      "title": "Unclear packages",
      "desc": "A wedding planner or videographer cannot explain what a package includes every single time. Without a price list, variants, and clear limits, the client interprets, asks for discounts, and postpones the decision."
    },
    {
      "icon": "ph-credit-card",
      "title": "Deposits handled by hand",
      "desc": "Bank transfer, screenshot, account check, confirmation message: the deposit becomes a fragile step. If there is no automation, the event stays pending and the calendar is not truly blocked."
    }
  ],
  "features": [
    {
      "title": "Clear package catalog",
      "description": "Albums, prints, workshops, gift cards, and pre-packaged services organized with variants, descriptions, extras, and limits. The client chooses without having to rebuild everything in chat."
    },
    {
      "title": "Deposits and balances online",
      "description": "Payments with Stripe, PayPal, or tracked bank transfer, with automatic confirmations and readable order statuses. Useful for blocking dates, photo sessions, events, and deliveries without chasing screenshots."
    },
    {
      "title": "Variants without chaos",
      "description": "Print formats, page count, covers, locations, duration, video extras, and gift options managed inside the purchase flow. Fewer repeated messages, fewer production errors."
    },
    {
      "title": "Clean transactional emails",
      "description": "Order confirmation, file upload instructions, payment reminders, cart recovery, and shipping updates written in clear English. Not newsletters in disguise: operational communication."
    },
    {
      "title": "Data for Google Shopping",
      "description": "Product and Offer schema to make products, availability, and offers readable to search engines. It matters when you sell prints, albums, courses, or digital kits people can search for online."
    }
  ],
  "faqs": [
    {
      "question": "Can I sell both physical prints and photography packages?",
      "answer": "Yes. They need to be separated clearly: shipped products with formats, materials, and address; packages with date, deposit, balance, and conditions. Mixing them into the same bucket creates ambiguous orders and endless messages. The structure needs to reflect how you really work."
    },
    {
      "question": "Should I use WooCommerce or a custom platform?",
      "answer": "It depends on catalog, inventory, variants, and automations. WooCommerce handles prints, albums, vouchers, and standard payments well. A custom platform makes sense when the package configurator, calendar, or internal flows are too specific."
    },
    {
      "question": "How do I manage the deposit for weddings or events?",
      "answer": "The deposit can be a product, a share tied to a package, or an initial payment with a later balance. The important part is automatic confirmation: date blocked, email sent, order recorded, no manual account check every morning."
    },
    {
      "question": "Can clients upload files or preferences after purchase?",
      "answer": "Yes, but it is better not to load everything into checkout. Collect the order, then send clear instructions for files, photo selections, event notes, or preferences. Checkout stays fast and production receives organized data."
    },
    {
      "question": "Is cart recovery really useful in this industry?",
      "answer": "If you sell albums, prints, courses, or gift cards, yes. Many clients start on mobile, look at options, then stop. A sober cart recovery email reminds them what they chose without pushing fake lines. That is the whole story."
    }
  ],
  "ctaText": "Let's talk",
  "searchExamplePrefix": "buy photo album"
}
};
