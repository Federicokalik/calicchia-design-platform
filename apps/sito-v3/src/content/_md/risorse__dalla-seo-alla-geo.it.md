# Dalla SEO alla GEO: White Paper sull'evoluzione della ricerca nell'era dell'AI generativa

*White paper a cura di [Federico Calicchia](https://github.com/federicokalik), redatto con il supporto di Claude Opus 4.8 (Anthropic) su sue indicazioni editoriali · Ultimo aggiornamento: 22 giugno 2026*

> **Nota metodologica.** Documento elaborato a partire da una ricerca su fonti primarie e secondarie (paper accademici, documentazione ufficiale dei motori, report di settore, analisi di reverse-engineering indipendenti). Le sezioni distinguono esplicitamente i fatti documentati dai claim dei vendor e dalle analisi non confermate ufficialmente. Tutte le fonti sono elencate in bibliografia.

## Introduzione

Per vent'anni la ricerca online ha funzionato secondo una grammatica stabile: un utente digita una query, un motore restituisce una lista ordinata di link, l'utente clicca e arriva su un sito. Su questa meccanica si è costruita un'intera disciplina — la SEO — e, con essa, il modello economico del web aperto, dove la visibilità si traduceva in traffico e il traffico in valore. Quella grammatica si sta rompendo.

I motori generativi — Google con AI Overviews e AI Mode, ChatGPT, Perplexity, Microsoft Copilot, Claude — non restituiscono più primariamente una lista di link: leggono il web al posto dell'utente, sintetizzano una risposta e citano poche fonti. Il click, che era il fine, diventa l'eccezione. Cambia l'unità di competizione (non più la pagina, ma il singolo "chunk" di contenuto che un sistema di retrieval può estrarre e citare), cambiano le metriche (dalla posizione in SERP alla quota di citazione), cambiano gli attori (non un solo motore dominante, ma un arcipelago frammentato e in rapida evoluzione, con dinamiche proprie anche fuori dall'Occidente). Da questo spostamento nasce la GEO, *Generative Engine Optimization*.

Questo white paper ricostruisce il passaggio dalla SEO alla GEO con tre obiettivi: spiegare **come funzionano davvero** i motori generativi a livello di retrieval (embedding, chunking, re-ranking, query fan-out) e di selezione delle fonti, motore per motore; **distinguere ciò che è documentato** da ciò che è inferito tramite reverse-engineering o semplicemente affermato dai vendor; e **collocare il fenomeno nel contesto italiano ed europeo**, dove il quadro normativo (AI Act, opt-out TDM, DSA, GDPR) è il più stringente al mondo e condiziona concretamente cosa la GEO può e non può fare. Il taglio è formativo e analitico, non operativo-aziendale: l'obiettivo è capire il meccanismo, non vendere una ricetta.

