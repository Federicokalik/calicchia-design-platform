// Professions data for SEO landing pages
// Pattern: /sito-web-per-{profession}-a-{city}
// Content per category follows marketing-friendly tone (tu diretto, caldo, onesto)

export interface SeoProfession {
  slug: string;
  label: string;
  categoryId: string;
  /** Priority tier: 1 = MVP (index), 2 = expansion (index), 3 = long-tail (noindex until reviewed) */
  tier: 1 | 2 | 3;
}

export interface CategoryProblem {
  icon: string;
  title: string;
  desc: string;
}

export interface CategoryFeature {
  title: string;
  description: string;
}

export interface CategoryFaq {
  question: string;
  answer: string;
}

export interface ProfessionCategory {
  id: string;
  label: string;
  description: string; // intro paragraph for the category
  problems: CategoryProblem[];
  features: CategoryFeature[];
  faqs: CategoryFaq[];
  ctaText: string;
}

// ─── CATEGORIES ───────────────────────────────

export const PROFESSION_CATEGORIES: Record<string, ProfessionCategory> = {
  'beauty-wellness': {
    id: 'beauty-wellness',
    label: 'Beauty & Wellness',
    description: 'Nel mondo della bellezza e del benessere, la prima impressione conta — e oggi quella prima impressione avviene online.\nI tuoi clienti cercano su Google prima di prenotare. Se non ti trovano, prenotano da qualcun altro.',
    problems: [
      { icon: 'ph-instagram-logo', title: 'Instagram non basta', desc: 'Hai un profilo curato ma i contatti non arrivano?\nI social da soli non bastano: ti serve una base solida, un sito tuo, che non dipenda dall\'algoritmo.' },
      { icon: 'ph-calendar-blank', title: 'Zero prenotazioni dal web', desc: 'I clienti vogliono prenotare dal telefono, in 30 secondi.\nSe non possono farlo dal tuo sito, vanno da chi glielo permette.' },
      { icon: 'ph-magnifying-glass', title: 'Invisibile su Google', desc: 'Qualcuno cerca "parrucchiere vicino a me" e tu non compari?\nStai regalando clienti alla concorrenza ogni giorno.' },
    ],
    features: [
      { title: 'Sito vetrina con galleria lavori', description: 'Mostra i tuoi lavori migliori con foto prima/dopo che parlano da sole.\nI clienti vogliono vedere cosa sai fare.' },
      { title: 'Prenotazione online o WhatsApp', description: 'Un bottone per prenotare subito — via form, via WhatsApp, o integrato con il tuo gestionale.\nComodo per te, comodo per loro.' },
      { title: 'SEO locale', description: 'Ti faccio trovare su Google quando le persone cercano il tuo servizio nella tua zona.\nRisultati reali, non promesse.' },
      { title: 'Integrazione social', description: 'Il tuo feed Instagram direttamente nel sito.\nI tuoi lavori sempre visibili, senza che il cliente debba cercarli.' },
      { title: 'Google Business ottimizzato', description: 'Scheda Google completa, con foto, orari, recensioni e link al sito.\nCosì compari anche su Google Maps.' },
    ],
    faqs: [
      { question: 'Ma mi serve davvero un sito se ho già Instagram?', answer: 'Sì. Instagram è uno strumento in affitto — può cambiare le regole domani.\nIl sito è tuo, lo controlli tu, e ti fa trovare su Google.\nSono due cose che lavorano insieme, non una al posto dell\'altra.' },
      { question: 'Quanto costa un sito per il mio settore?', answer: 'Un sito vetrina parte da €790.\nCon prenotazione online e galleria lavori siamo intorno ai €1.490.\nTi faccio un preventivo su misura dopo una chiacchierata.' },
      { question: 'Posso gestire il sito da solo?', answer: 'Certo. Ti insegno a cambiare foto, aggiungere servizi e aggiornare i prezzi.\nE se ti blocchi, mi scrivi.' },
      { question: 'Quanto tempo ci vuole?', answer: 'Un sito vetrina: 10-15 giorni lavorativi.\nCon funzionalità extra (prenotazione, e-commerce prodotti): fino a 30 giorni.' },
      { question: 'Il sito mi aiuterà ad avere più clienti?', answer: 'Se fatto bene, sì.\nUn sito ottimizzato per la tua zona ti fa trovare da chi sta già cercando quello che offri.\nNon è magia — è strategia.' },
    ],
    ctaText: 'Vuoi che i tuoi prossimi clienti ti trovino online?',
  },

  'sanita-salute': {
    id: 'sanita-salute',
    label: 'Sanità e Salute',
    description: 'Per un professionista della salute, il sito web non è un vezzo — è uno strumento di fiducia.\nI pazienti cercano online, leggono, confrontano.\nChi ha un sito chiaro e professionale parte in vantaggio.',
    problems: [
      { icon: 'ph-magnifying-glass', title: 'I pazienti non ti trovano', desc: 'Cercano "dentista a [città]" e trovano i tuoi colleghi.\nSe non hai un sito ottimizzato, sei invisibile proprio quando ti cercano.' },
      { icon: 'ph-phone-disconnect', title: 'Troppi contatti persi', desc: 'Telefono occupato, segreteria piena, orari chiusi.\nSenza un modo per contattarti online, i pazienti rinunciano.' },
      { icon: 'ph-warning-circle', title: 'Immagine non aggiornata', desc: 'Un sito vecchio o assente non comunica professionalità.\nI pazienti vogliono sentirsi in mani sicure — anche dal sito.' },
    ],
    features: [
      { title: 'Presentazione professionale', description: 'Chi sei, cosa fai, dove lavori, le tue specializzazioni.\nTutto chiaro, tutto leggibile, tutto al posto giusto.' },
      { title: 'Sistema di contatto/prenotazione', description: 'Form di contatto, richiesta appuntamento o integrazione con il tuo gestionale.\nI pazienti ti raggiungono quando vogliono.' },
      { title: 'Pagine trattamenti', description: 'Ogni servizio spiegato in modo chiaro e accessibile — senza gergo, senza paura.\nI pazienti arrivano già informati.' },
      { title: 'SEO medico locale', description: 'Ottimizzazione per le ricerche nella tua zona.\n"Fisioterapista a [città]" porta al tuo sito, non a quello del competitor.' },
      { title: 'Conformità deontologica', description: 'Il sito rispetta le regole del tuo ordine professionale.\nNessuna comunicazione fuorviante, nessun rischio.' },
    ],
    faqs: [
      { question: 'Il sito rispetta le regole del mio ordine?', answer: 'Sì. Conosco le linee guida deontologiche per medici, dentisti, psicologi e altre professioni sanitarie.\nIl sito viene costruito in conformità.' },
      { question: 'Posso mostrare prezzi e tariffe?', answer: 'Dipende dal tuo ordine professionale.\nIn molti casi puoi indicare fasce di prezzo o invitare a richiedere un preventivo.\nNe parliamo insieme.' },
      { question: 'Serve la prenotazione online?', answer: 'Non è obbligatoria, ma fa la differenza.\nUn form di contatto semplice o l\'integrazione con il tuo gestionale riduce le chiamate e ti fa risparmiare tempo.' },
      { question: 'Quanto costa?', answer: 'Un sito professionale per il settore sanitario parte da €790 (vetrina) a €1.490+ (con prenotazione e pagine dedicate ai trattamenti).' },
      { question: 'Posso aggiornarlo da solo?', answer: 'Sì. Ti lascio un pannello semplice per modificare testi e foto.\nPer cambiamenti strutturali, ci sono io.' },
    ],
    ctaText: 'Vuoi che i tuoi pazienti ti trovino facilmente online?',
  },

  'studi-professionali': {
    id: 'studi-professionali',
    label: 'Studi Professionali',
    description: 'Avvocati, commercialisti, consulenti: il passaparola funziona ancora, ma oggi passa anche da Google.\nChi cerca un professionista, cerca online. E si aspetta di trovare un sito serio, chiaro, aggiornato.',
    problems: [
      { icon: 'ph-user-circle', title: 'Nessuna presenza online', desc: 'Sei un ottimo professionista ma online non esisti?\nI potenziali clienti ti cercano, non ti trovano, e vanno da qualcun altro.' },
      { icon: 'ph-scales', title: 'Sito generico e datato', desc: 'Un sito fatto anni fa, con testi generici e un design vecchio, non comunica la competenza che hai.\nAnzi, rischia di allontanare.' },
      { icon: 'ph-chart-line-down', title: 'Nessuna generazione di contatti', desc: 'Il sito c\'è ma non ricevi mai richieste?\nProbabilmente non è pensato per convertire. È un biglietto da visita statico, non uno strumento attivo.' },
    ],
    features: [
      { title: 'Presentazione dello studio', description: 'Chi siete, cosa fate, come lavorate. Tutto raccontato in modo professionale ma accessibile — non un muro di legalese.' },
      { title: 'Aree di competenza', description: 'Ogni servizio ha la sua pagina, con spiegazioni chiare. Chi vi trova sa subito se potete aiutarlo.' },
      { title: 'Sistema di contatto strutturato', description: 'Form intelligenti che raccolgono le informazioni giuste. Così rispondete già preparati e il cliente si sente preso sul serio.' },
      { title: 'SEO professionale locale', description: 'Vi faccio trovare per le ricerche nella vostra città. "Avvocato divorzista a [città]" porta al vostro sito.' },
      { title: 'Blog e risorse', description: 'Articoli che mostrano la vostra competenza e che Google adora. Autorità online che si traduce in fiducia offline.' },
    ],
    faqs: [
      { question: 'Serve davvero un sito per uno studio professionale?', answer: 'Sì. Anche se lavori col passaparola, la prima cosa che fa un potenziale cliente è cercarti su Google.\nSe non trova niente (o trova un sito vecchio), l\'impressione è negativa.' },
      { question: 'Posso mostrare i casi trattati?', answer: 'Puoi parlare delle tue aree di competenza e dei risultati ottenuti in termini generali, nel rispetto del segreto professionale.\nTi aiuto a trovare il modo giusto.' },
      { question: 'Quanto costa un sito per uno studio?', answer: 'Un sito professionale parte da €790.\nPer studi più strutturati con blog, area riservata o più professionisti: da €1.490 in su.' },
      { question: 'Chi scrive i testi?', answer: 'Posso aiutarti a scriverli o riscrivere quelli che hai.\nL\'importante è che suonino professionali senza essere incomprensibili.' },
      { question: 'Funziona anche per studi piccoli?', answer: 'Soprattutto per studi piccoli. Un sito ben fatto livella il campo: comunichi la stessa professionalità di uno studio grande.' },
    ],
    ctaText: 'Vuoi che il tuo studio si faccia trovare online?',
  },

  'casa-edilizia': {
    id: 'casa-edilizia',
    label: 'Casa, Impianti e Edilizia',
    description: 'Idraulici, elettricisti, imprese edili: quando qualcuno ha un problema in casa, cerca online.\nSe non ti trova, chiama qualcun altro.\nUn sito semplice e ben fatto cambia tutto.',
    problems: [
      { icon: 'ph-phone', title: 'Solo passaparola', desc: 'Il passaparola è ottimo ma ha un limite: non scala.\nUn sito ti rende visibile a chiunque cerchi il tuo servizio nella tua zona.' },
      { icon: 'ph-magnifying-glass', title: 'Invisibile sulle emergenze', desc: '"Idraulico urgente [città]" — se non compari su Google per queste ricerche, stai perdendo i lavori più pagati.' },
      { icon: 'ph-image', title: 'Nessuna prova dei tuoi lavori', desc: 'Sai fare un ottimo lavoro ma non lo mostri?\nSenza un portfolio online, i clienti non hanno modo di fidarsi prima di chiamarti.' },
    ],
    features: [
      { title: 'Sito vetrina con portfolio', description: 'I tuoi lavori migliori in bella mostra: prima e dopo, tipologie di intervento, zone servite.\nLe foto parlano più di mille parole.' },
      { title: 'Contatto diretto', description: 'Bottone "Chiama ora", form di richiesta preventivo, WhatsApp.\nIl cliente ti raggiunge nel modo che preferisce.' },
      { title: 'SEO locale per emergenze', description: 'Compari quando cercano il tuo servizio nella tua zona — anche per le ricerche urgenti.\nI lavori più urgenti pagano meglio.' },
      { title: 'Zone servite', description: 'Mappa chiara delle zone opera.\nIl cliente sa subito se puoi raggiungerlo.' },
      { title: 'Recensioni e referenze', description: 'Le opinioni dei clienti soddisfatti direttamente sul sito.\nLa prova sociale più potente che esista.' },
    ],
    faqs: [
      { question: 'Ma a un artigiano serve davvero un sito?', answer: 'Sì, eccome. Le persone cercano su Google anche l\'idraulico.\nChi ha un sito (anche semplice) prende i lavori che chi non ce l\'ha perde.' },
      { question: 'Quanto costa?', answer: 'Un sito vetrina con portfolio e contatto diretto parte da €790.\nSemplice, efficace, pronto in 10-15 giorni.' },
      { question: 'Non sono bravo con il computer...', answer: 'Nessun problema. Io creo il sito, ti spiego come funziona in parole semplici, e se hai bisogno di aggiornamenti ci penso io.' },
      { question: 'Come faccio a farmi trovare nella mia zona?', answer: 'Ottimizzazione SEO locale + scheda Google Business.\nTi faccio comparire quando cercano il tuo servizio nella tua città.' },
      { question: 'Posso mostrare i miei lavori?', answer: 'Certo, e ti consiglio di farlo. Una galleria con foto dei tuoi interventi vale più di qualsiasi descrizione.' },
    ],
    ctaText: 'Vuoi che i clienti nella tua zona ti trovino su Google?',
  },

  'auto-mobilita': {
    id: 'auto-mobilita',
    label: 'Auto e Mobilità',
    description: 'Officine, carrozzieri, gommisti: quando l\'auto ha un problema, la prima cosa che fanno le persone è cercare su Google.\nSe non hai un sito, stai lasciando quei clienti ai tuoi competitor.',
    problems: [
      { icon: 'ph-magnifying-glass', title: 'Nessuna visibilità online', desc: 'Le persone cercano "officina vicino a me" e tu non compari.\nQuel cliente va da qualcun altro — anche se tu sei più bravo.' },
      { icon: 'ph-star', title: 'Recensioni sparse o assenti', desc: 'Hai clienti soddisfatti ma nessuno lo sa?\nSenza recensioni visibili, i nuovi clienti non hanno modo di fidarsi.' },
      { icon: 'ph-clock', title: 'Nessun modo per contattarti facilmente', desc: 'Telefono occupato, orari chiusi.\nSe il cliente non riesce a raggiungerti in 30 secondi, chiama il prossimo della lista.' },
    ],
    features: [
      { title: 'Sito con servizi e listino', description: 'Tutti i tuoi servizi spiegati chiaramente, con prezzi indicativi se vuoi.\nIl cliente arriva già informato.' },
      { title: 'Richiesta preventivo online', description: 'Form semplice per richiedere un preventivo. Anche fuori orario, anche di domenica.\nTu rispondi quando puoi.' },
      { title: 'SEO locale', description: 'Ti faccio trovare per "officina a [città]", "gommista vicino a me", "carrozziere [zona]".\nLe ricerche che contano.' },
      { title: 'Galleria lavori', description: 'Foto dei tuoi interventi migliori.\nI clienti vedono la qualità del tuo lavoro prima ancora di chiamarti.' },
      { title: 'Google Maps e recensioni', description: 'Scheda Google ottimizzata con indirizzo, orari, foto e recensioni.\nCompari anche sulla mappa.' },
    ],
    faqs: [
      { question: 'Mi serve un sito se lavoro già bene?', answer: 'Se lavori bene, immagina come andresti con più visibilità.\nIl sito ti porta clienti nuovi — quelli che non ti conoscono ancora.' },
      { question: 'Quanto costa?', answer: 'Un sito per un\'officina o carrozzeria parte da €790.\nCon galleria, preventivi online e SEO locale: da €1.490.' },
      { question: 'Posso inserire i prezzi?', answer: 'Certo. Puoi mettere un listino indicativo o invitare a richiedere un preventivo personalizzato.\nDecidiamo insieme cosa funziona meglio.' },
      { question: 'Come gestisco le richieste?', answer: 'Le ricevi via email o WhatsApp.\nNiente dashboard complicata — le richieste arrivano dove le vedi già.' },
      { question: 'Funziona anche per attività piccole?', answer: 'Soprattutto per attività piccole. Un sito semplice e ben fatto ti mette allo stesso livello delle catene, almeno online.' },
    ],
    ctaText: 'Vuoi che i tuoi prossimi clienti ti trovino online?',
  },

  'food-hospitality': {
    id: 'food-hospitality',
    label: 'Food, Hospitality e Turismo',
    description: 'Ristoranti, bar, hotel, B&B: i tuoi clienti decidono dove andare guardando lo smartphone.\nMenu, foto, recensioni, prenotazione. Se non trovano tutto questo sul tuo sito, vanno altrove.',
    problems: [
      { icon: 'ph-fork-knife', title: 'Dipendi solo da piattaforme esterne', desc: 'TripAdvisor, TheFork, Booking prendono commissioni e controllano la tua visibilità.\nUn sito tuo ti rende indipendente.' },
      { icon: 'ph-image', title: 'Nessuna identità online', desc: 'Le persone vogliono vedere foto reali, il menu, l\'atmosfera.\nSe non trovano tutto questo, scelgono chi glielo mostra.' },
      { icon: 'ph-calendar-blank', title: 'Prenotazioni solo a voce', desc: 'Telefono che squilla durante il servizio, messaggi persi, prenotazioni dimenticate.\nUn sistema online risolve tutto.' },
    ],
    features: [
      { title: 'Sito con menu e foto', description: 'Menu sempre aggiornato, foto professionali degli ambienti e dei piatti.\nIl cliente viene già con l\'acquolina in bocca.' },
      { title: 'Prenotazione tavoli/camere', description: 'Sistema di prenotazione integrato — form, WhatsApp o collegamento al tuo gestionale.\nZero commissioni.' },
      { title: 'SEO locale', description: '"Ristorante a [città]", "B&B [zona]" — ti faccio trovare su Google quando le persone cercano il tuo servizio nella tua zona.\nRisultati reali, non promesse.' },
      { title: 'Google Business completo', description: 'Scheda Google con orari, foto, menu, link di prenotazione.\nIl biglietto da visita che tutti vedono.' },
      { title: 'Integrazione social', description: 'Le tue foto da Instagram direttamente nel sito.\nTieni tutto collegato senza lavoro extra.' },
    ],
    faqs: [
      { question: 'Non basta la pagina su TripAdvisor/Booking?', answer: 'Quelle pagine non sono tue — domani cambiano le regole e tu non puoi farci niente.\nIl sito è tuo, non paga commissioni e lavora per te 24/7.' },
      { question: 'Posso aggiornare il menu da solo?', answer: 'Sì, facilmente. Cambio piatto? Cambio prezzo? Lo fai in 2 minuti dal tuo telefono o computer.' },
      { question: 'Quanto costa?', answer: 'Un sito per ristorante/bar parte da €790.\nCon prenotazione, menu interattivo e galleria: da €1.490.' },
      { question: 'Serve anche per eventi o catering?', answer: 'Assolutamente. Aggiungiamo una sezione eventi, un form per richieste personalizzate e galleria degli allestimenti.' },
      { question: 'Mi aiuta a ricevere più prenotazioni?', answer: 'Un sito ottimizzato per la tua zona ti fa trovare da chi cerca attivamente dove mangiare o dormire.\nPiù visibilità = più prenotazioni.' },
    ],
    ctaText: 'Vuoi riempire i tavoli (o le camere) con clienti che ti trovano online?',
  },

  'retail-negozi': {
    id: 'retail-negozi',
    label: 'Retail e Negozi',
    description: 'Anche il negozio sotto casa ha bisogno di farsi trovare online.\nNon per vendere su internet per forza — ma per far sapere che esisti, cosa vendi e perché vale la pena venire da te.',
    problems: [
      { icon: 'ph-storefront', title: 'Esisti solo offline', desc: 'Se qualcuno cerca il tuo tipo di negozio nella tua città, non ti trova.\nE va da chi si fa trovare — anche se è meno bravo.' },
      { icon: 'ph-shopping-bag', title: 'Nessuna vetrina digitale', desc: 'I clienti vogliono vedere cosa hai prima di venire in negozio.\nSenza un sito, rinunciano al viaggio.' },
      { icon: 'ph-phone-disconnect', title: 'Informazioni introvabili', desc: 'Orari, indirizzo, disponibilità: se il cliente deve cercarli troppo, perde la pazienza e va altrove.' },
    ],
    features: [
      { title: 'Vetrina prodotti online', description: 'I tuoi prodotti migliori in bella mostra: categorie, foto, prezzi.\nIl cliente arriva in negozio già convinto.' },
      { title: 'Info sempre aggiornate', description: 'Orari, indirizzo, parcheggio, contatti — tutto chiaro e accessibile.\nNiente più "ma siete aperti oggi?".' },
      { title: 'SEO locale', description: 'Ti faccio trovare per le ricerche nella tua zona.\n"Fioraio a [città]", "ferramenta [quartiere]" — le ricerche che portano clienti in negozio.' },
      { title: 'WhatsApp e contatto diretto', description: 'Il cliente vede un prodotto sul sito e ti scrive subito.\nNessun passaggio inutile.' },
      { title: 'Google Maps e scheda Google', description: 'Il tuo negozio visibile sulla mappa, con foto, recensioni e orari.\nChi cerca vicino a te, ti trova.' },
    ],
    faqs: [
      { question: 'Ma se ho un negozio fisico, mi serve un sito?', answer: 'Sì. Il sito non sostituisce il negozio — lo rende più visibile.\nLe persone cercano online anche il panettiere. Chi si fa trovare, vince.' },
      { question: 'Non voglio vendere online, mi basta farmi conoscere.', answer: 'Perfetto. Un sito vetrina fa esattamente questo: mostra cosa fai, dove sei e come contattarti.\nSemplice ed efficace.' },
      { question: 'Quanto costa?', answer: 'Un sito vetrina per un negozio parte da €790.\nSe vuoi anche una vetrina prodotti con categorie: da €1.490.' },
      { question: 'Posso aggiungere prodotti da solo?', answer: 'Sì. Ti lascio un pannello dove puoi aggiungere foto, descrizioni e prezzi in totale autonomia.' },
      { question: 'E se poi voglio anche vendere online?', answer: 'Il sito può evolvere in un e-commerce quando vuoi.\nPartiamo dalla vetrina e cresciamo insieme.' },
    ],
    ctaText: 'Vuoi che le persone nella tua zona scoprano il tuo negozio?',
  },

  'creativita-eventi': {
    id: 'creativita-eventi',
    label: 'Creatività e Eventi',
    description: 'Fotografi, wedding planner, artisti: il tuo lavoro è visivo.\nTi serve una casa online che mostri la tua arte senza distrazioni, che emozioni e che faccia venire voglia di chiamarti.',
    problems: [
      { icon: 'ph-image', title: 'Portfolio disordinato', desc: 'Le tue foto sono sparse tra social e hard disk?\nTi serve una galleria professionale che dia valore a ogni tuo scatto.' },
      { icon: 'ph-palette', title: 'Immagine poco curata', desc: 'Se vendi bellezza, il tuo sito deve essere bellissimo.\nUn design mediocre allontana i clienti che cercano qualità.' },
      { icon: 'ph-calendar-blank', title: 'Difficoltà a gestire i contatti', desc: 'Richieste che arrivano ovunque e si perdono.\nUn form dedicato ti aiuta a qualificare il cliente e a rispondere meglio.' },
    ],
    features: [
      { title: 'Portfolio emozionale', description: 'Gallerie a tutto schermo, caricamento veloce, design minimale.\nIl tuo lavoro è il protagonista assoluto.' },
      { title: 'Pagine servizio dedicate', description: 'Non solo foto: spiega come lavori, cosa offri e perché sceglierti.\nCrea una connessione con il cliente.' },
      { title: 'Form di contatto personalizzato', description: 'Chiedi le informazioni che ti servono (data, luogo, tipo di evento).\nRisparmi tempo e sei più professionale.' },
      { title: 'Integrazione Instagram', description: 'Il tuo feed sempre aggiornato nel sito.\nIl tuo lavoro più recente è sempre in prima pagina.' },
      { title: 'SEO per eventi e cerimonie', description: 'Ti faccio trovare da chi cerca un professionista per il suo evento speciale nella tua zona.' },
    ],
    faqs: [
      { question: 'Ma non basta Instagram per un fotografo?', answer: 'No. Instagram comprime le foto, le nasconde con l\'algoritmo e non è tuo.\nSul sito la qualità è massima e il controllo è totale.' },
      { question: 'Quanto costa?', answer: 'Un sito portfolio per creativi parte da €790.\nCon gallerie avanzate, blog e SEO specifica: da €1.490.' },
      { question: 'Posso caricare le foto da solo?', answer: 'Assolutamente sì. Ti lascio un sistema semplicissimo per aggiungere i tuoi lavori in totale autonomia.' },
      { question: 'Il sito è ottimizzato per mobile?', answer: 'Sì, è fondamentale. La maggior parte dei tuoi clienti vedrà le tue foto dal telefono — saranno spettacolari.' },
      { question: 'Quanto tempo ci vuole?', answer: 'Circa 15-20 giorni lavorativi per avere un portfolio pronto a stupire i tuoi clienti.' },
    ],
    ctaText: 'Vuoi una casa online che renda giustizia al tuo talento?',
  },
};

