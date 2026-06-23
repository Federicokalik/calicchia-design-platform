/**
 * EN translation of the "From SEO to GEO" white paper body.
 * Mirrors the IT body in geo-whitepaper.it.ts 1:1 in structure: same tags,
 * classes and element ids (#ds-*, #chunk-*, #fo-*, #se-*) so the client demos
 * attach identically. Only the human-readable text is translated.
 */

export const GEO_WP_BODY_EN = `<header class="masthead">
  <div class="wrap">
    <div class="mast-top"><span>White Paper</span><span>Generative Engine Optimization</span><span class="r">2026</span></div>
    <div class="hero-grid">
      <div>
        <h1 class="display">SEO<br>→ <span class="red">GEO</span></h1>
      </div>
      <div class="hero-sub">
        <p class="lede">The evolution of search in the age of generative AI.</p>
        <div class="byline">
          Curated by <a href="https://github.com/federicokalik">Federico Calicchia</a> · written with the support of Claude Opus 4.8 (Anthropic) under editorial direction.
        </div>
        <div class="meta-row"><span>Last updated · 22 June 2026</span></div>
      </div>
    </div>
  </div>
</header>

<main>
<div class="wrap">

<!-- INTRO -->
<section id="intro">
  <div class="sec-grid">
    <div class="sec-aside"><span class="num">00</span><span class="lbl">Introduction</span></div>
    <div class="sec-body">
      <p class="lede" style="margin-bottom:24px">For twenty years search had a stable grammar: query → list of links → click. That grammar is breaking down.</p>
      <p>For twenty years online search worked according to a stable grammar: a user types a query, an engine returns an ordered list of links, the user clicks and lands on a site. On that mechanism — crawling, indexing, ranking, click-through — an entire discipline was built, SEO, and with it the economic model of the open web, where visibility translated into traffic and traffic into value.</p>
      <p>Generative engines (Google with AI Overviews and AI Mode, ChatGPT, Perplexity, Microsoft Copilot, Claude) no longer return primarily a list of links: they read the web on the user's behalf, synthesise an answer and cite a handful of sources. The click, which used to be the goal, becomes the exception. The unit of competition changes (no longer the page but the single <em>chunk</em> of content that a retrieval system can extract and cite), the metrics change (from SERP position to share of citation), the players change (a fragmented archipelago, evolving fast, including beyond the West). From this shift, GEO is born, <em>Generative Engine Optimization</em>.</p>
      <p>This document has three aims: to explain <strong>how the engines really work</strong> at the level of retrieval (embedding, chunking, re-ranking, query fan-out) and source selection, engine by engine; to <strong>distinguish what is documented</strong> from what is inferred via reverse-engineering or merely asserted by vendors; and to <strong>place the phenomenon in the Italian and European context</strong>, where the regulatory framework (AI Act, TDM opt-out, DSA, GDPR) is the most stringent in the world and concretely shapes what GEO can and cannot do. The tone is educational and analytical: understand the mechanism, not sell a recipe.</p>
      <div class="note"><strong>Methodological note.</strong> This document was put together from research on primary and secondary sources (academic papers, official engine documentation, industry reports, independent reverse-engineering analyses). The sections explicitly distinguish documented facts from vendor claims and from analyses not officially confirmed. All sources are listed in the bibliography.</div>
    </div>
  </div>
</section>

<!-- TLDR -->
<section id="tldr">
  <div class="sec-grid">
    <div class="sec-aside"><span class="num">—</span><span class="lbl">In brief</span></div>
    <div class="sec-body">
      <h2>Five points</h2>
      <ul class="keylist">
        <li><div>Zero-click is structural: in 2024, 58.5% of US Google searches ended without a click (SparkToro/Datos), rising to <strong>68.01%</strong> in early 2026. With an AI Overview, the organic CTR of the top page drops by <strong>47-61%</strong> depending on the study (Authoritas, Pew, Seer Interactive, Ahrefs).</div></li>
        <li><div>GEO originates from the paper by Aggarwal et al. (IIT Delhi/Princeton, KDD 2024): statistics, citations and quotations raise visibility <strong>"by up to 40%"</strong>; keyword stuffing is the only tested method that <em>worsens</em> it.</div></li>
        <li><div>Each engine has a different pipeline (ChatGPT on Bing/scraping, Perplexity with its own crawler, Claude on Brave, Copilot on Bing/Prometheus, Gemini with fan-out): all of them use RAG, embeddings and chunk-level selection, so structure, freshness, authority and citability matter more than traditional positioning.</div></li>
        <li><div>AI visibility is a distribution, not a score: a single measurement has a standard error of <strong>0.370</strong> (useless); you need 7-10+ runs per prompt (paper "Don't Measure Once", arXiv:2604.07585).</div></li>
        <li><div>Google itself (May 2026) declares that <strong>"GEO is still SEO"</strong> and debunks 5 myths, among them llms.txt and manual chunking.</div></li>
      </ul>
      <div class="panel">
        <h4>Key Findings</h4>
        <ol>
          <li><strong>Search behaviour has changed structurally, not marginally.</strong> Zero-click went from ~50% (SparkToro 2019) to 68.01% (Q1 2026, US). Gartner forecast (Feb 2024) a 25% decline in traditional search volume by 2026 — a forecast, not a final figure.</li>
          <li><strong>Traditional organic ranking remains important but is no longer sufficient.</strong> Ahrefs (Jan 2026): only 38% of pages cited in AI Overviews are also in the organic top 10 (it was 76% in July 2025).</li>
          <li><strong>GEO tactics with empirical evidence are few and specific:</strong> statistics, source citations, quotations, freshness, answer-first structure. Many popular pieces of advice (llms.txt, schema-as-hack, manual chunking) have no evidence of working and some are contradicted by Google.</li>
          <li><strong>The Italian/EU market is lagging but accelerating fast:</strong> AI Overviews in Italy since 26 March 2025; GenAI use in Italy at 20% (below the EU average of 33%, Eurostat 2025); after the FIEG complaint (15 October 2025), AGCOM referred the case to the EU Commission under art. 65 DSA (29 April 2026). Fragmentation is global: in China, Doubao, ERNIE, DeepSeek and Qwen together exceed 900 million users.</li>
          <li><strong>The EU regulatory context is the most stringent in the world:</strong> AI Act, GDPR, the TDM opt-out under art. 4 CDSM, the Garante-OpenAI case and publisher disputes shape how GEO can operate in Europe.</li>
        </ol>
      </div>
    </div>
  </div>
</section>

<!-- SEC 1 -->
<section id="s1">
  <div class="sec-grid">
    <div class="sec-aside"><span class="num">01</span><span class="lbl">Fundamentals</span></div>
    <div class="sec-body">
      <h2>The evolution from SEO to GEO</h2>
      <h4>How traditional search worked (and still works)</h4>
      <p>Classic SEO rests on three phases: <strong>crawling</strong> (a bot like Googlebot discovers and downloads pages), <strong>indexing</strong> (pages are analysed and stored in an index), <strong>ranking</strong> (an algorithm orders the pages for a query, producing the SERP, the list of "blue links"). The economic model of the open web was based on <strong>click-through</strong>: the user searched, saw a list of results and clicked on a site, generating monetisable traffic.</p>
      <h4>How AI-driven search works</h4>
      <p>Generative engines do not primarily return a list of links, but <strong>synthesise an answer</strong> from multiple sources using an LLM, citing some of them inline. This produces <strong>zero-click answers</strong>: the user gets the answer without visiting any site. Google integrated the paradigm with <strong>AI Overviews</strong> (generative boxes at the top of the SERP) and <strong>AI Mode</strong> (a full conversational experience).</p>
      <h4>Turning points and timeline</h4>
      <ul>
        <li>May 2023: Google announces the Search Generative Experience (SGE) as an experiment in Search Labs.</li>
        <li>14 May 2024: Google officially launches AI Overviews in the US (at Google I/O).</li>
        <li>28 Oct 2024: AI Overviews extended to more than 100 countries and territories.</li>
        <li>31 Oct 2024: OpenAI launches ChatGPT Search.</li>
        <li>5 Mar 2025: AI Overviews move to Gemini 2.0; Google announces AI Mode as a Labs experiment.</li>
        <li>26 Mar 2025: AI Overviews arrive in Italy and other European countries.</li>
        <li>20 May 2025: AI Mode extended to all US users.</li>
        <li>7 May 2026: Chrome releases Lighthouse 13.3.0 with the experimental "Agentic Browsing" category, including an optional <code>llms.txt</code> check.</li>
        <li>15 May 2026: Google publishes its official GEO guidance ("Optimizing your website for generative AI features").</li>
        <li>5 Jun 2026: Google publishes guidance on third-party SEO services and updates "Do you need an SEO?", naming AEO/GEO as a service category.</li>
      </ul>
      <p>Perplexity (founded in 2022) popularised the concept of the "answer engine" with transparent citations. Claude (Anthropic) added web search in 2025.</p>
      <h4>The founding paper "GEO: Generative Engine Optimization"</h4>
      <p>The term was formalised in the paper by <strong>Pranjal Aggarwal, Vishvak Murahari, Tanmay Rajpurohit, Ashwin Kalyan, Karthik Narasimhan, Ameet Deshpande</strong> (IIT Delhi/Princeton/Allen AI), published at <strong>KDD 2024</strong> (arXiv:2311.09735, DOI 10.1145/3637528.3671900). Key results, verified against the original text:</p>
      <ul>
        <li>They introduced <strong>GEO-bench</strong>, a benchmark of <strong>10,000 queries</strong> from different domains.</li>
        <li>They tested <strong>9 methods</strong> of optimization: Authoritative, Keyword Stuffing, Statistics Addition, Quotation Addition, Cite Sources, Fluency Optimization, Easy-to-Understand, Technical Terms, Unique Words.</li>
        <li>Two metrics: <strong>Position-Adjusted Word Count</strong> (words attributed to a source, weighted by position in the answer) and <strong>Subjective Impression</strong> (a qualitative G-Eval score across 7 dimensions).</li>
        <li>The best methods — <strong>Quotation Addition +41%, Statistics Addition +31%, Cite Sources +28%, Fluency Optimization +28%</strong> — can raise visibility "up to 40%" in generative answers.</li>
        <li><strong>Keyword Stuffing</strong> is the <strong>only method that worsened</strong> visibility (−8%): SEO tactics do not transfer automatically.</li>
        <li>Effectiveness <strong>varies by domain</strong>: Statistics in "Law &amp; Government" and "Opinion" queries; Quotation in "History" and "People &amp; Society".</li>
        <li>GEO favours <strong>low-ranking</strong> sites: Cite Sources raised visibility by <strong>115.1%</strong> for sites in fifth SERP position.</li>
        <li>The <strong>Fluency + Statistics</strong> combination beat any single method by more than 5.5%.</li>
        <li>Validation on Perplexity.ai: improvements <strong>up to 37%</strong>.</li>
      </ul>
      <p class="note">Sourcing note: method titles, headline percentages and prose phrases confirmed against arXiv. v3 reports a 15-30% boost for the stylistic methods, against "10-20%" in earlier versions — a version discrepancy worth flagging.</p>
      <h4>Data on the change in search behaviour</h4>
      <ul>
        <li><strong>SparkToro/Datos (2024):</strong> 58.5% of US and 59.7% of EU Google searches without a click. For every 1,000 US searches, only 360 clicks to the open web.</li>
        <li><strong>SparkToro/Similarweb (2026):</strong> 68.01% of US Google searches without a click in the first 4 months of 2026 (+7.56 points since 2024).</li>
        <li><strong>Ahrefs (Dec 2025):</strong> an AIO correlates with an average CTR of −58% for the top page.</li>
        <li><strong>Pew Research (Jul 2025):</strong> across 68,879 real searches, clicks on a traditional link at 8% with an AIO vs 15% without (≈ −47%); only 1% click a cited source; 26% of sessions with an AIO end entirely (vs 16%). Google contested the methodology.</li>
        <li><strong>Seer Interactive (Sep 2025, &gt;25M impressions):</strong> organic CTR for queries with an AIO −61% (1.76% → 0.61%).</li>
        <li><strong>Gartner (Feb 2024):</strong> forecast of −25% in traditional search volume by 2026 (a forecast, not a final figure).</li>
        <li><strong>Publisher impact:</strong> Digital Content Next (Aug 2025) a median 10% drop in Google referral traffic; Press Gazette/Chartbeat: −33% globally in 2025 (−38% US, −17% Europe). The damage scales with site size.</li>
      </ul>
    </div>
  </div>
</section>

<!-- SEC 2 -->
<section id="s2">
  <div class="sec-grid">
    <div class="sec-aside"><span class="num">02</span><span class="lbl">Mechanics</span></div>
    <div class="sec-body">
      <h2>How the engines work</h2>
      <p>All generative engines use some form of <strong>RAG (Retrieval-Augmented Generation)</strong>: instead of relying only on "parametric" knowledge (learned in training), they retrieve fresh content from the web and use it to build the answer. The underlying technical thesis: <strong>the page is no longer the unit of competition, the chunk is.</strong></p>
      <ul>
        <li><strong>ChatGPT (OpenAI):</strong> retrieval via third-party scraping APIs (historically tied to Bing; Seer found 87% overlap with Bing's top results); query fan-out; source selection that weighs authority, structure and freshness.</li>
        <li><strong>Google Gemini / AI Overviews / AI Mode:</strong> its own web index + Knowledge Graph + Shopping; query fan-out documented via API; selection that also draws from outside the top 10 (Ahrefs Jan 2026: only 38% of citations from the top 10).</li>
        <li><strong>Perplexity:</strong> RAG with its own crawler (PerplexityBot); strong sensitivity to freshness; typically 3-5 sources per answer; multi-level ML reranking.</li>
        <li><strong>Microsoft Copilot:</strong> the Prometheus model on the Bing index; a "Bing Orchestrator" that generates iterative internal queries (fan-out); numbered citations [1][2]; the first engine to codify GEO in its own Webmaster Guidelines (February 2026).</li>
        <li><strong>Claude (Anthropic):</strong> retrieval via an external provider (overlap with Brave); sentence-level citation; three bots (ClaudeBot training, Claude-User fetch, Claude-SearchBot indexing).</li>
      </ul>

      <h3>2-bis · The three families of retrieval</h3>
      <p><strong>Dense (bi-encoder):</strong> query and document encoded <em>separately</em> into a single dense vector (e.g. 768 dimensions); relevance is cosine similarity. Very fast (pre-computed vectors + ANN), but — as Towards Data Science puts it — <em>"the model compresses all meaning into one vector before any comparison happens"</em>: query and document never interact at the token level. GEO consequence: a chunk with three concepts produces an "average" vector that represents none of the three well. <strong>Sparse (BM25, SPLADE):</strong> exact (or expanded) lexical match, unbeatable on proper nouns, product codes and technical terms — the cases where dense fails. <strong>Late interaction (ColBERT and successors):</strong> keeps embeddings <em>at the token level</em> and computes relevance with MaxSim. Weaviate: dense methods <em>"pool token-wise embeddings into a single representation while ColBERT embeddings keep the token-wise representations in a multi-vector"</em>. Advantage: explainability; disadvantage: storage (BEIR: ~20GB/1M docs vs 0.4GB for BM25 and ~3GB for dense).</p>
      <p><strong>The figure that matters:</strong> <strong>hybrid dense+sparse approaches beat every single method</strong>. A single study (Jan 2026, on MS MARCO, a low-visibility source with an unusually low dense baseline — to be treated as indicative) reports up to <strong>580% improvement in Recall@10</strong> over dense alone (13.9% → 80.8%); the general principle is in any case confirmed by more solid peer-reviewed literature. Real engines combine "meaning" (dense) and "exact word" (sparse): content must serve both — clear concepts <em>and</em> exact terminology.</p>

      <!-- DEMO 1 -->
      <div class="demo" id="demo-ds">
        <div class="demo-head"><span class="dot"></span>Demo 01 · Dense vs Sparse<span class="tag">educational simulation</span></div>
        <div class="demo-body">
          <label for="ds-q">Search query</label>
          <input type="text" id="ds-q" value="iPhone 15 Pro 256GB" autocomplete="off">
          <div class="chips" id="ds-chips">
            <span class="chip" data-q="iPhone 15 Pro 256GB">product code</span>
            <span class="chip" data-q="best lightweight laptop for students">natural language</span>
            <span class="chip" data-q="how to reduce battery drain">how-to question</span>
          </div>
          <div class="ds-grid">
            <div class="ds-col dense"><h5>Dense · semantic</h5><div class="ds-score" id="ds-dense-score">—</div><div class="ds-bar"><span id="ds-dense-bar"></span></div><div class="ds-note" id="ds-dense-note"></div></div>
            <div class="ds-col sparse"><h5>Sparse · lexical</h5><div class="ds-score" id="ds-sparse-score">—</div><div class="ds-bar"><span id="ds-sparse-bar"></span></div><div class="ds-note" id="ds-sparse-note"></div></div>
          </div>
        </div>
        <div class="demo-cap">Educational heuristic (not a real engine): it shows <em>why</em> the two approaches excel on different queries. Codes and proper nouns reward sparse; conceptual queries reward dense. Real engines combine them.</div>
      </div>

      <h3>2-bis · Embeddings</h3>
      <p>What a vector captures (and what it does not). Three operational implications: (1) <strong>the same model is mandatory for index and query</strong> — otherwise the vectors live in misaligned spaces and the similarity is noise; it is the #1 cause of silently broken RAG; (2) <strong>context rot</strong> — Chroma's research (Jul 2025, 18 models including GPT-4.1, Claude 4, Gemini 2.5) shows that retrieval degrades as context length grows, even on simple tasks: burying the answer in the middle of a wall of text makes it less retrievable; (3) <strong>an average vector is not a good vector</strong> — several distinct concepts in one chunk = a diffuse embedding.</p>

      <h3>2-bis · Chunking</h3>
      <p>Common sense says "semantic chunking is best"; the benchmarks say the opposite, and the divergence is instructive. <strong>Vecta Benchmark (Feb 2026):</strong> recursive splitting at 512 tokens first (69%), semantic at 54% (fragments of ~43 tokens); the author: the conversation about chunking has been <em>"dominated by theory rather than measurement"</em>. <strong>MDPI Bioengineering (Nov 2025):</strong> in the clinical domain, adaptive 87% vs 13-50% for fixed-size (p=0.001). <strong>arXiv 2506.17277 (chemistry):</strong> recursive up to +45% domain-weighted precision. <strong>arXiv 2512.05411 (enterprise):</strong> on well-structured documentation, naive beats semantic and recursive. <strong>arXiv 2506.06339 (Arabic):</strong> sentence-aware best, semantic <em>consistently worst</em>.</p>
      <p><strong>They do not reconcile — and that is the point.</strong> No strategy is universally optimal; it depends on document structure and query type. A defensible robust default: <strong>recursive splitting at 400-512 tokens with 10-20% overlap</strong>, when you have no specific reason to do otherwise. Why care even if you don't control the engine's chunker? Because you control <em>how well-splittable</em> the page is: sharp semantic boundaries (clear headings, one idea per section, self-contained answers) produce coherent chunks with any strategy. <strong>Content structure is the chunking you can control.</strong></p>

      <!-- DEMO 2 -->
      <div class="demo" id="demo-chunk">
        <div class="demo-head"><span class="dot"></span>Demo 02 · Chunking strategies<span class="tag">interactive</span></div>
        <div class="demo-body">
          <label for="chunk-in">Text to split</label>
          <input type="text" id="chunk-in" value="GEO optimises for generative engines. Statistics increase citations. Keyword stuffing instead reduces them. Freshness matters a lot for Perplexity." autocomplete="off">
          <div class="chunk-controls">
            <button data-mode="fixed">Fixed-size</button>
            <button data-mode="recursive">Recursive</button>
            <button data-mode="semantic">Semantic</button>
          </div>
          <div class="chunk-out" id="chunk-out"></div>
          <div class="chunk-meta" id="chunk-meta"></div>
        </div>
        <div class="demo-cap">Fixed cuts at a set length (breaks sentences); recursive respects sentence boundaries; semantic groups by meaning but can fragment too much.</div>
      </div>

      <h3>2-bis · Re-ranking</h3>
      <p>Real retrieval is almost always <strong>two-stage</strong>: <strong>Stage 1 — Recall</strong> (bi-encoder/BM25/hybrid), a wide net with 20-150 fast candidates; <strong>Stage 2 — Precision</strong> (cross-encoder) that re-evaluates each query-chunk pair <em>together</em> (<code>[CLS] query [SEP] document [SEP]</code>), reorders and keeps the top 3-8. Operational numbers: a lightweight cross-encoder (ms-marco-MiniLM-L-6-v2) ~50ms/20 docs; Cohere Rerank ~200ms; an LLM reranker 1-3s. Typical gain <strong>+5-15 points nDCG@10</strong> or +10-25% accuracy. Default: top-20→50, rerank, pass top-3→8; beyond 50 candidates it <em>"adds latency without meaningfully improving recall"</em>. <strong>GEO implication:</strong> the cross-encoder rewards <strong>direct, query-specific relevance</strong> — not keyword density, not length, not domain authority in itself. It is the mechanical foundation of why answer-first works: it is not style, it is alignment with the cross-encoder.</p>

      <div class="panel">
        <h4>From the mechanism to the markup rule</h4>
        <div class="tablewrap"><table>
          <tr><th>Mechanical fact</th><th>Operational rule for the content</th></tr>
          <tr><td>Dense compresses everything into one vector</td><td>One idea per section; don't mix 3 themes in a paragraph</td></tr>
          <tr><td>Sparse rewards exact match</td><td>Include exact terms/codes/names, not just synonyms</td></tr>
          <tr><td>Hybrid beats single methods</td><td>Clear concepts <em>and</em> precise terminology together</td></tr>
          <tr><td>Context rot</td><td>Answer up top, not buried halfway down the page</td></tr>
          <tr><td>Self-contained chunks = robust retrieval</td><td>Each section should make sense read on its own</td></tr>
          <tr><td>Clear headings = sharp boundaries</td><td>Semantic HTML: <code>&lt;h2&gt;</code> as a question + answer below</td></tr>
          <tr><td>Cross-encoder rewards direct relevance</td><td>Answer-first: the answer in the first 40-60 tokens</td></tr>
          <tr><td>Re-ranking cuts to the top 3-8</td><td>You need to be the <em>most</em> relevant chunk, not just relevant</td></tr>
        </table></div>
      </div>

      <h3>2-ter · Per-engine reverse-engineering</h3>
      <p class="note">Epistemic distinction: what follows mixes <strong>official facts</strong> (documentation, APIs), <strong>reverse-engineering analyses</strong> not confirmed by the makers, and <strong>vendor claims</strong>. I flag each case as it comes. This is the most volatile area of the document: the pipelines change from one model update to the next.</p>

      <h4>ChatGPT — the web.run tool</h4>
      <p>The most detailed source is the RESONEO/Meteoria study (Olivier de Segonzac, May 2026), which decompiled the mobile app, sniffed the network packets and reconstructed the system prompt. The internal engine is called <code>web.run</code>: before GPT-5.3 it sent compact textual commands separated by pipes (<code>fast|query|recency</code>), after 5.3 structured JSON objects. The tool supports <strong>12 operations</strong> (up from 4): <code>search_query</code>, <code>open</code>, <code>find</code>, <code>click</code>, <code>screenshot</code>, <code>product_query</code> and specialised widgets, plus a <code>genui</code> system. The <strong>query fan-out</strong> chains 2-10+ rounds; the novel product fan-out (<code>browse_rewritten_queries</code>) launches a <em>separate shopping search for each individual product</em>. It is <code>ChatGPT-User</code> (not OAI-SearchBot) that fetches the pages during the conversation; Google tracking markers (<code>strlid</code>) in product URLs reveal a backend that leans on third-party providers and on Google behind the scenes.</p>
      <p>With the switch to GPT-5.3 Instant (4 Mar 2026) the unique domains cited per answer <strong>dropped from 19 to 15 (−20%)</strong> — the "Bigfoot Effect": concentration on a few authoritative domains (URL-per-domain ratio stable at 1.26). <strong>Reddit</strong> is the only domain exempt from the per-word copyright limits in the reconstructed system prompt. <em>(Reverse-engineering.)</em> Strategic point: the study distinguishes <strong>parametric visibility</strong> (what the model learned in training — stable, shaped by press coverage, Wikipedia, authoritative sites) from <strong>dynamic visibility</strong> (what it retrieves in real time, volatile). The link: <em>"the model formulates the web queries pointing at sources it already knows. A brand absent from the parametric memory will not even be considered as a candidate."</em></p>
      <p class="note">Caveat: the same prompt on 5.2/5.3/5.4 produces different fan-out, sources and passages. Citation in ChatGPT is not reproducible like a Google ranking: it must be tested model by model.</p>

      <h4>Gemini / AI Mode — documented fan-out</h4>
      <p>Unlike ChatGPT, here there is <strong>official documentation</strong>, via the Gemini grounding API. The response returns <code>webSearchQueries</code> (the queries actually executed — e.g. for "who won Euro 2024" it generates <code>["UEFA Euro 2024 winner", "who won euro 2024"]</code>), <code>groundingChunks</code> (the sources, with uri and title) and <code>groundingSupports</code> (the <strong>text segment → source chunk</strong> mapping, with <code>startIndex</code>/<code>endIndex</code> character by character): every sentence of the answer is anchored to specific chunks. From the Gemini 2.5 technical report: Gemini 2.0 was <em>"the first family of models trained to natively call tools like Google Search"</em>; Gemini 2.5 <em>"interleaves search capabilities with internal thought processes"</em> for multi-hop queries. Search is interleaved with reasoning, not occasional.</p>
      <p>Scale: in mid-2025 the models powered ~1.5 billion monthly users in AI Overviews and ~400M in the Gemini app; at the end of 2025/early 2026 the official Alphabet numbers rise to <strong>2 billion</strong> users for AI Overviews and <strong>750 million</strong> MAU for the Gemini app (Q4 2025). AI Mode uses a <em>"custom version of Gemini"</em> with fan-out, which decomposes the query into many parallel sub-queries — the reason why pages not in the top 10 get cited. <strong>GEO consequence:</strong> optimising for Gemini means covering the <strong>tree of sub-questions</strong> of a topic, not a single keyword.</p>

      <!-- DEMO 3 -->
      <div class="demo" id="demo-fanout">
        <div class="demo-head"><span class="dot"></span>Demo 03 · Query fan-out<span class="tag">interactive</span></div>
        <div class="demo-body">
          <label for="fo-q">Your question to the AI</label>
          <input type="text" id="fo-q" value="what is the best city to move to for remote work?" autocomplete="off">
          <div style="margin-top:14px"><button id="fo-go">Run fan-out →</button> <button class="ghost" id="fo-reset">reset</button></div>
          <div class="fan-out" id="fo-out"></div>
        </div>
        <div class="demo-cap">A single question is broken down into several parallel sub-queries; each retrieves different sources — which is why pages not in the top 10 get cited, if they answer a sub-query well.</div>
      </div>

      <h4>Perplexity / Sonar</h4>
      <p>RAG with its own crawler (PerplexityBot) + realtime fetch (Perplexity-User). <strong>Sonar</strong> is the proprietary model built on open Llama architectures; at the product level it is multi-model and selects the best model at runtime per mode (search/reasoning/research). Pipeline: (1) <strong>query decomposition</strong>; (2) retrieval from its own index + realtime; (3) <strong>three-level reranking</strong> — Layer 1 candidate retrieval with classic scoring, Layer 2 ranking by authority/relevance, Layer 3 ML reranking that reportedly favours <strong>earned media from Tier-1 publications</strong> (a citation on TechCrunch or Forbes as an externally verified authority signal — independent analysis by Yeşilyurt, Aug 2025, <em>not officially confirmed</em>); (4) synthesis with inline citations. Citation is a "two-step dance": inclusion in the retrieval set, then selection of the paragraph. <strong>Freshness dominates:</strong> an article "updated 2 hours ago" was cited <strong>+38%</strong> more than its identical twin dated a month earlier; the stale twin rarely disappeared from the retrieval set but was demoted in the synthesis. ~780M queries in May 2025 (+20% MoM, Srinivas statement, Bloomberg Tech).</p>

      <h4>Claude — sentence-level citation</h4>
      <p>Retrieval via an external provider (Profound analyses indicate strong overlap with Brave Search) and fetch from the result URLs. The web search and citations tool documentation specifies that documents are split into chunks at <strong>sentence</strong> granularity: the output returns <code>cited_text</code> blocks, with <code>title</code> and <code>url</code>. Consequence: <strong>a well-built, self-contained sentence is the smallest citable unit</strong> — the most extreme case of the "the chunk is the unit of competition" principle. Three bots: ClaudeBot (training), Claude-User (fetch on user request), Claude-SearchBot (indexing). All declare that they respect robots.txt.</p>

      <h4>Microsoft Copilot — GEO in policy</h4>
      <p>Copilot is the only major engine that has <strong>codified GEO in its own official policy</strong>. Microsoft describes <strong>Prometheus</strong> as a model that combines <em>"the fresh and comprehensive Bing index, ranking, and answers results with the creative reasoning capabilities of … GPT models"</em>; the <strong>Bing Orchestrator</strong> <em>"generate[s] a set of internal queries iteratively"</em> — the internal query fan-out mechanism. The citations are numbered [1][2] linked to the source page. The rewrite of the <strong>Bing Webmaster Guidelines (27 Feb 2026)</strong> treats <em>"grounding results and citations"</em> as a <strong>separate eligibility outcome</strong> and introduces GEO as an official category: <code>NOARCHIVE</code> prevents the content from being used in Copilot answers; <code>NOCACHE</code> limits it to URL, title and snippet (Microsoft <strong>advises against</strong> it on pages you want cited); the <code>data-snippet</code> attribute controls which text Bing can show or cite (paragraph level). Seer (6 Feb 2025): 87% of SearchGPT citations coincide with Bing's top-20 organic (vs 56% for Google) — <em>an independent measurement of coincidence; the "~92% via Bing API" is an unconfirmed vendor claim</em>. <strong>IndexNow</strong> notifies Bing on every change; Google does not support it. Bing Webmaster Tools' <strong>AI Performance Report</strong> (public preview since Feb 2026) shows citation counts, cited URLs and a sample of the grounding queries.</p>

      <div class="tablewrap"><table>
        <tr><th>Dimension</th><th>ChatGPT</th><th>Gemini</th><th>Perplexity</th><th>Copilot</th><th>Claude</th></tr>
        <tr><td>Index/source</td><td>Third-party scraping (+Google traces)</td><td>Google index + KG + Shopping</td><td>Own index + realtime</td><td>Bing/Prometheus</td><td>External (Brave overlap)</td></tr>
        <tr><td>Retrieval bot</td><td>ChatGPT-User</td><td>Google-Extended / Search</td><td>Perplexity-User</td><td>bingbot / Bing</td><td>Claude-User / Claude-SearchBot</td></tr>
        <tr><td>Fan-out</td><td>Yes (web.run, 2-10+ rounds)</td><td>Yes (documented via API)</td><td>Yes (query decomposition)</td><td>Yes (Bing Orchestrator)</td><td>Yes (multiple searches)</td></tr>
        <tr><td>Citation</td><td>Inline, varies by model</td><td>sentence→chunk (groundingSupports)</td><td>Inline, paragraph</td><td>Numbered [1][2] + panel</td><td>Inline, sentence (cited_text)</td></tr>
        <tr><td>Distinctive</td><td>Few authoritative domains (Bigfoot)</td><td>Sub-question tree</td><td>Freshness + Tier-1</td><td>GEO in policy</td><td>Sentence granularity</td></tr>
        <tr><td>Transparency</td><td>Low (rev-eng)</td><td>Medium (official API)</td><td>Low-medium</td><td>High (docs + report)</td><td>Medium (docs)</td></tr>
      </table></div>
    </div>
  </div>
</section>

<!-- SEC 3 -->
<section id="s3">
  <div class="sec-grid">
    <div class="sec-aside"><span class="num">03</span><span class="lbl">Citability</span></div>
    <div class="sec-body">
      <h2>What makes content citable</h2>
      <h4>Tactics with empirical support</h4>
      <ul>
        <li><strong>Statistics and specific data</strong> (GEO paper: Statistics Addition +31%).</li>
        <li><strong>Source citations and quotations</strong> (Quotation Addition +41%, Cite Sources +28%).</li>
        <li><strong>Freshness</strong> (strong for Perplexity and news/trend queries).</li>
        <li><strong>Answer-first structure</strong> with a question heading and a direct answer in the first 40-60 tokens (alignment with the cross-encoder).</li>
        <li><strong>Authority/E-E-A-T</strong> and third-party citations; <strong>non-commodity content</strong> with first-hand experience (confirmed by Google's 2026 guidance).</li>
        <li><strong>Brand mentions:</strong> Previsible study on 1.96M sessions → brand search volume is the strongest predictor of AI citations (correlation 0.334), more than backlinks.</li>
      </ul>
      <p class="note">Caveat: vendor claims such as "data-rich cited 2.7x more" or "FCP &lt;0.4s = 6.7 citations" circulate but are not verifiable against a primary source — see the Anti-hype section.</p>
      <p><strong>Correlation with traditional ranking (conflicting data):</strong> in July 2025 Ahrefs found 76% overlap between AIO citations and the top 10, in January 2026 only 38% (partly due to better detection, partly to fan-out). Semrush: ~90% of ChatGPT citations from URLs outside Google's top 20. Ranking helps but is not a necessary condition.</p>
      <p><strong>robots.txt for AI crawlers:</strong> the 2024 "block all AI bots" strategy is counterproductive. Distinguish <strong>training</strong> bots (GPTBot, ClaudeBot, Google-Extended) from <strong>retrieval/search</strong> bots (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, PerplexityBot): blocking the latter removes the site from AI citations.</p>
    </div>
  </div>
</section>

<!-- SEC 4 market -->
<section id="s4">
  <div class="sec-grid">
    <div class="sec-aside"><span class="num">04</span><span class="lbl">IT/EU market</span></div>
    <div class="sec-body">
      <h2>The Italian and European market</h2>
      <h4>Adoption</h4>
      <p><strong>Eurostat 2025:</strong> use of GenAI tools in Italy at <strong>20%</strong>, below the EU average of 33% and far from Norway (56%) and Denmark (48%); it reflects the European north-south gap. ChatGPT in Europe: average monthly active users from 11.2 to 41.3 million by March 2025 (~+270%). Italy was the <strong>first country in the world</strong> to temporarily block ChatGPT (March 2023).</p>
      <h4>AI Overviews timing in Europe</h4>
      <p>They arrived in Italy on <strong>26 March 2025</strong> (alongside Austria, Belgium, Germany, Ireland, Poland, Portugal, Spain, Switzerland), ~10 months after the US, in Italian and on Gemini 2.0. They trigger for long-tail informational queries. AI Mode in Italian was not fully launched as of mid-2026.</p>
      <h4>The global landscape: the Chinese AI engines</h4>
      <p>Fragmentation is not only a Western affair. The Chinese market is the world's second pole, with a more crowded competition than the US one. <strong>Baidu ERNIE:</strong> ERNIE 4.5 open-sourced on 30 June 2025 (10 MoE variants up to 424B parameters, Apache 2.0 licence); ERNIE Assistant at <strong>202 million MAU</strong> in December 2025; in Q4 2025 subscription revenue from the AI accelerator infrastructure grew <strong>+143% YoY</strong> (up from +128% in Q3) and the call volume of the AI search API +110% QoQ (Baidu press release and earnings call, 26 February 2026). <strong>DeepSeek:</strong> cost-efficient open-source models that shook the market in early 2025; in mid-2025 one estimate attributed ~34% of the developer API share to DeepSeek vs ~18% for ERNIE; integrated into Baidu Search and Zhihu. <strong>The others:</strong> according to QuestMobile (via Caixin), in March 2026 <strong>Doubao (ByteDance) is in the lead with ~345 million MAU</strong>, ahead of Qwen (Alibaba, ~166M) and DeepSeek (~127M), with Tencent Yuanbao among the top four; the combined MAU of the main players exceed 900 million.</p>
      <p class="note">For an Italian freelancer these engines are <strong>context</strong>, not daily action. The point is structural: the GEO logic (retrieval, grounding, citations, fan-out) is substantially the same everywhere, and fragmentation is a global trend, not a Western anomaly. The Chinese MAU counts diverge widely between sources: they are estimates, always with source and date.</p>
    </div>
  </div>
</section>

<!-- SEC 4bis measurement -->
<section id="s4bis">
  <div class="sec-grid">
    <div class="sec-aside"><span class="num">04·B</span><span class="lbl">Measurement</span></div>
    <div class="sec-body">
      <h2>Testing GEO without fooling yourself</h2>
      <p>This is the section that separates serious work from theatre. Thesis: <strong>visibility in AI search is a distribution, not a score.</strong> Treating it like Google rank tracking is the underlying methodological error from which almost all the unreliable numbers in circulation derive.</p>
      <h4>Why a single measurement is useless (with the numbers)</h4>
      <p>The most rigorous figure comes from the paper <strong>"Don't Measure Once: Measuring Visibility in AI Search (GEO)"</strong> (Schulte et al., arXiv:2604.07585, 10 April 2026), which measured 4 engines × 8 prompts × 3 campaigns with 10 runs each (1,216-1,726 per-brand series). A single run has a standard error of <strong>0.370</strong> (95% CI ±0.724; Table 16, Appendix J): a true rate of 50% can appear <strong>anywhere between −22% and +122%</strong> — <em>"essentially uninformative"</em>, indistinguishable from noise. At <strong>7 runs</strong> the standard error drops to 0.081 (±0.158) and at <strong>8 runs</strong> to 0.062 (±0.121). The source overlap between two consecutive days can fall to <strong>34-42%</strong>. A second paper (Sielinski, March 2026, arXiv:2603.08924) converges: citation distributions follow a power law and 95% of ChatGPT Shopping titles appear in fewer than 30% of the runs of the same prompt. Minimum defensible floor: <strong>10+ runs per prompt</strong>.</p>

      <!-- DEMO 4 -->
      <div class="demo" id="demo-se">
        <div class="demo-head"><span class="dot"></span>Demo 04 · Standard error by number of runs<span class="tag">real data · Schulte 2026</span></div>
        <div class="demo-body">
          <label for="se-range">Repeated runs per prompt: <strong id="se-n">1</strong></label>
          <input type="range" id="se-range" min="1" max="9" value="1" step="1">
          <div class="se-readout">
            <div class="se-big" id="se-val">0.370<small>standard error</small></div>
            <div class="se-runs" id="se-ci">95% interval: ±0.724</div>
          </div>
          <div class="se-track"><div class="se-true"></div><div class="se-ci" id="se-band"></div></div>
          <div class="se-verdict bad" id="se-verdict"></div>
        </div>
        <div class="demo-cap">Exact values from Table 16 (Appendix J) of the paper. The red bar is the 95% confidence interval on a true rate of 50%: with 1 run it can swing from −22% to +122%. Move the slider.</div>
      </div>

      <h4>Citation drift: volatility over time</h4>
      <p>Volatility is not only run-to-run, it is also temporal. <strong>Monthly drift</strong> (% of domains present in July but absent in June for the same prompts): <strong>40-60%</strong> (Profound). <strong>Half-yearly drift:</strong> <strong>70-90%</strong> comparing January with July; BrightEdge reports a 70% churn of cited domains within six months (70× volatility gap). <strong>Platform shocks:</strong> the share of Reddit citations in ChatGPT collapsed from ~60% to ~10% in a few weeks in September 2025 (Semrush, 13 weeks); the model change of 4 March 2026 cut cited domains by 20% from one day to the next. Rule: <strong>measure with windows, not snapshots</strong> (weekly for strategic queries).</p>
      <h4>Minimum defensible protocol</h4>
      <ol>
        <li>Define <strong>20-30 prompts from a real buyer</strong>, not vanity brand queries ("what is the best X for Y", not "tell me about [my brand]").</li>
        <li>Run across multiple engines (ChatGPT, Perplexity, Google AI Overviews/AI Mode, Gemini) — visibility in one does not predict the others.</li>
        <li>Repeat each prompt <strong>7-10 times, spread over several days</strong> (not 10 times in the same minute).</li>
        <li>Log three things per run: whether you appeared, which publication was cited, which competitor was named in your place.</li>
        <li>Compute bootstrap confidence intervals on the detection rate per brand, not bare averages.</li>
        <li>Report <strong>per-engine</strong> (the cross-engine aggregate hides the patterns).</li>
        <li>To test a change: measure the baseline over a window, apply it, wait for the re-crawl, measure over an equivalent window. Compare distributions, not points. Use a <strong>control group</strong> (unmodified pages) to separate the effect from background drift.</li>
      </ol>
      <h4>Metrics that matter (and one to drop)</h4>
      <p>From Nick Lafferty's reference (2026) and the cited studies: <strong>Citation Share per engine</strong> (the central metric); <strong>Time-to-First-Citation</strong> (reported as a distribution — median, P75, P90 — never as an average); <strong>Inline Brand Hyperlink Share</strong> (the share of answers with a clickable link, its weight grown after the ChatGPT change of 7 May 2026 tripled B2B SaaS referrals); <strong>Co-citation Rate</strong>; <strong>Citation Rank Stability</strong> (the Schulte paper metric that almost all dashboards skip). <strong>To drop if you sell software/services:</strong> the <strong>Shopping Trigger Rate</strong> — across ~2 million prompts, 79% never triggered Shopping and only ~6% trigger reliably; the prompt category alone predicts the trigger with 95-97% accuracy.</p>
      <h4>Replicating the GEO paper yourself</h4>
      <p>The original GEO paper is replicable at low cost. (1) Take 10-20 target pages/chunks and create two variants: baseline and treated (+ cited statistics, or + quotations). (2) Build 30-50 realistic queries. (3) Submit the queries with search active, <strong>7-10 runs per query per variant</strong>, alternating the order to avoid position bias. (4) Measure the <strong>Position-Adjusted Word Count</strong>, in addition to presence/absence. (5) Compare the distributions with a non-parametric test (Mann-Whitney). Calibrated expectation: <strong>+20-40%</strong>, not "10x", with Statistics and Quotation as the strongest levers. If you see +300%, it is almost certainly noise from too small a sample.</p>
      <p class="note">Practical rule: if a GEO claim does not state how many times it repeated each prompt and over what period, it is anecdote. With SE 0.370 at one run, any two-decimal figure without repeated runs is statistically suspect.</p>
    </div>
  </div>
</section>

<!-- SEC 4ter law -->
<section id="s4ter">
  <div class="sec-grid">
    <div class="sec-aside"><span class="num">05</span><span class="lbl">EU/IT law</span></div>
    <div class="sec-body">
      <h2>The framework that constrains GEO in Europe</h2>
      <p>This section matters for an Italian freelancer more than it seems: the choices around <code>robots.txt</code>, licensing and handling client content have concrete legal implications under EU law, the most stringent in the world on AI and copyright.</p>
      <h4>TDM exception and opt-out (art. 4 CDSM): the legal cornerstone</h4>
      <p>The foundation of commercial AI training in Europe is <strong>Directive (EU) 2019/790 (CDSM)</strong>: <strong>art. 3</strong> covers TDM for <em>scientific</em> purposes (research organisations, not commercial AI); <strong>art. 4</strong> covers general (commercial) TDM, which became <em>"the cornerstone of commercial AI training in the EU"</em>, although it was added in the final stages of the legislative process without an impact assessment on GenAI. The key mechanism is the <strong>opt-out under art. 4(3):</strong> TDM is permitted by default <em>unless</em> a reservation is expressed in an appropriate manner, <em>"for instance by means of machine-readable tools"</em> for content publicly available online (Recital 18). The bridge to the <strong>AI Act:</strong> art. 53(1)(c) obliges GPAI model providers to <em>"identify and respect … the reservations of rights expressed pursuant to art. 4(3)"</em>; Recital 106 establishes a <strong>"Brussels effect"</strong> — the obligation applies to any provider placing a GPAI model on the EU market <em>"regardless of the jurisdiction in which the training acts take place"</em>. Even a model trained in the US, if offered in the EU, must respect European opt-outs.</p>
      <h4>The unresolved problem: what makes an opt-out "valid"</h4>
      <p>The directive does <strong>not prescribe a single technical standard</strong> and national case law diverges. <strong>Kneschke v. LAION</strong> (Hamburg Court, 27 Sep 2024): the construction of the dataset was covered by the German equivalent of art. 3, but with doubts about art. 4 for the downstream commercial exploitation; a later ruling held that an opt-out in <em>"natural language"</em> in the ToS may qualify as machine-readable. <strong>DPG Media v. HowardsHome</strong> (Amsterdam Court, late 2024): the reservation must be <em>"practically detectable and processable by automated systems"</em>. The two directions are <em>"markedly different"</em> → <strong>relying only on a clause in the terms of use is risky; a technical signal is also needed</strong> (robots.txt, metadata, headers). An additional argument (Synodinou-Vrakas, Nov 2025): datasets built by indiscriminate scraping may include works that are <em>publicly accessible but not "lawfully accessed"</em>, outside the protection of the TDM exception.</p>
      <h4>The EU Parliament's push to reform the opt-out</h4>
      <p>Within the own-initiative procedure <strong>2025/2058(INI)</strong> <em>"Copyright and generative AI"</em> (JURI committee, rapporteur <strong>Axel Voss</strong>), two distinct documents: (1) the <strong>JURI study PE 774095</strong> (Prof. Nicola Lucchi, <strong>9 July 2025</strong>), which concludes that training <em>"far exceeds the scope of the current TDM exceptions"</em>; (2) the <strong>draft report / Motion for a resolution PE775.433</strong> (<strong>27 June 2025</strong>), which calls for clearer rules, transparency on training data and a remuneration obligation. The resolution was adopted in plenary on <strong>10 March 2026</strong> (T10-0066/2026). The majority nonetheless considers a new legislative instrument <strong>unnecessary</strong> "at this stage" — a sign of unresolved political tension.</p>
      <h4>The Italian case: FIEG vs Google, the DSA and the opt-out dilemma</h4>
      <p><strong>15 October 2025:</strong> <strong>FIEG</strong> files a formal complaint with <strong>AGCOM</strong> against <strong>AI Overview and AI Mode</strong>, calling them <em>"traffic killers"</em>. The charge is not copyright but a <strong>breach of the DSA</strong>: they would amount to improper competition, a structural reduction in visibility and revenue, and <em>"a systemic risk to the economic sustainability of the entire information ecosystem"</em>. <strong>29 April 2026</strong> (a separate, subsequent act): following hearings with Google, FIEG and FISC, AGCOM — in its role as national Digital Services Coordinator — decides to <strong>refer to the European Commission, under art. 65 DSA, a request for assessment</strong> of Google's AI Overviews and AI Mode in relation to arts. 27, 34 and 35 DSA (systemic risks to pluralism and freedom of information; transparency of recommender systems). Press release of 30 April 2026; decision taken with the <strong>dissenting vote of Commissioner Elisa Giomi</strong>. It is a <strong>referral</strong> aimed at the possible opening of a Commission investigation — not an autonomous AGCOM sanctioning proceeding.</p>
      <blockquote>Exercising the opt-out (blocking AI crawlers) protects copyright but <strong>removes the content from generative answers</strong>, zeroing out GEO visibility. Publishers want to be able to opt out <em>without</em> losing visibility — but technically, today, the two are largely the same lever.</blockquote>
      <p>For an SME/e-commerce site (not a publisher) the rational choice is almost always to <strong>not</strong> opt out of <em>retrieval</em> bots (you want to be cited); opting out of <em>training</em> bots has near-zero cost in immediate visibility. They must be distinguished: blocking GPTBot (training) does not remove you from ChatGPT Search; blocking OAI-SearchBot/ChatGPT-User does.</p>
      <h4>The Privacy Authority (Garante) and GDPR: the Italian precedent</h4>
      <p>The <strong>Italian Garante</strong> was the first regulator in the world to restrict ChatGPT (31 March 2023, Order 112/2023): lack of a privacy notice, no legal basis for training, inadequate protection of minors. Reactivation on 28 April 2023 after corrective measures (privacy notice, right to object including for non-users, age verification). The 2024 fine (Order 755): <strong>€15 million</strong>; OpenAI appealed and the <strong>Court of Rome annulled the fine</strong> (judgment no. 4153/2026, filed on 18 March 2026), after which the order was removed from the Garante's website. <em>(The reasoning was not yet public as of mid-2026.)</em> The "right to object" extended to non-users is a privacy-based opt-out precedent parallel to the copyright one.</p>
      <h4>AI Act operational timeline</h4>
      <ul>
        <li><strong>1 August 2024:</strong> entry into force (Reg. EU 2024/1689).</li>
        <li><strong>2 August 2025:</strong> the obligations for GPAI models apply (copyright policy and a "sufficiently detailed summary" of training data); the GPAI Code of Practice published.</li>
        <li><strong>2 August 2026:</strong> full applicability, including the obligations to label AI-generated content and deepfakes.</li>
      </ul>
      <p>For a freelancer: the direct obligations fall on model <em>providers</em>, not on those who publish sites. But labelling clients' AI-generated content and correctly managing opt-out/licensing become part of professional due diligence.</p>
    </div>
  </div>
</section>

<!-- SEC 5 practice -->
<section id="s5">
  <div class="sec-grid">
    <div class="sec-aside"><span class="num">06</span><span class="lbl">Practice</span></div>
    <div class="sec-body">
      <h2>Operational implications</h2>
      <h4>What still holds from classic SEO</h4>
      <p>Crawlability and indexing (extended to Bing for ChatGPT and to AI retrieval bots); authority/E-E-A-T; semantic HTML and speed; server-side rendering (many AI bots fetch but do not execute JS).</p>
      <h4>What is new in GEO</h4>
      <p>Optimisation at the chunk/passage level (not the page); topical breadth for query fan-out (pillar + cluster); entity/brand building; surface diversification (YouTube, Reddit); indexing on Bing.</p>
      <h4>Operational recommendations in three phases</h4>
      <ol>
        <li><strong>Phase 1 — Technical foundations (immediate):</strong> verify indexing on Bing Webmaster Tools (a prerequisite for ChatGPT) and use IndexNow; audit robots.txt allowing the retrieval bots (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User) even while blocking training; server-side rendering of the key content and clean semantic HTML.</li>
        <li><strong>Phase 2 — Content (1-3 months):</strong> rewrite the top pages in answer-first format (question heading, direct answer in the first 40-60 tokens); add cited statistics and quotations (the levers with the most evidence); update the key content quarterly (freshness, especially for Perplexity); structure into self-contained chunks that cover the sub-questions (for fan-out), a pillar + cluster architecture — by writing well, not by splitting artificially.</li>
        <li><strong>Phase 3 — Authority and measurement (3-6 months):</strong> build brand mentions and third-party citations (G2/Trustpilot, digital PR, YouTube, Reddit; Wikipedia for entity grounding where relevant); implement an AI tracking tool (Otterly entry-level, Peec AI for European multilingual, Profound enterprise) and monitor trends with repeated runs, not snapshots.</li>
      </ol>
      <h4>Thresholds that change the choices</h4>
      <ul>
        <li>If traffic from AI search exceeds 1-2% (today typically &lt;1% but it converts better than organic), increase the GEO investment.</li>
        <li>If the overlap between AI citations and organic ranking is low, prioritise chunkability and authority.</li>
        <li>For Italy, monitor the launch of AI Mode in Italian and the evolution of the FIEG-AGCOM case and the EU copyright framework.</li>
      </ul>
    </div>
  </div>
</section>

<!-- SEC 6 antihype -->
<section id="s6">
  <div class="sec-grid">
    <div class="sec-aside"><span class="num">07</span><span class="lbl">Anti-hype</span></div>
    <div class="sec-body">
      <h2>What to debunk in the GEO discourse</h2>
      <p>This section isolates the GEO claims that circulate as truths but have weak, no, or contrary evidence. A single criterion: <strong>primary source or replicable experiment vs repetition among influencers.</strong></p>
      <h4>Google debunks 5 myths (15 May 2026)</h4>
      <p>On <strong>15 May 2026</strong> Google Search Central published the official guide <em>"Optimizing your website for generative AI features on Google Search"</em> (announced by John Mueller). It is the most explicit on-record statement on what works for AI Overviews and AI Mode. The underlying thesis: <strong>"AEO and GEO are still SEO"</strong>, because the AI features run on the same ranking systems as classic Search. Google classifies as <strong>unnecessary</strong>: (1) <strong><code>llms.txt</code> files and special markup</strong> — <em>"You don't need to create new machine readable files, AI text files, markup, or Markdown to appear in generative AI search"</em>; (2) <strong>content chunking</strong> — the systems <em>"are able to understand the nuance of multiple topics on a page"</em>; (3) <strong>AI-specific rewrites</strong>; (4) <strong>inauthentic mentions</strong> (artificial link-building and mentions); (5) <strong>excessive use of schema/structured data</strong>. What to <em>actually</em> do: solid SEO, non-commodity content with unique perspectives and first-hand experience, multimodal assets.</p>
      <p>Reinforcing the position, on <strong>5 June 2026</strong> Google published <em>"Google Search's guidance on using third-party SEO tools, services, and advice"</em> and updated <em>"Do you need an SEO?"</em>, explicitly naming <strong>AEO and GEO as service categories</strong>. Google <strong>legitimises the discipline</strong> but <strong>narrows its scope</strong> — it remains "still SEO" — and urges caution toward anyone promising shortcuts or guarantees of citation in AI answers.</p>
      <div class="panel">
        <h4>The honest tension over chunking</h4>
        <p style="margin:0">Google is right on one point: you don't have to <em>physically</em> split the page into micro-files or rewrite it in an "AI format" — its systems do the chunking on their side and understand multi-topic pages. But <strong>"manual chunking is not needed" ≠ "structure doesn't matter":</strong> RAG research shows that clean, self-contained chunks improve retrieval <em>all else being equal</em>, and you get them by <strong>writing well</strong> (clear headings, one idea per section, direct answers), not by manipulating the structure for the bot. A crucial distinction: the guidance applies to <em>Google</em> (which runs on Search ranking); for ChatGPT, Perplexity and Claude (their own RAG pipelines) structure remains more relevant. Generalising "chunking is dead" to all engines is over-extension. <strong>Verdict:</strong> stop selling "chunking optimisation" as a service in itself; keep writing well-structured content.</p>
      </div>
      <h4>llms.txt — the textbook case of hype</h4>
      <p>A proposal by Jeremy Howard (September 2024), a Markdown file in the root to help LLMs use a site at inference time; it was born for <em>technical documentation aimed at dev tools</em>, not as an SEO lever. The evidence against: Google <em>Search</em> states it does not use it; the 15 May 2026 guide says new machine-readable files, AI text files, markup or Markdown <em>"won't harm (nor help)"</em> visibility; Otterly detects 84 requests out of 62,100 in 90 days (0.1%); Ahrefs (15 June 2026 study, ~38,000 valid files across 137,210 domains) finds that <strong>97% of the files receive no requests</strong> and only 19.5% of fetches come from named AI tools; SE Ranking finds no correlation with citations and removing the variable improves the model. The new fact must not be misread: <strong>Lighthouse 13.3.0</strong> added <code>llms.txt</code> to the experimental <em>Agentic Browsing</em> category, but as an optional <strong>agentic readiness</strong> check, not as a Search ranking or citation signal. Lighthouse is developer diagnostics, not a search engine; the audit marks a 404 as <em>Not Applicable</em> and does not even assign a 0-100 score. <strong>Verdict:</strong> an AI-citation lever that is <strong>unproven, with mostly contrary evidence</strong>. If the CMS generates it at low cost it can remain future-facing infrastructure, but it must be versioned and protected: selling it as a GEO factor today is inflating a bet.</p>
      <h4>Serving pages in Markdown too — marginal, often hype</h4>
      <p>Is it worth publishing a Markdown version of pages to get cited better? <strong>For mainstream engines it is marginal/situational, not proven</strong>, and in some forms it is risky. Technical distinction: <strong>content negotiation</strong> via <code>Accept: text/markdown</code> on the <em>same</em> URL is legitimate, standard HTTP; <strong>separate <code>.md</code> files at separate URLs</strong> are defined by Google and Bing as potential cloaking and a doubling of the crawl budget. Search crawlers (GPTBot, OAI-SearchBot, ChatGPT-User, PerplexityBot, ClaudeBot, Googlebot, Bingbot) do <strong>not negotiate Markdown</strong> — only some coding agents do in a live session (Claude Code, Cursor, OpenCode — Checkly test, Feb 2026). Empirical evidence of a null/non-significant effect: Profound (a controlled experiment, 381 pages, Jan-Feb 2026) finds a ~16% lift that is <em>not statistically significant</em>, driven by outliers; Otterly finds 0% AI bot traffic and zero citations to <code>.md</code> files. The real advantage of Markdown is tokenisation (~80% fewer tokens according to Cloudflare), but it benefits those who <em>convert</em> the HTML (Jina Reader, Firecrawl, RAG pipelines, Claude Code via Turndown already do this). Google (15 May 2026): <em>"You don't need to create new machine readable files, AI text files, markup, or Markdown … as Google Search itself doesn't use them"</em>; Mueller (Feb 2026) calls converting pages just for the bots <em>"such a stupid idea"</em>. <strong>Verdict:</strong> useful only for technical/SaaS/API documentation consulted by agents in real time; for a generic site, clean semantic HTML matters far more. If you implement it, use content negotiation with <code>Vary: Accept</code>, never separately indexable <code>.md</code> files.</p>
      <h4>Schema/structured data — useful, but not for the reason you're told</h4>
      <p>The hype claim: "without schema.org you don't get cited by AI". Google (May 2026) declares it <strong>not required</strong> to generate AI answers; Pedro Dias and others have shown that schema does not influence ChatGPT citations. Correlation studies exist but are <strong>confounded by third variables</strong>: sites with schema also tend to be better maintained and more authoritative — the correlation does not isolate schema as the cause. <strong>Balanced verdict:</strong> it remains useful for its classic purposes (rich results, parsing, entity disambiguation) and for traditional Search, not as an "AI trick".</p>
      <h4>Vendors' bait numbers</h4>
      <p>Precise percentages without a named primary source: "data-rich cited 2.7x more", "FCP &lt;0.4s = 6.7 average citations", "well-organised headings = 2.8x more cited" (AirOps — the last at least has a declared dataset of 45,000 citations, more defensible). Methodology, sample size, number of runs and a control group are often missing. In light of SE 0.370 at one run, any two-decimal figure obtained without repeated runs is statistically suspect. <strong>Practical rule:</strong> if a claim does not state how many times it repeated each prompt and over what period, it is anecdote.</p>
      <h4>"SEO is dead" — the opposite over-extension</h4>
      <p>Equally false: the Ahrefs/Semrush data show that traditional organic ranking <strong>remains correlated</strong> (even if no longer a necessary condition) with AI citation; AI Overviews run <em>on top of</em> the Search ranking system; "parametric visibility" is built with the same signals as classic SEO (authority, press coverage, Wikipedia, backlinks, mentions). Google itself titles its position "AEO and GEO are still SEO". <strong>GEO is an extension of SEO, not a replacement.</strong> The foundations are <em>more</em> important, not less; what changes is the level of competition (chunk vs page), the surfaces and the metrics.</p>
      <div class="tablewrap"><table>
        <tr><th>GEO claim</th><th>Verdict</th><th>Priority</th></tr>
        <tr><td>Statistics + source citations</td><td><span class="badge b-ok">Proven</span></td><td>High</td></tr>
        <tr><td>Content freshness</td><td><span class="badge b-ok">Proven</span></td><td>High</td></tr>
        <tr><td>Non-commodity content / first-hand experience</td><td><span class="badge b-ok">Confirmed</span></td><td>High</td></tr>
        <tr><td>Answer-first structure</td><td><span class="badge b-ok">Solid</span></td><td>High</td></tr>
        <tr><td>Brand mentions &gt; backlinks</td><td><span class="badge b-warn">1 study</span></td><td>Medium</td></tr>
        <tr><td>Schema for AI citation</td><td><span class="badge b-warn">Overrated</span></td><td>Low</td></tr>
        <tr><td>Manual chunking</td><td><span class="badge b-bad">Myth (Google)</span></td><td>Low</td></tr>
        <tr><td>llms.txt as a lever</td><td><span class="badge b-bad">Unproven for citations</span></td><td>Very low</td></tr>
        <tr><td>Serving pages in Markdown</td><td><span class="badge b-warn">Marginal</span></td><td>Low</td></tr>
        <tr><td>"2.7x" bait numbers</td><td><span class="badge b-bad">Anecdote</span></td><td>Ignore</td></tr>
        <tr><td>"SEO is dead"</td><td><span class="badge b-bad">False</span></td><td>—</td></tr>
      </table></div>
      <div class="note"><strong>Underlying caveats.</strong> Distinguish documented facts from vendor claims: the Pew/SparkToro/Ahrefs/Seer indices and numbers are well documented; many precise "citation factors" come from unverifiable vendor blogs. The overlap between AIO citations and the top 10 varies between studies (38% vs 76%) partly due to methodological differences. Forecasts are forecasts (Gartner's 25% is a 2024 estimate). The details on ChatGPT's <code>web.run</code>, fan-out and system prompt derive from independent analyses (RESONEO/Meteoria, AirOps, Dejan), not from complete official documentation, and they change from one model to the next. Pipelines change quickly: every figure has a validity date. On Lighthouse, the "Agentic Browsing" category is experimental and can change; Chrome documentation does not prove <code>llms.txt</code> is used for Search citations.</div>
    </div>
  </div>
</section>

</div>
</main>

<footer>
  <div class="wrap">
    <h2>Primary sources</h2>
    <div class="biblio">
      <h4>Academic papers and benchmarks</h4>
      <ul>
        <li>Aggarwal P. et al., <em>GEO: Generative Engine Optimization</em>, arXiv:2311.09735 (KDD 2024) — <a href="https://arxiv.org/abs/2311.09735">arxiv.org/abs/2311.09735</a></li>
        <li>Schulte J. et al., <em>Don't Measure Once</em>, arXiv:2604.07585 (10 Apr 2026) — <a href="https://arxiv.org/abs/2604.07585">arxiv.org/abs/2604.07585</a></li>
        <li>Sielinski R., uncertainty in measuring AI visibility (Mar 2026), arXiv:2603.08924</li>
        <li>Gemini Team, <em>Gemini 2.5 Technical Report</em>, arXiv:2507.06261 — <a href="https://arxiv.org/pdf/2507.06261">arxiv.org/pdf/2507.06261</a></li>
        <li>Vecta Benchmark (Feb 2026); arXiv:2506.17277 (chemistry); arXiv:2512.05411 (enterprise); arXiv:2506.06339 (Arabic); MDPI Bioengineering (Nov 2025); BEIR arXiv:2104.08663; <em>LegalBench-RAG</em> arXiv:2408.10343</li>
        <li>Khattab O., Zaharia M., <em>ColBERT</em> (SIGIR 2020); Santhanam et al., <em>ColBERTv2/PLAID</em> (2022)</li>
      </ul>
      <h4>Retrieval / embeddings / chunking / reranking</h4>
      <ul>
        <li>Towards Data Science, <em>Advanced RAG Retrieval: Cross-Encoders &amp; Reranking</em> — <a href="https://towardsdatascience.com/advanced-rag-retrieval-cross-encoders-reranking/">towardsdatascience.com</a></li>
        <li>Pinecone, <em>Rerankers and Two-Stage Retrieval</em> — <a href="https://www.pinecone.io/learn/series/rag/rerankers/">pinecone.io</a>; Weaviate, <em>Late Interaction</em> — <a href="https://weaviate.io/blog/late-interaction-overview">weaviate.io</a>; Qdrant, <em>Late Interaction Models</em> — <a href="https://qdrant.tech/articles/late-interaction-models/">qdrant.tech</a></li>
        <li>Firecrawl, <em>Best Chunking Strategies for RAG (2026)</em> — <a href="https://www.firecrawl.dev/blog/best-chunking-strategies-rag">firecrawl.dev</a>; Chroma, <em>Context Rot research</em> (Jul 2025)</li>
      </ul>
      <h4>Engine reverse-engineering</h4>
      <ul>
        <li>de Segonzac O. (RESONEO/Meteoria), <em>Inside ChatGPT Search: web.run</em>, Search Engine Land (14 May 2026) — <a href="https://searchengineland.com/inside-chatgpt-search-web-run-fan-out-queries-ai-visibility-477339">searchengineland.com</a>; study: <a href="https://think.resoneo.com/chatgpt/5.3-5.4/">think.resoneo.com</a></li>
        <li>Google, <em>Gemini API — Grounding</em> (groundingMetadata) — <a href="https://ai.google.dev/gemini-api/docs/google-search">ai.google.dev</a></li>
        <li>Yeşilyurt M., Perplexity reranking (Aug 2025), via Search Engine Land; AuthorityTech, <em>How Perplexity Selects Sources</em> — <a href="https://authoritytech.io/blog/how-perplexity-selects-sources-algorithm-2026">authoritytech.io</a>; GrowthMarshal <em>Perplexity Playbook</em>; RankStudio <em>Sonar &amp; PPLX Deep Dive</em></li>
        <li>Anthropic, <em>Web search tool — Claude API Docs</em> — <a href="https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool">platform.claude.com</a>; Seer Interactive, <em>SearchGPT ↔ Bing 87%</em> (Feb 2025)</li>
      </ul>
      <h4>Microsoft Copilot / Bing</h4>
      <ul>
        <li>Microsoft Bing Blog, <em>Building the New Bing</em> (Prometheus, Bing Orchestrator) — <a href="https://blogs.bing.com/search-quality-insights/february-2023/Building-the-New-Bing">blogs.bing.com</a></li>
        <li>Bing Webmaster Guidelines (rewrite 27 Feb 2026); NOARCHIVE/NOCACHE/data-snippet analysis (SEJ, WrittenlyHub); Seer Interactive, <em>87% SearchGPT ↔ Bing</em> — <a href="https://www.seerinteractive.com/insights/searchgpt-citations-bing">seerinteractive.com</a>; Microsoft <em>IndexNow</em> and <em>AI Performance Report</em> (Feb 2026)</li>
      </ul>
      <h4>Chinese AI engines</h4>
      <ul>
        <li>Baidu, <em>Q4 &amp; FY2025 Results</em> (26 Feb 2026) — <a href="https://ir.baidu.com/news-releases/news-release-details/baidu-announces-fourth-quarter-and-fiscal-year-2025-results">ir.baidu.com</a>; earnings call via Investing.com</li>
        <li>ERNIE 4.5 open-source (30 Jun 2025, Apache 2.0) — @Baidu_Inc, TechNode, SCMP; DeepSeek ~34% vs ERNIE ~18% (mid-2025) — SiliconANGLE, TechRadar Pro; QuestMobile via Caixin (Doubao ~345M MAU, Mar 2026)</li>
      </ul>
      <h4>Measurement / volatility</h4>
      <ul>
        <li>Profound, <em>AI Search Volatility</em> — <a href="https://www.tryprofound.com/blog/ai-search-volatility">tryprofound.com</a>; AirOps, <em>AI Visibility Metrics</em> — <a href="https://www.airops.com/blog/ai-visibility-metrics">airops.com</a></li>
        <li>Lafferty N., <em>AI Visibility Metrics Reference (2026)</em> — <a href="https://nicklafferty.com/blog/ai-visibility-metrics-reference/">nicklafferty.com</a>; Machine Relations, <em>Citation Drift</em> (BrightEdge 70x, Semrush Reddit 60→10%) — <a href="https://medium.com/machine-relations/citation-drift-ai-visibility-data-d7c2eea8e223">medium.com/machine-relations</a></li>
      </ul>
      <h4>Official Google guidance and anti-hype</h4>
      <ul>
        <li>Google Search Central, <em>A new resource for optimizing for generative AI in Search</em> (15 May 2026) — <a href="https://developers.google.com/search/blog/2026/05/a-new-resource-for-optimizing">developers.google.com</a>; <em>third-party SEO tools/services</em> and <em>Do you need an SEO?</em> (5 Jun 2026, naming AEO/GEO) — <a href="https://www.digitalapplied.com/blog/google-official-seo-docs-generative-ai-optimization-june-2026">digitalapplied.com</a></li>
        <li>Search Engine Journal, <em>AEO And GEO 'Still SEO'</em> — <a href="https://www.searchenginejournal.com/googles-new-ai-search-guide-calls-aeo-and-geo-still-seo/575026/">searchenginejournal.com</a>; Search Engine Land, <em>GEO myths</em> — <a href="https://searchengineland.com/geo-myths-lies-467617">searchengineland.com</a></li>
        <li>Wix Studio, <em>Debunking LLMs.txt Myths</em> — <a href="https://www.wix.com/studio/ai-search-lab/llms-txt-myths">wix.com/studio</a>; Ahrefs, <em>97% of llms.txt files never get read</em> — <a href="https://ahrefs.com/blog/llmstxt-study/">ahrefs.com</a>; SE Ranking — <a href="https://seranking.com/blog/llms-txt/">seranking.com</a>; Otterly — <a href="https://otterly.ai/blog/the-llms-txt-experiment/">otterly.ai</a>; SEJ, <em>Mueller: llms.txt Can't Help LLMs Differentiate Sites</em> — <a href="https://www.searchenginejournal.com/googles-mueller-says-llms-txt-cant-help-llms-differentiate-sites/579304/">searchenginejournal.com</a>; Chrome Lighthouse Agentic Browsing — <a href="https://developer.chrome.com/docs/lighthouse/agentic-browsing/llms-txt">developer.chrome.com</a>; Lighthouse 13.3.0 changelog — <a href="https://github.com/GoogleChrome/lighthouse/blob/main/changelog.md">github.com</a></li>
        <li>Markdown for pages — Google <em>AI optimization guide</em> — <a href="https://developers.google.com/search/docs/fundamentals/ai-optimization-guide">developers.google.com</a>; Profound <em>Markdown vs HTML</em> — <a href="https://www.tryprofound.com/blog/does-markdown-increase-ai-bot-traffic">tryprofound.com</a>; Otterly <em>Markdown vs HTML</em> — <a href="https://otterly.ai/blog/geo-experiment-html-vs-markdown/">otterly.ai</a>; Checkly <em>content negotiation</em> — <a href="https://www.checklyhq.com/blog/state-of-ai-agent-content-negotation/">checklyhq.com</a>; Cloudflare <em>Markdown for Agents</em> — <a href="https://blog.cloudflare.com/markdown-for-agents/">blog.cloudflare.com</a>; Search Engine Land — <a href="https://searchengineland.com/google-bing-dont-recommend-seperate-markdown-pages-for-llms-468365">searchengineland.com</a></li>
      </ul>
      <h4>EU/Italy legal framework</h4>
      <ul>
        <li>Directive (EU) 2019/790 (CDSM), arts. 3-4; AI Act (Reg. EU 2024/1689), art. 53(1)(c), Recital 106; EPRS, <em>AI and copyright</em> — <a href="https://www.europarl.europa.eu/RegData/etudes/ATAG/2025/769585/EPRS_ATA(2025)769585_EN.pdf">europarl.europa.eu</a></li>
        <li>EU Parliament 2025/2058(INI) (rapporteur Voss): JURI study PE 774095 (Lucchi, 9 Jul 2025), draft report PE775.433 (27 Jun 2025), resolution T10-0066/2026 (10 Mar 2026) — <a href="https://oeil.secure.europarl.europa.eu/oeil/en/procedure-file?reference=2025/2058(INI)">oeil.europarl.europa.eu</a>; Jones Day, <em>EP study on GenAI and copyright</em> — <a href="https://www.jonesday.com/en/insights/2025/08/european-parliaments-new-study-on-generative-ai-and-copyright-calls-for-overhaul-of-optout-regime">jonesday.com</a></li>
        <li>Kluwer Copyright Blog, <em>The TDM Opt-Out in the EU</em> — <a href="https://legalblogs.wolterskluwer.com/copyright-blog/the-tdm-opt-out-in-the-eu-five-problems-one-solution/">legalblogs.wolterskluwer.com</a>; Synodinou-Vrakas, <em>Lawful Access as a Gatekeeper for TDM</em>, Verfassungsblog (17 Nov 2025) — <a href="https://verfassungsblog.de/lawful-access-gatekeeper/">verfassungsblog.de</a>; Kneschke v. LAION (Hamburg, 27 Sep 2024); DPG Media v. HowardsHome (Amsterdam)</li>
        <li>Agenda Digitale, <em>Italian publishers (FIEG) against Google's AI</em> — <a href="https://www.agendadigitale.eu/mercati-digitali/editori-italiani-fieg-contro-lai-di-google-ecco-le-basi-del-reclamo-agcom/">agendadigitale.eu</a>; Key4biz, <em>FIEG against Google</em> — <a href="https://www.key4biz.it/fieg-contro-google-ai-overview-e-un-traffic-killer-chiesto-lintervento-dellagcom-per-violazione-del-dsa/550920/">key4biz.it</a>; AGCOM, referral under art. 65 DSA (29 Apr 2026, press release 30 Apr 2026) — ANSA, Primaonline; Agenda Digitale — <a href="https://www.agendadigitale.eu/mercati-digitali/ai-di-google-e-giornali-la-palla-e-nel-campo-dellue-il-quadro/">agendadigitale.eu</a></li>
        <li>Garante Privacy, Orders 112/2023 and 755/2024; Court of Rome judgment 4153/2026 (annulment of the fine) — Altalex; Eurostat via Euronews, GenAI adoption in Europe — <a href="https://www.euronews.com/next/2025/12/29/chatgpt-gemini-grok-and-others-which-countries-use-generative-ai-tools-most-across-europe">euronews.com</a></li>
      </ul>
      <h4>GEO measurement tools</h4>
      <ul>
        <li>Surmado, <em>Best AI Visibility Tools 2026</em> — <a href="https://www.surmado.com/blog/best-ai-visibility-tools-2026">surmado.com</a>; Otterly.ai — <a href="https://otterly.ai/">otterly.ai</a></li>
      </ul>
    </div>
    <div class="foot-meta">
      White paper curated by Federico Calicchia · written with the support of Claude Opus 4.8 (Anthropic). Last updated: 22 June 2026.<br>
      Demos 01-03 are client-side educational simulations (not real engines); demo 04 uses the exact data from the Schulte et al. paper. Given the speed of the sector's evolution, the statistics and mechanisms described have a limited shelf life.
    </div>
  </div>
</footer>`;
