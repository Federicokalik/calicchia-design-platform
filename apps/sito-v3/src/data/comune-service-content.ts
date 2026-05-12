/**
 * Generatore deterministico di contenuto unico per ogni combo (comune × servizio).
 *
 * Strategia anti-doorway:
 *   1. Tagging dei comuni con attributi semantici (`comune-attributes.ts`)
 *   2. ~50 template angle paragraphs per coppia (attributo, servizio)
 *   3. Factory `getComboContent(comuneSlug, serviceSlug)` che pesca il template
 *      piu rilevante in base agli attributi del comune.
 *
 * Output deterministico: stesso input → stesso output (no random, no LLM).
 * Ogni pagina /zone/{comune}/{service} riceve un paragrafo che combina la
 * specificita locale del comune con il valore del servizio. Pagine
 * diverse → contenuto sostanzialmente diverso.
 */

import type { ServiceSlug } from './seo-service-matrix';
import { COMUNE_ATTRIBUTES, getPreposizione, type ComuneAttributes } from '@/lib/comune-attributes';

export interface ComboContent {
  /** Headline breve sotto l'h1, mostrata come subtitle del Combo Angle. */
  intro: string;
  /** Paragrafo lungo che spiega perché QUESTO servizio in QUESTO comune. */
  localAngle: string;
}

// ─── Attributi prioritari per ogni servizio ────────────────────────
// Per ogni service, definisco quali attributi del comune "attivano" un
// template specifico. La factory pesca il primo che matcha (priority ordering).
type AttrKey =
  | 'universitaria'
  | 'industriale'
  | 'turistica'
  | 'storica'
  | 'termale'
  | 'portuale'
  | 'metro'      // populationTier 'xl'
  | 'grande'     // populationTier 'l'
  | 'media'      // populationTier 'm'
  | 'piccola'    // populationTier 's'
  | 'capoluogo'
  | 'ciociaria';

function deriveAttrKeys(c: ComuneAttributes): AttrKey[] {
  const keys: AttrKey[] = [];
  if (c.isUniversitaria) keys.push('universitaria');
  if (c.isIndustriale)   keys.push('industriale');
  if (c.isTuristica)     keys.push('turistica');
  if (c.isStorica)       keys.push('storica');
  if (c.isTermale)       keys.push('termale');
  if (c.isPortuale)      keys.push('portuale');
  if (c.populationTier === 'xl') keys.push('metro');
  if (c.populationTier === 'l')  keys.push('grande');
  if (c.populationTier === 'm')  keys.push('media');
  if (c.populationTier === 's')  keys.push('piccola');
  if (c.isCapoluogo)     keys.push('capoluogo');
  if (c.isCiociariaTop)  keys.push('ciociaria');
  return keys;
}

// ─── Templates: (AttrKey × ServiceSlug) → (intro, angle) ────────────
// Tutti i template hanno il placeholder `{Comune}` interpolato a runtime.
// Ordine: più specifico → più generico. La factory pesca il primo match.

interface Template {
  intro: string;
  angle: string;
}

type ServiceTemplates = Partial<Record<AttrKey, Template>>;

