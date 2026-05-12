import type { EditorialChapterEntry } from '@/components/layout/EditorialArticleLayout';

export type CompareRow = { label: string; designer: string; developer: string };

export type WdvdLocaleContent = {
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
  table: { kicker: string; aspectHeader: string; designerHeader: string; developerHeader: string; rows: CompareRow[] };
  origin: { kicker: string; lead: string; body: string[] };
  designer: { kicker: string; lead: string; body: string[] };
  developer: { kicker: string; lead: string; body: string[] };
  unione: { kicker: string; lead: string; body: string[] };
  separated: { kicker: string; lead: string; body: string[] };
};

const IT: WdvdLocaleContent = {
  metaTitle:
    'Web Designer vs Web Developer · Differenze reali e perché scegliere uno solo è la trappola | Federico Calicchia',
  metaDescription:
    "Web Designer e Web Developer: cosa fa davvero ognuno, dove finisce uno e inizia l'altro, perché la separazione di ruoli è un'eredità da agenzia. Quando scegliere chi fa entrambi.",
  ogTitle: 'Web Designer vs Web Developer · Differenze reali (e perché entrambi in uno è meglio)',
  ogDescription: "Cosa fa davvero ognuno, dove finisce uno e inizia l'altro. Perché la separazione di ruoli è eredità agenzia.",
  schemaTitle: 'Web Designer vs Web Developer · Differenze reali e perché scegliere uno solo è la trappola',
  schemaDescription: "Cosa fa davvero ognuno, dove finisce uno e inizia l'altro, perché la separazione di ruoli è eredità agenzia.",
  schemaSection: 'Web Design',
  breadcrumbs: [
    { name: 'Home', url: '/' },
    { name: 'Web Designer Freelance', url: '/web-design-freelance' },
    { name: 'Web Designer vs Web Developer', url: '/web-designer-vs-developer' },
  ],
  eyebrow: 'Posizionamento — 6 capitoli · 6 minuti di lettura',
  title: 'Web Designer vs Web Developer. Differenze reali e perché scegliere uno solo è la trappola.',
  lead: 'Sono due lavori diversi.\nSpesso te li vendono come due fatture diverse — ma chi fa entrambi fa risparmiare tempo, soldi e quel limbo dove il design è bello e il sito non funziona (o viceversa).',
  readTime: '6 min',
  updatedAt: '8 maggio 2026',
  chapterLabels: [
    { id: 'tabella', number: '01', label: 'Tabella delle differenze' },
    { id: 'origine', number: '02', label: 'Da dove viene la separazione' },
    { id: 'designer', number: '03', label: 'Cosa fa il Web Designer' },
    { id: 'developer', number: '04', label: 'Cosa fa il Web Developer' },
    { id: 'unione', number: '05', label: 'Perché entrambi in uno funziona' },
    { id: 'quando-separati', number: '06', label: 'Quando scegliere due figure separate' },
  ],
  table: {
    kicker: '01 — Le differenze in tabella',
    aspectHeader: 'Aspetto',
    designerHeader: 'Web Designer',
    developerHeader: 'Web Developer',
    rows: [
      {
        label: 'Cosa decide',
        designer: 'Layout, gerarchie visive, tipografia, palette, micro-interazioni, percorso utente, identità visiva.',
        developer: 'Stack tecnico (framework, database, hosting), performance, sicurezza, integrazioni, architettura del codice.',
      },
      {
        label: 'Tool primari',
        designer: 'Figma, Sketch, Adobe XD, browser DevTools, Lighthouse (lato visivo).',
        developer: 'Editor di codice, terminale, Git, framework (React, Next.js, Vue), DevOps, monitoring.',
      },
      {
        label: 'Output',
        designer: 'File Figma, design system, prototipo cliccabile, asset esportati, brand guidelines.',
        developer: 'Codice funzionante deployato, repository Git, documentazione tecnica, infrastruttura.',
      },
      {
        label: 'Limite quando lavora da solo',
        designer: 'Disegno bellissimo che il dev non può implementare (font esotico in webfont da 4MB, layout che non scrolla bene mobile, interazioni che richiedono librerie pesanti).',
        developer: "Sito che funziona ma sembra una demo da hackathon.\nTipografia Times New Roman, colori da default Tailwind, UI che ignora il brand, UX deciso 'a sentimento'.",
      },
      {
        label: 'Cosa ti costa',
        designer: 'Design favoloso che il dev (interno o freelance separato) deve adattare, semplificare o reimplementare.\nHand-off doloroso, fedeltà persa, due fatture.',
        developer: 'Sito tecnicamente pulito ma indistinguibile da 50 altri.\nDevi pagare un designer separato per dare personalità, oppure rimanere generico.',
      },
    ],
  },
  origin: {
    kicker: '02 — Da dove viene la separazione',
    lead: 'La separazione "designer fa il design, developer scrive il codice" è eredità delle agenzie anni 2000, quando i due mondi parlavano lingue diverse e gli strumenti non si toccavano.',
    body: [
      'Nel 2026 questa divisione non regge più.\nI tool moderni (Figma con Code Connect, Tailwind, componenti React/Vue, design system tokenizzati) hanno reso il passaggio design→codice molto più fluido.\nLe persone serie nel settore conoscono entrambi i lati: un designer che non capisce cosa sia un media query disegna layout impossibili da implementare; un developer che non capisce tipografia e gerarchie visive scrive interfacce illeggibili.',
      'La realtà è che i due ruoli si sono fusi nei freelance moderni.\nLe agenzie li tengono separati perché così possono fatturarli separatamente.\nÈ business, non tecnica.',
    ],
  },
  designer: {
    kicker: '03 — Cosa fa esattamente il Web Designer',
    lead: 'Il Web Designer decide come il sito appare, si legge, si naviga.\nNon è "fare cose belle": è ingegneria visiva applicata.',
    body: [
      '<strong>Cosa fa concretamente:</strong> wireframe e mockup in Figma, gerarchie tipografiche (display, body, mono, scale modulari), palette colore con contrasti WCAG-compliant, spaziature sistematiche (8/16/24px o equivalente), componenti design system riusabili, micro-interazioni (hover, focus, transition), responsive breakpoint, prototipazione cliccabile, brand consistency.',
      '<strong>Cosa NON fa (in teoria):</strong> scrivere codice, deploy, configurare hosting, ottimizzare query database, integrare API, performance backend.\nIn pratica, i designer moderni sanno quanto basta per non disegnare cose impossibili.',
    ],
  },
  developer: {
    kicker: '04 — Cosa fa esattamente il Web Developer',
    lead: 'Il Web Developer trasforma il design in qualcosa che funziona, scala, ed è sicuro.',
    body: [
      '<strong>Cosa fa concretamente:</strong> implementa il design in codice (HTML/CSS/JS o framework moderno), sceglie lo stack (React, Next.js, Vue, vanilla, WordPress headless o classico), configura database e API, integra terze parti (pagamenti, CRM, analytics), si occupa di SEO tecnica, performance Core Web Vitals, sicurezza, deploy, hosting, monitoring, backup, manutenzione long-term.',
      '<strong>Cosa NON fa (in teoria):</strong> design visivo, branding, copywriting, UX flow.\nIn pratica, i developer moderni si rifiutano di lavorare con design poveri e spesso "li sistemano in itinere".',
    ],
  },
  unione: {
    kicker: '05 — Perché entrambi in uno funziona meglio (per progetti piccoli e medi)',
    lead: 'Per il 90% dei progetti — sito vetrina, e-commerce piccolo/medio, landing page, blog, portfolio — avere una persona che fa entrambi è oggettivamente meglio.',
    body: [
      '<strong>1. Niente hand-off doloroso.</strong> Il design viene già pensato per essere implementato.\nNiente "ah, questo gradient non si può fare".\nNiente "questo font costa 800€ di license".\nDecisioni prese sapendo come finiscono nel codice.',
      '<strong>2. Una fattura, un punto di contatto.</strong> Niente discussioni "questa non è colpa mia, è del designer/developer".\nUna persona che progetta, costruisce, e mantiene.',
      '<strong>3. Iterazioni veloci.</strong> Vuoi cambiare un componente?\nLa stessa persona aggiorna il design Figma e il codice in mezz\'ora.\nCon due figure separate diventano due meeting, due preventivi extra, due settimane.',
      '<strong>4. Coerenza.</strong> Un solo cervello fa scelte coerenti tra layout e tecnica: performance e bellezza non sono in conflitto, sono parte dello stesso lavoro.',
    ],
  },
  separated: {
    kicker: '06 — Quando scegliere due figure separate',
    lead: 'Per onestà intellettuale: ci sono casi in cui due specialisti separati sono la scelta giusta.',
    body: [
      '<strong>Progetti grandi e complessi:</strong> piattaforme SaaS multi-tenant, e-commerce con 300.000 SKU, sistemi enterprise con audit di sicurezza ISO 27001, design system corporate con 200+ componenti.\nLì un solo freelance non basta — servono team, e dentro al team le specializzazioni hanno senso.',
      '<strong>Brand identity da zero per aziende grandi:</strong> il branding completo (naming, positioning, sistema visivo, brand book) è un lavoro a sé che giustifica un brand designer specializzato.\nNei progetti sotto i 100k€ però il branding "essenziale" lo gestisce bene anche un Designer-Developer.',
      '<strong>Backend custom complesso:</strong> microservizi distribuiti, integrazioni con ERP-SAP-Salesforce, machine learning.\nLì serve un developer puro, possibilmente con team DevOps.\nIl designer si limita a UI dell\'admin/dashboard.',
      '<strong>Per tutto il resto — sito vetrina, portfolio, e-commerce, blog, piattaforma piccola — una persona competente è quasi sempre la scelta più razionale.</strong> Costi più contenuti, tempi più veloci, zero passaggi di mano.',
    ],
  },
};

