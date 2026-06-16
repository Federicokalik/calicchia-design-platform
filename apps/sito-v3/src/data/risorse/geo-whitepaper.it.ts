/**
 * Body IT del white paper (markup Swiss + demo). Seed dall'HTML sorgente,
 * poi allineato al markdown esteso. Modificabile a mano.
 */
export const GEO_WP_BODY_IT = `<header class="masthead">
  <div class="wrap">
    <div class="mast-top"><span>White Paper</span><span>Generative Engine Optimization</span><span class="r">2026</span></div>
    <div class="hero-grid">
      <div>
        <h1 class="display">SEO<br>→ <span class="red">GEO</span></h1>
      </div>
      <div class="hero-sub">
        <p class="lede">L'evoluzione della ricerca nell'era dell'AI generativa.</p>
        <div class="byline">
          A cura di <a href="https://github.com/federicokalik">Federico Calicchia</a> · redatto con il supporto di Claude Opus 4.8 (Anthropic) su indicazioni editoriali.
        </div>
        <div class="meta-row"><span>Ultimo aggiornamento · 16 giugno 2026</span></div>
      </div>
    </div>
  </div>
</header>

<main>
<div class="wrap">

<!-- INTRO -->
<section id="intro">
  <div class="sec-grid">
    <div class="sec-aside"><span class="num">00</span><span class="lbl">Introduzione</span></div>
    <div class="sec-body">
      <p class="lede" style="margin-bottom:24px">Per vent'anni la ricerca ha avuto una grammatica stabile: query → lista di link → click. Quella grammatica si sta rompendo.</p>
      <p>Per vent'anni la ricerca online ha funzionato secondo una grammatica stabile: un utente digita una query, un motore restituisce una lista ordinata di link, l'utente clicca e arriva su un sito. Su quella meccanica — crawling, indexing, ranking, click-through — si è costruita un'intera disciplina, la SEO, e con essa il modello economico del web aperto, dove la visibilità si traduceva in traffico e il traffico in valore.</p>
      <p>I motori generativi (Google con AI Overviews e AI Mode, ChatGPT, Perplexity, Microsoft Copilot, Claude) non restituiscono più primariamente una lista di link: leggono il web al posto dell'utente, sintetizzano una risposta e citano poche fonti. Il click, che era il fine, diventa l'eccezione. Cambia l'unità di competizione (non più la pagina ma il singolo <em>chunk</em> di contenuto che un sistema di retrieval può estrarre e citare), cambiano le metriche (dalla posizione in SERP alla quota di citazione), cambiano gli attori (un arcipelago frammentato e in rapida evoluzione, anche fuori dall'Occidente). Da questo spostamento nasce la GEO, <em>Generative Engine Optimization</em>.</p>
      <p>Questo documento ha tre obiettivi: spiegare <strong>come funzionano davvero</strong> i motori a livello di retrieval (embedding, chunking, re-ranking, query fan-out) e di selezione fonti, motore per motore; <strong>distinguere ciò che è documentato</strong> da ciò che è inferito tramite reverse-engineering o solo affermato dai vendor; <strong>collocare il fenomeno nel contesto italiano ed europeo</strong>, dove il quadro normativo (AI Act, opt-out TDM, DSA, GDPR) è il più stringente al mondo e condiziona concretamente cosa la GEO può e non può fare. Il taglio è formativo e analitico: capire il meccanismo, non vendere una ricetta.</p>
      <div class="note"><strong>Nota metodologica.</strong> Documento elaborato a partire da una ricerca su fonti primarie e secondarie (paper accademici, documentazione ufficiale dei motori, report di settore, analisi di reverse-engineering indipendenti). Le sezioni distinguono esplicitamente i fatti documentati dai claim dei vendor e dalle analisi non confermate ufficialmente. Tutte le fonti sono elencate in bibliografia.</div>
    </div>
  </div>
</section>

<!-- TLDR -->
<section id="tldr">
  <div class="sec-grid">
    <div class="sec-aside"><span class="num">—</span><span class="lbl">In breve</span></div>
    <div class="sec-body">
      <h2>Cinque punti</h2>
      <ul class="keylist">
        <li><div>Lo zero-click è strutturale: nel 2024 il 58,5% delle ricerche Google USA finiva senza click (SparkToro/Datos), salito al <strong>68,01%</strong> a inizio 2026. Con un AI Overview il CTR organico della pagina top cala del <strong>47-61%</strong> a seconda dello studio (Authoritas, Pew, Seer Interactive, Ahrefs).</div></li>
        <li><div>La GEO nasce dal paper di Aggarwal et al. (IIT Delhi/Princeton, KDD 2024): statistiche, citazioni e quotazioni alzano la visibilità <strong>"fino al 40%"</strong>; il keyword stuffing è l'unico metodo testato che la <em>peggiora</em>.</div></li>
        <li><div>Ogni motore ha una pipeline diversa (ChatGPT su Bing/scraping, Perplexity con crawler proprio, Claude su Brave, Copilot su Bing/Prometheus, Gemini con fan-out): tutti usano RAG, embeddings e selezione a livello di chunk, per cui struttura, freschezza, autorevolezza e citabilità contano più del posizionamento tradizionale.</div></li>
        <li><div>La visibilità AI è una distribuzione, non un punteggio: una misura singola ha errore standard <strong>0,370</strong> (inutile); servono 7-10+ run per prompt (paper "Don't Measure Once", arXiv:2604.07585).</div></li>
        <li><div>Google stessa (maggio 2026) dichiara che <strong>"GEO è ancora SEO"</strong> e smonta 5 miti, tra cui llms.txt e il chunking manuale.</div></li>
      </ul>
      <div class="panel">
        <h4>Key Findings</h4>
        <ol>
          <li><strong>Il comportamento di ricerca è cambiato strutturalmente, non marginalmente.</strong> Lo zero-click è passato da ~50% (SparkToro 2019) a 68,01% (Q1 2026 USA). Gartner ha previsto (feb 2024) un calo del 25% del volume di ricerca tradizionale entro il 2026 — una previsione, non un consuntivo.</li>
          <li><strong>Il posizionamento organico tradizionale resta importante ma non è più sufficiente.</strong> Ahrefs (gen 2026): solo il 38% delle pagine citate negli AI Overviews è anche nella top-10 organica (era 76% a luglio 2025).</li>
          <li><strong>Le tattiche GEO con evidenza empirica sono poche e specifiche:</strong> statistiche, citazioni di fonti, quotazioni, freschezza, struttura answer-first. Molti consigli popolari (llms.txt, schema-as-hack, chunking manuale) non hanno evidenza di funzionare e alcuni sono smentiti da Google.</li>
          <li><strong>Il mercato italiano/UE è in ritardo ma in rapida accelerazione:</strong> AI Overviews in Italia dal 26 marzo 2025; uso GenAI in Italia al 20% (sotto media UE 33%, Eurostat 2025); dopo il reclamo FIEG (15 ottobre 2025) l'AGCOM ha trasmesso il caso alla Commissione UE ex art. 65 DSA (29 aprile 2026). La frammentazione è globale: in Cina Doubao, ERNIE, DeepSeek e Qwen superano insieme i 900 milioni di utenti.</li>
          <li><strong>Il contesto normativo UE è il più stringente al mondo:</strong> AI Act, GDPR, opt-out TDM ex art. 4 CDSM, caso Garante-OpenAI e dispute publisher modellano come la GEO può operare in Europa.</li>
        </ol>
      </div>
    </div>
  </div>
</section>

<!-- SEC 1 -->
<section id="s1">
  <div class="sec-grid">
    <div class="sec-aside"><span class="num">01</span><span class="lbl">Fondamenti</span></div>
    <div class="sec-body">
      <h2>L'evoluzione dalla SEO alla GEO</h2>
      <h4>Come funzionava (e funziona) la ricerca tradizionale</h4>
      <p>La SEO classica si basa su tre fasi: <strong>crawling</strong> (un bot come Googlebot scopre e scarica pagine), <strong>indexing</strong> (le pagine vengono analizzate e archiviate in un indice), <strong>ranking</strong> (un algoritmo ordina le pagine per una query producendo la SERP, la lista di "link blu"). Il modello economico del web aperto era basato sul <strong>click-through</strong>: l'utente cercava, vedeva una lista di risultati e cliccava su un sito, generando traffico monetizzabile.</p>
      <h4>Come funziona la ricerca AI-driven</h4>
      <p>I motori generativi non restituiscono primariamente una lista di link, ma <strong>sintetizzano una risposta</strong> da più fonti usando un LLM, citandone alcune inline. Questo produce <strong>risposte zero-click</strong>: l'utente ottiene la risposta senza visitare alcun sito. Google ha integrato il paradigma con gli <strong>AI Overviews</strong> (riquadri generativi in cima alla SERP) e l'<strong>AI Mode</strong> (esperienza conversazionale completa).</p>
      <h4>Punti di svolta e timeline</h4>
      <ul>
        <li>Mag 2023: Google annuncia la Search Generative Experience (SGE) come esperimento in Search Labs.</li>
        <li>14 mag 2024: Google lancia ufficialmente gli AI Overviews negli USA (al Google I/O).</li>
        <li>28 ott 2024: AI Overviews estesi a oltre 100 paesi e territori.</li>
        <li>31 ott 2024: OpenAI lancia ChatGPT Search.</li>
        <li>5 mar 2025: AI Overviews passano a Gemini 2.0; Google annuncia AI Mode come esperimento Labs.</li>
        <li>26 mar 2025: AI Overviews arrivano in Italia e in altri paesi europei.</li>
        <li>20 mag 2025: AI Mode esteso a tutti gli utenti USA.</li>
        <li>15 mag 2026: Google pubblica la guida ufficiale GEO ("Optimizing your website for generative AI features").</li>
        <li>5 giu 2026: Google pubblica la guida sui servizi SEO di terze parti e aggiorna "Do you need an SEO?", nominando AEO/GEO come categoria di servizio.</li>
      </ul>
      <p>Perplexity (fondata nel 2022) ha reso popolare il concetto di "answer engine" con citazioni trasparenti. Claude (Anthropic) ha aggiunto la ricerca web nel 2025.</p>
      <h4>Il paper fondativo "GEO: Generative Engine Optimization"</h4>
      <p>Il termine è stato formalizzato nel paper di <strong>Pranjal Aggarwal, Vishvak Murahari, Tanmay Rajpurohit, Ashwin Kalyan, Karthik Narasimhan e Ameet Deshpande</strong> (IIT Delhi/Princeton/Allen AI), pubblicato a <strong>KDD 2024</strong> (arXiv:2311.09735, DOI 10.1145/3637528.3671900). Risultati chiave, verificati sul testo originale:</p>
      <ul>
        <li>Hanno introdotto <strong>GEO-bench</strong>, un benchmark di <strong>10.000 query</strong> da domini diversi.</li>
        <li>Hanno testato <strong>9 metodi</strong> di ottimizzazione: Authoritative, Keyword Stuffing, Statistics Addition, Quotation Addition, Cite Sources, Fluency Optimization, Easy-to-Understand, Technical Terms, Unique Words.</li>
        <li>Due metriche: <strong>Position-Adjusted Word Count</strong> (parole attribuite a una fonte, pesate per posizione nella risposta) e <strong>Subjective Impression</strong> (punteggio qualitativo G-Eval su 7 dimensioni).</li>
        <li>I metodi migliori — <strong>Quotation Addition +41%, Statistics Addition +31%, Cite Sources +28%, Fluency Optimization +28%</strong> — possono aumentare la visibilità "up to 40%" nelle risposte generative.</li>
        <li>Il <strong>Keyword Stuffing</strong> è l'<strong>unico metodo che ha peggiorato</strong> la visibilità (−8%): le tattiche SEO non si trasferiscono automaticamente.</li>
        <li>L'efficacia <strong>varia per dominio</strong>: Statistics in "Law &amp; Government" e query "Opinion"; Quotation in "History" e "People &amp; Society".</li>
        <li>GEO favorisce i siti <strong>a basso ranking</strong>: Cite Sources ha aumentato la visibilità del <strong>115,1%</strong> per i siti in quinta posizione SERP.</li>
        <li>La combinazione <strong>Fluency + Statistics</strong> ha superato qualsiasi metodo singolo di oltre il 5,5%.</li>
        <li>Validazione su Perplexity.ai: miglioramenti <strong>fino al 37%</strong>.</li>
      </ul>
      <p class="note">Nota di sourcing: titoli di metodo, percentuali headline e frasi di prosa confermati su arXiv. La v3 indica un boost 15-30% per i metodi stilistici, contro "10-20%" di versioni precedenti — discrepanza di versione da segnalare.</p>
      <h4>Dati sul cambiamento del comportamento di ricerca</h4>
      <ul>
        <li><strong>SparkToro/Datos (2024):</strong> 58,5% ricerche Google USA e 59,7% UE senza click. Per ogni 1.000 ricerche USA, solo 360 click al web aperto.</li>
        <li><strong>SparkToro/Similarweb (2026):</strong> 68,01% ricerche Google USA senza click nei primi 4 mesi del 2026 (+7,56 punti dal 2024).</li>
        <li><strong>Ahrefs (dic 2025):</strong> un AIO correla con CTR medio −58% per la pagina top.</li>
        <li><strong>Pew Research (lug 2025):</strong> su 68.879 ricerche reali, click su link tradizionale all'8% con AIO vs 15% senza (≈ −47%); solo l'1% clicca una fonte citata; 26% delle sessioni con AIO termina del tutto (vs 16%). Google ha contestato la metodologia.</li>
        <li><strong>Seer Interactive (set 2025, &gt;25M impression):</strong> CTR organico per query con AIO −61% (1,76% → 0,61%).</li>
        <li><strong>Gartner (feb 2024):</strong> previsione −25% del volume di ricerca tradizionale entro il 2026 (previsione, non consuntivo).</li>
        <li><strong>Impatto publisher:</strong> Digital Content Next (ago 2025) cala mediano del traffico referral Google del 10%; Press Gazette/Chartbeat: −33% globale nel 2025 (−38% USA, −17% Europa). Il danno scala con la dimensione del sito.</li>
      </ul>
    </div>
  </div>
</section>

<!-- SEC 2 -->
<section id="s2">
  <div class="sec-grid">
    <div class="sec-aside"><span class="num">02</span><span class="lbl">Meccanica</span></div>
    <div class="sec-body">
      <h2>Come funzionano i motori</h2>
      <p>Tutti i motori generativi usano una forma di <strong>RAG (Retrieval-Augmented Generation)</strong>: invece di affidarsi solo alla conoscenza "parametrica" (appresa in training), recuperano contenuti freschi dal web e li usano per costruire la risposta. Tesi tecnica di fondo: <strong>la pagina non è più l'unità di competizione, lo è il chunk.</strong></p>
      <ul>
        <li><strong>ChatGPT (OpenAI):</strong> retrieval via API di scraping di terze parti (storicamente legato a Bing; Seer ha trovato 87% di overlap con i top result di Bing); query fan-out; selezione fonti che pesa autorevolezza, struttura e freschezza.</li>
        <li><strong>Google Gemini / AI Overviews / AI Mode:</strong> indice web proprio + Knowledge Graph + Shopping; query fan-out documentato via API; selezione che attinge anche fuori dalla top-10 (Ahrefs gen 2026: solo 38% delle citazioni dalla top-10).</li>
        <li><strong>Perplexity:</strong> RAG con crawler proprio (PerplexityBot); forte sensibilità alla freschezza; tipicamente 3-5 fonti per risposta; reranking ML a più livelli.</li>
        <li><strong>Microsoft Copilot:</strong> modello Prometheus su indice Bing; "Bing Orchestrator" che genera query interne iterative (fan-out); citazioni numerate [1][2]; primo motore a codificare la GEO nelle proprie Webmaster Guidelines (febbraio 2026).</li>
        <li><strong>Claude (Anthropic):</strong> retrieval via provider esterno (overlap con Brave); citazione a livello di frase; tre bot (ClaudeBot training, Claude-User fetch, Claude-SearchBot indicizzazione).</li>
      </ul>

      <h3>2-bis · Le tre famiglie di retrieval</h3>
      <p><strong>Dense (bi-encoder):</strong> query e documento codificati <em>separatamente</em> in un singolo vettore denso (es. 768 dimensioni); la rilevanza è la cosine similarity. Velocissimo (vettori pre-calcolati + ANN), ma — come sintetizza Towards Data Science — <em>"the model compresses all meaning into one vector before any comparison happens"</em>: query e documento non interagiscono mai a livello di token. Conseguenza GEO: un chunk con tre concetti produce un vettore "medio" che non rappresenta bene nessuno dei tre. <strong>Sparse (BM25, SPLADE):</strong> match lessicale esatto (o espanso), imbattibile su nomi propri, codici prodotto e termini tecnici — i casi in cui il dense fallisce. <strong>Late interaction (ColBERT e successori):</strong> mantiene gli embedding <em>a livello di token</em> e calcola la rilevanza con MaxSim. Weaviate: i metodi dense <em>"pool token-wise embeddings into a single representation while ColBERT embeddings keep the token-wise representations in a multi-vector"</em>. Vantaggio: spiegabilità; svantaggio: storage (BEIR: ~20GB/1M doc vs 0,4GB BM25 e ~3GB dense).</p>
      <p><strong>Il dato che conta:</strong> gli approcci <strong>ibridi dense+sparse battono ogni metodo singolo</strong>. Uno studio singolo (gen 2026, su MS MARCO, fonte poco visibile e con baseline dense insolitamente bassa — da trattare come indicativo) riporta fino al <strong>580% di miglioramento in Recall@10</strong> rispetto al solo dense (13,9% → 80,8%); il principio generale è comunque confermato da letteratura peer-reviewed più solida. I motori reali combinano "significato" (dense) e "parola esatta" (sparse): il contenuto deve servire entrambi — concetti chiari <em>e</em> terminologia esatta.</p>

      <!-- DEMO 1 -->
      <div class="demo" id="demo-ds">
        <div class="demo-head"><span class="dot"></span>Demo 01 · Dense vs Sparse<span class="tag">simulazione didattica</span></div>
        <div class="demo-body">
          <label for="ds-q">Query di ricerca</label>
          <input type="text" id="ds-q" value="iPhone 15 Pro 256GB" autocomplete="off">
          <div class="chips" id="ds-chips">
            <span class="chip" data-q="iPhone 15 Pro 256GB">codice prodotto</span>
            <span class="chip" data-q="migliore portatile leggero per studenti">linguaggio naturale</span>
            <span class="chip" data-q="come ridurre il consumo della batteria">domanda how-to</span>
          </div>
          <div class="ds-grid">
            <div class="ds-col dense"><h5>Dense · semantico</h5><div class="ds-score" id="ds-dense-score">—</div><div class="ds-bar"><span id="ds-dense-bar"></span></div><div class="ds-note" id="ds-dense-note"></div></div>
            <div class="ds-col sparse"><h5>Sparse · lessicale</h5><div class="ds-score" id="ds-sparse-score">—</div><div class="ds-bar"><span id="ds-sparse-bar"></span></div><div class="ds-note" id="ds-sparse-note"></div></div>
          </div>
        </div>
        <div class="demo-cap">Euristica didattica (non un vero motore): mostra <em>perché</em> i due approcci eccellono su query diverse. Codici e nomi propri premiano lo sparse; le query concettuali premiano il dense. I motori reali li combinano.</div>
      </div>

      <h3>2-bis · Embeddings</h3>
      <p>Cosa cattura un vettore (e cosa no). Tre implicazioni operative: (1) <strong>stesso modello obbligatorio per indice e query</strong> — altrimenti i vettori vivono in spazi non allineati e la similarity è rumore; è la causa #1 di RAG rotti silenziosamente; (2) <strong>context rot</strong> — la ricerca Chroma (lug 2025, 18 modelli inclusi GPT-4.1, Claude 4, Gemini 2.5) mostra che il retrieval degrada all'aumentare della lunghezza del contesto, anche su task semplici: infilare la risposta a metà di un muro di testo la rende meno recuperabile; (3) <strong>un vettore medio non è un buon vettore</strong> — più concetti distinti in un chunk = embedding diffuso.</p>

      <h3>2-bis · Chunking</h3>
      <p>Il senso comune dice "il semantic chunking è il migliore"; i benchmark dicono il contrario, e la divergenza è istruttiva. <strong>Vecta Benchmark (feb 2026):</strong> recursive splitting a 512 token primo (69%), semantic al 54% (frammenti da ~43 token); l'autore: la conversazione sul chunking è stata <em>"dominated by theory rather than measurement"</em>. <strong>MDPI Bioengineering (nov 2025):</strong> nel dominio clinico adaptive 87% vs 13-50% del fixed-size (p=0,001). <strong>arXiv 2506.17277 (chimica):</strong> recursive fino al +45% di precisione domain-weighted. <strong>arXiv 2512.05411 (enterprise):</strong> su documentazione ben strutturata il naive batte semantic e recursive. <strong>arXiv 2506.06339 (arabo):</strong> sentence-aware il migliore, semantic <em>consistentemente peggiore</em>.</p>
      <p><strong>Non si conciliano — ed è il punto.</strong> Nessuna strategia è universalmente ottimale; dipende da struttura del documento e tipo di query. Default robusto difendibile: <strong>recursive splitting a 400-512 token con 10-20% di overlap</strong>, quando non si hanno motivi specifici per altro. Perché curarsene anche se non controlli il chunker del motore? Perché controlli <em>quanto è spezzabile bene</em> la pagina: confini semantici netti (heading chiari, un'idea per sezione, risposte autosufficienti) producono chunk coerenti con qualsiasi strategia. <strong>La struttura del contenuto è il chunking che puoi controllare.</strong></p>

      <!-- DEMO 2 -->
      <div class="demo" id="demo-chunk">
        <div class="demo-head"><span class="dot"></span>Demo 02 · Strategie di chunking<span class="tag">interattiva</span></div>
        <div class="demo-body">
          <label for="chunk-in">Testo da spezzare</label>
          <input type="text" id="chunk-in" value="La GEO ottimizza per i motori generativi. Le statistiche aumentano le citazioni. Il keyword stuffing invece le riduce. La freschezza conta molto per Perplexity." autocomplete="off">
          <div class="chunk-controls">
            <button data-mode="fixed">Fixed-size</button>
            <button data-mode="recursive">Recursive</button>
            <button data-mode="semantic">Semantic</button>
          </div>
          <div class="chunk-out" id="chunk-out"></div>
          <div class="chunk-meta" id="chunk-meta"></div>
        </div>
        <div class="demo-cap">Il fixed taglia a lunghezza fissa (rompe le frasi); il recursive rispetta i confini di frase; il semantic raggruppa per significato ma può frammentare troppo.</div>
      </div>

      <h3>2-bis · Re-ranking</h3>
      <p>Il retrieval reale è quasi sempre a <strong>due stadi</strong>: <strong>Stadio 1 — Recall</strong> (bi-encoder/BM25/ibrido), rete larga con 20-150 candidati veloci; <strong>Stadio 2 — Precision</strong> (cross-encoder) che ri-valuta ogni coppia query-chunk <em>insieme</em> (<code>[CLS] query [SEP] documento [SEP]</code>), riordina e tiene i top 3-8. Numeri operativi: cross-encoder leggero (ms-marco-MiniLM-L-6-v2) ~50ms/20 doc; Cohere Rerank ~200ms; reranker LLM 1-3s. Guadagno tipico <strong>+5-15 punti nDCG@10</strong> o +10-25% accuratezza. Default: top-20→50, rerank, passa top-3→8; oltre 50 candidati <em>"adds latency without meaningfully improving recall"</em>. <strong>Implicazione GEO:</strong> il cross-encoder premia la <strong>rilevanza diretta e specifica alla query</strong> — non densità di keyword, non lunghezza, non autorità del dominio in sé. È il fondamento meccanico del perché l'answer-first funziona: non è stile, è allineamento col cross-encoder.</p>

      <div class="panel">
        <h4>Dal meccanismo alla regola di markup</h4>
        <div class="tablewrap"><table>
          <tr><th>Fatto meccanico</th><th>Regola operativa per il contenuto</th></tr>
          <tr><td>Dense comprime tutto in un vettore</td><td>Un'idea per sezione; non mescolare 3 temi in un paragrafo</td></tr>
          <tr><td>Sparse premia il match esatto</td><td>Includi termini/codici/nomi esatti, non solo sinonimi</td></tr>
          <tr><td>Ibrido batte i singoli metodi</td><td>Concetti chiari <em>e</em> terminologia precisa insieme</td></tr>
          <tr><td>Context rot</td><td>Risposta in alto, non sepolta a metà pagina</td></tr>
          <tr><td>Chunk autosufficienti = retrieval robusto</td><td>Ogni sezione abbia senso letta da sola</td></tr>
          <tr><td>Heading chiari = confini netti</td><td>HTML semantico: <code>&lt;h2&gt;</code> a domanda + risposta sotto</td></tr>
          <tr><td>Cross-encoder premia rilevanza diretta</td><td>Answer-first: risposta nei primi 40-60 token</td></tr>
          <tr><td>Re-ranking taglia a top 3-8</td><td>Serve essere il chunk <em>più</em> pertinente, non solo pertinente</td></tr>
        </table></div>
      </div>

      <h3>2-ter · Reverse-engineering per-motore</h3>
      <p class="note">Distinzione epistemica: ciò che segue mescola <strong>fatti ufficiali</strong> (documentazione, API), <strong>analisi di reverse-engineering</strong> non confermate dai produttori e <strong>claim dei vendor</strong>. Lo segnalo caso per caso. È l'area più volatile del documento: le pipeline cambiano da un aggiornamento di modello all'altro.</p>

      <h4>ChatGPT — il tool web.run</h4>
      <p>La fonte più dettagliata è lo studio RESONEO/Meteoria (Olivier de Segonzac, maggio 2026), che ha decompilato l'app mobile, sniffato i pacchetti di rete e ricostruito il system prompt. Il motore interno si chiama <code>web.run</code>: prima di GPT-5.3 inviava comandi testuali compatti separati da pipe (<code>fast|query|recency</code>), dopo 5.3 oggetti JSON strutturati. Il tool supporta <strong>12 operazioni</strong> (da 4 precedenti): <code>search_query</code>, <code>open</code>, <code>find</code>, <code>click</code>, <code>screenshot</code>, <code>product_query</code> e widget specializzati, più un sistema <code>genui</code>. Il <strong>query fan-out</strong> concatena 2-10+ round; il fan-out prodotto inedito (<code>browse_rewritten_queries</code>) lancia una ricerca shopping <em>separata per ogni singolo prodotto</em>. È <code>ChatGPT-User</code> (non OAI-SearchBot) a fetchare le pagine durante la conversazione; marcatori di tracking Google (<code>strlid</code>) negli URL prodotto rivelano un backend che si appoggia a provider terzi e a Google dietro le quinte.</p>
      <p>Con lo switch a GPT-5.3 Instant (4 mar 2026) i domini unici citati per risposta sono <strong>scesi da 19 a 15 (−20%)</strong> — il "Bigfoot Effect": concentrazione su pochi domini autorevoli (rapporto URL-per-dominio stabile a 1,26). <strong>Reddit</strong> è l'unico dominio esentato dai limiti di parole per copyright nel system prompt ricostruito. <em>(Reverse-engineering.)</em> Punto strategico: lo studio distingue <strong>visibilità parametrica</strong> (ciò che il modello ha appreso in training — stabile, plasmata da copertura stampa, Wikipedia, siti autorevoli) da <strong>visibilità dinamica</strong> (ciò che recupera in tempo reale, volatile). Il legame: <em>"il modello formula le query web puntando a fonti che già conosce. Un brand assente dalla memoria parametrica non sarà nemmeno considerato come candidato."</em></p>
      <p class="note">Avvertenza: stesso prompt su 5.2/5.3/5.4 produce fan-out, fonti e passaggi diversi. La citazione in ChatGPT non è riproducibile come un ranking Google: va testata modello per modello.</p>

      <h4>Gemini / AI Mode — fan-out documentato</h4>
      <p>A differenza di ChatGPT, qui c'è <strong>documentazione ufficiale</strong>, tramite l'API di grounding di Gemini. La risposta restituisce <code>webSearchQueries</code> (le query realmente eseguite — es. per "chi ha vinto Euro 2024" genera <code>["UEFA Euro 2024 winner", "who won euro 2024"]</code>), <code>groundingChunks</code> (le fonti, con uri e title) e <code>groundingSupports</code> (la mappatura <strong>segmento di testo → chunk fonte</strong>, con <code>startIndex</code>/<code>endIndex</code> carattere per carattere): ogni frase della risposta è ancorata a chunk specifici. Dal technical report Gemini 2.5: Gemini 2.0 è stata <em>"la prima famiglia di modelli addestrata a chiamare nativamente strumenti come Google Search"</em>; Gemini 2.5 <em>"interleaves search capabilities with internal thought processes"</em> per query multi-hop. La ricerca è interlacciata col ragionamento, non occasionale.</p>
      <p>Scala: a metà 2025 i modelli alimentavano ~1,5 miliardi di utenti mensili negli AI Overviews e ~400M nell'app Gemini; a fine 2025/inizio 2026 i numeri ufficiali Alphabet salgono a <strong>2 miliardi</strong> di utenti per gli AI Overviews e <strong>750 milioni</strong> di MAU per l'app Gemini (Q4 2025). AI Mode usa una <em>"custom version of Gemini"</em> con fan-out, che scompone la query in molte sotto-query parallele — il motivo per cui pagine non in top-10 vengono citate. <strong>Conseguenza GEO:</strong> ottimizzare per Gemini significa coprire l'<strong>albero di sotto-domande</strong> di un tema, non una singola keyword.</p>

      <!-- DEMO 3 -->
      <div class="demo" id="demo-fanout">
        <div class="demo-head"><span class="dot"></span>Demo 03 · Query fan-out<span class="tag">interattiva</span></div>
        <div class="demo-body">
          <label for="fo-q">La tua domanda all'AI</label>
          <input type="text" id="fo-q" value="qual è la migliore città dove trasferirsi per lavorare da remoto?" autocomplete="off">
          <div style="margin-top:14px"><button id="fo-go">Esegui fan-out →</button> <button class="ghost" id="fo-reset">reset</button></div>
          <div class="fan-out" id="fo-out"></div>
        </div>
        <div class="demo-cap">Una domanda viene scomposta in più sotto-query parallele; ognuna recupera fonti diverse — per questo pagine non in top-10 vengono citate, se rispondono bene a una sotto-query.</div>
      </div>

      <h4>Perplexity / Sonar</h4>
      <p>RAG con crawler proprio (PerplexityBot) + fetch realtime (Perplexity-User). <strong>Sonar</strong> è il modello proprietario costruito su architetture open Llama; a livello prodotto è multi-modello e seleziona a runtime il modello migliore per modalità (search/reasoning/research). Pipeline: (1) <strong>query decomposition</strong>; (2) retrieval da indice proprio + realtime; (3) <strong>reranking a tre livelli</strong> — Layer 1 retrieval dei candidati con scoring classico, Layer 2 ranking per autorità/rilevanza, Layer 3 reranking ML che favorirebbe l'<strong>earned media da pubblicazioni Tier-1</strong> (una citazione su TechCrunch o Forbes come segnale di autorità verificato esternamente — analisi indipendente Yeşilyurt, ago 2025, <em>non confermata ufficialmente</em>); (4) sintesi con citazioni inline. La citazione è un "two-step dance": inclusione nel retrieval set, poi selezione del paragrafo. <strong>Freschezza dominante:</strong> un articolo "aggiornato 2 ore fa" è stato citato il <strong>+38%</strong> del gemello identico datato di un mese; il gemello stantio raramente spariva dal retrieval set ma veniva retrocesso nella sintesi. ~780M query a maggio 2025 (+20% MoM, dichiarazione Srinivas, Bloomberg Tech).</p>

      <h4>Claude — citazione a livello di frase</h4>
      <p>Retrieval via provider esterno (analisi Profound indicano forte overlap con Brave Search) e fetch dagli URL dei risultati. La documentazione del web search e del citations tool specifica che i documenti vengono spezzati in chunk a granularità di <strong>frase</strong>: l'output restituisce blocchi <code>cited_text</code>, con <code>title</code> e <code>url</code>. Conseguenza: <strong>una frase ben costruita e autosufficiente è l'unità minima citabile</strong> — il caso più estremo del principio "il chunk è l'unità di competizione". Tre bot: ClaudeBot (training), Claude-User (fetch su richiesta utente), Claude-SearchBot (indicizzazione). Tutti dichiarano di rispettare robots.txt.</p>

      <h4>Microsoft Copilot — GEO in policy</h4>
      <p>Copilot è l'unico motore importante che ha <strong>codificato la GEO nella propria policy ufficiale</strong>. Microsoft descrive <strong>Prometheus</strong> come un modello che combina <em>"the fresh and comprehensive Bing index, ranking, and answers results with the creative reasoning capabilities of … GPT models"</em>; il <strong>Bing Orchestrator</strong> <em>"generate[s] a set of internal queries iteratively"</em> — il meccanismo di query fan-out interno. Le citazioni sono numerate [1][2] linkate alla pagina sorgente. La riscrittura delle <strong>Bing Webmaster Guidelines (27 feb 2026)</strong> tratta <em>"grounding results and citations"</em> come <strong>esito di eleggibilità separato</strong> e introduce la GEO come categoria ufficiale: <code>NOARCHIVE</code> impedisce l'uso del contenuto nelle risposte Copilot; <code>NOCACHE</code> lo limita a URL, titolo e snippet (Microsoft lo <strong>sconsiglia</strong> sulle pagine da far citare); l'attributo <code>data-snippet</code> controlla quale testo Bing può mostrare o citare (livello di paragrafo). Seer (6 feb 2025): l'87% delle citazioni SearchGPT coincide coi top-20 organic di Bing (vs 56% per Google) — <em>misurazione indipendente di coincidenza; il "~92% via Bing API" è claim vendor non confermato</em>. <strong>IndexNow</strong> notifica Bing ad ogni modifica; Google non lo supporta. L'<strong>AI Performance Report</strong> di Bing Webmaster Tools (public preview da feb 2026) mostra conteggio citazioni, URL citati e un campione delle grounding queries.</p>

      <div class="tablewrap"><table>
        <tr><th>Dimensione</th><th>ChatGPT</th><th>Gemini</th><th>Perplexity</th><th>Copilot</th><th>Claude</th></tr>
        <tr><td>Indice/fonte</td><td>Scraping terzi (+tracce Google)</td><td>Indice Google + KG + Shopping</td><td>Indice proprio + realtime</td><td>Bing/Prometheus</td><td>Esterno (overlap Brave)</td></tr>
        <tr><td>Bot di retrieval</td><td>ChatGPT-User</td><td>Google-Extended / Search</td><td>Perplexity-User</td><td>bingbot / Bing</td><td>Claude-User / Claude-SearchBot</td></tr>
        <tr><td>Fan-out</td><td>Sì (web.run, 2-10+ round)</td><td>Sì (documentato via API)</td><td>Sì (query decomposition)</td><td>Sì (Bing Orchestrator)</td><td>Sì (ricerche multiple)</td></tr>
        <tr><td>Citazione</td><td>Inline, variabile per modello</td><td>frase→chunk (groundingSupports)</td><td>Inline, paragrafo</td><td>Numerata [1][2] + pannello</td><td>Inline, frase (cited_text)</td></tr>
        <tr><td>Distintivo</td><td>Pochi domini autorevoli (Bigfoot)</td><td>Albero sotto-domande</td><td>Freshness + Tier-1</td><td>GEO in policy</td><td>Granularità di frase</td></tr>
        <tr><td>Trasparenza</td><td>Bassa (rev-eng)</td><td>Media (API ufficiale)</td><td>Bassa-media</td><td>Alta (doc + report)</td><td>Media (doc)</td></tr>
      </table></div>
    </div>
  </div>
</section>

<!-- SEC 3 -->
<section id="s3">
  <div class="sec-grid">
    <div class="sec-aside"><span class="num">03</span><span class="lbl">Citabilità</span></div>
    <div class="sec-body">
      <h2>Cosa rende un contenuto citabile</h2>
      <h4>Tattiche con supporto empirico</h4>
      <ul>
        <li><strong>Statistiche e dati specifici</strong> (GEO paper: Statistics Addition +31%).</li>
        <li><strong>Citazioni e quotazioni di fonti</strong> (Quotation Addition +41%, Cite Sources +28%).</li>
        <li><strong>Freschezza</strong> (forte per Perplexity e query news/trend).</li>
        <li><strong>Struttura answer-first</strong> con heading a domanda e risposta diretta nei primi 40-60 token (allineamento col cross-encoder).</li>
        <li><strong>Autorevolezza/E-E-A-T</strong> e citazioni di terze parti; <strong>contenuto non-commodity</strong> con esperienza diretta (confermato dalla guida Google 2026).</li>
        <li><strong>Menzioni del brand:</strong> studio Previsible su 1,96M sessioni → il volume di ricerca del brand è il predittore più forte delle citazioni AI (correlazione 0,334), più dei backlink.</li>
      </ul>
      <p class="note">Avvertenza: claim di vendor come "data-rich citati 2,7x in più" o "FCP &lt;0,4s = 6,7 citazioni" circolano ma non sono verificabili con fonte primaria — vedi sezione Anti-hype.</p>
      <p><strong>Correlazione col ranking tradizionale (dati contrastanti):</strong> Ahrefs a luglio 2025 trovava 76% di overlap tra citazioni AIO e top-10, a gennaio 2026 solo 38% (in parte per migliore rilevamento, in parte per il fan-out). Semrush: ~90% delle citazioni ChatGPT da URL fuori dalla top-20 Google. Il ranking aiuta ma non è condizione necessaria.</p>
      <p><strong>robots.txt per crawler AI:</strong> la strategia "blocca tutti i bot AI" del 2024 è controproducente. Distinguere bot di <strong>training</strong> (GPTBot, ClaudeBot, Google-Extended) dai bot di <strong>retrieval/search</strong> (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, PerplexityBot): bloccare i secondi rimuove il sito dalle citazioni AI.</p>
    </div>
  </div>
</section>

<!-- SEC 4 mercato -->
<section id="s4">
  <div class="sec-grid">
    <div class="sec-aside"><span class="num">04</span><span class="lbl">Mercato IT/UE</span></div>
    <div class="sec-body">
      <h2>Il mercato italiano ed europeo</h2>
      <h4>Adozione</h4>
      <p><strong>Eurostat 2025:</strong> uso di strumenti GenAI in Italia al <strong>20%</strong>, sotto la media UE del 33% e lontano da Norvegia (56%) e Danimarca (48%); riflette il divario nord-sud europeo. ChatGPT in Europa: utenti attivi mensili medi da 11,2 a 41,3 milioni entro marzo 2025 (~+270%). L'Italia è stata il <strong>primo paese al mondo</strong> a bloccare temporaneamente ChatGPT (marzo 2023).</p>
      <h4>Tempistica AI Overviews in Europa</h4>
      <p>Arrivati in Italia il <strong>26 marzo 2025</strong> (con Austria, Belgio, Germania, Irlanda, Polonia, Portogallo, Spagna, Svizzera), ~10 mesi dopo gli USA, in italiano e su Gemini 2.0. Si attivano per query informative a coda lunga. L'AI Mode in italiano non risultava pienamente lanciato a metà 2026.</p>
      <h4>Il panorama globale: i motori AI cinesi</h4>
      <p>La frammentazione non è solo occidentale. Il mercato cinese è il secondo polo mondiale, con una competizione più affollata di quella USA. <strong>Baidu ERNIE:</strong> ERNIE 4.5 reso open-source il 30 giugno 2025 (10 varianti MoE fino a 424B parametri, licenza Apache 2.0); ERNIE Assistant a <strong>202 milioni di MAU</strong> a dicembre 2025; nel Q4 2025 i ricavi in abbonamento dell'infrastruttura AI accelerator sono cresciuti del <strong>+143% YoY</strong> (dal +128% del Q3) e il volume di chiamate dell'AI search API +110% QoQ (comunicato e earnings call Baidu, 26 febbraio 2026). <strong>DeepSeek:</strong> modelli open-source cost-efficient che hanno scosso il mercato a inizio 2025; a metà 2025 una stima attribuiva ~34% della quota API developer a DeepSeek vs ~18% di ERNIE; integrato in Baidu Search e Zhihu. <strong>Gli altri:</strong> secondo QuestMobile (via Caixin), a marzo 2026 <strong>Doubao (ByteDance) è in testa con ~345 milioni di MAU</strong>, davanti a Qwen (Alibaba, ~166M) e DeepSeek (~127M), con Tencent Yuanbao tra i primi quattro; i MAU combinati dei principali player superano i 900 milioni.</p>
      <p class="note">Per un freelance italiano questi motori sono <strong>contesto</strong>, non azione quotidiana. Il punto è strutturale: la logica GEO (retrieval, grounding, citazioni, fan-out) è sostanzialmente la stessa ovunque, e la frammentazione è una tendenza globale, non un'anomalia occidentale. I conteggi MAU cinesi divergono molto tra fonti: sono stime, sempre con fonte e data.</p>
    </div>
  </div>
</section>

<!-- SEC 4bis misurazione -->
<section id="s4bis">
  <div class="sec-grid">
    <div class="sec-aside"><span class="num">04·B</span><span class="lbl">Misurazione</span></div>
    <div class="sec-body">
      <h2>Testare la GEO senza ingannarsi</h2>
      <p>Questa è la sezione che separa il lavoro serio dal teatro. Tesi: <strong>la visibilità in AI search è una distribuzione, non un punteggio.</strong> Trattarla come un rank tracking di Google è l'errore metodologico di fondo da cui derivano quasi tutti i numeri inaffidabili che circolano.</p>
      <h4>Perché una misura singola è inutile (con i numeri)</h4>
      <p>Il dato più rigoroso viene dal paper <strong>"Don't Measure Once: Measuring Visibility in AI Search (GEO)"</strong> (Schulte et al., arXiv:2604.07585, 10 aprile 2026), che ha misurato 4 motori × 8 prompt × 3 campagne con 10 run ciascuno (1.216-1.726 serie per-brand). Una run singola ha un errore standard di <strong>0,370</strong> (CI 95% ±0,724; Table 16, Appendice J): un tasso reale del 50% può apparire <strong>ovunque tra −22% e +122%</strong> — <em>"essentially uninformative"</em>, indistinguibile dal rumore. A <strong>7 run</strong> l'errore standard scende a 0,081 (±0,158) e a <strong>8 run</strong> a 0,062 (±0,121). L'overlap delle fonti tra due giorni consecutivi può cadere nel <strong>34-42%</strong>. Un secondo paper (Sielinski, marzo 2026, arXiv:2603.08924) converge: le distribuzioni di citazione seguono una power law e il 95% dei titoli ChatGPT Shopping appare in meno del 30% delle run dello stesso prompt. Floor minimo difendibile: <strong>10+ run per prompt</strong>.</p>

      <!-- DEMO 4 -->
      <div class="demo" id="demo-se">
        <div class="demo-head"><span class="dot"></span>Demo 04 · Errore standard per numero di run<span class="tag">dati reali · Schulte 2026</span></div>
        <div class="demo-body">
          <label for="se-range">Run ripetute per prompt: <strong id="se-n">1</strong></label>
          <input type="range" id="se-range" min="1" max="9" value="1" step="1">
          <div class="se-readout">
            <div class="se-big" id="se-val">0,370<small>errore standard</small></div>
            <div class="se-runs" id="se-ci">intervallo 95%: ±0,724</div>
          </div>
          <div class="se-track"><div class="se-true"></div><div class="se-ci" id="se-band"></div></div>
          <div class="se-verdict bad" id="se-verdict"></div>
        </div>
        <div class="demo-cap">Valori esatti dalla Table 16 (Appendice J) del paper. La barra rossa è l'intervallo di confidenza al 95% su un tasso reale del 50%: con 1 run può oscillare da −22% a +122%. Sposta il cursore.</div>
      </div>

      <h4>Citation drift: la volatilità nel tempo</h4>
      <p>La volatilità non è solo run-to-run, è anche temporale. <strong>Drift mensile</strong> (% di domini presenti a luglio ma assenti a giugno per gli stessi prompt): <strong>40-60%</strong> (Profound). <strong>Drift semestrale:</strong> <strong>70-90%</strong> confrontando gennaio con luglio; BrightEdge riporta un churn del 70% dei domini citati entro sei mesi (70× volatility gap). <strong>Shock di piattaforma:</strong> la quota di citazioni Reddit in ChatGPT è crollata dal ~60% al ~10% in poche settimane a settembre 2025 (Semrush, 13 settimane); il cambio di modello del 4 marzo 2026 ha tagliato i domini citati del 20% da un giorno all'altro. Regola: <strong>misurare con finestre, non con snapshot</strong> (settimanale per le query strategiche).</p>
      <h4>Protocollo minimo difendibile</h4>
      <ol>
        <li>Definisci <strong>20-30 prompt da buyer reale</strong>, non query di brand vanity ("qual è il miglior X per Y", non "parlami di [il mio brand]").</li>
        <li>Esegui su più motori (ChatGPT, Perplexity, Google AI Overviews/AI Mode, Gemini) — la visibilità in uno non predice gli altri.</li>
        <li>Ripeti ogni prompt <strong>7-10 volte, distribuite su più giorni</strong> (non 10 volte nello stesso minuto).</li>
        <li>Logga tre cose per run: se sei apparso, quale pubblicazione è stata citata, quale competitor è stato nominato al tuo posto.</li>
        <li>Calcola intervalli di confidenza bootstrap sul tasso di detection per brand, non medie nude.</li>
        <li>Riporta <strong>per-engine</strong> (l'aggregato cross-engine nasconde i pattern).</li>
        <li>Per testare una modifica: misura il baseline su finestra, applica, attendi il re-crawl, misura su finestra equivalente. Confronta distribuzioni, non punti. Usa un <strong>gruppo di controllo</strong> (pagine non modificate) per separare l'effetto dal drift di sfondo.</li>
      </ol>
      <h4>Metriche che contano (e una da togliere)</h4>
      <p>Dalla reference di Nick Lafferty (2026) e dagli studi citati: <strong>Citation Share per engine</strong> (la metrica centrale); <strong>Time-to-First-Citation</strong> (riportato come distribuzione — mediana, P75, P90 — mai come media); <strong>Inline Brand Hyperlink Share</strong> (quota di risposte con link cliccabile, peso cresciuto dopo che il cambio ChatGPT del 7 maggio 2026 ha triplicato i referral B2B SaaS); <strong>Co-citation Rate</strong>; <strong>Citation Rank Stability</strong> (la metrica del paper Schulte che quasi tutti i cruscotti saltano). <strong>Da togliere se vendi software/servizi:</strong> lo <strong>Shopping Trigger Rate</strong> — su ~2 milioni di prompt il 79% non ha mai triggerato Shopping e solo il ~6% triggera in modo affidabile; la categoria del prompt da sola predice il trigger col 95-97% di accuratezza.</p>
      <h4>Replicare il GEO paper in proprio</h4>
      <p>Il GEO paper originale è replicabile a costo contenuto. (1) Prendi 10-20 pagine/chunk target e crea due varianti: baseline e trattata (+ statistiche citate, o + quotazioni). (2) Costruisci 30-50 query realistiche. (3) Sottoponi le query con search attiva, <strong>7-10 run per query per variante</strong>, alternando l'ordine per evitare bias di posizione. (4) Misura il <strong>Position-Adjusted Word Count</strong>, oltre alla presenza/assenza. (5) Confronta le distribuzioni con un test non parametrico (Mann-Whitney). Aspettativa calibrata: <strong>+20-40%</strong>, non "10x", con Statistics e Quotation come leve più forti. Se vedi +300%, è quasi certamente rumore da campione troppo piccolo.</p>
      <p class="note">Regola pratica: se un claim GEO non dichiara quante volte ha ripetuto ogni prompt e su quale periodo, è aneddoto. Con SE 0,370 a una run, qualsiasi cifra a due decimali senza run ripetute è statisticamente sospetta.</p>
    </div>
  </div>
</section>

<!-- SEC 4ter diritto -->
<section id="s4ter">
  <div class="sec-grid">
    <div class="sec-aside"><span class="num">05</span><span class="lbl">Diritto UE/IT</span></div>
    <div class="sec-body">
      <h2>Il quadro che vincola la GEO in Europa</h2>
      <p>Questa sezione conta per un freelance italiano più di quanto sembri: le scelte di <code>robots.txt</code>, di licensing e di gestione dei contenuti dei clienti hanno implicazioni legali concrete sotto il diritto UE, il più stringente al mondo su AI e copyright.</p>
      <h4>Eccezione TDM e opt-out (art. 4 CDSM): il cardine giuridico</h4>
      <p>Il fondamento dell'addestramento commerciale di AI in Europa è la <strong>Direttiva (UE) 2019/790 (CDSM)</strong>: l'<strong>art. 3</strong> copre il TDM per scopi <em>scientifici</em> (organismi di ricerca, non l'AI commerciale); l'<strong>art. 4</strong> copre il TDM generale (commerciale), diventato <em>"the cornerstone of commercial AI training in the EU"</em>, pur aggiunto nelle fasi finali del processo legislativo senza valutazione d'impatto sulla GenAI. Il meccanismo chiave è l'<strong>opt-out dell'art. 4(3):</strong> il TDM è permesso di default <em>salvo</em> riserva espressa in modo appropriato, <em>"ad esempio con strumenti leggibili meccanicamente"</em> (machine-readable) per i contenuti pubblici online (Considerando 18). Il ponte con l'<strong>AI Act:</strong> l'art. 53(1)(c) obbliga i fornitori di modelli GPAI a <em>"identificare e rispettare … le riserve di diritti espresse ai sensi dell'art. 4(3)"</em>; il Considerando 106 sancisce un <strong>"Brussels effect"</strong> — l'obbligo si applica a qualunque fornitore immetta un modello GPAI sul mercato UE <em>"a prescindere dalla giurisdizione in cui avvengono gli atti di addestramento"</em>. Anche un modello addestrato negli USA, se offerto in UE, deve rispettare gli opt-out europei.</p>
      <h4>Il problema irrisolto: cosa rende un opt-out "valido"</h4>
      <p>La direttiva <strong>non prescrive uno standard tecnico unico</strong> e la giurisprudenza nazionale è divergente. <strong>Kneschke v. LAION</strong> (Tribunale di Amburgo, 27 set 2024): la costruzione del dataset era coperta dall'equivalente tedesco dell'art. 3, ma con dubbi sull'art. 4 per lo sfruttamento commerciale a valle; in una pronuncia successiva si è affermato che un opt-out in <em>"linguaggio naturale"</em> nei ToS può qualificarsi come machine-readable. <strong>DPG Media v. HowardsHome</strong> (Tribunale di Amsterdam, fine 2024): la riserva deve essere <em>"praticamente rilevabile ed elaborabile da sistemi automatizzati"</em>. Le due direzioni sono <em>"markedly different"</em> → <strong>affidarsi solo a una clausola nei termini d'uso è rischioso; serve anche un segnale tecnico</strong> (robots.txt, metadati, header). Argomento aggiuntivo (Synodinou-Vrakas, nov 2025): i dataset costruiti per scraping indiscriminato possono includere opere <em>accessibili pubblicamente ma non "legalmente accedute"</em>, fuori dalla protezione dell'eccezione TDM.</p>
      <h4>La spinta del Parlamento UE a riformare l'opt-out</h4>
      <p>Nell'ambito della procedura di iniziativa <strong>2025/2058(INI)</strong> <em>"Copyright and generative AI"</em> (commissione JURI, relatore <strong>Axel Voss</strong>), due documenti distinti: (1) lo <strong>studio JURI PE 774095</strong> (Prof. Nicola Lucchi, <strong>9 luglio 2025</strong>), che conclude che l'addestramento <em>"far exceeds the scope of the current TDM exceptions"</em>; (2) il <strong>draft report / Motion for a resolution PE775.433</strong> (<strong>27 giugno 2025</strong>), che chiede norme più chiare, trasparenza sui dati di training e un obbligo di remunerazione. La risoluzione è stata adottata in plenaria il <strong>10 marzo 2026</strong> (T10-0066/2026). La maggioranza ritiene comunque <strong>non necessario</strong> un nuovo strumento legislativo "at this stage" — segno di una tensione politica irrisolta.</p>
      <h4>Il caso italiano: FIEG vs Google, DSA e il dilemma dell'opt-out</h4>
      <p><strong>15 ottobre 2025:</strong> la <strong>FIEG</strong> deposita un reclamo formale all'<strong>AGCOM</strong> contro <strong>AI Overview e AI Mode</strong>, definendoli <em>"traffic killer"</em>. L'accusa non è di copyright ma di <strong>violazione del DSA</strong>: configurerebbero concorrenza impropria, riduzione strutturale di visibilità e ricavi, e <em>"un rischio sistemico per la sostenibilità economica dell'intero ecosistema dell'informazione"</em>. <strong>29 aprile 2026</strong> (atto distinto e successivo): all'esito di audizioni con Google, FIEG e FISC, l'AGCOM — nel ruolo di Coordinatore nazionale dei servizi digitali — decide di <strong>trasmettere alla Commissione europea, ex art. 65 DSA, una richiesta di valutazione</strong> dei servizi Google AI Overviews e AI Mode in relazione agli artt. 27, 34 e 35 DSA (rischi sistemici per pluralismo e libertà di informazione; trasparenza dei sistemi di raccomandazione). Comunicato del 30 aprile 2026; decisione assunta con il <strong>voto contrario della commissaria Elisa Giomi</strong>. È una <strong>segnalazione</strong> finalizzata all'eventuale apertura di un'indagine della Commissione — non un procedimento sanzionatorio autonomo dell'AGCOM.</p>
      <blockquote>Esercitare l'opt-out (bloccare i crawler AI) protegge il copyright ma <strong>rimuove il contenuto dalle risposte generative</strong>, azzerando la visibilità GEO. Gli editori chiedono di poter fare opt-out <em>senza</em> perdere visibilità — ma tecnicamente, oggi, le due cose sono in larga parte la stessa leva.</blockquote>
      <p>Per un sito SME/e-commerce (non un editore) la scelta razionale è quasi sempre <strong>non</strong> fare opt-out dai bot di <em>retrieval</em> (vuoi essere citato); l'opt-out dai bot di <em>training</em> ha costo quasi nullo in visibilità immediata. Vanno distinti: bloccare GPTBot (training) non toglie da ChatGPT Search; bloccare OAI-SearchBot/ChatGPT-User sì.</p>
      <h4>Garante Privacy e GDPR: il precedente italiano</h4>
      <p>Il <strong>Garante italiano</strong> è stato il primo regolatore al mondo a limitare ChatGPT (31 marzo 2023, Provv. 112/2023): mancanza di informativa, assenza di base giuridica per il training, carente tutela dei minori. Riattivazione il 28 aprile 2023 dopo misure correttive (informativa, diritto di opposizione anche per i non-utenti, verifica età). Sanzione del 2024 (Provv. 755): <strong>15 milioni di euro</strong>; OpenAI fa opposizione e il <strong>Tribunale di Roma annulla la sanzione</strong> (sent. n. 4153/2026, depositata il 18 marzo 2026), dopo di che il provvedimento è stato rimosso dal sito del Garante. <em>(Le motivazioni non risultano ancora pubbliche a metà 2026.)</em> Il "diritto di opposizione" esteso ai non-utenti è un precedente di opt-out su base privacy parallelo a quello copyright.</p>
      <h4>Timeline operativa dell'AI Act</h4>
      <ul>
        <li><strong>1 agosto 2024:</strong> entrata in vigore (Reg. UE 2024/1689).</li>
        <li><strong>2 agosto 2025:</strong> applicabili gli obblighi per i modelli GPAI (policy copyright e "riassunto sufficientemente dettagliato" dei dati di training); pubblicato il GPAI Code of Practice.</li>
        <li><strong>2 agosto 2026:</strong> piena applicabilità, inclusi gli obblighi di etichettatura dei contenuti generati da AI e dei deepfake.</li>
      </ul>
      <p>Per un freelance: gli obblighi diretti ricadono sui <em>fornitori</em> di modelli, non su chi pubblica siti. Ma l'etichettatura dei contenuti AI-generati dei clienti e la gestione corretta di opt-out/licensing diventano parte della due diligence professionale.</p>
    </div>
  </div>
</section>

<!-- SEC 5 pratica -->
<section id="s5">
  <div class="sec-grid">
    <div class="sec-aside"><span class="num">06</span><span class="lbl">Pratica</span></div>
    <div class="sec-body">
      <h2>Implicazioni operative</h2>
      <h4>Cosa resta valido dalla SEO classica</h4>
      <p>Crawlability e indicizzazione (estese a Bing per ChatGPT e ai bot AI di retrieval); autorevolezza/E-E-A-T; HTML semantico e velocità; rendering server-side (molti bot AI fetchano ma non eseguono JS).</p>
      <h4>Cosa è nuovo nella GEO</h4>
      <p>Ottimizzazione a livello di chunk/passaggio (non di pagina); ampiezza topica per il query fan-out (pillar + cluster); costruzione di entità/brand; diversificazione delle superfici (YouTube, Reddit); indicizzazione su Bing.</p>
      <h4>Raccomandazioni operative in tre fasi</h4>
      <ol>
        <li><strong>Fase 1 — Fondamenta tecniche (immediato):</strong> verifica l'indicizzazione su Bing Webmaster Tools (prerequisito per ChatGPT) e usa IndexNow; audita il robots.txt consentendo i bot di retrieval (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User) anche bloccando il training; rendering server-side del contenuto chiave e HTML semantico pulito.</li>
        <li><strong>Fase 2 — Contenuto (1-3 mesi):</strong> riscrivi le pagine top in formato answer-first (heading a domanda, risposta diretta nei primi 40-60 token); inserisci statistiche citate e quotazioni (le leve con più evidenza); aggiorna trimestralmente i contenuti chiave (freschezza, specie per Perplexity); struttura in chunk autosufficienti che coprano le sotto-domande (per il fan-out), architettura pillar + cluster — scrivendo bene, non spezzando artificialmente.</li>
        <li><strong>Fase 3 — Autorità e misurazione (3-6 mesi):</strong> costruisci menzioni di brand e citazioni di terze parti (G2/Trustpilot, PR digitale, YouTube, Reddit; Wikipedia per il grounding delle entità dove rilevante); implementa un tool di tracking AI (Otterly entry, Peec AI per il multilingua europeo, Profound enterprise) e monitora trend con run ripetute, non snapshot.</li>
      </ol>
      <h4>Soglie che cambiano le scelte</h4>
      <ul>
        <li>Se il traffico da AI search supera l'1-2% (oggi tipicamente &lt;1% ma converte meglio dell'organico), aumenta l'investimento GEO.</li>
        <li>Se l'overlap tra citazioni AI e ranking organico è basso, dai priorità a chunkability e autorevolezza.</li>
        <li>Per l'Italia, monitora il lancio dell'AI Mode in italiano e l'evoluzione del caso FIEG-AGCOM e del quadro copyright UE.</li>
      </ul>
    </div>
  </div>
</section>

<!-- SEC 6 antihype -->
<section id="s6">
  <div class="sec-grid">
    <div class="sec-aside"><span class="num">07</span><span class="lbl">Anti-hype</span></div>
    <div class="sec-body">
      <h2>Cosa smontare nel discorso GEO</h2>
      <p>Questa sezione isola i claim GEO che circolano come verità ma hanno evidenza debole, nulla o contraria. Criterio unico: <strong>fonte primaria o esperimento replicabile vs ripetizione tra influencer.</strong></p>
      <h4>Google smonta 5 miti (15 maggio 2026)</h4>
      <p>Il <strong>15 maggio 2026</strong> Google Search Central ha pubblicato la guida ufficiale <em>"Optimizing your website for generative AI features on Google Search"</em> (annunciata da John Mueller). È la dichiarazione on-record più esplicita su cosa funziona per AI Overviews e AI Mode. Tesi di fondo: <strong>"AEO e GEO sono ancora SEO"</strong>, perché le feature AI girano sugli stessi sistemi di ranking della Search classica. Google classifica come <strong>non necessari</strong>: (1) <strong>file <code>llms.txt</code> e markup speciali</strong> — <em>"You don't need to create new machine readable files, AI text files, markup, or Markdown to appear in generative AI search"</em>; (2) il <strong>chunking del contenuto</strong> — i sistemi <em>"are able to understand the nuance of multiple topics on a page"</em>; (3) le <strong>riscritture AI-specifiche</strong>; (4) le <strong>menzioni inautentiche</strong> (link-building e menzioni artificiali); (5) l'<strong>uso eccessivo di schema/structured data</strong>. Cosa fare <em>davvero</em>: SEO solida, contenuto non-commodity con prospettive uniche ed esperienza diretta, asset multimodali.</p>
      <p>A rafforzare la posizione, il <strong>5 giugno 2026</strong> Google ha pubblicato <em>"Google Search's guidance on using third-party SEO tools, services, and advice"</em> e aggiornato <em>"Do you need an SEO?"</em>, nominando esplicitamente <strong>AEO e GEO come categorie di servizio</strong>. Google <strong>legittima la disciplina</strong> ma ne <strong>restringe il perimetro</strong> — resta "ancora SEO" — e invita alla cautela verso chi promette scorciatoie o garanzie di citazione nelle risposte AI.</p>
      <div class="panel">
        <h4>La tensione onesta sul chunking</h4>
        <p style="margin:0">Google ha ragione su un punto: non devi spezzare <em>fisicamente</em> la pagina in micro-file né riscrivere in "formato AI" — i suoi sistemi fanno il chunking lato loro e capiscono pagine multi-tema. Ma <strong>"non serve il chunking manuale" ≠ "la struttura non conta":</strong> la ricerca sul RAG mostra che chunk netti e autosufficienti migliorano il retrieval <em>a parità di tutto il resto</em>, e li ottieni <strong>scrivendo bene</strong> (heading chiari, un'idea per sezione, risposte dirette), non manipolando la struttura per il bot. Distinzione cruciale: la guida vale per <em>Google</em> (che gira sul ranking Search); per ChatGPT, Perplexity e Claude (pipeline RAG proprie) la struttura resta più rilevante. Generalizzare "il chunking è morto" a tutti i motori è iper-estensione. <strong>Verdetto:</strong> smetti di vendere "ottimizzazione del chunking" come servizio a sé; continua a scrivere contenuto strutturato bene.</p>
      </div>
      <h4>llms.txt — il caso da manuale di hype</h4>
      <p>Una proposta di Jeremy Howard (settembre 2024), un file Markdown nella root per aiutare gli LLM a usare un sito in inferenza; nasce per la <em>documentazione tecnica destinata a dev tool</em>, non come leva SEO. Le prove contro: Google (Mueller, Illyes) dichiara di non usarlo e lo paragona al "keywords meta tag" obsoleto; Otterly rileva 84 richieste su 62.100 in 90 giorni (0,1%); Ahrefs (mag 2026, ~38.000 file validi su 137.210 domini) rileva che il <strong>97% dei file non riceve alcuna richiesta</strong>; SE Ranking (~300.000 domini) non trova correlazione con le citazioni; Search Engine Land: <em>"there is no data or evidence showing that llms.txt files boost AI inclusion."</em> Il granello di verità: Wix (AI Search Lab, oltre 1.400 file, nov 2025) stima i file indicizzati saliti da ~30-60.000 a ~120.000 (mag 2026, picco ~200.000 ad aprile) — ma è una <strong>stima di parte non verificata</strong> (la cifra "125.000" del sottotitolo non coincide col "~120.000" del corpo) e, parole della stessa fonte, <em>"this will not make or break your GEO strategy."</em> <strong>Verdetto:</strong> leva di citazione AI <strong>non provata, con evidenza prevalentemente contraria</strong>. Caso d'uso legittimo e ristretto (documentazione per agenti/dev tool). Priorità realistica: bassissima.</p>
      <h4>Servire le pagine anche in Markdown — marginale, spesso hype</h4>
      <p>Conviene pubblicare una versione Markdown delle pagine per farsi citare meglio? <strong>Per i motori mainstream è marginale/situazionale, non provato</strong>, e in alcune forme è rischioso. Distinzione tecnica: la <strong>content negotiation</strong> via <code>Accept: text/markdown</code> sullo <em>stesso</em> URL è standard HTTP legittimo; i <strong>file <code>.md</code> a URL separati</strong> sono definiti da Google e Bing come potenziale cloaking e raddoppio del crawl budget. I crawler di ricerca (GPTBot, OAI-SearchBot, ChatGPT-User, PerplexityBot, ClaudeBot, Googlebot, Bingbot) <strong>non negoziano Markdown</strong> — lo fanno solo alcuni agenti di coding in sessione live (Claude Code, Cursor, OpenCode — test Checkly, feb 2026). Evidenza empirica di effetto nullo/non significativo: Profound (esperimento controllato, 381 pagine, gen-feb 2026) trova ~16% di lift <em>non statisticamente significativo</em>, trainato da outlier; Otterly trova 0% di traffico bot AI e zero citazioni ai file <code>.md</code>. Il vantaggio reale del Markdown è la tokenizzazione (~80% di token in meno secondo Cloudflare), ma beneficia chi <em>converte</em> l'HTML (Jina Reader, Firecrawl, le pipeline RAG, Claude Code via Turndown lo fanno già). Google (15 mag 2026): <em>"You don't need to create new machine readable files, AI text files, markup, or Markdown … as Google Search itself doesn't use them"</em>; Mueller (feb 2026) definisce convertire le pagine solo per i bot <em>"such a stupid idea"</em>. <strong>Verdetto:</strong> utile solo per documentazione tecnica/SaaS/API consultata da agenti in tempo reale; per un sito generico conta molto di più l'HTML semantico pulito. Se lo implementi, usa content negotiation con <code>Vary: Accept</code>, mai file <code>.md</code> indicizzabili separati.</p>
      <h4>Schema/structured data — utile, ma non per il motivo che ti dicono</h4>
      <p>Il claim hype: "senza schema.org non vieni citato dall'AI". Google (maggio 2026) lo dichiara <strong>non richiesto</strong> per generare risposte AI; Pedro Dias e altri hanno mostrato che lo schema non influenza le citazioni ChatGPT. Gli studi di correlazione esistono ma sono <strong>confusi da variabili terze</strong>: i siti con schema tendono a essere anche più curati e autorevoli — la correlazione non isola lo schema come causa. <strong>Verdetto bilanciato:</strong> resta utile per i suoi scopi classici (rich result, parsing, disambiguazione di entità) e per la Search tradizionale, non come "trucco AI".</p>
      <h4>I numeri-civetta dei vendor</h4>
      <p>Percentuali precise senza fonte primaria nominata: "data-rich citati 2,7x in più", "FCP &lt;0,4s = 6,7 citazioni medie", "heading ben organizzati = 2,8x più citate" (AirOps — quest'ultima almeno ha un dataset dichiarato di 45.000 citazioni, più difendibile). Spesso mancano metodologia, dimensione del campione, numero di run e gruppo di controllo. Alla luce del SE 0,370 a una run, qualsiasi cifra a due decimali ottenuta senza run ripetute è statisticamente sospetta. <strong>Regola pratica:</strong> se un claim non dichiara quante volte ha ripetuto ogni prompt e su quale periodo, è aneddoto.</p>
      <h4>"Il SEO è morto" — l'iper-estensione opposta</h4>
      <p>Altrettanto falsa: i dati Ahrefs/Semrush mostrano che il ranking organico tradizionale <strong>resta correlato</strong> (anche se non più condizione necessaria) con la citazione AI; gli AI Overviews girano <em>sopra</em> il sistema di ranking Search; la "visibilità parametrica" si costruisce con gli stessi segnali del SEO classico (autorità, copertura stampa, Wikipedia, backlink, menzioni). Google stessa intitola la sua posizione "AEO e GEO sono ancora SEO". <strong>La GEO è un'estensione del SEO, non un suo sostituto.</strong> Le fondamenta sono <em>più</em> importanti, non meno; ciò che cambia è il livello di competizione (chunk vs pagina), le superfici e le metriche.</p>
      <div class="tablewrap"><table>
        <tr><th>Claim GEO</th><th>Verdetto</th><th>Priorità</th></tr>
        <tr><td>Statistiche + citazioni di fonti</td><td><span class="badge b-ok">Provato</span></td><td>Alta</td></tr>
        <tr><td>Freschezza del contenuto</td><td><span class="badge b-ok">Provato</span></td><td>Alta</td></tr>
        <tr><td>Contenuto non-commodity / esperienza diretta</td><td><span class="badge b-ok">Confermato</span></td><td>Alta</td></tr>
        <tr><td>Struttura answer-first</td><td><span class="badge b-ok">Solido</span></td><td>Alta</td></tr>
        <tr><td>Menzioni brand &gt; backlink</td><td><span class="badge b-warn">1 studio</span></td><td>Media</td></tr>
        <tr><td>Schema per citazione AI</td><td><span class="badge b-warn">Sopravvalutato</span></td><td>Bassa</td></tr>
        <tr><td>Chunking manuale</td><td><span class="badge b-bad">Mito (Google)</span></td><td>Bassa</td></tr>
        <tr><td>llms.txt come leva</td><td><span class="badge b-bad">Non provato</span></td><td>Bassissima</td></tr>
        <tr><td>Servire pagine in Markdown</td><td><span class="badge b-warn">Marginale</span></td><td>Bassa</td></tr>
        <tr><td>Numeri-civetta "2,7x"</td><td><span class="badge b-bad">Aneddoto</span></td><td>Ignora</td></tr>
        <tr><td>"Il SEO è morto"</td><td><span class="badge b-bad">Falso</span></td><td>—</td></tr>
      </table></div>
      <div class="note"><strong>Caveats di fondo.</strong> Distinguere fatti documentati da claim dei vendor: indici e numeri Pew/SparkToro/Ahrefs/Seer sono ben documentati; molti "fattori di citazione" precisi provengono da blog di vendor non verificabili. L'overlap tra citazioni AIO e top-10 varia tra studi (38% vs 76%) anche per differenze metodologiche. Le previsioni sono previsioni (il 25% di Gartner è una stima del 2024). I dettagli su <code>web.run</code>, fan-out e system prompt di ChatGPT derivano da analisi indipendenti (RESONEO/Meteoria, AirOps, Dejan), non da documentazione ufficiale completa, e cambiano da un modello all'altro. Le pipeline cambiano rapidamente (Gemini 3 gen 2026, switch ChatGPT 5.3 mar 2026): ogni dato ha una data di validità.</div>
    </div>
  </div>
</section>

</div>
</main>

<footer>
  <div class="wrap">
    <h2>Fonti principali</h2>
    <div class="biblio">
      <h4>Paper accademici e benchmark</h4>
      <ul>
        <li>Aggarwal P. et al., <em>GEO: Generative Engine Optimization</em>, arXiv:2311.09735 (KDD 2024) — <a href="https://arxiv.org/abs/2311.09735">arxiv.org/abs/2311.09735</a></li>
        <li>Schulte J. et al., <em>Don't Measure Once</em>, arXiv:2604.07585 (10 apr 2026) — <a href="https://arxiv.org/abs/2604.07585">arxiv.org/abs/2604.07585</a></li>
        <li>Sielinski R., incertezza nella misurazione di visibilità AI (mar 2026), arXiv:2603.08924</li>
        <li>Gemini Team, <em>Gemini 2.5 Technical Report</em>, arXiv:2507.06261 — <a href="https://arxiv.org/pdf/2507.06261">arxiv.org/pdf/2507.06261</a></li>
        <li>Vecta Benchmark (feb 2026); arXiv:2506.17277 (chimica); arXiv:2512.05411 (enterprise); arXiv:2506.06339 (arabo); MDPI Bioengineering (nov 2025); BEIR arXiv:2104.08663; <em>LegalBench-RAG</em> arXiv:2408.10343</li>
        <li>Khattab O., Zaharia M., <em>ColBERT</em> (SIGIR 2020); Santhanam et al., <em>ColBERTv2/PLAID</em> (2022)</li>
      </ul>
      <h4>Retrieval / embeddings / chunking / reranking</h4>
      <ul>
        <li>Towards Data Science, <em>Advanced RAG Retrieval: Cross-Encoders &amp; Reranking</em> — <a href="https://towardsdatascience.com/advanced-rag-retrieval-cross-encoders-reranking/">towardsdatascience.com</a></li>
        <li>Pinecone, <em>Rerankers and Two-Stage Retrieval</em> — <a href="https://www.pinecone.io/learn/series/rag/rerankers/">pinecone.io</a>; Weaviate, <em>Late Interaction</em> — <a href="https://weaviate.io/blog/late-interaction-overview">weaviate.io</a>; Qdrant, <em>Late Interaction Models</em> — <a href="https://qdrant.tech/articles/late-interaction-models/">qdrant.tech</a></li>
        <li>Firecrawl, <em>Best Chunking Strategies for RAG (2026)</em> — <a href="https://www.firecrawl.dev/blog/best-chunking-strategies-rag">firecrawl.dev</a>; Chroma, <em>Context Rot research</em> (lug 2025)</li>
      </ul>
      <h4>Reverse-engineering motori</h4>
      <ul>
        <li>de Segonzac O. (RESONEO/Meteoria), <em>Inside ChatGPT Search: web.run</em>, Search Engine Land (14 mag 2026) — <a href="https://searchengineland.com/inside-chatgpt-search-web-run-fan-out-queries-ai-visibility-477339">searchengineland.com</a>; studio: <a href="https://think.resoneo.com/chatgpt/5.3-5.4/">think.resoneo.com</a></li>
        <li>Google, <em>Gemini API — Grounding</em> (groundingMetadata) — <a href="https://ai.google.dev/gemini-api/docs/google-search">ai.google.dev</a></li>
        <li>Yeşilyurt M., reranking Perplexity (ago 2025), via Search Engine Land; AuthorityTech, <em>How Perplexity Selects Sources</em> — <a href="https://authoritytech.io/blog/how-perplexity-selects-sources-algorithm-2026">authoritytech.io</a>; GrowthMarshal <em>Perplexity Playbook</em>; RankStudio <em>Sonar &amp; PPLX Deep Dive</em></li>
        <li>Anthropic, <em>Web search tool — Claude API Docs</em> — <a href="https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool">platform.claude.com</a>; Seer Interactive, <em>SearchGPT ↔ Bing 87%</em> (feb 2025)</li>
      </ul>
      <h4>Microsoft Copilot / Bing</h4>
      <ul>
        <li>Microsoft Bing Blog, <em>Building the New Bing</em> (Prometheus, Bing Orchestrator) — <a href="https://blogs.bing.com/search-quality-insights/february-2023/Building-the-New-Bing">blogs.bing.com</a></li>
        <li>Bing Webmaster Guidelines (riscrittura 27 feb 2026); analisi NOARCHIVE/NOCACHE/data-snippet (SEJ, WrittenlyHub); Seer Interactive, <em>87% SearchGPT ↔ Bing</em> — <a href="https://www.seerinteractive.com/insights/searchgpt-citations-bing">seerinteractive.com</a>; Microsoft <em>IndexNow</em> e <em>AI Performance Report</em> (feb 2026)</li>
      </ul>
      <h4>Motori AI cinesi</h4>
      <ul>
        <li>Baidu, <em>Q4 &amp; FY2025 Results</em> (26 feb 2026) — <a href="https://ir.baidu.com/news-releases/news-release-details/baidu-announces-fourth-quarter-and-fiscal-year-2025-results">ir.baidu.com</a>; earnings call via Investing.com</li>
        <li>ERNIE 4.5 open-source (30 giu 2025, Apache 2.0) — @Baidu_Inc, TechNode, SCMP; DeepSeek ~34% vs ERNIE ~18% (metà 2025) — SiliconANGLE, TechRadar Pro; QuestMobile via Caixin (Doubao ~345M MAU, mar 2026)</li>
      </ul>
      <h4>Misurazione / volatilità</h4>
      <ul>
        <li>Profound, <em>AI Search Volatility</em> — <a href="https://www.tryprofound.com/blog/ai-search-volatility">tryprofound.com</a>; AirOps, <em>AI Visibility Metrics</em> — <a href="https://www.airops.com/blog/ai-visibility-metrics">airops.com</a></li>
        <li>Lafferty N., <em>AI Visibility Metrics Reference (2026)</em> — <a href="https://nicklafferty.com/blog/ai-visibility-metrics-reference/">nicklafferty.com</a>; Machine Relations, <em>Citation Drift</em> (BrightEdge 70x, Semrush Reddit 60→10%) — <a href="https://medium.com/machine-relations/citation-drift-ai-visibility-data-d7c2eea8e223">medium.com/machine-relations</a></li>
      </ul>
      <h4>Guida ufficiale Google e anti-hype</h4>
      <ul>
        <li>Google Search Central, <em>A new resource for optimizing for generative AI in Search</em> (15 mag 2026) — <a href="https://developers.google.com/search/blog/2026/05/a-new-resource-for-optimizing">developers.google.com</a>; <em>third-party SEO tools/services</em> e <em>Do you need an SEO?</em> (5 giu 2026, nomina AEO/GEO) — <a href="https://www.digitalapplied.com/blog/google-official-seo-docs-generative-ai-optimization-june-2026">digitalapplied.com</a></li>
        <li>Search Engine Journal, <em>AEO And GEO 'Still SEO'</em> — <a href="https://www.searchenginejournal.com/googles-new-ai-search-guide-calls-aeo-and-geo-still-seo/575026/">searchenginejournal.com</a>; Search Engine Land, <em>GEO myths</em> — <a href="https://searchengineland.com/geo-myths-lies-467617">searchengineland.com</a></li>
        <li>Wix Studio, <em>Debunking LLMs.txt Myths</em> — <a href="https://www.wix.com/studio/ai-search-lab/llms-txt-myths">wix.com/studio</a>; Ahrefs, <em>97% of llms.txt files never get read</em> — <a href="https://ahrefs.com/blog/llmstxt-study/">ahrefs.com</a>; SE Ranking — <a href="https://seranking.com/blog/llms-txt/">seranking.com</a>; Otterly — <a href="https://otterly.ai/blog/the-llms-txt-experiment/">otterly.ai</a>; SEJ, <em>Mueller: llms.txt Can't Help LLMs Differentiate Sites</em> — <a href="https://www.searchenginejournal.com/googles-mueller-says-llms-txt-cant-help-llms-differentiate-sites/579304/">searchenginejournal.com</a></li>
        <li>Markdown per le pagine — Google <em>AI optimization guide</em> — <a href="https://developers.google.com/search/docs/fundamentals/ai-optimization-guide">developers.google.com</a>; Profound <em>Markdown vs HTML</em> — <a href="https://www.tryprofound.com/blog/does-markdown-increase-ai-bot-traffic">tryprofound.com</a>; Otterly <em>Markdown vs HTML</em> — <a href="https://otterly.ai/blog/geo-experiment-html-vs-markdown/">otterly.ai</a>; Checkly <em>content negotiation</em> — <a href="https://www.checklyhq.com/blog/state-of-ai-agent-content-negotation/">checklyhq.com</a>; Cloudflare <em>Markdown for Agents</em> — <a href="https://blog.cloudflare.com/markdown-for-agents/">blog.cloudflare.com</a>; Search Engine Land — <a href="https://searchengineland.com/google-bing-dont-recommend-seperate-markdown-pages-for-llms-468365">searchengineland.com</a></li>
      </ul>
      <h4>Quadro giuridico UE/Italia</h4>
      <ul>
        <li>Direttiva (UE) 2019/790 (CDSM), artt. 3-4; AI Act (Reg. UE 2024/1689), art. 53(1)(c), Considerando 106; EPRS, <em>AI and copyright</em> — <a href="https://www.europarl.europa.eu/RegData/etudes/ATAG/2025/769585/EPRS_ATA(2025)769585_EN.pdf">europarl.europa.eu</a></li>
        <li>Parlamento UE 2025/2058(INI) (relatore Voss): studio JURI PE 774095 (Lucchi, 9 lug 2025), draft report PE775.433 (27 giu 2025), risoluzione T10-0066/2026 (10 mar 2026) — <a href="https://oeil.secure.europarl.europa.eu/oeil/en/procedure-file?reference=2025/2058(INI)">oeil.europarl.europa.eu</a>; Jones Day, <em>EP study on GenAI and copyright</em> — <a href="https://www.jonesday.com/en/insights/2025/08/european-parliaments-new-study-on-generative-ai-and-copyright-calls-for-overhaul-of-optout-regime">jonesday.com</a></li>
        <li>Kluwer Copyright Blog, <em>The TDM Opt-Out in the EU</em> — <a href="https://legalblogs.wolterskluwer.com/copyright-blog/the-tdm-opt-out-in-the-eu-five-problems-one-solution/">legalblogs.wolterskluwer.com</a>; Synodinou-Vrakas, <em>Lawful Access as a Gatekeeper for TDM</em>, Verfassungsblog (17 nov 2025) — <a href="https://verfassungsblog.de/lawful-access-gatekeeper/">verfassungsblog.de</a>; Kneschke v. LAION (Amburgo, 27 set 2024); DPG Media v. HowardsHome (Amsterdam)</li>
        <li>Agenda Digitale, <em>Editori italiani (FIEG) contro l'AI di Google</em> — <a href="https://www.agendadigitale.eu/mercati-digitali/editori-italiani-fieg-contro-lai-di-google-ecco-le-basi-del-reclamo-agcom/">agendadigitale.eu</a>; Key4biz, <em>FIEG contro Google</em> — <a href="https://www.key4biz.it/fieg-contro-google-ai-overview-e-un-traffic-killer-chiesto-lintervento-dellagcom-per-violazione-del-dsa/550920/">key4biz.it</a>; AGCOM, segnalazione ex art. 65 DSA (29 apr 2026, comunicato 30 apr 2026) — ANSA, Primaonline; Agenda Digitale — <a href="https://www.agendadigitale.eu/mercati-digitali/ai-di-google-e-giornali-la-palla-e-nel-campo-dellue-il-quadro/">agendadigitale.eu</a></li>
        <li>Garante Privacy, Provv. 112/2023 e 755/2024; Tribunale di Roma sent. 4153/2026 (annullamento sanzione) — Altalex; Eurostat via Euronews, adozione GenAI in Europa — <a href="https://www.euronews.com/next/2025/12/29/chatgpt-gemini-grok-and-others-which-countries-use-generative-ai-tools-most-across-europe">euronews.com</a></li>
      </ul>
      <h4>Strumenti di misurazione GEO</h4>
      <ul>
        <li>Surmado, <em>Best AI Visibility Tools 2026</em> — <a href="https://www.surmado.com/blog/best-ai-visibility-tools-2026">surmado.com</a>; Otterly.ai — <a href="https://otterly.ai/">otterly.ai</a></li>
      </ul>
    </div>
    <div class="foot-meta">
      White paper a cura di Federico Calicchia · redatto con il supporto di Claude Opus 4.8 (Anthropic). Ultimo aggiornamento: 16 giugno 2026.<br>
      Le demo 01-03 sono simulazioni didattiche client-side (non motori reali); la demo 04 usa i dati esatti del paper Schulte et al. Data la rapidità dell'evoluzione del settore, statistiche e meccanismi descritti hanno validità temporale limitata.
    </div>
  </div>
</footer>`;