const TEMPLATES: Record<ServiceSlug, ServiceTemplates> = {
  // ─── SITO WEB ─────────────────────────────────────────────────────
  'sito-web': {
    metro: {
      intro: 'A {Comune} la concorrenza online è altissima.',
      angle: 'A {Comune} ogni settore ha decine di competitor che si giocano gli stessi clienti su Google.\nUn sito web fatto come va, con SEO seria e contenuti che convertono, è quello che ti separa dall\'essere uno dei tanti.\nNon serve "esserci" — serve essere scelti.',
    },
    universitaria: {
      intro: 'A {Comune} il pubblico è giovane e digitale-first.',
      angle: 'A {Comune}, città universitaria, il tuo cliente nasce digitale: cerca su Google, confronta su Instagram, decide dal telefono.\nUn sito veloce e mobile-first è quello che ti rende rilevante.\nPer studenti, professori e giovani professionisti, la velocità è il primo segnale di professionalità.',
    },
    turistica: {
      intro: 'A {Comune} il turista decide online prima di partire.',
      angle: 'A {Comune}, dove il turismo è parte dell\'economia, il sito web è il primo punto di contatto.\nMultilingua, prenotazione integrata e foto autentiche.\nOgni dettaglio fa la differenza tra essere scelti o passati oltre in favore di un competitor.',
    },
    storica: {
      intro: '{Comune} ha una storia da raccontare. Anche online.',
      angle: 'A {Comune}, dove il patrimonio storico è parte dell\'identità, il sito web è l\'occasione per raccontare la tua attività con la stessa cura del contesto.\nDesign che rispetta il valore culturale, contenuti che valorizzano il legame col territorio: una presenza digitale che si sente di casa.',
    },
    industriale: {
      intro: 'A {Comune} il B2B passa anche dal sito.',
      angle: 'A {Comune}, polo produttivo, anche le PMI più solide si giocano clienti, fornitori e partner online.\nUn sito B2B chiaro, con catalogo strutturato, schede tecniche e form di richiesta preventivo che funzionano: è quello che converte chi ti cerca dopo una fiera o un\'email cold.',
    },
    portuale: {
      intro: 'A {Comune}, città di porto, il sito apre all\'estero.',
      angle: 'A {Comune}, dove il porto porta clienti italiani e stranieri, un sito multilingua con contenuti SEO localizzati ti fa trovare anche da chi cerca in inglese o in tedesco.\nNiente più confine geografico tra te e i tuoi prossimi clienti.',
    },
    termale: {
      intro: 'A {Comune}, terra di benessere, il sito vende l\'esperienza.',
      angle: 'A {Comune}, città termale, chi arriva ha già deciso di prendersi cura di sé.\nUn sito che racconta l\'esperienza con foto autentiche e prenotazione integrata.\nFa la differenza tra essere "una delle opzioni" o "la scelta giusta".',
    },
    ciociaria: {
      intro: 'A {Comune}, in Ciociaria, il sito ti fa trovare in zona.',
      angle: 'A {Comune}, conosco bene il mercato locale e i ritmi del territorio.\nUn sito ottimizzato per le ricerche "{servizio} a {Comune}" e dintorni, con SEO locale fatta seriamente, ti fa trovare quando i tuoi clienti potenziali stanno cercando proprio quello che offri.',
    },
    capoluogo: {
      intro: 'A {Comune}, capoluogo, la visibilità online conta doppio.',
      angle: 'A {Comune}, capoluogo di provincia, la concorrenza locale è robusta e la SEO è cruciale.\nUn sito ottimizzato per le ricerche locali, con contenuti pensati per il tuo settore specifico, ti porta clienti reali — non solo visite.',
    },
    media: {
      intro: 'A {Comune} il sito è il tuo passaparola digitale.',
      angle: 'A {Comune}, comune di medie dimensioni, il sito web è il modo più efficace per consolidare la reputazione locale.\nLe persone ti cercano dopo aver sentito parlare di te — se ti trovano con un sito chiaro e professionale, hai già fatto metà del lavoro.',
    },
    piccola: {
      intro: 'A {Comune}, anche un piccolo comune merita un sito serio.',
      angle: 'A {Comune}, dove il passaparola conta ma non basta, il sito web è quello che ti fa esistere oltre i confini del paese.\nPer chi cerca da fuori e vuole verificare prima di chiamare.\nPer chi semplicemente vuole capire chi sei e cosa offri.',
    },
  },

  // ─── E-COMMERCE ───────────────────────────────────────────────────
  'e-commerce': {
    universitaria: {
      intro: '{Comune} città universitaria: l\'e-commerce raddoppia il bacino.',
      angle: 'A {Comune}, dove l\'università porta migliaia di studenti e ricercatori, l\'e-commerce ti permette di servire sia il mercato locale che quello dei fuorisede.\nPagamenti rapidi, spedizioni veloci, shop mobile-first: tutto pensato per un pubblico abituato a comprare online.',
    },
    industriale: {
      intro: 'A {Comune}, polo produttivo, l\'e-commerce B2B fa volume.',
      angle: 'A {Comune}, dove l\'industria locale produce, un e-commerce B2B con catalogo strutturato, listini riservati, ordini ricorrenti e integrazione gestionale ti fa scalare le vendite senza moltiplicare i commerciali.\nI clienti business ordinano alle 22 di sera e tu li servi senza sforzo.',
    },
    turistica: {
      intro: 'A {Comune}, terra turistica, l\'e-commerce vende anche dopo.',
      angle: 'A {Comune}, città turistica, il visitatore vorrebbe portare a casa un pezzo del territorio.\nUn e-commerce di prodotti locali, gift card, esperienze prenotabili continua a vendere anche dopo la partenza dei tuoi ospiti.\nIl souvenir digitale che spedisci direttamente a casa loro.',
    },
    storica: {
      intro: 'A {Comune}, città storica, l\'e-commerce racconta tradizione.',
      angle: 'A {Comune}, dove il patrimonio è parte del valore del prodotto, un e-commerce ben curato racconta la storia dietro ogni articolo.\nFoto, descrizioni, contesto: vendi non solo l\'oggetto ma anche la sua origine. E i clienti pagano la storia, non solo la cosa.',
    },
    termale: {
      intro: 'A {Comune}, terra termale, l\'e-commerce vende benessere.',
      angle: 'A {Comune}, città termale, l\'e-commerce è il modo per portare a casa l\'esperienza wellness: prodotti, gift card, percorsi prenotabili online.\nI tuoi clienti cercano cura del benessere e tu gliela vendi anche a distanza, con una shopping experience pulita.',
    },
    portuale: {
      intro: 'A {Comune}, città di porto, l\'e-commerce parla al mercato globale.',
      angle: 'A {Comune}, dove la logistica portuale è nel DNA, un e-commerce multilingua con spedizioni internazionali è una scelta naturale.\nNiente confini geografici tra te e i tuoi clienti — il tuo prodotto raggiunge dove serve.',
    },
    metro: {
      intro: 'A {Comune}, metropoli, l\'e-commerce è ormai imprescindibile.',
      angle: 'A {Comune}, dove tutti i tuoi competitor sono già online, restare offline è decidere di rinunciare al 60% delle vendite.\nUn e-commerce moderno con pagamenti veloci, recovery email e analytics è quello che ti tiene al passo — non un lusso.',
    },
    ciociaria: {
      intro: 'A {Comune}, in Ciociaria, l\'e-commerce apre al mercato esterno.',
      angle: 'A {Comune}, dove il bacino locale è limitato, un e-commerce ti fa vendere oltre i confini del paese.\nProdotti tipici, artigianato, specialità: tutto può viaggiare.\nE un negozio di {Comune} può servire clienti a Roma, Milano, all\'estero — senza investimenti in punti vendita.',
    },
    capoluogo: {
      intro: 'A {Comune}, capoluogo, l\'e-commerce moltiplica la portata.',
      angle: 'A {Comune}, dove la concorrenza è già robusta, un e-commerce ben fatto ti fa servire anche i comuni della provincia che non possono raggiungerti fisicamente.\nUn negozio di {Comune} diventa il punto di riferimento di un\'intera area — senza aprire altri punti vendita.',
    },
    media: {
      intro: 'A {Comune}, l\'e-commerce porta il negozio fuori dal paese.',
      angle: 'A {Comune}, dove il passaparola locale fa molto ma non tutto, un e-commerce è il modo per intercettare i clienti che cercano online prodotti come i tuoi.\nSpese di spedizione configurate intelligentemente, pagamenti sicuri, formazione inclusa: gestisci ordini come gestisci il banco.',
    },
    piccola: {
      intro: 'A {Comune}, l\'e-commerce supera il limite del territorio.',
      angle: 'A {Comune}, dove la popolazione è limitata, l\'e-commerce ti permette di vendere a chi non passa fisicamente da qui.\nUn\'attività di paese che diventa raggiungibile da chiunque cerchi proprio quello che fai.',
    },
  },

  // ─── SEO ──────────────────────────────────────────────────────────
  'seo': {
    metro: {
      intro: 'A {Comune}, metropoli, la SEO è la differenza tra essere visti o no.',
      angle: 'A {Comune}, dove ogni keyword ha decine di competitor che fanno SEO seria, fermarsi al SEO tecnico di base significa restare a pagina 5.\nAudit completo, contenuto strategico, link building, monitoraggio mensile: l\'unico modo per scalare le SERP è portare traffico qualificato che converte.',
    },
    grande: {
      intro: 'A {Comune}, città importante, la SEO locale fa la differenza.',
      angle: 'A {Comune}, dove le ricerche "{servizio} a {Comune}" portano clienti veri ma la concorrenza è alta, una strategia SEO locale curata ti porta in cima ai risultati.\nGoogle Business Profile ottimizzato, schema LocalBusiness, contenuti per la tua zona: tutto coordinato per intercettare chi cerca proprio te.',
    },
    universitaria: {
      intro: 'A {Comune}, città universitaria, la SEO parla anche ai giovani.',
      angle: 'A {Comune} il pubblico online è ampio e variato: studenti, professori, giovani professionisti.\nUna SEO che cura long-tail keywords, contenuti freschi e un blog attivo ti fa intercettare ricerche specifiche che il competitor "sito vetrina" non vede nemmeno passare.',
    },
    industriale: {
      intro: 'A {Comune}, polo produttivo, la SEO B2B porta clienti seri.',
      angle: 'A {Comune}, dove le aziende cercano fornitori e partner online, una SEO B2B con keyword tecniche, contenuti settoriali e Google Search Console monitorata è quello che ti porta lead qualificati.\nNon click random — clienti che firmano contratti.',
    },
    turistica: {
      intro: 'A {Comune}, città turistica, la SEO multilingua apre al mondo.',
      angle: 'A {Comune}, dove i turisti pianificano la visita su Google, una SEO multilingua con contenuti localizzati e schema TravelGuide ti fa trovare anche da chi cerca in inglese, tedesco, francese.\nVisite reali tradotte in prenotazioni reali.',
    },
    ciociaria: {
      intro: 'A {Comune}, in Ciociaria, la SEO locale è quasi tutto.',
      angle: 'A {Comune}, in un mercato locale dove la concorrenza diretta non è enorme, la SEO ben fatta ti porta facilmente in cima.\nAudit, ottimizzazione locale, Google Business Profile, link building dai siti del territorio: pochi mesi e sei la prima scelta su Google.',
    },
    capoluogo: {
      intro: 'A {Comune}, capoluogo, la SEO è l\'investimento che frutta nel tempo.',
      angle: 'A {Comune}, dove i tuoi clienti cercano "{servizio} a {Comune}" ogni giorno, posizionarsi nei primi 3 risultati è meglio di qualsiasi campagna ads.\nAudit, strategia contenuti, link building, monitoraggio: 4-6 mesi di lavoro per un asset che lavora poi per anni.',
    },
    media: {
      intro: 'A {Comune}, la SEO locale rende invisibile la concorrenza.',
      angle: 'A {Comune}, dove i tuoi competitor diretti sono pochi, una SEO locale curata ti fa dominare le ricerche.\nAudit mirato, ottimizzazione delle pagine principali, contenuti settoriali, link da fonti locali: in 4-6 mesi diventi il riferimento per il tuo settore in zona.',
    },
    piccola: {
      intro: 'A {Comune}, anche un piccolo paese ha una SEO che vale.',
      angle: 'A {Comune}, dove le ricerche "{servizio} a {Comune}" sono poche ma rilevanti, anche una SEO leggera ben fatta ti porta praticamente al top.\nGoogle Business Profile ottimizzato, schema LocalBusiness, qualche pagina di qualità: investimento basso, risultati duraturi.',
    },
  },

  // ─── WEB APP ──────────────────────────────────────────────────────
  'sviluppo-web': {
    industriale: {
      intro: 'A {Comune}, polo produttivo, le web app sostituiscono fogli Excel.',
      angle: 'A {Comune}, dove le aziende strutturate ancora gestiscono ordini, magazzino e clienti via Excel + email, una web app gestionale fa scalare la produttività senza assumere.\nDashboard, integrazioni col gestionale esistente, automazioni: meno errori, più volume.',
    },
    metro: {
      intro: 'A {Comune}, metropoli, le web app sono asset.',
      angle: 'A {Comune}, feudo di attività che diventano subito complesse, una web app su misura sostituisce 4-5 tool generici con un sistema unico.\nRisparmi licenze, riduci errori da copia-incolla, scali senza rifare tutto da capo.',
    },
    universitaria: {
      intro: 'A {Comune}, città universitaria, le piattaforme digitali sono natura.',
      angle: 'A {Comune} il pubblico è abituato a piattaforme web.\nSistemi di prenotazione, area riservata utenti, dashboard per ordini ricorrenti: aspettative alte, esperienza fluida richiesta.\nUna web app ben fatta non ti distingue — ti rende competitivo.',
    },
    turistica: {
      intro: 'A {Comune}, terra turistica, le web app gestiscono prenotazioni e check-in.',
      angle: 'A {Comune}, dove il flusso turistico richiede sistemi di prenotazione, check-in, gestione pulizie e camere, una web app dedicata al tuo settore turistico ti libera dalle telefonate ripetitive.\nLavora 24/7, non si dimentica nulla, non si stanca.',
    },
    capoluogo: {
      intro: 'A {Comune}, capoluogo, una web app porta efficienza alle PMI locali.',
      angle: 'A {Comune}, dove molte PMI hanno processi già codificati ma gestiti a mano, una web app su misura riduce il tempo amministrativo del 30-50%.\nArea riservata clienti, dashboard operativa, automazioni mirate: scali senza assumere.',
    },
    media: {
      intro: 'A {Comune}, una web app sostituisce 4 tool generici.',
      angle: 'A {Comune}, dove molte attività medie pagano abbonamenti a Google Workspace + Mailchimp + Calendly + gestionale + ecc., una web app su misura unifica tutto in un\'interfaccia che parla la lingua del tuo lavoro.\nRisparmi soldi, semplifichi i collaboratori.',
    },
    piccola: {
      intro: 'A {Comune}, una web app vale solo se semplifica davvero.',
      angle: 'A {Comune}, dove i volumi sono limitati, una web app ha senso solo se elimina un dolore concreto.\nPrenotazioni telefoniche infinite, fatturazione manuale, ordini persi.\nQuando c\'è il problema giusto, anche un piccolo sistema cambia la giornata operativa.',
    },
  },
};