// ─── PER-PROFESSION UNIQUE CONTENT ───────────────────────────────
// Each profession gets unique tagline + searchExample for content differentiation

export interface ProfessionContent {
  tagline: string;        // Unique hook for this specific profession
  searchExample: string;  // What real people Google (used in page text)
}

export const PROFESSION_CONTENT: Record<string, ProfessionContent> = {
  // ── Beauty & Wellness ──
  'parrucchieri': { tagline: 'Il tuo salone merita clienti che lo scelgono gia prima di entrare.', searchExample: 'parrucchiere vicino a me' },
  'barbieri': { tagline: 'Barba, capelli e una presenza online che ti distingue dalla catena accanto.', searchExample: 'barbiere bravo [citta]' },
  'estetiste': { tagline: 'I tuoi trattamenti parlano da soli — il sito li fa arrivare a chi li cerca.', searchExample: 'estetista [citta] recensioni' },
  'centri-estetici': { tagline: 'Un centro estetico senza sito e come una vetrina con le serrande abbassate.', searchExample: 'centro estetico vicino a me' },
  'palestre': { tagline: 'I tuoi futuri iscritti stanno cercando una palestra su Google. Adesso.', searchExample: 'palestra [citta] prezzi' },
  'personal-trainer': { tagline: 'Il passaparola ti porta clienti, il sito te ne porta di nuovi ogni giorno.', searchExample: 'personal trainer [citta]' },
  'saloni-di-bellezza': { tagline: 'Le tue clienti scelgono dallo smartphone. Fatti trovare bella anche online.', searchExample: 'salone di bellezza [citta]' },
  'make-up-artist': { tagline: 'Il tuo portfolio merita un palcoscenico migliore di Instagram.', searchExample: 'make-up artist matrimonio [citta]' },
  'onicotecniche': { tagline: 'Unghie perfette e un sito che le mostri al mondo.', searchExample: 'onicotecnica [citta]' },
  'yoga': { tagline: 'Chi cerca equilibrio nella vita, inizia cercando su Google.', searchExample: 'corsi yoga [citta]' },
  'pilates': { tagline: 'Le persone vogliono provare Pilates — devi farti trovare nel momento giusto.', searchExample: 'pilates vicino a me' },
  'scuole-di-danza': { tagline: 'I genitori cercano online la scuola giusta per i loro figli.', searchExample: 'scuola di danza [citta]' },
  'centri-sportivi': { tagline: 'Campi, corsi, orari: tutto visibile in un click.', searchExample: 'centro sportivo [citta]' },
  'piscine': { tagline: 'Nuoto libero, corsi, abbonamenti: fai trovare tutto online.', searchExample: 'piscina [citta] orari' },
  'scuole-calcio': { tagline: 'I genitori vogliono vedere la tua scuola prima di iscrivere i figli.', searchExample: 'scuola calcio [citta]' },

  // ── Sanita & Salute ──
  'dentisti': { tagline: 'I pazienti scelgono il dentista online. La fiducia inizia dal sito.', searchExample: 'dentista [citta] recensioni' },
  'psicologi': { tagline: 'Chi cerca uno psicologo ha gia fatto il passo piu difficile. Fatti trovare.', searchExample: 'psicologo [citta]' },
  'fisioterapisti': { tagline: 'Dolore alla schiena, riabilitazione, postura: ti cercano nel momento del bisogno.', searchExample: 'fisioterapista vicino a me' },
  'veterinari': { tagline: 'Quando il cane sta male, il padrone cerca su Google. Sii tu il primo risultato.', searchExample: 'veterinario aperto [citta]' },
  'medici': { tagline: 'Un sito professionale comunica competenza prima ancora della prima visita.', searchExample: 'medico specialista [citta]' },
  'nutrizionisti': { tagline: 'Le persone vogliono cambiare alimentazione e cercano chi le guidi.', searchExample: 'nutrizionista [citta] prezzi' },
  'osteopati': { tagline: 'L\'osteopatia e in crescita — fatti trovare da chi la scopre ora.', searchExample: 'osteopata [citta]' },
  'ginecologi': { tagline: 'Le pazienti cercano un ginecologo di fiducia. Il sito e il primo contatto.', searchExample: 'ginecologo [citta] privato' },
  'ortodontisti': { tagline: 'Apparecchi invisibili, sorrisi perfetti: mostrali online prima che in studio.', searchExample: 'ortodontista [citta]' },
  'psicoterapeuti': { tagline: 'La psicoterapia e ancora un tabu per molti. Il tuo sito puo abbattere la barriera.', searchExample: 'psicoterapeuta [citta]' },
  'farmacie': { tagline: 'Orari, turni, prodotti disponibili: le persone li cercano online.', searchExample: 'farmacia aperta [citta]' },
  'pediatri': { tagline: 'I genitori cercano il miglior pediatra per i loro figli. Sii visibile.', searchExample: 'pediatra [citta]' },
  'medici-di-base': { tagline: 'Anche i medici di base possono comunicare meglio con i pazienti.', searchExample: 'medico di base [citta]' },
  'dietisti': { tagline: 'Chi vuole dimagrire cerca aiuto online. Fatti trovare con un sito chiaro.', searchExample: 'dietista [citta]' },
  'logopedisti': { tagline: 'I genitori cercano un logopedista con urgenza. Sii facile da trovare.', searchExample: 'logopedista [citta]' },
  'podologi': { tagline: 'Piedi doloranti, unghie incarnite: ti cercano nel momento del bisogno.', searchExample: 'podologo [citta]' },
  'parafarmacie': { tagline: 'Prodotti naturali, cosmetici, integratori: mostra il tuo assortimento online.', searchExample: 'parafarmacia [citta]' },
  'ottici': { tagline: 'Occhiali nuovi? La scelta inizia su Google, non in negozio.', searchExample: 'ottico [citta] prezzi' },
  'audioprotesisti': { tagline: 'Chi cerca un apparecchio acustico vuole fidarsi. Il sito trasmette fiducia.', searchExample: 'audioprotesista [citta]' },

  // ── Studi Professionali ──
  'avvocati': { tagline: 'Il tuo prossimo cliente ti sta cercando su Google in questo momento.', searchExample: 'avvocato divorzista [citta]' },
  'commercialisti': { tagline: 'Partite IVA, dichiarazioni, consulenze: farsi trovare e il primo passo.', searchExample: 'commercialista [citta]' },
  'architetti': { tagline: 'I tuoi progetti parlano per te — il sito li mostra al mondo.', searchExample: 'architetto [citta]' },
  'agenzie-immobiliari': { tagline: 'Il 90% delle ricerche immobiliari inizia online. Sei presente?', searchExample: 'agenzia immobiliare [citta]' },
  'geometri': { tagline: 'Catasto, pratiche, rilievi: chi ti cerca ha un problema da risolvere ora.', searchExample: 'geometra [citta]' },
  'notai': { tagline: 'Anche i notai vengono scelti online. Un sito serio fa la differenza.', searchExample: 'notaio [citta]' },
  'consulenti-del-lavoro': { tagline: 'Buste paga, assunzioni, consulenze: le aziende ti cercano su Google.', searchExample: 'consulente del lavoro [citta]' },
  'ingegneri': { tagline: 'Progetti strutturali, perizie, consulenze: mostra le tue competenze online.', searchExample: 'ingegnere [citta]' },
  'interior-designer': { tagline: 'Il tuo portfolio di interni merita una vetrina digitale all\'altezza.', searchExample: 'interior designer [citta]' },
  'amministratori-di-condominio': { tagline: 'I condomini cercano trasparenza. Un sito la comunica prima di tutto.', searchExample: 'amministratore condominio [citta]' },
  'consulenti-fiscali': { tagline: 'Tasse, detrazioni, bonus: le persone cercano risposte e trovano te.', searchExample: 'consulente fiscale [citta]' },
  'consulenti-finanziari': { tagline: 'La fiducia finanziaria si costruisce anche online.', searchExample: 'consulente finanziario [citta]' },
  'assicuratori': { tagline: 'Le persone confrontano polizze online. Fatti trovare con un sito chiaro.', searchExample: 'assicurazione [citta]' },
  'mediatori-creditizi': { tagline: 'Mutui, prestiti, finanziamenti: il primo contatto avviene online.', searchExample: 'mediatore creditizio [citta]' },
  'agenzie-assicurative': { tagline: 'Auto, casa, vita: le persone cercano la migliore agenzia nella loro zona.', searchExample: 'agenzia assicurativa [citta]' },
  'caf': { tagline: '730, ISEE, bonus: tutti li cercano su Google. Fatti trovare tu.', searchExample: 'CAF [citta]' },
  'patronati': { tagline: 'Pensioni, disoccupazione, pratiche: chi ha bisogno ti cerca online.', searchExample: 'patronato [citta]' },
  'geologi': { tagline: 'Indagini geologiche, relazioni tecniche: mostra la tua esperienza sul campo.', searchExample: 'geologo [citta]' },
  'periti': { tagline: 'Perizie, stime, valutazioni: un sito professionale ti posiziona come esperto.', searchExample: 'perito [citta]' },
  'studi-tecnici': { tagline: 'Pratiche edilizie, progettazione, certificazioni: fatti trovare da chi ha bisogno.', searchExample: 'studio tecnico [citta]' },

  // ── Casa, Impianti & Edilizia ──
  'idraulici': { tagline: 'Tubo rotto alle 3 di notte? Ti cercano su Google. Sii il primo risultato.', searchExample: 'idraulico urgente [citta]' },
  'elettricisti': { tagline: 'Impianti, guasti, certificazioni: il tuo prossimo lavoro arriva dal web.', searchExample: 'elettricista [citta]' },
  'imprese-edili': { tagline: 'Ristrutturazioni, costruzioni, bonus: i clienti piu grossi ti trovano online.', searchExample: 'impresa edile [citta]' },
  'giardinieri': { tagline: 'Giardini curati, potature, manutenzione: le persone cercano nella loro zona.', searchExample: 'giardiniere [citta]' },
  'fabbri': { tagline: 'Serratura bloccata? Cancello da riparare? Ti cercano adesso.', searchExample: 'fabbro urgente [citta]' },
  'serramentisti': { tagline: 'Infissi, finestre, porte: chi ristruttura cerca online prima di comprare.', searchExample: 'serramenti [citta] prezzi' },
  'installatori-fotovoltaico': { tagline: 'Il fotovoltaico e in boom. Fatti trovare da chi vuole installare i pannelli.', searchExample: 'installatore fotovoltaico [citta]' },
  'installatori-climatizzatori': { tagline: 'Estate in arrivo? Tutti cercano chi installa climatizzatori.', searchExample: 'installazione climatizzatori [citta]' },
  'imprese-di-pulizie': { tagline: 'Uffici, condomini, case: le richieste di pulizia partono da Google.', searchExample: 'impresa di pulizie [citta]' },
  'termoidraulici': { tagline: 'Caldaie, riscaldamento, manutenzione: lavori che partono da una ricerca.', searchExample: 'termoidraulico [citta]' },
  'imbianchini': { tagline: 'Pareti da rinfrescare? Il cliente cerca foto dei tuoi lavori prima di chiamarti.', searchExample: 'imbianchino [citta] prezzi' },
  'muratori': { tagline: 'Muri, tramezze, ristrutturazioni: mostra quello che sai fare.', searchExample: 'muratore [citta]' },
  'piastrellisti': { tagline: 'Bagno nuovo, pavimento da rifare: il cliente vuole vedere i tuoi lavori.', searchExample: 'piastrellista [citta]' },
  'cartongessisti': { tagline: 'Controsoffitti, pareti, velette: le foto dei tuoi lavori valgono piu delle parole.', searchExample: 'cartongessista [citta]' },
  'vivaisti': { tagline: 'Piante, fiori, alberi: chi ha il pollice verde ti cerca anche su Google.', searchExample: 'vivaio [citta]' },
  'antennisti': { tagline: 'Parabola, digitale terrestre, problemi di segnale: ti cercano con urgenza.', searchExample: 'antennista [citta]' },
  'caldaisti': { tagline: 'Revisione caldaia, manutenzione, sostituzione: lavori ricorrenti che arrivano dal web.', searchExample: 'caldaista [citta]' },
  'disinfestatori': { tagline: 'Blatte, topi, insetti: quando il problema e urgente, si cerca su Google.', searchExample: 'disinfestazione [citta]' },
  'traslocatori': { tagline: 'Chi trasloca cerca preventivi online. Fatti trovare con un sito che ispira fiducia.', searchExample: 'traslochi [citta] preventivo' },
  'spurgo-pozzi': { tagline: 'Pozzi neri, fosse biologiche: emergenze che partono da una ricerca Google.', searchExample: 'spurgo pozzi [citta]' },
  'autospurghi': { tagline: 'Quando serve un autospurgo, lo cercano subito online.', searchExample: 'autospurgo [citta]' },

  // ── Auto & Mobilita ──
  'officine-meccaniche': { tagline: 'Tagliando, revisione, riparazione: il cliente cerca l\'officina piu vicina.', searchExample: 'officina meccanica [citta]' },
  'carrozzieri': { tagline: 'Dopo un incidente, il carrozziere si cerca su Google. Fatti trovare.', searchExample: 'carrozziere [citta]' },
  'gommisti': { tagline: 'Cambio gomme stagionale? Tutti cercano il gommista piu comodo.', searchExample: 'gommista [citta] prezzi' },
  'autoscuole': { tagline: 'I neopatentati (e i loro genitori) scelgono l\'autoscuola online.', searchExample: 'autoscuola [citta] prezzi' },
  'autonoleggi': { tagline: 'Noleggio auto per un giorno, un mese, un anno: tutto inizia da Google.', searchExample: 'autonoleggio [citta]' },
  'concessionarie-auto': { tagline: 'Il 95% degli acquirenti inizia la ricerca dell\'auto online.', searchExample: 'concessionaria auto [citta]' },
  'elettrauto': { tagline: 'Batteria scarica, problemi elettrici: ti cercano quando hanno fretta.', searchExample: 'elettrauto [citta]' },
  'autolavaggi': { tagline: 'Lavaggio auto, interni, lucidatura: le persone cercano il migliore vicino a loro.', searchExample: 'autolavaggio [citta]' },
  'soccorso-stradale': { tagline: 'Auto in panne? Ti cercano con il telefono in mano, al bordo della strada.', searchExample: 'soccorso stradale [citta]' },

  // ── Food, Hospitality & Turismo ──
  'ristoranti': { tagline: 'Il menu lo guardano sullo smartphone prima ancora di sedersi.', searchExample: 'ristorante [citta] menu' },
  'hotel': { tagline: 'Il 70% delle prenotazioni inizia online. Senza sito, dipendi solo da Booking.', searchExample: 'hotel [citta] prezzi' },
  'b-b': { tagline: 'I viaggiatori cercano B&B con carattere. Il tuo sito deve raccontarlo.', searchExample: 'b&b [citta]' },
  'pizzerie': { tagline: '"Pizza vicino a me" — una delle ricerche piu fatte in Italia. Ci sei?', searchExample: 'pizzeria [citta]' },
  'agriturismi': { tagline: 'Natura, relax, buon cibo: il tuo agriturismo merita di essere trovato.', searchExample: 'agriturismo [citta]' },
  'catering': { tagline: 'Matrimoni, eventi aziendali, feste: ti cercano mesi prima. Fatti trovare.', searchExample: 'catering [citta] preventivo' },
  'bar': { tagline: 'Colazione, aperitivo, pausa pranzo: anche il bar sotto casa si cerca online.', searchExample: 'bar [citta]' },
  'case-vacanza': { tagline: 'I turisti cercano foto, prezzi e disponibilita. Il sito glieli da senza commissioni.', searchExample: 'casa vacanza [citta]' },
  'pasticcerie': { tagline: 'Torte personalizzate, dolci artigianali: mostra le tue creazioni al mondo.', searchExample: 'pasticceria [citta]' },
  'panifici': { tagline: 'Pane fresco, prodotti da forno, specialita: fatti conoscere anche online.', searchExample: 'panificio [citta]' },
  'gelaterie': { tagline: 'Gelato artigianale: i turisti (e i locali) cercano il migliore sulla mappa.', searchExample: 'gelateria [citta]' },
  'pub': { tagline: 'Birre artigianali, serate live, atmosfera: racconta tutto nel tuo sito.', searchExample: 'pub [citta]' },
  'stabilimenti-balneari': { tagline: 'Ombrelloni, lettini, servizi: i bagnanti prenotano online prima di arrivare.', searchExample: 'stabilimento balneare [citta]' },
  'wine-bar': { tagline: 'Vini selezionati, degustazioni, atmosfera: attira gli intenditori con un sito curato.', searchExample: 'wine bar [citta]' },
  'enoteche': { tagline: 'Etichette, eventi, degustazioni: il tuo mondo del vino merita un sito dedicato.', searchExample: 'enoteca [citta]' },

  // ── Retail & Negozi ──
  'negozi-di-abbigliamento': { tagline: 'Le persone guardano online prima di venire in negozio. Mostra cosa hai.', searchExample: 'negozio abbigliamento [citta]' },
  'arredamenti': { tagline: 'Chi ristruttura cerca ispirazione online. I tuoi mobili devono essere li.', searchExample: 'arredamento [citta]' },
  'gioiellerie': { tagline: 'Anelli, collane, orologi: il lusso si sceglie anche con gli occhi, online.', searchExample: 'gioielleria [citta]' },
  'fiorai': { tagline: 'Fiori per ogni occasione: il cliente vuole scegliere e ordinare dal telefono.', searchExample: 'fioraio [citta]' },
  'ferramenta': { tagline: 'Viti, attrezzi, materiali: chi ha un progetto cerca prima su Google.', searchExample: 'ferramenta [citta]' },
  'elettrodomestici': { tagline: 'Lavatrice rotta? Il cliente confronta prezzi online prima di comprare.', searchExample: 'elettrodomestici [citta]' },
  'boutique': { tagline: 'La tua selezione curata merita un sito che la valorizzi.', searchExample: 'boutique [citta]' },
  'tabaccherie': { tagline: 'Tabacchi, ricariche, bollettini: le persone cercano la piu vicina.', searchExample: 'tabaccheria [citta]' },
  'cartolerie': { tagline: 'Materiale scolastico, cancelleria, stampe: fatti trovare a settembre e tutto l\'anno.', searchExample: 'cartoleria [citta]' },
  'librerie': { tagline: 'I lettori cercano librerie indipendenti. Il tuo sito le attira.', searchExample: 'libreria [citta]' },
  'mobili': { tagline: 'Divani, cucine, camere da letto: il cliente vuole vedere prima di venire.', searchExample: 'negozio mobili [citta]' },
  'materassi': { tagline: 'Chi dorme male cerca soluzioni. Fatti trovare con un sito che ispira fiducia.', searchExample: 'materassi [citta]' },
  'telefonia': { tagline: 'Riparazioni, accessori, offerte: il tuo negozio deve comparire su Google.', searchExample: 'negozio telefonia [citta]' },
  'informatica': { tagline: 'Computer, assistenza, riparazioni: le persone cercano il tecnico vicino a loro.', searchExample: 'assistenza computer [citta]' },
  'copisterie': { tagline: 'Stampe, rilegature, tesi: studenti e aziende ti cercano online.', searchExample: 'copisteria [citta]' },
  'tipografie': { tagline: 'Biglietti da visita, volantini, packaging: il primo contatto e digitale.', searchExample: 'tipografia [citta]' },
  'ricamifici': { tagline: 'Ricami personalizzati, loghi, divise: mostra il tuo lavoro artigianale.', searchExample: 'ricamificio [citta]' },
  'mercerie': { tagline: 'Stoffe, bottoni, filati: chi cuce e crea ti cerca anche su Google.', searchExample: 'merceria [citta]' },

  // ── Creativita, Digitale & Eventi ──
  'fotografi': { tagline: 'Il tuo occhio cattura momenti. Il sito li porta ai clienti giusti.', searchExample: 'fotografo matrimonio [citta]' },
  'wedding-planner': { tagline: 'Le spose iniziano a pianificare online. Sii la prima che trovano.', searchExample: 'wedding planner [citta]' },
  'videomaker': { tagline: 'I tuoi video meritano un palcoscenico migliore di YouTube.', searchExample: 'videomaker [citta]' },
  'organizzatori-eventi': { tagline: 'Feste, congressi, inaugurazioni: ti cercano mesi prima dell\'evento.', searchExample: 'organizzazione eventi [citta]' },
  'agenzie-viaggi': { tagline: 'Il viaggio inizia online. Il tuo sito e la prima destinazione.', searchExample: 'agenzia viaggi [citta]' },
  'scuole-private': { tagline: 'I genitori scelgono la scuola anche dal sito. Fai la migliore impressione.', searchExample: 'scuola privata [citta]' },
  'asili-nido': { tagline: 'Genitori ansiosi cercano l\'asilo perfetto. Il sito li rassicura.', searchExample: 'asilo nido [citta]' },
  'tipografi': { tagline: 'Stampa offset, digitale, grande formato: mostra le tue capacita online.', searchExample: 'tipografo [citta]' },
  'centri-di-formazione': { tagline: 'Corsi, certificazioni, master: le persone cercano formazione su Google.', searchExample: 'centro formazione [citta]' },
  'musicisti': { tagline: 'Concerti, eventi, lezioni: il tuo talento merita di essere trovato.', searchExample: 'musicista eventi [citta]' },
  'dj': { tagline: 'Matrimoni, feste, eventi: i clienti vogliono sentire il tuo stile prima di sceglierti.', searchExample: 'dj matrimonio [citta]' },
  'imprese-funebri': { tagline: 'Un momento difficile. Le famiglie cercano seriet\u00e0 e vicinanza — anche online.', searchExample: 'agenzia funebre [citta]' },
};