const EN: WdvdLocaleContent = {
  metaTitle:
    'Web Designer vs Web Developer · Real differences and why picking only one is the trap | Federico Calicchia',
  metaDescription:
    "Web Designer and Web Developer: what each one really does, where one ends and the other begins, why the role separation is an agency-era leftover. When to pick someone who does both.",
  ogTitle: 'Web Designer vs Web Developer · Real differences (and why both-in-one is better)',
  ogDescription: "What each one really does, where one ends and the other begins. Why the role separation is agency-era leftover.",
  schemaTitle: 'Web Designer vs Web Developer · Real differences and why picking only one is the trap',
  schemaDescription: "What each one really does, where one ends and the other begins, why the role separation is an agency-era leftover.",
  schemaSection: 'Web Design',
  breadcrumbs: [
    { name: 'Home', url: '/' },
    { name: 'Freelance Web Designer', url: '/web-design-freelance' },
    { name: 'Web Designer vs Web Developer', url: '/web-designer-vs-developer' },
  ],
  eyebrow: 'Positioning — 6 chapters · 6 min read',
  title: 'Web Designer vs Web Developer. Real differences and why picking only one is the trap.',
  lead: "They are two different jobs.\nThey are often sold to you as two separate invoices — but someone who does both saves you time, money, and that limbo where the design is beautiful and the site doesn't work (or vice versa).",
  readTime: '6 min',
  updatedAt: 'May 8, 2026',
  chapterLabels: [
    { id: 'tabella', number: '01', label: 'Differences in a table' },
    { id: 'origine', number: '02', label: 'Where the separation comes from' },
    { id: 'designer', number: '03', label: 'What the Web Designer does' },
    { id: 'developer', number: '04', label: 'What the Web Developer does' },
    { id: 'unione', number: '05', label: 'Why both-in-one works' },
    { id: 'quando-separati', number: '06', label: 'When to pick two separate roles' },
  ],
  table: {
    kicker: '01 — Differences in a table',
    aspectHeader: 'Aspect',
    designerHeader: 'Web Designer',
    developerHeader: 'Web Developer',
    rows: [
      {
        label: 'What they decide',
        designer: 'Layout, visual hierarchies, typography, palette, micro-interactions, user journey, visual identity.',
        developer: 'Tech stack (framework, database, hosting), performance, security, integrations, code architecture.',
      },
      {
        label: 'Primary tools',
        designer: 'Figma, Sketch, Adobe XD, browser DevTools, Lighthouse (visual side).',
        developer: 'Code editor, terminal, Git, frameworks (React, Next.js, Vue), DevOps, monitoring.',
      },
      {
        label: 'Output',
        designer: 'Figma files, design system, clickable prototype, exported assets, brand guidelines.',
        developer: 'Working deployed code, Git repository, technical documentation, infrastructure.',
      },
      {
        label: 'Limit when working alone',
        designer: 'Beautiful designs the dev cannot implement (exotic 4MB webfont, layout that scrolls badly on mobile, interactions requiring heavy libraries).',
        developer: "Site that works but looks like a hackathon demo.\nTimes New Roman typography, default Tailwind colours, UI ignoring the brand, UX decided 'by gut feel'.",
      },
      {
        label: 'What it costs you',
        designer: 'Gorgeous design the dev (in-house or separate freelance) must adapt, simplify or reimplement.\nPainful hand-off, fidelity lost, two invoices.',
        developer: 'Technically clean site indistinguishable from 50 others.\nYou must pay a separate designer for personality, or stay generic.',
      },
    ],
  },
  origin: {
    kicker: '02 — Where the separation comes from',
    lead: 'The "designer designs, developer codes" separation is a leftover from 2000s agencies, when the two worlds spoke different languages and tools didn\'t overlap.',
    body: [
      'In 2026 this division no longer holds.\nModern tools (Figma with Code Connect, Tailwind, React/Vue components, tokenised design systems) have made the design→code handoff much smoother.\nSerious people in the field know both sides: a designer who doesn\'t understand what a media query is draws layouts impossible to implement; a developer who doesn\'t understand typography and visual hierarchy writes unreadable interfaces.',
      'The reality is that the two roles have merged in modern freelancers.\nAgencies keep them separate because that way they can bill them separately.\nIt\'s business, not technique.',
    ],
  },
  designer: {
    kicker: '03 — What the Web Designer actually does',
    lead: 'The Web Designer decides how the site looks, reads, navigates.\nIt\'s not "making things pretty": it\'s applied visual engineering.',
    body: [
      '<strong>What they concretely do:</strong> wireframes and mockups in Figma, typographic hierarchies (display, body, mono, modular scales), colour palette with WCAG-compliant contrast, systematic spacing (8/16/24px or equivalent), reusable design system components, micro-interactions (hover, focus, transition), responsive breakpoints, clickable prototyping, brand consistency.',
      '<strong>What they DON\'T do (in theory):</strong> write code, deploy, configure hosting, optimise database queries, integrate APIs, backend performance.\nIn practice, modern designers know just enough not to draw impossible things.',
    ],
  },
  developer: {
    kicker: '04 — What the Web Developer actually does',
    lead: 'The Web Developer turns the design into something that works, scales, and is secure.',
    body: [
      '<strong>What they concretely do:</strong> implements the design in code (HTML/CSS/JS or modern framework), picks the stack (React, Next.js, Vue, vanilla, WordPress headless or classic), configures database and APIs, integrates third-parties (payments, CRM, analytics), handles technical SEO, Core Web Vitals performance, security, deploy, hosting, monitoring, backup, long-term maintenance.',
      '<strong>What they DON\'T do (in theory):</strong> visual design, branding, copywriting, UX flow.\nIn practice, modern developers refuse to work with poor designs and often "fix them on the fly".',
    ],
  },
  unione: {
    kicker: '05 — Why both-in-one works better (for small and medium projects)',
    lead: 'For 90% of projects — brochure site, small/medium e-commerce, landing page, blog, portfolio — having one person doing both is objectively better.',
    body: [
      '<strong>1. No painful hand-off.</strong> The design is already conceived to be implemented.\nNo "ah, this gradient can\'t be done".\nNo "this font costs 800€ in licensing".\nDecisions made knowing how they end up in code.',
      '<strong>2. One invoice, one point of contact.</strong> No discussions like "this isn\'t my fault, it\'s the designer/developer\'s".\nOne person who designs, builds, and maintains.',
      '<strong>3. Fast iterations.</strong> Want to change a component?\nThe same person updates the Figma design and the code in half an hour.\nWith two separate roles it becomes two meetings, two extra quotes, two weeks.',
      '<strong>4. Coherence.</strong> A single brain makes coherent choices between layout and technique: performance and beauty aren\'t in conflict, they\'re part of the same job.',
    ],
  },
  separated: {
    kicker: '06 — When to pick two separate roles',
    lead: "Intellectual honesty: there are cases where two separate specialists are the right call.",
    body: [
      '<strong>Large complex projects:</strong> multi-tenant SaaS platforms, e-commerce with 300,000 SKUs, enterprise systems with ISO 27001 security audit, corporate design systems with 200+ components.\nThere a single freelance isn\'t enough — you need a team, and inside a team specialisations make sense.',
      '<strong>Brand identity from scratch for large companies:</strong> full branding (naming, positioning, visual system, brand book) is its own job that justifies a specialised brand designer.\nFor projects under 100k€ though, "essential" branding is well-handled by a Designer-Developer.',
      '<strong>Complex custom backend:</strong> distributed microservices, ERP-SAP-Salesforce integrations, machine learning.\nThere you need a pure developer, ideally with a DevOps team.\nThe designer limits themselves to admin/dashboard UI.',
      '<strong>For everything else — brochure site, portfolio, e-commerce, blog, small platform — a single competent person is almost always the rational choice.</strong> Lower cost, faster timeline, zero hand-offs.',
    ],
  },
};

export const WDVD_CONTENT = { it: IT, en: EN } as const;

export function chapterEntries(content: WdvdLocaleContent): EditorialChapterEntry[] {
  return content.chapterLabels.map((c) => ({ id: c.id, number: c.number, label: c.label }));
}