// ─── Fallback generico ───────────────────────────────────────────────
const FALLBACK: Record<ServiceSlug, Template> = {
  'sito-web': {
    intro: 'A {Comune}, un sito web fatto come va apre nuovi clienti.',
    angle: 'Lavoro con realtà come la tua a {Comune} per costruire siti che si fanno trovare e che convertono.\nDesign su misura, SEO locale, esperienza fluida su qualsiasi schermo.',
  },
  'e-commerce': {
    intro: 'A {Comune}, un e-commerce ben fatto allarga il bacino di clienti.',
    angle: 'A {Comune} progetto e-commerce che vendono davvero: catalogo strutturato, checkout veloce, pagamenti sicuri, tracking.\nNon template — sistemi che si adattano al tuo business.',
  },
  'seo': {
    intro: 'A {Comune}, la SEO porta clienti che già ti stanno cercando.',
    angle: 'A {Comune} faccio SEO seria: audit, keyword strategiche, contenuti, link building.\nNiente trucchi, solo lavoro che porta visite qualificate e clienti veri.',
  },
  'sviluppo-web': {
    intro: 'A {Comune}, una web app su misura sostituisce 4 tool generici.',
    angle: 'A {Comune} costruisco web app che semplificano i processi: aree riservate, dashboard, prenotazioni, integrazioni.\nCodice pulito, scalabile, tuo.',
  },
};

