import type { Locale } from '@/lib/i18n';

type LocalisedField = { it: string; en: string };

export type EcommerceTerm = {
  slug: string;
  letter: string;
  term: string;
  fullName?: string;
  whatItIs: LocalisedField;
  whyYouCare: LocalisedField;
  whatToDemand: LocalisedField;
};

export const GLOSSARIO_ECOMMERCE: EcommerceTerm[] = [
  {
    slug: 'aov',
    letter: 'A',
    term: 'AOV',
    fullName: 'Average Order Value',
    whatItIs: {
      it: "Valore medio dell'ordine.\nCalcolato come revenue totale / numero ordini in un periodo.\nÈ il KPI più sensibile a strategie di upsell, cross-sell, soglia free shipping.",
      en: 'Average value per order.\nComputed as total revenue / number of orders in a period.\nThe KPI most sensitive to upsell, cross-sell, and free-shipping threshold strategies.',
    },
    whyYouCare: {
      it: "AOV stagnante = stai prendendo clienti ma non li monetizzi al massimo.\nAumentare AOV del 10% è quasi sempre più redditizio che acquisire +10% clienti (CAC è la voce di costo più alta).",
      en: "Stagnant AOV = you're getting customers but not monetising them fully.\nRaising AOV by 10% is almost always more profitable than acquiring +10% customers (CAC is the highest cost line).",
    },
    whatToDemand: {
      it: 'Tracking AOV per source/medium e per categoria prodotto.\nTest soglia free shipping (es. €60).\nBundle discounts e "spesso comprati insieme" su pagina prodotto e checkout.',
      en: 'AOV tracking by source/medium and product category.\nTest free shipping threshold (e.g. €60).\nBundle discounts and "frequently bought together" on product page and checkout.',
    },
  },
  {
    slug: 'abandoned-cart',
    letter: 'A',
    term: 'Abandoned Cart',
    fullName: 'Carrello abbandonato',
    whatItIs: {
      it: 'Utente che aggiunge prodotti al carrello ma non completa il checkout.\nTasso medio: 65-75% (Baymard Institute).\nI motivi: costi extra (shipping, tax) inattesi, account obbligatorio, checkout lungo, sicurezza percepita bassa.',
      en: 'User who adds products to cart but doesn\'t complete checkout.\nAverage rate: 65-75% (Baymard Institute).\nReasons: unexpected extra costs (shipping, tax), forced account creation, long checkout, low perceived security.',
    },
    whyYouCare: {
      it: 'Recupero carrello vale 5-15% delle conversioni totali.\nEmail sequence post-abbandono ben fatta = revenue gratuito.\nSenza tracking, perdi l\'opportunità.',
      en: 'Cart recovery is worth 5-15% of total conversions.\nWell-built post-abandonment email sequence = free revenue.\nWithout tracking, you lose the opportunity.',
    },
    whatToDemand: {
      it: 'Tracking abandoned cart in GA4 (event begin_checkout senza purchase entro 24h).\nEmail sequence 3 step (1h, 24h, 72h).\nGuest checkout sempre disponibile e pre-load shipping/tax in carrello.',
      en: 'Abandoned cart tracking in GA4 (begin_checkout event without purchase within 24h).\n3-step email sequence (1h, 24h, 72h).\nGuest checkout always available and pre-load shipping/tax in cart.',
    },
  },
  {
    slug: 'add-to-cart',
    letter: 'A',
    term: 'ATC',
    fullName: 'Add to Cart Rate',
    whatItIs: {
      it: 'Percentuale di visitatori product page che aggiungono al carrello.\nBenchmark medio 5-12% (varia per settore).\nKPI fondamentale per misurare quality landing prodotto.',
      en: 'Percentage of product page visitors who add to cart.\nAverage benchmark 5-12% (varies by industry).\nFundamental KPI to measure product landing quality.',
    },
    whyYouCare: {
      it: 'ATC basso (<3%) = product page non convince: foto scarse, descrizione povera, prezzo non competitivo, mancano social proof o reviews.\nOptimization step uno.',
      en: 'Low ATC (<3%) = product page not convincing: poor photos, weak description, non-competitive price, missing social proof or reviews.\nOptimisation step one.',
    },
    whatToDemand: {
      it: 'A/B test su PDP: foto multiple + zoom, video brevi.\nRecensioni con stelle (Schema Product).\nDescrizione benefit-driven (non feature-list) e CTA visibile above-the-fold.',
      en: 'A/B testing on PDP: multiple photos + zoom, short videos.\nStarred reviews (Product schema).\nBenefit-driven description (not feature-list) and CTA above-the-fold.',
    },
  },
  {
    slug: 'b2b-b2c',
    letter: 'B',
    term: 'B2B / B2C',
    fullName: 'Business-to-Business / Business-to-Consumer',
    whatItIs: {
      it: 'B2B = vendi ad altre aziende (volumi alti, ciclo lungo, multi-stakeholder, fatturazione differita).\nB2C = vendi a consumatori finali (volumi singoli bassi, ciclo veloce, decisione individuale, pagamento immediato).',
      en: 'B2B = sell to other businesses (high volumes, long cycle, multi-stakeholder, deferred billing).\nB2C = sell to end consumers (low single volumes, fast cycle, individual decision, immediate payment).',
    },
    whyYouCare: {
      it: 'E-commerce B2B richiede feature B2C non ha: cataloghi privati per cliente, prezzi negoziati, quote system, pagamento via fattura, multi-utente per account.\nUna piattaforma B2C piegata a B2B fa schifo a entrambi.',
      en: 'B2B e-commerce needs features B2C doesn\'t: per-client private catalogues, negotiated prices, quote system, invoice payment, multi-user accounts.\nA B2C platform bent to B2B sucks at both.',
    },
    whatToDemand: {
      it: 'Per B2B: piattaforma dedicata (Shopify Plus B2B, BigCommerce B2B, Magento Adobe Commerce).\nPer B2C: Shopify standard, WooCommerce, BigCommerce.\nNiente "B2B su Shopify base con plugin".',
      en: 'For B2B: dedicated platform (Shopify Plus B2B, BigCommerce B2B, Magento Adobe Commerce).\nFor B2C: standard Shopify, WooCommerce, BigCommerce.\nNo "B2B on basic Shopify with plugins".',
    },
  },
  {
    slug: 'cart',
    letter: 'C',
    term: 'Cart',
    fullName: 'Carrello',
    whatItIs: {
      it: 'Pagina/sezione che mostra prodotti selezionati prima del checkout.\nPersiste in sessione (anonima) o user (loggato).\nEdge cases: synced cross-device, expiry, quantity rules.',
      en: 'Page/section showing selected products before checkout.\nPersists in session (anonymous) or user (logged-in).\nEdge cases: cross-device sync, expiry, quantity rules.',
    },
    whyYouCare: {
      it: 'Cart UX cattivo = abbandono.\nCart che non persiste cross-device su utenti loggati = perdita clienti loyal.\nCart con costi nascosti fino al checkout = killer di conversion.',
      en: 'Bad cart UX = abandonment.\nCart that doesn\'t persist cross-device for logged-in users = loyal customer loss.\nCart with hidden costs until checkout = conversion killer.',
    },
    whatToDemand: {
      it: 'Cart drawer/page con pre-load shipping + tax (no surprise).\nPersistence cross-device (logged users).\nCTA "Vedi carrello" + "Continua acquisti" entrambi visibili.',
      en: 'Cart drawer/page with pre-loaded shipping + tax (no surprises).\nCross-device persistence (logged users).\nBoth "View cart" + "Continue shopping" CTAs visible.',
    },
  },
  {
    slug: 'checkout',
    letter: 'C',
    term: 'Checkout',
    whatItIs: {
      it: 'Flusso da carrello a ordine confermato.\nStep tipici: shipping address, shipping method, payment, review, place order.\nSingle-page o multi-step.',
      en: 'Flow from cart to confirmed order.\nTypical steps: shipping address, shipping method, payment, review, place order.\nSingle-page or multi-step.',
    },
    whyYouCare: {
      it: 'Ogni step extra = drop-off ~10%.\nForzare account creation = -25% conversion (Baymard).\nLayout sub-ottimale = perdita reale.',
      en: 'Every extra step = ~10% drop-off.\nForcing account creation = -25% conversion (Baymard).\nSub-optimal layout = real loss.',
    },
    whatToDemand: {
      it: 'Checkout 1-page o ≤3 step.\nGuest sempre disponibile e autofill address + Apple/Google Pay.\nValidazione inline, progress indicator, mobile-first.',
      en: 'Checkout 1-page or ≤3 steps.\nGuest always available and address autofill + Apple/Google Pay.\nInline validation, progress indicator, mobile-first.',
    },
  },
  {
    slug: 'conversion-rate',
    letter: 'C',
    term: 'Conversion Rate',
    fullName: 'CR / CVR',
    whatItIs: {
      it: 'Percentuale di visitatori che completano un\'azione target (acquisto, signup, lead).\nE-commerce media: 1-3% per traffic generico, 5-10% per traffic branded.',
      en: 'Percentage of visitors completing a target action (purchase, signup, lead).\nE-commerce average: 1-3% for generic traffic, 5-10% for branded traffic.',
    },
    whyYouCare: {
      it: 'CR doppio = revenue doppio a parità di traffico.\nOptimization CR (CRO) ha ROI quasi sempre superiore ad acquisition (più traffic).',
      en: 'Double CR = double revenue at the same traffic.\nCR optimisation (CRO) almost always has higher ROI than acquisition (more traffic).',
    },
    whatToDemand: {
      it: 'CR tracking per source/medium, device, landing page.\nA/B testing setup (Google Optimize sostituibile con VWO, Convert, AB Tasty).\nTest continui su elementi critici (CTA, headline, prezzo).',
      en: 'CR tracking by source/medium, device, landing page.\nA/B testing setup (Google Optimize replaceable with VWO, Convert, AB Tasty).\nContinuous tests on critical elements (CTA, headline, price).',
    },
  },
  {
    slug: 'cro',
    letter: 'C',
    term: 'CRO',
    fullName: 'Conversion Rate Optimization',
    whatItIs: {
      it: "Disciplina di ottimizzare il sito per aumentare CR.\nCycle: ipotesi (basata su data/heatmap/user research) → A/B test → analisi statistica → implementazione winner.",
      en: 'Discipline of optimising the site to raise CR.\nCycle: hypothesis (data/heatmap/user-research-based) → A/B test → statistical analysis → winner implementation.',
    },
    whyYouCare: {
      it: 'Senza CRO, ti basi su sentimento.\nCon CRO, ogni cambio è motivato da dato.\nSu 1000 ordini/mese, +10% CR = 100 ordini extra/mese.',
      en: 'Without CRO, you rely on gut feeling.\nWith CRO, every change is data-driven.\nOn 1000 orders/month, +10% CR = 100 extra orders/month.',
    },
    whatToDemand: {
      it: 'Stack CRO: GA4 + heatmap (Hotjar/Microsoft Clarity).\nA/B testing tool + tracking event custom.\nRoadmap test trimestrale con priorità ICE/PIE scoring.',
      en: 'CRO stack: GA4 + heatmap (Hotjar/Microsoft Clarity).\nA/B testing tool + custom event tracking.\nQuarterly test roadmap with ICE/PIE scoring prioritisation.',
    },
  },
  {
    slug: 'cross-sell',
    letter: 'C',
    term: 'Cross-sell',
    whatItIs: {
      it: 'Suggerimento di prodotti complementari a quello visualizzato/in carrello.\nEsempio: "Compra anche la cover" su pagina iPhone.\nDiverso da upsell (versione superiore stesso prodotto).',
      en: 'Suggestion of complementary products to the one viewed/in cart.\nExample: "Add the cover too" on iPhone page.\nDifferent from upsell (higher version of same product).',
    },
    whyYouCare: {
      it: "Cross-sell ben fatto aumenta AOV del 10-30%.\nCross-sell stupido (suggerisci ciò che non c'entra) fa cliccare \"X\" e basta.",
      en: 'Well-done cross-sell raises AOV 10-30%.\nStupid cross-sell (suggesting unrelated stuff) just makes people click "X".',
    },
    whatToDemand: {
      it: 'Cross-sell algoritmico (basato su co-purchase data) non manuale.\nPosizioni: PDP "Frequently bought together", cart drawer, post-purchase.\nMai >3 suggerimenti per non sovraccaricare.',
      en: 'Algorithmic cross-sell (co-purchase data based), not manual.\nPositions: PDP "Frequently bought together", cart drawer, post-purchase.\nNever >3 suggestions to avoid overload.',
    },
  },
  {
    slug: 'dropshipping',
    letter: 'D',
    term: 'Dropshipping',
    whatItIs: {
      it: "Modello di business in cui vendi prodotti senza tenerli in stock.\nQuando arriva ordine, lo passi al fornitore che spedisce direttamente al cliente.\nTu margini la differenza.",
      en: 'Business model where you sell products without holding stock.\nWhen an order comes, you forward it to the supplier who ships direct to the customer.\nYou margin the difference.',
    },
    whyYouCare: {
      it: 'Vantaggio: niente stock, niente warehouse.\nSvantaggio: margini bassi (15-30%), shipping time lungo (Cina 2-4 settimane), zero quality control, mercato saturo.\nNon è "facile" come venduto sui corsi YouTube.',
      en: 'Pro: no stock, no warehouse.\nCon: low margins (15-30%), long shipping (China 2-4 weeks), zero quality control, saturated market.\nNot "easy" as sold on YouTube courses.',
    },
    whatToDemand: {
      it: 'Per dropshipping serio: fornitori EU/USA (no Aliexpress puro), product research data-driven, brand differenziazione forte (foto custom, packaging proprio).\nSenza, è race-to-bottom.',
      en: 'For serious dropshipping: EU/USA suppliers (no pure Aliexpress), data-driven product research, strong brand differentiation (custom photos, own packaging).\nWithout it, it\'s a race to the bottom.',
    },
  },
  {
    slug: 'fulfillment',
    letter: 'F',
    term: 'Fulfillment',
    whatItIs: {
      it: "Insieme delle operazioni post-ordine: picking (prendere prodotto da warehouse), packing (imballare), shipping (consegnare).\nPuò essere in-house o esternalizzato (3PL — Third Party Logistics, es. Amazon FBA).",
      en: "All post-order operations: picking (take product from warehouse), packing (box it), shipping (deliver).\nCan be in-house or outsourced (3PL — Third Party Logistics, e.g. Amazon FBA).",
    },
    whyYouCare: {
      it: 'Fulfillment lento o scadente = recensioni negative + churn.\nCosto fulfillment è il 15-30% del COGS in retail medio.',
      en: 'Slow or sub-par fulfillment = negative reviews + churn.\nFulfillment cost is 15-30% of COGS in median retail.',
    },
    whatToDemand: {
      it: 'KPI fulfillment misurati: order-to-ship time (target <24h), shipping accuracy (target >99%), damage rate (target <0.5%).\n3PL solo se volumi >500 ordini/mese giustificano.',
      en: 'Measured fulfillment KPIs: order-to-ship time (target <24h), shipping accuracy (target >99%), damage rate (target <0.5%).\n3PL only if >500 orders/month volume justifies it.',
    },
  },
  {
    slug: 'gmv',
    letter: 'G',
    term: 'GMV',
    fullName: 'Gross Merchandise Value',
    whatItIs: {
      it: "Valore totale dei prodotti venduti su una piattaforma in un periodo, prima di scontare commissioni/refund/costi.\nUsato per marketplace (Amazon, Etsy, Shopify) — è il numero che gli investitori guardano per scaling.",
      en: "Total value of products sold on a platform in a period, before deducting commissions/refunds/costs.\nUsed for marketplaces (Amazon, Etsy, Shopify) — the number investors look at for scaling.",
    },
    whyYouCare: {
      it: "GMV è vanity metric se non lo correli a margin.\nMarketplace cresce GMV +200% YoY ma margin negativo = bruci capitale, non sei sostenibile.",
      en: "GMV is a vanity metric if not correlated to margin.\nA marketplace growing GMV +200% YoY with negative margin = burning capital, not sustainable.",
    },
    whatToDemand: {
      it: 'Reporting GMV + take rate (commissione %) + contribution margin per categoria.\nMai presentare solo GMV in board meeting senza margin.',
      en: 'GMV + take rate (commission %) + contribution margin per category reporting.\nNever present only GMV in a board meeting without margin.',
    },
  },
  {
    slug: 'headless-commerce',
    letter: 'H',
    term: 'Headless Commerce',
    whatItIs: {
      it: 'Architettura e-commerce con backend (catalogo, ordini, pagamenti) separato dal frontend (presentazione).\nEs: Shopify Hydrogen, BigCommerce + Next, Medusa + Remix.\nFrontend serve via API.',
      en: 'E-commerce architecture with backend (catalogue, orders, payments) separated from frontend (presentation).\nE.g. Shopify Hydrogen, BigCommerce + Next, Medusa + Remix.\nFrontend served via API.',
    },
    whyYouCare: {
      it: 'Headless = perf top + custom UX impossibile su template.\nCosto: dev iniziale 15-50k€, team forte.\nSi giustifica oltre 500k€/anno revenue.',
      en: 'Headless = top perf + custom UX impossible on templates.\nCost: 15-50k€ initial dev, strong team.\nJustified above 500k€/year revenue.',
    },
    whatToDemand: {
      it: 'Per headless: piattaforma con API mature (Shopify Storefront API, BigCommerce GraphQL), CDN edge (Vercel/Netlify), monitoring perf.\nDecision matrix prima di migrare.',
      en: 'For headless: platforms with mature APIs (Shopify Storefront API, BigCommerce GraphQL), edge CDN (Vercel/Netlify), perf monitoring.\nDecision matrix before migrating.',
    },
  },
  {
    slug: 'ltv',
    letter: 'L',
    term: 'LTV',
    fullName: 'Customer Lifetime Value',
    whatItIs: {
      it: "Valore totale che un cliente porta in tutta la sua vita di relazione con il brand.\nCalcolato come AOV × frequenza acquisti × retention.\nPredittivo per quanto puoi spendere in CAC.",
      en: "Total value a customer brings during their entire relationship with the brand.\nComputed as AOV × purchase frequency × retention.\nPredictive of how much you can spend on CAC.",
    },
    whyYouCare: {
      it: "Regola: LTV/CAC ratio > 3 sostenibile.\nSe LTV = 100€ e CAC = 50€, ratio 2 = stai bruciando margine.\nSenza LTV non puoi giudicare se ad spending è razionale.",
      en: "Rule: LTV/CAC ratio > 3 sustainable.\nIf LTV = 100€ and CAC = 50€, ratio 2 = you're burning margin.\nWithout LTV you can't judge if ad spending is rational.",
    },
    whatToDemand: {
      it: 'Calcolo LTV per segmento (acquisition channel, primo prodotto, geo).\nDashboard cohort retention monthly.\nAlert quando LTV trend down (predittivo di churn).',
      en: 'LTV calculation per segment (acquisition channel, first product, geo).\nMonthly cohort retention dashboard.\nAlert when LTV trends down (predictive of churn).',
    },
  },
  {
    slug: 'mrr',
    letter: 'M',
    term: 'MRR',
    fullName: 'Monthly Recurring Revenue',
    whatItIs: {
      it: 'Revenue mensile ricorrente da subscription.\nVale per e-commerce subscription-based (Dollar Shave Club, HelloFresh) e SaaS.\nNon vale per e-commerce one-shot.',
      en: 'Monthly recurring revenue from subscriptions.\nValid for subscription-based e-commerce (Dollar Shave Club, HelloFresh) and SaaS.\nNot for one-shot e-commerce.',
    },
    whyYouCare: {
      it: "MRR è metric più valuable del retail puro: prevedibilità revenue, valutazione VC più alta.\nSe hai un prodotto consumable, valutare modello subscription può raddoppiare valuation.",
      en: 'MRR is a more valuable metric than pure retail: revenue predictability, higher VC valuation.\nIf you have a consumable, considering subscription model can double valuation.',
    },
    whatToDemand: {
      it: 'Subscription tier chiari, churn tracking mensile, expansion MRR (upsell esistenti) + new MRR (acquisition).\nNet MRR Growth Rate target >5% mensile in early stage.',
      en: 'Clear subscription tiers, monthly churn tracking, expansion MRR (upsell existing) + new MRR (acquisition).\nTarget Net MRR Growth Rate >5% monthly in early stage.',
    },
  },
  {
    slug: 'marketplace',
    letter: 'M',
    term: 'Marketplace',
    whatItIs: {
      it: "Piattaforma che mette in contatto venditori (third-party) con buyer.\nEsempi: Amazon Marketplace, Etsy, eBay, Zalando Connected Retail.\nModello revenue: commissione (take rate) per transazione.",
      en: 'Platform connecting sellers (third-party) to buyers.\nExamples: Amazon Marketplace, Etsy, eBay, Zalando Connected Retail.\nRevenue model: per-transaction commission (take rate).',
    },
    whyYouCare: {
      it: "Vendere su marketplace = traffic gratis, ma cedi 8-30% commissione + dipendenza piattaforma.\nStrategy ibrida (proprio sito + marketplace) protegge da dipendenza singola.",
      en: 'Selling on a marketplace = free traffic, but you give up 8-30% commission + platform dependency.\nHybrid strategy (own site + marketplace) protects from single dependency.',
    },
    whatToDemand: {
      it: 'Mix canale: 60-70% sito proprio (margine alto, brand control), 30-40% marketplace (volume, brand reach).\nMai 100% marketplace (rischio TOS change come Amazon ban improvvisi).',
      en: 'Channel mix: 60-70% own site (high margin, brand control), 30-40% marketplace (volume, brand reach).\nNever 100% marketplace (TOS-change risk like sudden Amazon bans).',
    },
  },
  {
    slug: 'nps',
    letter: 'N',
    term: 'NPS',
    fullName: 'Net Promoter Score',
    whatItIs: {
      it: '"Quanto raccomanderesti il brand a un amico/collega?" su scala 0-10.\nDetractors (0-6), Passives (7-8), Promoters (9-10).\nNPS = %Promoters − %Detractors.\nRange -100 a +100.',
      en: '"How likely are you to recommend the brand to a friend/colleague?" on a 0-10 scale.\nDetractors (0-6), Passives (7-8), Promoters (9-10).\nNPS = %Promoters − %Detractors.\nRange -100 to +100.',
    },
    whyYouCare: {
      it: 'NPS misura word-of-mouth potenziale, leading indicator di organic growth.\nNPS <30 = brand non genera passaparola, growth sarà solo paid.',
      en: 'NPS measures word-of-mouth potential, a leading indicator of organic growth.\nNPS <30 = brand doesn\'t drive word-of-mouth, growth will be paid only.',
    },
    whatToDemand: {
      it: 'NPS survey post-purchase (30 giorni dopo) + post-support, target >40 (settore retail).\nOpen question follow-up "perché?" per qualitative insight.\nTool: Delighted, AskNicely, custom Typeform.',
      en: 'Post-purchase NPS survey (30 days after) + post-support, target >40 (retail benchmark).\nFollow-up open question "why?" for qualitative insight.\nTools: Delighted, AskNicely, custom Typeform.',
    },
  },
  {
    slug: 'omnichannel',
    letter: 'O',
    term: 'Omnichannel',
    whatItIs: {
      it: 'Strategia in cui customer experience è coerente attraverso canali (online, fisico, mobile, social, marketplace).\nNon è multi-channel (canali separati) ma integrazione (es. compra online ritira in negozio, return cross-channel).',
      en: 'Strategy where customer experience is consistent across channels (online, physical, mobile, social, marketplace).\nNot multi-channel (separate channels) but integration (e.g. buy online pick up in store, cross-channel returns).',
    },
    whyYouCare: {
      it: 'Customer omnichannel spende +30% lifetime vs single-channel (HBR).\nNon implementare omnichannel oggi = lasciare valore sul tavolo.',
      en: 'Omnichannel customers spend +30% lifetime vs single-channel (HBR).\nNot implementing omnichannel today = leaving value on the table.',
    },
    whatToDemand: {
      it: 'Customer ID unificato cross-canale, inventory unificato (real-time stock disponibile online + fisico), staff retail con accesso ordini online cliente, BOPIS (Buy Online Pickup In Store) almeno opzionale.',
      en: 'Unified customer ID cross-channel, unified inventory (real-time stock available online + physical), retail staff with access to customer online orders, BOPIS (Buy Online Pickup In Store) at least optional.',
    },
  },
  {
    slug: 'payment-gateway',
    letter: 'P',
    term: 'Payment Gateway',
    whatItIs: {
      it: 'Servizio che processa pagamenti carta/PayPal/Apple Pay tra cliente e merchant.\nEsempi: Stripe, Adyen, PayPal, Mollie, Braintree.\nCommissione tipica: 1.4-2.9% + fee fissa per transazione.',
      en: 'Service processing card/PayPal/Apple Pay payments between customer and merchant.\nExamples: Stripe, Adyen, PayPal, Mollie, Braintree.\nTypical commission: 1.4-2.9% + fixed per-transaction fee.',
    },
    whyYouCare: {
      it: 'Gateway sbagliato = transaction fee alti + tasso failure alto su 3DS = perdi vendite.\nRegion matters: Stripe top USA/EU, Adyen enterprise globale, PayPal alta brand trust.',
      en: 'Wrong gateway = high transaction fees + high 3DS failure rate = lost sales.\nRegion matters: Stripe top USA/EU, Adyen enterprise global, PayPal high brand trust.',
    },
    whatToDemand: {
      it: 'Multi-gateway setup (es. Stripe primary + PayPal secondary), local payment methods (SEPA EU, Klarna BNPL, iDEAL NL), 3DS Authentication ottimizzato (frictionless quando possibile).',
      en: 'Multi-gateway setup (e.g. Stripe primary + PayPal secondary), local payment methods (SEPA EU, Klarna BNPL, iDEAL NL), optimised 3DS Authentication (frictionless when possible).',
    },
  },
  {
    slug: 'pim',
    letter: 'P',
    term: 'PIM',
    fullName: 'Product Information Management',
    whatItIs: {
      it: "Sistema centrale per gestire informazioni prodotto (titolo, descrizioni, attributi, immagini, traduzioni) e distribuirle a multiple destinations (sito, marketplace, ERP, catalogo cartaceo).\nEs: Akeneo, Pimcore, Salsify.",
      en: "Central system for managing product information (title, descriptions, attributes, images, translations) and distributing to multiple destinations (site, marketplace, ERP, paper catalogue).\nE.g. Akeneo, Pimcore, Salsify.",
    },
    whyYouCare: {
      it: 'Senza PIM, content prodotto vive in spreadsheet/email/CMS = caos, errori, traduzioni desincronizzate.\nCatalogo >500 SKU + multi-canale = PIM diventa quasi obbligatorio.',
      en: 'Without PIM, product content lives in spreadsheet/email/CMS = chaos, errors, out-of-sync translations.\nCatalogue >500 SKU + multi-channel = PIM becomes almost mandatory.',
    },
    whatToDemand: {
      it: 'PIM se >500 SKU + multi-canale + multi-lingua.\nSotto, custom CMS structure può bastare.\nAkeneo Community è gratuito (open source), Salsify enterprise paid.',
      en: 'PIM if >500 SKU + multi-channel + multi-language. Below, custom CMS structure may suffice. Akeneo Community is free (open source), Salsify enterprise paid.',
    },
  },
  {
    slug: 'returns-rate',
    letter: 'R',
    term: 'Returns Rate',
    fullName: 'Tasso di reso',
    whatItIs: {
      it: 'Percentuale di ordini restituiti.\nBenchmark: fashion 15-30%, elettronica 5-10%, beauty 3-7%.\nCategoria con returns rate >25% = costo logistic significativo.',
      en: 'Percentage of returned orders.\nBenchmark: fashion 15-30%, electronics 5-10%, beauty 3-7%.\nCategory with returns rate >25% = significant logistics cost.',
    },
    whyYouCare: {
      it: 'Returns rate alto erode margine: shipping return + restocking + perdita prodotto se non rivendibile.\nCause comuni: foto prodotto non rappresentative, sizing chart errato, product description vaga.',
      en: 'High returns rate erodes margin: return shipping + restocking + product loss if unsellable.\nCommon causes: non-representative product photos, wrong sizing chart, vague product description.',
    },
    whatToDemand: {
      it: 'Tracking returns per categoria + reason (size, defect, expectations mismatch).\nReturns reason analytics drive product description/foto improvements.\nReturns process via portale self-service.',
      en: 'Track returns by category + reason (size, defect, expectations mismatch).\nReturns reason analytics drive product description/photo improvements.\nReturns process via self-service portal.',
    },
  },
  {
    slug: 'sku',
    letter: 'S',
    term: 'SKU',
    fullName: 'Stock Keeping Unit',
    whatItIs: {
      it: 'Codice univoco identificatore di una variante prodotto (es. "TSHIRT-RED-M" = T-shirt rossa size M).\nDiverso da product (T-shirt rossa) che può avere più SKU (size XS/S/M/L/XL).',
      en: 'Unique code identifying a product variant (e.g. "TSHIRT-RED-M" = red T-shirt size M). Different from product (red T-shirt) which may have multiple SKUs (size XS/S/M/L/XL).',
    },
    whyYouCare: {
      it: 'SKU naming inconsistente = nightmare in inventory + analytics.\nSKU duplicati = ordine sbagliato/missed inventory.\nPattern naming standard è infrastruttura essenziale.',
      en: 'Inconsistent SKU naming = inventory + analytics nightmare. Duplicate SKUs = wrong order/missed inventory. Standard naming pattern is essential infrastructure.',
    },
    whatToDemand: {
      it: 'Pattern SKU documentato: [CATEGORY]-[VARIANT]-[SIZE], es. TSHIRT-RED-M.\nSKU univoco enforced via DB constraint.\nAudit tool dup detection trimestrale.',
      en: 'Documented SKU pattern: [CATEGORY]-[VARIANT]-[SIZE], e.g. TSHIRT-RED-M. Unique SKU enforced via DB constraint. Quarterly audit tool for dup detection.',
    },
  },
  {
    slug: 'shipping',
    letter: 'S',
    term: 'Shipping',
    fullName: 'Spedizione',
    whatItIs: {
      it: 'Servizio di consegna del prodotto al cliente.\nVariabili: cost, time, carrier (DHL/UPS/FedEx/local post), insurance, tracking, return policy.',
      en: 'Product delivery service to customer. Variables: cost, time, carrier (DHL/UPS/FedEx/local post), insurance, tracking, return policy.',
    },
    whyYouCare: {
      it: 'Shipping = #1 motivo di abandoned cart (50% dei casi quando aggiunto solo al checkout).\nFree shipping è il singolo più potente CRO lever (con soglia AOV).',
      en: 'Shipping = #1 reason for abandoned cart (50% of cases when added only at checkout). Free shipping is the single most powerful CRO lever (with AOV threshold).',
    },
    whatToDemand: {
      it: 'Shipping cost transparent dal carrello (no surprise checkout), free shipping threshold testato (AOV uplift), tracking real-time, multiple carrier per region.\nMai shipping nascosto fino al checkout.',
      en: 'Transparent shipping cost from cart (no checkout surprises), tested free shipping threshold (AOV uplift), real-time tracking, multiple carriers per region. Never hidden shipping until checkout.',
    },
  },
  {
    slug: 'upsell',
    letter: 'U',
    term: 'Upsell',
    whatItIs: {
      it: 'Suggerimento di una versione superiore (più costosa) dello stesso prodotto.\nEsempio: in un ristorante "vuoi il menu large?".\nDiverso da cross-sell (prodotto complementare).',
      en: 'Suggestion of a higher (more expensive) version of the same product. Example: at a restaurant "want the large menu?". Different from cross-sell (complementary product).',
    },
    whyYouCare: {
      it: 'Upsell ben fatto +15-25% AOV.\nUpsell pushy o irrilevante = annoyance + churn.',
      en: 'Well-done upsell raises AOV +15-25%. Pushy or irrelevant upsell = annoyance + churn.',
    },
    whatToDemand: {
      it: 'Upsell rilevante solo (es. "premium version stesso prodotto" non "altro brand").\nPosizione: PDP + cart drawer.\nFrame come "Upgrade for X€ more".',
      en: 'Only relevant upsell (e.g. "premium version of same product", not "another brand"). Position: PDP + cart drawer. Frame as "Upgrade for X€ more".',
    },
  },
];