// ─── PROFESSIONS ───────────────────────────────

export const SEO_PROFESSIONS: SeoProfession[] = [
  // Beauty & wellness
  // Tier 1: alta domanda di ricerca, forte intento commerciale
  { slug: 'parrucchieri', label: 'Parrucchieri', categoryId: 'beauty-wellness', tier: 1 },
  { slug: 'barbieri', label: 'Barbieri', categoryId: 'beauty-wellness', tier: 1 },
  { slug: 'estetiste', label: 'Estetiste', categoryId: 'beauty-wellness', tier: 1 },
  { slug: 'centri-estetici', label: 'Centri Estetici', categoryId: 'beauty-wellness', tier: 1 },
  { slug: 'palestre', label: 'Palestre', categoryId: 'beauty-wellness', tier: 1 },
  { slug: 'personal-trainer', label: 'Personal Trainer', categoryId: 'beauty-wellness', tier: 2 },
  { slug: 'saloni-di-bellezza', label: 'Saloni di Bellezza', categoryId: 'beauty-wellness', tier: 2 },
  { slug: 'make-up-artist', label: 'Make-up Artist', categoryId: 'beauty-wellness', tier: 2 },
  { slug: 'onicotecniche', label: 'Onicotecniche', categoryId: 'beauty-wellness', tier: 3 },
  { slug: 'yoga', label: 'Yoga', categoryId: 'beauty-wellness', tier: 3 },
  { slug: 'pilates', label: 'Pilates', categoryId: 'beauty-wellness', tier: 3 },
  { slug: 'scuole-di-danza', label: 'Scuole di Danza', categoryId: 'beauty-wellness', tier: 3 },
  { slug: 'centri-sportivi', label: 'Centri Sportivi', categoryId: 'beauty-wellness', tier: 3 },
  { slug: 'piscine', label: 'Piscine', categoryId: 'beauty-wellness', tier: 3 },
  { slug: 'scuole-calcio', label: 'Scuole Calcio', categoryId: 'beauty-wellness', tier: 3 },

  // Sanita & salute
  { slug: 'dentisti', label: 'Dentisti', categoryId: 'sanita-salute', tier: 1 },
  { slug: 'psicologi', label: 'Psicologi', categoryId: 'sanita-salute', tier: 1 },
  { slug: 'fisioterapisti', label: 'Fisioterapisti', categoryId: 'sanita-salute', tier: 1 },
  { slug: 'veterinari', label: 'Veterinari', categoryId: 'sanita-salute', tier: 1 },
  { slug: 'medici', label: 'Medici', categoryId: 'sanita-salute', tier: 1 },
  { slug: 'nutrizionisti', label: 'Nutrizionisti', categoryId: 'sanita-salute', tier: 2 },
  { slug: 'osteopati', label: 'Osteopati', categoryId: 'sanita-salute', tier: 2 },
  { slug: 'ginecologi', label: 'Ginecologi', categoryId: 'sanita-salute', tier: 2 },
  { slug: 'ortodontisti', label: 'Ortodontisti', categoryId: 'sanita-salute', tier: 2 },
  { slug: 'psicoterapeuti', label: 'Psicoterapeuti', categoryId: 'sanita-salute', tier: 2 },
  { slug: 'farmacie', label: 'Farmacie', categoryId: 'sanita-salute', tier: 2 },
  { slug: 'pediatri', label: 'Pediatri', categoryId: 'sanita-salute', tier: 3 },
  { slug: 'medici-di-base', label: 'Medici di Base', categoryId: 'sanita-salute', tier: 3 },
  { slug: 'dietisti', label: 'Dietisti', categoryId: 'sanita-salute', tier: 3 },
  { slug: 'logopedisti', label: 'Logopedisti', categoryId: 'sanita-salute', tier: 3 },
  { slug: 'podologi', label: 'Podologi', categoryId: 'sanita-salute', tier: 3 },
  { slug: 'parafarmacie', label: 'Parafarmacie', categoryId: 'sanita-salute', tier: 3 },
  { slug: 'ottici', label: 'Ottici', categoryId: 'sanita-salute', tier: 3 },
  { slug: 'audioprotesisti', label: 'Audioprotesisti', categoryId: 'sanita-salute', tier: 3 },

  // Studi professionali
  { slug: 'avvocati', label: 'Avvocati', categoryId: 'studi-professionali', tier: 1 },
  { slug: 'commercialisti', label: 'Commercialisti', categoryId: 'studi-professionali', tier: 1 },
  { slug: 'architetti', label: 'Architetti', categoryId: 'studi-professionali', tier: 1 },
  { slug: 'agenzie-immobiliari', label: 'Agenzie Immobiliari', categoryId: 'studi-professionali', tier: 1 },
  { slug: 'geometri', label: 'Geometri', categoryId: 'studi-professionali', tier: 2 },
  { slug: 'notai', label: 'Notai', categoryId: 'studi-professionali', tier: 2 },
  { slug: 'consulenti-del-lavoro', label: 'Consulenti del Lavoro', categoryId: 'studi-professionali', tier: 2 },
  { slug: 'ingegneri', label: 'Ingegneri', categoryId: 'studi-professionali', tier: 2 },
  { slug: 'interior-designer', label: 'Interior Designer', categoryId: 'studi-professionali', tier: 2 },
  { slug: 'amministratori-di-condominio', label: 'Amministratori di Condominio', categoryId: 'studi-professionali', tier: 2 },
  { slug: 'consulenti-fiscali', label: 'Consulenti Fiscali', categoryId: 'studi-professionali', tier: 3 },
  { slug: 'consulenti-finanziari', label: 'Consulenti Finanziari', categoryId: 'studi-professionali', tier: 3 },
  { slug: 'assicuratori', label: 'Assicuratori', categoryId: 'studi-professionali', tier: 3 },
  { slug: 'mediatori-creditizi', label: 'Mediatori Creditizi', categoryId: 'studi-professionali', tier: 3 },
  { slug: 'agenzie-assicurative', label: 'Agenzie Assicurative', categoryId: 'studi-professionali', tier: 3 },
  { slug: 'caf', label: 'CAF', categoryId: 'studi-professionali', tier: 3 },
  { slug: 'patronati', label: 'Patronati', categoryId: 'studi-professionali', tier: 3 },
  { slug: 'geologi', label: 'Geologi', categoryId: 'studi-professionali', tier: 3 },
  { slug: 'periti', label: 'Periti', categoryId: 'studi-professionali', tier: 3 },
  { slug: 'studi-tecnici', label: 'Studi Tecnici', categoryId: 'studi-professionali', tier: 3 },

  // Casa, impianti & edilizia
  { slug: 'idraulici', label: 'Idraulici', categoryId: 'casa-edilizia', tier: 1 },
  { slug: 'elettricisti', label: 'Elettricisti', categoryId: 'casa-edilizia', tier: 1 },
  { slug: 'imprese-edili', label: 'Imprese Edili', categoryId: 'casa-edilizia', tier: 1 },
  { slug: 'giardinieri', label: 'Giardinieri', categoryId: 'casa-edilizia', tier: 2 },
  { slug: 'fabbri', label: 'Fabbri', categoryId: 'casa-edilizia', tier: 2 },
  { slug: 'serramentisti', label: 'Serramentisti', categoryId: 'casa-edilizia', tier: 2 },
  { slug: 'installatori-fotovoltaico', label: 'Installatori Fotovoltaico', categoryId: 'casa-edilizia', tier: 2 },
  { slug: 'installatori-climatizzatori', label: 'Installatori Climatizzatori', categoryId: 'casa-edilizia', tier: 2 },
  { slug: 'imprese-di-pulizie', label: 'Imprese di Pulizie', categoryId: 'casa-edilizia', tier: 2 },
  { slug: 'termoidraulici', label: 'Termoidraulici', categoryId: 'casa-edilizia', tier: 2 },
  { slug: 'imbianchini', label: 'Imbianchini', categoryId: 'casa-edilizia', tier: 3 },
  { slug: 'muratori', label: 'Muratori', categoryId: 'casa-edilizia', tier: 3 },
  { slug: 'piastrellisti', label: 'Piastrellisti', categoryId: 'casa-edilizia', tier: 3 },
  { slug: 'cartongessisti', label: 'Cartongessisti', categoryId: 'casa-edilizia', tier: 3 },
  { slug: 'vivaisti', label: 'Vivaisti', categoryId: 'casa-edilizia', tier: 3 },
  { slug: 'antennisti', label: 'Antennisti', categoryId: 'casa-edilizia', tier: 3 },
  { slug: 'caldaisti', label: 'Caldaisti', categoryId: 'casa-edilizia', tier: 3 },
  { slug: 'disinfestatori', label: 'Disinfestatori', categoryId: 'casa-edilizia', tier: 3 },
  { slug: 'traslocatori', label: 'Traslocatori', categoryId: 'casa-edilizia', tier: 3 },
  { slug: 'spurgo-pozzi', label: 'Spurgo Pozzi', categoryId: 'casa-edilizia', tier: 3 },
  { slug: 'autospurghi', label: 'Autospurghi', categoryId: 'casa-edilizia', tier: 3 },

  // Auto & mobilita
  { slug: 'officine-meccaniche', label: 'Officine Meccaniche', categoryId: 'auto-mobilita', tier: 1 },
  { slug: 'carrozzieri', label: 'Carrozzieri', categoryId: 'auto-mobilita', tier: 2 },
  { slug: 'gommisti', label: 'Gommisti', categoryId: 'auto-mobilita', tier: 2 },
  { slug: 'autoscuole', label: 'Autoscuole', categoryId: 'auto-mobilita', tier: 2 },
  { slug: 'autonoleggi', label: 'Autonoleggi', categoryId: 'auto-mobilita', tier: 2 },
  { slug: 'concessionarie-auto', label: 'Concessionarie Auto', categoryId: 'auto-mobilita', tier: 2 },
  { slug: 'elettrauto', label: 'Elettrauto', categoryId: 'auto-mobilita', tier: 3 },
  { slug: 'autolavaggi', label: 'Autolavaggi', categoryId: 'auto-mobilita', tier: 3 },
  { slug: 'soccorso-stradale', label: 'Soccorso Stradale', categoryId: 'auto-mobilita', tier: 3 },

  // Food, hospitality & turismo
  { slug: 'ristoranti', label: 'Ristoranti', categoryId: 'food-hospitality', tier: 1 },
  { slug: 'hotel', label: 'Hotel', categoryId: 'food-hospitality', tier: 1 },
  { slug: 'b-b', label: 'B&B', categoryId: 'food-hospitality', tier: 1 },
  { slug: 'pizzerie', label: 'Pizzerie', categoryId: 'food-hospitality', tier: 2 },
  { slug: 'agriturismi', label: 'Agriturismi', categoryId: 'food-hospitality', tier: 2 },
  { slug: 'catering', label: 'Catering', categoryId: 'food-hospitality', tier: 2 },
  { slug: 'bar', label: 'Bar', categoryId: 'food-hospitality', tier: 2 },
  { slug: 'case-vacanza', label: 'Case Vacanza', categoryId: 'food-hospitality', tier: 2 },
  { slug: 'pasticcerie', label: 'Pasticcerie', categoryId: 'food-hospitality', tier: 3 },
  { slug: 'panifici', label: 'Panifici', categoryId: 'food-hospitality', tier: 3 },
  { slug: 'gelaterie', label: 'Gelaterie', categoryId: 'food-hospitality', tier: 3 },
  { slug: 'pub', label: 'Pub', categoryId: 'food-hospitality', tier: 3 },
  { slug: 'stabilimenti-balneari', label: 'Stabilimenti Balneari', categoryId: 'food-hospitality', tier: 3 },
  { slug: 'wine-bar', label: 'Wine Bar', categoryId: 'food-hospitality', tier: 3 },
  { slug: 'enoteche', label: 'Enoteche', categoryId: 'food-hospitality', tier: 3 },

  // Retail & negozi
  { slug: 'negozi-di-abbigliamento', label: 'Negozi di Abbigliamento', categoryId: 'retail-negozi', tier: 1 },
  { slug: 'arredamenti', label: 'Arredamenti', categoryId: 'retail-negozi', tier: 2 },
  { slug: 'gioiellerie', label: 'Gioiellerie', categoryId: 'retail-negozi', tier: 2 },
  { slug: 'fiorai', label: 'Fiorai', categoryId: 'retail-negozi', tier: 2 },
  { slug: 'ferramenta', label: 'Ferramenta', categoryId: 'retail-negozi', tier: 2 },
  { slug: 'elettrodomestici', label: 'Elettrodomestici', categoryId: 'retail-negozi', tier: 2 },
  { slug: 'boutique', label: 'Boutique', categoryId: 'retail-negozi', tier: 3 },
  { slug: 'tabaccherie', label: 'Tabaccherie', categoryId: 'retail-negozi', tier: 3 },
  { slug: 'cartolerie', label: 'Cartolerie', categoryId: 'retail-negozi', tier: 3 },
  { slug: 'librerie', label: 'Librerie', categoryId: 'retail-negozi', tier: 3 },
  { slug: 'mobili', label: 'Mobili', categoryId: 'retail-negozi', tier: 3 },
  { slug: 'materassi', label: 'Materassi', categoryId: 'retail-negozi', tier: 3 },
  { slug: 'telefonia', label: 'Telefonia', categoryId: 'retail-negozi', tier: 3 },
  { slug: 'informatica', label: 'Informatica', categoryId: 'retail-negozi', tier: 3 },
  { slug: 'copisterie', label: 'Copisterie', categoryId: 'retail-negozi', tier: 3 },
  { slug: 'tipografie', label: 'Tipografie', categoryId: 'retail-negozi', tier: 3 },
  { slug: 'ricamifici', label: 'Ricamifici', categoryId: 'retail-negozi', tier: 3 },
  { slug: 'mercerie', label: 'Mercerie', categoryId: 'retail-negozi', tier: 3 },

  // Creativita, digitale & eventi
  { slug: 'fotografi', label: 'Fotografi', categoryId: 'creativita-eventi', tier: 1 },
  { slug: 'wedding-planner', label: 'Wedding Planner', categoryId: 'creativita-eventi', tier: 1 },
  { slug: 'videomaker', label: 'Videomaker', categoryId: 'creativita-eventi', tier: 2 },
  // agenzie-marketing rimosso: competitor diretto
  { slug: 'organizzatori-eventi', label: 'Organizzatori Eventi', categoryId: 'creativita-eventi', tier: 2 },
  { slug: 'agenzie-viaggi', label: 'Agenzie Viaggi', categoryId: 'creativita-eventi', tier: 2 },
  { slug: 'scuole-private', label: 'Scuole Private', categoryId: 'creativita-eventi', tier: 2 },
  { slug: 'asili-nido', label: 'Asili Nido', categoryId: 'creativita-eventi', tier: 2 },
  // grafici e web-designer rimossi: competitor diretti
  // social-media-manager rimosso: competitor diretto
  { slug: 'tipografi', label: 'Tipografi', categoryId: 'creativita-eventi', tier: 3 },
  { slug: 'centri-di-formazione', label: 'Centri di Formazione', categoryId: 'creativita-eventi', tier: 3 },
  { slug: 'musicisti', label: 'Musicisti', categoryId: 'creativita-eventi', tier: 3 },
  { slug: 'dj', label: 'DJ', categoryId: 'creativita-eventi', tier: 3 },
  { slug: 'imprese-funebri', label: 'Imprese Funebri', categoryId: 'creativita-eventi', tier: 3 },
];

