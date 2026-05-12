import type { EditorialChapterEntry } from '@/components/layout/EditorialArticleLayout';

export type ArchetypeEntry = { n: string; name: string; what: string; tradeoff: string };
export type DimensionEntry = { n: string; name: string; body: string };
export type DecisionRow = { profile: string; suggestion: string; reason: string };

export type WpHeadlessLocaleContent = {
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
  archetypes: { kicker: string; lead: string; items: ArchetypeEntry[] };
  dimensions: { kicker: string; items: DimensionEntry[] };
  whenWp: { kicker: string; lead: string; body: string[] };
  whenHeadless: { kicker: string; lead: string; body: string[] };
  matrix: { kicker: string; lead: string; items: DecisionRow[] };
};

const IT: WpHeadlessLocaleContent = {
  metaTitle:
    'WordPress vs Headless 2026 · Quando passare e quando restare, da chi sviluppa entrambi | Federico Calicchia',
  metaDescription:
    "WordPress monolitico, WP headless, headless puro (Sanity/Strapi + Next): cosa cambia davvero su performance, costo, manutenzione, team, SEO. Quando WP è ancora la scelta giusta. Quando passare headless e cosa serve.",
  ogTitle: 'WordPress vs Headless 2026 · differenze reali, decision matrix',
  ogDescription:
    "3 archetipi, 6 dimensioni decisionali, decision matrix per caso d'uso. Senza fluff sul jamstack.",
  schemaTitle: 'WordPress vs Headless 2026 · Quando passare e quando restare',
  schemaDescription:
    "WordPress monolitico, WP headless, headless puro: differenze reali su performance, costo, manutenzione, SEO. Decision matrix per caso d'uso.",
  schemaSection: 'Architettura',
  breadcrumbs: [
    { name: 'Home', url: '/' },
    { name: 'Servizi', url: '/servizi' },
    { name: 'WordPress vs Headless', url: '/wordpress-vs-headless' },
  ],
  eyebrow: 'Architettura — 6 capitoli · 8 minuti di lettura',
  title: 'WordPress vs Headless 2026. Quando passare e quando restare, da chi sviluppa entrambi.',
  lead:
    "Headless non è automaticamente meglio.\nWordPress non è automaticamente obsoleto.\nCosa cambia davvero tra WordPress monolitico, WP headless e headless puro (Sanity/Strapi + Next/Astro).\nSei dimensioni di confronto e una decision matrix per caso d'uso reale.",
  readTime: '8 min',
  updatedAt: '9 maggio 2026',
  chapterLabels: [
    { id: 'cosa-significa', number: '01', label: 'Cosa significa "headless"' },
    { id: 'archetipi', number: '02', label: '3 archetipi a confronto' },
    { id: 'dimensioni', number: '03', label: '6 dimensioni decisionali' },
    { id: 'quando-wp', number: '04', label: 'Quando WordPress è ancora giusto' },
    { id: 'quando-headless', number: '05', label: 'Quando passare headless' },
    { id: 'matrix', number: '06', label: 'Decision matrix per caso d\'uso' },
  ],
  intro: {
    kicker: '01 — Cosa significa "headless" (e cosa NON significa)',
    lead:
      '"Headless" è una parola che fa SEO ma confonde le decisioni.\nEcco la definizione operativa, senza buzzword.',
    body: [
      "<strong>Headless = il CMS gestisce solo il contenuto, non lo presenta.</strong> Il frontend è un'applicazione separata che chiede il contenuto via API (REST o GraphQL) e lo renderizza dove gli pare: web, mobile app, smart TV, newsletter, OG image generator.",
      '<strong>WordPress monolitico</strong> è l\'opposto: WP gestisce contenuto E rendering.\nOgni pageview gira PHP+MySQL+plugin che decidono come si vede la pagina.\nÈ il modello "tutto in una scatola" che dura dal 2003.',
      'In mezzo c\'è <strong>WordPress headless</strong>: usi WP solo come backend di contenuto (admin Gutenberg, custom post types, media library), e fai il frontend in Next.js/Astro che chiama la WP REST API.\nÈ un compromesso che mantiene l\'editor experience WP senza la tassa di performance del rendering PHP.',
      'L\'errore comune: pensare che "headless" significhi automaticamente "veloce".\nÈ falso.\nUn headless mal fatto (over-fetch, cache miss, edge cold) è più lento di un WordPress decent.\nLa differenza è di <em>controllo</em> e <em>scala</em>, non di velocità per default.',
    ],
  },
  archetypes: {
    kicker: '02 — 3 archetipi a confronto (cosa fa cosa)',
    lead: 'Tre famiglie di stack reale, ognuna con i suoi trade-off.\nCapire dove ricade il tuo caso è metà della decisione.',
    items: [
      {
        n: '01',
        name: 'WordPress monolitico',
        what: "WP installato su hosting PHP/MySQL, theme + plugin, admin Gutenberg, frontend rendered server-side (PHP) per ogni pageview.\nWooCommerce per e-commerce.",
        tradeoff: 'Setup veloce, ecosistema gigantesco, editor familiare.\nPerformance dipende da quality theme + plugin (spesso pessima).\nSicurezza richiede update costanti.\nScala male oltre 100k PV/mese senza CDN aggressive.',
      },
      {
        n: '02',
        name: 'WordPress headless',
        what: 'WP backend (admin + REST/GraphQL API) + frontend Next.js/Astro/Nuxt che fetcha contenuto e rende statico/incremental.\nWP non rende pages — solo contenuto.',
        tradeoff: 'Performance frontend top (static gen), editor WP familiare, ma manutenzione doppia (WP backend + frontend codebase).\nPlugin WP che dipendono da rendering frontend (es. SEO plugin) vanno reimplementati lato Next/Astro.',
      },
      {
        n: '03',
        name: 'Headless puro (CMS specializzato + frontend)',
        what: 'CMS API-first (Sanity, Contentful, Strapi, Storyblok, Payload) + frontend Next/Astro/Remix.\nNessuna istanza WordPress.\nHosting frontend Vercel/Netlify, hosting CMS managed.',
        tradeoff: 'Performance + scala enterprise.\nManutenzione frontend-only, niente patch WP weekly.\nMa curva apprendimento editor (admin diverso da WP), costo CMS subscription 25-300€/mese, lock-in vendor.',
      },
    ],
  },
  dimensions: {
    kicker: '03 — 6 dimensioni decisionali (cosa pesare davvero)',
    items: [
      {
        n: '01',
        name: 'Performance (CWV reali)',
        body: "WP monolitico: LCP medio 3-5s su mobile (PHP rendering + plugin assets).\nWP headless: LCP 0.8-1.5s (static gen + edge).\nHeadless puro: LCP 0.5-1.2s (static gen + CDN edge + image optimization).\nDifferenza non triviale per SEO Google e conversion: ogni 100ms in più di LCP = -1% conversioni e-commerce (dato medio).",
      },
      {
        n: '02',
        name: 'Costo totale (TCO 3 anni)',
        body: 'WP monolitico: hosting 10-30€/mese + plugin paid 100-300€/anno + dev manutenzione 500-2000€/anno = ~1500-4000€ in 3 anni per sito vetrina.\nWP headless: 50-150€/mese + dev iniziale 5-15k€ + manutenzione = ~10-25k€.\nHeadless puro: 50-300€/mese CMS + dev iniziale 8-25k€ + manutenzione = ~15-40k€.\nIl break-even avviene quando il traffic giustifica perf gain.',
      },
      {
        n: '03',
        name: 'Manutenzione operativa',
        body: 'WP monolitico: update core+plugin+theme weekly, security patches, db dumps, downtime per upgrade.\nWP headless: stessi update WP backend + frontend deploys (CI/CD).\nHeadless puro: solo frontend deploy + CMS subscription, niente plugin update, niente db.\nHeadless riduce manutenzione del 60-70% medio sul lungo periodo.',
      },
      {
        n: '04',
        name: 'Editor experience (chi scrive)',
        body: 'WP monolitico: Gutenberg + classico, editori già abituati.\nWP headless: stesso admin WP, zero curva apprendimento.\nHeadless puro: admin diverso (Sanity Studio, Contentful, Storyblok) — più focalizzato e content-modeling-friendly, ma editor abituati a WP necessitano 1-2 settimane onboarding.\nPer team con tanti editori non-tech, WP-based vince.',
      },
      {
        n: '05',
        name: 'Team requirements (chi mantiene)',
        body: "WP monolitico: qualsiasi WP dev (~2000€/anno freelance retainer).\nWP headless: serve React/Next dev + WP admin abilitato (combo rara, costa di più).\nHeadless puro: serve React/Next dev + know-how CMS specifico (Sanity, Contentful) — meno rara, ma più costosa di WP dev medio.\nHeadless raddoppia il costo team senior.",
      },
      {
        n: '06',
        name: 'SEO + integrazioni',
        body: 'WP monolitico: SEO via plugin (Yoast/RankMath), schema auto, sitemap auto, integrazioni 50k+ plugin pronti.\nWP headless: SEO frontend va ricostruito (next-sitemap, schema custom, meta), plugin WP che modificano frontend non funzionano.\nHeadless puro: SEO frontend custom, ma controllo totale (schema fine-grained, edge headers, custom OG).\nPiù potente ma più lavoro.',
      },
    ],
  },
  whenWp: {
    kicker: '04 — Quando WordPress monolitico è ancora la scelta giusta',
    lead: 'Non è cool, ma è spesso la decisione razionale.\nEcco i casi.',
    body: [
      '<strong>1. Sito vetrina con &lt;30 pagine</strong>: blog/portfolio/showcase senza traffic enorme né ambizioni multi-channel.\nHosting 10€/mese, theme decent, finita lì.\nHeadless è overkill puro.',
      '<strong>2. Studio professionale (avvocato, architetto, commercialista)</strong>: contenuto driven, editor non-tech (segretaria che aggiorna news), budget contenuto.\nWP fa esattamente quello che serve.',
      '<strong>3. PMI con team marketing 1-2 persone</strong>: chi scrive contenuto è generalista, non vuole imparare un CMS nuovo.\nWP riduce frizione.',
      '<strong>4. E-commerce small-mid (10-200k€/anno)</strong>: WooCommerce ha ecosystem maturo (gateway pagamento, shipping, contabilità).\nShopify è alternativa, ma WooCommerce resta valido.',
      '<strong>5. Budget hard cap &lt;3k€</strong>: headless richiede dev investment iniziale 5-15k€.\nSotto questa soglia, WordPress mono fatto bene > headless mal fatto.',
      'In tutti questi casi, la <strong>perf gain di headless non giustifica il TCO</strong>.\nWP fatto bene (theme custom o premium leggero, &lt;5 plugin essenziali, hosting decent, CDN Cloudflare free) può raggiungere CWV verdi e SEO competitivo.',
    ],
  },
  whenHeadless: {
    kicker: '05 — Quando passare headless (e cosa serve)',
    lead: 'Quando il TCO headless si paga col valore aggiunto, e quali sono i pre-requisiti.',
    body: [
      '<strong>1. Performance critica per business</strong>: e-commerce mid-large dove ogni 100ms di LCP = perdita conversioni misurabile.\nSaaS dove demo page lenta = bounce.\nEditorial high-traffic dove ad revenue scala con engagement.',
      '<strong>2. Multi-channel content</strong>: stesso contenuto deve apparire su sito web + app mobile + newsletter + smart TV + signage.\nWP non è progettato per multi-channel; headless è.',
      '<strong>3. Team dev forte (in-house o retainer)</strong>: serve React/Next/Astro senior che sa fare static gen + edge functions + CMS integration.\nSenza questo, headless diventa frankenstein.',
      '<strong>4. Compliance enterprise</strong>: separare backend (CMS, dati) da frontend (rendering) facilita audit GDPR, security review, isolation.\nAziende enterprise spesso lo richiedono.',
      '<strong>5. Editorial > 200 articoli + traffic > 200k PV/mese</strong>: WP monolitico inizia a soffrire.\nWP headless o pure headless con static gen + edge cache reggono il volume meglio.',
      '<strong>Pre-requisiti minimi</strong>: budget iniziale 8-25k€, dev senior reachable per manutenzione, content modeling fatto bene <em>prima</em> di scegliere il CMS, team con almeno 1 persona che sa Git + deploy CI/CD.\nSe manca uno di questi, WordPress mono o WP headless restano scelte più sicure.',
    ],
  },
  matrix: {
    kicker: '06 — Decision matrix per caso d\'uso',
    lead: 'Otto profili tipici, otto orientamenti.\nPunto di partenza, non dogma.',
    items: [
      {
        profile: 'Blog/portfolio personale',
        suggestion: 'WP mono o static SSG (Astro)',
        reason: 'Volume basso, scope semplice, budget low.\nWP mono va bene; Astro static + Markdown è alternativa moderna senza overhead.',
      },
      {
        profile: 'Studio professionale',
        suggestion: 'WP mono',
        reason: 'Contenuto driven, editor non-tech, budget contenuto.\nEcosistema WP per local SEO + plugin booking copre tutto.',
      },
      {
        profile: 'PMI sito vetrina',
        suggestion: 'WP mono o WP headless (se perf priority)',
        reason: 'Default WP mono.\nPassare WP headless se Core Web Vitals sono goal SEO esplicito e budget supporta dev investment.',
      },
      {
        profile: 'E-commerce small-mid (10-500k€/anno)',
        suggestion: 'WordPress + WooCommerce',
        reason: 'Ecosistema WC maturo, gateway+shipping+contabilità.\nShopify è alternativa, ma WC resta valida sotto questo volume.',
      },
      {
        profile: 'E-commerce mid-large (500k-5M€/anno)',
        suggestion: 'Headless: Shopify Hydrogen / Medusa + Next',
        reason: 'Performance e CRO critici, multi-channel, custom checkout.\nWC scala male oltre 1M€/anno; headless è giustificato.',
      },
      {
        profile: 'Editorial / publisher (>200 articoli)',
        suggestion: 'WP headless',
        reason: 'Editor abituati a WP, ma frontend Next/Astro per perf + scale.\nMulti-channel via API.\nCombo migliore costo/feature.',
      },
      {
        profile: 'SaaS marketing site',
        suggestion: 'Headless puro (Sanity/Contentful + Next)',
        reason: "Budget tech disponibile, team dev forte, perf critica per demo conversion, content modeling preciso (features, pricing, docs).",
      },
      {
        profile: 'Multi-channel content (sito + app + newsletter)',
        suggestion: 'Headless puro',
        reason: 'WP non è progettato per multi-channel.\nCMS API-first con frontend disaccoppiati = unico modo sano di scalare la content distribution.',
      },
    ],
  },
};