export const GLOSSARIO_ECOMMERCE_LETTERS = Array.from(
  new Set(GLOSSARIO_ECOMMERCE.map((t) => t.letter)),
).sort();

export type EcommerceTermLocalised = {
  slug: string;
  letter: string;
  term: string;
  fullName?: string;
  whatItIs: string;
  whyYouCare: string;
  whatToDemand: string;
};

export function localiseEcommerceTerms(locale: Locale): EcommerceTermLocalised[] {
  return GLOSSARIO_ECOMMERCE.map((t) => ({
    slug: t.slug,
    letter: t.letter,
    term: t.term,
    fullName: t.fullName,
    whatItIs: t.whatItIs[locale],
    whyYouCare: t.whyYouCare[locale],
    whatToDemand: t.whatToDemand[locale],
  }));
}

export const GLOSSARIO_ECOMMERCE_META = {
  it: {
    metaTitle: 'Glossario E-commerce 2026 · I 25 termini che separano chi vende da chi spera | Federico Calicchia',
    description:
      'AOV, CRO, LTV, Abandoned Cart, Headless Commerce, Omnichannel… 25 termini e-commerce spiegati semplici. Per ogni termine: cos\'è, perché ti riguarda, cosa pretendere dal fornitore.',
    ogTitle: 'Glossario E-commerce 2026 · 25 termini essenziali',
    ogDescription: 'AOV, CRO, LTV, Abandoned Cart, Omnichannel. Spiegati per quello che sono — e perché ti riguardano.',
    eyebrow: 'Glossario — 25 termini · ordine A-Z',
    pageTitle: 'Glossario E-commerce 2026. I 25 termini che separano chi vende da chi spera.',
    lead:
      'L\'e-commerce è pieno di buzzword nascoste in cifre belle.\nEcco i 25 termini che ti permettono di capire se chi ti vende soluzioni e-commerce sa davvero cosa fa.\nPer ogni termine: cos\'è, perché ti riguarda, cosa pretendere dal fornitore.',
    readTime: 'lettura libera',
    updatedAt: '9 maggio 2026',
    sectionWhatItIs: "Cos'è",
    sectionWhyYouCare: 'Perché ti riguarda',
    sectionWhatToDemand: 'Cosa pretendere',
    closingTitle: 'Adesso quando un fornitore ti dice "il GMV cresce", sai cosa chiedere subito dopo (margin, take rate, churn).',
    ctaPrimary: 'Parlane con uno che capisce',
    ctaSecondary: 'Vai al servizio E-commerce',
    breadcrumbServiceName: 'Servizi',
    breadcrumbGlossaryName: 'Glossario E-commerce',
  },
  en: {
    metaTitle: 'E-commerce Glossary 2026 · The 25 terms separating those who sell from those who hope | Federico Calicchia',
    description:
      'AOV, CRO, LTV, Abandoned Cart, Headless Commerce, Omnichannel… 25 e-commerce terms explained simply. For each term: what it is, why it matters, what to demand from your vendor.',
    ogTitle: 'E-commerce Glossary 2026 · 25 essential terms',
    ogDescription: 'AOV, CRO, LTV, Abandoned Cart, Omnichannel. Explained for what they are — and why they matter to you.',
    eyebrow: 'Glossary — 25 terms · A-Z order',
    pageTitle: 'E-commerce Glossary 2026. The 25 terms separating those who sell from those who hope.',
    lead:
      'E-commerce is full of buzzwords hidden in pretty numbers.\nHere are the 25 terms that let you tell if whoever sells you e-commerce solutions actually knows what they\'re doing.\nFor each term: what it is, why it matters, what to demand from your vendor.',
    readTime: 'free reading',
    updatedAt: 'May 9, 2026',
    sectionWhatItIs: 'What it is',
    sectionWhyYouCare: 'Why it matters',
    sectionWhatToDemand: 'What to demand',
    closingTitle: 'Now when a vendor tells you "GMV is growing", you know what to ask right after (margin, take rate, churn).',
    ctaPrimary: 'Talk to someone who gets it',
    ctaSecondary: 'See e-commerce service',
    breadcrumbServiceName: 'Services',
    breadcrumbGlossaryName: 'E-commerce Glossary',
  },
} as const;
