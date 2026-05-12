// Service detail — Performance & Core Web Vitals (standalone, fuori matrice).
// Voice aggressive vs siti lenti + agenzie che non sanno cosa sia un LCP.
// Niente prezzi pubblici (vincolo permanente).

import type { ServiceDetail } from '../services-detail';

export const PERFORMANCE_CWV_SERVICE: ServiceDetail = {
  slug: 'performance-cwv',
  title: 'Performance & Core Web Vitals',
  icon: 'ph-gauge',
  description:
    'Il sito carica lento, su mobile rimbalza, su Google scivola in fondo.\nSistemo LCP, CLS, INP fino a far passare il check.',
  longDescription:
    'Un sito che carica in 6-8 secondi non è un sito lento, è un sito invisibile.\nGoogle da maggio 2021 usa i Core Web Vitals come segnale di ranking: se LCP, CLS e INP non passano la soglia, vai sotto i concorrenti più ordinati.\n\nSu mobile la metà degli utenti se ne va prima ancora di vedere il primo titolo.\nIl problema non è \"comprare un host più caro\": è capire dove il sito spreca millisecondi e tagliare.\n\nHero da 4MB caricato in PNG, font caricati senza preload, JavaScript che blocca il render, layout shift causati da un banner cookie messo male, immagini servite senza optimization.\n\nNiente magia: misuro con Lighthouse + WebPageTest + CrUX, identifico i bottleneck reali, applico i fix, rimisuro.\nSe serve toccare hosting, CDN, cache layer o build pipeline, lo faccio. Il check Google passa o non si chiude. Punto.',
  features: [
    {
      title: 'Audit Lighthouse + WebPageTest + CrUX',
      description:
        'Misurazione su 3 fonti che si incrociano.\nLighthouse per il lab data, WebPageTest per il filmstrip e i waterfall, CrUX per il dato reale degli utenti negli ultimi 28 giorni.\nSolo dopo si tocca il codice.'
    },
    {
      title: 'LCP < 2.5s',
      description:
        'Largest Contentful Paint sotto soglia.\nHero serviti in formato moderno (AVIF/WebP), preload del font display, fetchpriority sul cover, eliminazione del render-blocking CSS.\nPrima si vede il contenuto, poi tutto il resto.'
    },
    {
      title: 'CLS < 0.1',
      description:
        'Niente layout shift fastidioso.\nDimensioni esplicite su ogni immagine e iframe, height riservato per banner cookie e sticky header, font-display swap senza salti.\nIl sito smette di \"saltare\" mentre carica.'
    },
    {
      title: 'INP < 200ms',
      description:
        'Interaction to Next Paint sotto soglia.\nLong task spezzati con yield, eventi pesanti spostati in requestIdleCallback, hydration ottimizzata.\nI click rispondono subito, non dopo aver aspettato un bundle JS da 800KB.'
    },
    {
      title: 'Image + asset pipeline',
      description:
        'Immagini ricodificate in AVIF/WebP con fallback, lazy loading nativo, responsive srcset.\nFont preload solo per i pesi above-the-fold.\nBundle JS analizzato e tree-shaken senza dipendenze morte.\nNiente \"ottimizzazioni segrete\": misurabile e replicabile.'
    },
    {
      title: 'Report before/after',
      description:
        'Snapshot Lighthouse + WebPageTest prima e dopo, con waterfall a confronto e numeri sulle metriche chiave.\nSe non si vede il delta nei dati, il lavoro non è chiuso.\nNiente screenshot decorativi: numeri.'
    }
  ],
  benefits: [
    'Il sito passa il check Core Web Vitals senza compromessi.',
    'Il bounce rate mobile cala perché il primo paint arriva in tempo.',
    'Google smette di penalizzare per Page Experience.',
    'Il TTFB scende sotto 600ms, percepito istantaneo.',
    'Il report è leggibile da chi non è tecnico, con prima/dopo confrontabili.'
  ],
  process: [
    {
      step: 1,
      title: 'Audit baseline',
      description:
        'Misuro lo stato attuale su 5-10 page critiche: home, lista prodotti/lavori, dettaglio, checkout (se e-commerce), landing principale.\nLighthouse + WebPageTest + CrUX.\nIdentifico i bottleneck per metrica.'
    },
    {
      step: 2,
      title: 'Diagnosi prioritaria',
      description:
        'Ordino i fix per impatto/effort.\nLCP è quasi sempre il primo target perché sblocca ranking. CLS e INP arrivano dopo.\nNiente refactor full-stack: solo fix che spostano l\'ago.'
    },
    {
      step: 3,
      title: 'Implementazione fix',
      description:
        'Applico i fix in ordine: image pipeline, font loading, render-blocking cleanup, JavaScript splitting, layout reservation.\nOgni fix viene testato in isolation per evitare regressioni.'
    },
    {
      step: 4,
      title: 'Verifica + re-audit',
      description:
        'Rimisuro su Lighthouse + WebPageTest.\nConfronto i numeri prima/dopo. Se una metrica non passa, identifico perché e itero.\nNiente \"abbiamo fatto del nostro meglio\": il check passa.'
    },
    {
      step: 5,
      title: 'Handoff + monitoring',
      description:
        'Consegna del report con numeri, snapshot delle waterfall, e checklist di manutenzione.\nSetup opzionale di un monitoring continuo (PageSpeed Insights API o equivalente) per intercettare regressioni prima che le veda Google.'
    }
  ],
  faqs: [
    {
      question: 'Quanto tempo serve per far passare il check Core Web Vitals?',
      answer:
        'Dipende da quanto è messo male il sito di partenza.\nUn sito moderno con qualche fix mirato si sistema in 1-2 settimane.\nUn sito legacy con jQuery monolitico, plugin WordPress non aggiornati e immagini PNG da 4MB richiede di più, perché spesso bisogna toccare hosting o build pipeline.\nIl primo audit chiarisce la dimensione reale del lavoro.'
    },
    {
      question: 'Posso farlo senza cambiare hosting?',
      answer:
        'Quasi sempre sì.\nLa maggior parte dei problemi è nel codice e negli asset, non nel server.\nPerò se l\'hosting è condiviso e il TTFB resta sopra 1 secondo anche dopo cache + CDN, l\'unica via è cambiarlo.\nNon vale promettere \"performance miracolose\" su shared hosting da 3€ al mese.'
    },
    {
      question: 'Il mio sito è in WordPress: cambia qualcosa?',
      answer:
        'No, le metriche sono le stesse.\nCambia il toolkit: caching plugin (W3 Total Cache, WP Rocket), image optimizer, query optimization su WP_Query, eventuale migrazione a hosting WP-tuned.\nPer casi più gravi, segnalo migrazione headless o CMS alternativo, ma è raro.'
    },
    {
      question: 'Garantisci che il check passi sempre?',
      answer:
        'No, e chi lo garantisce mente.\nGarantisco di applicare le best practice misurabili e di documentare ogni fix con before/after.\nSu siti molto grandi o con vincoli (terze parti, tracking pesanti, embed video) qualche metrica può restare borderline.\nIn quel caso lo dico subito, non a fine progetto.'
    },
    {
      question: 'Cosa succede se cambio sito dopo l\'ottimizzazione?',
      answer:
        'Senza manutenzione, le metriche tornano a degradare nel giro di mesi: nuovi plugin, foto non ottimizzate, script di tracking aggiunti.\nPer questo consegno una checklist operativa e, se serve, un retainer di monitoring trimestrale.'
    },
    {
      question: 'Lavori solo su sito-v3 / Next.js o anche su altri stack?',
      answer:
        'Lavoro su qualsiasi stack: WordPress, Shopify, Webflow, custom React/Vue/Next, statici Hugo/Astro.\nIl principio non cambia: misuro, identifico, fixo, rimisuro.\nIl toolkit cambia, le metriche restano LCP, CLS, INP.'
    }
  ],
  awareness: {
    title: 'Un sito lento è un sito invisibile',
    subtitle:
      'Google penalizza i siti che falliscono il check Core Web Vitals.\nMobile è dove succede tutto: se il primo paint arriva in 4 secondi, gli utenti se ne vanno.',
    problems: [
      {
        icon: 'ph-clock-countdown',
        title: 'Hero che impiega 6 secondi',
        desc: 'Immagine cover servita in PNG da 3-4MB, senza fetchpriority, dietro un banner cookie che blocca il render.\nLCP fuori soglia, primi visitatori già rimbalzati prima di vedere il titolo.'
      },
      {
        icon: 'ph-arrows-vertical',
        title: 'Layout che salta mentre leggi',
        desc: 'Banner cookie senza altezza riservata, hero senza dimensioni esplicite, font che cambiano peso a metà render.\nCLS oltre 0.25, l\'utente clicca dove non voleva e il sito perde fiducia immediatamente.'
      },
      {
        icon: 'ph-spinner-gap',
        title: 'Click che rispondono dopo 1 secondo',
        desc: 'JavaScript bloccante, hydration in un blocco unico, listener che fanno layout reflow.\nINP oltre 500ms.\nL\'utente preme \"Aggiungi al carrello\" due volte perché il primo click sembra ignorato.'
      }
    ]
  },
  expandedScope: {
    eyebrow: 'POST-AUDIT',
    title: 'Le performance non sono un fix una tantum',
    body:
      'Il check Core Web Vitals oggi è verde.\nIl prossimo deploy arriva con un\'altra immagine pesante, un nuovo plugin di tracking, un embed video aggiunto al volo.\nSenza un monitoring continuo, le metriche degradano in mesi.\n\nPer questo dopo l\'audit consegno una checklist operativa: cosa controllare prima di pubblicare ogni nuova pagina, come ottimizzare le immagini in autonomia, quando rifare un re-audit.\n\nPer i siti con traffico significativo o e-commerce critico, attivo un monitoring trimestrale: PageSpeed Insights API + alert su regressioni reali.\nNiente dashboard fumose: solo i numeri che servono per intervenire prima che li veda Google.'
  }
};