// ─── Lookup maps ───────────────────────────────

const professionBySlug = new Map<string, SeoProfession>();
for (const p of SEO_PROFESSIONS) professionBySlug.set(p.slug, p);

// ─── Exports ───────────────────────────────

export function getProfessionBySlug(slug: string): SeoProfession | undefined {
  return professionBySlug.get(slug);
}

export function getCategoryById(id: string): ProfessionCategory | undefined {
  return PROFESSION_CATEGORIES[id];
}

export function getCategoryForProfession(profession: SeoProfession): ProfessionCategory {
  return PROFESSION_CATEGORIES[profession.categoryId];
}

export function getProfessionsByCategory(categoryId: string): SeoProfession[] {
  return SEO_PROFESSIONS.filter(p => p.categoryId === categoryId);
}

export function getAllProfessions(): SeoProfession[] {
  return SEO_PROFESSIONS;
}

export function getProfessionContent(slug: string): ProfessionContent | undefined {
  return PROFESSION_CONTENT[slug];
}

/**
 * All pages are indexed. Tier is kept for sitemap priority scoring
 * and future granular control if needed.
 */
export function shouldIndex(_profession: SeoProfession, _city?: { tier: 1 | 2 | 3 }): boolean {
  return true;
}

/**
 * Sitemap priority based on tier scoring.
 * Lower score = higher priority.
 */
