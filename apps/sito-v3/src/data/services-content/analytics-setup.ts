// Service detail — Analytics + Tag Manager (standalone, fuori matrice).
// Voice aggressive vs setup di analytics rotti, GA4 senza eventi, dashboard inutili.
// Niente prezzi pubblici (vincolo permanente).

import type { ServiceDetail } from '../services-detail';

export const ANALYTICS_SETUP_SERVICE: ServiceDetail = {
  slug: 'analytics-setup',
  title: 'Analytics & Tag Manager',
  icon: 'ph-chart-line-up',
  description:
    'Hai un sito ma non sai chi compra, chi rimbalza, da dove vengono.\nSetup GA4 + GTM corretto, eventi conversione tracciati, dashboard letta in 5 minuti.',
  longDescription:
    'Universal Analytics è morto da luglio 2023.\nLa maggior parte dei siti ha \"qualcosa\" su GA4: un setup di default importato male, eventi non configurati, conversioni che non si triggerano, consent mode mancante.\nRisultato: ogni mese guardi numeri che non significano niente.\n\nQuanti hanno aggiunto al carrello? Quanti hanno completato il form? Quale traffic source converte davvero?\nSenza un setup serio, il sito è una scatola nera.\n\nNon serve installare 30 tag: serve un GA4 property pulito, un GTM container ordinato, gli eventi giusti per il tuo business model (e-commerce, lead gen, content, SaaS), Consent Mode v2 per non rompere il tracking e restare GDPR-compliant, una dashboard Looker Studio che si legge in 5 minuti senza aprire 12 schermate.\n\nConfiguro tutto, documento ogni evento, ti insegno cosa guardare.\nNiente \"report executive\" decorativi: solo i numeri che ti permettono di decidere se cambiare il sito, l\'ad, il funnel.',
  features: [
    {
      title: 'GA4 property pulito',
      description:
        'Property nuova o cleanup di una esistente: data stream configurato, internal traffic filter, cross-domain tracking se serve, debug mode, retention impostato a 14 mesi (massimo non-paid).\nNiente account \"enhanced ecommerce\" con 50 eventi disattivati di default.'
    },
    {
      title: 'GTM container ordinato',
      description:
        'Tag Manager con folder logici per tipo (analytics, ads, conversion API), naming convention chiaro (TY1-Pageview, AY2-Click-CTA, EY3-Form-Submit), trigger riusabili, variables centralizzate.\nChi entra dopo capisce la logica in 10 minuti, non dopo 2 settimane.'
    },
    {
      title: 'Eventi conversione che servono',
      description:
        'Eventi specifici al tuo business: e-commerce (view_item, add_to_cart, begin_checkout, purchase), lead gen (form_submit, phone_click, whatsapp_click), content (scroll_depth, video_engagement).\nNiente evento \"click\" generico che non dice nulla.'
    },
    {
      title: 'Consent Mode v2 (GDPR)',
      description:
        'Integrazione Cookiebot / Iubenda / banner custom con Consent Mode v2 di Google.\nTracking attivo con dati aggregati anche prima del consenso (modeled conversions), pieno tracking dopo accept.\nNiente \"tracking spento sotto banner\" che ti fa perdere il 40% dei dati.'
    },
    {
      title: 'Dashboard Looker Studio',
      description:
        'Dashboard personalizzata che mostra solo quello che conta: traffic source per conversione, funnel checkout/lead, pagine top-performing, ricerche on-site, dispositivo + zona.\nSingle page leggibile in 5 minuti, refresh quotidiano, accesso condiviso con il team.'
    },
    {
      title: 'Documentazione + handoff',
      description:
        'Spreadsheet con ogni evento tracciato: nome, trigger, variable, business meaning, dove viene letto.\nPiù una guida \"5 numeri da controllare ogni lunedì\".\nSe cambi consulente o ne aggiungi uno, riprende da dove ho lasciato senza reverse engineering.'
    }
  ],
  benefits: [
    'Sai chi converte, da dove arriva, cosa funziona davvero.',
    'GA4 + GTM ordinati, riusabili, mantenibili anche dopo il mio handoff.',
    'Consent Mode v2 attivo: GDPR-compliant senza perdere il tracking modeled.',
    'Dashboard Looker Studio leggibile in 5 minuti, condivisa col team.',
    'Documentazione che evita \"ma cosa fa questo evento?\" nei mesi successivi.'
  ],
  process: [
    {
      step: 1,
      title: 'Audit setup attuale',
      description:
        'Verifico GA4 esistente (se c\'è): tag duplicati, eventi spam, filtri sbagliati, conversioni rotte.\nIdentifico cosa salvare e cosa ricostruire.\nSpesso conviene partire da zero su GTM, mantenere GA4 property e ripulirla.'
    },
    {
      step: 2,
      title: 'Mappa eventi business-driven',
      description:
        'Sessione 30 minuti per capire cosa conta per te: macro-conversioni (purchase, lead form), micro-conversioni (add_to_cart, scroll 75%, time on key page), traffic sources critici.\nMappa eventi prima di toccare codice.'
    },
    {
      step: 3,
      title: 'Implementazione GTM + GA4',
      description:
        'Setup container GTM, configurazione tag analytics + Google Ads conversion + Meta CAPI (se serve), variables condivise, trigger sui touchpoint mappati.\nTest in preview mode per ogni evento.\nNiente push in production senza preview check.'
    },
    {
      step: 4,
      title: 'Consent Mode + GDPR',
      description:
        'Integrazione banner cookie con Consent Mode v2.\nTest che senza consenso i dati arrivano in modeled mode (Google ricostruisce le conversioni mancanti).\nTest che con consenso pieno tutto si attiva. Verifica con DebugView GA4.'
    },
    {
      step: 5,
      title: 'Dashboard + documentation + handoff',
      description:
        'Dashboard Looker Studio configurata sui KPI mappati.\nSpreadsheet di documentazione completo.\nSessione handoff 30 minuti per spiegarti come leggere la dashboard e quali numeri usare per decidere.\nNiente \"rimani da solo dopo\".'
    }
  ],
  faqs: [
    {
      question: 'Universal Analytics è ancora utile?',
      answer:
        'No, è dismesso da luglio 2023.\nI dati storici UA sono ancora consultabili fino al 1° luglio 2024 (ora 2026 sono già stati cancellati nei property gratuiti).\nSe ti dicono \"manteniamo Universal Analytics\", scappa. Si lavora solo su GA4.'
    },
    {
      question: 'Devo per forza usare GTM o posso mettere il codice GA4 nel sito?',
      answer:
        'Tecnicamente puoi, ma è una pessima idea.\nSenza GTM ogni nuovo evento richiede modifica del codice + deploy.\nCon GTM aggiungi un evento in 5 minuti senza toccare il sito.\nInoltre GTM gestisce in modo unificato Google Ads conversion, Meta Pixel, LinkedIn Insight, qualunque cosa serva per le ads. È lo standard.'
    },
    {
      question: 'Consent Mode v2 è davvero obbligatorio?',
      answer:
        'Per chi fa Google Ads in EEA + UK, sì, dal 6 marzo 2024.\nSenza Consent Mode v2 le campagne Google Ads non vedono le conversioni e l\'ottimizzazione automatica degrada.\nPer chi non fa Google Ads ma usa solo GA4, non è strettamente \"obbligatorio\", ma è la prassi GDPR-compliant corretta. Lo configuro sempre.'
    },
    {
      question: 'La dashboard Looker Studio è inclusa o costa a parte?',
      answer:
        'Inclusa nel setup.\nLooker Studio (ex Data Studio) è gratuito e si connette nativamente a GA4.\nLa dashboard è personalizzata sui tuoi KPI: e-commerce avrà funnel checkout, lead gen avrà funnel form + traffic source, content avrà scroll depth + time on page. Single page leggibile.'
    },
    {
      question: 'Posso integrare Meta Pixel, TikTok Ads, LinkedIn Insight?',
      answer:
        'Sì, tutto via GTM.\nSetup di Meta Pixel + Conversion API (server-side per superare iOS 14.5 e ad blocker) è incluso se serve.\nTikTok Pixel, LinkedIn Insight, Pinterest, Reddit Ads: tutti gestiti via GTM con consent gating.\nNiente codice diretto nel sito.'
    },
    {
      question: 'Cosa succede dopo l\'handoff? Se voglio aggiungere un evento?',
      answer:
        'Hai accesso amministratore al GTM container e al GA4 property.\nLa documentazione spiega come duplicare un trigger esistente per aggiungere un evento simile.\nPer cambiamenti più grossi (nuovo funnel, nuovo dominio, integrazione CRM) posso fare un retainer trimestrale, oppure intervento on-demand.'
    }
  ],
  awareness: {
    title: 'Senza analytics serio, decidi a sentimento',
    subtitle:
      'Un GA4 di default importato male è peggio di niente: ti dà numeri sbagliati e ti fa prendere decisioni sbagliate.\nServono setup pulito, eventi business-driven, consent gestito.',
    problems: [
      {
        icon: 'ph-warning-circle',
        title: 'GA4 di default',
        desc: 'Property creata in 5 minuti senza configurazione, retention 2 mesi (massimo default), zero filtri internal traffic, zero eventi custom.\nVedi \"pageview\" e basta.\nQuando il marketing chiede \"quale ad converte?\", silenzio.'
      },
      {
        icon: 'ph-cookie',
        title: 'Banner cookie che spegne tutto',
        desc: 'Banner installato male: senza consenso, GTM non parte, GA4 non riceve niente, Google Ads non vede conversioni.\nRisultato: il 40-60% dei visitatori UE (che cliccano \"rifiuta\") non viene tracciato per niente.\nModeled conversions mai attivate.'
      },
      {
        icon: 'ph-clipboard-text',
        title: 'Eventi non documentati',
        desc: 'Container GTM con 47 tag, naming random (\"tag_2024_test\", \"click-ok\"), nessun owner.\nChi entra dopo passa 3 settimane a capire cosa fa cosa.\nSpesso il setup viene rifatto da zero perché è più veloce che reverse engineering.'
      }
    ]
  },
  expandedScope: {
    eyebrow: 'POST-SETUP',
    title: 'Analytics serve per decidere, non per riempire dashboard',
    body:
      'GA4 + GTM configurati, dashboard in piedi. Ora il punto è usarli.\nOgni mese (o trimestre se sei piccolo) si guarda: cosa converte, cosa rimbalza, dove perdi soldi nel funnel.\nLe decisioni dipendono dai numeri, non dal sentimento.\n\nSenza un check periodico, la dashboard diventa decorazione e il setup degrada (nuovi tag aggiunti senza naming, eventi duplicati, Consent Mode rotto da un update del banner).\n\nPer i siti con investimento in ads o e-commerce significativo, attivo un retainer trimestrale: review della dashboard, identificazione delle 3 leve più impattanti, action plan operativo.\nNiente \"siamo crescuti del 12%\": serve sapere perché, dove, cosa fare ora.'
  }
};
