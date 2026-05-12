/**
 * Glossario Web Design — 30 termini A-Z.
 * Voice aggressiva: ogni entry è strutturata come
 *  "Cos'è. Perché ti riguarda. Cosa pretendere."
 * — taglio esplicitamente anti-fumo.
 *
 * Schema.org DefinedTerm: il `slug` diventa l'anchor #lcp, #cms, ecc.
 */

export interface GlossarioEntry {
  /** Anchor slug per #fragment URL (lowercase, hyphenated) */
  slug: string;
  /** Acronimo o termine principale */
  term: string;
  /** Sottotitolo / nome esteso (opzionale) */
  fullName?: string;
  /** "Cos'è" — definizione asciutta, max 30 parole */
  whatItIs: string;
  /** "Perché ti riguarda" — impatto sul cliente, max 35 parole */
  whyYouCare: string;
  /** "Cosa pretendere" — richiesta concreta al fornitore, max 35 parole */
  whatToDemand: string;
  /** Lettera A-Z per indicizzazione */
  letter: string;
}

export const GLOSSARIO: GlossarioEntry[] = [
  {
    slug: 'accessibility',
    term: 'Accessibility',
    fullName: 'Accessibilità web (WCAG)',
    letter: 'A',
    whatItIs:
      "Insieme di criteri (WCAG 2.2) che rendono un sito usabile da chiunque:\nchi non vede, chi non sente, chi naviga solo da tastiera.",
    whyYouCare:
      "Un sito non accessibile esclude clienti.\nDal 2025 in Europa diventa illegale per le aziende sopra una certa soglia.\nTi espone anche a risarcimenti se ti fanno causa.",
    whatToDemand:
      "Chiedi un report di audit accessibilità prima del lancio.\nSe il fornitore ti guarda come un alieno quando dici 'WCAG', cambia fornitore.",
  },
  {
    slug: 'alt-text',
    term: 'Alt text',
    letter: 'A',
    whatItIs:
      "La descrizione testuale che si associa a un'immagine.\nLetta dagli screen reader e usata da Google per capire cosa raffigura.",
    whyYouCare:
      "Senza alt text le tue immagini non posizionano in Google Immagini.\nI tuoi clienti ipovedenti non possono usare correttamente il sito.",
    whatToDemand:
      "Pretendi alt text descrittivo su tutte le immagini di contenuto.\nLe immagini decorative possono avere alt vuoto, ma non essere assenti.",
  },
  {
    slug: 'anchor-text',
    term: 'Anchor text',
    letter: 'A',
    whatItIs:
      "Il testo cliccabile di un link.\n'Clicca qui' è anchor text. Il testo che precede è contesto.",
    whyYouCare:
      "Google usa l'anchor text per capire di cosa parla la pagina linkata.\n'Clicca qui' non gli dice niente. Una keyword sì.",
    whatToDemand:
      "I link interni del tuo sito devono avere anchor descrittive ('servizi di web design').\nEvita termini generici come 'clicca qui' o 'leggi di più'.",
  },
  {
    slug: 'backlink',
    term: 'Backlink',
    letter: 'B',
    whatItIs:
      "Un link da un altro sito al tuo.\nPer Google è come un voto di fiducia: più siti autorevoli ti linkano, più ranki.",
    whyYouCare:
      "Senza backlink di qualità, anche il sito tecnicamente perfetto non rankerà su keyword competitive.\nÈ il pilastro dell'autorità esterna.",
    whatToDemand:
      "Diffida di chi vende '1.000 backlink a 99€'. Sono link spam che Google penalizza.\nVuoi pochi link, ma da siti reali e autorevoli del tuo settore.",
  },
  {
    slug: 'breadcrumb',
    term: 'Breadcrumb',
    letter: 'B',
    whatItIs:
      "La 'briciolina' di navigazione — Home › Servizi › Web Design — che mostra dove sei nel sito e come ci sei arrivato.",
    whyYouCare:
      "Aiuta gli utenti a orientarsi e Google a capire la struttura del sito.\nSenza, la navigazione confonde e il SEO peggiora.",
    whatToDemand:
      "I breadcrumb devono essere presenti su tutte le pagine interne.\nDevono includere lo schema JSON-LD BreadcrumbList per Google.",
  },
  {
    slug: 'canonical',
    term: 'Canonical',
    fullName: 'Canonical URL',
    letter: 'C',
    whatItIs:
      "Il tag `<link rel='canonical'>` che dice a Google qual è la versione 'ufficiale' di una pagina.\nIndispensabile quando ne esistono varianti (es. parametri tracking).",
    whyYouCare:
      "Senza canonical Google vede contenuto duplicato, divide il ranking tra le copie, e la pagina principale ne soffre.",
    whatToDemand:
      "Ogni pagina deve avere un canonical esplicito che punta alla URL pulita.\nSe il tuo sito ha versioni mobile/desktop separate, il canonical lo dichiara.",
  },
  {
    slug: 'cdn',
    term: 'CDN',
    fullName: 'Content Delivery Network',
    letter: 'C',
    whatItIs:
      "Una rete di server distribuiti nel mondo che consegna i tuoi contenuti dal nodo più vicino al visitatore.\nIl sito apre più veloce ovunque.",
    whyYouCare:
      "Se vendi a Milano e il tuo server è ad Amsterdam, ogni clic perde 100ms.\nIl CDN abbatte la latenza e migliora le Core Web Vitals.",
    whatToDemand:
      "Hosting moderno (Vercel, Cloudflare Pages) include CDN.\nSu WordPress chiedi Cloudflare in front.\nCosto: spesso zero.",
  },
  {
    slug: 'cls',
    term: 'CLS',
    fullName: 'Cumulative Layout Shift',
    letter: 'C',
    whatItIs:
      "Quanto la pagina 'salta' mentre si carica.\nSuccede quando clicchi un bottone e all'ultimo si sposta perché un'immagine ha caricato.",
    whyYouCare:
      "Un CLS alto fa rabbia all'utente, e Google ti penalizza nel ranking.\nSotto 0,1 sei a posto, sopra 0,25 sei nei guai.",
    whatToDemand:
      "Tutte le immagini devono avere width/height esplicite.\nNiente font che caricano in ritardo cambiando il layout.\nMisurato con Lighthouse, non a occhio.",
  },
  {
    slug: 'cms',
    term: 'CMS',
    fullName: 'Content Management System',
    letter: 'C',
    whatItIs:
      "Il pannello con cui modifichi i contenuti del sito senza saper programmare.\nWordPress è il più famoso, ma ce ne sono di più moderni (Payload, Sanity).",
    whyYouCare:
      "Senza CMS dipendi dal fornitore per ogni virgola da cambiare.\nCon il CMS giusto sei autonomo.\nCon quello sbagliato è peggio del nulla.",
    whatToDemand:
      "Non accettare 'siti statici a mano' a meno che non ti serva.\nVuoi un CMS che capisci e che dura nel tempo.\nFormazione sempre inclusa.",
  },
  {
    slug: 'core-web-vitals',
    term: 'Core Web Vitals',
    letter: 'C',
    whatItIs:
      "I tre numeri (LCP, CLS, INP) con cui Google misura l'esperienza tecnica del sito.\nSe non passi, perdi posizioni.",
    whyYouCare:
      "Sono fattori di ranking ufficiali dal 2021.\nUn sito lento o instabile non posiziona, indipendentemente dalla qualità dei contenuti.",
    whatToDemand:
      "Pretendi un report PageSpeed Insights con tutti tre i numeri in verde.\nSe il fornitore ti dice 'è normale che sia rosso', non è il tuo fornitore.",
  },
  {
    slug: 'dominio',
    term: 'Dominio',
    letter: 'D',
    whatItIs:
      "L'indirizzo del tuo sito — calicchia.design, miosito.it.\nÈ il nome che digiti per arrivare alla tua casa online.",
    whyYouCare:
      "Il dominio deve essere TUO, registrato a nome tuo.\nNon del web designer, non dell'agenzia.\nSe sparisce il fornitore, non deve sparire il tuo business.",
    whatToDemand:
      "Pretendi le credenziali del registrar con il dominio intestato a te.\nSe fanno resistenza, è un segnale di allarme.",
  },
  {
    slug: 'fid',
    term: 'FID',
    fullName: 'First Input Delay (deprecato 2024)',
    letter: 'F',
    whatItIs:
      "Tempo tra il primo clic dell'utente e la risposta del browser.\nDa marzo 2024 sostituito da INP, ma lo trovi ancora in vecchi report.",
    whyYouCare:
      "Storicamente Core Web Vital — oggi guarda INP.\nSe il tuo fornitore parla ancora di FID, è fermo a tecniche di 3 anni fa.",
    whatToDemand:
      "Report che misuri INP, non solo FID.\nSe vedi solo FID nel report, chiedi un aggiornamento tecnico.",
  },
  {
    slug: 'hosting',
    term: 'Hosting',
    letter: 'H',
    whatItIs:
      "Lo spazio server dove vive il sito.\nSe il sito è una casa, l'hosting è il terreno su cui poggia.",
    whyYouCare:
      "Hosting scadente = sito lento, downtime, attacchi informatici.\nSpendere 30€/anno per risparmiare 100€ ti costa clienti ogni giorno.",
    whatToDemand:
      "Performance reali, backup automatici giornalieri, supporto 24/7.\nIl prezzo vero è quello che ti garantisce la continuità del business.",
  },
  {
    slug: 'hreflang',
    term: 'Hreflang',
    letter: 'H',
    whatItIs:
      "Tag che dice a Google che la stessa pagina esiste in più lingue.\nEsempio: '/it/contatti' e '/en/contact' vanno collegati tra loro.",
    whyYouCare:
      "Senza hreflang Google può mostrare la versione sbagliata al visitatore.\nO peggio: pensare che siano contenuti duplicati e penalizzarti.",
    whatToDemand:
      "In un sito multilingua, ogni versione deve dichiarare hreflang verso le altre.\nLa sitemap XML deve includerli automaticamente.",
  },
  {
    slug: 'https',
    term: 'HTTPS',
    fullName: 'HTTPS / SSL',
    letter: 'H',
    whatItIs:
      "Il lucchetto verde nel browser.\nSignifica che il traffico tra utente e sito è cifrato.\nSenza, è tutto in chiaro.",
    whyYouCare:
      "HTTPS è fattore di ranking.\nI browser marchiano 'Non sicuro' i siti senza.\nNessuno compra da un sito 'Non sicuro'.",
    whatToDemand:
      "Certificato SSL incluso nell'hosting (Let's Encrypt è gratis e perfetto).\nRedirect automatico da HTTP a HTTPS.\nNiente eccezioni."
  },
  {
    slug: 'inp',
    term: 'INP',
    fullName: 'Interaction to Next Paint',
    letter: 'I',
    whatItIs:
      "Quanto tempo passa tra un clic e il momento in cui il browser mostra il risultato.\nSostituisce definitivamente il FID dal 2024.",
    whyYouCare:
      "Un sito che 'non risponde' subito al clic frustra l'utente.\nSotto 200ms sei ottimo, sopra 500ms sei rotto.\nGoogle lo usa per pesare il tuo ranking.",
    whatToDemand:
      "Misurato in PageSpeed Insights.\nDeve essere sotto i 200ms su mobile reale, non solo su test sintetici.",
  },
  {
    slug: 'lazy-loading',
    term: 'Lazy loading',
    letter: 'L',
    whatItIs:
      "Tecnica che carica le immagini solo quando l'utente sta per vederle.\nRiduce drasticamente il peso iniziale della pagina.",
    whyYouCare:
      "Un sito senza lazy loading carica tutto subito: è lento, brucia dati mobili.\nCon il lazy loading apre istantaneo e consuma meno banda.",
    whatToDemand:
      "Tutte le immagini sotto la prima schermata devono essere lazy.\nQuelle sopra (LCP) no: caricarle lazy peggiorerebbe le prestazioni.",
  },
  {
    slug: 'lcp',
    term: 'LCP',
    fullName: 'Largest Contentful Paint',
    letter: 'L',
    whatItIs:
      "Il tempo che impiega l'elemento più grande della pagina (immagine hero, video o testo) ad apparire al visitatore.",
    whyYouCare:
      "Sotto i 2,5 secondi sei a posto.\nSopra i 4 secondi Google ti penalizza e i visitatori chiudono la scheda annoiati.",
    whatToDemand:
      "Chiedi l'LCP esatto misurato — non un generico 'va veloce'.\nDeve essere testato su mobile reale (rete 4G), non su connessione ufficio.",
  },
  {
    slug: 'meta-description',
    term: 'Meta description',
    letter: 'M',
    whatItIs:
      "Il riassunto di 150-160 caratteri che appare sotto al titolo blu nei risultati di Google.",
    whyYouCare:
      "Non è fattore di ranking diretto, ma incide sul click-through rate (CTR).\nUna description debole e nessuno clicca, anche se sei primo.",
    whatToDemand:
      "Ogni pagina deve avere una meta description unica e scritta a mano.\nDeve includere keyword, value prop e un invito all'azione chiaro.",
  },
  {
    slug: 'mobile-first',
    term: 'Mobile first',
    letter: 'M',
    whatItIs:
      "Approccio di design che parte dal mobile e poi adatta al desktop.\nRiflette come naviga oggi oltre il 70% degli utenti reali.",
    whyYouCare:
      "Google indicizza mobile-first dal 2019.\nSe il tuo sito 'si adatta' ma non è progettato per il pollice, perdi ranking e clienti.",
    whatToDemand:
      "Pretendi il mockup mobile PRIMA del desktop.\nSe il fornitore parte dal monitor grande, sta lavorando con una mentalità vecchia.",
  },
  {
    slug: 'open-graph',
    term: 'Open Graph',
    letter: 'O',
    whatItIs:
      "Tag che controllano come appare il tuo sito quando viene condiviso sui social (Facebook, LinkedIn, WhatsApp).\nTitolo, descrizione e immagine.",
    whyYouCare:
      "Senza Open Graph, una condivisione su LinkedIn mostra un quadrato bianco o una URL nuda.\nSembra amatoriale e nessuno ci clicca.",
    whatToDemand:
      "Ogni pagina deve avere og:title, og:description e og:image (1200×630).\nL'immagine deve essere curata, non uno screenshot casuale.",
  },
  {
    slug: 'page-speed',
    term: 'Page speed',
    letter: 'P',
    whatItIs:
      "La velocità complessiva di caricamento.\nNon un singolo numero, ma l'unione di LCP, CLS, INP e TTFB.",
    whyYouCare:
      "Ogni secondo in più di attesa = -7% di conversioni.\nLa velocità non è un dettaglio tecnico, è l'efficienza del tuo business online.",
    whatToDemand:
      "PageSpeed Insights almeno 90/100 su mobile reale.\nSe il fornitore minimizza lo score, sta proteggendo la sua incapacità tecnica.",
  },
  {
    slug: 'redirect',
    term: 'Redirect',
    letter: 'R',
    whatItIs:
      "Reindirizzamento da una URL vecchia a una nuova.\nQuando rifai il sito, il redirect 301 dice a Google: 'la pagina si è spostata qui'.",
    whyYouCare:
      "Senza redirect, i link che puntavano al vecchio sito diventano 404.\nPerdi traffico, perdi autorità e anni di SEO faticosa.",
    whatToDemand:
      "Mappa dei redirect 301 di TUTTE le URL vecchie verso le nuove.\nPretendila scritta e verificabile PRIMA del lancio del nuovo sito.",
  },
  {
    slug: 'responsive',
    term: 'Responsive design',
    letter: 'R',
    whatItIs:
      "Design che si adatta a ogni dimensione di schermo: mobile, tablet, desktop.\nUna sola codebase che risponde a ogni viewport.",
    whyYouCare:
      "Un sito 'solo desktop' nel 2026 è un asset morto.\nGoogle lo penalizza, gli utenti lo abbandonano, è inutile sul telefono.",
    whatToDemand:
      "Verifica il sito su un iPhone e un Android reali prima del lancio.\nNon fidarti degli emulatori del browser, prova il tocco reale.",
  },
  {
    slug: 'robots',
    term: 'Robots.txt',
    letter: 'R',
    whatItIs:
      "File di testo che dice ai bot dei motori di ricerca cosa scansionare e cosa ignorare.\nEs: blocco dell'area admin o dei file privati.",
    whyYouCare:
      "Un robots.txt sbagliato può far sparire l'intero sito da Google.\nO esporre pagine sensibili che dovrebbero restare nascoste.",
    whatToDemand:
      " robots.txt esplicito che blocchi solo i path privati.\nTutto il resto deve essere libero per la scansione dei bot.",
  },
  {
    slug: 'schema-markup',
    term: 'Schema markup',
    fullName: 'Schema markup (JSON-LD)',
    letter: 'S',
    whatItIs:
      "Codice strutturato (formato JSON-LD) che spiega a Google cosa sono i contenuti — un articolo, un prodotto, una FAQ, un evento.",
    whyYouCare:
      "Lo schema sblocca i 'rich result': stelle nei risultati, FAQ espandibili, prezzi visibili.\nPiù visibilità in SERP a parità di posizione.",
    whatToDemand:
      "Schema Article, FAQPage, BreadcrumbList, LocalBusiness validati con Google Rich Results Test.\nSenza non sei competitivo."
  },
  {
    slug: 'sitemap',
    term: 'Sitemap',
    fullName: 'Sitemap XML',
    letter: 'S',
    whatItIs:
      "L'indice del sito in formato XML.\nLa mappa che Google legge per scoprire e indicizzare tutte le tue pagine velocemente.",
    whyYouCare:
      "Senza sitemap Google trova le pagine 'a caso' seguendo i link.\nLe pagine nuove possono impiegare settimane a comparire nei risultati.",
    whatToDemand:
      "Sitemap XML auto-aggiornante, registrata in Search Console.\nDeve contenere tutte (e sole) le URL pubbliche e indicizzabili.",
  },
  {
    slug: 'ssl',
    term: 'SSL',
    fullName: 'Secure Sockets Layer (oggi TLS)',
    letter: 'S',
    whatItIs:
      "Il certificato che cifra il traffico tra browser e server.\nÈ quello che abilita l'icona del lucchetto e il protocollo sicuro HTTPS.",
    whyYouCare:
      "Senza SSL il sito è marchiato 'Non sicuro'.\nI browser bloccano i form di contatto e il checkout se la connessione non è protetta.",
    whatToDemand:
      "SSL Let's Encrypt incluso e con rinnovo automatico.\nCosto: zero. Chi te lo fa pagare a parte sta gonfiando il conto.",
  },
  {
    slug: 'link-interni',
    term: 'Link interni',
    fullName: 'Internal Linking',
    letter: 'L',
    whatItIs:
      "Link da una pagina del tuo sito a un'altra pagina dello stesso sito.\nDiversi dai backlink, che provengono da siti esterni.",
    whyYouCare:
      "Distribuiscono l'autorità SEO tra le pagine e aiutano Google a capire la gerarchia.\nNessun link interno = pagina orfana = invisibile.",
    whatToDemand:
      "Ogni pagina nuova deve ricevere almeno 2-3 link da altre sezioni.\nUsa anchor text descrittivi, non 'clicca qui'.",
  }
];

/** Letters with at least one term — usato per la barra di navigazione A-Z */
export const GLOSSARIO_LETTERS = Array.from(
  new Set(GLOSSARIO.map((e) => e.letter))
).sort();
