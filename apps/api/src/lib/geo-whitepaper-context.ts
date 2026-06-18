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
export const GEO_WHITEPAPER_PLAYBOOK = `RIFERIMENTO GEO (dal white paper "Dalla SEO alla GEO", evidence-based):

Principio: l'obiettivo è essere CITATI dai motori AI (ChatGPT/Bing, Perplexity, Google AI, Claude). Tutti usano RAG + embeddings + selezione a livello di "chunk": contano struttura, freschezza, autorevolezza e citabilità, non il ranking tradizionale.

Leve con evidenza empirica (Aggarwal et al., KDD 2024) — usale nelle azioni:
- Aggiungere STATISTICHE citate: fino a +31% di visibilità.
- Aggiungere QUOTAZIONI/virgolettati di fonti autorevoli: fino a +41%.
- CITARE FONTI esterne autorevoli: ~+28% (fino a +115% per siti a bassa autorità).
- Struttura ANSWER-FIRST: heading a domanda + risposta diretta nei primi 40-60 token (allineamento col cross-encoder).
- FRESCHEZZA: contenuto aggiornato di recente citato fino a +38% (specie Perplexity); anche piccole modifiche resettano il segnale → aggiornare i contenuti chiave ogni trimestre.
- Da EVITARE: keyword stuffing (unico metodo testato che PEGGIORA la visibilità).

robots.txt: AMMETTERE i bot di retrieval/citazione (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User). Si possono bloccare i bot di training (GPTBot, ClaudeBot, Google-Extended) senza perdere le citazioni. Bloccare i bot di retrieval rimuove il sito dalle risposte AI. Pubblicare una sitemap.xml; valutare Bing Webmaster Tools + IndexNow.

Rendering: molti bot AI non eseguono JavaScript → il contenuto chiave deve essere reso SERVER-SIDE nell'HTML grezzo.

Struttura: un solo <h1>, gerarchia <h2>/<h3>, un'idea per sezione (chunk auto-sufficienti); includere sia i concetti sia la terminologia esatta nello stesso blocco (retrieval ibrido dense+sparse).

Autorità (off-page, non auto-verificabile): menzioni del brand su G2, Trustpilot, Wikipedia, Reddit, YouTube; il volume di ricerca del brand è il predittore più forte di visibilità AI.

Non priorità (smentite o non provate): llms.txt, schema markup speciale, file .md, chunking manuale. Non insistere su queste.

Misurazione: la visibilità AI è una distribuzione, non un punteggio singolo; servono 7-10+ run per prompt per dati affidabili.`;