## TL;DR
- **La ricerca sta migrando da un modello a "link blu" (crawling → indexing → ranking → click) a un modello di "motori generativi" che sintetizzano risposte e citano poche fonti:** nel 2024 il 58,5% delle ricerche Google USA finiva senza click (SparkToro/Datos), salito al 68,01% all'inizio del 2026 (SparkToro/Similarweb); quando appare un AI Overview, il CTR organico della pagina top cala di circa il 47-61% a seconda dello studio (Authoritas, Pew, Seer Interactive, Ahrefs).
- **La GEO (Generative Engine Optimization) nasce dal paper accademico di Aggarwal et al. (IIT Delhi/Princeton, KDD 2024)**, che dimostra che aggiungere statistiche, citazioni e quotazioni può aumentare la visibilità nelle risposte generative "fino al 40%", mentre il keyword stuffing tradizionale è l'unico metodo testato che *peggiora* la visibilità.
- **Ogni motore AI ha una pipeline di retrieval diversa** (ChatGPT su indice Bing/scraping terzi, Perplexity con crawler proprio, Claude su Brave Search, Copilot su Bing con Prometheus, Gemini sull'indice Google con query fan-out): tutti usano RAG, embeddings e selezione a livello di "chunk", per cui struttura del contenuto, freschezza, autorevolezza e citabilità contano più del posizionamento tradizionale.
- **La visibilità AI è una distribuzione, non un punteggio:** una misura singola ha un errore standard di 0,370 (statisticamente inutile); servono 7-10+ run ripetute per prompt (paper "Don't Measure Once", arXiv 2604.07585).
- **Google stessa (maggio 2026) ha dichiarato che "GEO è ancora SEO"** e ha smontato 5 miti, tra cui llms.txt e il chunking manuale.

## Key Findings

1. **Il comportamento di ricerca è cambiato strutturalmente, non marginalmente.** Lo zero-click è passato da ~50% (SparkToro 2019) a 68,01% (Q1 2026 USA). Gartner ha previsto (feb 2024) un calo del 25% del volume di ricerca tradizionale entro il 2026 — una previsione, non un consuntivo.
2. **Il posizionamento organico tradizionale resta importante ma non è più sufficiente.** Lo studio Ahrefs di gennaio 2026 mostra che solo il 38% delle pagine citate negli AI Overviews è anche nella top 10 organica (era 76% a luglio 2025).
3. **Le tattiche GEO con evidenza empirica sono poche e specifiche:** statistiche, citazioni di fonti, quotazioni, freschezza, struttura "answer-first". Molti consigli popolari (llms.txt, schema-as-hack, chunking manuale) non hanno evidenza di funzionare e alcuni sono smentiti da Google.
4. **Il mercato italiano/UE è in ritardo ma in rapida accelerazione:** AI Overviews in Italia dal 26 marzo 2025; uso GenAI in Italia al 20% (sotto media UE 33%, Eurostat 2025); dopo il reclamo FIEG (15 ottobre 2025), l'AGCOM ha trasmesso il caso Google AI Overviews/AI Mode alla Commissione UE ex art. 65 DSA (29 aprile 2026). La frammentazione dei motori è globale: in Cina Doubao, ERNIE, DeepSeek e Qwen superano insieme i 900 milioni di utenti.
5. **Il contesto normativo UE è il più stringente al mondo:** AI Act, GDPR, opt-out TDM ex art. 4 CDSM, caso Garante-OpenAI e dispute publisher modellano come la GEO può operare in Europa.

## Details

### 1. L'evoluzione dalla SEO alla GEO

#### Come funzionava (e funziona) la ricerca tradizionale
La SEO classica si basa su tre fasi: **crawling** (un bot come Googlebot scopre e scarica pagine), **indexing** (le pagine vengono analizzate e archiviate in un indice), e **ranking** (un algoritmo ordina le pagine per una query producendo la SERP, la lista di "link blu"). Il modello economico del web aperto era basato sul **click-through**: l'utente cercava, vedeva una lista di risultati e cliccava su un sito, generando traffico monetizzabile.

#### Come funziona la ricerca AI-driven
I "motori generativi" (generative engines) non restituiscono primariamente una lista di link, ma **sintetizzano una risposta** da più fonti usando un LLM, citando alcune fonti inline. Questo produce **risposte zero-click**: l'utente ottiene la risposta senza visitare alcun sito. Google ha integrato questo paradigma con gli **AI Overviews** (riquadri generativi in cima alla SERP) e l'**AI Mode** (esperienza conversazionale completa).

#### Punti di svolta e timeline
- **Maggio 2023:** Google annuncia la Search Generative Experience (SGE) come esperimento in Search Labs.
- **14 maggio 2024:** Google lancia ufficialmente gli AI Overviews negli USA (al Google I/O).
- **28 ottobre 2024:** AI Overviews estesi a oltre 100 paesi e territori.
- **31 ottobre 2024:** OpenAI lancia ChatGPT Search.
- **5 marzo 2025:** AI Overviews passano a Gemini 2.0; Google annuncia AI Mode come esperimento Labs.
- **26 marzo 2025:** AI Overviews arrivano in Italia e in altri paesi europei.
- **20 maggio 2025:** AI Mode esteso a tutti gli utenti USA.
- **7 maggio 2026:** Google Chrome rilascia Lighthouse 13.3.0 con la categoria sperimentale "Agentic Browsing" (include un check su llms.txt) nel config di default.
- **15 maggio 2026:** Google pubblica la guida ufficiale GEO ("Optimizing your website for generative AI features").
- **5 giugno 2026:** Google pubblica la guida sui servizi SEO di terze parti e aggiorna "Do you need an SEO?", nominando AEO/GEO come categoria di servizio.

Perplexity (fondata nel 2022) ha reso popolare il concetto di "answer engine" con citazioni trasparenti. Claude (Anthropic) ha aggiunto la ricerca web nel 2025.

#### Il paper fondativo "GEO: Generative Engine Optimization"
Il termine GEO è stato formalizzato nel paper di **Pranjal Aggarwal, Vishvak Murahari, Tanmay Rajpurohit, Ashwin Kalyan, Karthik Narasimhan e Ameet Deshpande** (IIT Delhi/Princeton/Allen AI), pubblicato a **KDD 2024** (arXiv:2311.09735, DOI 10.1145/3637528.3671900). Risultati chiave, verificati sul testo originale:

- Hanno introdotto **GEO-bench**, un benchmark di **10.000 query** da domini diversi.
- Hanno testato **9 metodi** di ottimizzazione: Authoritative, Keyword Stuffing, Statistics Addition, Quotation Addition, Cite Sources, Fluency Optimization, Easy-to-Understand, Technical Terms, Unique Words.
- Le metriche sono due: **Position-Adjusted Word Count** (parole attribuite a una fonte, pesate per posizione nella risposta) e **Subjective Impression** (punteggio qualitativo G-Eval su 7 dimensioni).
- I metodi migliori — **Quotation Addition (+41%), Statistics Addition (+31%), Cite Sources (+28%), Fluency Optimization (+28%)** — possono aumentare la visibilità "**up to 40%**" nelle risposte generative. Frase di sintesi: *"The best methods improve upon baseline by 41% and 28% on Position-Adjusted Word Count and Subjective Impression respectively."*
- Il **Keyword Stuffing** è l'**unico metodo che ha peggiorato** la visibilità (−8%): le tattiche SEO non si trasferiscono automaticamente ai motori generativi.
- L'efficacia **varia per dominio**: Statistics in "Law & Government" e query "Opinion"; Quotation in "History" e "People & Society".
- GEO è particolarmente vantaggioso per i siti **a basso ranking**: Cite Sources ha aumentato la visibilità del **115,1%** per i siti in quinta posizione SERP.
- La combinazione **Fluency + Statistics** ha superato qualsiasi metodo singolo di oltre il 5,5%.
- Validazione su Perplexity.ai: miglioramenti **fino al 37%**.

*(Nota di sourcing: titoli di metodo, percentuali headline e frasi di prosa confermati su arXiv. La v3 indica un boost 15-30% per i metodi stilistici, contro "10-20%" di versioni precedenti — discrepanza di versione da segnalare.)*

#### Dati sul cambiamento del comportamento di ricerca
- **SparkToro/Datos (2024):** 58,5% ricerche Google USA e 59,7% UE senza click. Per ogni 1.000 ricerche USA, solo 360 click al web aperto.
- **SparkToro/Similarweb (2026):** **68,01%** delle ricerche Google USA senza click nei primi 4 mesi del 2026 (+7,56 punti dal 2024).
- **Ahrefs (dic 2025):** la presenza di un AI Overview correla con un CTR medio inferiore del **58%** per la pagina top.
- **Pew Research (lug 2025):** su 68.879 ricerche reali, click su link tradizionale all'8% con AI Overview vs 15% senza (≈ −47%); solo l'1% clicca una fonte citata; 26% delle sessioni con AIO termina del tutto (vs 16%). Google ha contestato la metodologia.
- **Seer Interactive (set 2025, >25M impression):** CTR organico per query con AIO crollato del **61%** (1,76% → 0,61%).
- **Gartner (feb 2024):** previsione −25% del volume di ricerca tradizionale entro il 2026.
- **Impatto publisher:** Digital Content Next (ago 2025) cala mediano del traffico referral Google del **10%**; Press Gazette/Chartbeat: −33% globale nel 2025 (−38% USA, −17% Europa). Il danno scala con la dimensione del sito.

### 2. Come funziona tecnicamente ogni motore AI (panoramica)

Tutti i motori generativi usano una forma di **RAG (Retrieval-Augmented Generation)**: invece di affidarsi solo alla conoscenza "parametrica" (appresa in training), recuperano contenuti freschi dal web e li usano per costruire la risposta. Le sottosezioni 2-bis e 2-ter scendono in profondità sulla meccanica e sul reverse-engineering; qui la sintesi per-motore.

- **ChatGPT (OpenAI):** retrieval via API di scraping di terze parti (storicamente legato a Bing; Seer Interactive ha trovato 87% di overlap con i top result di Bing); query fan-out; selezione fonti che pesa autorevolezza, struttura e freschezza.
- **Google Gemini / AI Overviews / AI Mode:** indice web proprio + Knowledge Graph + Shopping; query fan-out documentato via API; selezione che attinge anche fuori dalla top-10 organica (Ahrefs gen 2026: solo 38% delle citazioni dalla top-10).
- **Perplexity:** RAG con crawler proprio (PerplexityBot); forte sensibilità alla freschezza; tipicamente 3-5 fonti per risposta; reranking ML a più livelli.
- **Microsoft Copilot:** modello Prometheus su indice Bing; "Bing Orchestrator" che genera query interne iterative (fan-out); citazioni numerate [1][2]; primo motore a codificare la GEO nelle proprie Webmaster Guidelines (febbraio 2026).
- **Claude (Anthropic):** retrieval via provider esterno (overlap con Brave); citazione a livello di frase; tre bot (ClaudeBot training, Claude-User fetch, Claude-SearchBot indicizzazione).

### 2-bis. La meccanica tecnica del retrieval (dal vettore al chunk citato)

Questa sezione scende al livello che serve a un dev per prendere decisioni di markup e architettura del contenuto. La tesi di fondo: **la "pagina" non è più l'unità di competizione; lo è il chunk.** Capire come un chunk viene rappresentato, recuperato e ri-ordinato spiega perché certe scelte di struttura HTML aumentano o distruggono la citabilità.

#### 2-bis.1 — Le tre famiglie di retrieval: dense, sparse, late-interaction

**Dense retrieval (bi-encoder).** Query e documento vengono codificati *separatamente* in un singolo vettore denso (es. 768 dimensioni); la rilevanza è la cosine similarity. Velocissimo (vettori pre-calcolati + ANN), ma — come sintetizza Towards Data Science — *"the model compresses all meaning into one vector before any comparison happens"*: query e documento non interagiscono mai a livello di token. Conseguenza GEO: un chunk che mescola tre concetti produce un vettore "medio" che non rappresenta bene nessuno dei tre.

**Sparse retrieval (BM25, SPLADE).** Match lessicale esatto (o espanso). Imbattibile su nomi propri, codici prodotto, termini tecnici — i casi in cui il dense fallisce.

**Late interaction (ColBERT e successori).** Mantiene gli embedding *a livello di token* e calcola la rilevanza con MaxSim (ogni token query vs ogni token documento). Weaviate: i metodi dense *"pool token-wise embeddings into a single representation while ColBERT embeddings keep the token-wise representations in a multi-vector"*. Vantaggio: spiegabilità. Svantaggio: storage (BEIR: ~20GB/1M doc vs 0,4GB BM25 e ~3GB dense).

**Il dato che conta per la GEO:** gli approcci **ibridi dense+sparse battono ogni metodo singolo**. Uno studio singolo (gen 2026, su MS MARCO, fonte poco visibile e con baseline dense insolitamente bassa — da trattare come indicativo, non come benchmark consolidato) riporta fino al **580% di miglioramento in Recall@10** rispetto al solo dense (13,9% → 80,8%); il principio generale — l'ibrido supera i singoli metodi — è comunque confermato da letteratura peer-reviewed più solida. I motori reali combinano "significato" (dense) e "parola esatta" (sparse): il contenuto deve servire entrambi — concetti chiari *e* terminologia esatta.

#### 2-bis.2 — Embeddings: cosa cattura un vettore (e cosa no)

1. **Stesso modello obbligatorio per indice e query** — altrimenti i vettori vivono in spazi non allineati e la similarity è rumore. Causa #1 di RAG rotti silenziosamente.
2. **Context rot:** la ricerca Chroma (lug 2025, 18 modelli inclusi GPT-4.1, Claude 4, Gemini 2.5) mostra che il retrieval degrada all'aumentare della lunghezza del contesto, anche su task semplici. Infilare la risposta a metà di un muro di testo la rende meno recuperabile.
3. **Un vettore medio non è un buon vettore** — più concetti distinti in un chunk = embedding diffuso.

#### 2-bis.3 — Chunking: la decisione più sottovalutata (e i dati che smentiscono il senso comune)

Il senso comune dice "il semantic chunking è il migliore". I benchmark dicono il contrario, e la divergenza è istruttiva:
- **Vecta Benchmark (feb 2026):** recursive splitting a 512 token primo al **69%**; semantic chunking al **54%** (frammenti da ~43 token). L'autore: la conversazione sul chunking è stata *"dominated by theory rather than measurement"*.
- **MDPI Bioengineering (nov 2025):** nel dominio clinico, adaptive chunking 87% vs 13-50% del fixed-size (p=0,001).
- **arXiv 2506.17277 (chimica):** recursive fino al 45% di precisione domain-weighted in più del miglior fixed-span.
- **arXiv 2512.05411 (enterprise):** su documentazione formale ben strutturata, naive chunking batte semantic e recursive.
- **arXiv 2506.06339 (arabo):** sentence-aware il migliore, semantic *consistentemente peggiore*.

**Non si conciliano — ed è il punto.** Non esiste una strategia di chunking universalmente ottimale; dipende da struttura del documento e tipo di query. Il default robusto difendibile: **recursive splitting a 400-512 token con 10-20% di overlap**, quando non si hanno motivi specifici per altro.

**Perché un dev GEO deve curarsene anche se non controlla il chunker del motore?** Perché controlli *quanto è spezzabile bene* la pagina. Confini semantici netti (heading chiari, un'idea per sezione, risposte autosufficienti) producono chunk coerenti con qualsiasi strategia. **La struttura del contenuto è il chunking che puoi controllare.** (Vedi anche la tensione con la posizione ufficiale di Google in 6.2.)

#### 2-bis.4 — Re-ranking: lo stadio dove si decide cosa viene citato

Il retrieval reale è quasi sempre a **due stadi**:
- **Stadio 1 — Recall (bi-encoder/BM25/ibrido):** rete larga, 20-150 candidati veloci.
- **Stadio 2 — Precision (cross-encoder):** ri-valuta ogni coppia query-chunk *insieme* (`[CLS] query [SEP] documento [SEP]`), riordina, tiene i top 3-8.

Numeri operativi: cross-encoder leggero (ms-marco-MiniLM-L-6-v2) ~50ms/20 doc; Cohere Rerank ~200ms; reranker LLM 1-3s. Guadagno tipico **+5-15 punti nDCG@10** o **+10-25% accuratezza**. Default: top-20→50, rerank, passa top-3→8. Oltre 50 candidati *"adds latency without meaningfully improving recall"*.

**Implicazione GEO:** il cross-encoder premia la **rilevanza diretta e specifica alla query** — non densità di keyword, non lunghezza, non autorità del dominio in sé. È il fondamento meccanico del perché la scrittura "answer-first" funziona: non è stile, è allineamento col cross-encoder.

#### 2-bis.5 — Dal modello di retrieval alle regole di markup

| Fatto meccanico | Regola operativa per il contenuto |
|---|---|
| Dense comprime tutto in un vettore | Un'idea per sezione; non mescolare 3 temi in un paragrafo |
| Sparse premia il match esatto | Includi termini/codici/nomi esatti, non solo sinonimi |
| Ibrido batte i singoli metodi | Concetti chiari *e* terminologia precisa insieme |
| Context rot | Risposta in alto, non sepolta a metà pagina |
| Chunk autosufficienti = retrieval robusto | Ogni sezione abbia senso letta da sola |
| Heading chiari = confini di chunk netti | HTML semantico: `<h2>` a domanda + risposta sotto |
| Cross-encoder premia rilevanza diretta | Answer-first: risposta nei primi 40-60 token |
| Re-ranking taglia a top 3-8 | Serve essere il chunk *più* pertinente, non solo pertinente |

### 2-ter. Reverse-engineering granulare: come ciascun motore costruisce le query e seleziona le fonti

Questa sezione documenta, motore per motore, ciò che è *verificabile* (documentazione ufficiale, API, log honeypot, decompilazione) separandolo da ciò che è *ricostruito* o *plausibile*. È l'area più volatile del documento: le pipeline cambiano da un aggiornamento di modello all'altro.

#### 2-ter.1 — ChatGPT Search: il tool `web.run`

La fonte più dettagliata è lo studio RESONEO/Meteoria (Olivier de Segonzac, maggio 2026), che ha decompilato l'app mobile, analizzato il client web, sniffato i pacchetti di rete e ricostruito progressivamente il system prompt. Risultati verificati:

- **Il motore di ricerca interno si chiama `web.run`.** Prima di GPT-5.3 inviava comandi testuali compatti separati da pipe (`fast|query|recency`); dopo 5.3 invia oggetti JSON strutturati con parametri tipizzati — un cambio di architettura, non solo di formato.
- **Il tool supporta 12 operazioni** (da 4 precedenti): `search_query`, `open`, `find`, `click`, `screenshot`, `product_query` e widget specializzati (sport, finanza, meteo), più un sistema separato `genui`.
- **Query fan-out:** GPT-5.4 può concatenare da 5 a oltre 10 round di ricerca per risposta, raffinando le query in base ai risultati precedenti; GPT-5.3 Instant ne esegue tipicamente 2-3. GPT-5.4 Thinking usa operatori `site:` per restringere la ricerca a domini fidati.
- **Fan-out prodotto inedito (`browse_rewritten_queries`):** sulle query di prodotto, ChatGPT prima esegue un rewrite per costruire la lista di candidati, poi lancia una ricerca shopping *separata per ogni singolo prodotto*, recuperando specifiche, recensioni e prezzi uno alla volta.
- **Chi recupera davvero le pagine:** l'esperimento honeypot ha confermato che durante una conversazione è **`ChatGPT-User`** (non OAI-SearchBot) a fetchare il contenuto delle pagine. OpenAI descrive OAI-SearchBot come l'agente che costruisce l'indice, ma in pratica il modello si appoggia ad **API di scraping di terze parti** per i risultati di ricerca, poi invia ChatGPT-User a recuperare il contenuto degli URL selezionati. Marcatori di tracking Google (`strlid`) negli URL prodotto e match di ID SearchAPI rivelano un backend che si appoggia a provider di ricerca terzi — e a Google dietro le quinte.
- **Selezione fonti — il "Bigfoot Effect":** il 4 marzo 2026 OpenAI ha cambiato il modello di default (da GPT-4o/5.2 a 5.3 Instant) e i domini unici citati per risposta sono **scesi da 19 a 15 (-20%+)**, gli URL unici da 24 a 19, senza più recuperare. Il rapporto URL-per-dominio è restato stabile (1,26): meno siti distinti, non meno pagine per sito. Riflette uno spostamento strutturale verso fonti ad alta autorità.
- **Reddit** è l'unico dominio esentato dai limiti di parole per copyright nel system prompt ricostruito; esiste una "verbosity score" su scala 1-10 e una policy pubblicitaria per fascia di abbonamento.
- **Il punto strategico:** lo studio distingue **visibilità parametrica** (ciò che il modello ha appreso in training, con search disattivata — l'equivalente di E-E-A-T per LLM, stabile, plasmata da copertura stampa, Wikipedia, siti autorevoli) da **visibilità dinamica** (ciò che recupera in tempo reale, volatile, model-dependent). Il legame chiave: *"il modello formula le query web puntando a fonti che già conosce. Un brand assente dalla memoria parametrica non sarà nemmeno considerato come candidato di ricerca."* Essere sconosciuti al modello = invisibili prima ancora che la ricerca inizi.

**Avvertenza:** stesso prompt su 5.2/5.3/5.4 produce fan-out, fonti e passaggi diversi. La citazione in ChatGPT non è riproducibile come un ranking Google: va testata modello per modello.

#### 2-ter.2 — Google Gemini / AI Mode / AI Overviews: il query fan-out documentato

A differenza di ChatGPT, qui esiste **documentazione ufficiale** che espone parte della meccanica, tramite l'API di grounding di Gemini:

- **Query fan-out confermato dall'API.** La risposta dell'API con grounding restituisce un oggetto `groundingMetadata` che contiene `webSearchQueries` (l'array delle query effettivamente eseguite — es. per "chi ha vinto Euro 2024" genera `["UEFA Euro 2024 winner", "who won euro 2024"]`), `groundingChunks` (le fonti recuperate, con uri e title) e `groundingSupports` (la mappatura **segmento di testo → chunk fonte**, con `startIndex`/`endIndex` carattere per carattere). Questo è il meccanismo di citazione di Gemini esposto in chiaro: ogni frase della risposta è ancorata a chunk specifici.
- **Modello tool-native.** Dal technical report Gemini 2.5: Gemini 2.0 è stata *"la prima famiglia di modelli addestrata a chiamare nativamente strumenti come Google Search"*, formulando query precise. Gemini 2.5 *"interleaves search capabilities with internal thought processes"* per query multi-hop, e ha imparato a *"issue additional, detailed follow-up queries"* per espandere e verificare. Non è un LLM che "ogni tanto cerca": la ricerca è interlacciata col ragionamento.
- **Scala:** a metà 2025 i modelli alimentavano circa 1,5 miliardi di utenti mensili negli AI Overviews e ~400 milioni nell'app Gemini (dato del report 2.5); a fine 2025/inizio 2026 i numeri ufficiali Alphabet salgono a **2 miliardi** di utenti per gli AI Overviews e **750 milioni** di MAU per l'app Gemini (Q4 2025) — la crescita è uno degli indicatori della rapidità con cui il paradigma si sta diffondendo.
- **Custom model:** Google ha dichiarato che AI Mode usa una *"custom version of Gemini"* con fan-out. Il fan-out scompone la query in molte sotto-query parallele (sintetiche e implicite) ed è il motivo per cui pagine non in top-10 vengono citate: rispondono a una sotto-query del fan-out.
- **Indice:** quello web proprio di Google + Knowledge Graph + Shopping Graph. Il grounding usa endpoint `vertexaisearch.cloud.google.com` come redirect delle fonti.

**Conseguenza GEO specifica:** ottimizzare per Gemini significa coprire l'**albero di sotto-domande** di un tema, non una singola keyword. La struttura `groundingSupports` premia il contenuto in cui una frase risponde in modo autosufficiente e ancorabile.

#### 2-ter.3 — Perplexity / Sonar: il reranking a tre livelli

Perplexity è il più trasparente nell'output (citazioni sempre visibili) ma proprietario nell'infrastruttura. Quadro ricostruito da analisi indipendenti (Metehan Yeşilyurt, agosto 2025, citato da Search Engine Land; RankStudio; documentazione API Sonar):

- **Sonar** è il modello proprietario di Perplexity, costruito su architetture open Llama (a febbraio 2025 su Llama 3.3); a livello prodotto è un sistema **multi-modello** che a runtime seleziona il modello migliore per modalità (search/reasoning/research) e permette di alternare modelli nativi e di partner (OpenAI, Anthropic).
- **Pipeline:** (1) **Query decomposition** — il prompt viene scomposto in più sotto-query; (2) **retrieval** da indice proprio costruito da crawler headless (PerplexityBot) integrato da fetch in tempo reale (Perplexity-User); (3) **reranking**; (4) **sintesi** con citazioni inline.
- **Reranking a tre livelli** (la parte più tecnicamente dettagliata emersa pubblicamente): **Layer 1** retrieval iniziale dei candidati con scoring di rilevanza classico; **Layer 2** ranking per segnali convenzionali di autorità e rilevanza; **Layer 3** reranking ML che — secondo questa analisi — favorisce strutturalmente l'**earned media da pubblicazioni Tier-1**: una citazione su TechCrunch o Forbes funziona come segnale di autorità verificato esternamente. *(Da trattare come analisi indipendente credibile ma non confermata ufficialmente.)*
- **La citazione è un "two-step dance":** (1) inclusione del documento nel retrieval set, (2) selezione del paragrafo per la citazione. Si possono vincere entrambe e ottenere il link nell'answer box.
- **Freshness come fattore dominante:** in test time-series, un articolo "aggiornato 2 ore fa" è stato citato il **38% in più** del suo gemello identico con data di un mese prima. Il gemello stantio raramente spariva dal retrieval set, ma veniva **retrocesso nella sintesi**. Anche piccole modifiche resettano il segnale di freschezza. Sonar tratta le pagine datate come rischio-allucinazione più alto.
- **PDF:** Perplexity tende a preferire PDF pubblici ben strutturati, che spesso battono l'HTML nella citazione per pulizia strutturale. *(Claim di vendor SEO, plausibile ma non confermato da Perplexity.)*
- **Scala:** ~780 milioni di query a maggio 2025, +20% mese su mese (dichiarazione Srinivas, Bloomberg Tech), con obiettivo dichiarato di 1 miliardo/settimana.

#### 2-ter.4 — Claude (Anthropic): citazione a livello di frase

Per il motore con cui stai interagendo ora, i dettagli pubblici sono nella documentazione ufficiale Anthropic:

- **Retrieval:** con web search attivo, Claude interroga un provider di ricerca (analisi Profound indicano forte overlap con Brave Search) e recupera contenuti dagli URL dei risultati. Esiste anche un web fetch tool che recupera URL specifici forniti dall'utente o emersi dai risultati.
- **Chunking citazionale a livello di frase:** la documentazione del web search e del citations tool specifica che i documenti vengono spezzati in chunk a granularità di **frase** (per testo semplice e PDF). L'output restituisce blocchi `cited_text`, con `title` e `url`. Conseguenza: la citazione è ancorata a singole frasi, quindi **una frase ben costruita e autosufficiente è l'unità minima citabile** — il caso più estremo del principio "il chunk è l'unità di competizione".
- **Bot a tre livelli:** ClaudeBot (training), Claude-User (fetch su richiesta utente), Claude-SearchBot (indicizzazione per la ricerca). Tutti dichiarano di rispettare robots.txt.

#### 2-ter.5 — Microsoft Copilot: Prometheus, Bing Orchestrator e le Webmaster Guidelines

Copilot merita una trattazione a sé perché è l'unico motore importante che ha **codificato la GEO nella propria policy ufficiale**, e perché la sua infrastruttura (indice Bing) è anche il backend storico di ChatGPT.

- **Architettura — Prometheus (FATTO UFFICIALE).** Microsoft descrive Prometheus come un modello che combina *"the fresh and comprehensive Bing index, ranking, and answers results with the creative reasoning capabilities of … GPT models"*. Il componente **Bing Orchestrator** *"generate[s] a set of internal queries iteratively"*: è il meccanismo di **query fan-out interno**, distinto dal testo digitato dall'utente. Il modello è *"grounded by Bing data, via the Bing Orchestrator"* — il grounding è ciò che ancora la risposta alle fonti recuperate.
- **Citazioni.** Prometheus *"integrate[s] citations into sentences in the Chat answer"* con riferimenti numerati [1][2] linkati alla pagina sorgente; pannelli fonti consolidati e nomi dei publisher sono mostrati (UI aggiornata da novembre 2025).
- **Bing Webmaster Guidelines (riscrittura del 27 febbraio 2026) — FATTO UFFICIALE.** Microsoft ha riscritto le linee guida trattando *"grounding results and citations"* come **esito di eleggibilità separato** dal ranking tradizionale, e introducendo **GEO come categoria di ottimizzazione ufficiale** (primo motore a farlo in policy). Direttive verificate: **NOARCHIVE** impedisce l'uso del contenuto nelle risposte Copilot; **NOCACHE** limita Copilot a usare solo URL, titolo e snippet (Microsoft lo **sconsiglia** sulle pagine che si vogliono far citare); l'attributo **data-snippet** permette di specificare quale testo Bing può mostrare o citare (controllo a livello di paragrafo).
- **Relazione con ChatGPT (ATTRIBUZIONE CAUTA).** Lo studio Seer Interactive (6 febbraio 2025) ha trovato che **l'87% delle citazioni di SearchGPT coincide con i top 20 organic result di Bing** (contro il 56% per Google). È una **misurazione indipendente di coincidenza**, non una quota di retrieval dichiarata; il dato spesso citato "~92% via Bing API" è un **claim vendor non confermato**. Inoltre OpenAI sta costruendo un indice proprio: la correlazione con Bing potrebbe de-correlare nel tempo.
- **IndexNow (FATTO UFFICIALE).** Protocollo che notifica a Bing (e ai motori partecipanti) ogni aggiunta/modifica/rimozione di contenuto; **Google non lo supporta** (febbraio 2026).
- **Trasparenza.** L'**AI Performance Report** di Bing Webmaster Tools (public preview da febbraio 2026) mostra conteggio citazioni, URL citati e un campione delle grounding queries (che *"sono un campione"* e *"non necessariamente le query esatte digitate"*).
- **Copilot Search vs Microsoft 365 Copilot.** Il consumer è grounded sull'indice web pubblico di Bing; l'enterprise (M365 Copilot) è grounded sul tenant via Microsoft Graph + Semantic Index, con scoping ai permessi dell'utente.

**Conseguenza GEO:** per Copilot, l'indicizzazione su Bing e la gestione corretta delle direttive (evitare NOARCHIVE/NOCACHE sulle pagine da far citare) sono prerequisiti tecnici espliciti — l'unico caso in cui il "cosa fare" è scritto nero su bianco dal produttore.

#### 2-ter.6 — Tabella comparativa di sintesi

| Dimensione | ChatGPT Search | Gemini / AI Mode | Perplexity / Sonar | Copilot | Claude |
|---|---|---|---|---|---|
| Indice/fonte risultati | API scraping terze parti (+ tracce Google) | Indice web Google + KG + Shopping | Indice proprio (PerplexityBot) + realtime | Indice Bing (Prometheus) | Provider esterno (overlap Brave) |
| Bot di retrieval realtime | ChatGPT-User | Google-Extended / infrastruttura Search | Perplexity-User | bingbot / infrastruttura Bing | Claude-User / Claude-SearchBot |
| Query fan-out | Sì (`web.run`, 2-10+ round) | Sì (documentato via API) | Sì (query decomposition) | Sì (Bing Orchestrator) | Sì (ricerche multiple) |
| Citazione esposta | Inline, variabile per modello | `groundingSupports` frase→chunk | Inline sempre, paragrafo | Numerata [1][2] + pannello fonti | Inline sempre, frase (`cited_text`) |
| Fattore distintivo | Concentrazione su pochi domini autorevoli (Bigfoot) | Copertura albero sotto-domande | Freshness estrema, earned media Tier-1 | GEO in policy ufficiale (Webmaster Guidelines) | Granularità di frase |
| Trasparenza meccanica | Bassa (reverse-engineering) | Media (API ufficiale) | Bassa-media (analisi indipendenti) | Alta (doc + AI Performance Report) | Media (doc ufficiale) |
| Riproducibilità citazione | Bassa (cambia per modello) | Media | Media-bassa (volatile su freshness) | Media-alta | Media |

### 3. Cosa rende un contenuto citabile (tattiche GEO evidence-based)

**Tattiche con supporto empirico:**
- **Statistiche e dati specifici** (GEO paper: Statistics Addition +31%).
- **Citazioni e quotazioni di fonti** (GEO paper: Quotation Addition +41%, Cite Sources +28%).
- **Freschezza** (forte per Perplexity e query news/trend; vedi 2-ter.3).
- **Struttura "answer-first"** con heading a domanda e risposta diretta nei primi 40-60 token (allineamento col cross-encoder, vedi 2-bis.4).
- **Autorevolezza/E-E-A-T** e citazioni di terze parti; **contenuto non-commodity** con esperienza diretta (confermato dalla guida Google 2026).
- **Menzioni del brand:** studio Previsible su 1,96M sessioni indica il volume di ricerca del brand come predittore più forte delle citazioni AI (correlazione 0,334), più dei backlink.

*(Avvertenza: claim di vendor come "data-rich citati 2,7x in più" o "FCP <0,4s = 6,7 citazioni" circolano ma non sono verificabili con fonte primaria — vedi Sezione 6.5.)*

**Correlazione con il ranking tradizionale (dati contrastanti):** Ahrefs a luglio 2025 trovava 76% di overlap tra citazioni AIO e top-10; a gennaio 2026 solo 38% (in parte per migliore rilevamento, in parte per il fan-out). Semrush: ~90% delle citazioni ChatGPT da URL fuori dalla top-20 Google. Il ranking aiuta ma non è condizione necessaria.

**robots.txt per crawler AI:** la strategia "blocca tutti i bot AI" del 2024 è controproducente. Distinguere bot di **training** (GPTBot, ClaudeBot, Google-Extended) dai bot di **retrieval/search** (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, PerplexityBot). Bloccare i secondi rimuove il sito dalle citazioni AI.

*(Per llms.txt, schema e chunking come tattiche — tutte ridimensionate o smentite — vedi la Sezione 6 critica.)*

### 4. Il mercato italiano ed europeo (quadro generale)

#### Adozione
- **Eurostat 2025:** uso di strumenti GenAI in Italia al **20%**, sotto la media UE del 33% e lontano da Norvegia (56%) e Danimarca (48%). Riflette il divario nord-sud europeo.
- **ChatGPT in Europa:** utenti attivi mensili medi da 11,2 a 41,3 milioni entro marzo 2025 (~270%).
- L'Italia è stata il **primo paese al mondo** a bloccare temporaneamente ChatGPT (marzo 2023).

#### Tempistica AI Overviews in Europa
Arrivati in Italia il **26 marzo 2025** (con Austria, Belgio, Germania, Irlanda, Polonia, Portogallo, Spagna, Svizzera), ~10 mesi dopo gli USA, in italiano e su Gemini 2.0. Si attivano per query informative a coda lunga. L'AI Mode in italiano non risultava pienamente lanciato a metà 2026.

*(Per il quadro normativo dettagliato — TDM/opt-out, AI Act, caso FIEG-AGCOM, Garante — vedi la Sezione 4-ter.)*

#### Il panorama globale: i motori AI cinesi
La frammentazione dei motori generativi non è un fenomeno solo occidentale. Per chi ha pubblico cinese (o vuole capire la scala reale del fenomeno), il mercato cinese è il secondo polo mondiale, con dinamiche proprie e una competizione più affollata di quella USA:

- **Baidu ERNIE.** ERNIE 4.5 è stato reso **open-source il 30 giugno 2025** (10 varianti MoE fino a 424B parametri, licenza Apache 2.0). ERNIE Assistant ha raggiunto **202 milioni di MAU a dicembre 2025** (dato ufficiale Baidu). Sul fronte ricavi, nel Q4 2025 i **ricavi in abbonamento dell'infrastruttura AI accelerator (AI Cloud Infra) sono cresciuti del +143% su base annua**, in accelerazione dal +128% del Q3; il volume di chiamate dell'AI search API è cresciuto di oltre il +110% trimestre su trimestre (fonte: comunicato e earnings call Baidu del 26 febbraio 2026).
- **DeepSeek.** Modelli open-source e cost-efficient che hanno scosso il mercato a inizio 2025; a metà 2025 una stima (snapshot, società di ricerca non nominata) attribuiva a DeepSeek ~34% della quota API developer contro ~18% di ERNIE. Integrato in Baidu Search (deep-search da febbraio 2025) e in Zhihu.
- **Gli altri.** Secondo i dati QuestMobile (via Caixin), a **marzo 2026 Doubao (ByteDance) è in testa con ~345 milioni di MAU**, davanti a Qwen (Alibaba, ~166M) e DeepSeek (~127M), con Tencent Yuanbao tra i primi quattro; Doubao ha superato Baidu ERNIE Bot. I MAU combinati dei principali player superano i 900 milioni.

**Implicazione per un freelance italiano:** questi motori sono **contesto**, non azione operativa quotidiana. Il punto rilevante è strutturale — la logica GEO (retrieval, grounding, citazioni, query fan-out) è sostanzialmente la stessa ovunque, e la frammentazione (più motori, nessun dominatore unico) è una tendenza globale, non un'anomalia occidentale. *(Nota: i conteggi MAU dei motori cinesi divergono molto tra fonti e metriche; vanno trattati come stime, sempre con fonte e data.)*

### 4-bis. Metodologia di misurazione: come testare la GEO senza ingannarsi

Questa è la sezione che separa il lavoro serio dal teatro. La tesi: **la visibilità in AI search è una distribuzione, non un punteggio.** Trattarla come un rank tracking di Google è l'errore metodologico di fondo da cui derivano quasi tutti i numeri inaffidabili che circolano.

#### 4-bis.1 — Perché una misura singola è inutile (con i numeri)

Il dato più rigoroso disponibile viene dal paper **"Don't Measure Once: Measuring Visibility in AI Search (GEO)"** (Schulte et al., arXiv:2604.07585, 10 aprile 2026), che ha misurato 4 motori × 8 prompt × 3 campagne con 10 run ciascuno (1.216-1.726 serie per-brand). I risultati sull'errore di stima sono inequivocabili:

- **Una run singola ha un errore standard di 0,370** (intervallo di confidenza al 95% pari a ±0,724; Table 16, Appendice J del paper). Tradotto: un tasso reale di citazione del 50% può apparire **ovunque tra −22% e +122%** in un intervallo di confidenza nominale al 95% (clippato a [0,1] nella pratica). Una run singola è *"essentially uninformative"* — statisticamente indistinguibile dal rumore.
- **A 7 run l'errore standard scende a 0,081** (CI 95% ±0,158) e a **8 run a 0,062** (±0,121) — sufficiente per distinguere differenze grandi (es. un brand citato all'80% vs uno al 50%).
- L'overlap delle fonti tra due giorni consecutivi può cadere nel range **34-42%**: un terzo-due quinti delle fonti citate cambia da un giorno all'altro per lo stesso identico prompt.

Un secondo paper (Sielinski, marzo 2026) converge: le query identiche restituiscono fonti diverse tra run, quindi la visibilità va trattata come **stima di una distribuzione sottostante**, non come valore fisso. Le distribuzioni di citazione seguono una **power law** con forte variabilità run-to-run: il 95% dei titoli ChatGPT Shopping appare in meno del 30% delle run dello stesso prompt.

**Conseguenza operativa diretta:** chiunque ti mostri un "AI Visibility Score" da uno screenshot o da una singola interrogazione ti sta vendendo rumore con l'aspetto di un segnale. Il floor minimo difendibile è **10+ run per prompt** prima di trattare un tasso come stabile (è la soglia che usa Profound nella sua metodologia shopping).

#### 4-bis.2 — Citation drift: la volatilità nel tempo

La volatilità non è solo run-to-run, è anche temporale e va distinta:

- **Citation drift mensile:** misurato come % di domini presenti a luglio ma assenti a giugno per gli stessi prompt, sta nel **40-60%** (analisi Profound). Cioè circa metà dei domini citati cambia in un mese.
- **Citation drift semestrale:** sale al **70-90%** confrontando gennaio con luglio — crescita grossomodo lineare. BrightEdge riporta che il **70% dei domini citati cambia (churn) entro sei mesi**.
- **Shock di piattaforma:** la quota di citazioni Reddit in ChatGPT è crollata dal 60% al 10% **in poche settimane** a settembre 2025 (studio Semrush a 13 settimane). Il cambio di modello del 4 marzo 2026 ha tagliato i domini citati del 20% da un giorno all'altro.

Questo impone una regola: **misurare con finestre, non con snapshot.** Una misura mensile manca shift materiali; il consiglio convergente è settimanale per le query strategiche.

#### 4-bis.3 — Protocollo di test GEO valido (replicabile)

Mettendo insieme la letteratura, un protocollo minimo difendibile per testare se una modifica GEO funziona:

1. **Definisci 20-30 prompt da buyer reale**, non query di brand vanity ("qual è il miglior X per Y", non "parlami di [il mio brand]").
2. **Esegui su più motori** (ChatGPT, Perplexity, Google AI Overviews/AI Mode, Gemini) — la visibilità in uno non predice gli altri.
3. **Ripeti ogni prompt almeno 7-10 volte, distribuite su più giorni** (non 10 volte nello stesso minuto: cattureresti solo il rumore intra-sessione, non il drift).
4. **Logga tre cose per run:** se sei apparso, quale pubblicazione è stata citata, quale competitor è stato nominato al tuo posto.
5. **Calcola intervalli di confidenza bootstrap** sul tasso di detection per brand, non medie nude.
6. **Riporta per-engine** (il reporting aggregato cross-engine nasconde i pattern: ogni motore ha algoritmo diverso).
7. **Per il test di una modifica:** misura il baseline su finestra (es. 2 settimane), applica la modifica, attendi il re-crawl, misura di nuovo su finestra equivalente. Confronta distribuzioni, non punti. Usa un **gruppo di controllo** (pagine non modificate) per separare l'effetto della tua modifica dal drift di sfondo — senza controllo non puoi attribuire nulla.

#### 4-bis.4 — Metriche che contano (e una da togliere dal cruscotto)

Dalla reference di Nick Lafferty (2026) e dagli studi citati, le metriche con senso statistico:

- **Citation Share per engine:** quota delle tue citazioni sul totale per un cluster di prompt. La metrica centrale.
- **Time-to-First-Citation (TTFC):** giorni tra pubblicazione e prima citazione osservata. Va riportato come **distribuzione (mediana, P75, P90), mai come media** (la distribuzione è asimmetrica).
- **Inline Brand Hyperlink Share:** quota di risposte in cui ottieni un link cliccabile, non solo una menzione. Ha acquisito peso dopo che il cambio ChatGPT del 7 maggio 2026 ha triplicato i referral B2B SaaS.
- **Co-citation Rate:** quanto spesso compari insieme a competitor specifici.
- **Citation Rank Stability:** consistenza del tuo rank di citazione tra run ripetute — la metrica del paper Schulte, quella che quasi tutti i cruscotti saltano.

**Metrica da togliere se vendi software/servizi:** lo **Shopping Trigger Rate**. Su ~2 milioni di prompt eseguiti 10+ volte, il 79% non ha mai triggerato Shopping in nessuna run e solo il ~6% triggera in modo affidabile; la categoria del prompt da sola predice il comportamento di trigger col 95-97% di accuratezza. Spendere budget di misurazione lì è sprecato: meglio investirlo in Citation Share.

#### 4-bis.5 — Come replicare il GEO paper in proprio

Il GEO paper originale (Aggarwal et al.) è replicabile a costo contenuto, ed è l'esperimento più istruttivo da fare per non fidarsi ciecamente:

1. Prendi 10-20 delle tue pagine/chunk target e crea due varianti: baseline e "trattata" (es. + statistiche citate, o + quotazioni di fonti autorevoli).
2. Costruisci un set di 30-50 query realistiche per cui quelle pagine dovrebbero competere.
3. Sottoponi le query a un motore generativo con search attiva, 7-10 run per query per variante, alternando l'ordine di presentazione per evitare bias di posizione.
4. Misura la metrica del paper — **Position-Adjusted Word Count** (parole attribuite alla tua fonte, pesate per la posizione nella risposta) — oltre alla semplice presenza/assenza.
5. Confronta le distribuzioni baseline vs trattata con un test non parametrico (Mann-Whitney), data la non-normalità.

**Aspettativa calibrata dai dati del paper:** miglioramenti reali ma modesti e dipendenti dal dominio (ordine del +20-40% sulla metrica, non "10x"), con Statistics e Quotation come leve più forti e maggiore beneficio per pagine inizialmente a basso ranking. Se il tuo test mostra +300%, è quasi certamente rumore da campione troppo piccolo: torna al punto 3 e aumenta le run.

### 4-ter. Approfondimento giuridico UE/Italia: il quadro che vincola la GEO in Europa

Questa sezione conta per un freelance italiano più di quanto sembri: le scelte di `robots.txt`, di licensing e di gestione dei contenuti dei clienti hanno implicazioni legali concrete sotto il diritto UE, che è il più stringente al mondo su AI e copyright.

#### 4-ter.1 — L'eccezione TDM e l'opt-out dell'art. 4 CDSM: il cardine giuridico

Il fondamento di tutto l'addestramento commerciale di AI in Europa è la **Direttiva (UE) 2019/790 (CDSM)**, in particolare:

- **Art. 3** — eccezione TDM per *scopi scientifici*, riservata a organismi di ricerca e istituti di tutela del patrimonio. Non copre l'AI commerciale.
- **Art. 4** — eccezione TDM generale (commerciale e altri scopi). È diventata, come nota la dottrina, *"the cornerstone of commercial AI training in the EU"*, pur essendo stata aggiunta nelle fasi finali del processo legislativo senza una valutazione d'impatto sulla GenAI.

Il meccanismo chiave è l'**opt-out dell'art. 4(3)**: l'eccezione TDM si applica *a condizione che* l'uso non sia stato **espressamente riservato dai titolari in modo appropriato, "ad esempio con strumenti leggibili meccanicamente" (machine-readable)** per i contenuti resi pubblici online (Considerando 18). In pratica: **il TDM su materiale protetto è permesso di default, salvo opt-out tecnicamente implementato.** Dichiarando l'opt-out, il titolare neutralizza il permesso TDM e ripristina il diritto esclusivo di vietare l'uso per l'addestramento.

**Il ponte con l'AI Act:** l'art. 53(1)(c) dell'AI Act obbliga i fornitori di modelli GPAI a dotarsi di una policy per rispettare il diritto d'autore UE e *"identificare e rispettare, anche tramite tecnologie allo stato dell'arte, le riserve di diritti espresse ai sensi dell'art. 4(3)"*. Il Considerando 106 sancisce esplicitamente un **"Brussels effect"**: l'obbligo si applica a qualunque fornitore immetta un modello GPAI sul mercato UE *"a prescindere dalla giurisdizione in cui avvengono gli atti di addestramento"*. Tradotto: anche un modello addestrato negli USA, se offerto in UE, deve rispettare gli opt-out europei.

#### 4-ter.2 — Il problema irrisolto: cosa rende un opt-out "valido"

Qui sta il nodo pratico più rilevante e ancora aperto. La direttiva **non prescrive uno standard tecnico unico**, e la giurisprudenza nazionale è divergente:

- **Kneschke v. LAION** (Tribunale di Amburgo, 27 settembre 2024): ha ritenuto che la costruzione del dataset di immagini fosse coperta dall'equivalente tedesco dell'art. 3 (atto preparatorio di ricerca), ma ha sollevato dubbi sull'art. 4 per lo sfruttamento commerciale a valle. In una pronuncia successiva (Amburgo) si è affermato che un opt-out espresso in **"linguaggio naturale"** — ad esempio nei termini d'uso di un sito — può qualificarsi come machine-readable.
- **DPG Media v. HowardsHome** (Tribunale di Amsterdam, fine 2024): l'art. 4(3) non impone uno standard tecnico unico, ma richiede che la riserva sia *"praticamente rilevabile ed elaborabile da sistemi automatizzati"*.
- La direzione delle due decisioni è *"markedly different"*: un opt-out in linguaggio naturale nei ToS soddisfa l'olandese requisito di processabilità automatica? Incerto. Per il professionista questo significa: **affidarsi solo a una clausola nei termini d'uso è rischioso; serve anche un segnale tecnico** (robots.txt, metadati, header).

**Lawful access come ulteriore filtro** (Synodinou-Vrakas, novembre 2025): i dataset costruiti per scraping indiscriminato possono includere opere *accessibili pubblicamente ma non "legalmente accedute"*, spingendole fuori dalla protezione dell'eccezione TDM. Un argomento che rafforza la posizione dei titolari.

#### 4-ter.3 — La spinta del Parlamento UE a riformare l'opt-out

Sul tema, il Parlamento europeo ha prodotto due documenti distinti nell'ambito della procedura di iniziativa **2025/2058(INI)** *"Copyright and generative artificial intelligence – opportunities and challenges"* (commissione JURI, relatore **Axel Voss**), da non confondere: (1) lo **studio commissionato dalla commissione JURI** — *"Generative AI and Copyright – Training, Creation, Regulation"*, **PE 774095**, a cura del Prof. Nicola Lucchi, pubblicato il **9 luglio 2025** — che conclude che l'addestramento AI su larga scala *"far exceeds the scope of the current TDM exceptions"*; e (2) il **progetto di relazione / Motion for a resolution** — **PE775.433, del 27 giugno 2025** — che chiede norme più chiare o un'eccezione dedicata per la GenAI, piena trasparenza sui dati di training e un obbligo di remunerazione per i titolari. La risoluzione è stata poi adottata in plenaria il **10 marzo 2026** (T10-0066/2026). La maggioranza ritiene comunque **non necessario** un nuovo strumento legislativo "at this stage", privilegiando l'attuazione del quadro esistente — segno di una tensione politica irrisolta.

#### 4-ter.4 — Il caso italiano: FIEG vs Google, DSA e il dilemma dell'opt-out

L'Italia è uno dei fronti più caldi d'Europa:

- **15 ottobre 2025:** la **FIEG** (Federazione Italiana Editori Giornali) deposita un reclamo formale all'**AGCOM** (in qualità di Coordinatore nazionale dei Servizi Digitali) contro **AI Overview e AI Mode**, definendoli *"traffic killer"*. L'accusa giuridica non è di copyright ma di **violazione del DSA**: AI Overview e AI Mode (con query fan-out e link spostati in colonna laterale) configurerebbero concorrenza impropria, riduzione strutturale di visibilità e ricavi, e *"un rischio sistemico per la sostenibilità economica dell'intero ecosistema dell'informazione"*. Il DSA impone alle VLOP/VLOSE (categoria che include Google) obblighi di trasparenza algoritmica e non discriminazione delle fonti.
- **29 aprile 2026 (atto AGCOM, distinto e successivo al reclamo):** all'esito di audizioni con Google, FIEG e FISC, l'AGCOM — nel suo ruolo di Coordinatore nazionale dei servizi digitali — ha deciso di **trasmettere alla Commissione europea, ai sensi dell'articolo 65 del DSA, una richiesta di valutazione** dei servizi Google AI Overviews e AI Mode in relazione agli articoli 27, 34 e 35 DSA (rischi sistemici per pluralismo e libertà di informazione; trasparenza dei sistemi di raccomandazione). Comunicato del 30 aprile 2026; decisione assunta con il **voto contrario della commissaria Elisa Giomi**. Si tratta di una **segnalazione** finalizzata all'eventuale apertura di un'indagine da parte della Commissione — non di un procedimento sanzionatorio autonomo dell'AGCOM (la competenza sulle VLOP/VLOSE resta alla Commissione). La FIEG chiede tra l'altro *"il rispetto effettivo dei meccanismi di opt-out, senza il rischio di penalizzazioni o riduzione della visibilità dei contenuti"*.

Quest'ultimo punto rivela **il dilemma centrale della GEO in Europa, che è anche un dilemma tecnico-strategico per i tuoi clienti:**

> Esercitare l'opt-out (bloccare i crawler AI) protegge il copyright ma **rimuove il contenuto dalle risposte generative**, azzerando la visibilità GEO. Non esercitarlo espone i contenuti allo sfruttamento senza compensazione. Gli editori chiedono di poter fare opt-out *senza* perdere visibilità — ma tecnicamente, oggi, le due cose sono in larga parte la stessa leva.

Per un sito SME/e-commerce (non un editore) la scelta razionale è quasi sempre **non** fare opt-out dai bot di *retrieval* (vuoi essere citato), mentre l'opt-out dai bot di *training* è una scelta di principio a costo quasi nullo in termini di visibilità immediata. Ma vanno distinti: bloccare GPTBot (training) non toglie da ChatGPT Search; bloccare OAI-SearchBot/ChatGPT-User sì.

#### 4-ter.5 — Garante Privacy e GDPR: il precedente italiano

Sul fronte dati personali (distinto dal copyright):

- Il **Garante italiano** è stato il primo regolatore al mondo a limitare ChatGPT (31 marzo 2023, Provv. 112/2023): mancanza di informativa, assenza di base giuridica per il training, carente tutela dei minori. Riattivazione il 28 aprile 2023 dopo misure correttive (informativa, diritto di opposizione anche per i non-utenti, verifica età).
- **Sanzione del 2024 (Provv. 755):** **15 milioni di euro**. OpenAI fa opposizione e il **Tribunale di Roma annulla la sanzione** (sent. n. 4153/2026, depositata il 18 marzo 2026), dopo di che il provvedimento è stato rimosso dal sito del Garante. *(Nota: le motivazioni della sentenza non risultano ancora pubbliche a metà 2026; verificare la data esatta di adozione del provvedimento sanzionatorio prima della pubblicazione, riportata da alcune fonti al 20 dicembre 2024.)*

Rilevanza GEO: il GDPR vincola come i dati personali presenti nei contenuti possono essere processati dai motori AI, e il "diritto di opposizione" esteso ai non-utenti è un precedente di opt-out su base privacy parallelo a quello copyright.

#### 4-ter.6 — Timeline operativa dell'AI Act (per chi pubblica contenuti)

- **1 agosto 2024:** entrata in vigore (Reg. UE 2024/1689).
- **2 agosto 2025:** applicabili gli obblighi per i modelli GPAI (inclusi policy copyright e "riassunto sufficientemente dettagliato" dei dati di training). Pubblicato il GPAI Code of Practice (capitoli Trasparenza, Copyright, Safety).
- **2 agosto 2026:** piena applicabilità, inclusi gli obblighi di trasparenza (etichettatura dei contenuti generati da AI e dei deepfake).

Per un freelance: gli obblighi diretti ricadono sui *fornitori* di modelli, non su chi pubblica siti. Ma l'etichettatura dei contenuti AI-generati (dei tuoi clienti) e la gestione corretta di opt-out/licensing diventano parte della due diligence professionale.

### 5. Implicazioni pratiche per la GEO

#### Cosa resta valido dalla SEO classica
Crawlability e indicizzazione (estese a Bing per ChatGPT e ai bot AI di retrieval); autorevolezza/E-E-A-T; HTML semantico e velocità; rendering server-side (molti bot AI fetchano ma non eseguono JS).

#### Cosa è nuovo nella GEO
Ottimizzazione a livello di chunk/passaggio (non di pagina); ampiezza topica per il query fan-out (pillar + cluster); costruzione di entità/brand; diversificazione delle superfici (YouTube, Reddit); indicizzazione su Bing.

#### Raccomandazioni operative in tre fasi

**Fase 1 — Fondamenta tecniche (immediato):**
1. Verificare l'indicizzazione su **Bing Webmaster Tools** (prerequisito per ChatGPT). Usare **IndexNow**.
2. Auditare il **robots.txt**: consentire i bot di retrieval (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User) anche bloccando il training. Non bloccare per errore i bot di citazione.
3. Rendering server-side del contenuto chiave e HTML semantico pulito.

**Fase 2 — Contenuto (1-3 mesi):**
4. Riscrivere le pagine top in formato **answer-first**: heading a domanda, risposta diretta nei primi 40-60 token.
5. Inserire **statistiche citate** e **quotazioni** (le leve con più evidenza).
6. Aggiornare trimestralmente i contenuti chiave (freschezza, specie per Perplexity).
7. Strutturare in **chunk autosufficienti** che coprano le sotto-domande (per il fan-out), architettura pillar + cluster. (NB: scrivere bene, non spezzare artificialmente — vedi 6.2.)

**Fase 3 — Autorità e misurazione (3-6 mesi):**
8. Costruire **menzioni di brand** e citazioni di terze parti (G2/Trustpilot, PR digitale, YouTube, Reddit); Wikipedia per il grounding delle entità dove rilevante.
9. Implementare un tool di tracking AI (Otterly entry, Peec AI per il multilingua europeo, Profound enterprise) e monitorare **trend con run ripetute** (vedi 4-bis), non snapshot.

**Soglie che cambiano le raccomandazioni:**
- Se il traffico da AI search supera l'1-2% (oggi tipicamente <1% ma converte meglio dell'organico), aumentare l'investimento GEO.
- Se l'overlap tra citazioni AI e ranking organico è basso, dare priorità a chunking-friendliness e autorevolezza.
- Per l'Italia, monitorare il lancio dell'**AI Mode in italiano** e l'evoluzione del caso FIEG-AGCOM e del quadro copyright UE.

### 6. Sezione critica / anti-hype: cosa smontare nel discorso GEO corrente

Coerentemente con un approccio da devil's advocate, questa sezione isola i claim GEO che circolano come verità ma che hanno evidenza debole, nulla o contraria. Il criterio è uno solo: **fonte primaria o esperimento replicabile vs ripetizione tra influencer.**

#### 6.1 — Il documento che cambia il quadro: Google smonta 5 miti (15 maggio 2026)

Il **15 maggio 2026** Google Search Central ha pubblicato la guida ufficiale *"Optimizing your website for generative AI features on Google Search"* (annunciata da John Mueller, nuova sezione "Generative AI fundamentals"). È la dichiarazione on-record più esplicita di Google su cosa funziona e cosa no per AI Overviews e AI Mode. La tesi di fondo: **"AEO e GEO sono ancora SEO"**, perché le feature AI girano sugli stessi sistemi di ranking della Search classica. Google classifica esplicitamente come **non necessari**:

1. **File `llms.txt` e markup speciali:** *"You don't need to create new machine readable files, AI text files, markup, or Markdown to appear in generative AI search."* Google può scoprire e indicizzare questi file, ma non ricevono trattamento speciale.
2. **Chunking del contenuto:** non c'è alcun requisito di spezzare il contenuto in piccoli pezzi; i sistemi Google *"are able to understand the nuance of multiple topics on a page and show the relevant piece to users."* Danny Sullivan (gennaio 2026) aveva già riferito che gli ingegneri Google sconsigliano il chunking.
3. **Riscritture AI-specifiche:** i sistemi AI capiscono sinonimi e significati generali; non serve riscrivere per l'AI.
4. **Menzioni inautentiche:** link-building e menzioni artificiali non ingannano i sistemi AI.
5. **Uso eccessivo di schema/structured data:** non è richiesto per generare risposte AI.

Cosa Google dice di fare *davvero*: SEO solida (indicizzabile, crawlabile, buona page experience), **contenuto non-commodity** con prospettive uniche ed esperienza diretta, asset multimodali.

A rafforzare la posizione, il **5 giugno 2026** Google ha pubblicato *"Google Search's guidance on using third-party SEO tools, services, and advice"* e aggiornato la pagina storica *"Do you need an SEO?"*, nominando esplicitamente **AEO e GEO come categorie di servizio** offerte da consulenti e agenzie. Il messaggio è coerente con la guida del 15 maggio: Google **legittima la disciplina** (riconosce che esistono servizi GEO/AEO) ma ne **restringe il perimetro** ribadendo che resta "ancora SEO" e invitando alla cautela verso chi promette scorciatoie o garanzie di posizionamento nelle risposte AI.

#### 6.2 — La tensione onesta sul chunking (e come scioglierla)

C'è un'apparente contraddizione tra la Sezione 2-bis (dove sostengo che la struttura/chunkabilità conta) e Google che dice "il chunking non serve". Va affrontata, non nascosta:

- **Google ha ragione su un punto specifico:** non devi spezzare *fisicamente* la pagina in micro-file o micro-pagine per l'AI, e non devi riscrivere in "formato AI". I suoi sistemi di retrieval fanno il chunking lato loro e capiscono pagine lunghe multi-tema.
- **Ma "non serve fare chunking manuale" ≠ "la struttura non conta".** La ricerca sul RAG (Sezione 2-bis.3) mostra che chunk netti e autosufficienti migliorano il retrieval *a parità di tutto il resto*. La differenza è che ottieni quei chunk **scrivendo bene** (heading chiari, un'idea per sezione, risposte dirette), non manipolando artificialmente la struttura per il bot. In altre parole: Google smonta il chunking-come-hack, non la chiarezza strutturale come buona pratica.
- **Distinzione cruciale per non sbagliare:** la guida Google vale per *Google* (AI Overviews/AI Mode, che girano sul ranking Search). Per ChatGPT, Perplexity e Claude — che hanno pipeline RAG proprie e diverse — l'evidenza sul valore della struttura resta più rilevante. Generalizzare "il chunking è morto" da una dichiarazione Google a tutti i motori è esattamente il tipo di iper-estensione che questa sezione critica vuole evitare.

**Verdetto:** smetti di vendere/comprare "ottimizzazione del chunking" come servizio tecnico a sé. Continua a scrivere contenuto strutturato bene, perché aiuta i motori RAG non-Google e aiuta comunque i lettori.

#### 6.3 — llms.txt: il caso da manuale di hype

llms.txt merita una dissezione perché è il claim GEO più ripetuto e meno supportato:

- **Cos'è davvero:** una proposta di Jeremy Howard (settembre 2024), un file Markdown nella root per aiutare gli LLM a usare un sito in fase di inferenza. Nasce per la *documentazione tecnica destinata a tool per sviluppatori*, non come leva SEO.
- **Le prove contro (visibilità nella ricerca AI):** Google *Search* dichiara di non usarlo. La guida ufficiale del 15 maggio 2026 afferma che non servono nuovi file machine-readable, AI text file, markup o Markdown, perché *"Google Search itself doesn't use them"* e che aggiungerli *"won't harm (nor help)"* la visibilità. Mueller lo paragona al "keywords meta tag" obsoleto. Misurazioni indipendenti (Otterly) rilevano 84 richieste su 62.100 verso il file in 90 giorni (0,1%); Ahrefs (studio 15 giugno 2026, ~38.000 file validi su 137.210 domini) rileva che il **97% dei file llms.txt non riceve alcuna richiesta** a maggio 2026 — e tra le fetch che avvengono, solo il 19,5% viene da tool AI nominati (*"Slackbot alone fetched llms.txt files more often than PerplexityBot did"*). SE Ranking (~300.000 domini) non trova correlazione tra adozione e citazioni; rimuovere la variabile dal modello ne *migliora* l'accuratezza. L'analisi Search Engine Land ("GEO myths") è netta: *"there is no data or evidence showing that llms.txt files boost AI inclusion. There is certainly no proof."*
- **La biforcazione Search vs Chrome (fatto recente, da non fraintendere):** a ~8 giorni di distanza dalla guida Search, Google *Chrome* ha aggiunto llms.txt agli strumenti per sviluppatori. **Lighthouse 13.3.0** (changelog ufficiale GitHub, 7 maggio 2026) ha introdotto nel config di default una **categoria sperimentale "Agentic Browsing"** che include un check su llms.txt come segnale *opzionale* di "prontezza per agenti AI" (agentic readiness), accanto a WebMCP, accessibility tree e CLS. **Non è una contraddizione, è una biforcazione di scopo tra due team diversi:** Lighthouse è uno strumento *diagnostico di best-practice*, non un motore di ricerca; un audit che rileva llms.txt non equivale a Google Search che lo usa per le citazioni. Tant'è che l'audit marca un file assente (404) come *"Not Applicable"* perché *"optional at the moment"*, e la categoria non assegna nemmeno un punteggio 0-100 *"because the standards for the agentic web are still emerging"*. Mueller (19 maggio 2026) lo conferma: llms.txt *"is not done for search ... more of a temporary crutch, perhaps to save some tokens"* per i tool di AI coding. **La motivazione di Lighthouse è prospettica** (uso futuro presunto da parte di agenti), non basata su evidenza di utilizzo reale provato — che resta negativa. Vedere comparire llms.txt nei check ufficiali di Chrome potrebbe far ripensare alcuni SEO ai propri dubbi, ma sul piano delle citazioni non cambia nulla.
- **Il granello di verità (da non gonfiare):** un'analisi Wix (AI Search Lab, oltre 1.400 file esaminati, novembre 2025 aggiornata a maggio 2026) stima che il numero di file llms.txt indicizzati da Google sia salito da ~30.000-60.000 (ottobre 2025) a circa 120.000 (maggio 2026), con un picco di ~200.000 ad aprile 2026 — segno che il formato costa una frazione dei token di una pagina HTML e *può* avere senso nell'ottica dell'**agentic web** futura e per RAG su tool che lo leggono esplicitamente. È però una **stima di parte non verificata da fonti indipendenti** (la cifra "125.000" spesso citata compare nel sottotitolo dell'articolo ma non coincide con il "circa 120.000" del corpo del testo), e — parole della stessa fonte — *"this will not make or break your GEO strategy."*
- **Verdetto critico:** llms.txt come leva di citazione AI è **non provato e con evidenza prevalentemente contraria**. Ha un caso d'uso legittimo e ristretto (documentazione per agenti/dev tool), che è diverso dal "ti fa citare di più da ChatGPT". L'inserimento in Lighthouse non smentisce gli studi: misura una *agentic readiness* prospettica, non il comportamento reale dei bot oggi. Chi lo vende come fattore GEO sta vendendo una scommessa sul futuro spacciata per tattica presente. Priorità realistica: bassissima, dopo qualsiasi cosa che riguardi qualità e struttura del contenuto. Se il CMS lo genera con poco sforzo (Wix, Framer lo fanno già), tenerlo come "infrastruttura a basso costo orientata al futuro" è accettabile — ma va versionato e protetto (rischio prompt injection segnalato da Ahrefs).

#### 6.4 — Servire le pagine anche in Markdown: marginale, spesso hype

Domanda ricorrente: conviene pubblicare una versione Markdown delle pagine (via content negotiation o file `.md` paralleli) per farsi citare meglio dagli AI? Risposta breve: <strong>per i motori generativi mainstream è marginale/situazionale, non un fattore provato</strong>, e in alcune forme è rischioso.

- **Distinzione tecnica cruciale:** (a) **content negotiation** via header `Accept: text/markdown` sullo *stesso* URL è uno standard HTTP legittimo, non cloaking; (b) **file `.md` a URL separati** sono definiti da Google e Bing come potenziale cloaking e raddoppio del crawl budget (Bing crawla comunque entrambe le versioni per verificare similarità).
- **I crawler di ricerca non negoziano Markdown.** GPTBot, OAI-SearchBot, ChatGPT-User, PerplexityBot, ClaudeBot, Googlebot, Bingbot non inviano `Accept: text/markdown`. Lo fanno solo alcuni *agenti di coding* in sessione live (Claude Code, Cursor, OpenCode — test indipendente Checkly, feb 2026). Generalizzare il loro comportamento a tutti i crawler è l'errore alla base dell'hype.
- **L'evidenza empirica è di effetto nullo/non significativo.** Profound (esperimento controllato, 381 pagine, gen-feb 2026): ~16% di lift medio ma *non statisticamente significativo*, trainato da outlier. Otterly (md vs HTML, 14 giorni): i file `.md` hanno ricevuto lo 0% del traffico bot AI e zero citazioni. È lo stesso destino di llms.txt (anch'esso Markdown): se quello non muove l'ago, il formato di per sé non è il fattore.
- **Il vantaggio reale del Markdown è la tokenizzazione** (~80% di token in meno secondo l'esempio Cloudflare), ma beneficia chi *converte* l'HTML — Jina Reader, Firecrawl, le pipeline RAG, Claude Code via Turndown convertono già l'HTML in Markdown lato loro, rendendo in larga parte ridondante servirlo.
- **Posizione ufficiale Google (15 mag 2026):** *"You don't need to create new machine readable files, AI text files, markup, or Markdown ... as Google Search itself doesn't use them."* Mueller (Bluesky, feb 2026): convertire le pagine in Markdown solo per i bot è *"such a stupid idea"*.
- **Verdetto:** ha senso solo per **documentazione tecnica / SaaS / API** consultate da agenti di coding in tempo reale (developer experience + risparmio token), o come beneficio infrastrutturale (banda/costi). Per un sito e-commerce/aziendale generico che punta a ChatGPT/Perplexity/AI Overviews è investimento a ROI provato basso/nullo. Conta molto di più l'**HTML semantico pulito** (heading corretti, tabelle vere, no div-soup, server-side rendering): aiuta gli LLM, gli scraper e l'accessibilità insieme. Se proprio lo implementi, usa content negotiation con `Vary: Accept`, mai file `.md` indicizzabili separati.

#### 6.5 — Schema/structured data: utile, ma non per il motivo che ti dicono

- **Il claim hype:** "senza schema.org non vieni citato dall'AI."
- **L'evidenza:** Google (maggio 2026) dice esplicitamente che lo structured data **non è richiesto** per generare risposte AI. Pedro Dias e altri hanno mostrato che lo schema non influenza le citazioni ChatGPT. Gli studi di correlazione (siti con schema = più visibilità AI) esistono ma sono **confusi da variabili terze**: i siti che implementano schema tendono a essere anche più curati, più autorevoli, meglio strutturati. La correlazione non isola lo schema come causa.
- **Verdetto bilanciato:** lo schema resta utile per i suoi scopi classici (rich result, parsing, disambiguazione di entità) e non fa male. Ma non è il fattore di citazione AI che il marketing GEO suggerisce. Implementalo per igiene tecnica e per la Search tradizionale, non come "trucco AI".

#### 6.6 — I numeri-civetta dei vendor

Una classe di claim da trattare con sospetto sistematico: percentuali precise senza fonte primaria nominata. Esempi che circolano:

- "I contenuti data-rich sono citati 2,7x in più."
- "FCP sotto 0,4s = 6,7 citazioni medie."
- "Le pagine con heading ben organizzati sono 2,8x più citate." (AirOps — quest'ultima almeno ha un dataset dichiarato di 45.000 citazioni, quindi è più difendibile delle altre due.)

**Perché sospettare:** spesso mancano metodologia, dimensione del campione, numero di run per prompt e gruppo di controllo. Alla luce della Sezione 4-bis (una run singola ha SE 0,370!), qualsiasi cifra a due decimali ottenuta senza run ripetute è statisticamente sospetta. **Regola pratica:** se un claim non dichiara quante volte ha ripetuto ogni prompt e su quale periodo, trattalo come aneddoto, non come dato.

#### 6.7 — "Il SEO è morto": l'iper-estensione opposta

All'estremo opposto dell'hype GEO c'è l'hype del "SEO è morto, conta solo la GEO". È altrettanto sbagliato:

- I dati Ahrefs/Semrush mostrano che il ranking organico tradizionale **resta correlato** (anche se non più condizione necessaria) con la citazione AI; gli AI Overviews girano *sopra* il sistema di ranking Search.
- La "visibilità parametrica" (Sezione 2-ter.1) si costruisce con gli stessi segnali del SEO classico: autorità, copertura stampa, Wikipedia, backlink, menzioni.
- Google stessa intitola la sua posizione "AEO e GEO sono ancora SEO".

**Verdetto:** la GEO è un'estensione del SEO, non un suo sostituto. Le fondamenta (crawlabilità, autorevolezza, contenuto di qualità) sono *più* importanti, non meno. Ciò che cambia è il livello di competizione (chunk vs pagina), le superfici (YouTube, Reddit) e le metriche (citazione vs click).

#### 6.8 — Tabella di triage dei claim GEO

| Claim GEO | Evidenza | Verdetto | Priorità |
|---|---|---|---|
| Statistiche + citazioni di fonti aumentano la citazione | GEO paper (KDD 2024), replicabile | Provato | Alta |
| Freschezza del contenuto conta | Ahrefs, Seer, Perplexity test, GEO paper | Provato | Alta |
| Contenuto non-commodity / esperienza diretta | Google guide ufficiale 2026 | Confermato dal platform | Alta |
| Struttura/chiarezza answer-first | Ricerca RAG + cross-encoder | Solido (meccanismo) | Alta |
| Menzioni di brand > backlink per citazioni | Previsible (1,96M sessioni) | Plausibile, 1 studio | Media |
| Schema/structured data per AISO | Smentito da Google 2026 | Sopravvalutato | Bassa (fallo per altro) |
| Chunking manuale del contenuto | Smentito da Google 2026 | Mito (per Google) | Bassa |
| llms.txt come leva di citazione | Nessuna prova, evidenza contraria (Search); incluso in Lighthouse come agentic readiness | Non provato per citazioni / hype | Bassissima |
| Servire pagine in Markdown | Profound/Otterly: effetto nullo/non signif. | Marginale (utile solo per dev tool) | Bassa |
| Numeri-civetta "2,7x", "6,7 citazioni" | Senza metodologia/run | Aneddoto | Ignora |
| "Il SEO è morto" | Contraddetto dai dati | Falso | — |

## Caveats
- **Distinguere fatti documentati da claim dei vendor:** indici e numeri Pew/SparkToro/Ahrefs/Seer sono ben documentati; molti "fattori di citazione" precisi provengono da blog di vendor e non sono verificabili con fonti primarie nominate.
- **Dati contrastanti sul ranking:** l'overlap tra citazioni AIO e top-10 varia tra studi (38% vs 76%) anche per differenze metodologiche di rilevamento.
- **Le previsioni sono previsioni:** il 25% di Gartner è una stima del 2024, non un consuntivo.
- **Reverse-engineering:** i dettagli su `web.run`, fan-out e system prompt di ChatGPT derivano da analisi indipendenti (RESONEO/Meteoria, AirOps, Dejan), non da documentazione ufficiale completa, e cambiano da un modello all'altro.
- **Volatilità:** le pipeline cambiano rapidamente (Gemini 3 gen 2026, switch ChatGPT 5.3 mar 2026); ogni dato ha una data di validità.
- **Tensione chunking:** Google (mag 2026) dichiara non necessario il chunking manuale per le *sue* feature AI; questo vale per Google, mentre per i motori RAG non-Google la struttura del contenuto resta rilevante (vedi 6.2).
- **llms.txt e schema:** segnalati esplicitamente come hype/sopravvalutati per la GEO (Sezione 6), a differenza di quanto suggerito da molti tool e agenzie. Sul caso Lighthouse: la categoria "Agentic Browsing" è **sperimentale** e può cambiare/essere rimossa; la documentazione ufficiale Chrome **non** menziona la content negotiation (`Accept: text/markdown`), quindi quella caratteristica non va attribuita a Lighthouse. La data del changelog 13.3.0 (7 mag 2026) è quella ufficiale del rilascio; la copertura stampa è di ~20 mag 2026.

---

## Bibliografia / Fonti

**Paper accademici e benchmark**
- Aggarwal P. et al., *GEO: Generative Engine Optimization*, arXiv:2311.09735, KDD 2024 — https://arxiv.org/abs/2311.09735
- Schulte J. et al., *Don't Measure Once: Measuring Visibility in AI Search (GEO)*, arXiv:2604.07585 (10 apr 2026) — https://arxiv.org/abs/2604.07585
- Sielinski R., paper su incertezza nella misurazione di visibilità AI (mar 2026), arXiv:2603.08924
- Gemini Team, *Gemini 2.5 Technical Report*, arXiv:2507.06261 — https://arxiv.org/pdf/2507.06261
- *Hybrid Dense-Sparse Retrieval for High-Recall IR* (gen 2026) — researchgate 399428523
- Khattab O., Zaharia M., *ColBERT* (SIGIR 2020); Santhanam et al., *ColBERTv2/PLAID* (2022)
- Studi chunking: Vecta Benchmark (feb 2026); arXiv:2506.17277 (chimica); arXiv:2512.05411 (enterprise); arXiv:2506.06339 (arabo); MDPI Bioengineering (nov 2025, clinico); BEIR arXiv:2104.08663
- *LegalBench-RAG*, arXiv:2408.10343

**Retrieval / embeddings / chunking / reranking**
- Towards Data Science, *Advanced RAG Retrieval: Cross-Encoders & Reranking* — https://towardsdatascience.com/advanced-rag-retrieval-cross-encoders-reranking/
- Pinecone, *Rerankers and Two-Stage Retrieval* — https://www.pinecone.io/learn/series/rag/rerankers/
- Weaviate, *Late Interaction Retrieval: ColBERT, ColPali, ColQwen* — https://weaviate.io/blog/late-interaction-overview
- Qdrant, *Any Embedding Model Can Become a Late Interaction Model* — https://qdrant.tech/articles/late-interaction-models/
- Firecrawl, *Best Chunking Strategies for RAG (2026)* — https://www.firecrawl.dev/blog/best-chunking-strategies-rag
- Chroma, *Context Rot research* (lug 2025)

**Reverse-engineering motori**
- de Segonzac O. (RESONEO/Meteoria), *Inside ChatGPT Search: web.run and fan-out queries*, Search Engine Land (14 mag 2026) — https://searchengineland.com/inside-chatgpt-search-web-run-fan-out-queries-ai-visibility-477339 ; studio completo: https://think.resoneo.com/chatgpt/5.3-5.4/
- Seer Interactive, *SearchGPT vs Bing citation overlap (87%)* (feb 2025)
- Google, *Gemini API — Grounding with Google Search* (groundingMetadata) — https://ai.google.dev/gemini-api/docs/google-search
- Yeşilyurt M., analisi reranking Perplexity (ago 2025), via Search Engine Land; AuthorityTech, *How Perplexity Selects Sources* (feb 2026) — https://authoritytech.io/blog/how-perplexity-selects-sources-algorithm-2026
- GrowthMarshal, *The 2025 Perplexity Playbook: Sonar Ranking Factors* — https://www.growthmarshal.io/field-notes/the-perplexity-playbook
- RankStudio, *Perplexity's LLM: Sonar & PPLX Deep Dive* — https://rankstudio.net/articles/en/perplexity-llm-tech-stack
- Anthropic, *Web search tool — Claude API Docs* — https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool

**Microsoft Copilot / Bing**
- Microsoft Bing Blog, *Building the New Bing | Search Quality Insights* (Prometheus, Bing Orchestrator) — https://blogs.bing.com/search-quality-insights/february-2023/Building-the-New-Bing
- Bing Webmaster Guidelines (riscrittura 27 feb 2026); Search Engine Journal e WrittenlyHub, analisi NOARCHIVE/NOCACHE/data-snippet
- Seer Interactive, *87% of SearchGPT Citations Match Bing's Top Results* (6 feb 2025) — https://www.seerinteractive.com/insights/searchgpt-citations-bing
- Microsoft, *IndexNow* e *Bing Webmaster Tools — AI Performance Report* (public preview feb 2026)

**Motori AI cinesi**
- Baidu, *Fourth Quarter and Fiscal Year 2025 Results* (26 feb 2026) — https://ir.baidu.com/news-releases/news-release-details/baidu-announces-fourth-quarter-and-fiscal-year-2025-results ; earnings call transcript via Investing.com
- ERNIE 4.5 open-source (30 giu 2025), licenza Apache 2.0 — post ufficiale @Baidu_Inc; TechNode, SCMP
- DeepSeek quota API ~34% vs ERNIE ~18% (snapshot metà 2025) — SiliconANGLE, TechRadar Pro
- QuestMobile (via Caixin), *leading native AI apps in China, March 2026* (Doubao ~345M MAU)

**Misurazione / volatilità**
- Profound, *AI Search Volatility* — https://www.tryprofound.com/blog/ai-search-volatility
- AirOps, *AI Search Volatility* e *AI Visibility Metrics* — https://www.airops.com/blog/ai-visibility-metrics
- Lafferty N., *AI Visibility Metrics: Formulas, Benchmarks & Sample Sizes (2026)* — https://nicklafferty.com/blog/ai-visibility-metrics-reference/
- Machine Relations, *Citation Drift* (BrightEdge 70x, Semrush Reddit 60→10%) — https://medium.com/machine-relations/citation-drift-ai-visibility-data-d7c2eea8e223

**Guida ufficiale Google e anti-hype**
- Google Search Central, *A new resource for optimizing for generative AI in Search* (15 mag 2026) — https://developers.google.com/search/blog/2026/05/a-new-resource-for-optimizing
- Google Search Central, *Guidance on using third-party SEO tools, services, and advice* e aggiornamento *Do you need an SEO?* (5 giu 2026, nomina AEO/GEO come categoria) — cfr. Digital Applied, *Google Now Tells You to Optimize for Generative AI* — https://www.digitalapplied.com/blog/google-official-seo-docs-generative-ai-optimization-june-2026
- Search Engine Journal, *Google's New AI Search Guide Calls AEO And GEO 'Still SEO'* — https://www.searchenginejournal.com/googles-new-ai-search-guide-calls-aeo-and-geo-still-seo/575026/
- Search Engine Land, *GEO myths: This article may contain lies* — https://searchengineland.com/geo-myths-lies-467617
- Wix Studio, *Debunking LLMs.txt Myths* (oltre 1.400 file; stima ~120.000 indicizzati) — https://www.wix.com/studio/ai-search-lab/llms-txt-myths
- Ahrefs, *97% of llms.txt Files Never Get Read* (mag 2026) — https://ahrefs.com/blog/llmstxt-study/ ; SE Ranking, *LLMs.txt: Why It Doesn't Work* — https://seranking.com/blog/llms-txt/ ; Otterly, *The llms.txt Experiment* — https://otterly.ai/blog/the-llms-txt-experiment/
- Search Engine Journal, *Mueller: llms.txt Can't Help LLMs Differentiate Sites* — https://www.searchenginejournal.com/googles-mueller-says-llms-txt-cant-help-llms-differentiate-sites/579304/
- Google Chrome for Developers, *Lighthouse agentic browsing scoring* e *llms.txt audit* (cat. sperimentale, doc agg. 5 mag 2026) — https://developer.chrome.com/docs/lighthouse/agentic-browsing/scoring · https://developer.chrome.com/docs/lighthouse/agentic-browsing/llms-txt
- GoogleChrome/lighthouse, *changelog 13.3.0* (Agentic Browsing nel default config, 7 mag 2026) — https://github.com/GoogleChrome/lighthouse/blob/main/changelog.md
- Search Engine Journal, *Google's llms.txt Guidance Depends On Which Product You Ask* (20 mag 2026) — https://www.searchenginejournal.com/googles-llms-txt-guidance-depends-on-which-product-you-ask/575431/ ; Search Engine Land, *Google adds llms.txt check to Chrome Lighthouse* — https://searchengineland.com/google-llms-txt-chrome-lighthouse-478246

**Markdown per le pagine (content negotiation / .md)**
- Google Search Central, *AI optimization guide* (no Markdown necessario) — https://developers.google.com/search/docs/fundamentals/ai-optimization-guide
- Profound, *Markdown vs HTML: An Experiment on AI Traffic* — https://www.tryprofound.com/blog/does-markdown-increase-ai-bot-traffic
- Otterly, *GEO Experiment: Markdown vs HTML* — https://otterly.ai/blog/geo-experiment-html-vs-markdown/
- Checkly, *State of Content Negotiation for AI Agents* — https://www.checklyhq.com/blog/state-of-ai-agent-content-negotation/
- Cloudflare, *Introducing Markdown for Agents* — https://blog.cloudflare.com/markdown-for-agents/ ; Search Engine Land, *Google & Bing don't recommend separate markdown pages* — https://searchengineland.com/google-bing-dont-recommend-seperate-markdown-pages-for-llms-468365

**Quadro giuridico UE/Italia**
- Direttiva (UE) 2019/790 (CDSM), artt. 3-4; AI Act (Reg. UE 2024/1689), art. 53(1)(c), Considerando 106
- EPRS, *AI and copyright: training of general-purpose AI* — https://www.europarl.europa.eu/RegData/etudes/ATAG/2025/769585/EPRS_ATA(2025)769585_EN.pdf
- Parlamento UE, procedura 2025/2058(INI) *"Copyright and generative AI"* (relatore Voss): studio JURI PE 774095 (Lucchi, 9 lug 2025) e draft report PE775.433 (27 giu 2025); risoluzione T10-0066/2026 (10 mar 2026) — https://oeil.secure.europarl.europa.eu/oeil/en/procedure-file?reference=2025/2058(INI) ; Jones Day, *EP study on GenAI and copyright* — https://www.jonesday.com/en/insights/2025/08/european-parliaments-new-study-on-generative-ai-and-copyright-calls-for-overhaul-of-optout-regime
- Kluwer Copyright Blog, *The TDM Opt-Out in the EU* e *LAION Round 2* — https://legalblogs.wolterskluwer.com/copyright-blog/the-tdm-opt-out-in-the-eu-five-problems-one-solution/
- Synodinou-Vrakas, *Lawful Access as a Gatekeeper for TDM*, Verfassungsblog (17 nov 2025) — https://verfassungsblog.de/lawful-access-gatekeeper/
- Kneschke v. LAION (Tribunale di Amburgo, 27 set 2024); DPG Media v. HowardsHome (Amsterdam, 2024)
- Agenda Digitale, *Editori italiani (FIEG) contro l'AI di Google* — https://www.agendadigitale.eu/mercati-digitali/editori-italiani-fieg-contro-lai-di-google-ecco-le-basi-del-reclamo-agcom/
- Key4biz, *FIEG contro Google: "AI Overview è un traffic killer"* — https://www.key4biz.it/fieg-contro-google-ai-overview-e-un-traffic-killer-chiesto-lintervento-dellagcom-per-violazione-del-dsa/550920/
- AGCOM, segnalazione alla Commissione UE su Google AI Overviews/AI Mode ex art. 65 DSA (seduta 29 apr 2026, comunicato 30 apr 2026) — ANSA, Italpress/Business Channel, Primaonline; Agenda Digitale, *L'AI di Google e i giornali: la palla è nel campo dell'UE* — https://www.agendadigitale.eu/mercati-digitali/ai-di-google-e-giornali-la-palla-e-nel-campo-dellue-il-quadro/
- Garante Privacy, Provv. 112/2023 e 755/2024; Tribunale di Roma sent. 4153/2026 (annullamento sanzione) — Altalex
- Eurostat via Euronews, adozione GenAI in Europa — https://www.euronews.com/next/2025/12/29/chatgpt-gemini-grok-and-others-which-countries-use-generative-ai-tools-most-across-europe

**Strumenti di misurazione GEO**
- Surmado, *Best AI Visibility Tools 2026* — https://www.surmado.com/blog/best-ai-visibility-tools-2026
- Otterly.ai — https://otterly.ai/

*Documento aggiornato al 22 giugno 2026. Data la rapidità dell'evoluzione del settore, statistiche e meccanismi descritti hanno validità temporale limitata.*
