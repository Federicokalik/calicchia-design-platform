/**
 * Compact, whitepaper-grounded GEO remediation playbook.
 *
 * Distilled from the "Dalla SEO alla GEO" white paper
 * (apps/sito-v3/src/content/_md/risorse__dalla-seo-alla-geo.it.md). We embed a
 * condensed version here rather than reading the 81 KB markdown at runtime: the
 * API runs in its own container without sito-v3's files, and feeding the full
 * paper on every unlock would be slow and costly. Keep this in sync with the
 * paper's evidence-based recommendations if the paper changes materially.
 *
 * It is injected into the action-plan LLM call so the "how" instructions are
 * concrete and aligned with the paper (not generic SEO advice).
 */
export const GEO_WHITEPAPER_PLAYBOOK = `RIFERIMENTO GEO (dal white paper "Dalla SEO alla GEO", aggiornato a settembre 2026, evidence-based):

Principio: l'obiettivo è aumentare la probabilità di essere CITABILI dai motori AI (ChatGPT/Bing, Perplexity, Google AI, Claude), non garantire una citazione. Tutti usano RAG + embeddings + selezione a livello di "chunk": contano struttura, freschezza, autorevolezza e citabilità, non il ranking tradizionale. Il gioco si sposta dai click alle citazioni, ma non si chiude: il CTR organico in presenza di AI Overview è rimbalzato (~1,3% dic 2025 → ~2,4% feb 2026, Seer) e il traffico da AI converte molto meglio dell'organico (4,4x Semrush; 23x Ahrefs; Adobe +42%) — molti brand perdono click ma non fatturato.

Leve con evidenza empirica (Aggarwal et al., KDD 2024) — usale nelle azioni:
- Aggiungere STATISTICHE citate: fino a +31% di visibilità.
- Aggiungere QUOTAZIONI/virgolettati di fonti autorevoli: fino a +41%.
- CITARE FONTI esterne autorevoli: ~+28% (fino a +115% per siti a bassa autorità).
- Struttura ANSWER-FIRST: heading a domanda + risposta diretta nei primi 40-60 token (allineamento col cross-encoder).
- FRESCHEZZA: contenuto aggiornato di recente citato fino a +38% (specie Perplexity); anche piccole modifiche resettano il segnale → aggiornare i contenuti chiave ogni trimestre.
- Da EVITARE: keyword stuffing (unico metodo testato che PEGGIORA la visibilità).

robots.txt: AMMETTERE i bot di retrieval/citazione (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User). Si possono bloccare i bot di training/opt-out (GPTBot, ClaudeBot, Google-Extended) senza penalizzare automaticamente la citabilità. Bloccare i bot di retrieval può rimuovere il sito dalle risposte AI. Pubblicare una sitemap.xml; valutare Bing Webmaster Tools + IndexNow.

CLOUDFLARE (novità set 2026): dal 15 settembre 2026 Cloudflare blocca di DEFAULT i crawler AI "mixed-use" (search + training + agent mescolati) su pagine con pubblicità, per nuovi clienti e clienti free; i crawler di sola ricerca restano ammessi. Per i siti dietro Cloudflare: decidere consapevolmente tra bloccare, consentire o monetizzare (Pay Per Crawl è evoluto in Pay Per Use), MAI bloccare per errore i bot di retrieval che generano citazioni.

SEARCH CONSOLE (novità set 2026): i report "Search Generative AI" sono globali dal 31 agosto 2026 (dati dal 18 maggio 2026, UK dal 3 giugno 2026): impression in AI Overviews, AI Mode e Discover, pagine, paesi, dispositivi, date — SOLO impression, niente click né prompt. Esiste un toggle di opt-out dalle feature AI senza penalità di ranking. Consigliare di attivarli per una baseline di esposizione AI.

FAQ/rich results (novità set 2026): Google ha deprecato i FAQ rich results dal 7 maggio 2026 (dopo HowTo nel 2023; Practice Problem e Sitelinks Search Box a gennaio 2026). Il markup FAQPage resta valido ma non produce più rich results (l'API Search Console per i dati FAQ è stata rimossa ad agosto 2026): NON rimuovere lo schema (non fa male, aiuta la comprensione delle entità), ma non fondare decisioni o audit sui rich results FAQ. Nessuno schema speciale è richiesto per AI Overviews o AI Mode.

AI ACT art. 50 (in vigore dal 2 agosto 2026): i contenuti generati da AI su temi di interesse pubblico vanno etichettati (marking machine-readable; deepfake etichettati; utenti informati quando interagiscono con chatbot). Sanzioni fino a €15M o 3% del fatturato mondiale; contenuti precedenti al 2 agosto 2026 non etichettati retroattivamente; periodo transitorio fino al 2 dicembre 2026; esente la revisione editoriale umana con responsabilità di persona identificabile. Consigliare: clausole nei contratti, responsabilità editoriale documentata nel CMS.

Rendering: molti bot AI non eseguono JavaScript → il contenuto chiave deve essere reso SERVER-SIDE nell'HTML grezzo.

Struttura: un solo <h1>, gerarchia <h2>/<h3>, un'idea per sezione (chunk auto-sufficienti); includere sia i concetti sia la terminologia esatta nello stesso blocco (retrieval ibrido dense+sparse).

Autorità (off-page, non auto-verificabile): menzioni del brand su G2, Trustpilot, Wikipedia, Reddit, YouTube; il volume di ricerca del brand è il predittore più forte di visibilità AI (0,334; menzioni non linkate 0,664; Wikidata/Wikipedia + piattaforme autorevoli ≈ 2,8x la probabilità di citazione). Ipotesi da trattare come tale (Seer): le citazioni possono essere "post-hoc" — l'LLM decide prima il brand da raccomandare e poi cerca le fonti; la brand authority non si compensa con trucchi di citazione.

Multi-engine (novità set 2026): ChatGPT è sceso sotto il 50% della quota app a marzo 2026 (Sensor Tower: 46,4%; Gemini 27,7%; Claude 10,3%). Non si ottimizza per un solo motore: ChatGPT + Gemini + Claude sono il set base (~84% dell'audience app), ogni engine va monitorato separatamente. Tracciare il traffico da AI come canale separato in GA4 (pratica ancora rara: solo 16% delle Fortune 500 e 22% dei marketer); KPI: share of voice, citation rate. Il traffico AI resta ~1% del totale ma converte meglio.

Agentic browsing: ChatGPT Atlas è stato dismesso come browser il 9 agosto 2026 (funzioni agentiche nell'app ChatGPT e in un'estensione Chrome); Perplexity Comet è gratuito e cross-platform (Android dal 19 agosto 2026); Google ha chiuso Project Mariner integrandolo in Gemini Agent. Implicazione: le funzioni agentiche non richiedono strategie separate per oggi — il contenuto server-side e strutturato serve anche gli agenti.

Non priorità (smentite o non provate come leve di citazione): llms.txt, schema markup speciale, file .md, chunking manuale. llms.txt può essere trattato come "agentic readiness" opzionale (Lighthouse 13.3.0), ma non come fattore di citazione Search/ChatGPT. Non insistere su queste.

Misurazione: la visibilità AI è una distribuzione, non un punteggio singolo; servono 7-10+ run per prompt per dati affidabili. Per le PMI: tool entry (Otterly ~$29/mese, Semrush AI Visibility Toolkit da $99) sufficienti per iniziare; Profound/enterprise solo con budget dedicato.`;
