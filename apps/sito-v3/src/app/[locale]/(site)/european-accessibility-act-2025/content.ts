import type { EditorialChapterEntry } from '@/components/layout/EditorialArticleLayout';

export type SectorEntry = { label: string; detail: string };
export type ViolationEntry = { n: string; label: string; why: string };
export type PourPrinciple = { name: string; body: string };
export type AuditStep = { body: string };

export type EaaLocaleContent = {
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
  obligated: { kicker: string; lead: string; sectors: SectorEntry[]; afterNote: string };
  sanctions: { kicker: string; lead: string; body: string[] };
  wcag: { kicker: string; lead: string; principlesTitle: string; principles: PourPrinciple[] };
  violations: { kicker: string; items: ViolationEntry[] };
  checklist: { kicker: string; lead: string; steps: AuditStep[]; outro: string };
};

const IT: EaaLocaleContent = {
  metaTitle:
    'European Accessibility Act 2025 · Cosa devi fare se vendi online (entro 28 giugno) | Federico Calicchia',
  metaDescription:
    "European Accessibility Act in vigore dal 28 giugno 2025: chi è obbligato, quali siti devono essere accessibili WCAG 2.1 AA, sanzioni in Italia, audit checklist, scadenze.",
  ogTitle: 'European Accessibility Act 2025 · Cosa devi fare se vendi online',
  ogDescription: 'Chi è obbligato, sanzioni, audit checklist, scadenze. Niente compliance-washing.',
  schemaTitle: 'European Accessibility Act 2025 · Cosa devi fare se vendi online',
  schemaDescription: 'Chi è obbligato, sanzioni in Italia, audit checklist, scadenze. EAA in vigore dal 28 giugno 2025.',
  schemaSection: 'Web Accessibility',
  breadcrumbs: [
    { name: 'Home', url: '/' },
    { name: 'Servizi', url: '/servizi' },
    { name: 'European Accessibility Act 2025', url: '/european-accessibility-act-2025' },
  ],
  eyebrow: 'Compliance — 6 capitoli · 8 minuti di lettura',
  title: 'European Accessibility Act 2025. Cosa devi fare se vendi online (entro 28 giugno).',
  lead: "Dal 28 giugno 2025 l'European Accessibility Act è in vigore.\nSe vendi prodotti o servizi online a consumatori europei, il sito deve essere accessibile WCAG 2.1 AA.\nIn Italia le sanzioni arrivano fino a 40.000€ per violazione.\nNiente plugin \"accessibility\": serve audit serio nel codice.",
  readTime: '8 min',
  updatedAt: '8 maggio 2026',
  chapterLabels: [
    { id: 'cosa-e', number: '01', label: "Cosa è l'EAA" },
    { id: 'chi', number: '02', label: 'Chi è obbligato' },
    { id: 'sanzioni', number: '03', label: 'Sanzioni in Italia' },
    { id: 'wcag', number: '04', label: 'WCAG 2.1 AA come standard' },
    { id: 'violazioni', number: '05', label: '8 violazioni comuni' },
    { id: 'checklist', number: '06', label: 'Audit checklist' },
  ],
  intro: {
    kicker: "01 — Cosa è l'European Accessibility Act",
    lead: "L'European Accessibility Act (EAA) è la direttiva UE 2019/882 che impone standard di accessibilità a prodotti e servizi digitali venduti a consumatori europei.",
    body: [
      'In Italia è stata recepita con il <strong>Decreto Legislativo 82/2022</strong> (e successive modifiche).\nSi applica obbligatoriamente <strong>dal 28 giugno 2025</strong>.\nLa norma riguarda siti web, app, e-book, terminali self-service, servizi bancari, telecom, trasporti, e in generale qualsiasi servizio digitale in cui un consumatore può completare una transazione.',
      'Lo standard tecnico di riferimento è <strong>WCAG 2.1 livello AA</strong> (Web Content Accessibility Guidelines), nello specifico la norma armonizzata <strong>EN 301 549</strong>.\nNon è facoltativo, e non lo si raggiunge installando un plugin.',
    ],
  },
  obligated: {
    kicker: '02 — Chi è obbligato',
    lead: 'La regola generale: se vendi a consumatori finali europei (B2C) e il servizio è digitale, sei obbligato.\nSettori specifici nel decreto:',
    sectors: [
      { label: 'E-commerce B2C', detail: 'Qualsiasi sito che vende prodotti o servizi a consumatori finali europei: fashion, food, retail, prodotti digitali, abbonamenti SaaS B2C.' },
      { label: 'Banche e servizi finanziari', detail: 'Home banking, pagamenti, investimenti, prestiti.\nTutto ciò che gestisce denaro accessibile via web/app.' },
      { label: 'Telecom e ISP', detail: 'Servizi telefonia mobile/fissa, internet, contratti gestiti online (sottoscrizione, fatturazione, supporto).' },
      { label: 'Trasporti passeggeri', detail: 'Vendita biglietti, prenotazioni, informazioni real-time, app di navigazione del trasporto pubblico.' },
      { label: 'E-book e contenuti digitali', detail: 'Editori che vendono libri elettronici, piattaforme di lettura, abbonamenti contenuti.' },
      { label: 'Servizi audiovisivi on-demand', detail: 'Streaming video, piattaforme TV via internet, video di formazione vendute online.' },
    ],
    afterNote: '<strong>Esenzioni microimprese:</strong> il D.Lgs. 82/2022 prevede esenzioni parziali per microimprese (meno di 10 dipendenti e fatturato annuo sotto 2 milioni di euro) limitatamente a determinati servizi.\nLa sicurezza è verificare con un consulente specifico — l\'esenzione non è automatica e non copre tutti i casi.',
  },
  sanctions: {
    kicker: '03 — Sanzioni in Italia',
    lead: "Le sanzioni amministrative per violazione dell'EAA in Italia arrivano fino a 40.000€ per singola violazione, con possibili ordini di rimozione del servizio.",
    body: [
      "<strong>AGID</strong> (Agenzia per l'Italia Digitale) e gli enti consumatori possono ricevere segnalazioni e aprire procedimenti.\nLa sanzione è cumulativa: ogni servizio o prodotto non conforme conta come violazione separata.",
      "Più della multa, però, c'è il rischio reputazionale.\nUna segnalazione pubblica per inaccessibilità — soprattutto per banche, telecom, e-commerce di brand visibili — è marketing inverso.\nLe associazioni dei consumatori e disabilità monitorano attivamente i siti dei grandi brand e pubblicano i risultati.",
      "E ancora: chi ha disabilità che non riesce a completare un acquisto sul tuo sito può fare class action.\nNegli Stati Uniti questo tipo di causa (sotto ADA, simile concettualmente all'EAA) ha generato oltre 11.000 lawsuit l'anno solo in 2023.\nIn Europa la curva sta partendo ora.",
    ],
  },
  wcag: {
    kicker: '04 — WCAG 2.1 AA come standard tecnico',
    lead: 'WCAG 2.1 AA è lo standard internazionale di accessibilità web mantenuto da W3C.\nÈ diviso in tre livelli: A (blocking — minimo indispensabile), AA (mandatory per EAA), AAA (opzionale, standard editoriale alto).',
    principlesTitle: '<strong>I 4 principi WCAG (POUR):</strong>',
    principles: [
      { name: 'Percepibile', body: 'tutto il contenuto deve essere percepibile attraverso più sensi (testo + immagine + audio).\nAlt text, sottotitoli, contrasti.' },
      { name: 'Operabile', body: 'tutte le funzioni devono essere usabili tramite tastiera, non solo mouse o touch.\nTab order, focus visibile, navigazione coerente.' },
      { name: 'Comprensibile', body: 'contenuti e interazioni devono essere prevedibili.\nErrori spiegati, lingua dichiarata, etichette chiare.' },
      { name: 'Robusto', body: 'il codice deve essere compatibile con tecnologie assistive attuali e future.\nHTML semantico, ARIA dove serve, validità W3C.' },
    ],
  },
  violations: {
    kicker: '05 — Le 8 violazioni più comuni che troverai sul tuo sito',
    items: [
      { n: '01', label: 'Form senza label associate', why: 'Campi input con placeholder ma senza <label for=...>.\nLo screen reader non legge cosa va inserito.\nErrore Level A blocking.' },
      { n: '02', label: 'Contrasto colore sotto soglia', why: 'Testi grigi su fondo bianco con contrast ratio sotto 4.5:1.\nWCAG AA chiede minimo 4.5:1 per testo normale.\nErrore Level AA mandatory.' },
      { n: '03', label: 'Immagini senza alt text', why: '<img> decorativi vanno con alt vuoto, immagini informative con alt descrittivo.\nUna galleria prodotti senza alt è inaccessibile.' },
      { n: '04', label: 'Navigazione tastiera rotta', why: 'Menu, modali, dropdown raggiungibili solo col mouse.\nTab order incoerente, focus invisibile, escape che non chiude modali.\nBlocking per chi non usa il mouse.' },
      { n: '05', label: 'Errori di validazione solo con colore rosso', why: 'Campo errato segnalato solo dal colore (rosso) senza testo o icona.\nDaltonici e screen reader user non vedono nulla.\nWCAG SC 1.4.1.' },
      { n: '06', label: 'Heading hierarchy disordinata', why: 'Pagina che salta da H1 a H4 senza H2/H3.\nScreen reader perde il contesto strutturale.\nDifficile da navigare e da indicizzare.' },
      { n: '07', label: 'Video senza sottotitoli', why: 'Contenuti video pubblicati senza captions/sottotitoli.\nInaccessibile a sordi, ipoudenti, e a chi guarda senza audio in pubblico.' },
      { n: '08', label: 'Plugin "accessibility widget"', why: 'Plugin che aggiunge un\'icona "accessibility" con toggle font/contrasto.\nNon sistema niente di sostanziale.\nDiversi tribunali UE lo considerano compliance-washing.' },
    ],
  },
  checklist: {
    kicker: '06 — Audit checklist (cosa controllare oggi)',
    lead: 'Tre passaggi che puoi fare oggi sul tuo sito, in ordine di facilità.',
    steps: [
      { body: '<strong>Lighthouse audit (5 minuti).</strong> Apri il tuo sito su Chrome, premi F12, tab Lighthouse, seleziona "Accessibility", click "Generate report".\nIl punteggio sotto 90 è già un campanello d\'allarme.\nLighthouse identifica circa il 30% delle violazioni automatiche.' },
      { body: '<strong>axe DevTools scan (10 minuti).</strong> Installa l\'estensione Chrome axe DevTools, esegui scan sulle 5-10 page più visitate del tuo sito.\naxe trova violazioni che Lighthouse non vede (ARIA, semantic, keyboard).' },
      { body: '<strong>Test screen reader manuale (30 minuti).</strong> Scarica NVDA (gratis, nvaccess.org) o usa VoiceOver su Mac (Cmd+F5).\nNaviga il sito SOLO con tastiera + ascolto.\nCerca di completare il flusso più importante (acquisto, registrazione, contatto).\nDove fallisci, lì c\'è una violazione concreta.' },
    ],
    outro: 'Se questi tre step ti fanno capire che il sito è in difficoltà, è tempo di un audit serio.\nNiente plugin, niente compliance-washing: serve fix nel codice e accessibility statement pubblicabile.\nQuello sì, è il lavoro che faccio.',
  },
};

