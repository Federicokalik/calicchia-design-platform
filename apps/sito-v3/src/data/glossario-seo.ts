import type { Locale } from '@/lib/i18n';

type LocalisedField = { it: string; en: string };

export type SeoTerm = {
  slug: string;
  letter: string;
  term: string; // Same in both locales (technical English term used in IT too)
  fullName?: string;
  whatItIs: LocalisedField;
  whyYouCare: LocalisedField;
  whatToDemand: LocalisedField;
};

export const GLOSSARIO_SEO: SeoTerm[] = [
  {
    slug: 'algorithm',
    letter: 'A',
    term: 'Algorithm',
    fullName: 'Algoritmo / Search Algorithm',
    whatItIs: {
      it: 'Sistema di regole che Google usa per classificare le pagine.\nNon è un singolo algoritmo ma una pila stratificata: index, ranking signals, intent matching.\nCambia con update mensili (Core Update) e continui (helpful content).',
      en: "The system of rules Google uses to rank pages.\nNot a single algorithm but a layered stack: index, ranking signals, intent matching.\nChanges with monthly Core Updates and continuous tweaks (helpful content).",
    },
    whyYouCare: {
      it: "Una variazione di traffico improvvisa è quasi sempre legata a un update.\nSenza monitoraggio perdi il controllo della tua visibilità organica.\nL'algoritmo non è sfortuna, è meccanica.",
      en: 'A sudden traffic variation is almost always linked to an algorithm update.\nWithout monitoring update dates + traffic, you attribute to luck what is engine mechanics.',
    },
    whatToDemand: {
      it: "Dashboard che incrocia algorithm update timeline con traffico organico.\nSenza dati, ogni discussione SEO è solo un'opinione.",
      en: 'Dashboard cross-referencing algorithm update timeline (Search Engine Roundtable, Semrush Sensor) with organic traffic.\nWithout it, every SEO discussion is opinion.',
    },
  },
  {
    slug: 'anchor-text',
    letter: 'A',
    term: 'Anchor Text',
    fullName: 'Testo del link',
    whatItIs: {
      it: "Il testo cliccabile di un link.\nEsempio: <a>servizi web design</a> ha anchor 'servizi web design'.\nGoogle usa l'anchor per capire di cosa parla la pagina linkata.",
      en: "The clickable text of a link.\nExample: <a>web design services</a> has anchor 'web design services'.\nGoogle uses the anchor to understand what the linked page is about.",
    },
    whyYouCare: {
      it: 'Anchor text uniformi tipo "clicca qui" non aiutano Google a contestualizzare.\nAnchor over-ottimizzati (esattamente la keyword target su ogni link) sono spam signal.',
      en: 'Uniform anchors like "click here" don\'t help Google contextualise.\nOver-optimised anchors (exactly the target keyword on every link) are a spam signal.',
    },
    whatToDemand: {
      it: 'Mix naturale di anchor: brand (Calicchia Design), keyword exact (web design Frosinone).\nKeyword variation (sito web Ciociaria), naked URL (calicchia.design), generici (qui, articolo).\nDistribuzione 30/20/20/15/15 medio.',
      en: 'Natural anchor mix: brand (Calicchia Design), exact keyword (web design Frosinone).\nKeyword variation (Ciociaria website), naked URL (calicchia.design), generic (here, article).\n30/20/20/15/15 average distribution.',
    },
  },
  {
    slug: 'backlink',
    letter: 'B',
    term: 'Backlink',
    fullName: 'Link in entrata',
    whatItIs: {
      it: "Link da un altro sito al tuo.\nÈ il segnale di autorevolezza più forte di Google: se siti rilevanti ti linkano, sei rilevante.\nQuantità conta meno di qualità (TLD, topical authority del sito linkante, anchor pulito).",
      en: 'Link from another site to yours.\nThe strongest authority signal in Google: if relevant sites link to you, you are relevant.\nQuantity matters less than quality (TLD, topical authority of the linking site, clean anchor).',
    },
    whyYouCare: {
      it: 'Senza backlink di qualità, ranking competitivo è impossibile.\nMa comprare backlink è penalty: Google rileva pattern innaturali (PBN, link farm, comment spam) e te lo fa pagare.',
      en: 'Without quality backlinks, competitive ranking is impossible.\nBut buying backlinks is a penalty: Google detects unnatural patterns (PBNs, link farms, comment spam) and you pay for it.',
    },
    whatToDemand: {
      it: 'Backlink earned (digital PR, content che attrae link).\nGuest post selettivi su siti rilevanti settore, mai link farm/PBN.\nAudit backlink trimestrale via Ahrefs/Semrush per disavow tossici.',
      en: 'Earned backlinks (digital PR, link-worthy content).\nSelective guest posts on relevant industry sites, never link farms/PBNs.\nQuarterly backlink audit via Ahrefs/Semrush to disavow toxic ones.',
    },
  },
  {
    slug: 'bounce-rate',
    letter: 'B',
    term: 'Bounce Rate',
    fullName: 'Frequenza di rimbalzo',
    whatItIs: {
      it: "Percentuale di utenti che lasciano il sito senza interagire (in UA classico).\nIn GA4 è stata sostituita da 'engagement rate' (complementare): utente è 'engaged' se sta >10s, vede ≥2 pagine, o triggera evento conversion.",
      en: "Percentage of users who leave the site without interaction (in classic UA).\nIn GA4 it's replaced by 'engagement rate' (complementary): a user is 'engaged' if they stay >10s, view ≥2 pages, or trigger a conversion event.",
    },
    whyYouCare: {
      it: 'Bounce alto su una landing = problema di intent match (utente cercava altro) o di UX (sito illeggibile mobile).\nPrima sospetta intent, poi UX.',
      en: 'High bounce on a landing page = intent match problem (user wanted something else) or UX (mobile-unreadable site).\nSuspect intent first, then UX.',
    },
    whatToDemand: {
      it: 'Engagement rate >55% per landing pages target.\nSotto, debug: è il copy fuori intent? è il design illeggibile? è il LCP a 5s che fa scappare?\nMai fix decorativo, sempre causal.',
      en: 'Engagement rate >55% for target landing pages.\nBelow, debug: is the copy off-intent? is the design unreadable? is LCP at 5s scaring people away?\nNever decorative fix, always causal.',
    },
  },
  {
    slug: 'canonical',
    letter: 'C',
    term: 'Canonical',
    fullName: 'URL canonical / rel="canonical"',
    whatItIs: {
      it: 'Tag HTML <link rel="canonical" href="..."> che dice a Google "questa pagina è duplicato di X, indicizza X".\nRisolve duplicate content da parametri URL (utm_), pagine paginate, mobile/desktop separate.',
      en: 'HTML tag <link rel="canonical" href="..."> that tells Google "this page is a duplicate of X, index X".\nResolves duplicate content from URL parameters (utm_), paginated pages, separate mobile/desktop.',
    },
    whyYouCare: {
      it: 'Canonical sbagliato = Google indicizza la pagina sbagliata, perdi ranking sulla canonical che credevi forte.\nCanonical mancante = Google sceglie da solo, spesso sbagliando.',
      en: 'Wrong canonical = Google indexes the wrong page, you lose ranking on the canonical you thought was strong.\nMissing canonical = Google picks alone, often wrong.',
    },
    whatToDemand: {
      it: 'Ogni pagina ha canonical esplicito.\nPagine duplicate (es. /products?color=red) puntano a /products.\nAudit canonical via Screaming Frog ogni release maggiore.',
      en: 'Every page has an explicit canonical.\nDuplicate pages (e.g. /products?color=red) point to /products.\nCanonical audit via Screaming Frog on every major release.',
    },
  },
  {
    slug: 'crawl-budget',
    letter: 'C',
    term: 'Crawl Budget',
    whatItIs: {
      it: 'Numero di pagine che il bot Google scansiona nel tuo sito per visit.\nDeterminato da: server speed, popolarità sito, freshness contenuto.\nSiti grossi (>10k pagine) ne sono limitati; siti piccoli no.',
      en: 'Number of pages the Google bot crawls on your site per visit.\nDetermined by: server speed, site popularity, content freshness.\nLarge sites (>10k pages) are limited; small sites are not.',
    },
    whyYouCare: {
      it: 'Su siti grandi, sprecare crawl budget su pagine inutili (filtri infiniti e-commerce, calendari, archivi paginati) significa pagine importanti non scansionate.',
      en: 'On large sites, wasting crawl budget on useless pages (infinite e-commerce filters, calendars, paginated archives) means important pages don\'t get crawled.',
    },
    whatToDemand: {
      it: 'robots.txt che blocca pattern inutili (?sort=, ?filter=).\nSitemap XML con solo pagine indexable.\nServer fast (<200ms TTFB) e internal link strategici.',
      en: 'robots.txt blocking useless patterns (?sort=, ?filter=).\nXML sitemap with only indexable pages.\nFast server (<200ms TTFB) and strategic internal links.',
    },
  },
  {
    slug: 'core-web-vitals',
    letter: 'C',
    term: 'Core Web Vitals',
    fullName: 'CWV — LCP, CLS, INP',
    whatItIs: {
      it: 'Tre metriche Google per qualità UX: LCP (Largest Contentful Paint, <2.5s), CLS (Cumulative Layout Shift, <0.1), INP (Interaction to Next Paint, <200ms).\nRanking signal dal 2021.',
      en: 'Three Google metrics for UX quality: LCP (Largest Contentful Paint, <2.5s), CLS (Cumulative Layout Shift, <0.1), INP (Interaction to Next Paint, <200ms).\nRanking signal since 2021.',
    },
    whyYouCare: {
      it: 'CWV in rosso = downgrade ranking.\nPer e-commerce, ogni 100ms in più di LCP = -1% conversioni.\nNon è "nice to have", è qualifier per giocare la partita SEO.',
      en: 'Red CWV = ranking downgrade.\nFor e-commerce, every 100ms more LCP = -1% conversions.\nIt\'s not "nice to have", it\'s a qualifier to play the SEO game.',
    },
    whatToDemand: {
      it: 'CWV verdi su field data CrUX (75% utenti reali).\nMonitoraggio mensile via PageSpeed Insights API.\nAlert immediati su ogni regressione tecnica.',
      en: 'Green CWV on CrUX field data (75% real users).\nMonthly monitoring via PageSpeed Insights API.\nImmediate alerts on any technical regression.',
    },
  },
  {
    slug: 'domain-authority',
    letter: 'D',
    term: 'Domain Authority',
    fullName: 'DA / DR — Moz / Ahrefs',
    whatItIs: {
      it: "Score 0-100 calcolato da Moz (DA) o Ahrefs (DR) che proxy l'autorevolezza di un dominio.\nNON è una metrica Google ufficiale — è una stima privata.\nUtile per benchmark, non per decisioni.",
      en: "Score 0-100 computed by Moz (DA) or Ahrefs (DR) that proxies a domain's authority.\nIt is NOT an official Google metric — it's a private estimate.\nUseful for benchmark, not decisions.",
    },
    whyYouCare: {
      it: "Agenzie che vendono SEO con 'aumentiamo il tuo DA' stanno vendendo ginnastica numerica, non ranking.\nDA alto correla con ranking ma non lo causa.",
      en: "Agencies selling SEO with 'we'll raise your DA' are selling numerical gymnastics, not ranking.\nHigh DA correlates with ranking but doesn't cause it.",
    },
    whatToDemand: {
      it: 'Focus su metriche outcome: traffico organico, conversion, page 1 ranking.\nDA/DR sono vanity metrics per agenzie senza risultati.\nDA è solo un benchmark competitor.',
      en: 'Focus on outcome metrics: organic traffic, conversion, page 1 ranking.\nDA/DR are vanity metrics for agencies without results.\nDA is just a competitor benchmark.',
    },
  },
  {
    slug: 'eeat',
    letter: 'E',
    term: 'E-E-A-T',
    fullName: 'Experience, Expertise, Authoritativeness, Trustworthiness',
    whatItIs: {
      it: "Framework Google per quality raters: Experience (l'autore ha esperienza diretta?), Expertise (è competente?), Authoritativeness (è riconosciuto come fonte?), Trustworthiness (è affidabile?).\nCritico per YMYL (Your Money Your Life).",
      en: 'Google framework for quality raters: Experience (does the author have direct experience?), Expertise (are they competent?), Authoritativeness (are they recognised as a source?), Trustworthiness (are they reliable?).\nCritical for YMYL (Your Money Your Life).',
    },
    whyYouCare: {
      it: 'Senza E-E-A-T forte, contenuti su salute, finanza, legale, food sono penalizzati strutturalmente.\nAuthor bio, credenziali, link autorevoli sono ranking factor reali.',
      en: 'Without strong E-E-A-T, content on health, finance, legal, food is structurally penalised.\nAuthor bio, credentials, authoritative links are real ranking factors.',
    },
    whatToDemand: {
      it: 'Author bio dettagliato (Person schema).\nCitazioni esterne autorevoli e case study con dati reali.\nNiente content AI-generato senza review umana.',
      en: 'Detailed author bio (Person schema).\nAuthoritative external citations and case studies with real data.\nNo AI-generated content without human review.',
    },
  },
  {
    slug: 'featured-snippet',
    letter: 'F',
    term: 'Featured Snippet',
    fullName: 'Snippet in primo piano',
    whatItIs: {
      it: 'Box risposta sopra i risultati organici Google, estratto da una pagina ranking top 10.\nTipi: paragraph, list, table, video.\nSpesso chiamato "position 0".',
      en: 'Answer box above Google organic results, extracted from a top-10 ranking page.\nTypes: paragraph, list, table, video.\nOften called "position 0".',
    },
    whyYouCare: {
      it: 'Featured snippet ruba 30-40% del CTR della query — utile se sei tu, devastante se è un competitor.\nPer query informational, è il vero target ranking.',
      en: 'Featured snippet steals 30-40% of query CTR — useful if it\'s you, devastating if it\'s a competitor.\nFor informational queries, it\'s the real ranking target.',
    },
    whatToDemand: {
      it: 'Content strutturato: H2 = domanda specifica, paragrafo successivo = risposta concisa 40-60 parole.\nSchema FAQ.\nListe numerate per "how to".\nTabelle per confronti.',
      en: 'Structured content: H2 = specific question, next paragraph = concise 40-60 word answer.\nFAQ schema.\nNumbered lists for "how to".\nTables for comparisons.',
    },
  },
  {
    slug: 'google-search-console',
    letter: 'G',
    term: 'Google Search Console',
    fullName: 'GSC',
     whatItIs: {
      it: "Tool gratuito Google che mostra come il tuo sito performa nei risultati di ricerca: query che portano traffic, CTR, posizione media, errori indexing, manual action.",
      en: "Google's free tool showing how your site performs in search results: queries driving traffic, CTR, average position, indexing errors, manual actions.",
    },
    whyYouCare: {
      it: 'Senza GSC sei cieco sul SEO.\nAnalytics dice utenti+sessioni, ma non dice cosa cercavano per arrivare.\nGSC è la verità lato Google.',
      en: 'Without GSC you are blind on SEO.\nAnalytics tells you users+sessions, but not what they searched to arrive.\nGSC is the truth on Google\'s side.',
    },
    whatToDemand: {
      it: 'GSC verificato con DNS TXT, sitemap submitted, monitoring weekly su query top 50, alert email su manual action.\nExport performance API per analisi BigQuery oltre i 16 mesi.',
      en: 'GSC verified with DNS TXT, sitemap submitted, weekly monitoring on top-50 queries, email alert on manual action.\nPerformance API export for BigQuery analysis beyond 16 months.',
    },
  },
  {
    slug: 'hreflang',
    letter: 'H',
    term: 'Hreflang',
    whatItIs: {
      it: 'Tag HTML <link rel="alternate" hreflang="..."> che dice a Google quale versione lingua/regione di una pagina servire all\'utente in base alla sua location/lingua.\nEsempio: it, en, en-us, en-gb, x-default.',
      en: 'HTML tag <link rel="alternate" hreflang="..."> that tells Google which language/region version of a page to serve based on user location/language.\nExample: it, en, en-us, en-gb, x-default.',
    },
    whyYouCare: {
      it: 'Hreflang sbagliato = utente IT vede pagina EN, utente EN vede pagina IT.\nBounce rate alto, conversioni perse.\nSu siti multi-locale è il bug più comune.',
      en: 'Wrong hreflang = IT user sees EN page, EN user sees IT page.\nHigh bounce rate, lost conversions.\nOn multi-locale sites it\'s the most common bug.',
    },
    whatToDemand: {
      it: 'Hreflang reciproco (IT linka EN, EN linka IT), x-default per fallback, audit via GSC International Targeting.\nSe il sito ha /it /en, niente IP-based redirect (Google lo penalizza).',
      en: 'Reciprocal hreflang (IT links EN, EN links IT), x-default for fallback, audit via GSC International Targeting.\nIf the site has /it /en, no IP-based redirect (Google penalises it).',
    },
  },
  {
    slug: 'index',
    letter: 'I',
    term: 'Index / Indexing',
    fullName: 'Indicizzazione',
    whatItIs: {
      it: 'Inclusione di una pagina nel database di Google.\nUna pagina può essere crawled (visitata dal bot) ma non indexed (non inserita).\nSenza index, non appare nei risultati.',
      en: 'Inclusion of a page in the Google database.\nA page can be crawled (visited by the bot) but not indexed (not stored).\nWithout indexing, it doesn\'t appear in results.',
    },
    whyYouCare: {
      it: 'Pagine non indexed = pagine che non esistono per Google.\nCause comuni: noindex tag, crawl block robots.txt, content thin/duplicate, low quality signal.',
      en: 'Non-indexed pages = pages that don\'t exist for Google.\nCommon causes: noindex tag, robots.txt crawl block, thin/duplicate content, low quality signal.',
    },
    whatToDemand: {
      it: 'GSC Indexing report monitorato weekly.\nPagine target tutte "Indexed".\n"Crawled - currently not indexed" = sintomo di quality issue, da debuggare per pagina.',
      en: 'GSC Indexing report monitored weekly.\nAll target pages "Indexed".\n"Crawled - currently not indexed" = symptom of quality issue, debug per page.',
    },
  },
  {
    slug: 'internal-link',
    letter: 'I',
    term: 'Internal Link',
    fullName: 'Link interno',
    whatItIs: {
      it: 'Link da una pagina del tuo sito a un\'altra pagina del tuo sito.\nDistribuisce "link juice" interno e aiuta Google a capire la gerarchia del sito.',
      en: 'Link from one page of your site to another page of your site.\nDistributes internal "link juice" and helps Google understand the site hierarchy.',
    },
    whyYouCare: {
      it: 'Pagine senza internal link in entrata = "orphan pages", Google le considera meno importanti.\nInternal linking strategico passa autorità da pagine forti a pagine target.',
      en: 'Pages with no incoming internal link = "orphan pages", Google considers them less important. Strategic internal linking passes authority from strong pages to target pages.',
    },
    whatToDemand: {
      it: 'Mappa internal link gerarchica (homepage → pillar → cluster), audit orphan pages via Screaming Frog, anchor text descrittivo (no "qui" / "leggi qui"), 3-5 link in entrata per pagina target.',
      en: 'Hierarchical internal link map (homepage → pillar → cluster), orphan-page audit via Screaming Frog, descriptive anchor text (no "here" / "read here"), 3-5 incoming links per target page.',
    },
  },
  {
    slug: 'keyword',
    letter: 'K',
    term: 'Keyword',
    fullName: 'Parola chiave',
    whatItIs: {
      it: 'Parola o frase che gli utenti digitano in Google per trovare contenuto.\nCategorizzate per: volume di ricerca, difficulty (KD), intent (informational/navigational/transactional/commercial).',
      en: 'Word or phrase users type into Google to find content.\nCategorised by: search volume, difficulty (KD), intent (informational/navigational/transactional/commercial).',
    },
    whyYouCare: {
      it: 'Keyword research sbagliata = scrivi contenuto che nessuno cerca.\nVolume alto + difficulty alta = impossibile per siti piccoli.\nLong-tail (3+ parole) = volume basso ma intent alto, conversion-friendly.',
      en: 'Wrong keyword research = you write content nobody searches for.\nHigh volume + high difficulty = impossible for small sites.\nLong-tail (3+ words) = low volume but high intent, conversion-friendly.',
    },
    whatToDemand: {
      it: 'Keyword tracking GSC + Semrush/Ahrefs su top 20-50 keyword target.\nMix: head terms (volume) + long-tail (intent).\nMai puntare keyword DR>40 con sito DR<20.',
      en: 'Keyword tracking GSC + Semrush/Ahrefs on top 20-50 target keywords. Mix: head terms (volume) + long-tail (intent). Never target a DR>40 keyword with a DR<20 site.',
    },
  },
  {
    slug: 'link-building',
    letter: 'L',
    term: 'Link Building',
    whatItIs: {
      it: 'Pratica di acquisire backlink da altri siti.\nTecniche: digital PR (storie newsworthy), guest posting (articoli su altri siti), broken link building (sostituire link rotti con tuoi), HARO (rispondere a richieste journalist).',
      en: 'Practice of acquiring backlinks from other sites.\nTechniques: digital PR (newsworthy stories), guest posting (articles on other sites), broken link building (replace broken links with yours), HARO (respond to journalist requests).',
    },
    whyYouCare: {
      it: 'Senza link building (anche solo passive — content che attrae link), il sito non scala in autorità.\nComprare link è penalty (Penguin algorithm).',
      en: 'Without link building (even passive — link-worthy content), the site doesn\'t scale in authority. Buying links is a penalty (Penguin algorithm).',
    },
    whatToDemand: {
      it: 'Link building white-hat: digital PR, guest post selettivi, partnership content.\nMai PBN, mai link farm.\nAudit toxic link trimestrale + disavow Google.',
      en: 'White-hat link building: digital PR, selective guest posts, content partnerships. Never PBNs, never link farms. Quarterly toxic link audit + Google disavow.',
    },
  },
  {
    slug: 'meta-description',
    letter: 'M',
    term: 'Meta Description',
    whatItIs: {
      it: 'Tag HTML <meta name="description"> che descrive in 150-160 caratteri il contenuto della pagina.\nNon è ranking factor diretto, ma influenza CTR nei SERP (e CTR è ranking factor indiretto).',
      en: 'HTML <meta name="description"> tag describing the page content in 150-160 characters. Not a direct ranking factor, but influences SERP CTR (and CTR is an indirect ranking factor).',
    },
    whyYouCare: {
      it: 'Meta description vuota = Google ne genera una random dal contenuto, spesso pessima.\nDescription duplicate su 100 pagine = quality signal negativo.',
      en: 'Empty meta description = Google generates a random one from content, often poor. Duplicate descriptions across 100 pages = negative quality signal.',
    },
    whatToDemand: {
      it: 'Description unica per pagina, 140-160 caratteri, include keyword target naturale, propone CTA chiaro ("Scopri", "Confronta").\nAudit meta via Screaming Frog ogni release.',
      en: 'Unique description per page, 140-160 characters, naturally includes target keyword, proposes clear CTA ("Discover", "Compare"). Meta audit via Screaming Frog every release.',
    },
  },
  {
    slug: 'nofollow',
    letter: 'N',
    term: 'Nofollow',
    fullName: 'rel="nofollow"',
    whatItIs: {
      it: 'Attributo HTML <a rel="nofollow"> che dice a Google "non passare link juice via questo link".\nUsato per UGC (commenti), sponsored content, link non endorsati.',
      en: 'HTML attribute <a rel="nofollow"> that tells Google "don\'t pass link juice through this link". Used for UGC (comments), sponsored content, non-endorsed links.',
    },
    whyYouCare: {
      it: "Nofollow su tutti i link esterni in uscita = isolation antipatica e signal sospetto.\nMancato nofollow su link sponsorizzati = violazione Google policy, manual action rischio.",
      en: "Nofollow on all outbound external links = unfriendly isolation and suspicious signal. Missing nofollow on sponsored links = Google policy violation, manual action risk.",
    },
    whatToDemand: {
      it: 'rel="nofollow" su UGC/comments.\nrel="sponsored" su affiliate/paid.\nrel="ugc" su content user-generated.\nLink editoriali rimangono dofollow (default).',
      en: 'rel="nofollow" on UGC/comments. rel="sponsored" on affiliate/paid. rel="ugc" on user-generated content. Editorial links stay dofollow (default).',
    },
  },
  {
    slug: 'on-page-seo',
    letter: 'O',
    term: 'On-page SEO',
    fullName: 'SEO on-page',
    whatItIs: {
      it: 'Ottimizzazioni interne alla pagina: title tag, meta description, headings (H1-H6), URL structure, content quality, internal linking, schema markup, image alt.',
      en: 'On-page optimisations: title tag, meta description, headings (H1-H6), URL structure, content quality, internal linking, schema markup, image alt.',
    },
    whyYouCare: {
      it: 'On-page SEO è il 70% del lavoro SEO controllabile.\nOff-page (link, signals esterni) è 30% ma più difficile da influenzare.\nPartire dall\'on-page è razionale.',
      en: 'On-page SEO is 70% of the controllable SEO work. Off-page (links, external signals) is 30% but harder to influence. Starting from on-page is rational.',
    },
    whatToDemand: {
      it: 'On-page audit completo via Screaming Frog: 0 missing title, 0 duplicate H1, 0 broken internal link, 0 image senza alt.\nScore Lighthouse SEO ≥95.',
      en: 'Complete on-page audit via Screaming Frog: 0 missing titles, 0 duplicate H1s, 0 broken internal links, 0 images without alt. Lighthouse SEO score ≥95.',
    },
  },
  {
    slug: 'redirect-301',
    letter: 'R',
    term: 'Redirect 301',
    fullName: 'Redirect permanente',
    whatItIs: {
      it: 'HTTP status code 301 che dice "questa URL è permanentemente spostata a Y".\nTrasferisce ~95% del link juice della vecchia URL alla nuova.\nVs 302 (temporary) che non lo fa pienamente.',
      en: 'HTTP 301 status code that says "this URL is permanently moved to Y". Transfers ~95% of link juice from old URL to new. Vs 302 (temporary) which doesn\'t fully transfer.',
    },
    whyYouCare: {
      it: 'Migrazione/restyle senza redirect 301 = perdi tutto il SEO che avevi.\nErrore catastrofico più comune nei rebranding.',
      en: 'Migration/restyle without 301 redirects = you lose all the SEO you had. Most common catastrophic error in rebrandings.',
    },
    whatToDemand: {
      it: 'Mappa redirect 1:1 vecchie URL → nuove URL prima del go-live.\nTest 301 (non 302) via curl.\nGSC monitoring 30 giorni post-launch per crawl error.',
      en: '1:1 redirect map old URLs → new URLs before go-live. Test 301 (not 302) via curl. GSC monitoring 30 days post-launch for crawl errors.',
    },
  },
  {
    slug: 'robots-txt',
    letter: 'R',
    term: 'Robots.txt',
    whatItIs: {
      it: 'File /robots.txt che dice ai bot crawler quali path possono/non possono visitare.\nEs: User-agent: * / Disallow: /admin/.\nNON è meccanismo di sicurezza, solo cortesia.',
      en: 'File /robots.txt that tells crawler bots which paths they can/cannot visit. E.g.: User-agent: * / Disallow: /admin/. NOT a security mechanism, only courtesy.',
    },
    whyYouCare: {
      it: 'Disallow di tutto il sito (Disallow: /) = sito invisibile a Google.\nErrore frequente quando si copia robots.txt da staging a production.',
      en: 'Disallow on the entire site (Disallow: /) = site invisible to Google. Common error when copying robots.txt from staging to production.',
    },
    whatToDemand: {
      it: 'robots.txt esplicito, sitemap reference, user-agent specifici per Googlebot/Bingbot, disallow su path sensitive (/admin, /api, /private), test via GSC robots tester.',
      en: 'Explicit robots.txt, sitemap reference, specific user-agents for Googlebot/Bingbot, disallow on sensitive paths (/admin, /api, /private), test via GSC robots tester.',
    },
  },
  {
    slug: 'schema-markup',
    letter: 'S',
    term: 'Schema Markup',
    fullName: 'Structured Data / JSON-LD',
    whatItIs: {
      it: "JSON-LD inserito in <head> che dice a Google il significato semantico del contenuto: Article, Product, LocalBusiness, FAQ, Recipe, ecc.\nVocabolario standardizzato schema.org.",
      en: 'JSON-LD inserted in <head> telling Google the semantic meaning of content: Article, Product, LocalBusiness, FAQ, Recipe, etc. Standardised schema.org vocabulary.',
    },
    whyYouCare: {
      it: 'Schema markup = rich snippet in SERP (stelle, prezzo, FAQ accordion, breadcrumb).\nCTR boost 20-30%.\nSenza, hai snippet vanilla.',
      en: 'Schema markup = rich snippets in SERP (stars, price, FAQ accordion, breadcrumb). CTR boost 20-30%. Without it, you get vanilla snippets.',
    },
    whatToDemand: {
      it: "Schema appropriato per page type: Article su blog, Product su e-commerce, LocalBusiness su location pages, FAQPage su FAQ.\nValidation via Google Rich Results Test ogni release.",
      en: 'Appropriate schema per page type: Article on blog, Product on e-commerce, LocalBusiness on location pages, FAQPage on FAQ. Validation via Google Rich Results Test every release.',
    },
  },
  {
    slug: 'search-intent',
    letter: 'S',
    term: 'Search Intent',
    fullName: 'Intento di ricerca',
    whatItIs: {
      it: "Cosa l'utente vuole davvero quando digita una query.\nCategorie: informational (\"cos'è LCP\"), navigational (\"facebook login\"), transactional (\"comprare iPhone 15\"), commercial (\"miglior laptop 2026\").",
      en: 'What the user actually wants when they type a query. Categories: informational ("what is LCP"), navigational ("facebook login"), transactional ("buy iPhone 15"), commercial ("best laptop 2026").',
    },
    whyYouCare: {
      it: 'Content che non matcha intent = bounce alto, ranking impossibile.\nEs: scrivere "Guida completa LCP" per query "fix LCP wordpress" = miss.',
      en: 'Content that doesn\'t match intent = high bounce, impossible ranking. E.g.: writing "Complete LCP guide" for the query "fix LCP wordpress" = miss.',
    },
    whatToDemand: {
      it: 'Per ogni keyword target, leggere top 10 risultati Google PRIMA di scrivere.\nSe top 10 sono guide step-by-step, scrivi guida step-by-step.\nMatch the intent.',
      en: 'For every target keyword, read the top 10 Google results BEFORE writing. If top 10 are step-by-step guides, write a step-by-step guide. Match the intent.',
    },
  },
  {
    slug: 'serp',
    letter: 'S',
    term: 'SERP',
    fullName: 'Search Engine Results Page',
    whatItIs: {
      it: 'Pagina risultati Google.\nComposta da: organic results (10 link), ads (top + bottom), featured snippet, People Also Ask, image pack, video pack, local pack (se geo), AI Overviews (recente).',
      en: 'Google results page. Composed of: organic results (10 links), ads (top + bottom), featured snippet, People Also Ask, image pack, video pack, local pack (if geo), AI Overviews (recent).',
    },
    whyYouCare: {
      it: "Posizione 1 organic vale ~28% CTR, posizione 5 vale ~6%.\nMa con AI Overviews crescenti, anche posizione 1 può perdere CTR a vantaggio della box AI sopra.",
      en: 'Organic position 1 is worth ~28% CTR, position 5 is ~6%. But with growing AI Overviews, even position 1 can lose CTR to the AI box above.',
    },
    whatToDemand: {
      it: "Monitoring SERP feature per query target (featured snippet, PAA, AI Overview).\nTool: Semrush SERP analysis, Sistrix Visibility Index.\nAdattare strategia content alle SERP feature presenti.",
      en: 'SERP feature monitoring per target query (featured snippet, PAA, AI Overview). Tools: Semrush SERP analysis, Sistrix Visibility Index. Adapt content strategy to present SERP features.',
    },
  },
  {
    slug: 'sitemap',
    letter: 'S',
    term: 'Sitemap',
    fullName: 'XML sitemap',
    whatItIs: {
      it: "File XML che lista tutte le URL indexable del tuo sito + lastmod, changefreq, priority.\nAiuta Google a scoprire pagine e capire prioritization.",
      en: 'XML file listing all indexable URLs of your site + lastmod, changefreq, priority. Helps Google discover pages and understand prioritisation.',
    },
    whyYouCare: {
      it: 'Senza sitemap, Google scopre pagine via crawling (lento, parziale per siti grandi).\nCon sitemap submitted, indexing 3-10x più veloce.',
      en: 'Without sitemap, Google discovers pages via crawling (slow, partial for large sites). With submitted sitemap, indexing is 3-10x faster.',
    },
    whatToDemand: {
      it: 'Sitemap XML auto-generata, submitted GSC, contiene SOLO pagine indexable (no noindex, no canonical-to-other), <50k URL per file (split se serve), aggiornata su content change.',
      en: 'Auto-generated XML sitemap, GSC submitted, contains ONLY indexable pages (no noindex, no canonical-to-other), <50k URLs per file (split if needed), updated on content change.',
    },
  },
  {
    slug: 'title-tag',
    letter: 'T',
    term: 'Title Tag',
    whatItIs: {
      it: 'Tag HTML <title> che appare nel tab browser e come headline blu nei risultati Google.\nLimite ~60 caratteri prima del troncamento.\nRanking factor diretto.',
      en: 'HTML <title> tag appearing in the browser tab and as the blue headline in Google results.\n~60 character limit before truncation.\nDirect ranking factor.',
    },
    whyYouCare: {
      it: 'Title vuoto/duplicato/generico = ranking impossibile su query competitive.\nTitle troppo lungo = troncamento in SERP, perdi CTR.',
      en: 'Empty/duplicate/generic title = impossible ranking on competitive queries. Title too long = SERP truncation, you lose CTR.',
    },
    whatToDemand: {
      it: 'Title unico per pagina, 50-60 caratteri, include keyword target nei primi 30 caratteri, usa power words se commercial intent (es. "2026", "Guida").\nAudit via Screaming Frog ogni release.',
      en: 'Unique title per page, 50-60 characters, includes target keyword in the first 30 characters, uses power words for commercial intent (e.g. "2026", "Guide"). Audit via Screaming Frog every release.',
    },
  },
];

