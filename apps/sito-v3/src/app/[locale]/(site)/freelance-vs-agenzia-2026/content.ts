import type { EditorialChapterEntry } from '@/components/layout/EditorialArticleLayout';

export type DimensionEntry = { n: string; name: string; body: string };
export type FlagEntry = { n: string; flag: string; body: string };
export type DecisionRow = { profile: string; suggestion: string; reason: string };

export type PillarLocaleContent = {
  metaTitle: string;
  metaDescription: string;
  ogTitle: string;
  ogDescription: string;
  schemaTitle: string;
  schemaDescription: string;
  schemaSection: string;
  breadcrumbs: { name: string; url: string }[];
  eyebrow: string;
  title: string;
  lead: string;
  readTime: string;
  updatedAt: string;
  chapterLabels: { id: string; number: string; label: string }[];
  intro: { kicker: string; lead: string; body: string[] };
  dimensions: { kicker: string; items: DimensionEntry[] };
  freelanceFlags: { kicker: string; lead: string; items: FlagEntry[] };
  agencyFlags: { kicker: string; lead: string; items: FlagEntry[] };
  matrix: { kicker: string; lead: string; items: DecisionRow[] };
  outro: { kicker: string; lead: string; body: string[] };
};

const IT: PillarLocaleContent = {
  metaTitle:
    'Freelance vs Agenzia 2026 · Differenze reali da chi lavora in entrambi i mondi | Federico Calicchia',
  metaDescription:
    "Freelance vs agenzia per il sito web nel 2026: cost-ownership-comm-accountability-scope-time. 5 segnali per scartare un freelance cattivo, 4 per scartare un'agenzia che vende fumo. Decision matrix per PMI, corporate e startup.",
  ogTitle: 'Freelance vs Agenzia 2026 · differenze reali, segnali bullshit, decision matrix',
  ogDescription:
    "6 dimensioni di confronto, 9 segnali per scartare i cattivi (5 freelance + 4 agenzia), decision matrix per profilo aziendale.",
  schemaTitle: 'Freelance vs Agenzia 2026 · differenze reali, segnali bullshit, decision matrix',
  schemaDescription:
    "Freelance vs agenzia per il sito web nel 2026: 6 dimensioni reali di confronto, 9 segnali per scartare i cattivi, decision matrix per PMI, corporate e startup.",
  schemaSection: 'Strategia',
  breadcrumbs: [
    { name: 'Home', url: '/' },
    { name: 'Perché scegliere me', url: '/perche-scegliere-me' },
    { name: 'Freelance vs Agenzia', url: '/freelance-vs-agenzia-2026' },
  ],
  eyebrow: 'Strategia — 6 capitoli · 9 minuti di lettura',
  title: 'Freelance vs Agenzia 2026. Differenze reali da chi lavora in entrambi i mondi.',
  lead:
    "Confronto onesto tra le due opzioni nel 2026, senza marketing fluff.\nSei dimensioni di costo reale, ownership, comunicazione, accountability, scope, time.\nNove segnali per scartare i cattivi prima che ti facciano perdere mesi e budget.\nUna decision matrix concreta per PMI, corporate, e-commerce, startup.",
  readTime: '9 min',
  updatedAt: '9 maggio 2026',
  chapterLabels: [
    { id: 'cosa-cambia', number: '01', label: 'Cosa cambia (no fluff)' },
    { id: 'dimensioni', number: '02', label: '6 dimensioni di confronto' },
    { id: 'freelance-rosso', number: '03', label: '5 segnali per scartare un freelance' },
    { id: 'agenzia-rosso', number: '04', label: '4 segnali bullshit-agenzia' },
    { id: 'matrix', number: '05', label: 'Decision matrix per profilo' },
    { id: 'realta', number: '06', label: 'Realtà 2026: il modello ibrido' },
  ],
  intro: {
    kicker: '01 — Cosa cambia tra freelance e agenzia (senza fluff)',
    lead:
      'La vera differenza non è "qualità" o "professionalità".\nEntrambe possono essere alte o basse.\nLa differenza è di modello operativo, e si traduce in compromessi precisi.',
    body: [
      "<strong>Freelance senior</strong> = una persona competente che fa il lavoro.\nDecisioni dirette, comunicazione veloce, costo medio-alto sull'ora, profondità su 1-2 verticali.\nBus factor 1: se sparisce, sparisce tutto.",
      "<strong>Agenzia</strong> = squadra strutturata.\nDecisioni filtrate dal PM, comunicazione via canali formali, costo gonfiato dall'overhead, scope largo ma profondità variabile per skill.\nBus factor alto: il sito sopravvive anche se chi l'ha fatto cambia lavoro.",
      '<strong>"Ma allora dipende"</strong>.\nSì, dipende — da costo, time-to-launch, complessità, stakeholder.\nLa domanda corretta non è "freelance o agenzia?" ma "qual è il mio profilo aziendale e quale modello regge il mio caso?".\nLe 6 dimensioni qui sotto rispondono.',
    ],
  },
  dimensions: {
    kicker: '02 — 6 dimensioni di confronto reale',
    items: [
      {
        n: '01',
        name: 'Costo reale (non solo preventivo)',
        body: 'Il preventivo è un punto di partenza.\nCosto reale = preventivo + tempo interno tuo (review, decisioni) + tempo perso in handoff + costo dei revamp se la prima consegna è sbagliata.\n\nFreelance senior: preventivo medio-alto, ma poco overhead, decisioni dirette.\nAgenzia: preventivo gonfiato del 30-50% per coprire margine, account, project manager — meno overhead per te (in teoria), più handoff (in pratica).',
      },
      {
        n: '02',
        name: 'Ownership del lavoro',
        body: "Chi decide e chi sa cosa è stato fatto?\nFreelance: decide e fa.\nSa tutto.\nLo trovi sempre — finché c'è.\n\nAgenzia: decide il senior, fa il junior, scrive le slide il PM.\nQuando il senior si licenzia, parte della knowledge se ne va con lui.\nPer progetti che vivono 5+ anni, ownership distribuita = rischio di perdita di contesto.",
      },
      {
        n: '03',
        name: 'Comunicazione (canali e velocità)',
        body: 'Freelance: WhatsApp/email/call diretta.\nRisposta in ore, decisioni in giornata.\n\nAgenzia: PM in mezzo, slack interno, kick-off settimanale, deck di status.\nRisposta in 1-3 giorni, decisioni in 1-2 settimane.\n\nPer chi ha cicli rapidi (e-commerce, SaaS) il delta agenzia è friction.\nPer chi ha cicli lunghi (corporate enterprise) il delta freelance è caos.',
      },
      {
        n: '04',
        name: 'Accountability (chi risponde quando rompe)',
        body: 'Freelance: rispondi tu o non risponde nessuno.\nSe sparisce, contratto inutile (causa internazionale costa più del progetto).\n\nAgenzia: contratto solido, SLA scritti, garanzie corporate.\nSe rompe il sito alle 3 di notte di Black Friday, qualcuno risponde — non sempre il senior, ma qualcuno.\nScelta di rischio: agenzia paga security blanket, freelance paga performance pure.',
      },
      {
        n: '05',
        name: 'Scope (cosa copre davvero)',
        body: "Freelance: profondo su 1-2 verticali (es. web design + dev), shallow su tutto il resto.\nAgenzia: copre catalogo (web + branding + ads + SEO + content + video) ma profondità varia molto per skill.\n\nMito da sfatare: 'agenzia full-service' non significa 'fa tutto bene' — significa 'fa tutto, alcune cose bene e altre per coprire il pacchetto'.\nSe ti serve solo web, freelance specializzato batte agenzia generalista.",
      },
      {
        n: '06',
        name: 'Time-to-launch',
        body: "Freelance: kick-off → consegna tipico 4-12 settimane (no overhead).\nAgenzia: 8-20 settimane (kick-off + discovery + brand workshop + design sprint + dev sprint + UAT + launch).\n\nPer MVP veloci, freelance vince.\nPer progetti che richiedono allineamento multi-stakeholder (e.g. corporate con marketing + legal + IT + brand), il processo agenzia è feature non bug.",
      },
    ],
  },
  freelanceFlags: {
    kicker: '03 — 5 segnali per scartare un freelance cattivo',
    lead: 'Esistono freelance bravi e altri che vivono del Cap-Cap del primo cliente che firma.\nEcco come distinguerli al primo contatto.',
    items: [
      {
        n: '01',
        flag: 'Portfolio vago o solo "concept"',
        body: "Mostra solo render Behance/Dribbble, non siti live in produzione.\nIl portfolio reale è quello indexato da Google con clienti veri.\nSe non c'è, non hai prova di consegna.\nStandard: 3+ siti live verificabili, almeno uno simile al tuo settore.",
      },
      {
        n: '02',
        flag: 'Risponde al primo call con preventivo',
        body: "Senza brief scritto, senza domande di scoperta, senza vedere il sito attuale, ti spara una cifra.\nSignifica: ha 3 fascia di prezzo (small/medium/large) e ti incastra in una.\nNon sta progettando per te.\nStandard: discovery prima del preventivo, anche minimo (1h call + brief scritto).",
      },
      {
        n: '03',
        flag: 'Stack random "qualunque cosa serve"',
        body: 'Dichiara di lavorare con WordPress + Webflow + Wix + Shopify + Magento + Custom React.\nSignifica: sa fare tutto male.\nLo specialista vero ha 2-3 stack solidi e dice no agli altri.\nStandard: chiedere quale stack consiglierebbe per il TUO caso e perché.',
      },
      {
        n: '04',
        flag: 'Niente contratto / contratto generico',
        body: 'Manda un Word di 1 pagina riciclato da template.\nNiente clausole su revisioni, change order, ownership IP, downtime, terminazione.\nStandard: contratto con scope esplicito, milestone, change order workflow, IP transfer su balance pagato, indennità su breach.',
      },
      {
        n: '05',
        flag: 'Pagamento tutto in advance o tutto a fine',
        body: 'Tutto in advance = se sparisce, hai perso tutto.\nTutto a fine = se non sei contento, non paghi (ma il freelance smart non firma neanche).\nStandard: tranches 30/40/30 o 25/25/25/25 legate a milestone misurabili, non al tempo.',
      },
    ],
  },
  agencyFlags: {
    kicker: '04 — 4 segnali bullshit-agenzia',
    lead: 'Le agenzie hanno un sales process strutturato.\nSaperlo leggere è metà del filtro.',
    items: [
      {
        n: '01',
        flag: '"Full-service" senza una specializzazione chiara',
        body: "Sito + branding + advertising + content + video + SEO + social + AI.\nTutto.\nSignifica: 12 junior generalisti gestiti da 1 senior overworked.\nIl deliverable medio è mediocre per copertura.\nStandard: agenzie che dichiarano apertamente 'noi siamo specialisti X, per Y collaboriamo con partner'.",
      },
      {
        n: '02',
        flag: 'Pitch deck pieno di loghi clienti enterprise senza dettagli',
        body: "Slide con 20 loghi (Coca-Cola, Pirelli, ENI).\nNessun caso studio con metriche.\nSignifica: hanno fatto 'qualcosa' per quei brand (forse una landing page singola, forse 1 mese di consulenza) e usano i loghi per autorevolezza.\nStandard: chiedere 2 case study con KPI prima/dopo e contatto cliente referenziabile.",
      },
      {
        n: '03',
        flag: 'Discovery sprint da 15-30k€ prima di un preventivo serio',
        body: "Vendono 'discovery' come servizio standalone, lungo 4-8 settimane, da pagare prima di sapere costo del sito.\nSignifica: stanno monetizzando l'incertezza che loro stessi hanno creato.\nStandard: discovery breve (1-2 settimane) incluso o accreditato sul preventivo finale.",
      },
      {
        n: '04',
        flag: 'PM bottleneck su tutta la comunicazione',
        body: 'Non puoi parlare con designer/dev mai, tutto passa dal PM.\nSignifica: parli con qualcuno che riassume male e che non ha potere decisionale.\nRisultato: round di feedback infiniti, errori di traduzione, frustration.\nStandard: PM presente ma sblocca call dirette designer/dev quando serve.',
      },
    ],
  },
  matrix: {
    kicker: '05 — Decision matrix per profilo aziendale',
    lead: 'Sei profili aziendali tipici, sei orientamenti.\nNon sono dogmi — sono il punto di partenza.',
    items: [
      {
        profile: 'PMI 1-30 dipendenti',
        suggestion: 'Freelance senior',
        reason: "Volume di progetto piccolo-medio, decisioni rapide, budget contenuto, scope focalizzato (web + qualche evolutiva).\nL'overhead agenzia non è giustificato.",
      },
      {
        profile: 'Studi professionali (avvocato/commercialista/architetto)',
        suggestion: 'Freelance specializzato in studi',
        reason: 'Brief specifico, requisiti SEO local, copy tecnico settore.\nIl freelance che ha già fatto 10 siti per studi simili batte agenzia generalista al primo brief.',
      },
      {
        profile: 'E-commerce 100k-2M€/anno',
        suggestion: 'Freelance + retainer ongoing',
        reason: 'Scope tecnico (Shopify/WooCommerce + integrazioni), serve qualcuno che lo segua mensile (CWV + tracking + nuovi feature).\nAgenzia per e-commerce piccolo è overkill.',
      },
      {
        profile: 'Corporate / multinazionale',
        suggestion: 'Agenzia',
        reason: 'Multi-stakeholder, compliance legale/brand, contratto strutturato, SLA enterprise, capacità di scalare team.\nFreelance singolo non regge il bandwidth richiesto.',
      },
      {
        profile: 'Startup pre-seed / seed',
        suggestion: 'Freelance MVP-mode',
        reason: 'Budget low, time-to-launch critico, scope variable (probabilmente cambierà).\nFreelance che fa MVP rapido in 4-6 settimane > agenzia con discovery sprint da 15k€.',
      },
      {
        profile: 'Startup Series A+',
        suggestion: 'Hybrid: in-house + freelance/agenzia per spike',
        reason: 'Scaling internal team, freelance/agenzia per overflow tactical.\nNé solo freelance (knowledge bus factor) né solo agenzia (over-priced per work continuativo).',
      },
    ],
  },
  outro: {
    kicker: '06 — Realtà 2026: il modello ibrido',
    lead: 'La dicotomia rigida freelance-vs-agenzia è invecchiata.\nNel 2026, il modello che funziona spesso è ibrido.',
    body: [
      'Cosa sta succedendo: i freelance senior si organizzano in <strong>collettivi e studio-of-one</strong> (es. Pentagram-style, ma in scala individuale).\nI clienti smart costruiscono <strong>panel di freelance verticali</strong>: uno per web, uno per branding, uno per ads.\nL\'agenzia non è più il default — è una delle opzioni.',
      '<strong>Vantaggio del panel di freelance</strong>: profondità ovunque (ognuno è specialista), niente overhead, costo aggregato comparabile a un\'agenzia mid.\n<strong>Svantaggio</strong>: tu sei il PM.\nDevi sapere coordinare, dare brief, allineare.\nPer chi non ha il tempo o la competenza, l\'agenzia resta la scelta meno faticosa.',
      '<strong>Il modello che vedo crescere più velocemente nel 2026</strong>: in-house lean (1-2 persone marketing/product) + freelance senior per work creativo profondo (web, branding, content) + agenzia tactical solo quando serve scaling temporaneo (campagne ads picco, traduzioni multi-lingua, eventi).\nNessuna delle 3 leve è "la soluzione" — sono componenti.',
    ],
  },
};

