// Service detail — Accessibilità WCAG 2.1 AA (standalone, fuori matrice).
// Driven da European Accessibility Act in vigore dal 28 giugno 2025.
// Voice aggressive vs siti che ignorano accessibilità + agenzie che la "dimenticano".
// Niente prezzi pubblici (vincolo permanente).

import type { ServiceDetail } from '../services-detail';

export const ACCESSIBILITY_WCAG_SERVICE: ServiceDetail = {
  slug: 'accessibility-wcag',
  title: 'Accessibilità WCAG',
  icon: 'ph-wheelchair',
  description:
    'Dal 28 giugno 2025 il European Accessibility Act è in vigore.\nSe vendi online, il sito deve essere accessibile o paghi multe.\nAudit WCAG 2.1 AA + remediation.',
  longDescription:
    'L\'European Accessibility Act (EAA, direttiva UE 2019/882, recepita in Italia col D.Lgs. 82/2022) è obbligatorio dal 28 giugno 2025 per chiunque venda online a consumatori europei: e-commerce, banche, telecom, trasporti, e-book, servizi digitali.\nLe sanzioni in Italia arrivano fino a 40.000€ per violazione e includono possibili ordini di rimozione del sito.\n\nIl problema non è \"aggiungere un widget di accessibilità\" — quei plugin sono cosmetici e non risolvono niente.\nServe audit serio: navigazione da tastiera, screen reader (NVDA + VoiceOver), contrasto colore, semantica HTML, ARIA dove necessario, focus management, alternative testuali, form errori dichiarati.\n\nMisuro con tool automatici (axe DevTools, Lighthouse) e manualmente con NVDA su Chrome/Firefox e VoiceOver su Safari.\nIdentifico le violazioni reali, le ordino per priorità (Level A blocking, Level AA mandatory, Level AAA opzionale), applico i fix, rilascio l\'accessibility statement pubblicabile.\n\nNiente \"siamo conformi al 100%\", quella è una bugia.\nConformità WCAG 2.1 AA misurabile e dichiarata.',
  features: [
    {
      title: 'Audit screen reader reale',
      description:
        'Navigo il sito con NVDA su Chrome/Firefox e VoiceOver su Safari/macOS.\nIdentifico landmark mancanti, heading non gerarchici, link \"leggi tutto\" senza contesto, form senza label associate.\nTool automatici prendono il 30% delle violazioni. Il resto si trova solo usando lo screen reader davvero.'
    },
    {
      title: 'Keyboard navigation completa',
      description:
        'Verifico che ogni interazione sia raggiungibile da tastiera: menu, modali, dropdown, carosello, accordion.\nTab order coerente, focus visibile, escape che chiude modal, frecce che scorrono i tab.\nNiente trap che bloccano l\'utente in un overlay senza via d\'uscita.'
    },
    {
      title: 'Contrast + color check',
      description:
        'Misuro il contrast ratio di ogni combinazione testo/sfondo.\nSoglia WCAG AA: 4.5:1 per testo normale, 3:1 per testo grande.\nIdentifico testi grigi su fondi chiari che falliscono il check. Verifico anche stati hover, disabled, error, focus.'
    },
    {
      title: 'Semantic HTML + ARIA',
      description:
        'Sostituisco div generici con tag semantici (nav, main, article, aside, section, button vs link).\nAggiungo ARIA solo dove HTML semantico non basta (es. tab list, listbox, dialog).\nNiente ARIA \"preventivo\": ogni attributo ha un motivo testato con screen reader.'
    },
    {
      title: 'Form errors dichiarati',
      description:
        'Errori di validazione legati al campo via aria-describedby, annunciati da screen reader, visibili senza dipendere solo dal colore (icona + testo).\nSubmit che lancia un summary con focus management, campi required marcati nei messaggi di errore.'
    },
    {
      title: 'Accessibility statement pubblicabile',
      description:
        'Documento conforme all\'art. 32 del D.Lgs. 82/2022 e al Codex AGID: livello di conformità raggiunto, eventuali contenuti non accessibili, motivazione, alternative offerte, contatti per segnalazioni, data di pubblicazione.\nPronto per essere linkato dal footer.'
    }
  ],
  benefits: [
    'Il sito rispetta l\'European Accessibility Act, niente sanzioni a sorpresa.',
    'Gli utenti con disabilità (15% della popolazione) possono usare il sito davvero.',
    'Google migliora il ranking SEO: accessibility e crawlabilità si rinforzano a vicenda.',
    'L\'accessibility statement è linkabile dal footer e dimostra compliance.',
    'Il sito è auditabile da terze parti senza paura.'
  ],
  process: [
    {
      step: 1,
      title: 'Audit automatico + manuale',
      description:
        'Scan con axe DevTools, WAVE, Lighthouse su 5-10 page tipo (home, lista, dettaglio, form, checkout).\nPoi audit manuale con NVDA + VoiceOver.\nLe violazioni reali emergono solo unendo i due strati.'
    },
    {
      step: 2,
      title: 'Report + prioritizzazione',
      description:
        'Mappa delle violazioni divise per Level (A blocking, AA mandatory).\nPer ognuna: come riprodurla, perché viola WCAG 2.1, criterio specifico (es. SC 1.4.3 Contrast Minimum), fix proposto.\nNiente lista da 200 voci alfabetiche: priorità.'
    },
    {
      step: 3,
      title: 'Remediation prioritaria',
      description:
        'Applico i fix in ordine di severity.\nLevel A prima (blocking — sito non utilizzabile da chi ha disabilità).\nLevel AA dopo (mandatory per EAA compliance).\nLevel AAA opzionale, valutato caso per caso.'
    },
    {
      step: 4,
      title: 'Re-audit + verifica',
      description:
        'Riscan automatico + ri-test manuale con screen reader. Confronto pre/post.\nSe una violazione resta, decisione documentata: fixata, accettata con alternative, deferred a Phase 2 con motivazione.\nNiente \"abbiamo fatto del nostro meglio\".'
    },
    {
      step: 5,
      title: 'Statement + handoff',
      description:
        'Redazione dell\'accessibility statement conforme.\nChecklist operativa per il team che gestisce il sito dopo: come verificare un nuovo contenuto, come scrivere alternative testuali sensate, come testare prima di pubblicare.\nIl sito resta accessibile anche dopo il mio handoff.'
    }
  ],
  faqs: [
    {
      question: 'Il mio sito è davvero obbligato a essere accessibile?',
      answer:
        'Se vendi prodotti o servizi online a consumatori europei (e-commerce, banche, telecom, trasporti, e-book), sì, dal 28 giugno 2025.\nLa direttiva EAA include anche servizi digitali e contenuti audiovisivi.\nLe micro-imprese (meno di 10 dipendenti e fatturato sotto 2M€) hanno alcune esenzioni, ma la sicurezza è chiedere a un consulente specifico o farti l\'audit per stare tranquillo.'
    },
    {
      question: 'I plugin \"accessibility widget\" non bastano?',
      answer:
        'No, e in molti casi peggiorano la situazione.\nQuei widget sovrappongono uno strato JS che cambia colori, font, contrasto al volo, ma non sistemano la struttura HTML, la semantica, i form senza label, le immagini senza alt.\nLo screen reader non li capisce. La Federal Trade Commission USA e diverse cause europee li considerano \"compliance-washing\".\nServono audit veri e fix nel codice.'
    },
    {
      question: 'Quanto tempo serve per arrivare a WCAG 2.1 AA?',
      answer:
        'Dipende dalla dimensione del sito e da quanto è messo male.\nUn sito vetrina pulito si sistema in 2-3 settimane.\nUn e-commerce complesso con checkout, filtri, account area, può richiedere 6-10 settimane perché ogni flusso va testato.\nIl primo audit chiarisce la dimensione reale.'
    },
    {
      question: 'Cosa succede se non rispetto l\'EAA?',
      answer:
        'In Italia (D.Lgs. 82/2022 e successivi) le sanzioni amministrative arrivano fino a 40.000€ per singola violazione, con possibili ordini di rimozione del servizio.\nAGID e gli enti consumatori possono ricevere segnalazioni e aprire procedimenti.\nPiù che le multe, il rischio reale è perdere fiducia: una segnalazione pubblica per inaccessibilità è marketing inverso.'
    },
    {
      question: 'L\'accessibilità rallenta o complica il sito?',
      answer:
        'No, di solito lo migliora.\nSemantica HTML pulita, immagini con alt, form con label associate sono anche best practice SEO. Google indicizza meglio i siti accessibili.\nLe performance non cambiano: nessun fix accessibility introduce JavaScript pesante.\nAnzi, spesso si rimuovono codici \"creativi\" che erano sia inaccessibili che inefficienti.'
    },
    {
      question: 'Posso mantenere il design attuale?',
      answer:
        'Quasi sempre sì.\nIl 90% dei fix sono nel codice (semantica, ARIA, focus, alt) e invisibili agli utenti senza disabilità.\nLe uniche modifiche visibili possono essere: aumento del contrasto su testi grigi, focus visibile più marcato, alternative ai colori come unico segnale di stato.\nNiente di drammatico.'
    }
  ],
  awareness: {
    title: 'Accessibility-washing è già illegale',
    subtitle:
      'I widget di accessibilità non risolvono niente.\nWCAG 2.1 AA si raggiunge nel codice, non con uno script aggiunto al footer.',
    problems: [
      {
        icon: 'ph-prohibit',
        title: 'Widget cosmetico',
        desc: 'Plugin che aggiunge un\'icona \"accessibility\" con toggle font/contrasto/cursore.\nNon sistema niente di sostanziale, e diversi tribunali lo considerano compliance-washing.\nLo screen reader continua a non capire la pagina.'
      },
      {
        icon: 'ph-warning-circle',
        title: 'Form non navigabile',
        desc: 'Campi senza label associate, errori di validazione mostrati solo in rosso, submit che non annuncia successo o fallimento.\nChi usa NVDA non capisce cosa è andato storto e lascia perdere.'
      },
      {
        icon: 'ph-eye-slash',
        title: 'Contrasto fuori soglia',
        desc: 'Testi grigi 999 su sfondo bianco, badge \"soft pastel\" con contrast ratio 2.5:1, link blu chiaro indistinguibili dal testo nero.\nChi ha bassa visione abbandona, e WCAG AA chiede 4.5:1 minimo.'
      }
    ]
  },
  expandedScope: {
    eyebrow: 'POST-AUDIT',
    title: 'L\'accessibilità non si \"mantiene\", si presidia',
    body:
      'Il sito oggi è WCAG 2.1 AA. Il prossimo articolo del blog viene pubblicato con un\'immagine senza alt, una landing nuova arriva con un form senza label, un component di terze parti rompe la navigazione da tastiera.\nSenza presidio, il livello di conformità decresce in mesi.\n\nPer questo dopo l\'audit consegno una checklist operativa per chi pubblica contenuti (cosa controllare prima di mettere online un articolo o una page) e, dove serve, attivo un retainer trimestrale di re-audit per intercettare le regressioni.\n\nL\'accessibility statement non è un documento da archiviare: va aggiornato quando il sito cambia.\nNiente compliance \"una volta e via\": presidio continuo, leggero, misurabile.'
  }
};
