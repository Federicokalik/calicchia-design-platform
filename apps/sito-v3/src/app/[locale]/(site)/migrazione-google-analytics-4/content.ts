import type { EditorialChapterEntry } from '@/components/layout/EditorialArticleLayout';

export type ProblemEntry = { n: string; title: string; body: string };
export type StepEntry = { n: string; title: string; body: string };
export type FaqEntry = { q: string; a: string };

export type Ga4LocaleContent = {
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
  problems: { kicker: string; items: ProblemEntry[] };
  migration: { kicker: string; items: StepEntry[] };
  consent: { kicker: string; lead: string; body: string[] };
  dashboard: { kicker: string; lead: string; body: string[]; bullets: string[]; outro: string };
  faqs: { kicker: string; items: FaqEntry[] };
};

const IT: Ga4LocaleContent = {
  metaTitle:
    'Migrazione Google Analytics 4 · Cosa sistemare se hai ancora UA o GA4 di default | Federico Calicchia',
  metaDescription:
    'Universal Analytics è morto da luglio 2023. GA4 di default è quasi inutile. Guida pratica alla migrazione UA→GA4 + setup Consent Mode v2 GDPR + eventi business-driven + dashboard Looker Studio.',
  ogTitle: 'Migrazione Google Analytics 4 · Senza setup di default inutili',
  ogDescription: 'UA→GA4 + Consent Mode v2 + eventi che servono. Senza dashboard fumose.',
  schemaTitle: 'Migrazione Google Analytics 4 · Cosa sistemare se hai ancora UA o GA4 di default',
  schemaDescription: 'Universal Analytics morto da luglio 2023. GA4 di default è quasi inutile. Guida pratica alla migrazione + setup Consent Mode v2 + eventi business-driven.',
  schemaSection: 'Analytics',
  breadcrumbs: [
    { name: 'Home', url: '/' },
    { name: 'Servizi', url: '/servizi' },
    { name: 'Migrazione Google Analytics 4', url: '/migrazione-google-analytics-4' },
  ],
  eyebrow: 'Analytics — 6 capitoli · 7 minuti di lettura',
  title: 'Migrazione Google Analytics 4. Cosa sistemare se hai ancora UA o GA4 di default.',
  lead:
    'Universal Analytics è morto da luglio 2023.\nGA4 importato in 5 minuti è quasi inutile.\nSenza Consent Mode v2 perdi metà dei dati.\nGuida pratica per migrare bene la prima volta, senza dashboard fumose o eventi inutili.',
  readTime: '7 min',
  updatedAt: '8 maggio 2026',
  chapterLabels: [
    { id: 'morto-ua', number: '01', label: 'UA è morto, GA4 default è inutile' },
    { id: 'problemi', number: '02', label: '4 problemi tipici' },
    { id: 'migrazione', number: '03', label: '6 step della migrazione' },
    { id: 'consent', number: '04', label: 'Consent Mode v2 + GDPR' },
    { id: 'dashboard', number: '05', label: 'Dashboard che si legge in 5 minuti' },
    { id: 'faqs', number: '06', label: 'FAQs' },
  ],
  intro: {
    kicker: '01 — UA è morto, GA4 di default è quasi inutile',
    lead:
      'Universal Analytics ha smesso di raccogliere dati il 1 luglio 2023.\nI dati storici sono stati cancellati nei property gratuiti il 1 luglio 2024.\nSe vedi ancora un tag UA-XXXXX nel codice del tuo sito, stai non-tracciando da quasi 3 anni.',
    body: [
      'Quasi tutti i siti hanno fatto qualcosa: una property GA4 creata in fretta nel 2023, un tag inserito, finita lì.\n<strong>Quel "qualcosa" è quasi inutile.</strong> Senza eventi configurati, conversioni dichiarate, retention estesa, Consent Mode, la dashboard mostra solo pageview generici.\nQuando il marketing chiede "quale ad ha convertito?", il consulente risponde "non lo so, GA non lo dice".',
      'Una migrazione GA4 fatta bene non è "spostare il tag".\nÈ <strong>configurare un sistema di analytics che ti permetta di prendere decisioni</strong>: quale traffic source porta clienti veri, quale ad spende soldi a vuoto, quale page del funnel perde conversioni, quale device fallisce.\nSenza questo, il marketing è puro sentimento.',
    ],
  },
  problems: {
    kicker: '02 — 4 problemi tipici che vedo nei setup esistenti',
    items: [
      {
        n: '01',
        title: 'Ancora con Universal Analytics',
        body: "Universal Analytics ha smesso di raccogliere dati il 1 luglio 2023.\nI dati storici sono stati cancellati nei property gratuiti il 1 luglio 2024.\nSe ancora vedi 'tag UA-XXXXX' nel codice del sito, stai semplicemente non tracciando nulla.\nNiente.\nZero.\nDa quasi 3 anni.",
      },
      {
        n: '02',
        title: 'GA4 importato in 5 minuti',
        body: "Quasi tutti i siti hanno GA4 'qualcosa': property creata in fretta, tag inserito, finita lì.\nRisultato: zero eventi custom, retention 2 mesi (default), filtri internal traffic non configurati, conversioni mai dichiarate.\nLa dashboard mostra pageview e basta.\nNon sai cosa converte.",
      },
      {
        n: '03',
        title: 'Banner cookie che spegne tutto',
        body: "Banner cookie configurato male: senza consenso esplicito, GTM non parte, GA4 non riceve niente, Google Ads non vede conversioni.\nIl 40-60% dei visitatori UE clicca 'rifiuta' o ignora il banner — quel 40-60% diventa invisibile.\nModeled conversions di Consent Mode v2 mai attivate.",
      },
      {
        n: '04',
        title: 'Nessuna documentazione del setup',
        body: "Container GTM con 30+ tag accumulati negli anni, naming random ('test_2024', 'click-cta-3'), zero documentazione.\nChi entra dopo passa settimane a capire cosa fa cosa.\nSpesso si rifà tutto da zero perché è più veloce del reverse engineering.",
      },
    ],
  },
  migration: {
    kicker: '03 — 6 step della migrazione',
    items: [
      { n: '01', title: 'Audit setup attuale', body: "Verifico cosa c'è: UA residuo da rimuovere, property GA4 esistente (se c'è) da pulire o ricreare, container GTM da ordinare.\nIdentifico cosa ha senso salvare e cosa ricostruire." },
      { n: '02', title: 'Mappa eventi business-driven', body: 'Sessione 30 minuti per capire cosa conta: macro-conversioni (purchase, lead form, prenotazione), micro-conversioni (add_to_cart, scroll 75%, time on key page), traffic source critici.\nMappa eventi PRIMA di toccare codice.' },
      { n: '03', title: 'GA4 property pulito', body: 'Nuova property o cleanup esistente: data stream configurato, internal traffic filter, cross-domain tracking se serve, debug mode, retention 14 mesi (massimo non-paid), enhanced measurement attivato sui giusti eventi.' },
      { n: '04', title: 'GTM container ordinato', body: 'Container GTM con folder logici per tipo (Analytics / Ads / Conversion API), naming convention chiaro (TY1-Pageview, AY2-Click-CTA, EY3-Form-Submit), trigger riusabili, variables centralizzate.\nDocumentazione in spreadsheet.' },
      { n: '05', title: 'Consent Mode v2 (GDPR)', body: 'Integrazione banner cookie (Cookiebot / Iubenda / custom) con Consent Mode v2 di Google.\nTag attivi anche prima del consenso in modalità "modeled" (Google ricostruisce conversioni mancanti).\nPieno tracking dopo accept esplicito.\nTest con DebugView GA4.' },
      { n: '06', title: 'Dashboard Looker Studio', body: 'Dashboard personalizzata che mostra solo quello che conta: traffic source per conversione, funnel checkout/lead, pagine top-performing, ricerche on-site, dispositivo + zona.\nSingle page leggibile in 5 minuti, refresh quotidiano, accesso condiviso col team.' },
    ],
  },
  consent: {
    kicker: '04 — Consent Mode v2 + GDPR (la parte più ignorata)',
    lead: 'Consent Mode v2 è il pezzo che la maggior parte degli installatori GA4 salta.\nEd è esattamente dove si perde il 40-60% dei dati nei mercati UE.',
    body: [
      "<strong>Senza Consent Mode v2:</strong> il banner cookie blocca completamente GTM finché l'utente non clicca \"accetta\".\nChi clicca \"rifiuta\" o ignora il banner non viene tracciato per niente.\nRisultato: dashboard mostra solo il 40-60% del traffico reale, e i decision-makers vedono solo metà della verità.",
      '<strong>Con Consent Mode v2:</strong> i tag Google ricevono signal anche prima del consenso (in modalità "modeled" — dati aggregati anonimi, GDPR-compliant).\nGoogle usa quei signal per ricostruire le conversioni mancanti tramite machine learning.\nIl risultato: il 75-90% del traffico reale visibile in dashboard, e ottimizzazione Google Ads che funziona invece di degradare.',
      'Setup richiede integrazione tra banner cookie (Cookiebot / Iubenda / custom) e GTM con i 4 consent state corretti (<code>ad_storage</code>, <code>analytics_storage</code>, <code>ad_user_data</code>, <code>ad_personalization</code>).\nOgni progetto include questo step come standard, mai opzionale.',
    ],
  },
  dashboard: {
    kicker: '05 — Dashboard Looker Studio che si legge in 5 minuti',
    lead: 'Le dashboard GA4 native sono fatte per analytics expert, non per chi deve decidere se spendere altri 500€ in Google Ads questa settimana.\nServono dashboard custom che rispondano a domande precise.',
    body: [
      'Looker Studio (ex Data Studio) è gratuito, si connette nativamente a GA4 + Google Ads + Search Console + Sheets, e produce dashboard single-page con i KPI che servono al tuo business.\nPer ogni cliente la dashboard è personalizzata:',
    ],
    bullets: [
      '<strong>E-commerce:</strong> funnel view item → add to cart → begin checkout → purchase, AOV per source, top products, conversion rate per device.',
      '<strong>Lead gen:</strong> form submit per source, form abandonment rate, time-to-form per landing page, traffic source quality (qualified leads vs raw leads).',
      '<strong>Content / blog:</strong> top articoli per traffic + engagement, scroll depth, source per categoria, ricerche on-site con frequenza.',
    ],
    outro: 'Refresh quotidiano automatico, accesso condiviso col team via link, esportabile in PDF per riunioni mensili.\nNiente "executive report" decorativo: solo i numeri che ti fanno agire.',
  },
  faqs: {
    kicker: '06 — FAQs',
    items: [
      {
        q: 'Devo davvero migrare se Universal Analytics ha smesso di funzionare nel 2023?',
        a: "Universal Analytics non raccoglie dati da luglio 2023, e i dati storici sono già stati cancellati nei property gratuiti dal 1 luglio 2024.\nSe hai ancora UA installato è morto codice — non fa danno, ma non serve a nulla.\nLa domanda non è 'devo migrare' ma 'devo finalmente avere analytics che funziona'.\nSì.",
      },
      {
        q: 'Posso recuperare i dati storici di Universal Analytics?',
        a: "Solo se li hai esportati prima della cancellazione (Google ha dato 18 mesi di preavviso).\nPer chi ha export storici (CSV, BigQuery sync, GA Universal API estratti), si possono importare in Looker Studio come dataset di confronto.\nPer chi non ha esportato, i dati pre-2023 sono persi.\nPunto.",
      },
      {
        q: 'GA4 e GTM sono gratuiti?',
        a: 'Sì, entrambi gratuiti per la maggior parte dei siti.\nGA4 standard ha limiti (10M eventi/mese, 14 mesi retention, 200 conversion events) ma sono sufficienti per il 95% dei casi.\nGA4 360 (paid, da $50k+/anno) serve solo a enterprise con miliardi di eventi.\nGTM è completamente gratuito senza limiti significativi.',
      },
      {
        q: 'Consent Mode v2 è davvero obbligatorio?',
        a: "Per chi fa Google Ads in EEA + UK è obbligatorio dal 6 marzo 2024 — senza Consent Mode v2 le campagne non vedono le conversioni e l'ottimizzazione automatica degrada.\nPer chi fa solo GA4 standard, non è strettamente 'obbligatorio' ma è la prassi GDPR-compliant corretta.\nLo configuro sempre come standard.",
      },
      {
        q: 'Quanto tempo serve per la migrazione completa?',
        a: 'Dipende dalla complessità del sito e dagli eventi da configurare.\nSito vetrina con form contatto: 1-2 giorni.\nE-commerce con checkout, filtri, account area: 1-2 settimane.\nSaaS con dashboard interno e tracking custom: 2-4 settimane.\nIl primo audit chiarisce la dimensione reale.',
      },
      {
        q: 'Cosa succede ai miei tag Google Ads e Meta Pixel esistenti?',
        a: 'Vengono spostati in GTM se non già lì, con setup Consent Mode v2 unificato.\nGoogle Ads conversion tracking aggiornato a Enhanced Conversions (server-side hashing).\nMeta Pixel + Conversion API server-side per superare iOS 14.5 e ad blocker.\nTikTok, LinkedIn, Pinterest se in uso: stesso pattern.\nTutto via GTM con consent gating.',
      },
      {
        q: 'Posso aggiungere eventi nuovi dopo il setup, da solo?',
        a: "Sì, se sono varianti di eventi esistenti (es. duplicare un trigger 'click button' per un nuovo CTA).\nLa documentazione che consegno spiega il pattern.\nPer eventi nuovi più complessi (e-commerce purchase con line items custom, eventi multi-step), retainer trimestrale o intervento on-demand ha più senso.",
      },
    ],
  },
};