const EN: PillarLocaleContent = {
  metaTitle:
    'Freelance vs Agency 2026 · Real differences from someone who works in both worlds | Federico Calicchia',
  metaDescription:
    "Freelance vs agency for your website in 2026: cost-ownership-comm-accountability-scope-time. 5 red flags to drop a bad freelance, 4 to drop an agency selling smoke. Decision matrix for SMBs, corporate, and startups.",
  ogTitle: 'Freelance vs Agency 2026 · real differences, bullshit signals, decision matrix',
  ogDescription:
    '6 comparison dimensions, 9 red flags to filter the bad ones (5 freelance + 4 agency), decision matrix by company profile.',
  schemaTitle: 'Freelance vs Agency 2026 · real differences, bullshit signals, decision matrix',
  schemaDescription:
    'Freelance vs agency for your website in 2026: 6 real comparison dimensions, 9 red flags, decision matrix for SMBs, corporate, and startups.',
  schemaSection: 'Strategy',
  breadcrumbs: [
    { name: 'Home', url: '/' },
    { name: 'Why choose me', url: '/perche-scegliere-me' },
    { name: 'Freelance vs Agency', url: '/freelance-vs-agenzia-2026' },
  ],
  eyebrow: 'Strategy — 6 chapters · 9 min read',
  title: 'Freelance vs Agency 2026. Real differences from someone who works in both worlds.',
  lead:
    "Honest comparison between the two options in 2026, without marketing fluff.\nSix dimensions of real cost, ownership, communication, accountability, scope, time.\nNine red flags to drop the bad ones before they cost you months and budget.\nA concrete decision matrix for SMBs, corporate, e-commerce, startups.",
  readTime: '9 min',
  updatedAt: 'May 9, 2026',
  chapterLabels: [
    { id: 'cosa-cambia', number: '01', label: 'What actually changes (no fluff)' },
    { id: 'dimensioni', number: '02', label: '6 comparison dimensions' },
    { id: 'freelance-rosso', number: '03', label: '5 red flags on freelancers' },
    { id: 'agenzia-rosso', number: '04', label: '4 bullshit-agency signals' },
    { id: 'matrix', number: '05', label: 'Decision matrix by profile' },
    { id: 'realta', number: '06', label: '2026 reality: the hybrid model' },
  ],
  intro: {
    kicker: '01 — What actually changes between freelance and agency (no fluff)',
    lead:
      'The real difference isn\'t "quality" or "professionalism".\nBoth can be high or low.\nThe difference is operating model, and it translates into precise trade-offs.',
    body: [
      '<strong>Senior freelance</strong> = one competent person doing the work.\nDirect decisions, fast comms, mid-to-high hourly cost, depth on 1-2 verticals.\nBus factor 1: if they vanish, everything vanishes.',
      "<strong>Agency</strong> = structured team.\nDecisions filtered through the PM, comms via formal channels, cost inflated by overhead, broad scope but uneven depth across skills.\nHigh bus factor: the site survives even if the person who built it leaves.",
      '<strong>"It depends"</strong>.\nYes, it depends — on cost, time-to-launch, complexity, stakeholders.\nThe right question isn\'t "freelance or agency?" but "what is my company profile and which model holds for my case?".\nThe 6 dimensions below answer that.',
    ],
  },
  dimensions: {
    kicker: '02 — 6 real comparison dimensions',
    items: [
      {
        n: '01',
        name: 'Real cost (not just the quote)',
        body: 'The quote is a starting point.\nReal cost = quote + your internal time (reviews, decisions) + time lost in handoffs + cost of revamps if the first delivery is wrong.\n\nSenior freelance: mid-to-high quote, low overhead, direct decisions.\nAgency: quote inflated 30-50% to cover margin, account, project manager — less overhead for you (in theory), more handoffs (in practice).',
      },
      {
        n: '02',
        name: 'Ownership of the work',
        body: "Who decides and who knows what was done?\nFreelance: decides and does.\nKnows everything.\nAlways reachable — as long as they're around.\n\nAgency: senior decides, junior does, PM writes the slides.\nWhen the senior leaves, part of the knowledge leaves with them.\nFor projects that live 5+ years, distributed ownership = risk of context loss.",
      },
      {
        n: '03',
        name: 'Communication (channels and speed)',
        body: 'Freelance: direct WhatsApp/email/call.\nReply in hours, decisions same day.\n\nAgency: PM in the middle, internal Slack, weekly kick-off, status decks.\nReply in 1-3 days, decisions in 1-2 weeks.\n\nFor fast cycles (e-commerce, SaaS) the agency delta is friction.\nFor long cycles (enterprise corporate) the freelance delta is chaos.',
      },
      {
        n: '04',
        name: 'Accountability (who answers when it breaks)',
        body: "Freelance: you answer or no one does.\nIf they vanish, contract is useless (international litigation costs more than the project).\n\nAgency: solid contract, written SLAs, corporate guarantees.\nIf the site breaks at 3am on Black Friday, someone answers — not always the senior, but someone.\nRisk choice: agency pays for the security blanket, freelance pays for pure performance.",
      },
      {
        n: '05',
        name: 'Scope (what they actually cover)',
        body: "Freelance: deep on 1-2 verticals (e.g. web design + dev), shallow on everything else.\nAgency: covers catalogue (web + branding + ads + SEO + content + video) but depth varies massively by skill.\n\nMyth to bust: 'full-service agency' doesn't mean 'does everything well' — it means 'does everything, some things well and some to fill the package'.\nIf you only need web, a specialised freelance beats a generalist agency.",
      },
      {
        n: '06',
        name: 'Time-to-launch',
        body: 'Freelance: typical kickoff → delivery 4-12 weeks (no overhead).\nAgency: 8-20 weeks (kickoff + discovery + brand workshop + design sprint + dev sprint + UAT + launch).\n\nFor fast MVPs, freelance wins.\nFor projects that require multi-stakeholder alignment (e.g. corporate with marketing + legal + IT + brand), the agency process is a feature, not a bug.',
      },
    ],
  },
  freelanceFlags: {
    kicker: '03 — 5 red flags to drop a bad freelance',
    lead: 'There are good freelancers and others who survive by signing the first client who shows up.\nHere is how to tell them apart at first contact.',
    items: [
      {
        n: '01',
        flag: 'Portfolio vague or only "concepts"',
        body: 'Shows only Behance/Dribbble renders, no live production sites.\nThe real portfolio is the one indexed by Google with real clients.\nIf it\'s missing, you have no proof of delivery.\nStandard: 3+ verifiable live sites, at least one similar to your industry.',
      },
      {
        n: '02',
        flag: 'Replies to the first call with a quote',
        body: 'No written brief, no discovery questions, no look at your current site — they fire a number.\nMeans: they have 3 price tiers (small/medium/large) and they slot you in.\nThey are not designing for you.\nStandard: discovery before the quote, even minimal (1h call + written brief).',
      },
      {
        n: '03',
        flag: 'Random stack "whatever you need"',
        body: 'Claims to work with WordPress + Webflow + Wix + Shopify + Magento + Custom React.\nMeans: does everything badly.\nThe real specialist has 2-3 solid stacks and says no to the rest.\nStandard: ask which stack they would recommend for YOUR case and why.',
      },
      {
        n: '04',
        flag: 'No contract / generic contract',
        body: 'Sends a 1-page Word doc recycled from a template.\nNo clauses on revisions, change orders, IP ownership, downtime, termination.\nStandard: contract with explicit scope, milestones, change-order workflow, IP transfer on final balance, indemnities on breach.',
      },
      {
        n: '05',
        flag: 'Payment all upfront or all on delivery',
        body: 'All upfront = if they vanish, you lost it all.\nAll on delivery = if you are not happy, you don\'t pay (but a smart freelance won\'t sign that either).\nStandard: tranches 30/40/30 or 25/25/25/25 tied to measurable milestones, not to time.',
      },
    ],
  },
  agencyFlags: {
    kicker: '04 — 4 bullshit-agency signals',
    lead: 'Agencies have a structured sales process.\nKnowing how to read it is half the filter.',
    items: [
      {
        n: '01',
        flag: '"Full-service" with no clear specialisation',
        body: "Web + branding + advertising + content + video + SEO + social + AI.\nEverything.\nMeans: 12 generalist juniors managed by 1 overworked senior.\nMedian deliverable is mediocre for breadth.\nStandard: agencies that openly say 'we are X specialists, for Y we partner with others'.",
      },
      {
        n: '02',
        flag: 'Pitch deck full of enterprise client logos with no detail',
        body: "Slide with 20 logos (Coca-Cola, Pirelli, ENI).\nZero case studies with metrics.\nMeans: they did 'something' for those brands (maybe a single landing page, maybe 1 month of consulting) and use the logos for authority.\nStandard: ask for 2 case studies with before/after KPIs and a referenceable client contact.",
      },
      {
        n: '03',
        flag: 'Discovery sprint at 15-30k€ before a serious quote',
        body: "Sells 'discovery' as a standalone service, 4-8 weeks long, payable before knowing the cost of the site.\nMeans: they are monetising the uncertainty they themselves created.\nStandard: short discovery (1-2 weeks) included or credited towards the final quote.",
      },
      {
        n: '04',
        flag: 'PM bottleneck on all communication',
        body: 'You can never speak with designer/dev, everything goes through the PM.\nMeans: you talk to someone who summarises poorly and has no decision power.\nResult: endless feedback rounds, translation errors, frustration.\nStandard: PM present but unblocks direct designer/dev calls when needed.',
      },
    ],
  },
  matrix: {
    kicker: '05 — Decision matrix by company profile',
    lead: 'Six typical profiles, six orientations.\nNot dogmas — just the starting point.',
    items: [
      {
        profile: 'SMB 1-30 employees',
        suggestion: 'Senior freelance',
        reason: "Small-to-medium project volume, fast decisions, contained budget, focused scope (web + some evolutions).\nAgency overhead isn't justified.",
      },
      {
        profile: 'Professional firms (lawyer/accountant/architect)',
        suggestion: 'Freelance specialised in firms',
        reason: 'Specific brief, local SEO requirements, sector-technical copy.\nThe freelance who has already done 10 sites for similar firms beats a generalist agency at the first brief.',
      },
      {
        profile: 'E-commerce 100k-2M€/year',
        suggestion: 'Freelance + ongoing retainer',
        reason: 'Technical scope (Shopify/WooCommerce + integrations), needs someone monthly (CWV + tracking + new features).\nAgency for small e-commerce is overkill.',
      },
      {
        profile: 'Corporate / multinational',
        suggestion: 'Agency',
        reason: 'Multi-stakeholder, legal/brand compliance, structured contract, enterprise SLA, ability to scale teams.\nA single freelance cannot hold the bandwidth.',
      },
      {
        profile: 'Pre-seed / seed startup',
        suggestion: 'Freelance MVP-mode',
        reason: 'Low budget, critical time-to-launch, variable scope (will likely change).\nA freelance shipping an MVP in 4-6 weeks > agency with a 15k€ discovery sprint.',
      },
      {
        profile: 'Series A+ startup',
        suggestion: 'Hybrid: in-house + freelance/agency for spikes',
        reason: 'Scaling internal team, freelance/agency for tactical overflow.\nNeither freelance-only (knowledge bus factor) nor agency-only (over-priced for continuous work).',
      },
    ],
  },
  outro: {
    kicker: '06 — 2026 reality: the hybrid model',
    lead: 'The rigid freelance-vs-agency dichotomy has aged.\nIn 2026, the model that works is often hybrid.',
    body: [
      'What\'s happening: senior freelancers organise in <strong>collectives and studios-of-one</strong> (Pentagram-style, but at individual scale).\nSmart clients build <strong>panels of vertical freelancers</strong>: one for web, one for branding, one for ads.\nThe agency is no longer the default — it\'s one option among many.',
      '<strong>Advantage of the freelance panel</strong>: depth everywhere (each is a specialist), no overhead, aggregated cost comparable to a mid agency.\n<strong>Drawback</strong>: you are the PM.\nYou must coordinate, brief, align.\nFor those without the time or the competence, the agency stays the lower-effort choice.',
      '<strong>The model I see growing fastest in 2026</strong>: lean in-house (1-2 people marketing/product) + senior freelance for deep creative work (web, branding, content) + tactical agency only when temporary scaling is needed (peak ads, multi-language translation, events).\nNone of the 3 levers is "the answer" — they are components.',
    ],
  },
};

export const FREELANCE_VS_AGENZIA_CONTENT = { it: IT, en: EN } as const;

export function chapterEntries(content: PillarLocaleContent): EditorialChapterEntry[] {
  return content.chapterLabels.map((c) => ({ id: c.id, number: c.number, label: c.label }));
}