// ─── Service labels (per "{servizio}" placeholder) ──────────────────
const SERVICE_LABELS: Record<ServiceSlug, string> = {
  'sito-web':              'sito web',
  'e-commerce':            'e-commerce',
  'seo':                   'SEO',
  'sviluppo-web':               'web app',
};

// ─── Factory ────────────────────────────────────────────────────────
function interpolate(tpl: string, comuneNome: string, serviceLabel: string): string {
  return tpl.replace(/\{Comune\}/g, comuneNome).replace(/\{servizio\}/g, serviceLabel);
}

/**
 * Restituisce contenuto unico per la combo (comune × service).
 * - Pesca il template piu specifico in base agli attributi del comune
 * - Cade su FALLBACK se nessun template specifico matcha
 * - Output deterministico: stesso input = stesso output
 */
export function getComboContent(comuneSlug: string, serviceSlug: ServiceSlug): ComboContent {
  const comune = COMUNE_ATTRIBUTES[comuneSlug];
  const serviceTemplates = TEMPLATES[serviceSlug];
  const fallback = FALLBACK[serviceSlug];
  const serviceLabel = SERVICE_LABELS[serviceSlug];

  if (!comune || !serviceTemplates) {
    return {
      intro: interpolate(fallback.intro, comune?.nome ?? comuneSlug, serviceLabel),
      localAngle: interpolate(fallback.angle, comune?.nome ?? comuneSlug, serviceLabel),
    };
  }

  const attrKeys = deriveAttrKeys(comune);
  for (const key of attrKeys) {
    const tpl = serviceTemplates[key];
    if (tpl) {
      return {
        intro: interpolate(tpl.intro, comune.nome, serviceLabel),
        localAngle: interpolate(tpl.angle, comune.nome, serviceLabel),
      };
    }
  }

  return {
    intro: interpolate(fallback.intro, comune.nome, serviceLabel),
    localAngle: interpolate(fallback.angle, comune.nome, serviceLabel),
  };
}

/** Helper per il page route: ritorna anche la preposizione corretta. */
export function getComboMeta(comuneSlug: string, serviceSlug: ServiceSlug): {
  comune: ComuneAttributes | undefined;
  preposizione: string;
  serviceLabel: string;
  content: ComboContent;
} {
  const comune = COMUNE_ATTRIBUTES[comuneSlug];
  return {
    comune,
    preposizione: comune ? getPreposizione(comune.nome) : 'a',
    serviceLabel: SERVICE_LABELS[serviceSlug],
    content: getComboContent(comuneSlug, serviceSlug),
  };
}
