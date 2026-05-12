import type { EditorialChapterEntry } from '@/components/layout/EditorialArticleLayout';

export type MetricEntry = { metric: string; fullname: string; threshold: string; what: string; fixes: string[]; fixesLabel: string };
export type ToolEntry = { n: string; name: string; url: string; use: string };

export type CwvLocaleContent = {
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
  ranking: { kicker: string; lead: string; body: string[] };
  metrics: { kicker: string; items: MetricEntry[] };
  tools: { kicker: string; lead: string; items: ToolEntry[] };
  audit: { kicker: string; steps: string[] };
  fixes: { kicker: string; lead: string; steps: string[]; outro: string };
};

const IT: CwvLocaleContent = {
  metaTitle:
    'Core Web Vitals Audit · LCP, CLS, INP spiegati da chi sistema siti lenti per lavoro | Federico Calicchia',
  metaDescription:
    "Core Web Vitals nel 2026: LCP, CLS, INP cosa misurano davvero, perché Google li usa per il ranking, come fare un audit serio in 30 minuti. Senza compliance-washing.",
  ogTitle: 'Core Web Vitals Audit · LCP, CLS, INP spiegati senza compliance-washing',
  ogDescription: "Cosa misurano davvero, perché Google li usa per il ranking, come fare un audit in 30 minuti.",
  schemaTitle: 'Core Web Vitals Audit · LCP, CLS, INP spiegati',
  schemaDescription: "Core Web Vitals nel 2026: cosa misurano davvero, perché Google li usa per il ranking, come fare un audit serio in 30 minuti.",
  schemaSection: 'Performance',
  breadcrumbs: [
    { name: 'Home', url: '/' },
    { name: 'Servizi', url: '/servizi' },
    { name: 'Core Web Vitals Audit', url: '/core-web-vitals-audit' },
  ],
  eyebrow: 'Performance — 6 capitoli · 7 minuti di lettura',
  title: 'Core Web Vitals Audit. LCP, CLS, INP spiegati da chi sistema siti lenti per lavoro.',
  lead: "Google da maggio 2021 usa i Core Web Vitals come segnale di ranking.\nSe il tuo sito non passa il check, scivola sotto i concorrenti più ordinati.\nQui ti spiego cosa misurano davvero queste tre metriche e come fare un audit serio in 30 minuti, senza widget magici.",
  readTime: '7 min',
  updatedAt: '8 maggio 2026',
  chapterLabels: [
    { id: 'cosa-sono', number: '01', label: 'Cosa sono i Core Web Vitals' },
    { id: 'perche', number: '02', label: 'Perché Google li usa per il ranking' },
    { id: 'metriche', number: '03', label: 'Le 3 metriche spiegate' },
    { id: 'tool', number: '04', label: '4 tool per misurare' },
    { id: 'audit', number: '05', label: 'Come fare audit in 30 minuti' },
    { id: 'fix', number: '06', label: 'Fix in ordine di priorità' },
  ],
  intro: {
    kicker: '01 — Cosa sono i Core Web Vitals',
    lead: "I Core Web Vitals sono tre metriche che Google ha standardizzato nel 2020 per misurare l'esperienza utente reale di una pagina web.",
    body: [
      "<strong>LCP (Largest Contentful Paint)</strong> misura quando il sito sembra caricato.\n<strong>CLS (Cumulative Layout Shift)</strong> misura quanto il layout salta durante il caricamento.\n<strong>INP (Interaction to Next Paint)</strong> misura quanto velocemente risponde alle azioni dell'utente.",
      "Google ha sostituito FID con INP a marzo 2024 perché INP è più rappresentativa dell'esperienza reale: misura ogni interazione, non solo la prima.\nLe soglie attuali sono: LCP &lt; 2.5s, CLS &lt; 0.1, INP &lt; 200ms.\nPer \"passare il check\" tutte e tre devono essere nel range \"good\" sul 75% degli utenti.",
    ],
  },
  ranking: {
    kicker: '02 — Perché Google li usa per il ranking',
    lead: '"Page Experience" è dal 2021 un fattore ufficiale di ranking.\nGoogle ha smesso di pretendere che i siti siano solo rilevanti: pretende anche che siano usabili.',
    body: [
      'Il peso dei Core Web Vitals nel ranking non è enorme di per sé (Google dichiara "tiebreaker quando i contenuti sono comparabili") MA si compone con altri segnali.\nBounce rate alto su mobile (causato da LCP lento), session duration ridotta (causata da INP cattivo), pogo-sticking (utente torna ai SERP perché il sito è inutilizzabile).\nTutti questi sono segnali secondari che spingono il sito in basso.',
      "<strong>L'effetto reale è asimmetrico:</strong> avere CWV verdi non ti dà boost, ma averli rossi ti fa scivolare.\nÈ un \"qualifier\", non un \"amplifier\".\nPer chi fa SEO seriamente è una condizione necessaria.",
      "Aldilà del ranking puro, c'è il dato di conversione.\n<strong>Ogni 100ms in più di LCP riduce le conversioni e-commerce dell'1%</strong> (dato Akamai/Cloudflare medio settore).\nPer un e-commerce con 100k€ di volume mensile, fare passare LCP da 4s a 2s vale, in soldi reali, multipli del costo dell'audit.",
    ],
  },
  metrics: {
    kicker: '03 — Le 3 metriche spiegate (e come si fixano)',
    items: [
      {
        metric: 'LCP',
        fullname: 'Largest Contentful Paint',
        threshold: '< 2.5s',
        what: "Misura il tempo necessario perché il più grande elemento visibile (immagine hero, titolo principale, video poster) appaia sullo schermo.\nÈ il proxy migliore per 'quando il sito sembra caricato all'utente'.",
        fixesLabel: 'Fix in ordine di impatto',
        fixes: [
          'Hero servito in AVIF/WebP invece di PNG/JPEG',
          "fetchpriority=\"high\" sull'immagine cover",
          'Preload del font display above-the-fold',
          'Eliminazione del CSS render-blocking',
          'Hosting con TTFB sotto 600ms',
        ],
      },
      {
        metric: 'CLS',
        fullname: 'Cumulative Layout Shift',
        threshold: '< 0.1',
        what: "Misura quanto il layout 'salta' durante il caricamento.\nUn layout shift è quando un elemento si sposta perché qualcosa carica dopo (immagine senza dimensioni, banner cookie, font che cambia metriche).\nMisurato in unità adimensionali da 0 a infinito.",
        fixesLabel: 'Fix in ordine di impatto',
        fixes: [
          'Dimensioni esplicite (width/height) su ogni <img>, <iframe>, <video>',
          'Spazio riservato per banner cookie (es. min-height: 80px)',
          'Font-display swap con size-adjust per minimizzare il salto fallback→display',
          "Sticky header con altezza fissa, non 'auto'",
          'Skeleton loader con stesse dimensioni del contenuto finale',
        ],
      },
      {
        metric: 'INP',
        fullname: 'Interaction to Next Paint',
        threshold: '< 200ms',
        what: "Misura quanto tempo il sito impiega a reagire a un'interazione (click, tap, key press).\nSostituisce FID dal marzo 2024.\nUn sito che risponde in 500ms si percepisce 'rotto' anche se tutto funziona.",
        fixesLabel: 'Fix in ordine di impatto',
        fixes: [
          'Long task spezzati con scheduler.yield() o setTimeout',
          'Eventi pesanti spostati in requestIdleCallback',
          'Hydration React/Vue ottimizzata (server components, lazy hydration)',
          'JavaScript bundle splitato per route, non monolitico',
          'Listener pesanti debounced o throttled',
        ],
      },
    ],
  },
  tools: {
    kicker: '04 — I 4 tool che servono davvero',
    lead: "Niente di esotico.\nQuattro tool, gratuiti o integrati, coprono il 95% dell'audit.",
    items: [
      { n: '01', name: 'PageSpeed Insights', url: 'pagespeed.web.dev', use: "Test rapido.\nUna volta inserito l'URL, ti dà sia lab data (Lighthouse) che field data (CrUX, dati reali degli utenti negli ultimi 28 giorni).\nQuello che davvero conta per Google è il field data." },
      { n: '02', name: 'WebPageTest', url: 'webpagetest.org', use: 'Test profondo.\nFilmstrip frame-by-frame, waterfall request, breakdown TTFB/render/scripting/loading.\nPermette di vedere DOVE si perde il tempo, non solo quanto.' },
      { n: '03', name: 'Chrome DevTools Performance', url: 'integrato', use: "Quando devi capire perché un'interazione è lenta (INP).\nRegistra una sessione, guarda il flame chart, identifica i long task.\nÈ lo strumento che usano i developer per i fix più tecnici." },
      { n: '04', name: 'CrUX Dashboard (BigQuery o Looker Studio)', url: 'BigQuery', use: 'Per siti grandi, dashboard sui dati Chrome reali aggregati (Chrome User Experience Report).\nMostra come performano i tuoi utenti reali, non un test lab.\nÈ il dato che Google usa per il ranking.' },
    ],
  },
  audit: {
    kicker: '05 — Come fare un audit serio in 30 minuti',
    steps: [
      '<strong>Identifica le 5 page critiche.</strong>\nNon testare tutto: testa quelle che portano traffico/conversioni (home, lista prodotti/servizi, dettaglio top-3, checkout se e-commerce).',
      '<strong>PageSpeed Insights su ogni page.</strong>\nGuarda <em>field data</em>, not lab.\nI numeri lab (Lighthouse) sono test in laboratorio.\nI field data (CrUX) sono utenti reali.\nDifferenza enorme.',
      '<strong>Identifica la metrica peggiore per ogni page.</strong>\nSe LCP è 4.2s, INP è 280ms, CLS è 0.05 → priorità è LCP.\nNon fare 30 fix random: fai 3-5 fix sulla metrica che fallisce.',
      '<strong>WebPageTest waterfall sulla page peggiore.</strong>\nGuarda quale request blocca il render (di solito CSS o font), quale request è quella del LCP element, quanto tempo passa prima del paint.\nDa qui escono i fix specifici.',
      "<strong>Elenco fix prioritari, non lista alfabetica.</strong>\nOutput dell'audit: 3-5 fix in ordine di impatto/effort, ognuno con stima di delta atteso.\n\"Sostituire hero PNG con AVIF + fetchpriority\" → atteso -800ms LCP.",
    ],
  },
  fixes: {
    kicker: '06 — Fix in ordine di priorità (per la maggior parte dei siti)',
    lead: "Per ~80% dei siti che vedo, l'ordine di fix che muove davvero l'ago è questo:",
    steps: [
      '<strong>Image optimization (AVIF/WebP + lazy loading + dimensioni).</strong>\nHero da 3MB in PNG → 80KB in AVIF è la differenza più grossa che vedrai.\nEffort basso, impact alto su LCP e CLS.',
      '<strong>Font loading.</strong>\nnext/font, preload selettivo, size-adjust.\nRiduce CLS quasi a zero, accelera LCP del 200-400ms.',
      '<strong>Render-blocking CSS/JS cleanup.</strong>\nCritical CSS inline, JavaScript splittato per route, defer su tutto ciò che non serve above-the-fold.\nRiduce LCP di 500-1500ms su siti pesanti.',
      '<strong>Hosting/TTFB.</strong>\nSe TTFB è sopra 600ms anche dopo cache, il problema è lato server.\nCDN, edge caching, hosting tuned.\nPer siti WordPress: WP Engine, SiteGround, Kinsta.\nPer Next.js: Vercel, Cloudflare.',
      '<strong>INP optimization.</strong>\nSolitamente l\'ultimo fix.\nLong task spezzati, hydration ottimizzata, listener throttled.\nSenza JavaScript pesante INP è quasi sempre verde di default.',
    ],
    outro: "Quando questi cinque step sono fatti, l'80% dei siti passa il check.\nIl 20% restante richiede interventi più profondi.\nRefactor architetturale, cambio CMS, riscrittura componenti pesanti.\nLì serve l'audit completo, non più la checklist.",
  },
};

