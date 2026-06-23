# From SEO to GEO: A White Paper on the Evolution of Search in the Age of Generative AI

*White paper by [Federico Calicchia](https://github.com/federicokalik), written with the support of Claude Opus 4.8 (Anthropic) under his editorial direction · Last updated: 22 June 2026*

> **Methodological note.** This document was developed from research into primary and secondary sources (academic papers, official engine documentation, industry reports, independent reverse-engineering analyses). The sections explicitly distinguish documented facts from vendor claims and from analyses not officially confirmed. All sources are listed in the bibliography.

## Introduction

For twenty years, online search worked according to a stable grammar: a user types a query, an engine returns an ordered list of links, the user clicks and lands on a site. An entire discipline — SEO — was built on this mechanics, and with it the economic model of the open web, where visibility translated into traffic and traffic into value. That grammar is breaking down.

Generative engines — Google with AI Overviews and AI Mode, ChatGPT, Perplexity, Microsoft Copilot, Claude — no longer return primarily a list of links: they read the web on the user's behalf, synthesise an answer and cite a few sources. The click, which used to be the goal, becomes the exception. The unit of competition changes (no longer the page, but the single "chunk" of content that a retrieval system can extract and cite), the metrics change (from SERP position to citation share), the players change (no longer a single dominant engine, but a fragmented and rapidly evolving archipelago, with dynamics of its own even outside the West). From this shift, GEO is born — *Generative Engine Optimization*.

This white paper reconstructs the transition from SEO to GEO with three goals: to explain **how generative engines really work** at the level of retrieval (embeddings, chunking, re-ranking, query fan-out) and source selection, engine by engine; to **distinguish what is documented** from what is inferred through reverse-engineering or simply asserted by vendors; and to **situate the phenomenon in the Italian and European context**, where the regulatory framework (AI Act, TDM opt-out, DSA, GDPR) is the most stringent in the world and concretely conditions what GEO can and cannot do. The approach is educational and analytical, not operational-commercial: the aim is to understand the mechanism, not to sell a recipe.

## TL;DR
- **Search is migrating from a "blue link" model (crawling → indexing → ranking → click) to a "generative engine" model that synthesises answers and cites a few sources:** in 2024, 58.5% of US Google searches ended without a click (SparkToro/Datos), rising to 68.01% in early 2026 (SparkToro/Similarweb); when an AI Overview appears, the organic CTR of the top page drops by roughly 47-61% depending on the study (Authoritas, Pew, Seer Interactive, Ahrefs).
- **GEO (Generative Engine Optimization) originates from the academic paper by Aggarwal et al. (IIT Delhi/Princeton, KDD 2024)**, which demonstrates that adding statistics, citations and quotations can increase visibility in generative answers "by up to 40%", whereas traditional keyword stuffing is the only tested method that *worsens* visibility.
- **Each AI engine has a different retrieval pipeline** (ChatGPT on the Bing index/third-party scraping, Perplexity with its own crawler, Claude on Brave Search, Copilot on Bing with Prometheus, Gemini on the Google index with query fan-out): all use RAG, embeddings and "chunk"-level selection, so content structure, freshness, authority and citability matter more than traditional ranking.
- **AI visibility is a distribution, not a score:** a single measurement has a standard error of 0.370 (statistically useless); 7-10+ repeated runs per prompt are needed (the paper "Don't Measure Once", arXiv 2604.07585).
- **Google itself (May 2026) declared that "GEO is still SEO"** and debunked 5 myths, including llms.txt and manual chunking.

## Key Findings

1. **Search behaviour has changed structurally, not marginally.** Zero-click went from ~50% (SparkToro 2019) to 68.01% (Q1 2026 USA). Gartner predicted (Feb 2024) a 25% drop in traditional search volume by 2026 — a forecast, not a final figure.
2. **Traditional organic ranking remains important but is no longer sufficient.** The Ahrefs study of January 2026 shows that only 38% of pages cited in AI Overviews are also in the organic top 10 (it was 76% in July 2025).
3. **The GEO tactics with empirical evidence are few and specific:** statistics, source citations, quotations, freshness, "answer-first" structure. Many popular pieces of advice (llms.txt, schema-as-hack, manual chunking) have no evidence of working and some are contradicted by Google.
4. **The Italian/EU market is lagging but accelerating fast:** AI Overviews in Italy since 26 March 2025; GenAI use in Italy at 20% (below the EU average of 33%, Eurostat 2025); after the FIEG complaint (15 October 2025), AGCOM referred the Google AI Overviews/AI Mode case to the EU Commission under art. 65 DSA (29 April 2026). Engine fragmentation is global: in China, Doubao, ERNIE, DeepSeek and Qwen together exceed 900 million users.
5. **The EU regulatory context is the most stringent in the world:** the AI Act, GDPR, the TDM opt-out under art. 4 CDSM, the Garante-OpenAI case and publisher disputes shape how GEO can operate in Europe.

## Details

### 1. The evolution from SEO to GEO

#### How traditional search worked (and still works)
Classic SEO rests on three phases: **crawling** (a bot such as Googlebot discovers and downloads pages), **indexing** (pages are analysed and stored in an index), and **ranking** (an algorithm orders the pages for a query, producing the SERP, the list of "blue links"). The economic model of the open web was based on **click-through**: the user searched, saw a list of results and clicked on a site, generating monetisable traffic.

#### How AI-driven search works
Generative engines do not primarily return a list of links but **synthesise an answer** from multiple sources using an LLM, citing a few sources inline. This produces **zero-click answers**: the user gets the answer without visiting any site. Google integrated this paradigm with **AI Overviews** (generative boxes at the top of the SERP) and **AI Mode** (a full conversational experience).

#### Turning points and timeline
- **May 2023:** Google announces the Search Generative Experience (SGE) as a Search Labs experiment.
- **14 May 2024:** Google officially launches AI Overviews in the USA (at Google I/O).
- **28 October 2024:** AI Overviews extended to more than 100 countries and territories.
- **31 October 2024:** OpenAI launches ChatGPT Search.
- **5 March 2025:** AI Overviews move to Gemini 2.0; Google announces AI Mode as a Labs experiment.
- **26 March 2025:** AI Overviews arrive in Italy and in other European countries.
- **20 May 2025:** AI Mode extended to all US users.
- **7 May 2026:** Google Chrome releases Lighthouse 13.3.0 with the experimental "Agentic Browsing" category (including an llms.txt check) in the default config.
- **15 May 2026:** Google publishes the official GEO guide ("Optimizing your website for generative AI features").
- **5 June 2026:** Google publishes guidance on third-party SEO services and updates "Do you need an SEO?", naming AEO/GEO as a service category.

Perplexity (founded in 2022) popularised the concept of the "answer engine" with transparent citations. Claude (Anthropic) added web search in 2025.

#### The foundational paper "GEO: Generative Engine Optimization"
The term GEO was formalised in the paper by **Pranjal Aggarwal, Vishvak Murahari, Tanmay Rajpurohit, Ashwin Kalyan, Karthik Narasimhan and Ameet Deshpande** (IIT Delhi/Princeton/Allen AI), published at **KDD 2024** (arXiv:2311.09735, DOI 10.1145/3637528.3671900). Key results, verified against the original text:

- They introduced **GEO-bench**, a benchmark of **10,000 queries** from different domains.
- They tested **9 optimization methods**: Authoritative, Keyword Stuffing, Statistics Addition, Quotation Addition, Cite Sources, Fluency Optimization, Easy-to-Understand, Technical Terms, Unique Words.
- There are two metrics: **Position-Adjusted Word Count** (words attributed to a source, weighted by position in the answer) and **Subjective Impression** (a qualitative G-Eval score across 7 dimensions).
- The best methods — **Quotation Addition (+41%), Statistics Addition (+31%), Cite Sources (+28%), Fluency Optimization (+28%)** — can increase visibility "**up to 40%**" in generative answers. Summary sentence: *"The best methods improve upon baseline by 41% and 28% on Position-Adjusted Word Count and Subjective Impression respectively."*
- **Keyword Stuffing** is the **only method that worsened** visibility (−8%): SEO tactics do not transfer automatically to generative engines.
- Effectiveness **varies by domain**: Statistics in "Law & Government" and "Opinion" queries; Quotation in "History" and "People & Society".
- GEO is particularly advantageous for **low-ranking** sites: Cite Sources increased visibility by **115.1%** for sites in fifth SERP position.
- The combination **Fluency + Statistics** outperformed any single method by more than 5.5%.
- Validation on Perplexity.ai: improvements **up to 37%**.

*(Sourcing note: method titles, headline percentages and prose sentences confirmed on arXiv. v3 reports a 15-30% boost for stylistic methods, against the "10-20%" of earlier versions — a version discrepancy to flag.)*

#### Data on the change in search behaviour
- **SparkToro/Datos (2024):** 58.5% of US Google searches and 59.7% of EU searches without a click. For every 1,000 US searches, only 360 clicks to the open web.
- **SparkToro/Similarweb (2026):** **68.01%** of US Google searches without a click in the first 4 months of 2026 (+7.56 points from 2024).
- **Ahrefs (Dec 2025):** the presence of an AI Overview correlates with an average CTR that is **58%** lower for the top page.
- **Pew Research (Jul 2025):** across 68,879 real searches, clicks on a traditional link at 8% with an AI Overview vs 15% without (≈ −47%); only 1% click a cited source; 26% of sessions with an AIO end altogether (vs 16%). Google disputed the methodology.
- **Seer Interactive (Sep 2025, >25M impressions):** organic CTR for queries with an AIO collapsed by **61%** (1.76% → 0.61%).
- **Gartner (Feb 2024):** forecast of a −25% drop in traditional search volume by 2026.
- **Publisher impact:** Digital Content Next (Aug 2025) reports a median drop in Google referral traffic of **10%**; Press Gazette/Chartbeat: −33% globally in 2025 (−38% USA, −17% Europe). The damage scales with site size.

### 2. How each AI engine works technically (overview)

All generative engines use some form of **RAG (Retrieval-Augmented Generation)**: instead of relying solely on "parametric" knowledge (learned in training), they retrieve fresh content from the web and use it to build the answer. Subsections 2-bis and 2-ter go deep into the mechanics and the reverse-engineering; here is the per-engine summary.

- **ChatGPT (OpenAI):** retrieval via third-party scraping APIs (historically tied to Bing; Seer Interactive found 87% overlap with Bing's top results); query fan-out; source selection that weighs authority, structure and freshness.
- **Google Gemini / AI Overviews / AI Mode:** its own web index + Knowledge Graph + Shopping; query fan-out documented via the API; selection that also draws from outside the organic top-10 (Ahrefs Jan 2026: only 38% of citations from the top-10).
- **Perplexity:** RAG with its own crawler (PerplexityBot); strong sensitivity to freshness; typically 3-5 sources per answer; multi-layer ML reranking.
- **Microsoft Copilot:** the Prometheus model on the Bing index; a "Bing Orchestrator" that generates iterative internal queries (fan-out); numbered citations [1][2]; the first engine to codify GEO in its own Webmaster Guidelines (February 2026).
- **Claude (Anthropic):** retrieval via an external provider (overlap with Brave); sentence-level citation; three bots (ClaudeBot training, Claude-User fetch, Claude-SearchBot indexing).

### 2-bis. The technical mechanics of retrieval (from vector to cited chunk)

This section descends to the level a developer needs in order to make markup and content-architecture decisions. The underlying thesis: **the "page" is no longer the unit of competition; the chunk is.** Understanding how a chunk is represented, retrieved and re-ordered explains why certain HTML-structure choices increase or destroy citability.

#### 2-bis.1 — The three families of retrieval: dense, sparse, late-interaction

**Dense retrieval (bi-encoder).** Query and document are encoded *separately* into a single dense vector (e.g. 768 dimensions); relevance is the cosine similarity. Very fast (pre-computed vectors + ANN), but — as Towards Data Science summarises — *"the model compresses all meaning into one vector before any comparison happens"*: query and document never interact at the token level. GEO consequence: a chunk that mixes three concepts produces an "average" vector that does not represent any of the three well.

**Sparse retrieval (BM25, SPLADE).** Exact (or expanded) lexical match. Unbeatable on proper nouns, product codes, technical terms — the cases where dense fails.

**Late interaction (ColBERT and successors).** Keeps the embeddings *at the token level* and computes relevance with MaxSim (each query token vs each document token). Weaviate: dense methods *"pool token-wise embeddings into a single representation while ColBERT embeddings keep the token-wise representations in a multi-vector"*. Advantage: explainability. Disadvantage: storage (BEIR: ~20GB/1M docs vs 0.4GB for BM25 and ~3GB for dense).

**The figure that matters for GEO:** **hybrid dense+sparse approaches beat any single method**. A single study (Jan 2026, on MS MARCO, a low-visibility source with an unusually low dense baseline — to be treated as indicative, not as a consolidated benchmark) reports up to **580% improvement in Recall@10** over dense alone (13.9% → 80.8%); the general principle — hybrid beats the single methods — is nonetheless confirmed by more solid peer-reviewed literature. Real engines combine "meaning" (dense) and "exact word" (sparse): content must serve both — clear concepts *and* exact terminology.

#### 2-bis.2 — Embeddings: what a vector captures (and what it doesn't)

1. **The same model is mandatory for index and query** — otherwise the vectors live in unaligned spaces and similarity is noise. The #1 cause of silently broken RAG.
2. **Context rot:** Chroma's research (Jul 2025, 18 models including GPT-4.1, Claude 4, Gemini 2.5) shows that retrieval degrades as context length grows, even on simple tasks. Stuffing the answer into the middle of a wall of text makes it less retrievable.
3. **An average vector is not a good vector** — multiple distinct concepts in a chunk = a diffuse embedding.

#### 2-bis.3 — Chunking: the most underrated decision (and the data that contradicts common sense)

Common sense says "semantic chunking is best". The benchmarks say the opposite, and the divergence is instructive:
- **Vecta Benchmark (Feb 2026):** recursive splitting at 512 tokens first at **69%**; semantic chunking at **54%** (fragments of ~43 tokens). The author: the conversation about chunking has been *"dominated by theory rather than measurement"*.
- **MDPI Bioengineering (Nov 2025):** in the clinical domain, adaptive chunking 87% vs 13-50% for fixed-size (p=0.001).
- **arXiv 2506.17277 (chemistry):** recursive up to 45% more domain-weighted precision than the best fixed-span.
- **arXiv 2512.05411 (enterprise):** on well-structured formal documentation, naive chunking beats semantic and recursive.
- **arXiv 2506.06339 (Arabic):** sentence-aware the best, semantic *consistently worse*.

**They don't reconcile — and that's the point.** There is no universally optimal chunking strategy; it depends on document structure and query type. The defensible robust default: **recursive splitting at 400-512 tokens with 10-20% overlap**, when you have no specific reason to do otherwise.

**Why should a GEO developer care, even if they don't control the engine's chunker?** Because you control *how well-splittable* the page is. Sharp semantic boundaries (clear headings, one idea per section, self-contained answers) produce coherent chunks under any strategy. **Content structure is the chunking you can control.** (See also the tension with Google's official position in 6.2.)

#### 2-bis.4 — Re-ranking: the stage where what gets cited is decided

Real retrieval is almost always **two-stage**:
- **Stage 1 — Recall (bi-encoder/BM25/hybrid):** a wide net, 20-150 fast candidates.
- **Stage 2 — Precision (cross-encoder):** re-evaluates each query-chunk pair *together* (`[CLS] query [SEP] document [SEP]`), reorders, keeps the top 3-8.

Operational figures: a lightweight cross-encoder (ms-marco-MiniLM-L-6-v2) ~50ms/20 docs; Cohere Rerank ~200ms; LLM reranker 1-3s. Typical gain **+5-15 nDCG@10 points** or **+10-25% accuracy**. Default: top-20→50, rerank, pass top-3→8. Beyond 50 candidates *"adds latency without meaningfully improving recall"*.

**GEO implication:** the cross-encoder rewards **direct, query-specific relevance** — not keyword density, not length, not domain authority in itself. It is the mechanical foundation of why "answer-first" writing works: it isn't style, it's alignment with the cross-encoder.

#### 2-bis.5 — From the retrieval model to markup rules

| Mechanical fact | Operational rule for content |
|---|---|
| Dense compresses everything into one vector | One idea per section; don't mix 3 themes in a paragraph |
| Sparse rewards exact match | Include exact terms/codes/names, not just synonyms |
| Hybrid beats the single methods | Clear concepts *and* precise terminology together |
| Context rot | Answer up top, not buried mid-page |
| Self-contained chunks = robust retrieval | Each section should make sense read on its own |
| Clear headings = sharp chunk boundaries | Semantic HTML: `<h2>` as a question + answer below |
| Cross-encoder rewards direct relevance | Answer-first: the answer in the first 40-60 tokens |
| Re-ranking cuts to top 3-8 | You need to be the *most* relevant chunk, not just relevant |

### 2-ter. Granular reverse-engineering: how each engine builds queries and selects sources

This section documents, engine by engine, what is *verifiable* (official documentation, APIs, honeypot logs, decompilation), separating it from what is *reconstructed* or *plausible*. It is the most volatile area of the document: the pipelines change from one model update to the next.

#### 2-ter.1 — ChatGPT Search: the `web.run` tool

The most detailed source is the RESONEO/Meteoria study (Olivier de Segonzac, May 2026), which decompiled the mobile app, analysed the web client, sniffed network packets and progressively reconstructed the system prompt. Verified findings:

- **The internal search engine is called `web.run`.** Before GPT-5.3 it sent compact textual commands separated by pipes (`fast|query|recency`); after 5.3 it sends structured JSON objects with typed parameters — an architecture change, not just a format change.
- **The tool supports 12 operations** (up from 4): `search_query`, `open`, `find`, `click`, `screenshot`, `product_query` and specialised widgets (sports, finance, weather), plus a separate `genui` system.
- **Query fan-out:** GPT-5.4 can chain from 5 to over 10 search rounds per answer, refining the queries based on previous results; GPT-5.3 Instant typically runs 2-3. GPT-5.4 Thinking uses `site:` operators to restrict the search to trusted domains.
- **Unprecedented product fan-out (`browse_rewritten_queries`):** on product queries, ChatGPT first runs a rewrite to build the candidate list, then launches a *separate shopping search for each individual product*, retrieving specs, reviews and prices one at a time.
- **Who actually fetches the pages:** the honeypot experiment confirmed that during a conversation it is **`ChatGPT-User`** (not OAI-SearchBot) that fetches the page content. OpenAI describes OAI-SearchBot as the agent that builds the index, but in practice the model relies on **third-party scraping APIs** for the search results, then sends ChatGPT-User to retrieve the content of the selected URLs. Google tracking markers (`strlid`) in product URLs and SearchAPI ID matches reveal a backend that relies on third-party search providers — and on Google behind the scenes.
- **Source selection — the "Bigfoot Effect":** on 4 March 2026 OpenAI changed the default model (from GPT-4o/5.2 to 5.3 Instant) and the unique domains cited per answer **fell from 19 to 15 (-20%+)**, the unique URLs from 24 to 19, without re-fetching. The URLs-per-domain ratio stayed stable (1.26): fewer distinct sites, not fewer pages per site. It reflects a structural shift towards high-authority sources.
- **Reddit** is the only domain exempted from the copyright word limits in the reconstructed system prompt; there is a "verbosity score" on a 1-10 scale and an advertising policy by subscription tier.
- **The strategic point:** the study distinguishes **parametric visibility** (what the model learned in training, with search disabled — the LLM equivalent of E-E-A-T, stable, shaped by press coverage, Wikipedia, authoritative sites) from **dynamic visibility** (what it retrieves in real time, volatile, model-dependent). The key link: *"the model formulates web queries targeting sources it already knows. A brand absent from the parametric memory won't even be considered as a search candidate."* Being unknown to the model = invisible before the search even starts.

**Caveat:** the same prompt on 5.2/5.3/5.4 produces different fan-out, sources and passages. Citation in ChatGPT is not reproducible like a Google ranking: it must be tested model by model.

#### 2-ter.2 — Google Gemini / AI Mode / AI Overviews: the documented query fan-out

Unlike ChatGPT, here there is **official documentation** that exposes part of the mechanics, through Gemini's grounding API:

- **Query fan-out confirmed by the API.** The grounded API response returns a `groundingMetadata` object containing `webSearchQueries` (the array of queries actually executed — e.g. for "who won Euro 2024" it generates `["UEFA Euro 2024 winner", "who won euro 2024"]`), `groundingChunks` (the retrieved sources, with uri and title) and `groundingSupports` (the mapping of **text segment → source chunk**, with `startIndex`/`endIndex` character by character). This is Gemini's citation mechanism exposed in the open: every sentence of the answer is anchored to specific chunks.
- **Tool-native model.** From the Gemini 2.5 technical report: Gemini 2.0 was *"the first family of models trained to natively call tools like Google Search"*, formulating precise queries. Gemini 2.5 *"interleaves search capabilities with internal thought processes"* for multi-hop queries, and learned to *"issue additional, detailed follow-up queries"* to expand and verify. This is not an LLM that "occasionally searches": search is interleaved with reasoning.
- **Scale:** by mid-2025 the models powered roughly 1.5 billion monthly users in AI Overviews and ~400 million in the Gemini app (figure from the 2.5 report); by late 2025/early 2026 the official Alphabet numbers rise to **2 billion** users for AI Overviews and **750 million** MAU for the Gemini app (Q4 2025) — growth is one of the indicators of how quickly the paradigm is spreading.
- **Custom model:** Google stated that AI Mode uses a *"custom version of Gemini"* with fan-out. Fan-out decomposes the query into many parallel sub-queries (synthetic and implicit) and is the reason pages not in the top-10 get cited: they answer one sub-query of the fan-out.
- **Index:** Google's own web index + Knowledge Graph + Shopping Graph. Grounding uses `vertexaisearch.cloud.google.com` endpoints as redirects for the sources.

**Specific GEO consequence:** optimising for Gemini means covering the **tree of sub-questions** of a topic, not a single keyword. The `groundingSupports` structure rewards content in which a sentence answers in a self-contained, anchorable way.

#### 2-ter.3 — Perplexity / Sonar: three-layer reranking

Perplexity is the most transparent in its output (citations always visible) but proprietary in its infrastructure. Picture reconstructed from independent analyses (Metehan Yeşilyurt, August 2025, cited by Search Engine Land; RankStudio; Sonar API documentation):

- **Sonar** is Perplexity's proprietary model, built on open Llama architectures (in February 2025 on Llama 3.3); at the product level it is a **multi-model** system that at runtime selects the best model per mode (search/reasoning/research) and allows switching between native and partner models (OpenAI, Anthropic).
- **Pipeline:** (1) **Query decomposition** — the prompt is broken down into multiple sub-queries; (2) **retrieval** from a proprietary index built by a headless crawler (PerplexityBot) supplemented by real-time fetch (Perplexity-User); (3) **reranking**; (4) **synthesis** with inline citations.
- **Three-layer reranking** (the most technically detailed part to have emerged publicly): **Layer 1** initial retrieval of candidates with classic relevance scoring; **Layer 2** ranking by conventional authority and relevance signals; **Layer 3** ML reranking that — according to this analysis — structurally favours **earned media from Tier-1 publications**: a citation on TechCrunch or Forbes works as an externally verified authority signal. *(To be treated as a credible independent analysis but not officially confirmed.)*
- **Citation is a "two-step dance":** (1) inclusion of the document in the retrieval set, (2) selection of the paragraph for the citation. You can win both and get the link in the answer box.
- **Freshness as a dominant factor:** in time-series tests, an article "updated 2 hours ago" was cited **38% more** than its identical twin dated a month earlier. The stale twin rarely disappeared from the retrieval set, but was **demoted in the synthesis**. Even small edits reset the freshness signal. Sonar treats dated pages as a higher hallucination risk.
- **PDF:** Perplexity tends to prefer well-structured public PDFs, which often beat HTML in citation thanks to structural cleanliness. *(SEO vendor claim, plausible but not confirmed by Perplexity.)*
- **Scale:** ~780 million queries in May 2025, +20% month over month (Srinivas statement, Bloomberg Tech), with a stated goal of 1 billion/week.

#### 2-ter.4 — Claude (Anthropic): sentence-level citation

For the engine you are interacting with right now, the public details are in Anthropic's official documentation:

- **Retrieval:** with web search active, Claude queries a search provider (Profound analyses indicate strong overlap with Brave Search) and retrieves content from the result URLs. There is also a web fetch tool that retrieves specific URLs provided by the user or surfaced from the results.
- **Sentence-level citational chunking:** the web search and citations tool documentation specifies that documents are split into chunks at **sentence** granularity (for plain text and PDF). The output returns `cited_text` blocks, with `title` and `url`. Consequence: the citation is anchored to single sentences, so **a well-built, self-contained sentence is the minimal citable unit** — the most extreme case of the principle "the chunk is the unit of competition".
- **Three-tier bots:** ClaudeBot (training), Claude-User (fetch on user request), Claude-SearchBot (indexing for search). All declare that they respect robots.txt.

#### 2-ter.5 — Microsoft Copilot: Prometheus, Bing Orchestrator and the Webmaster Guidelines

Copilot deserves separate treatment because it is the only major engine that has **codified GEO in its own official policy**, and because its infrastructure (the Bing index) is also ChatGPT's historical backend.

- **Architecture — Prometheus (OFFICIAL FACT).** Microsoft describes Prometheus as a model that combines *"the fresh and comprehensive Bing index, ranking, and answers results with the creative reasoning capabilities of … GPT models"*. The **Bing Orchestrator** component *"generate[s] a set of internal queries iteratively"*: this is the **internal query fan-out** mechanism, distinct from the text the user typed. The model is *"grounded by Bing data, via the Bing Orchestrator"* — grounding is what anchors the answer to the retrieved sources.
- **Citations.** Prometheus *"integrate[s] citations into sentences in the Chat answer"* with numbered references [1][2] linked to the source page; consolidated source panels and publisher names are shown (UI updated from November 2025).
- **Bing Webmaster Guidelines (rewrite of 27 February 2026) — OFFICIAL FACT.** Microsoft rewrote the guidelines, treating *"grounding results and citations"* as an **eligibility outcome separate** from traditional ranking, and introducing **GEO as an official optimization category** (the first engine to do so in policy). Verified directives: **NOARCHIVE** prevents the content from being used in Copilot answers; **NOCACHE** limits Copilot to using only URL, title and snippet (Microsoft **advises against it** on pages you want to be cited); the **data-snippet** attribute lets you specify which text Bing may show or cite (paragraph-level control).
- **Relationship with ChatGPT (CAUTIOUS ATTRIBUTION).** The Seer Interactive study (6 February 2025) found that **87% of SearchGPT citations coincide with Bing's top 20 organic results** (versus 56% for Google). It is an **independent coincidence measurement**, not a declared retrieval share; the often-cited "~92% via Bing API" figure is an **unconfirmed vendor claim**. Moreover, OpenAI is building its own index: the correlation with Bing could de-correlate over time.
- **IndexNow (OFFICIAL FACT).** A protocol that notifies Bing (and participating engines) of every content addition/modification/removal; **Google does not support it** (February 2026).
- **Transparency.** Bing Webmaster Tools' **AI Performance Report** (public preview from February 2026) shows citation count, cited URLs and a sample of the grounding queries (which *"are a sample"* and *"not necessarily the exact queries typed"*).
- **Copilot Search vs Microsoft 365 Copilot.** The consumer version is grounded on Bing's public web index; the enterprise version (M365 Copilot) is grounded on the tenant via Microsoft Graph + Semantic Index, scoped to the user's permissions.

**GEO consequence:** for Copilot, indexing on Bing and correct handling of the directives (avoiding NOARCHIVE/NOCACHE on pages you want cited) are explicit technical prerequisites — the only case where the "what to do" is written in black and white by the producer.

#### 2-ter.6 — Comparative summary table

| Dimension | ChatGPT Search | Gemini / AI Mode | Perplexity / Sonar | Copilot | Claude |
|---|---|---|---|---|---|
| Index/result source | Third-party scraping API (+ Google traces) | Google web index + KG + Shopping | Own index (PerplexityBot) + realtime | Bing index (Prometheus) | External provider (Brave overlap) |
| Realtime retrieval bot | ChatGPT-User | Google-Extended / Search infrastructure | Perplexity-User | bingbot / Bing infrastructure | Claude-User / Claude-SearchBot |
| Query fan-out | Yes (`web.run`, 2-10+ rounds) | Yes (documented via API) | Yes (query decomposition) | Yes (Bing Orchestrator) | Yes (multiple searches) |
| Exposed citation | Inline, varies by model | `groundingSupports` sentence→chunk | Inline always, paragraph | Numbered [1][2] + source panel | Inline always, sentence (`cited_text`) |
| Distinctive factor | Concentration on a few authoritative domains (Bigfoot) | Sub-question tree coverage | Extreme freshness, Tier-1 earned media | GEO in official policy (Webmaster Guidelines) | Sentence granularity |
| Mechanical transparency | Low (reverse-engineering) | Medium (official API) | Low-medium (independent analyses) | High (docs + AI Performance Report) | Medium (official docs) |
| Citation reproducibility | Low (changes by model) | Medium | Medium-low (volatile on freshness) | Medium-high | Medium |

### 3. What makes content citable (evidence-based GEO tactics)

**Tactics with empirical support:**
- **Statistics and specific data** (GEO paper: Statistics Addition +31%).
- **Source citations and quotations** (GEO paper: Quotation Addition +41%, Cite Sources +28%).
- **Freshness** (strong for Perplexity and news/trend queries; see 2-ter.3).
- **"Answer-first" structure** with a question heading and a direct answer in the first 40-60 tokens (alignment with the cross-encoder, see 2-bis.4).
- **Authority/E-E-A-T** and third-party citations; **non-commodity content** with first-hand experience (confirmed by the 2026 Google guide).
- **Brand mentions:** a Previsible study on 1.96M sessions indicates brand search volume as the strongest predictor of AI citations (correlation 0.334), more than backlinks.

*(Caveat: vendor claims such as "data-rich content cited 2.7x more" or "FCP <0.4s = 6.7 citations" circulate but are not verifiable against a named primary source — see Section 6.5.)*

**Correlation with traditional ranking (conflicting data):** Ahrefs in July 2025 found 76% overlap between AIO citations and the top-10; in January 2026 only 38% (partly due to better detection, partly to the fan-out). Semrush: ~90% of ChatGPT citations from URLs outside the Google top-20. Ranking helps but is not a necessary condition.

**robots.txt for AI crawlers:** the 2024 "block all AI bots" strategy is counterproductive. Distinguish **training** bots (GPTBot, ClaudeBot, Google-Extended) from **retrieval/search** bots (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, PerplexityBot). Blocking the latter removes the site from AI citations.

*(For llms.txt, schema and chunking as tactics — all downgraded or debunked — see the critical Section 6.)*

### 4. The Italian and European market (general picture)

#### Adoption
- **Eurostat 2025:** use of GenAI tools in Italy at **20%**, below the EU average of 33% and far from Norway (56%) and Denmark (48%). It reflects the European north-south divide.
- **ChatGPT in Europe:** average monthly active users from 11.2 to 41.3 million by March 2025 (~270%).
- Italy was the **first country in the world** to temporarily block ChatGPT (March 2023).

#### AI Overviews timing in Europe
They arrived in Italy on **26 March 2025** (along with Austria, Belgium, Germany, Ireland, Poland, Portugal, Spain, Switzerland), ~10 months after the USA, in Italian and on Gemini 2.0. They trigger for long-tail informational queries. AI Mode in Italian did not appear to be fully launched as of mid-2026.

*(For the detailed regulatory framework — TDM/opt-out, AI Act, FIEG-AGCOM case, Garante — see Section 4-ter.)*

#### The global landscape: the Chinese AI engines
The fragmentation of generative engines is not a purely Western phenomenon. For those with a Chinese audience (or those who want to understand the real scale of the phenomenon), the Chinese market is the world's second pole, with dynamics of its own and a more crowded competition than that of the USA:

- **Baidu ERNIE.** ERNIE 4.5 was **open-sourced on 30 June 2025** (10 MoE variants up to 424B parameters, Apache 2.0 licence). ERNIE Assistant reached **202 million MAU by December 2025** (official Baidu figure). On the revenue front, in Q4 2025 the **subscription revenues of the AI accelerator infrastructure (AI Cloud Infra) grew +143% year over year**, accelerating from +128% in Q3; the call volume of the AI search API grew by over +110% quarter over quarter (source: Baidu's communiqué and earnings call of 26 February 2026).
- **DeepSeek.** Open-source, cost-efficient models that shook the market in early 2025; by mid-2025 one estimate (a snapshot, from an unnamed research firm) attributed to DeepSeek ~34% of the developer API share versus ~18% for ERNIE. Integrated into Baidu Search (deep-search since February 2025) and into Zhihu.
- **The others.** According to QuestMobile data (via Caixin), in **March 2026 Doubao (ByteDance) is in the lead with ~345 million MAU**, ahead of Qwen (Alibaba, ~166M) and DeepSeek (~127M), with Tencent Yuanbao among the top four; Doubao has overtaken Baidu's ERNIE Bot. The combined MAU of the main players exceed 900 million.

**Implication for an Italian freelancer:** these engines are **context**, not daily operational action. The relevant point is structural — the GEO logic (retrieval, grounding, citations, query fan-out) is essentially the same everywhere, and fragmentation (more engines, no single dominator) is a global trend, not a Western anomaly. *(Note: the MAU counts of the Chinese engines diverge greatly across sources and metrics; they should be treated as estimates, always with source and date.)*

### 4-bis. Measurement methodology: how to test GEO without fooling yourself

This is the section that separates serious work from theatre. The thesis: **visibility in AI search is a distribution, not a score.** Treating it like Google rank tracking is the fundamental methodological error from which almost all the unreliable numbers in circulation derive.

#### 4-bis.1 — Why a single measurement is useless (with the numbers)

The most rigorous figure available comes from the paper **"Don't Measure Once: Measuring Visibility in AI Search (GEO)"** (Schulte et al., arXiv:2604.07585, 10 April 2026), which measured 4 engines × 8 prompts × 3 campaigns with 10 runs each (1,216-1,726 series per-brand). The results on estimation error are unequivocal:

- **A single run has a standard error of 0.370** (a 95% confidence interval of ±0.724; Table 16, Appendix J of the paper). Translated: a true citation rate of 50% can appear **anywhere between −22% and +122%** in a nominal 95% confidence interval (clipped to [0,1] in practice). A single run is *"essentially uninformative"* — statistically indistinguishable from noise.
- **At 7 runs the standard error drops to 0.081** (95% CI ±0.158) and at **8 runs to 0.062** (±0.121) — enough to distinguish large differences (e.g. a brand cited at 80% vs one at 50%).
- The source overlap between two consecutive days can fall in the **34-42%** range: a third to two-fifths of the cited sources change from one day to the next for the very same prompt.

A second paper (Sielinski, March 2026) converges: identical queries return different sources between runs, so visibility must be treated as an **estimate of an underlying distribution**, not as a fixed value. Citation distributions follow a **power law** with strong run-to-run variability: 95% of ChatGPT Shopping titles appear in fewer than 30% of the runs of the same prompt.

**Direct operational consequence:** anyone who shows you an "AI Visibility Score" from a screenshot or a single query is selling you noise with the appearance of a signal. The minimum defensible floor is **10+ runs per prompt** before treating a rate as stable (it is the threshold Profound uses in its shopping methodology).

#### 4-bis.2 — Citation drift: volatility over time

Volatility is not only run-to-run, it is also temporal and must be distinguished:

- **Monthly citation drift:** measured as the % of domains present in July but absent in June for the same prompts, sits at **40-60%** (Profound analysis). That is, about half the cited domains change in a month.
- **Semi-annual citation drift:** rises to **70-90%** comparing January with July — roughly linear growth. BrightEdge reports that **70% of cited domains churn within six months**.
- **Platform shocks:** the share of Reddit citations in ChatGPT collapsed from 60% to 10% **in a few weeks** in September 2025 (a 13-week Semrush study). The model change of 4 March 2026 cut cited domains by 20% overnight.

This imposes a rule: **measure with windows, not with snapshots.** A monthly measurement misses material shifts; the converging advice is weekly for strategic queries.

#### 4-bis.3 — A valid GEO test protocol (replicable)

Putting the literature together, a minimum defensible protocol for testing whether a GEO change works:

1. **Define 20-30 prompts from a real buyer**, not vanity brand queries ("what is the best X for Y", not "tell me about [my brand]").
2. **Run across multiple engines** (ChatGPT, Perplexity, Google AI Overviews/AI Mode, Gemini) — visibility in one does not predict the others.
3. **Repeat each prompt at least 7-10 times, spread across multiple days** (not 10 times in the same minute: you would capture only the intra-session noise, not the drift).
4. **Log three things per run:** whether you appeared, which publication was cited, which competitor was named in your place.
5. **Compute bootstrap confidence intervals** on the detection rate per brand, not bare averages.
6. **Report per-engine** (aggregate cross-engine reporting hides the patterns: each engine has a different algorithm).
7. **To test a change:** measure the baseline over a window (e.g. 2 weeks), apply the change, wait for the re-crawl, measure again over an equivalent window. Compare distributions, not points. Use a **control group** (unmodified pages) to separate the effect of your change from the background drift — without a control you can attribute nothing.

#### 4-bis.4 — Metrics that matter (and one to remove from the dashboard)

From Nick Lafferty's reference (2026) and the cited studies, the metrics with statistical sense:

- **Citation Share per engine:** the share of your citations of the total for a cluster of prompts. The central metric.
- **Time-to-First-Citation (TTFC):** days between publication and the first observed citation. It should be reported as a **distribution (median, P75, P90), never as an average** (the distribution is skewed).
- **Inline Brand Hyperlink Share:** the share of answers in which you get a clickable link, not just a mention. It gained weight after the ChatGPT change of 7 May 2026 tripled B2B SaaS referrals.
- **Co-citation Rate:** how often you appear alongside specific competitors.
- **Citation Rank Stability:** the consistency of your citation rank across repeated runs — the metric of the Schulte paper, the one almost every dashboard skips.

**A metric to remove if you sell software/services:** the **Shopping Trigger Rate**. Across ~2 million prompts run 10+ times, 79% never triggered Shopping in any run and only ~6% trigger reliably; the prompt category alone predicts trigger behaviour with 95-97% accuracy. Spending measurement budget there is wasted: better to invest it in Citation Share.

#### 4-bis.5 — How to replicate the GEO paper yourself

The original GEO paper (Aggarwal et al.) is replicable at modest cost, and it is the most instructive experiment to run in order not to trust blindly:

1. Take 10-20 of your target pages/chunks and create two variants: baseline and "treated" (e.g. + cited statistics, or + quotations from authoritative sources).
2. Build a set of 30-50 realistic queries for which those pages should compete.
3. Submit the queries to a generative engine with search active, 7-10 runs per query per variant, alternating the order of presentation to avoid position bias.
4. Measure the paper's metric — **Position-Adjusted Word Count** (words attributed to your source, weighted by position in the answer) — in addition to simple presence/absence.
5. Compare the baseline vs treated distributions with a non-parametric test (Mann-Whitney), given the non-normality.

**Expectation calibrated from the paper's data:** real but modest, domain-dependent improvements (on the order of +20-40% on the metric, not "10x"), with Statistics and Quotation as the strongest levers and greater benefit for pages initially at a low ranking. If your test shows +300%, it is almost certainly noise from too small a sample: go back to point 3 and increase the runs.

### 4-ter. EU/Italy legal deep-dive: the framework that constrains GEO in Europe

This section matters for an Italian freelancer more than it seems: choices of `robots.txt`, of licensing and of handling clients' content have concrete legal implications under EU law, which is the most stringent in the world on AI and copyright.

#### 4-ter.1 — The TDM exception and the art. 4 CDSM opt-out: the legal linchpin

The foundation of all commercial AI training in Europe is **Directive (EU) 2019/790 (CDSM)**, in particular:

- **Art. 3** — TDM exception for *scientific purposes*, reserved for research organisations and cultural heritage institutions. It does not cover commercial AI.
- **Art. 4** — general TDM exception (commercial and other purposes). It became, as the doctrine notes, *"the cornerstone of commercial AI training in the EU"*, despite having been added in the final stages of the legislative process without an impact assessment on GenAI.

The key mechanism is the **opt-out of art. 4(3)**: the TDM exception applies *on condition that* the use has not been **expressly reserved by the rightholders in an appropriate manner, "for instance by machine-readable means"** for content made publicly available online (Recital 18). In practice: **TDM on protected material is permitted by default, except where there is a technically implemented opt-out.** By declaring the opt-out, the rightholder neutralises the TDM permission and restores the exclusive right to prohibit use for training.

**The bridge with the AI Act:** art. 53(1)(c) of the AI Act obliges GPAI model providers to put in place a policy to comply with EU copyright law and *"identify and respect, including through state-of-the-art technologies, the rights reservations expressed pursuant to art. 4(3)"*. Recital 106 explicitly establishes a **"Brussels effect"**: the obligation applies to any provider that places a GPAI model on the EU market *"regardless of the jurisdiction in which the acts of training take place"*. Translated: even a model trained in the USA, if offered in the EU, must respect European opt-outs.

#### 4-ter.2 — The unresolved problem: what makes an opt-out "valid"

Here lies the most relevant and still-open practical issue. The directive **does not prescribe a single technical standard**, and national case law is divergent:

- **Kneschke v. LAION** (Hamburg Regional Court, 27 September 2024): held that the construction of the image dataset was covered by the German equivalent of art. 3 (a preparatory act of research), but raised doubts about art. 4 for downstream commercial exploitation. In a subsequent ruling (Hamburg) it was held that an opt-out expressed in **"natural language"** — for example in a site's terms of use — may qualify as machine-readable.
- **DPG Media v. HowardsHome** (Amsterdam District Court, late 2024): art. 4(3) does not impose a single technical standard, but requires that the reservation be *"practically detectable and processable by automated systems"*.
- The direction of the two decisions is *"markedly different"*: does an opt-out in natural language in the ToS satisfy the Dutch requirement of automatic processability? Uncertain. For the professional, this means: **relying solely on a clause in the terms of use is risky; a technical signal is also needed** (robots.txt, metadata, headers).

**Lawful access as a further filter** (Synodinou-Vrakas, November 2025): datasets built by indiscriminate scraping may include works *publicly accessible but not "lawfully accessed"*, pushing them outside the protection of the TDM exception. An argument that strengthens the rightholders' position.

#### 4-ter.3 — The EU Parliament's push to reform the opt-out

On this subject, the European Parliament produced two distinct documents within the own-initiative procedure **2025/2058(INI)** *"Copyright and generative artificial intelligence – opportunities and challenges"* (JURI committee, rapporteur **Axel Voss**), not to be confused: (1) the **study commissioned by the JURI committee** — *"Generative AI and Copyright – Training, Creation, Regulation"*, **PE 774095**, by Prof. Nicola Lucchi, published on **9 July 2025** — which concludes that large-scale AI training *"far exceeds the scope of the current TDM exceptions"*; and (2) the **draft report / Motion for a resolution** — **PE775.433, of 27 June 2025** — which calls for clearer rules or a dedicated exception for GenAI, full transparency on training data and a remuneration obligation for rightholders. The resolution was then adopted in plenary on **10 March 2026** (T10-0066/2026). The majority nonetheless considers a new legislative instrument **not necessary** "at this stage", favouring the implementation of the existing framework — a sign of an unresolved political tension.

#### 4-ter.4 — The Italian case: FIEG vs Google, the DSA and the opt-out dilemma

Italy is one of the hottest fronts in Europe:

- **15 October 2025:** **FIEG** (the Italian Federation of Newspaper Publishers) files a formal complaint with **AGCOM** (in its capacity as national Digital Services Coordinator) against **AI Overview and AI Mode**, calling them *"traffic killers"*. The legal charge is not copyright but a **DSA violation**: AI Overview and AI Mode (with query fan-out and links moved to a side column) would constitute unfair competition, a structural reduction of visibility and revenue, and *"a systemic risk to the economic sustainability of the entire information ecosystem"*. The DSA imposes on VLOPs/VLOSEs (a category that includes Google) obligations of algorithmic transparency and non-discrimination of sources.
- **29 April 2026 (an AGCOM act, distinct from and subsequent to the complaint):** following hearings with Google, FIEG and FISC, AGCOM — in its role as national Digital Services Coordinator — decided to **transmit to the European Commission, pursuant to Article 65 of the DSA, a request to assess** Google's AI Overviews and AI Mode services in relation to Articles 27, 34 and 35 DSA (systemic risks to pluralism and freedom of information; transparency of recommender systems). Communiqué of 30 April 2026; decision taken with the **dissenting vote of Commissioner Elisa Giomi**. This is a **referral** aimed at the possible opening of an investigation by the Commission — not an autonomous sanctioning proceeding by AGCOM (competence over VLOPs/VLOSEs remains with the Commission). Among other things, FIEG asks for *"effective respect of opt-out mechanisms, without the risk of penalties or reduced visibility of content"*.

This last point reveals **the central dilemma of GEO in Europe, which is also a technical-strategic dilemma for your clients:**

> Exercising the opt-out (blocking AI crawlers) protects copyright but **removes the content from generative answers**, zeroing out GEO visibility. Not exercising it exposes the content to exploitation without compensation. Publishers ask to be able to opt out *without* losing visibility — but technically, today, the two things are largely the same lever.

For an SME/e-commerce site (not a publisher) the rational choice is almost always **not** to opt out of *retrieval* bots (you want to be cited), while opting out of *training* bots is a matter of principle at almost no cost in terms of immediate visibility. But they must be distinguished: blocking GPTBot (training) does not remove you from ChatGPT Search; blocking OAI-SearchBot/ChatGPT-User does.

#### 4-ter.5 — Garante Privacy and GDPR: the Italian precedent

On the personal-data front (distinct from copyright):

- The **Italian Garante** was the first regulator in the world to restrict ChatGPT (31 March 2023, Decision 112/2023): lack of a privacy notice, absence of a legal basis for training, inadequate protection of minors. Reactivation on 28 April 2023 after corrective measures (privacy notice, the right to object also for non-users, age verification).
- **The 2024 fine (Decision 755):** **15 million euros**. OpenAI appeals and the **Court of Rome annuls the fine** (judgment no. 4153/2026, filed on 18 March 2026), after which the decision was removed from the Garante's website. *(Note: the reasons for the judgment did not appear to be public as of mid-2026; verify the exact date of adoption of the sanctioning decision before publication, reported by some sources as 20 December 2024.)*

GEO relevance: the GDPR constrains how the personal data present in content may be processed by AI engines, and the "right to object" extended to non-users is a precedent of a privacy-based opt-out parallel to the copyright one.

#### 4-ter.6 — Operational timeline of the AI Act (for content publishers)

- **1 August 2024:** entry into force (Reg. EU 2024/1689).
- **2 August 2025:** the obligations for GPAI models become applicable (including copyright policies and a "sufficiently detailed summary" of training data). The GPAI Code of Practice published (Transparency, Copyright, Safety chapters).
- **2 August 2026:** full applicability, including transparency obligations (labelling of AI-generated content and deepfakes).

For a freelancer: the direct obligations fall on the model *providers*, not on those who publish sites. But the labelling of AI-generated content (your clients') and the correct handling of opt-out/licensing become part of professional due diligence.

### 5. Practical implications for GEO

#### What remains valid from classic SEO
Crawlability and indexing (extended to Bing for ChatGPT and to AI retrieval bots); authority/E-E-A-T; semantic HTML and speed; server-side rendering (many AI bots fetch but do not execute JS).

#### What is new in GEO
Optimization at the chunk/passage level (not the page); topical breadth for query fan-out (pillar + cluster); entity/brand building; diversification of surfaces (YouTube, Reddit); indexing on Bing.

#### Operational recommendations in three phases

**Phase 1 — Technical foundations (immediate):**
1. Verify indexing on **Bing Webmaster Tools** (a prerequisite for ChatGPT). Use **IndexNow**.
2. Audit the **robots.txt**: allow the retrieval bots (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User) even while blocking training. Do not accidentally block the citation bots.
3. Server-side render the key content and use clean semantic HTML.

**Phase 2 — Content (1-3 months):**
4. Rewrite the top pages in **answer-first** format: a question heading, a direct answer in the first 40-60 tokens.
5. Insert **cited statistics** and **quotations** (the levers with the most evidence).
6. Update key content quarterly (freshness, especially for Perplexity).
7. Structure into **self-contained chunks** that cover the sub-questions (for the fan-out), a pillar + cluster architecture. (NB: write well, do not split artificially — see 6.2.)

**Phase 3 — Authority and measurement (3-6 months):**
8. Build **brand mentions** and third-party citations (G2/Trustpilot, digital PR, YouTube, Reddit); Wikipedia for entity grounding where relevant.
9. Implement an AI tracking tool (Otterly entry, Peec AI for European multilingual, Profound enterprise) and monitor **trends with repeated runs** (see 4-bis), not snapshots.

**Thresholds that change the recommendations:**
- If traffic from AI search exceeds 1-2% (today typically <1% but converting better than organic), increase the GEO investment.
- If the overlap between AI citations and organic ranking is low, prioritise chunking-friendliness and authority.
- For Italy, monitor the launch of **AI Mode in Italian** and the evolution of the FIEG-AGCOM case and the EU copyright framework.

### 6. Critical / anti-hype section: what to debunk in the current GEO discourse

Consistent with a devil's-advocate approach, this section isolates the GEO claims that circulate as truths but have weak, no or contrary evidence. The criterion is a single one: **primary source or replicable experiment vs repetition among influencers.**

#### 6.1 — The document that changes the picture: Google debunks 5 myths (15 May 2026)

On **15 May 2026** Google Search Central published the official guide *"Optimizing your website for generative AI features on Google Search"* (announced by John Mueller, a new "Generative AI fundamentals" section). It is Google's most explicit on-record statement on what works and what doesn't for AI Overviews and AI Mode. The underlying thesis: **"AEO and GEO are still SEO"**, because the AI features run on the same ranking systems as classic Search. Google explicitly classifies as **unnecessary**:

1. **`llms.txt` files and special markup:** *"You don't need to create new machine readable files, AI text files, markup, or Markdown to appear in generative AI search."* Google can discover and index these files, but they receive no special treatment.
2. **Content chunking:** there is no requirement to split content into small pieces; Google's systems *"are able to understand the nuance of multiple topics on a page and show the relevant piece to users."* Danny Sullivan (January 2026) had already reported that Google's engineers advise against chunking.
3. **AI-specific rewrites:** the AI systems understand synonyms and general meanings; there is no need to rewrite for the AI.
4. **Inauthentic mentions:** link-building and artificial mentions do not fool the AI systems.
5. **Excessive use of schema/structured data:** it is not required to generate AI answers.

What Google says to do *instead*: solid SEO (indexable, crawlable, good page experience), **non-commodity content** with unique perspectives and first-hand experience, multimodal assets.

To reinforce its position, on **5 June 2026** Google published *"Google Search's guidance on using third-party SEO tools, services, and advice"* and updated the historical page *"Do you need an SEO?"*, explicitly naming **AEO and GEO as service categories** offered by consultants and agencies. The message is consistent with the 15 May guide: Google **legitimises the discipline** (it acknowledges that GEO/AEO services exist) but **narrows its perimeter** by reiterating that it remains "still SEO" and urging caution towards those who promise shortcuts or guarantees of ranking in AI answers.

#### 6.2 — The honest tension on chunking (and how to resolve it)

There is an apparent contradiction between Section 2-bis (where I argue that structure/chunkability matters) and Google saying "chunking isn't needed". It must be confronted, not hidden:

- **Google is right on a specific point:** you don't have to *physically* split the page into micro-files or micro-pages for the AI, and you don't have to rewrite into "AI format". Its retrieval systems do the chunking on their side and understand long multi-topic pages.
- **But "no need to do manual chunking" ≠ "structure doesn't matter".** RAG research (Section 2-bis.3) shows that sharp, self-contained chunks improve retrieval *all else being equal*. The difference is that you get those chunks **by writing well** (clear headings, one idea per section, direct answers), not by artificially manipulating the structure for the bot. In other words: Google debunks chunking-as-a-hack, not structural clarity as a good practice.
- **A crucial distinction so as not to err:** Google's guidance applies to *Google* (AI Overviews/AI Mode, which run on Search ranking). For ChatGPT, Perplexity and Claude — which have their own, different RAG pipelines — the evidence on the value of structure remains more relevant. Generalising "chunking is dead" from a Google statement to all engines is exactly the kind of over-extension that this critical section aims to avoid.

**Verdict:** stop selling/buying "chunking optimization" as a standalone technical service. Keep writing well-structured content, because it helps non-Google RAG engines and helps readers anyway.

#### 6.3 — llms.txt: the textbook case of hype

llms.txt deserves dissection because it is the most repeated and least supported GEO claim:

- **What it really is:** a proposal by Jeremy Howard (September 2024), a Markdown file in the root to help LLMs use a site at inference time. It was born for *technical documentation aimed at developer tools*, not as an SEO lever.
- **The evidence against (visibility in AI search):** Google *Search* states that it does not use it. The official 15 May 2026 guide says no new machine-readable files, AI text files, markup or Markdown are needed, because *"Google Search itself doesn't use them"* and adding them *"won't harm (nor help)"* visibility. Mueller compares it to the obsolete "keywords meta tag". Independent measurements (Otterly) detect 84 requests out of 62,100 to the file in 90 days (0.1%); Ahrefs (15 June 2026 study, ~38,000 valid files across 137,210 domains) finds that **97% of llms.txt files receive no requests** in May 2026 — and among the fetches that do happen, only 19.5% come from named AI tools (*"Slackbot alone fetched llms.txt files more often than PerplexityBot did"*). SE Ranking (~300,000 domains) finds no correlation between adoption and citations; removing the variable from the model *improves* its accuracy. The Search Engine Land analysis ("GEO myths") is blunt: *"there is no data or evidence showing that llms.txt files boost AI inclusion. There is certainly no proof."*
- **The Search vs Chrome bifurcation (a recent fact, not to be misread):** about 8 days away from the Search guide, Google *Chrome* added llms.txt to developer tooling. **Lighthouse 13.3.0** (official GitHub changelog, 7 May 2026) introduced an experimental **"Agentic Browsing"** category in the default config, including an llms.txt check as an *optional* signal of "AI agent readiness" (agentic readiness), alongside WebMCP, the accessibility tree and CLS. **This is not a contradiction; it is a difference in purpose between two separate teams:** Lighthouse is a *best-practice diagnostic* tool, not a search engine; an audit that detects llms.txt does not mean Google Search uses it for citations. The audit marks a missing file (404) as *"Not Applicable"* because it is *"optional at the moment"*, and the category does not even assign a 0-100 score *"because the standards for the agentic web are still emerging"*. Mueller (19 May 2026) confirms it: llms.txt *"is not done for search ... more of a temporary crutch, perhaps to save some tokens"* for AI coding tools. **Lighthouse's motivation is prospective** (assumed future use by agents), not based on proven real-world usage — which remains negative. Seeing llms.txt appear in official Chrome checks may make some SEOs revisit their doubts, but it changes nothing on citations.
- **The grain of truth (not to be inflated):** a Wix analysis (AI Search Lab, over 1,400 files examined, November 2025 updated to May 2026) estimates that the number of llms.txt files indexed by Google rose from ~30,000-60,000 (October 2025) to about 120,000 (May 2026), with a peak of ~200,000 in April 2026 — a sign that the format costs a fraction of the tokens of an HTML page and *may* make sense in view of the future **agentic web** and for RAG on tools that read it explicitly. It is, however, a **biased estimate not verified by independent sources** (the "125,000" figure often cited appears in the article's subtitle but does not match the "about 120,000" of the body text), and — in the same source's words — *"this will not make or break your GEO strategy."*
- **Critical verdict:** llms.txt as an AI citation lever is **unproven and with predominantly contrary evidence**. It has a legitimate and narrow use case (documentation for agents/dev tools), which is different from "it gets you cited more by ChatGPT". Its inclusion in Lighthouse does not overturn the studies: it measures prospective *agentic readiness*, not real bot behaviour today. Whoever sells it as a GEO factor is selling a bet on the future passed off as a present-day tactic. Realistic priority: very low, after anything concerning content quality and structure. If the CMS generates it at low cost (Wix and Framer already do), keeping it as low-cost future-oriented infrastructure is acceptable — but it must be versioned and protected (prompt-injection risk flagged by Ahrefs).

#### 6.4 — Serving pages in Markdown too: marginal, often hype

A recurring question: is it worth publishing a Markdown version of pages (via content negotiation or parallel `.md` files) to get cited better by the AIs? Short answer: <strong>for mainstream generative engines it is marginal/situational, not a proven factor</strong>, and in some forms it is risky.

- **A crucial technical distinction:** (a) **content negotiation** via an `Accept: text/markdown` header on the *same* URL is a legitimate HTTP standard, not cloaking; (b) **`.md` files at separate URLs** are defined by Google and Bing as potential cloaking and a doubling of the crawl budget (Bing crawls both versions anyway to verify similarity).
- **Search crawlers do not negotiate Markdown.** GPTBot, OAI-SearchBot, ChatGPT-User, PerplexityBot, ClaudeBot, Googlebot, Bingbot do not send `Accept: text/markdown`. Only some *coding agents* in a live session do (Claude Code, Cursor, OpenCode — independent Checkly test, Feb 2026). Generalising their behaviour to all crawlers is the error at the root of the hype.
- **The empirical evidence is of null/non-significant effect.** Profound (a controlled experiment, 381 pages, Jan-Feb 2026): ~16% average lift but *not statistically significant*, driven by outliers. Otterly (md vs HTML, 14 days): the `.md` files received 0% of the AI bot traffic and zero citations. It is the same fate as llms.txt (also Markdown): if that doesn't move the needle, the format itself is not the factor.
- **The real advantage of Markdown is tokenization** (~80% fewer tokens according to the Cloudflare example), but it benefits those who *convert* the HTML — Jina Reader, Firecrawl, the RAG pipelines, Claude Code via Turndown already convert the HTML into Markdown on their side, making serving it largely redundant.
- **Official Google position (15 May 2026):** *"You don't need to create new machine readable files, AI text files, markup, or Markdown ... as Google Search itself doesn't use them."* Mueller (Bluesky, Feb 2026): converting pages into Markdown just for the bots is *"such a stupid idea"*.
- **Verdict:** it makes sense only for **technical documentation / SaaS / API** consulted by coding agents in real time (developer experience + token savings), or as an infrastructural benefit (bandwidth/costs). For a generic e-commerce/business site targeting ChatGPT/Perplexity/AI Overviews it is an investment with proven low/null ROI. Far more important is **clean semantic HTML** (correct headings, real tables, no div-soup, server-side rendering): it helps LLMs, scrapers and accessibility together. If you really do implement it, use content negotiation with `Vary: Accept`, never separately indexable `.md` files.

#### 6.5 — Schema/structured data: useful, but not for the reason you're told

- **The hype claim:** "without schema.org you don't get cited by the AI."
- **The evidence:** Google (May 2026) explicitly says that structured data **is not required** to generate AI answers. Pedro Dias and others have shown that schema does not influence ChatGPT citations. Correlation studies (sites with schema = more AI visibility) exist but are **confounded by third variables**: sites that implement schema also tend to be more polished, more authoritative, better structured. The correlation does not isolate schema as a cause.
- **Balanced verdict:** schema remains useful for its classic purposes (rich results, parsing, entity disambiguation) and does no harm. But it is not the AI citation factor that GEO marketing suggests. Implement it for technical hygiene and for traditional Search, not as an "AI trick".

#### 6.6 — Vendors' decoy numbers

A class of claims to treat with systematic suspicion: precise percentages without a named primary source. Examples that circulate:

- "Data-rich content is cited 2.7x more."
- "FCP under 0.4s = 6.7 average citations."
- "Pages with well-organised headings are 2.8x more cited." (AirOps — this last one at least has a declared dataset of 45,000 citations, so it is more defensible than the other two.)

**Why to be suspicious:** methodology, sample size, number of runs per prompt and a control group are often missing. In light of Section 4-bis (a single run has SE 0.370!), any two-decimal figure obtained without repeated runs is statistically suspect. **Rule of thumb:** if a claim does not state how many times it repeated each prompt and over what period, treat it as an anecdote, not as data.

#### 6.7 — "SEO is dead": the opposite over-extension

At the opposite extreme of GEO hype is the hype of "SEO is dead, only GEO matters". It is equally wrong:

- The Ahrefs/Semrush data show that traditional organic ranking **remains correlated** (even if no longer a necessary condition) with AI citation; AI Overviews run *on top of* the Search ranking system.
- "Parametric visibility" (Section 2-ter.1) is built with the same signals as classic SEO: authority, press coverage, Wikipedia, backlinks, mentions.
- Google itself titles its position "AEO and GEO are still SEO".

**Verdict:** GEO is an extension of SEO, not a substitute for it. The foundations (crawlability, authority, quality content) are *more* important, not less. What changes is the level of competition (chunk vs page), the surfaces (YouTube, Reddit) and the metrics (citation vs click).

#### 6.8 — GEO claims triage table

| GEO claim | Evidence | Verdict | Priority |
|---|---|---|---|
| Statistics + source citations increase citation | GEO paper (KDD 2024), replicable | Proven | High |
| Content freshness matters | Ahrefs, Seer, Perplexity test, GEO paper | Proven | High |
| Non-commodity content / first-hand experience | Official Google guide 2026 | Confirmed by the platform | High |
| Answer-first structure/clarity | RAG research + cross-encoder | Solid (mechanism) | High |
| Brand mentions > backlinks for citations | Previsible (1.96M sessions) | Plausible, 1 study | Medium |
| Schema/structured data for AISO | Debunked by Google 2026 | Overrated | Low (do it for other reasons) |
| Manual content chunking | Debunked by Google 2026 | Myth (for Google) | Low |
| llms.txt as a citation lever | No proof, contrary evidence (Search); included in Lighthouse as agentic readiness | Unproven for citations / hype | Very low |
| Serving pages in Markdown | Profound/Otterly: null/non-signif. effect | Marginal (useful only for dev tools) | Low |
| Decoy numbers "2.7x", "6.7 citations" | Without methodology/runs | Anecdote | Ignore |
| "SEO is dead" | Contradicted by the data | False | — |

## Caveats
- **Distinguish documented facts from vendor claims:** the Pew/SparkToro/Ahrefs/Seer indices and numbers are well documented; many precise "citation factors" come from vendor blogs and are not verifiable against named primary sources.
- **Conflicting data on ranking:** the overlap between AIO citations and the top-10 varies across studies (38% vs 76%), partly because of methodological differences in detection.
- **Forecasts are forecasts:** Gartner's 25% is a 2024 estimate, not a final figure.
- **Reverse-engineering:** the details on ChatGPT's `web.run`, fan-out and system prompt derive from independent analyses (RESONEO/Meteoria, AirOps, Dejan), not from complete official documentation, and change from one model to the next.
- **Volatility:** the pipelines change rapidly (Gemini 3 Jan 2026, ChatGPT 5.3 switch Mar 2026); every figure has a validity date.
- **Chunking tension:** Google (May 2026) declares manual chunking unnecessary for *its* AI features; this holds for Google, while for non-Google RAG engines content structure remains relevant (see 6.2).
- **llms.txt and schema:** explicitly flagged as hype/overrated for GEO (Section 6), contrary to what many tools and agencies suggest. On Lighthouse specifically: the "Agentic Browsing" category is **experimental** and may change or be removed; the official Chrome documentation **does not** mention content negotiation (`Accept: text/markdown`), so that characteristic should not be attributed to Lighthouse. The official changelog date for 13.3.0 is 7 May 2026; press coverage is around 20 May 2026.

---

## Bibliography / Sources

**Academic papers and benchmarks**
- Aggarwal P. et al., *GEO: Generative Engine Optimization*, arXiv:2311.09735, KDD 2024 — https://arxiv.org/abs/2311.09735
- Schulte J. et al., *Don't Measure Once: Measuring Visibility in AI Search (GEO)*, arXiv:2604.07585 (10 Apr 2026) — https://arxiv.org/abs/2604.07585
- Sielinski R., paper on uncertainty in AI visibility measurement (Mar 2026), arXiv:2603.08924
- Gemini Team, *Gemini 2.5 Technical Report*, arXiv:2507.06261 — https://arxiv.org/pdf/2507.06261
- *Hybrid Dense-Sparse Retrieval for High-Recall IR* (Jan 2026) — researchgate 399428523
- Khattab O., Zaharia M., *ColBERT* (SIGIR 2020); Santhanam et al., *ColBERTv2/PLAID* (2022)
- Chunking studies: Vecta Benchmark (Feb 2026); arXiv:2506.17277 (chemistry); arXiv:2512.05411 (enterprise); arXiv:2506.06339 (Arabic); MDPI Bioengineering (Nov 2025, clinical); BEIR arXiv:2104.08663
- *LegalBench-RAG*, arXiv:2408.10343

**Retrieval / embeddings / chunking / reranking**
- Towards Data Science, *Advanced RAG Retrieval: Cross-Encoders & Reranking* — https://towardsdatascience.com/advanced-rag-retrieval-cross-encoders-reranking/
- Pinecone, *Rerankers and Two-Stage Retrieval* — https://www.pinecone.io/learn/series/rag/rerankers/
- Weaviate, *Late Interaction Retrieval: ColBERT, ColPali, ColQwen* — https://weaviate.io/blog/late-interaction-overview
- Qdrant, *Any Embedding Model Can Become a Late Interaction Model* — https://qdrant.tech/articles/late-interaction-models/
- Firecrawl, *Best Chunking Strategies for RAG (2026)* — https://www.firecrawl.dev/blog/best-chunking-strategies-rag
- Chroma, *Context Rot research* (Jul 2025)

**Engine reverse-engineering**
- de Segonzac O. (RESONEO/Meteoria), *Inside ChatGPT Search: web.run and fan-out queries*, Search Engine Land (14 May 2026) — https://searchengineland.com/inside-chatgpt-search-web-run-fan-out-queries-ai-visibility-477339 ; full study: https://think.resoneo.com/chatgpt/5.3-5.4/
- Seer Interactive, *SearchGPT vs Bing citation overlap (87%)* (Feb 2025)
- Google, *Gemini API — Grounding with Google Search* (groundingMetadata) — https://ai.google.dev/gemini-api/docs/google-search
- Yeşilyurt M., Perplexity reranking analysis (Aug 2025), via Search Engine Land; AuthorityTech, *How Perplexity Selects Sources* (Feb 2026) — https://authoritytech.io/blog/how-perplexity-selects-sources-algorithm-2026
- GrowthMarshal, *The 2025 Perplexity Playbook: Sonar Ranking Factors* — https://www.growthmarshal.io/field-notes/the-perplexity-playbook
- RankStudio, *Perplexity's LLM: Sonar & PPLX Deep Dive* — https://rankstudio.net/articles/en/perplexity-llm-tech-stack
- Anthropic, *Web search tool — Claude API Docs* — https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool

**Microsoft Copilot / Bing**
- Microsoft Bing Blog, *Building the New Bing | Search Quality Insights* (Prometheus, Bing Orchestrator) — https://blogs.bing.com/search-quality-insights/february-2023/Building-the-New-Bing
- Bing Webmaster Guidelines (rewrite 27 Feb 2026); Search Engine Journal and WrittenlyHub, NOARCHIVE/NOCACHE/data-snippet analysis
- Seer Interactive, *87% of SearchGPT Citations Match Bing's Top Results* (6 Feb 2025) — https://www.seerinteractive.com/insights/searchgpt-citations-bing
- Microsoft, *IndexNow* and *Bing Webmaster Tools — AI Performance Report* (public preview Feb 2026)

**Chinese AI engines**
- Baidu, *Fourth Quarter and Fiscal Year 2025 Results* (26 Feb 2026) — https://ir.baidu.com/news-releases/news-release-details/baidu-announces-fourth-quarter-and-fiscal-year-2025-results ; earnings call transcript via Investing.com
- ERNIE 4.5 open-source (30 Jun 2025), Apache 2.0 licence — official @Baidu_Inc post; TechNode, SCMP
- DeepSeek API share ~34% vs ERNIE ~18% (snapshot mid-2025) — SiliconANGLE, TechRadar Pro
- QuestMobile (via Caixin), *leading native AI apps in China, March 2026* (Doubao ~345M MAU)

**Measurement / volatility**
- Profound, *AI Search Volatility* — https://www.tryprofound.com/blog/ai-search-volatility
- AirOps, *AI Search Volatility* and *AI Visibility Metrics* — https://www.airops.com/blog/ai-visibility-metrics
- Lafferty N., *AI Visibility Metrics: Formulas, Benchmarks & Sample Sizes (2026)* — https://nicklafferty.com/blog/ai-visibility-metrics-reference/
- Machine Relations, *Citation Drift* (BrightEdge 70x, Semrush Reddit 60→10%) — https://medium.com/machine-relations/citation-drift-ai-visibility-data-d7c2eea8e223

**Official Google guide and anti-hype**
- Google Search Central, *A new resource for optimizing for generative AI in Search* (15 May 2026) — https://developers.google.com/search/blog/2026/05/a-new-resource-for-optimizing
- Google Search Central, *Guidance on using third-party SEO tools, services, and advice* and update to *Do you need an SEO?* (5 Jun 2026, names AEO/GEO as a category) — cf. Digital Applied, *Google Now Tells You to Optimize for Generative AI* — https://www.digitalapplied.com/blog/google-official-seo-docs-generative-ai-optimization-june-2026
- Search Engine Journal, *Google's New AI Search Guide Calls AEO And GEO 'Still SEO'* — https://www.searchenginejournal.com/googles-new-ai-search-guide-calls-aeo-and-geo-still-seo/575026/
- Search Engine Land, *GEO myths: This article may contain lies* — https://searchengineland.com/geo-myths-lies-467617
- Wix Studio, *Debunking LLMs.txt Myths* (over 1,400 files; estimate ~120,000 indexed) — https://www.wix.com/studio/ai-search-lab/llms-txt-myths
- Ahrefs, *97% of llms.txt Files Never Get Read* (May 2026) — https://ahrefs.com/blog/llmstxt-study/ ; SE Ranking, *LLMs.txt: Why It Doesn't Work* — https://seranking.com/blog/llms-txt/ ; Otterly, *The llms.txt Experiment* — https://otterly.ai/blog/the-llms-txt-experiment/
- Search Engine Journal, *Mueller: llms.txt Can't Help LLMs Differentiate Sites* — https://www.searchenginejournal.com/googles-mueller-says-llms-txt-cant-help-llms-differentiate-sites/579304/
- Google Chrome for Developers, *Lighthouse agentic browsing scoring* and *llms.txt audit* (experimental category, docs updated 5 May 2026) — https://developer.chrome.com/docs/lighthouse/agentic-browsing/scoring · https://developer.chrome.com/docs/lighthouse/agentic-browsing/llms-txt
- GoogleChrome/lighthouse, *changelog 13.3.0* (Agentic Browsing in the default config, 7 May 2026) — https://github.com/GoogleChrome/lighthouse/blob/main/changelog.md
- Search Engine Journal, *Google's llms.txt Guidance Depends On Which Product You Ask* (20 May 2026) — https://www.searchenginejournal.com/googles-llms-txt-guidance-depends-on-which-product-you-ask/575431/ ; Search Engine Land, *Google adds llms.txt check to Chrome Lighthouse* — https://searchengineland.com/google-llms-txt-chrome-lighthouse-478246

**Markdown for pages (content negotiation / .md)**
- Google Search Central, *AI optimization guide* (no Markdown required) — https://developers.google.com/search/docs/fundamentals/ai-optimization-guide
- Profound, *Markdown vs HTML: An Experiment on AI Traffic* — https://www.tryprofound.com/blog/does-markdown-increase-ai-bot-traffic
- Otterly, *GEO Experiment: Markdown vs HTML* — https://otterly.ai/blog/geo-experiment-html-vs-markdown/
- Checkly, *State of Content Negotiation for AI Agents* — https://www.checklyhq.com/blog/state-of-ai-agent-content-negotation/
- Cloudflare, *Introducing Markdown for Agents* — https://blog.cloudflare.com/markdown-for-agents/ ; Search Engine Land, *Google & Bing don't recommend separate markdown pages* — https://searchengineland.com/google-bing-dont-recommend-seperate-markdown-pages-for-llms-468365

**EU/Italy legal framework**
- Directive (EU) 2019/790 (CDSM), arts. 3-4; AI Act (Reg. EU 2024/1689), art. 53(1)(c), Recital 106
- EPRS, *AI and copyright: training of general-purpose AI* — https://www.europarl.europa.eu/RegData/etudes/ATAG/2025/769585/EPRS_ATA(2025)769585_EN.pdf
- EU Parliament, procedure 2025/2058(INI) *"Copyright and generative AI"* (rapporteur Voss): JURI study PE 774095 (Lucchi, 9 Jul 2025) and draft report PE775.433 (27 Jun 2025); resolution T10-0066/2026 (10 Mar 2026) — https://oeil.secure.europarl.europa.eu/oeil/en/procedure-file?reference=2025/2058(INI) ; Jones Day, *EP study on GenAI and copyright* — https://www.jonesday.com/en/insights/2025/08/european-parliaments-new-study-on-generative-ai-and-copyright-calls-for-overhaul-of-optout-regime
- Kluwer Copyright Blog, *The TDM Opt-Out in the EU* and *LAION Round 2* — https://legalblogs.wolterskluwer.com/copyright-blog/the-tdm-opt-out-in-the-eu-five-problems-one-solution/
- Synodinou-Vrakas, *Lawful Access as a Gatekeeper for TDM*, Verfassungsblog (17 Nov 2025) — https://verfassungsblog.de/lawful-access-gatekeeper/
- Kneschke v. LAION (Hamburg Regional Court, 27 Sep 2024); DPG Media v. HowardsHome (Amsterdam, 2024)
- Agenda Digitale, *Italian publishers (FIEG) against Google's AI* — https://www.agendadigitale.eu/mercati-digitali/editori-italiani-fieg-contro-lai-di-google-ecco-le-basi-del-reclamo-agcom/
- Key4biz, *FIEG against Google: "AI Overview is a traffic killer"* — https://www.key4biz.it/fieg-contro-google-ai-overview-e-un-traffic-killer-chiesto-lintervento-dellagcom-per-violazione-del-dsa/550920/
- AGCOM, referral to the EU Commission on Google AI Overviews/AI Mode under art. 65 DSA (session 29 Apr 2026, communiqué 30 Apr 2026) — ANSA, Italpress/Business Channel, Primaonline; Agenda Digitale, *Google's AI and the newspapers: the ball is in the EU's court* — https://www.agendadigitale.eu/mercati-digitali/ai-di-google-e-giornali-la-palla-e-nel-campo-dellue-il-quadro/
- Garante Privacy, Decisions 112/2023 and 755/2024; Court of Rome judgment 4153/2026 (annulment of the fine) — Altalex
- Eurostat via Euronews, GenAI adoption in Europe — https://www.euronews.com/next/2025/12/29/chatgpt-gemini-grok-and-others-which-countries-use-generative-ai-tools-most-across-europe

**GEO measurement tools**
- Surmado, *Best AI Visibility Tools 2026* — https://www.surmado.com/blog/best-ai-visibility-tools-2026
- Otterly.ai — https://otterly.ai/

*Document updated as of 22 June 2026. Given the speed of the sector's evolution, the statistics and mechanisms described have limited temporal validity.*