const EN: Ga4LocaleContent = {
  metaTitle:
    'Google Analytics 4 Migration · What to fix if you still have UA or default GA4 | Federico Calicchia',
  metaDescription:
    'Universal Analytics died in July 2023. Default GA4 is almost useless. Practical guide to UA→GA4 migration + Consent Mode v2 GDPR setup + business-driven events + Looker Studio dashboard.',
  ogTitle: 'Google Analytics 4 Migration · No useless default setups',
  ogDescription: 'UA→GA4 + Consent Mode v2 + events that matter. No vanity dashboards.',
  schemaTitle: 'Google Analytics 4 Migration · What to fix if you still have UA or default GA4',
  schemaDescription: 'Universal Analytics dead since July 2023. Default GA4 is almost useless. Practical migration guide + Consent Mode v2 + business-driven events.',
  schemaSection: 'Analytics',
  breadcrumbs: [
    { name: 'Home', url: '/' },
    { name: 'Services', url: '/servizi' },
    { name: 'Google Analytics 4 Migration', url: '/migrazione-google-analytics-4' },
  ],
  eyebrow: 'Analytics — 6 chapters · 7 min read',
  title: 'Google Analytics 4 Migration. What to fix if you still have UA or default GA4.',
  lead:
    "Universal Analytics has been dead since July 2023.\nGA4 imported in 5 minutes is almost useless.\nWithout Consent Mode v2 you lose half the data.\nPractical guide to migrating well the first time, without vanity dashboards or useless events.",
  readTime: '7 min',
  updatedAt: 'May 8, 2026',
  chapterLabels: [
    { id: 'morto-ua', number: '01', label: 'UA is dead, default GA4 is useless' },
    { id: 'problemi', number: '02', label: '4 typical problems' },
    { id: 'migrazione', number: '03', label: '6-step migration' },
    { id: 'consent', number: '04', label: 'Consent Mode v2 + GDPR' },
    { id: 'dashboard', number: '05', label: '5-minute readable dashboard' },
    { id: 'faqs', number: '06', label: 'FAQs' },
  ],
  intro: {
    kicker: '01 — UA is dead, default GA4 is almost useless',
    lead:
      'Universal Analytics stopped collecting data on July 1, 2023.\nHistorical data was wiped in free properties on July 1, 2024.\nIf you still see a UA-XXXXX tag in your site code, you have been not-tracking for almost 3 years.',
    body: [
      'Almost every site has done something: a GA4 property created in a hurry in 2023, a tag inserted, end of story.\n<strong>That "something" is almost useless.</strong> Without configured events, declared conversions, extended retention, Consent Mode, the dashboard only shows generic pageviews.\nWhen marketing asks "which ad converted?", the consultant answers "I don\'t know, GA doesn\'t say".',
      'A well-done GA4 migration is not "moving the tag".\nIt is <strong>configuring an analytics system that lets you make decisions</strong>: which traffic source brings real customers, which ad burns money, which funnel page loses conversions, which device fails.\nWithout this, marketing is pure gut feeling.',
    ],
  },
  problems: {
    kicker: '02 — 4 typical problems I see in existing setups',
    items: [
      {
        n: '01',
        title: 'Still on Universal Analytics',
        body: "Universal Analytics stopped collecting data on July 1, 2023.\nHistorical data was wiped in free properties on July 1, 2024.\nIf you still see a 'UA-XXXXX tag' in the site code, you are simply tracking nothing.\nNada.\nZero.\nFor almost 3 years.",
      },
      {
        n: '02',
        title: 'GA4 imported in 5 minutes',
        body: "Almost every site has GA4 'something': property created in a rush, tag inserted, end of story.\nResult: zero custom events, 2-month retention (default), no internal traffic filter, conversions never declared.\nThe dashboard shows pageviews and that's it.\nYou don't know what converts.",
      },
      {
        n: '03',
        title: 'Cookie banner that turns everything off',
        body: "Cookie banner badly configured: without explicit consent, GTM doesn't fire, GA4 receives nothing, Google Ads doesn't see conversions.\n40-60% of EU visitors click 'reject' or ignore the banner — that 40-60% becomes invisible.\nConsent Mode v2 modeled conversions never enabled.",
      },
      {
        n: '04',
        title: 'No setup documentation',
        body: "GTM container with 30+ tags accumulated over years, random naming ('test_2024', 'click-cta-3'), zero docs.\nWhoever takes over spends weeks figuring out what does what.\nOften everything gets rebuilt from scratch because it's faster than reverse engineering.",
      },
    ],
  },
  migration: {
    kicker: '03 — 6-step migration',
    items: [
      { n: '01', title: 'Audit current setup', body: "I check what's there: residual UA to remove, existing GA4 property (if any) to clean or rebuild, GTM container to organise.\nI identify what's worth saving and what to rebuild." },
      { n: '02', title: 'Map business-driven events', body: '30-minute session to define what matters: macro-conversions (purchase, lead form, booking), micro-conversions (add_to_cart, scroll 75%, time on key page), critical traffic sources.\nMap events BEFORE touching code.' },
      { n: '03', title: 'Clean GA4 property', body: 'New property or cleanup existing: data stream configured, internal traffic filter, cross-domain tracking if needed, debug mode, retention 14 months (max non-paid), enhanced measurement enabled on the right events.' },
      { n: '04', title: 'Organised GTM container', body: 'GTM container with logical folders by type (Analytics / Ads / Conversion API), clear naming convention (TY1-Pageview, AY2-Click-CTA, EY3-Form-Submit), reusable triggers, centralised variables.\nDocumentation in spreadsheet.' },
      { n: '05', title: 'Consent Mode v2 (GDPR)', body: 'Cookie banner integration (Cookiebot / Iubenda / custom) with Google Consent Mode v2.\nTags active even before consent in "modeled" mode (Google reconstructs missing conversions).\nFull tracking after explicit accept.\nTest via GA4 DebugView.' },
      { n: '06', title: 'Looker Studio dashboard', body: 'Custom dashboard showing only what matters: traffic source by conversion, checkout/lead funnel, top-performing pages, on-site searches, device + region.\nSingle page readable in 5 minutes, daily refresh, shared team access.' },
    ],
  },
  consent: {
    kicker: '04 — Consent Mode v2 + GDPR (the most ignored part)',
    lead: 'Consent Mode v2 is the piece most GA4 installers skip.\nAnd it\'s exactly where 40-60% of data is lost in EU markets.',
    body: [
      "<strong>Without Consent Mode v2:</strong> the cookie banner completely blocks GTM until the user clicks \"accept\".\nWhoever clicks \"reject\" or ignores the banner is not tracked at all.\nResult: dashboard shows only 40-60% of real traffic, and decision-makers see only half the truth.",
      '<strong>With Consent Mode v2:</strong> Google tags receive signals even before consent (in "modeled" mode — anonymous aggregated data, GDPR-compliant).\nGoogle uses those signals to reconstruct missing conversions via machine learning.\nResult: 75-90% of real traffic visible in dashboard, and Google Ads optimisation that works instead of degrading.',
      'Setup requires integration between cookie banner (Cookiebot / Iubenda / custom) and GTM with the 4 correct consent states (<code>ad_storage</code>, <code>analytics_storage</code>, <code>ad_user_data</code>, <code>ad_personalization</code>).\nEvery project includes this step as standard, never optional.',
    ],
  },
  dashboard: {
    kicker: '05 — 5-minute readable Looker Studio dashboard',
    lead: 'Native GA4 dashboards are built for analytics experts, not for whoever has to decide whether to spend another 500€ in Google Ads this week.\nYou need custom dashboards that answer specific questions.',
    body: [
      'Looker Studio (formerly Data Studio) is free, natively connects to GA4 + Google Ads + Search Console + Sheets, and produces single-page dashboards with the KPIs your business needs.\nEach client gets a personalised dashboard:',
    ],
    bullets: [
      '<strong>E-commerce:</strong> funnel view item → add to cart → begin checkout → purchase, AOV by source, top products, conversion rate per device.',
      '<strong>Lead gen:</strong> form submit by source, form abandonment rate, time-to-form per landing page, traffic source quality (qualified leads vs raw leads).',
      '<strong>Content / blog:</strong> top articles by traffic + engagement, scroll depth, source per category, on-site searches with frequency.',
    ],
    outro: 'Automatic daily refresh, team access via shared link, exportable to PDF for monthly reviews.\nNo decorative "executive report": only the numbers that make you act.',
  },
  faqs: {
    kicker: '06 — FAQs',
    items: [
      {
        q: 'Do I really need to migrate if Universal Analytics stopped working in 2023?',
        a: "Universal Analytics hasn't collected data since July 2023, and historical data has already been wiped in free properties since July 1, 2024.\nIf you still have UA installed it's dead code — does no harm, but is useless.\nThe question isn't 'should I migrate' but 'should I finally have analytics that works'.\nYes.",
      },
      {
        q: 'Can I recover Universal Analytics historical data?',
        a: 'Only if you exported it before the wipe (Google gave 18 months notice).\nFor those with historical exports (CSV, BigQuery sync, GA Universal API extracts), they can be imported into Looker Studio as a comparison dataset.\nFor those who didn\'t export, pre-2023 data is lost.\nPeriod.',
      },
      {
        q: 'Are GA4 and GTM free?',
        a: 'Yes, both free for most sites.\nStandard GA4 has limits (10M events/month, 14 months retention, 200 conversion events) but they\'re sufficient for 95% of cases.\nGA4 360 (paid, from $50k+/year) is only for enterprise with billions of events.\nGTM is completely free with no significant limits.',
      },
      {
        q: 'Is Consent Mode v2 actually mandatory?',
        a: "For Google Ads in EEA + UK it's mandatory since March 6, 2024 — without Consent Mode v2 campaigns don't see conversions and automatic optimisation degrades.\nFor GA4-only setups, it's not strictly 'mandatory' but it's the correct GDPR-compliant practice.\nI always set it up as standard.",
      },
      {
        q: 'How long does the full migration take?',
        a: 'Depends on site complexity and events to configure.\nBrochure site with contact form: 1-2 days.\nE-commerce with checkout, filters, account area: 1-2 weeks.\nSaaS with internal dashboard and custom tracking: 2-4 weeks.\nThe first audit clarifies real scope.',
      },
      {
        q: 'What happens to my existing Google Ads and Meta Pixel tags?',
        a: 'They get moved to GTM if not already there, with unified Consent Mode v2 setup.\nGoogle Ads conversion tracking upgraded to Enhanced Conversions (server-side hashing).\nMeta Pixel + Conversion API server-side to bypass iOS 14.5 and ad blockers.\nTikTok, LinkedIn, Pinterest if in use: same pattern.\nEverything via GTM with consent gating.',
      },
      {
        q: 'Can I add new events after setup, on my own?',
        a: "Yes, if they're variants of existing events (e.g. duplicate a 'click button' trigger for a new CTA).\nThe documentation I deliver explains the pattern.\nFor more complex new events (e-commerce purchase with custom line items, multi-step events), quarterly retainer or on-demand intervention makes more sense.",
      },
    ],
  },
};

export const MIGRAZIONE_GA4_CONTENT = { it: IT, en: EN } as const;

export function chapterEntries(content: Ga4LocaleContent): EditorialChapterEntry[] {
  return content.chapterLabels.map((c) => ({ id: c.id, number: c.number, label: c.label }));
}