export function getSitemapPriority(profession: SeoProfession, city?: { tier: 1 | 2 | 3 }): string {
  if (!city) return '0.7'; // pillar pages
  const score = profession.tier + city.tier;
  if (score <= 3) return '0.6';
  if (score <= 4) return '0.5';
  return '0.4';
}

// ─── EN locale helper (Round 5b, 2026-05-08) ─────────────────────────
import { PROFESSION_CATEGORIES_EN } from './seo-professions-en';
import { PROFESSION_LABELS_EN } from './seo-professions-labels-en';
import { PROFESSION_CONTENT_EN } from './seo-profession-content-en';
import type { Locale } from '@/lib/i18n';

/**
 * Locale-aware getter for PROFESSION_CATEGORIES.
 * Le label individuali delle professioni (parrucchieri, dentisti, ecc.) sono
 * tradotte via `PROFESSION_LABELS_EN`. Le matrix landing pages restano IT-only
 * per il body content (bloccate dal route guard EN), ma il selettore matrix
 * (PerChiLavoro, MorphTicker) appare su pagine EN e deve mostrare le voci
 * tradotte. Dal 2026-05-15 anche le matrix profession-only sono EN-accessible
 * con content tradotto via PROFESSION_CONTENT_EN + WEB_DESIGN_CONTENT_EN etc.
 */