const EN: WpHeadlessLocaleContent = {
  metaTitle:
    'WordPress vs Headless 2026 · When to switch and when to stay, from someone who builds both | Federico Calicchia',
  metaDescription:
    "WordPress monolithic, WP headless, pure headless (Sanity/Strapi + Next): what really changes on performance, cost, maintenance, team, SEO. When WP is still the right choice. When to switch headless and what you need.",
  ogTitle: 'WordPress vs Headless 2026 · real differences, decision matrix',
  ogDescription:
    '3 archetypes, 6 decision dimensions, decision matrix by use case. No jamstack fluff.',
  schemaTitle: 'WordPress vs Headless 2026 · When to switch and when to stay',
  schemaDescription:
    "WordPress monolithic, WP headless, pure headless: real differences on performance, cost, maintenance, SEO. Decision matrix by use case.",
  schemaSection: 'Architecture',
  breadcrumbs: [
    { name: 'Home', url: '/' },
    { name: 'Services', url: '/servizi' },
    { name: 'WordPress vs Headless', url: '/wordpress-vs-headless' },
  ],
  eyebrow: 'Architecture — 6 chapters · 8 min read',
  title: 'WordPress vs Headless 2026. When to switch and when to stay, from someone who builds both.',
  lead:
    "Headless is not automatically better.\nWordPress is not automatically obsolete.\nWhat really changes between WordPress monolithic, WP headless, and pure headless (Sanity/Strapi + Next/Astro).\nSix comparison dimensions and a real-world decision matrix.",
  readTime: '8 min',
  updatedAt: 'May 9, 2026',
  chapterLabels: [
    { id: 'cosa-significa', number: '01', label: 'What "headless" actually means' },
    { id: 'archetipi', number: '02', label: '3 archetypes compared' },
    { id: 'dimensioni', number: '03', label: '6 decision dimensions' },
    { id: 'quando-wp', number: '04', label: 'When WordPress is still right' },
    { id: 'quando-headless', number: '05', label: 'When to switch headless' },
    { id: 'matrix', number: '06', label: 'Decision matrix by use case' },
  ],
  intro: {
    kicker: '01 — What "headless" actually means (and what it does NOT)',
    lead:
      '"Headless" is a SEO-optimised word that confuses decisions.\nHere is the operational definition, no buzzwords.',
    body: [
      "<strong>Headless = the CMS only manages content, doesn't render it.</strong> The frontend is a separate application that fetches content via API (REST or GraphQL) and renders it wherever you want: web, mobile app, smart TV, newsletter, OG image generator.",
      "<strong>WordPress monolithic</strong> is the opposite: WP manages content AND rendering.\nEvery pageview runs PHP+MySQL+plugins that decide how the page looks.\nIt's the all-in-one box model that's been around since 2003.",
      "In between there's <strong>WordPress headless</strong>: you use WP only as a content backend (Gutenberg admin, custom post types, media library), and build the frontend in Next.js/Astro that calls the WP REST API.\nIt's a compromise that keeps the WP editor experience without the performance tax of PHP rendering.",
      'Common mistake: thinking "headless" automatically means "fast".\nFalse.\nA poorly-built headless (over-fetch, cache miss, edge cold) is slower than a decent WordPress.\nThe difference is <em>control</em> and <em>scale</em>, not speed by default.',
    ],
  },
  archetypes: {
    kicker: '02 — 3 archetypes compared (what does what)',
    lead: 'Three real stack families, each with its trade-offs.\nKnowing where your case fits is half the decision.',
    items: [
      {
        n: '01',
        name: 'WordPress monolithic',
        what: "WP installed on PHP/MySQL hosting, theme + plugins, Gutenberg admin, frontend server-side rendered (PHP) on every pageview.\nWooCommerce for e-commerce.",
        tradeoff: 'Fast setup, huge ecosystem, familiar editor.\nPerformance depends on theme + plugin quality (often poor).\nSecurity needs constant updates.\nScales badly past 100k PV/month without aggressive CDN.',
      },
      {
        n: '02',
        name: 'WordPress headless',
        what: 'WP backend (admin + REST/GraphQL API) + Next.js/Astro/Nuxt frontend that fetches content and renders static/incremental.\nWP doesn\'t render pages — only content.',
        tradeoff: 'Top frontend performance (static gen), familiar WP editor, but doubled maintenance (WP backend + frontend codebase).\nWP plugins that depend on frontend rendering (e.g. SEO plugins) must be reimplemented in Next/Astro.',
      },
      {
        n: '03',
        name: 'Pure headless (specialised CMS + frontend)',
        what: 'API-first CMS (Sanity, Contentful, Strapi, Storyblok, Payload) + Next/Astro/Remix frontend.\nNo WordPress instance.\nFrontend hosting Vercel/Netlify, managed CMS hosting.',
        tradeoff: 'Enterprise performance + scale.\nFrontend-only maintenance, no weekly WP patches.\nBut editor learning curve (admin different from WP), CMS subscription cost 25-300€/month, vendor lock-in.',
      },
    ],
  },
  dimensions: {
    kicker: '03 — 6 decision dimensions (what to actually weigh)',
    items: [
      {
        n: '01',
        name: 'Performance (real CWV)',
        body: "WP monolithic: median LCP 3-5s on mobile (PHP rendering + plugin assets).\nWP headless: LCP 0.8-1.5s (static gen + edge).\nPure headless: LCP 0.5-1.2s (static gen + CDN edge + image optimisation).\nNon-trivial difference for Google SEO and conversion: every 100ms more LCP = -1% e-commerce conversions (median data).",
      },
      {
        n: '02',
        name: 'Total cost (3-year TCO)',
        body: "WP monolithic: hosting 10-30€/month + paid plugins 100-300€/year + dev maintenance 500-2000€/year ≈ 1500-4000€ over 3 years for a brochure site.\nWP headless: 50-150€/month + initial dev 5-15k€ + maintenance ≈ 10-25k€.\nPure headless: 50-300€/month CMS + initial dev 8-25k€ + maintenance ≈ 15-40k€.\nBreak-even when traffic justifies the perf gain.",
      },
      {
        n: '03',
        name: 'Operational maintenance',
        body: 'WP monolithic: weekly core+plugin+theme updates, security patches, db dumps, upgrade downtime.\nWP headless: same WP backend updates + frontend deploys (CI/CD).\nPure headless: only frontend deploys + CMS subscription, no plugin updates, no db.\nHeadless reduces long-term maintenance by 60-70% on average.',
      },
      {
        n: '04',
        name: 'Editor experience (who writes)',
        body: 'WP monolithic: Gutenberg + classic, editors already trained.\nWP headless: same WP admin, zero learning curve.\nPure headless: different admin (Sanity Studio, Contentful, Storyblok) — more focused and content-modeling-friendly, but WP-trained editors need 1-2 weeks onboarding.\nFor teams with many non-tech editors, WP-based wins.',
      },
      {
        n: '05',
        name: 'Team requirements (who maintains)',
        body: "WP monolithic: any WP dev (~2000€/year freelance retainer).\nWP headless: needs React/Next dev + WP admin enabled (rare combo, costs more).\nPure headless: needs React/Next dev + specific CMS know-how (Sanity, Contentful) — less rare but more expensive than median WP dev.\nHeadless doubles senior team cost.",
      },
      {
        n: '06',
        name: 'SEO + integrations',
        body: "WP monolithic: SEO via plugins (Yoast/RankMath), auto schema, auto sitemap, 50k+ ready integrations.\nWP headless: frontend SEO must be rebuilt (next-sitemap, custom schema, meta), WP plugins that modify frontend don't work.\nPure headless: custom frontend SEO, but total control (fine-grained schema, edge headers, custom OG).\nMore powerful but more work.",
      },
    ],
  },
  whenWp: {
    kicker: '04 — When WordPress monolithic is still the right choice',
    lead: 'It\'s not cool, but often it\'s the rational call.\nHere are the cases.',
    body: [
      '<strong>1. Brochure site with &lt;30 pages</strong>: blog/portfolio/showcase without huge traffic or multi-channel ambitions.\n10€/month hosting, decent theme, done.\nHeadless is pure overkill.',
      '<strong>2. Professional firms (lawyer, architect, accountant)</strong>: content driven, non-tech editor (assistant updating news), contained budget.\nWP does exactly what is needed.',
      '<strong>3. SMB with marketing team of 1-2</strong>: whoever writes content is a generalist, doesn\'t want to learn a new CMS.\nWP reduces friction.',
      '<strong>4. Small-mid e-commerce (10-200k€/year)</strong>: WooCommerce has a mature ecosystem (payment gateways, shipping, accounting).\nShopify is an alternative, but WooCommerce stays valid.',
      '<strong>5. Hard budget cap &lt;3k€</strong>: headless requires 5-15k€ initial dev investment.\nBelow this threshold, well-built WordPress mono > poorly-built headless.',
      'In all these cases, <strong>headless perf gain doesn\'t justify the TCO</strong>.\nWP done right (custom or lightweight premium theme, &lt;5 essential plugins, decent hosting, free Cloudflare CDN) can hit green CWV and competitive SEO.',
    ],
  },
  whenHeadless: {
    kicker: '05 — When to switch headless (and what you need)',
    lead: 'When headless TCO pays for itself in added value, and the prerequisites.',
    body: [
      "<strong>1. Performance critical for business</strong>: mid-large e-commerce where every 100ms of LCP = measurable conversion loss.\nSaaS where slow demo page = bounce.\nEditorial high-traffic where ad revenue scales with engagement.",
      '<strong>2. Multi-channel content</strong>: same content must appear on web + mobile app + newsletter + smart TV + signage.\nWP isn\'t designed for multi-channel; headless is.',
      "<strong>3. Strong dev team (in-house or retainer)</strong>: needs senior React/Next/Astro who can do static gen + edge functions + CMS integration.\nWithout this, headless becomes Frankenstein.",
      "<strong>4. Enterprise compliance</strong>: separating backend (CMS, data) from frontend (rendering) makes GDPR audits, security review, isolation easier.\nEnterprise companies often require it.",
      '<strong>5. Editorial > 200 articles + traffic > 200k PV/month</strong>: WP monolithic starts to suffer.\nWP headless or pure headless with static gen + edge cache holds volume better.',
      '<strong>Minimum prerequisites</strong>: 8-25k€ initial budget, senior dev reachable for maintenance, content modeling done well <em>before</em> picking the CMS, team with at least 1 person who knows Git + CI/CD deploy.\nIf any of these is missing, WordPress mono or WP headless remain safer choices.',
    ],
  },
  matrix: {
    kicker: '06 — Decision matrix by use case',
    lead: 'Eight typical profiles, eight orientations.\nStarting point, not dogma.',
    items: [
      {
        profile: 'Personal blog/portfolio',
        suggestion: 'WP mono or static SSG (Astro)',
        reason: 'Low volume, simple scope, low budget.\nWP mono is fine; Astro static + Markdown is a modern alternative without overhead.',
      },
      {
        profile: 'Professional firm',
        suggestion: 'WP mono',
        reason: 'Content driven, non-tech editor, contained budget.\nWP ecosystem for local SEO + booking plugins covers everything.',
      },
      {
        profile: 'SMB brochure site',
        suggestion: 'WP mono or WP headless (if perf priority)',
        reason: 'Default WP mono.\nSwitch to WP headless if Core Web Vitals are explicit SEO goals and budget supports dev investment.',
      },
      {
        profile: 'Small-mid e-commerce (10-500k€/year)',
        suggestion: 'WordPress + WooCommerce',
        reason: 'Mature WC ecosystem, gateways+shipping+accounting.\nShopify is an alternative, but WC stays valid below this volume.',
      },
      {
        profile: 'Mid-large e-commerce (500k-5M€/year)',
        suggestion: 'Headless: Shopify Hydrogen / Medusa + Next',
        reason: 'Critical performance and CRO, multi-channel, custom checkout.\nWC scales badly past 1M€/year; headless is justified.',
      },
      {
        profile: 'Editorial / publisher (>200 articles)',
        suggestion: 'WP headless',
        reason: 'Editors trained on WP, but Next/Astro frontend for perf + scale.\nMulti-channel via API.\nBest cost/feature combo.',
      },
      {
        profile: 'SaaS marketing site',
        suggestion: 'Pure headless (Sanity/Contentful + Next)',
        reason: 'Tech budget available, strong dev team, perf critical for demo conversion, precise content modeling (features, pricing, docs).',
      },
      {
        profile: 'Multi-channel content (web + app + newsletter)',
        suggestion: 'Pure headless',
        reason: "WP isn't designed for multi-channel.\nAPI-first CMS with decoupled frontends = the only sane way to scale content distribution.",
      },
    ],
  },
};

export const WORDPRESS_VS_HEADLESS_CONTENT = { it: IT, en: EN } as const;

export function chapterEntries(content: WpHeadlessLocaleContent): EditorialChapterEntry[] {
  return content.chapterLabels.map((c) => ({ id: c.id, number: c.number, label: c.label }));
}