const EN: EaaLocaleContent = {
  metaTitle:
    'European Accessibility Act 2025 · What you must do if you sell online (by June 28) | Federico Calicchia',
  metaDescription:
    "European Accessibility Act in force from June 28, 2025: who is obligated, which sites must be WCAG 2.1 AA accessible, fines in Italy, audit checklist, deadlines.",
  ogTitle: 'European Accessibility Act 2025 · What you must do if you sell online',
  ogDescription: 'Who is obligated, fines, audit checklist, deadlines. No compliance-washing.',
  schemaTitle: 'European Accessibility Act 2025 · What you must do if you sell online',
  schemaDescription: 'Who is obligated, fines in Italy, audit checklist, deadlines. EAA in force from June 28, 2025.',
  schemaSection: 'Web Accessibility',
  breadcrumbs: [
    { name: 'Home', url: '/' },
    { name: 'Services', url: '/servizi' },
    { name: 'European Accessibility Act 2025', url: '/european-accessibility-act-2025' },
  ],
  eyebrow: 'Compliance — 6 chapters · 8 min read',
  title: 'European Accessibility Act 2025. What you must do if you sell online (by June 28).',
  lead: 'Since June 28, 2025 the European Accessibility Act is in force.\nIf you sell products or services online to European consumers, the site must be WCAG 2.1 AA accessible.\nIn Italy fines reach 40,000€ per violation.\nNo "accessibility" plugin: you need a serious code-level audit.',
  readTime: '8 min',
  updatedAt: 'May 8, 2026',
  chapterLabels: [
    { id: 'cosa-e', number: '01', label: 'What the EAA is' },
    { id: 'chi', number: '02', label: 'Who is obligated' },
    { id: 'sanzioni', number: '03', label: 'Italian fines' },
    { id: 'wcag', number: '04', label: 'WCAG 2.1 AA as the standard' },
    { id: 'violazioni', number: '05', label: '8 common violations' },
    { id: 'checklist', number: '06', label: 'Audit checklist' },
  ],
  intro: {
    kicker: '01 — What the European Accessibility Act is',
    lead: 'The European Accessibility Act (EAA) is EU directive 2019/882 imposing accessibility standards on digital products and services sold to European consumers.',
    body: [
      'In Italy it was transposed by <strong>Legislative Decree 82/2022</strong> (and later amendments).\nIt applies mandatorily <strong>from June 28, 2025</strong>.\nThe rule covers websites, apps, e-books, self-service terminals, banking services, telecom, transport, and generally any digital service where a consumer can complete a transaction.',
      'The technical reference standard is <strong>WCAG 2.1 level AA</strong> (Web Content Accessibility Guidelines), specifically the harmonised norm <strong>EN 301 549</strong>.\nIt is not optional, and you don\'t reach it by installing a plugin.',
    ],
  },
  obligated: {
    kicker: '02 — Who is obligated',
    lead: 'General rule: if you sell to European end consumers (B2C) and the service is digital, you are obligated.\nSpecific sectors in the decree:',
    sectors: [
      { label: 'B2C e-commerce', detail: 'Any site selling products or services to European end consumers: fashion, food, retail, digital products, B2C SaaS subscriptions.' },
      { label: 'Banks and financial services', detail: 'Home banking, payments, investments, loans.\nAnything handling money accessible via web/app.' },
      { label: 'Telecom and ISPs', detail: 'Mobile/fixed telephony services, internet, contracts managed online (subscription, billing, support).' },
      { label: 'Passenger transport', detail: 'Ticket sales, bookings, real-time info, public transport navigation apps.' },
      { label: 'E-books and digital content', detail: 'Publishers selling e-books, reading platforms, content subscriptions.' },
      { label: 'On-demand audiovisual services', detail: 'Video streaming, internet TV platforms, training videos sold online.' },
    ],
    afterNote: '<strong>Microenterprise exemptions:</strong> Legislative Decree 82/2022 provides partial exemptions for microenterprises (fewer than 10 employees and annual turnover under 2 million euros) limited to certain services.\nThe safe move is to verify with a specific advisor — the exemption is not automatic and doesn\'t cover all cases.',
  },
  sanctions: {
    kicker: '03 — Italian fines',
    lead: "Administrative fines for EAA violations in Italy reach 40,000€ per single violation, with possible service-removal orders.",
    body: [
      "<strong>AGID</strong> (Agency for Digital Italy) and consumer authorities can receive complaints and open proceedings.\nThe fine is cumulative: every non-compliant service or product counts as a separate violation.",
      'More than the fine, however, there is reputational risk.\nA public complaint for inaccessibility — especially for banks, telecom, visible-brand e-commerce — is reverse marketing.\nConsumer and disability associations actively monitor large brand sites and publish results.',
      "And again: people with disabilities who can't complete a purchase on your site can file class actions.\nIn the United States this type of lawsuit (under ADA, conceptually similar to the EAA) generated more than 11,000 lawsuits per year in 2023 alone.\nIn Europe the curve is just starting.",
    ],
  },
  wcag: {
    kicker: '04 — WCAG 2.1 AA as the technical standard',
    lead: 'WCAG 2.1 AA is the international web accessibility standard maintained by W3C.\nIt\'s split in three levels: A (blocking — bare minimum), AA (mandatory for EAA), AAA (optional, high editorial standard).',
    principlesTitle: '<strong>The 4 WCAG principles (POUR):</strong>',
    principles: [
      { name: 'Perceivable', body: 'all content must be perceivable through multiple senses (text + image + audio).\nAlt text, captions, contrast.' },
      { name: 'Operable', body: 'all functions must be usable via keyboard, not just mouse or touch.\nTab order, visible focus, consistent navigation.' },
      { name: 'Understandable', body: 'content and interactions must be predictable.\nErrors explained, declared language, clear labels.' },
      { name: 'Robust', body: 'code must be compatible with current and future assistive technologies.\nSemantic HTML, ARIA where needed, W3C validity.' },
    ],
  },
  violations: {
    kicker: '05 — The 8 most common violations you will find on your site',
    items: [
      { n: '01', label: 'Forms without associated labels', why: 'Input fields with placeholder but no <label for=...>.\nThe screen reader doesn\'t read what to enter.\nLevel A blocking error.' },
      { n: '02', label: 'Colour contrast below threshold', why: 'Grey text on white background with contrast ratio below 4.5:1.\nWCAG AA requires minimum 4.5:1 for normal text.\nLevel AA mandatory error.' },
      { n: '03', label: 'Images without alt text', why: 'Decorative <img> need empty alt, informative images need descriptive alt.\nA product gallery without alt is inaccessible.' },
      { n: '04', label: 'Broken keyboard navigation', why: 'Menus, modals, dropdowns reachable only with mouse.\nInconsistent tab order, invisible focus, escape that doesn\'t close modals.\nBlocking for non-mouse users.' },
      { n: '05', label: 'Validation errors only via red colour', why: 'Wrong field signalled only by colour (red) without text or icon.\nColour-blind and screen reader users see nothing.\nWCAG SC 1.4.1.' },
      { n: '06', label: 'Disordered heading hierarchy', why: 'Page jumping from H1 to H4 without H2/H3.\nScreen reader loses structural context.\nHard to navigate and to index.' },
      { n: '07', label: 'Videos without subtitles', why: 'Video content published without captions/subtitles.\nInaccessible to deaf, hearing-impaired, and to those watching without audio in public.' },
      { n: '08', label: '"Accessibility widget" plugins', why: 'Plugins that add an "accessibility" icon with font/contrast toggles.\nFix nothing substantial.\nSeveral EU courts consider it compliance-washing.' },
    ],
  },
  checklist: {
    kicker: '06 — Audit checklist (what to check today)',
    lead: 'Three steps you can do today on your site, in order of ease.',
    steps: [
      { body: '<strong>Lighthouse audit (5 minutes).</strong> Open your site in Chrome, press F12, Lighthouse tab, select "Accessibility", click "Generate report".\nA score below 90 is already a red flag.\nLighthouse catches about 30% of automatic violations.' },
      { body: '<strong>axe DevTools scan (10 minutes).</strong> Install the axe DevTools Chrome extension, run a scan on the top 5-10 most-visited pages of your site.\naxe finds violations Lighthouse misses (ARIA, semantic, keyboard).' },
      { body: '<strong>Manual screen reader test (30 minutes).</strong> Download NVDA (free, nvaccess.org) or use VoiceOver on Mac (Cmd+F5).\nNavigate the site ONLY with keyboard + listening.\nTry to complete the most important flow (purchase, registration, contact).\nWhere you fail, there is a concrete violation.' },
    ],
    outro: 'If these three steps make you realise the site is in trouble, it\'s time for a serious audit.\nNo plugins, no compliance-washing: you need fixes in the code and a publishable accessibility statement.\nThat, yes, is the work I do.',
  },
};

export const EAA_CONTENT = { it: IT, en: EN } as const;

export function chapterEntries(content: EaaLocaleContent): EditorialChapterEntry[] {
  return content.chapterLabels.map((c) => ({ id: c.id, number: c.number, label: c.label }));
}