export function getProfessionCategories(
  locale: Locale = 'it',
): Record<string, ProfessionCategory> {
  return locale === 'en' ? PROFESSION_CATEGORIES_EN : PROFESSION_CATEGORIES;
}

/**
 * Locale-aware variant di getCategoryForProfession.
 */
export function getCategoryForProfessionLocalized(
  profession: SeoProfession,
  locale: Locale = 'it',
): ProfessionCategory {
  const map = locale === 'en' ? PROFESSION_CATEGORIES_EN : PROFESSION_CATEGORIES;
  return map[profession.categoryId];
}

/**
 * Locale-aware variant di getProfessionContent (tagline + searchExample).
 */
export function getProfessionContentLocalized(
  slug: string,
  locale: Locale = 'it',
): ProfessionContent | undefined {
  const map = locale === 'en' ? PROFESSION_CONTENT_EN : PROFESSION_CONTENT;
  return map[slug];
}

/**
 * Locale-aware label per una profession. Fallback: il label IT canonical.
 */
export function getProfessionLabel(profession: SeoProfession, locale: Locale = 'it'): string {
  if (locale === 'en') {
    return PROFESSION_LABELS_EN[profession.slug] ?? profession.label;
  }
  return profession.label;
}

/**
 * Locale-aware getter for all professions con label tradotta. Ritorna nuovi
 * oggetti (non mutua i SEO_PROFESSIONS originali) per non rompere consumer
 * che si aspettano IT canonical.
 */
export function getAllProfessionsLocalized(locale: Locale = 'it'): SeoProfession[] {
  if (locale === 'it') return SEO_PROFESSIONS;
  return SEO_PROFESSIONS.map((p) => ({
    ...p,
    label: PROFESSION_LABELS_EN[p.slug] ?? p.label,
  }));
}