const EN: CwvLocaleContent = {
  metaTitle:
    'Core Web Vitals Audit · LCP, CLS, INP explained by someone who fixes slow sites for a living | Federico Calicchia',
  metaDescription:
    "Core Web Vitals in 2026: what LCP, CLS, INP actually measure, why Google uses them for ranking, how to run a serious audit in 30 minutes. No compliance-washing.",
  ogTitle: 'Core Web Vitals Audit · LCP, CLS, INP explained without compliance-washing',
  ogDescription: 'What they actually measure, why Google uses them for ranking, how to run an audit in 30 minutes.',
  schemaTitle: 'Core Web Vitals Audit · LCP, CLS, INP explained',
  schemaDescription: 'Core Web Vitals in 2026: what they actually measure, why Google uses them for ranking, how to run a serious audit in 30 minutes.',
  schemaSection: 'Performance',
  breadcrumbs: [
    { name: 'Home', url: '/' },
    { name: 'Services', url: '/servizi' },
    { name: 'Core Web Vitals Audit', url: '/core-web-vitals-audit' },
  ],
  eyebrow: 'Performance — 6 chapters · 7 min read',
  title: 'Core Web Vitals Audit. LCP, CLS, INP explained by someone who fixes slow sites for a living.',
  lead: 'Since May 2021 Google uses Core Web Vitals as a ranking signal.\nIf your site doesn\'t pass the check, it slips below the more orderly competitors.\nHere I explain what these three metrics actually measure and how to run a serious audit in 30 minutes, without magic widgets.',
  readTime: '7 min',
  updatedAt: 'May 8, 2026',
  chapterLabels: [
    { id: 'cosa-sono', number: '01', label: 'What Core Web Vitals are' },
    { id: 'perche', number: '02', label: 'Why Google uses them for ranking' },
    { id: 'metriche', number: '03', label: 'The 3 metrics explained' },
    { id: 'tool', number: '04', label: '4 tools to measure' },
    { id: 'audit', number: '05', label: 'How to audit in 30 minutes' },
    { id: 'fix', number: '06', label: 'Fixes in priority order' },
  ],
  intro: {
    kicker: '01 — What Core Web Vitals are',
    lead: 'Core Web Vitals are three metrics Google standardised in 2020 to measure the real user experience of a web page.',
    body: [
      "<strong>LCP (Largest Contentful Paint)</strong> measures when the site appears loaded.\n<strong>CLS (Cumulative Layout Shift)</strong> measures how much the layout jumps during loading.\n<strong>INP (Interaction to Next Paint)</strong> measures how fast the site responds to user actions.",
      "Google replaced FID with INP in March 2024 because INP is more representative of real experience: it measures every interaction, not just the first.\nCurrent thresholds: LCP &lt; 2.5s, CLS &lt; 0.1, INP &lt; 200ms.\nTo \"pass the check\" all three must be in \"good\" range for 75% of users.",
    ],
  },
  ranking: {
    kicker: '02 — Why Google uses them for ranking',
    lead: '"Page Experience" has been an official ranking factor since 2021.\nGoogle stopped only requiring that sites be relevant: it now also requires they be usable.',
    body: [
      'Core Web Vitals\' weight in ranking is not huge by itself (Google declares "tiebreaker when content is comparable") BUT it compounds with other signals.\nHigh mobile bounce rate (caused by slow LCP), reduced session duration (caused by bad INP), pogo-sticking (user returns to SERP because the site is unusable).\nAll these are secondary signals that push a site down.',
      "<strong>The real effect is asymmetric:</strong> green CWV doesn't give you a boost, but red CWV makes you slip.\nIt's a \"qualifier\", not an \"amplifier\".\nFor serious SEO it's a necessary condition.",
      'Beyond pure ranking, there\'s the conversion data.\n<strong>Every 100ms more LCP reduces e-commerce conversions by 1%</strong> (Akamai/Cloudflare median industry data).\nFor an e-commerce with 100k€ monthly volume, getting LCP from 4s to 2s is, in real money, multiples of the audit cost.',
    ],
  },
  metrics: {
    kicker: '03 — The 3 metrics explained (and how to fix them)',
    items: [
      {
        metric: 'LCP',
        fullname: 'Largest Contentful Paint',
        threshold: '< 2.5s',
        what: "Measures the time it takes for the largest visible element (hero image, main heading, video poster) to appear on screen.\nIt's the best proxy for 'when the site looks loaded to the user'.",
        fixesLabel: 'Fixes in impact order',
        fixes: [
          'Hero served in AVIF/WebP instead of PNG/JPEG',
          'fetchpriority="high" on the cover image',
          'Preload of above-the-fold display font',
          'Eliminate render-blocking CSS',
          'Hosting with TTFB under 600ms',
        ],
      },
      {
        metric: 'CLS',
        fullname: 'Cumulative Layout Shift',
        threshold: '< 0.1',
        what: "Measures how much the layout 'jumps' during loading.\nA layout shift is when an element moves because something loads later (image without dimensions, cookie banner, font that changes metrics).\nMeasured in dimensionless units 0 to infinity.",
        fixesLabel: 'Fixes in impact order',
        fixes: [
          'Explicit dimensions (width/height) on every <img>, <iframe>, <video>',
          'Reserved space for cookie banner (e.g. min-height: 80px)',
          'Font-display swap with size-adjust to minimise the fallback→display jump',
          "Sticky header with fixed height, not 'auto'",
          'Skeleton loader with same dimensions as final content',
        ],
      },
      {
        metric: 'INP',
        fullname: 'Interaction to Next Paint',
        threshold: '< 200ms',
        what: "Measures how long the site takes to react to an interaction (click, tap, key press).\nReplaces FID since March 2024.\nA site that responds in 500ms feels 'broken' even if everything works.",
        fixesLabel: 'Fixes in impact order',
        fixes: [
          'Long tasks split with scheduler.yield() or setTimeout',
          'Heavy events moved to requestIdleCallback',
          'Optimised React/Vue hydration (server components, lazy hydration)',
          'JavaScript bundle split per route, not monolithic',
          'Heavy listeners debounced or throttled',
        ],
      },
    ],
  },
  tools: {
    kicker: '04 — The 4 tools that actually matter',
    lead: 'Nothing exotic.\nFour tools, free or built-in, cover 95% of the audit.',
    items: [
      { n: '01', name: 'PageSpeed Insights', url: 'pagespeed.web.dev', use: "Quick test.\nOnce you enter the URL, gives you both lab data (Lighthouse) and field data (CrUX, real users last 28 days).\nWhat actually counts for Google is the field data." },
      { n: '02', name: 'WebPageTest', url: 'webpagetest.org', use: 'Deep test.\nFrame-by-frame filmstrip, waterfall request, TTFB/render/scripting/loading breakdown.\nLets you see WHERE time is lost, not just how much.' },
      { n: '03', name: 'Chrome DevTools Performance', url: 'built-in', use: "When you need to understand why an interaction is slow (INP).\nRecord a session, look at the flame chart, identify long tasks.\nThe tool developers use for the most technical fixes." },
      { n: '04', name: 'CrUX Dashboard (BigQuery or Looker Studio)', url: 'BigQuery', use: 'For large sites, dashboard on aggregated real Chrome data (Chrome User Experience Report).\nShows how your real users perform, not a lab test.\nThe data Google uses for ranking.' },
    ],
  },
  audit: {
    kicker: '05 — How to run a serious audit in 30 minutes',
    steps: [
      '<strong>Identify the 5 critical pages.</strong>\nDon\'t test everything: test the ones that drive traffic/conversions (home, product/service list, top-3 detail, checkout if e-commerce).',
      '<strong>PageSpeed Insights on every page.</strong>\nLook at <em>field data</em>, not lab.\nLab numbers (Lighthouse) are laboratory tests.\nField data (CrUX) is real users.\nHuge difference.',
      '<strong>Identify the worst metric per page.</strong>\nIf LCP is 4.2s, INP is 280ms, CLS is 0.05 → priority is LCP.\nDon\'t do 30 random fixes: do 3-5 fixes on the metric that fails.',
      '<strong>WebPageTest waterfall on the worst page.</strong>\nSee which request blocks the render (usually CSS or font), which request is the LCP element\'s, how much time passes before paint.\nSpecific fixes come out of this.',
      '<strong>Prioritised fix list, not alphabetical.</strong>\nAudit output: 3-5 fixes in impact/effort order, each with estimated delta.\n"Replace hero PNG with AVIF + fetchpriority" → expected -800ms LCP.',
    ],
  },
  fixes: {
    kicker: '06 — Fixes in priority order (for most sites)',
    lead: 'For ~80% of the sites I see, the fix order that actually moves the needle is this:',
    steps: [
      '<strong>Image optimisation (AVIF/WebP + lazy loading + dimensions).</strong>\n3MB hero in PNG → 80KB in AVIF is the biggest difference you\'ll see.\nLow effort, high impact on LCP and CLS.',
      '<strong>Font loading.</strong>\nnext/font, selective preload, size-adjust.\nReduces CLS to almost zero, speeds up LCP by 200-400ms.',
      '<strong>Render-blocking CSS/JS cleanup.</strong>\nCritical CSS inlined, JavaScript split per route, defer everything not needed above the fold.\nReduces LCP by 500-1500ms on heavy sites.',
      '<strong>Hosting/TTFB.</strong>\nIf TTFB is above 600ms even after cache, the problem is server-side.\nCDN, edge caching, tuned hosting.\nFor WordPress sites: WP Engine, SiteGround, Kinsta.\nFor Next.js: Vercel, Cloudflare.',
      '<strong>INP optimisation.</strong>\nUsually the last fix.\nLong tasks split, optimised hydration, throttled listeners.\nWithout heavy JavaScript, INP is almost always green by default.',
    ],
    outro: 'When these five steps are done, 80% of sites pass the check.\nThe remaining 20% needs deeper interventions.\nArchitectural refactor, CMS change, heavy component rewrite.\nThere the full audit is needed, not the checklist.',
  },
};

export const CWV_CONTENT = { it: IT, en: EN } as const;

export function chapterEntries(content: CwvLocaleContent): EditorialChapterEntry[] {
  return content.chapterLabels.map((c) => ({ id: c.id, number: c.number, label: c.label }));
}