export const GLOSSARIO_SEO_LETTERS = Array.from(
  new Set(GLOSSARIO_SEO.map((t) => t.letter)),
).sort();

export type SeoTermLocalised = {
  slug: string;
  letter: string;
  term: string;
  fullName?: string;
  whatItIs: string;
  whyYouCare: string;
  whatToDemand: string;
};

export function localiseTerms(locale: Locale): SeoTermLocalised[] {
  return GLOSSARIO_SEO.map((t) => ({
    slug: t.slug,
    letter: t.letter,
    term: t.term,
    fullName: t.fullName,
    whatItIs: t.whatItIs[locale],
    whyYouCare: t.whyYouCare[locale],
    whatToDemand: t.whatToDemand[locale],
  }));
}

export const GLOSSARIO_SEO_META = {
  it: {
    metaTitle: 'Glossario SEO 2026 · I 25 termini che ti vendono fumo se non li capisci | Federico Calicchia',
    description:
      'Backlink, Canonical, Crawl Budget, E-E-A-T, Schema Markup, hreflang… 25 termini SEO spiegati semplici. Per ogni termine: cos\'è, perché ti riguarda, cosa pretendere dal fornitore.',
    ogTitle: 'Glossario SEO 2026 · 25 termini essenziali, spiegati senza fluff',
    ogDescription: 'Backlink, Canonical, E-E-A-T, Schema, hreflang, CWV. Spiegati per quello che sono — e perché ti riguardano.',
    eyebrow: `Glossario — 25 termini · ordine A-Z`,
    pageTitle: 'Glossario SEO 2026. I 25 termini che ti vendono fumo se non li capisci.',
    lead:
      'Il modo più veloce per farti vendere SEO che non funziona è usare termini che non capisci.\nEccoli, spiegati per quello che sono — e perché ti riguardano.\nPer ogni termine: cos\'è, perché ti riguarda, cosa pretendere dal fornitore.',
    readTime: 'lettura libera',
    updatedAt: '9 maggio 2026',
    sectionWhatItIs: "Cos'è",
    sectionWhyYouCare: 'Perché ti riguarda',
    sectionWhatToDemand: 'Cosa pretendere',
    closingTitle: "Adesso quando un'agenzia ti dice \"non preoccuparti del DA, è normale\", sai cosa rispondere.",
    ctaPrimary: 'Parlane con uno che capisce',
    ctaSecondary: 'Vai al servizio SEO',
    breadcrumbServiceName: 'Servizi',
    breadcrumbGlossaryName: 'Glossario SEO',
  },
  en: {
    metaTitle: 'SEO Glossary 2026 · The 25 terms agencies sell you smoke with if you don\'t get them | Federico Calicchia',
    description:
      'Backlink, Canonical, Crawl Budget, E-E-A-T, Schema Markup, hreflang… 25 SEO terms explained simply. For each term: what it is, why it matters, what to demand from your vendor.',
    ogTitle: 'SEO Glossary 2026 · 25 essential terms, explained no fluff',
    ogDescription: 'Backlink, Canonical, E-E-A-T, Schema, hreflang, CWV. Explained for what they are — and why they matter to you.',
    eyebrow: 'Glossary — 25 terms · A-Z order',
    pageTitle: 'SEO Glossary 2026. The 25 terms agencies sell you smoke with if you don\'t get them.',
    lead:
      'The fastest way to be sold SEO that doesn\'t work is by using terms you don\'t understand.\nHere they are, explained for what they are — and why they matter to you.\nFor each term: what it is, why it matters, what to demand from your vendor.',
    readTime: 'free reading',
    updatedAt: 'May 9, 2026',
    sectionWhatItIs: 'What it is',
    sectionWhyYouCare: 'Why it matters',
    sectionWhatToDemand: 'What to demand',
    closingTitle: "Now when an agency tells you \"don't worry about DA, it's normal\", you know what to reply.",
    ctaPrimary: 'Talk to someone who gets it',
    ctaSecondary: 'See SEO service',
    breadcrumbServiceName: 'Services',
    breadcrumbGlossaryName: 'SEO Glossary',
  },
} as const;
