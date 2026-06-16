/**
 * EN translation of the "Dalla SEO alla GEO" white paper body.
 * Mirrors the IT body in geo-whitepaper.ts 1:1 in structure: same tags,
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
        <div class="meta-row"><span>Last updated · 16 June 2026</span></div>
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
      <p>On that mechanism — crawling, indexing, ranking, click-through — an entire discipline was built, SEO, and with it the economic model of the open web. Generative engines (Google with AI Overviews and AI Mode, ChatGPT, Perplexity, Microsoft Copilot, Claude) no longer return primarily a list of links: they read the web on the user's behalf, synthesise an answer and cite a handful of sources. The click, which used to be the goal, becomes the exception.</p>
      <p>The unit of competition changes (no longer the page but the single citable <em>chunk</em>), the metrics change (from SERP position to share of citation), the players change (a fragmented archipelago, including beyond the West). From here GEO is born, <em>Generative Engine Optimization</em>.</p>
      <p>This document has three aims: to explain <strong>how the engines really work</strong> at the level of retrieval and source selection; to <strong>distinguish what is documented</strong> from what is inferred or merely asserted by vendors; and to <strong>place the phenomenon in the Italian and European context</strong>. The tone is educational and analytical: understand the mechanism, not sell a recipe.</p>
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
        <li><div>Zero-click is structural: in 2024, 58.5% of US Google searches ended without a click (SparkToro/Datos), rising to <strong>68.01%</strong> in early 2026. With an AI Overview, the organic CTR of the top page drops by <strong>47-61%</strong> depending on the study.</div></li>
        <li><div>GEO originates from the paper by Aggarwal et al. (KDD 2024): statistics, citations and quotations raise visibility <strong>"by up to 40%"</strong>; keyword stuffing is the only tested method that <em>worsens</em> it.</div></li>
        <li><div>Each engine has a different pipeline (ChatGPT on Bing/scraping, Perplexity with its own crawler, Claude on Brave, Copilot on Bing/Prometheus, Gemini with fan-out): all of them use RAG, embeddings and chunk-level selection.</div></li>
        <li><div>AI visibility is a distribution, not a score: a single measurement has a standard error of <strong>0.370</strong> (useless); you need 7-10+ runs per prompt (paper "Don't Measure Once").</div></li>
        <li><div>Google itself (May 2026) declares that <strong>"GEO is still SEO"</strong> and debunks 5 myths, among them llms.txt and manual chunking.</div></li>
      </ul>
    </div>
  </div>
</section>

<!-- SEC 1 -->
<section id="s1">
  <div class="sec-grid">
    <div class="sec-aside"><span class="num">01</span><span class="lbl">Fundamentals</span></div>
    <div class="sec-body">
      <h2>The evolution from SEO to GEO</h2>
      <h4>Traditional search</h4>
      <p>Classic SEO rests on three phases: <strong>crawling</strong> (a bot discovers and downloads pages), <strong>indexing</strong> (storage in an index), <strong>ranking</strong> (the ordering that produces the SERP). The economic model was the <strong>click-through</strong>.</p>
      <h4>AI-driven search</h4>
      <p>Generative engines <strong>synthesise an answer</strong> from multiple sources with an LLM, citing some of them inline → <strong>zero-click</strong> answers. Google integrated the paradigm with AI Overviews (boxes at the top of the SERP) and AI Mode (a conversational experience).</p>
      <h4>Timeline of turning points</h4>
      <ul>
        <li>May 2023: Google announces SGE in Search Labs.</li>
        <li>14 May 2024: AI Overviews launched in the US.</li>
        <li>31 Oct 2024: OpenAI launches ChatGPT Search.</li>
        <li>5 Mar 2025: AIO on Gemini 2.0; AI Mode in Labs.</li>
        <li>26 Mar 2025: AI Overviews reach Italy.</li>
        <li>20 May 2025: AI Mode extended to the whole US.</li>
        <li>15 May 2026: official Google guidance on GEO.</li>
        <li>5 Jun 2026: Google names AEO/GEO as a category of SEO service.</li>
      </ul>
      <h4>The founding paper</h4>
      <p><strong>Aggarwal et al.</strong> (IIT Delhi/Princeton/Allen AI), KDD 2024 (arXiv:2311.09735). On <strong>GEO-bench</strong> (10,000 queries) they tested 9 methods. The best: Quotation Addition <strong>+41%</strong>, Statistics Addition +31%, Cite Sources +28%, Fluency Optimization +28%. <strong>Keyword stuffing</strong> is the only one that worsens it (−8%). Cite Sources raised the visibility of fifth-position sites by <strong>115%</strong>: GEO favours those who start behind. The Fluency + Statistics combination beats every single method by more than 5.5%. Real-world validation on Perplexity: up to +37%.</p>
      <h4>Behaviour has changed</h4>
      <ul>
        <li><strong>SparkToro/Similarweb (2026):</strong> 68.01% of US Google searches without a click (+7.56 points since 2024).</li>
        <li><strong>Ahrefs (Dec 2025):</strong> an AIO correlates with an average CTR of −58% for the top page.</li>
        <li><strong>Pew Research (Jul 2025):</strong> across 68,879 real searches, clicks on a traditional link at 8% with an AIO vs 15% without; only 1% click a cited source; 26% of sessions with an AIO end entirely. Google contested the methodology.</li>
        <li><strong>Seer (Sep 2025, &gt;25M impressions):</strong> organic CTR for queries with an AIO −61% (1.76% → 0.61%).</li>
        <li><strong>Gartner (Feb 2024):</strong> forecast of −25% in traditional search volume by 2026 (a forecast, not a final figure).</li>
        <li><strong>Publishers:</strong> Press Gazette/Chartbeat −33% global Google traffic in 2025 (−38% US, −17% Europe); the damage scales with site size.</li>
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
      <p>All of them use some form of <strong>RAG (Retrieval-Augmented Generation)</strong>: they retrieve fresh content from the web and use it to build the answer. The underlying technical thesis: <strong>the page is no longer the unit of competition, the chunk is.</strong></p>

      <h3>2-bis · The three families of retrieval</h3>
      <p><strong>Dense (bi-encoder):</strong> query and document encoded separately into a vector; fast (ANN over pre-computed vectors) but "compresses all the meaning into a single vector before any comparison" — a chunk with three concepts produces an ambiguous "average" vector. <strong>Sparse (BM25, SPLADE):</strong> exact lexical match, unbeatable on proper nouns and codes. <strong>Late interaction (ColBERT):</strong> token-level embeddings, MaxSim computation; more explainable but storage-expensive (BEIR: ~20GB/1M docs vs 0.4GB for BM25 and ~3GB for dense; ColBERTv2 compresses heavily via quantization). <strong>Hybrid dense+sparse approaches beat every single method</strong>.</p>

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
      <p>Three operational implications: (1) <strong>the same model is mandatory</strong> for index and query, otherwise the vectors live in misaligned spaces — cause #1 of silently broken RAG; (2) <strong>context rot</strong> — Chroma's research (Jul 2025, 18 models including GPT-4.1/Claude 4/Gemini 2.5) shows that retrieval degrades as context length grows, even on simple tasks; (3) an average vector is not a good vector.</p>

      <h3>2-bis · Chunking</h3>
      <p>Common sense says "semantic chunking is best"; the benchmarks say the opposite. <strong>Vecta Benchmark (Feb 2026):</strong> recursive at 512 tokens first (69%), semantic at 54% (fragments of ~43 tokens). <strong>MDPI Bioengineering (Nov 2025):</strong> in the clinical domain, adaptive 87% vs 13-50% for fixed (p=0.001). <strong>arXiv 2506.17277 (chemistry):</strong> recursive up to +45% domain-weighted. <strong>arXiv 2512.05411 (enterprise):</strong> on well-structured documents, naive beats semantic and recursive. <strong>arXiv 2506.06339 (Arabic):</strong> sentence-aware best, semantic worst. They do not reconcile — that is the point: <strong>no strategy is universally optimal</strong>. Robust default: recursive at 400-512 tokens with 10-20% overlap. <strong>Content structure is the chunking you can control.</strong></p>

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
      <p>Two-stage retrieval: <strong>recall</strong> (a wide net, 20-150 candidates via bi-encoder/BM25) and <strong>precision</strong> (a cross-encoder re-evaluates each query-chunk pair <em>together</em>, keeping the top 3-8). Numbers: a lightweight cross-encoder ~50ms/20 docs, Cohere Rerank ~200ms, an LLM reranker 1-3s; a gain of +5-15 points nDCG@10. The cross-encoder rewards <strong>direct and specific relevance</strong> — the mechanical foundation of why answer-first works.</p>

      <div class="panel">
        <h4>From the mechanism to the markup rule</h4>
        <div class="tablewrap"><table>
          <tr><th>Mechanical fact</th><th>Rule for the content</th></tr>
          <tr><td>Dense compresses everything into one vector</td><td>One idea per section; don't mix 3 themes</td></tr>
          <tr><td>Sparse rewards exact match</td><td>Include exact terms/codes/names</td></tr>
          <tr><td>Hybrid beats single methods</td><td>Clear concepts <em>and</em> precise terminology</td></tr>
          <tr><td>Context rot</td><td>Answer up top, not halfway down the page</td></tr>
          <tr><td>Clear headings = sharp boundaries</td><td><code>&lt;h2&gt;</code> as a question + answer below</td></tr>
          <tr><td>Cross-encoder rewards direct relevance</td><td>Answer-first: the answer in the first 40-60 tokens</td></tr>
        </table></div>
      </div>

      <h3>2-ter · Per-engine reverse-engineering</h3>
      <p class="note">Epistemic caveat: what follows mixes <strong>official facts</strong> (documentation, APIs), <strong>reverse-engineering analyses</strong> not confirmed by the makers, and <strong>vendor claims</strong>. I flag each case as it comes. This area changes with every model update.</p>

      <h4>ChatGPT — the web.run tool</h4>
      <p>RESONEO/Meteoria study (Search Engine Land, May 2026): an internal <code>web.run</code> tool with <strong>12 operations</strong>, fan-out of 2-10+ rounds, a separate product fan-out (<code>browse_rewritten_queries</code>: a shopping search for each individual product). With the switch to GPT-5.3 (4 Mar 2026) the average number of cited domains <strong>dropped from 19 to 15 (−20%)</strong> — the "Bigfoot Effect": concentration on a few authoritative domains. It is <code>ChatGPT-User</code> that fetches the pages during the conversation. Reddit is exempt from copyright limits in the reconstructed system prompt. <em>(Reverse-engineering.)</em> Key point: the model formulates queries pointing at sources it <strong>already knows</strong> (parametric visibility) — a brand absent from the model's memory is not even considered a candidate.</p>

      <h4>Gemini / AI Mode — documented fan-out</h4>
      <p>Here there is <strong>official documentation</strong>: the grounding API returns <code>webSearchQueries</code> (the queries actually executed), <code>groundingChunks</code> (the sources) and <code>groundingSupports</code> (sentence→chunk mapping, with startIndex/endIndex). From the Gemini 2.5 report: search is "interleaved with reasoning". At the end of 2025 the models power <strong>2 billion</strong> users in AI Overviews and <strong>750M</strong> in the Gemini app. Optimising for Gemini = covering the <strong>tree of sub-questions</strong> of a topic.</p>

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
      <p>RAG with its own crawler (PerplexityBot) + realtime fetch. Pipeline: query decomposition → retrieval → <strong>three-level reranking</strong> (L3 reportedly favours Tier-1 earned media — independent analysis by Yeşilyurt, Aug 2025, unconfirmed) → synthesis with citations. <strong>Freshness dominates:</strong> content "updated 2 hours ago" was cited +38% more than its dated twin. ~780M queries in May 2025 (+20% MoM, CEO statement).</p>

      <h4>Claude — sentence-level citation</h4>
      <p>Retrieval via an external provider (overlap with Brave). The Citations API splits documents into chunks at <strong>sentence</strong> granularity: the output returns <code>cited_text</code>, <code>title</code>, <code>url</code>. A well-built, self-contained sentence is the smallest citable unit. Three bots: ClaudeBot (training), Claude-User (fetch), Claude-SearchBot (indexing).</p>

      <h4>Microsoft Copilot — GEO in policy</h4>
      <p><strong>Prometheus</strong> model on the Bing index; the "Bing Orchestrator" generates iterative internal queries (fan-out). The Webmaster Guidelines (rewritten 27 Feb 2026) treat citations and grounding as a <strong>separate eligibility outcome</strong> and introduce GEO as an official category: <code>NOARCHIVE</code> prevents citation, <code>NOCACHE</code> limits it (not recommended), <code>data-snippet</code> controls it at the paragraph level. Seer (Feb 2025): 87% of SearchGPT citations coincide with the top Bing results <em>(independent measurement; the "92% via Bing API" is an unconfirmed claim)</em>. IndexNow notifies Bing; Google does not support it.</p>

      <div class="tablewrap"><table>
        <tr><th>Dimension</th><th>ChatGPT</th><th>Gemini</th><th>Perplexity</th><th>Copilot</th><th>Claude</th></tr>
        <tr><td>Index/source</td><td>Third-party scraping (+Google traces)</td><td>Google index + KG</td><td>Own index + realtime</td><td>Bing/Prometheus</td><td>External (Brave overlap)</td></tr>
        <tr><td>Fan-out</td><td>Yes (web.run)</td><td>Yes (API)</td><td>Yes (decomposition)</td><td>Yes (Orchestrator)</td><td>Yes</td></tr>
        <tr><td>Citation</td><td>Inline, variable</td><td>sentence→chunk</td><td>Inline, paragraph</td><td>Numbered [1][2]</td><td>Inline, sentence</td></tr>
        <tr><td>Distinctive</td><td>Few authoritative domains</td><td>Sub-question tree</td><td>Freshness + Tier-1</td><td>GEO in policy</td><td>Sentence granularity</td></tr>
        <tr><td>Transparency</td><td>Low (rev-eng)</td><td>Medium (API)</td><td>Low-medium</td><td>High</td><td>Medium (docs)</td></tr>
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
        <li><strong>Statistics and specific data</strong> (GEO paper: +31%).</li>
        <li><strong>Citations and quotations of sources</strong> (Quotation +41%, Cite Sources +28%).</li>
        <li><strong>Freshness</strong> (strong for Perplexity and news/trend queries).</li>
        <li><strong>Answer-first structure</strong> (alignment with the cross-encoder).</li>
        <li><strong>Authority/E-E-A-T</strong> and non-commodity content with first-hand experience (confirmed by Google 2026).</li>
        <li><strong>Brand mentions:</strong> Previsible study (1.96M sessions) → brand search volume is the strongest predictor of AI citations (corr. 0.334), more than backlinks.</li>
      </ul>
      <p><strong>Correlation with traditional ranking (conflicting data):</strong> Ahrefs found 76% overlap between AIO citations and the top 10 in July 2025, only 38% in January 2026. Semrush: ~90% of ChatGPT citations from URLs outside Google's top 20. Ranking helps but is not a necessary condition.</p>
      <p><strong>robots.txt for AI crawlers:</strong> "blocking all AI bots" is counterproductive. Distinguish <strong>training</strong> bots (GPTBot, ClaudeBot, Google-Extended) from <strong>retrieval</strong> bots (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, PerplexityBot): blocking the latter removes you from the pool of citations.</p>
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
      <p><strong>Eurostat 2025:</strong> GenAI use in Italy at 20%, below the EU average of 33% and far from Norway (56%) and Denmark (48%). ChatGPT in Europe: from 11.2 to 41.3M average monthly users by March 2025 (~+270%). Italy was the first country in the world to temporarily block ChatGPT (March 2023).</p>
      <h4>AI Overviews timing</h4>
      <p>In Italy since <strong>26 March 2025</strong> (alongside Austria, Belgium, Germany, Ireland, Poland, Portugal, Spain, Switzerland), ~10 months after the US, on Gemini 2.0. AI Mode in Italian was not fully launched as of mid-2026.</p>
      <h4>The global landscape: the Chinese engines</h4>
      <p>Fragmentation is not only a Western affair. <strong>Baidu ERNIE:</strong> ERNIE 4.5 open-source since 30 June 2025 (Apache 2.0 licence); ERNIE Assistant at <strong>202M MAU</strong> (Dec 2025); in Q4 2025 subscription revenue from the AI accelerator infrastructure grew <strong>+143% YoY</strong> (up from +128% in Q3), and the call volume of the AI search API +110% QoQ (source: Baidu earnings call, 26 Feb 2026). <strong>DeepSeek:</strong> cost-efficient open-source models; in mid-2025 one estimate attributed ~34% of the developer API share to DeepSeek vs ~18% for ERNIE. <strong>Doubao (ByteDance):</strong> in the lead in March 2026 with ~345M MAU (QuestMobile), ahead of Qwen (~166M) and DeepSeek (~127M); the main players together exceed 900M users.</p>
      <p class="note">For an Italian freelancer these engines are <strong>context</strong>, not daily action. The point is structural: the GEO logic (retrieval, grounding, citations, fan-out) is the same everywhere. The Chinese MAU counts diverge widely between sources: they are estimates, always with source and date.</p>
    </div>
  </div>
</section>

<!-- SEC 4bis measurement -->
<section id="s4bis">
  <div class="sec-grid">
    <div class="sec-aside"><span class="num">04·B</span><span class="lbl">Measurement</span></div>
    <div class="sec-body">
      <h2>Testing GEO without fooling yourself</h2>
      <p>Thesis: <strong>visibility in AI search is a distribution, not a score.</strong> From the paper "Don't Measure Once" (Schulte et al., arXiv:2604.07585, Table 16): a single run has a standard error of <strong>0.370</strong> (95% CI ±0.724) — effectively uninformative. At 7 runs SE 0.081, at 8 runs 0.062. Source overlap between two consecutive days falls to 34-42%.</p>

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

      <h4>Citation drift</h4>
      <p>Monthly 40-60%, half-yearly 70-90% (Profound, over 240M citations); BrightEdge: 70× volatility gap; Reddit in ChatGPT from ~60% to ~10% in a few weeks (Semrush). Measure with windows, not snapshots.</p>
      <h4>Minimum defensible protocol</h4>
      <ol>
        <li>20-30 prompts from a real buyer (not vanity brand queries).</li>
        <li>Run across multiple engines — visibility in one does not predict the others.</li>
        <li>7-10 runs per prompt, spread over several days.</li>
        <li>Log: whether you appeared, which source was cited, which competitor was in your place.</li>
        <li>Bootstrap intervals, per-engine reporting, a control group (unmodified pages) to separate the effect from background drift.</li>
      </ol>
      <h4>Metrics that matter</h4>
      <p>Citation Share per engine; Time-to-First-Citation (as a distribution, not an average); Inline Brand Hyperlink Share; Co-citation Rate; Citation Rank Stability. To drop if you sell software/services: the Shopping Trigger Rate (79% of prompts never trigger Shopping).</p>
      <h4>Replicating the GEO paper</h4>
      <p>Two variants (baseline vs +statistics/quotations), 30-50 queries, 7-10 runs per variant alternating the order, measure the Position-Adjusted Word Count, non-parametric comparison (Mann-Whitney). Calibrated expectation: +20-40%, not "10x". If you see +300%, it is noise from a small sample.</p>
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
      <h4>TDM exception and opt-out (art. 4 CDSM)</h4>
      <p>The <strong>CDSM Directive (EU) 2019/790</strong>: art. 3 covers scientific TDM, art. 4 covers commercial TDM — "cornerstone of commercial AI training in the EU". The key mechanism is the <strong>opt-out (art. 4.3):</strong> TDM is permitted by default <em>unless</em> a reservation is expressed in a "machine-readable" manner. The <strong>AI Act</strong> (art. 53.1.c) obliges GPAI providers to respect these reservations even if they train outside the EU (Recital 106, the "Brussels effect").</p>
      <h4>What makes an opt-out valid (open question)</h4>
      <p><strong>Kneschke v. LAION</strong> (Hamburg, 27 Sep 2024; OLG appeal, Dec 2025): a natural-language opt-out in the ToS was <em>not</em> valid because it was not machine-readable. <strong>DPG Media v. HowardsHome</strong> (Amsterdam): a reservation "detectable and processable by automated systems" is required. Diverging directions → don't rely on a ToS clause alone: technical signals are also needed (robots.txt, metadata).</p>
      <h4>The EU Parliament's push</h4>
      <p>Procedure <strong>2025/2058(INI)</strong> "Copyright and generative AI" (rapporteur Voss): the JURI study <strong>PE 774095</strong> (Lucchi, 9 Jul 2025) concludes that training "far exceeds the scope of the current TDM exceptions"; the draft report <strong>PE775.433</strong> (27 Jun 2025) calls for transparency and remuneration. Resolution adopted on 10 March 2026 (T10-0066/2026). The majority nonetheless considers a new instrument unnecessary "at this stage".</p>
      <h4>The Italian case: FIEG vs Google</h4>
      <p><strong>15 Oct 2025:</strong> FIEG files a complaint with AGCOM against AI Overviews and AI Mode, "traffic killer", invoking the DSA. <strong>29 Apr 2026:</strong> following hearings (Google, FIEG, FISC), AGCOM decides to refer the case to the EU Commission <strong>under art. 65 DSA</strong> (arts. 27, 34, 35), with Commissioner Giomi voting against. It is a referral, not an autonomous sanctioning proceeding.</p>
      <blockquote>The opt-out protects copyright but removes the content from generative answers, zeroing out GEO visibility. Today the two are largely the same lever.</blockquote>
      <p>For an SME/e-commerce site: as a rule, do <strong>not</strong> opt out of <em>retrieval</em> bots (you want to be cited); opting out of <em>training</em> bots has near-zero cost in visibility. Blocking GPTBot (training) does not remove you from ChatGPT Search; blocking OAI-SearchBot/ChatGPT-User does.</p>
      <h4>The Privacy Authority (Garante)</h4>
      <p>The first regulator in the world to restrict ChatGPT (31 Mar 2023, Order 112/2023); reactivation 28 Apr 2023. A <strong>€15M</strong> fine (Order 755), <strong>annulled by the Court of Rome</strong> (judgment 4153/2026, filed 18 Mar 2026; the reasoning was not yet public as of mid-2026).</p>
      <h4>AI Act timeline</h4>
      <p>In force 1 Aug 2024; GPAI obligations from 2 Aug 2025; full applicability (incl. AI-content labelling) from 2 Aug 2026.</p>
    </div>
  </div>
</section>

<!-- SEC 5 practice -->
<section id="s5">
  <div class="sec-grid">
    <div class="sec-aside"><span class="num">06</span><span class="lbl">Practice</span></div>
    <div class="sec-body">
      <h2>Operational implications</h2>
      <h4>What still holds from SEO</h4>
      <p>Crawlability and indexing (extended to Bing for ChatGPT and to retrieval bots), authority/E-E-A-T, semantic HTML, server-side rendering (many AI bots fetch but do not execute JS).</p>
      <h4>What is new</h4>
      <p>Chunk-level optimisation, topical breadth for fan-out (pillar + cluster), entity/brand building, surface diversification (YouTube, Reddit), indexing on Bing.</p>
      <h4>Three phases</h4>
      <ol>
        <li><strong>Foundations:</strong> verify Bing indexing (+IndexNow); audit robots.txt distinguishing training from retrieval; server-side rendering.</li>
        <li><strong>Content:</strong> top pages in answer-first; cited statistics and quotations; quarterly updates; self-contained chunks (by writing well, not by splitting artificially).</li>
        <li><strong>Authority and measurement:</strong> brand mentions and third-party citations; AI tracking with repeated runs, not snapshots.</li>
      </ol>
      <h4>Thresholds that change the choices</h4>
      <ul>
        <li>If traffic from AI search exceeds 1-2% (today typically &lt;1% but it converts better), increase the GEO investment.</li>
        <li>If the overlap between AI citations and organic ranking is low, prioritise chunkability and authority.</li>
        <li>For Italy, monitor the launch of AI Mode in Italian and the FIEG-AGCOM-EU developments.</li>
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
      <p>A single criterion: <strong>primary source or replicable experiment vs repetition among influencers.</strong></p>
      <h4>Google debunks 5 myths (15 May 2026)</h4>
      <p>The official Search Central guide declares unnecessary: <strong>llms.txt and special markup</strong>, <strong>manual chunking</strong> (the systems understand multi-topic pages), <strong>AI-specific rewrites</strong>, <strong>inauthentic mentions</strong> (spam), <strong>excessive use of schema</strong>. Thesis: "optimising for generative AI is optimising for the search experience, and therefore it is still SEO".</p>
      <p>On <strong>5 June 2026</strong> Google doubled down: it published the guide on using <em>third-party SEO tools and services</em> and updated "Do you need an SEO?", explicitly naming <strong>AEO and GEO as service categories</strong>. It legitimises the discipline but narrows its scope — it remains "still SEO" — and urges caution toward anyone promising shortcuts or guarantees of citation in AI answers.</p>
      <div class="panel">
        <h4>The honest tension over chunking</h4>
        <p style="margin:0">Google says "chunking is not needed" — and it is right on one point: you don't have to <em>physically</em> split the page or rewrite it in an "AI format". But "manual chunking is not needed" ≠ "structure doesn't matter": clean chunks improve retrieval, all else being equal, and you get them by <strong>writing well</strong>. Moreover the guide applies to <em>Google</em>; for ChatGPT, Perplexity and Claude (their own RAG pipelines) structure remains more relevant. Generalising "chunking is dead" to all engines is over-extension.</p>
      </div>
      <h4>llms.txt — the textbook case</h4>
      <p>Google (Mueller, Illyes) states it does not use it. Otterly: 84 requests out of 62,100 in 90 days (0.1%); Ahrefs (May 2026): 97% of files receive no requests; SE Ranking (~300k domains): no correlation with citations. Wix estimates ~120k indexed files (a self-interested estimate, internally inconsistent with the "125k" in its subtitle). <strong>Verdict:</strong> an unproven AI-citation lever, with contrary evidence. A legitimate and narrow use case (documentation for dev tools).</p>
      <h4>Serving pages in Markdown</h4>
      <p>A recurring question: is it worth publishing a Markdown version of pages to get cited better? For mainstream engines it is <strong>marginal/situational, not proven</strong>. Technical distinction: <strong>content negotiation</strong> via <code>Accept: text/markdown</code> on the same URL is legitimate, standard HTTP; <strong>separate <code>.md</code> files at separate URLs</strong> are defined by Google and Bing as potential cloaking and a doubling of the crawl budget. Search crawlers (GPTBot, PerplexityBot, Googlebot, Bingbot) do <em>not</em> negotiate Markdown — only some coding agents do (Claude Code, Cursor). Empirical evidence: Profound (a controlled experiment, 381 pages) finds a ~16% lift that is <em>not statistically significant</em>; Otterly finds 0% traffic and zero citations to <code>.md</code> files. The real advantage of Markdown is tokenisation (~80% fewer tokens), but it benefits those who <em>convert</em> the HTML (Jina Reader, Firecrawl, RAG pipelines already do this). Google (15 May 2026): <em>"there is no need to create machine-readable files, AI text files or Markdown"</em>. <strong>Verdict:</strong> useful only for technical documentation consulted by agents in real time; for a generic site, clean semantic HTML matters far more. If you implement it, use content negotiation with <code>Vary: Accept</code>, never separately indexable <code>.md</code> files.</p>
      <h4>Schema/structured data</h4>
      <p>Google (May 2026) declares it <strong>not required</strong> for AI answers. Correlation studies are confounded by third variables (sites with schema are also better maintained). It remains useful for its classic purposes, not as an "AI trick".</p>
      <h4>Vendors' bait numbers</h4>
      <p>"data-rich cited 2.7x more", "FCP &lt;0.4s = 6.7 citations": often without methodology, sample, or number of runs. In light of SE 0.370 at one run, any two-decimal figure obtained without repeated runs is suspect.</p>
      <h4>"SEO is dead"</h4>
      <p>The opposite over-extension, and just as false: AIOs run <em>on top of</em> Search ranking, and parametric visibility is built with the signals of classic SEO. <strong>GEO is an extension of SEO, not a replacement.</strong></p>
      <div class="tablewrap"><table>
        <tr><th>GEO claim</th><th>Verdict</th><th>Priority</th></tr>
        <tr><td>Statistics + source citations</td><td><span class="badge b-ok">Proven</span></td><td>High</td></tr>
        <tr><td>Content freshness</td><td><span class="badge b-ok">Proven</span></td><td>High</td></tr>
        <tr><td>Answer-first structure</td><td><span class="badge b-ok">Solid</span></td><td>High</td></tr>
        <tr><td>Brand mentions &gt; backlinks</td><td><span class="badge b-warn">1 study</span></td><td>Medium</td></tr>
        <tr><td>Schema for AI citation</td><td><span class="badge b-warn">Overrated</span></td><td>Low</td></tr>
        <tr><td>Manual chunking</td><td><span class="badge b-bad">Myth (Google)</span></td><td>Low</td></tr>
        <tr><td>llms.txt as a lever</td><td><span class="badge b-bad">Unproven</span></td><td>Very low</td></tr>
        <tr><td>Serving pages in Markdown</td><td><span class="badge b-warn">Marginal</span></td><td>Low</td></tr>
        <tr><td>"SEO is dead"</td><td><span class="badge b-bad">False</span></td><td>—</td></tr>
      </table></div>
    </div>
  </div>
</section>

</div>
</main>

<footer>
  <div class="wrap">
    <h2>Primary sources</h2>
    <div class="biblio">
      <h4>Papers and benchmarks</h4>
      <ul>
        <li>Aggarwal P. et al., <em>GEO</em>, arXiv:2311.09735 (KDD 2024) — <a href="https://arxiv.org/abs/2311.09735">arxiv.org/abs/2311.09735</a></li>
        <li>Schulte J. et al., <em>Don't Measure Once</em>, arXiv:2604.07585 — <a href="https://arxiv.org/abs/2604.07585">arxiv.org/abs/2604.07585</a></li>
        <li>Vecta Benchmark (Feb 2026); BEIR arXiv:2104.08663; Chroma <em>Context Rot</em> (Jul 2025)</li>
      </ul>
      <h4>Search behaviour</h4>
      <ul>
        <li>SparkToro/Similarweb, <em>Zero-click 2026</em> — <a href="https://sparktoro.com/blog/in-2026-less-than-one-third-of-google-searches-still-send-a-click/">sparktoro.com</a></li>
        <li>Pew Research (Jul 2025); Ahrefs <em>AI Overviews Reduce Clicks by 58%</em></li>
      </ul>
      <h4>Reverse-engineering</h4>
      <ul>
        <li>RESONEO/Meteoria, <em>Inside ChatGPT Search: web.run</em>, Search Engine Land (May 2026) — <a href="https://searchengineland.com/inside-chatgpt-search-web-run-fan-out-queries-ai-visibility-477339">searchengineland.com</a></li>
        <li>Google, <em>Gemini API — Grounding</em> — <a href="https://ai.google.dev/gemini-api/docs/google-search">ai.google.dev</a></li>
        <li>Seer Interactive, <em>SearchGPT ↔ Bing 87%</em> (Feb 2025); Anthropic <em>Web search docs</em>; Yeşilyurt (Perplexity, Aug 2025)</li>
      </ul>
      <h4>Chinese market</h4>
      <ul>
        <li>Baidu, <em>Q4 & FY2025 Results</em> (26 Feb 2026) — <a href="https://ir.baidu.com/news-releases/news-release-details/baidu-announces-fourth-quarter-and-fiscal-year-2025-results">ir.baidu.com</a></li>
        <li>QuestMobile via Caixin (Doubao ~345M MAU, Mar 2026)</li>
      </ul>
      <h4>EU/Italy law</h4>
      <ul>
        <li>CDSM Directive (EU) 2019/790; AI Act (Reg. EU 2024/1689); EU Parliament 2025/2058(INI) — <a href="https://oeil.secure.europarl.europa.eu/oeil/en/procedure-file?reference=2025/2058(INI)">oeil.europarl.europa.eu</a></li>
        <li>Kneschke v. LAION (Hamburg/OLG); DPG Media v. HowardsHome (Amsterdam)</li>
        <li>AGCOM, referral under art. 65 DSA (29 Apr 2026); FIEG complaint (15 Oct 2025); Garante Orders 112/2023 and 755; Court of Rome 4153/2026</li>
      </ul>
      <h4>Anti-hype</h4>
      <ul>
        <li>Google Search Central, <em>Optimizing for generative AI features</em> (15 May 2026) — <a href="https://developers.google.com/search/blog/2026/05/a-new-resource-for-optimizing">developers.google.com</a>; <em>third-party SEO tools/services</em> and <em>Do you need an SEO?</em> (5 Jun 2026, naming AEO/GEO)</li>
        <li>Ahrefs <em>97% of llms.txt files never get read</em> — <a href="https://ahrefs.com/blog/llmstxt-study/">ahrefs.com</a>; SE Ranking; Otterly; Wix Studio</li>
        <li>Markdown for pages — Profound <em>Markdown vs HTML experiment</em> — <a href="https://www.tryprofound.com/blog/does-markdown-increase-ai-bot-traffic">tryprofound.com</a>; Otterly <em>md vs HTML</em>; Checkly <em>content negotiation</em>; Cloudflare <em>Markdown for Agents</em>; Google <em>AI optimization guide</em></li>
      </ul>
    </div>
    <div class="foot-meta">
      White paper curated by Federico Calicchia · written with the support of Claude Opus 4.8 (Anthropic). Last updated: 16 June 2026.<br>
      Demos 01-03 are client-side educational simulations (not real engines); demo 04 uses the exact data from the Schulte et al. paper. Statistics and mechanisms have a limited shelf life.
    </div>
  </div>
</footer>`;
