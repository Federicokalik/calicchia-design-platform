import type { ServiceDetail } from '../services-detail';
import { PROCESS_STEPS_IT } from './_shared/process';

export const GEO_SERVICE: ServiceDetail = {
  slug: 'geo',
  title: 'GEO & visibilità AI',
  icon: 'ph-sparkle',
  description:
    'Vuoi apparire su ChatGPT, Perplexity e nelle ricerche AI?\nPrima devi rendere il sito leggibile, citabile e misurabile dai motori generativi.',
  longDescription:
    'Apparire su ChatGPT, Perplexity, Gemini, Claude o nelle ricerche AI non dipende da una spunta magica.\nI motori generativi recuperano porzioni di contenuto, le riordinano, sintetizzano una risposta e citano poche fonti.\n\nQui non si vendono scorciatoie: niente llms.txt spacciato per fattore magico, niente schema markup come trucco, niente promessa di citazione garantita.\nSi parte dal white paper "Dalla SEO alla GEO" e dal GEO Audit: accesso dei bot di retrieval, HTML server-side, struttura answer-first, citabilità, freschezza, direttive snippet e misurazione ripetuta.\n\nIl risultato non è una classifica inventata.\nÈ un piano concreto per aumentare la probabilità che il tuo sito venga letto, scelto e citato nelle risposte AI.',
  features: [
    {
      title: 'Audit GEO tecnico',
      description:
        "Analisi di robots.txt, sitemap, rendering server-side, heading, snippet directives, contenuto leggibile nell'HTML grezzo e segnali che possono impedire la citazione.",
    },
    {
      title: 'Struttura answer-first',
      description:
        'Riorganizzazione delle pagine chiave con risposte dirette, sezioni autosufficienti e heading chiari.\nNon per ingannare il modello: per rendere ogni blocco realmente estraibile.',
    },
    {
      title: 'Citabilità verificabile',
      description:
        'Statistiche, fonti esterne, riferimenti, esempi e contenuti non generici vengono inseriti dove servono.\nLe leve sono quelle con evidenza, non quelle comode da vendere.',
    },
    {
      title: 'Accesso bot e direttive',
      description:
        'Separazione tra bot di retrieval/citazione e bot di training.\nSi evita di bloccare chi deve leggere il sito, senza rinunciare agli opt-out dove hanno senso.',
    },
    {
      title: 'Misurazione senza autoinganno',
      description:
        'La visibilità AI è volatile: una singola prova non significa nulla.\nSi definiscono prompt, run ripetute, motori da monitorare e metriche utili come citation share e stabilità.',
    },
    {
      title: 'Triage anti-hype',
      description:
        'llms.txt, Markdown parallelo, schema e chunking manuale vengono trattati per quello che sono: strumenti marginali o contestuali, non leve principali di citazione.',
    },
  ],
  benefits: [
    'Capisci cosa i motori AI vedono davvero del tuo sito.',
    'Smetti di inseguire tattiche GEO vendute senza prove.',
    'Rendi le pagine più chiare per utenti, crawler e sistemi RAG.',
    'Colleghi white paper, audit e interventi in un percorso misurabile.',
    'Costruisci una base solida per SEO classica e visibilità generativa.',
  ],
  process: PROCESS_STEPS_IT,
  faqs: [
    {
      question: 'Come apparire su ChatGPT con il mio sito?',
      answer:
        "Per apparire su ChatGPT non basta pubblicare una pagina e sperare.\nServe che il sito sia accessibile ai bot di retrieval, che il contenuto sia presente nell'HTML server-side, che le risposte siano dirette e che ci siano fonti, dati e segnali di autorevolezza.\nLa GEO lavora su questi elementi.\nNon garantisce la citazione, ma riduce gli ostacoli che rendono il sito invisibile o poco utile come fonte.",
    },
    {
      question: 'Come apparire nelle ricerche AI?',
      answer:
        'Le ricerche AI non funzionano come una lista di link blu.\nChatGPT, Perplexity, Gemini e Claude recuperano blocchi di contenuto, non solo pagine intere.\nPer apparire nelle ricerche AI servono pagine chiare, risposte nei primi paragrafi, citazioni a fonti esterne, dati aggiornati, HTML leggibile e nessuna direttiva che impedisca snippet o retrieval.',
    },
    {
      question: 'Come farsi citare da ChatGPT, Perplexity o Gemini?',
      answer:
        'Bisogna rendere il contenuto citabile.\nQuesto significa rispondere in modo diretto a una domanda, usare dati e riferimenti verificabili, aggiornare le pagine importanti e costruire segnali di brand fuori dal sito.\nIl keyword stuffing peggiora il risultato: non devi ripetere "apparire su ChatGPT" cento volte, devi dare al motore un blocco utile da usare come fonte.',
    },
    {
      question: 'Mi garantisci che ChatGPT citerà il mio sito?',
      answer:
        'No.\nChi promette una citazione garantita sta vendendo controllo che non ha.\nSi può rendere il sito più leggibile, accessibile ai bot di retrieval, strutturato e citabile.\nSi può misurare la presenza con run ripetute.\nMa nessuno controlla quale fonte verrà scelta da ChatGPT, Perplexity, Gemini o Claude in ogni risposta.',
    },
    {
      question: 'La GEO sostituisce la SEO?',
      answer:
        'No.\nLa GEO estende la SEO, non la cancella.\nGoogle stessa ha scritto che AEO e GEO sono ancora SEO.\nLe fondamenta restano: tecnica, contenuto, autorevolezza, performance, dati e coerenza.\nCambia il livello di competizione: spesso non vince la pagina intera, ma il blocco di contenuto più chiaro e citabile.',
    },
    {
      question: 'Serve installare llms.txt?',
      answer:
        'Non come priorità.\nllms.txt può avere senso come infrastruttura opzionale per agenti e tool di sviluppo, ma non è un fattore provato di citazione nei motori AI.\nLighthouse lo tratta come readiness sperimentale, non come ranking factor.\nPrima si sistemano contenuti, accesso bot, SSR, citabilità e misurazione.',
    },
    {
      question: 'Da dove si parte?',
      answer:
        "Dal GEO Audit.\nSi guarda cosa il sito espone davvero nell'HTML grezzo, quali bot sono bloccati, se ci sono direttive che tagliano snippet e se le pagine hanno struttura e fonti sufficienti.\nPoi si decide quali pagine vale la pena riscrivere o consolidare.",
    },
    {
      question: 'Quanto spesso bisogna misurare?',
      answer:
        'Dipende dal settore e dai motori che contano per te, ma una singola prova non basta.\nLa visibilità AI è una distribuzione: lo stesso prompt può produrre fonti diverse.\nServono prompt set, run ripetute e confronto nel tempo, altrimenti si confonde un caso con una tendenza.',
    },
    {
      question: 'Il servizio include anche interventi sui contenuti?',
      answer:
        "Sì, se l'audit mostra che sono il collo di bottiglia.\nLa GEO non è solo tecnica: un sito accessibile ma generico resta poco citabile.\nSi lavora su risposte, fonti, dati, struttura, freshness e pagine che hanno davvero senso per il business.",
    },
  ],
  awareness: {
    title: 'I motori AI non premiano le scorciatoie',
    subtitle:
      'Premiano contenuti leggibili, accessibili, aggiornati e abbastanza solidi da essere usati come fonte.',
    problems: [
      {
        icon: 'ph-robot',
        title: 'Bot bloccati',
        desc:
          'Il sito vuole essere citato, ma robots.txt o meta direttive impediscono ai motori di leggere contenuti e snippet.\nPrima della strategia serve togliere gli ostacoli tecnici.',
      },
      {
        icon: 'ph-text-align-left',
        title: 'Contenuto non citabile',
        desc:
          'Pagine piene di claim generici, senza dati, fonti o risposte dirette.\nUn motore AI non ha motivo di usare quel blocco come fonte se trova risposte migliori altrove.',
      },
      {
        icon: 'ph-chart-line-down',
        title: 'Misure casuali',
        desc:
          'Un prompt provato una volta non è una metrica.\nSenza run ripetute e criteri chiari, ogni report GEO diventa una fotografia casuale spacciata per strategia.',
      },
    ],
  },
  expandedScope: {
    eyebrow: 'METODO',
    title: 'Dal paper al sito, senza vendere magia',
    body:
      "Il white paper spiega il meccanismo: retrieval, chunk, fan-out, citazioni, limiti di llms.txt e misurazione.\nIl GEO Audit applica quei criteri a una pagina reale.\nIl servizio serve a trasformare il risultato in interventi: sistemare l'accesso dei bot, togliere direttive che bloccano snippet, riscrivere sezioni troppo generiche, aggiungere fonti e mantenere aggiornate le pagine che contano.\n\nLa promessa è più modesta, quindi più seria: aumentare la probabilità che il sito sia letto e usato correttamente dai motori AI.\nNon controllare le loro risposte.",
  },
};
