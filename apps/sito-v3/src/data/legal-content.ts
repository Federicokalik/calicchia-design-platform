export type LegalSection = {
  id: string;
  number: string;
  heading: string;
  paragraphs?: string[];
  list?: string[];
  subsections?: LegalSection[];
};

export type LegalDocument = {
  slug: 'cookie-policy' | 'privacy-policy' | 'termini-e-condizioni';
  title: string;
  intro: string;
  lastUpdated: string;
  sections: LegalSection[];
};

export const TITOLARE_EMAIL = 'mail@calicchia.design';
export const LAST_LEGAL_UPDATE = '2026-05-05';

const TITOLARE = 'Federico Calicchia';
const TITOLARE_ADDRESS = 'Via Scifelli 74, Ceccano 03023 FR';
const TITOLARE_VAT = 'P.IVA 03160480608';
const OPERATING_AREA = 'Frosinone, Ciociaria';

export const LEGAL_CONTENT: Record<LegalDocument['slug'], LegalDocument> = {
  'cookie-policy': {
    slug: 'cookie-policy',
    title: 'Cookie Policy',
    intro:
      'Informativa sull’uso di cookie e tecnologie simili,\naggiornata allo stack corrente del sito.',
    lastUpdated: LAST_LEGAL_UPDATE,
    sections: [
      {
        id: 'cosa-sono-cookie',
        number: '01',
        heading: 'Cosa sono i cookie',
        paragraphs: [
          'I cookie sono piccoli file di testo salvati sul dispositivo quando visiti un sito web.\nServono a memorizzare informazioni tecniche o preferenze necessarie alla navigazione.',
          'Tecnologie simili, come sessionStorage e localStorage, possono essere utilizzate per finalità analoghe.\nIn questa informativa le tratto insieme ai cookie quando hanno effetti comparabili.'
        ]
      },
      {
        id: 'cookie-utilizzati',
        number: '02',
        heading: 'Cookie e tecnologie utilizzate',
        paragraphs: [
          'Il sito usa solo le tecnologie necessarie al funzionamento, alla sicurezza e,\nprevio consenso quando richiesto, alla misurazione aggregata.\nI servizi non necessari vengono caricati solo se compatibili con le preferenze espresse.'
        ],
        subsections: [
          {
            id: 'cookie-tecnici',
            number: '02.01',
            heading: 'Cookie tecnici necessari',
            paragraphs: [
              'Sono essenziali per far funzionare il sito, mantenere le preferenze espresse e proteggere i form.\nNon richiedono consenso ai sensi della normativa vigente.'
            ],
            list: [
              'Next.js own data e sessionStorage: gestione tecnica della navigazione, stato temporaneo dell’interfaccia e transizioni locali; durata di sessione o finché il browser conserva il dato.',
              'Middleware locale: routing, localizzazione e controlli tecnici lato server; nessuna profilazione.',
              'cookie_consent: memorizza le preferenze cookie espresse; durata 6 mesi.',
              'Eventuali cookie di autenticazione HttpOnly: usati solo per aree riservate o amministrative; durata tecnica collegata alla sessione o alla sicurezza del servizio.'
            ]
          },
          {
            id: 'sicurezza-turnstile',
            number: '02.02',
            heading: 'Sicurezza e anti-bot',
            paragraphs: [
              'I form possono usare Cloudflare Turnstile per distinguere traffico umano da traffico automatico.\nIl token è transitorio, serve alla verifica anti-bot e non viene usato per tracciamento marketing.'
            ],
            list: [
              'Cloudflare Turnstile: token anti-bot temporaneo, dati tecnici minimi di interazione, finalità di sicurezza.'
            ]
          },
          {
            id: 'analytics-trustindex',
            number: '02.03',
            heading: 'Analytics e recensioni',
            paragraphs: [
              'Se attivo e consentito, TrustIndex può fornire analytics aggregato legato al widget recensioni.\nIl trattamento è aggregato, senza profilazione e senza conservazione di IP raw da parte del sito.'
            ],
            list: [
              'TrustIndex: widget recensioni e statistiche aggregate; caricamento subordinato alle impostazioni del banner quando richiesto.'
            ]
          },
          {
            id: 'error-tracking-bugsink',
            number: '02.04',
            heading: 'Error tracking',
            paragraphs: [
              'Bugsink non è attivo nella versione corrente del sito.\nSarà eventualmente attivato in una fase successiva per raccogliere errori tecnici, senza finalità di profilazione.'
            ]
          },
          {
            id: 'mappe-google',
            number: '02.05',
            heading: 'Mappe e contenuti esterni',
            paragraphs: [
              'La mappa nel footer può caricare Google Maps solo dopo consenso ai contenuti di terze parti.\nPrima del consenso viene mostrato un placeholder.'
            ],
            list: [
              'Google Maps: visualizzazione mappa e indicazioni; può trattare IP, dati tecnici del browser e cookie Google secondo le policy del fornitore.'
            ]
          },
          {
            id: 'servizi-rimossi',
            number: '02.06',
            heading: 'Servizi non utilizzati',
            paragraphs: [
              'Il sito non carica embed di prenotazione di terze parti.\nLa prenotazione, quando disponibile, viene gestita con stack proprietario o link interni.'
            ]
          }
        ]
      },
      {
        id: 'gestione-preferenze',
        number: '03',
        heading: 'Gestione delle preferenze',
        paragraphs: [
          'Al primo accesso puoi accettare, rifiutare o personalizzare le preferenze dal banner cookie.\nPuoi modificare le scelte in qualsiasi momento tramite il comando di gestione cookie, quando presente nel footer o nell’interfaccia del sito.',
          'Puoi anche bloccare o cancellare cookie e dati locali dalle impostazioni del browser.\nLa disattivazione dei cookie tecnici può compromettere alcune funzioni del sito.'
        ],
        list: [
          'Chrome: Impostazioni, Privacy e sicurezza, Cookie.',
          'Firefox: Impostazioni, Privacy e sicurezza, Cookie e dati dei siti.',
          'Safari: Preferenze, Privacy, Cookie e dati di siti web.',
          'Edge: Impostazioni, Cookie e autorizzazioni sito.'
        ]
      },
      {
        id: 'revoca-consenso',
        number: '04',
        heading: 'Revoca del consenso',
        paragraphs: [
          'Il consenso ai servizi non tecnici può essere revocato in qualsiasi momento.\nLa revoca non pregiudica la liceità del trattamento basato sul consenso prestato prima della revoca.'
        ],
        list: [
          'Riaprendo il pannello preferenze cookie.',
          'Cancellando cookie e dati del sito dal browser.',
          `Scrivendo a ${TITOLARE_EMAIL}.`
        ]
      },
      {
        id: 'riferimenti-normativi-cookie',
        number: '05',
        heading: 'Riferimenti normativi',
        list: [
          'Regolamento UE 2016/679 (GDPR), in particolare artt. 6, 7, 13, 14 e 15-22.',
          'D.Lgs. 196/2003 e successive modifiche e integrazioni.',
          'Provvedimento del Garante Privacy n. 229 dell’8/2021, Linee guida cookie e altri strumenti di tracciamento.',
          'Direttiva 2002/58/CE, direttiva ePrivacy.'
        ]
      },
      {
        id: 'contatti-cookie',
        number: '06',
        heading: 'Contatti',
        paragraphs: [
          `Per qualsiasi domanda sui cookie o sulle tecnologie utilizzate puoi contattarmi a ${TITOLARE_EMAIL}.`
        ]
      }
    ]
  },
  'privacy-policy': {
    slug: 'privacy-policy',
    title: 'Privacy Policy',
    intro:
      'Informativa sul trattamento dei dati personali\nai sensi degli artt. 13 e 14 del GDPR.',
    lastUpdated: LAST_LEGAL_UPDATE,
    sections: [
      {
        id: 'titolare-trattamento',
        number: '01',
        heading: 'Titolare del trattamento',
        paragraphs: [
          `Il Titolare del trattamento è ${TITOLARE}, persona fisica, con sede in ${TITOLARE_ADDRESS}.`,
          `${TITOLARE_VAT}. Email per richieste privacy: ${TITOLARE_EMAIL}. Sede operativa: ${OPERATING_AREA}.`
        ]
      },
      {
        id: 'dati-raccolti',
        number: '02',
        heading: 'Tipologie di dati raccolti',
        paragraphs: [
          'Il sito raccoglie dati personali autonomamente o tramite servizi tecnici di terze parti,\nnei limiti necessari alle finalità indicate.'
        ],
        list: [
          'Dati di navigazione: indirizzo IP o dato tecnico equivalente, user-agent, pagine visitate, data e ora di accesso, referrer, log tecnici e di sicurezza.',
          'Dati forniti volontariamente tramite form: nome, email, telefono se richiesto, azienda se indicata, messaggio, servizi o settori di interesse.',
          'Dati newsletter, se il servizio viene attivato: email e nome facoltativo.',
          'Dati area clienti: nome, email, ragione sociale, indirizzo di fatturazione, telefono, documenti e informazioni di progetto.',
          'Cookie e tecnologie simili: dettagli nella Cookie Policy.'
        ]
      },
      {
        id: 'finalita-basi-giuridiche',
        number: '03',
        heading: 'Finalità e basi giuridiche',
        list: [
          'Rispondere a richieste di contatto e preventivo: art. 6(1)(b) GDPR, misure precontrattuali.',
          'Fornire servizi contrattualizzati e area clienti: art. 6(1)(b) GDPR, esecuzione del contratto.',
          'Gestire richieste privacy e adempimenti legali: art. 6(1)(c) GDPR, obbligo legale.',
          'Inviare newsletter o comunicazioni facoltative: art. 6(1)(a) GDPR, consenso esplicito e revocabile.',
          'Misurare traffico e uso del sito con strumenti aggregati, se attivi: art. 6(1)(a) GDPR, consenso.',
          'Garantire sicurezza, prevenzione abusi e protezione anti-bot: art. 6(1)(f) GDPR, interesse legittimo.',
          'Gestire obblighi fiscali e contabili: art. 6(1)(c) GDPR, obbligo legale.'
        ]
      },
      {
        id: 'conferimento-dati',
        number: '04',
        heading: 'Conferimento dei dati',
        list: [
          'Obbligatorio per i campi necessari a rispondere a una richiesta o fornire un servizio, come email e descrizione della richiesta.',
          'Facoltativo per telefono, azienda, dettagli aggiuntivi e dati non essenziali.',
          'Facoltativo per newsletter e cookie non tecnici, basati su consenso revocabile.'
        ]
      },
      {
        id: 'modalita-trattamento',
        number: '05',
        heading: 'Modalità di trattamento',
        paragraphs: [
          'I dati sono trattati con strumenti informatici e telematici,\ncon logiche strettamente correlate alle finalità dichiarate.\nAdotto misure tecniche e organizzative proporzionate al rischio.'
        ],
        list: [
          'Comunicazioni protette tramite HTTPS/TLS.',
          'Accessi riservati con credenziali e cookie HttpOnly dove necessari.',
          'Controllo degli accessi alle aree amministrative.',
          'Log tecnici per sicurezza e manutenzione.',
          'Protezione anti-bot sui form pubblici tramite Cloudflare Turnstile.'
        ]
      },
      {
        id: 'conservazione-dati',
        number: '06',
        heading: 'Conservazione dei dati',
        list: [
          'Dati di contatto e preventivo: fino a 24 mesi dalla richiesta, salvo instaurazione di un rapporto contrattuale.',
          'Dati newsletter: fino a revoca, disiscrizione o richiesta di cancellazione.',
          'Dati contrattuali e di fatturazione: 10 anni per obblighi fiscali e contabili.',
          'Log tecnici e di sicurezza: per il tempo necessario alla protezione del sito e comunque in misura proporzionata.',
          'Consensi cookie: di norma 6 mesi, salvo rinnovo o modifica normativa/tecnica.',
          'Richieste privacy: conservate per documentare l’adempimento agli obblighi GDPR.'
        ]
      },
      {
        id: 'comunicazione-dati',
        number: '07',
        heading: 'Comunicazione dei dati',
        paragraphs: [
          'I dati possono essere comunicati a soggetti che supportano il funzionamento del sito o l’esecuzione dei servizi,\nnei limiti del ruolo ricoperto.'
        ],
        list: [
          'Fornitori tecnici di hosting, email, infrastruttura, sicurezza e manutenzione.',
          'Consulenti fiscali o legali, se necessario.',
          'Autorità competenti, quando richiesto dalla legge.',
          'I dati non vengono venduti a terzi e non vengono diffusi pubblicamente.'
        ]
      },
      {
        id: 'servizi-terze-parti',
        number: '08',
        heading: 'Servizi di terze parti',
        list: [
          'Cloudflare: sicurezza, protezione anti-bot e Turnstile.',
          'Resend o provider email equivalente: invio email transazionali e notifiche.',
          'Stripe e PayPal: pagamenti e fatturazione quando usati nei servizi contrattualizzati.',
          'Google Maps: mappa nel footer, caricata solo previo consenso ai contenuti di terze parti.',
          'TrustIndex: recensioni e analytics aggregato del widget, se attivo.',
          'Bugsink: non attivo nella versione corrente del sito; eventuale error tracking tecnico in fase successiva.'
        ]
      },
      {
        id: 'trasferimenti-extra-ue',
        number: '09',
        heading: 'Trasferimenti extra UE',
        paragraphs: [
          'Alcuni fornitori tecnici possono avere sede o infrastrutture fuori dallo Spazio Economico Europeo.\nIn questi casi il trasferimento avviene sulla base di garanzie adeguate,\ncome EU-US Data Privacy Framework ove applicabile o Standard Contractual Clauses approvate dalla Commissione Europea.'
        ]
      },
      {
        id: 'no-profilazione',
        number: '10',
        heading: 'Decisioni automatizzate e profilazione',
        paragraphs: [
          'Il sito non effettua decisioni basate unicamente su trattamento automatizzato,\ncompresa la profilazione, che producano effetti giuridici\no incidano significativamente sull’interessato ai sensi dell’art. 22 GDPR.'
        ]
      },
      {
        id: 'diritti-interessato',
        number: '11',
        heading: 'Diritti dell’interessato',
        paragraphs: [
          'Ai sensi degli artt. 15-22 del GDPR puoi esercitare i diritti riconosciuti dalla normativa.\nRispondo entro 30 giorni dal ricevimento della richiesta,\nsalvo proroghe consentite dalla legge in casi complessi.'
        ],
        list: [
          'Accesso ai dati personali, art. 15 GDPR.',
          'Rettifica di dati inesatti o incompleti, art. 16 GDPR.',
          'Cancellazione, art. 17 GDPR.',
          'Limitazione del trattamento, art. 18 GDPR.',
          'Portabilità dei dati, art. 20 GDPR.',
          'Opposizione al trattamento, art. 21 GDPR.',
          'Revoca del consenso in qualsiasi momento, art. 7 GDPR.'
        ]
      },
      {
        id: 'come-esercitare-diritti',
        number: '12',
        heading: 'Come esercitare i diritti',
        list: [
          `Scrivendo a ${TITOLARE_EMAIL}.`,
          'Utilizzando il modulo richieste privacy disponibile su /privacy-request.'
        ]
      },
      {
        id: 'reclamo-garante',
        number: '13',
        heading: 'Diritto di reclamo',
        paragraphs: [
          'Hai diritto di proporre reclamo al Garante per la Protezione dei Dati Personali,\nPiazza Venezia 11, 00187 Roma, email protocollo@gpdp.it, PEC protocollo@pec.gpdp.it,\nsito www.garanteprivacy.it.'
        ]
      },
      {
        id: 'modifiche-privacy',
        number: '14',
        heading: 'Modifiche alla privacy policy',
        paragraphs: [
          'Questa informativa può essere aggiornata.\nLa versione corrente resta disponibile su questa pagina con la data di ultimo aggiornamento.'
        ]
      }
    ]
  },
  'termini-e-condizioni': {
    slug: 'termini-e-condizioni',
    title: 'Termini e Condizioni',
    intro:
      'Condizioni generali per l’uso del sito e per i rapporti relativi ai servizi professionali.',
    lastUpdated: LAST_LEGAL_UPDATE,
    sections: [
      {
        id: 'identificazione-titolare',
        number: '01',
        heading: 'Identificazione del titolare',
        paragraphs: [
          `${TITOLARE}, ${TITOLARE_ADDRESS}, ${TITOLARE_VAT}.\nEmail: ${TITOLARE_EMAIL}. Sede operativa: ${OPERATING_AREA}.`
        ]
      },
      {
        id: 'oggetto',
        number: '02',
        heading: 'Oggetto',
        paragraphs: [
          'I presenti Termini e Condizioni regolano l’utilizzo del sito Caldes / Calicchia Design\ne i rapporti contrattuali relativi ai servizi professionali offerti.'
        ]
      },
      {
        id: 'servizi-offerti',
        number: '03',
        heading: 'Servizi offerti',
        paragraphs: [
          'I servizi v3 sono organizzati in cinque aree principali.\nEventuali attività accessorie vengono concordate nel preventivo e\nnon costituiscono automaticamente un servizio autonomo.'
        ],
        list: [
          'Web Design.',
          'Sviluppo Web.',
          'Branding.',
          'E-commerce.',
          'SEO.'
        ]
      },
      {
        id: 'preventivi-ordini',
        number: '04',
        heading: 'Preventivi e ordini',
        list: [
          'I preventivi sono gratuiti e senza impegno, salvo diversa indicazione scritta.',
          'I preventivi hanno validità di 30 giorni dalla data di emissione.',
          'L’ordine si perfeziona con accettazione scritta del preventivo e pagamento dell’acconto, quando previsto.',
          'Ogni modifica in corso d’opera deve essere concordata e può comportare variazioni di prezzo, scope e tempistiche.',
          'L’offerta descrive deliverable, tempi stimati, condizioni di pagamento e perimetro del servizio.'
        ]
      },
      {
        id: 'prezzi-pagamenti',
        number: '05',
        heading: 'Prezzi e pagamenti',
        list: [
          'I prezzi indicati nel preventivo sono comprensivi di IVA se dovuta.',
          'Modalità standard, salvo diversa pattuizione: acconto all’accettazione, saldo o milestone intermedie durante il progetto.',
          'Per importi superiori a 1.000 euro può essere concordato un pagamento rateale senza interessi.',
          'I pagamenti possono essere effettuati tramite bonifico bancario, Stripe o altri metodi indicati nel preventivo.',
          'In caso di ritardato pagamento il progetto può essere sospeso fino al saldo.'
        ]
      },
      {
        id: 'tempistiche',
        number: '06',
        heading: 'Tempistiche',
        list: [
          'Le tempistiche indicate nel preventivo sono stime operative e non termini essenziali, salvo accordo scritto.',
          'I tempi decorrono dalla ricezione dei materiali necessari: testi, immagini, accessi, contenuti e informazioni richieste.',
          'Ritardi nella fornitura dei materiali da parte del cliente comportano slittamento delle tempistiche.',
          'In caso di ritardi significativi imputabili al prestatore, il cliente viene informato tempestivamente.'
        ]
      },
      {
        id: 'revisioni-modifiche',
        number: '07',
        heading: 'Revisioni e modifiche',
        list: [
          'Il preventivo include il numero di revisioni specificato nell’offerta.',
          'Revisioni aggiuntive oltre quelle incluse vengono quotate separatamente.',
          'Le richieste di revisione devono essere comunicate in modo chiaro e completo.'
        ]
      },
      {
        id: 'proprieta-intellettuale',
        number: '08',
        heading: 'Proprietà intellettuale',
        list: [
          'Il codice sorgente e gli asset sviluppati su misura diventano di proprietà del cliente al saldo completo, salvo diversa indicazione.',
          'Librerie, framework, plugin e strumenti open source mantengono le rispettive licenze.',
          'Mi riservo il diritto di includere il progetto nel portfolio, salvo diverso accordo scritto.',
          'Il cliente garantisce di possedere i diritti sui contenuti forniti: testi, immagini, loghi, marchi e materiali.'
        ]
      },
      {
        id: 'hosting-terze-parti',
        number: '09',
        heading: 'Hosting e terze parti',
        list: [
          'Hosting, dominio e servizi di terze parti non sono inclusi nel prezzo, salvo diversa indicazione nel preventivo.',
          'Posso consigliare provider specifici, ma la scelta finale spetta al cliente.',
          'Non rispondo di disservizi causati da provider esterni, salvo responsabilità diretta e provata.'
        ]
      },
      {
        id: 'garanzia-supporto',
        number: '10',
        heading: 'Garanzia e supporto',
        list: [
          'Ogni progetto include il supporto indicato nel preventivo; in assenza di indicazione specifica, 30 giorni dalla consegna.',
          'Il supporto copre bug e malfunzionamenti imputabili al lavoro consegnato, non nuove funzionalità o modifiche fuori scope.',
          'Pacchetti di manutenzione continuativa possono essere concordati separatamente.'
        ]
      },
      {
        id: 'limitazione-responsabilita',
        number: '11',
        heading: 'Limitazione di responsabilità',
        paragraphs: [
          'Nei limiti consentiti dalla legge, non sono responsabile per eventi che dipendono da uso improprio,\nservizi di terze parti, contenuti forniti dal cliente o fattori fuori dal mio controllo diretto.'
        ],
        list: [
          'Danni diretti o indiretti derivanti dall’uso del sito web del cliente.',
          'Perdita di dati causata da provider di hosting o servizi terzi.',
          'Violazioni dei diritti di terzi causate dai contenuti forniti dal cliente.',
          'Risultati SEO garantiti: il posizionamento dipende da molteplici fattori non controllabili.'
        ]
      },
      {
        id: 'recesso',
        number: '12',
        heading: 'Recesso',
        list: [
          'Il cliente può recedere dal contratto in qualsiasi momento.',
          'In caso di recesso sono dovuti i compensi per il lavoro già svolto e per i costi non recuperabili sostenuti.',
          'L’acconto versato non è rimborsabile se il lavoro è già stato avviato, salvo diverso accordo scritto.'
        ]
      },
      {
        id: 'foro-competente',
        number: '13',
        heading: 'Foro competente',
        paragraphs: [
          'Per qualsiasi controversia derivante dai presenti Termini e Condizioni\nè competente in via esclusiva il Foro di Frosinone,\nsalvo norme inderogabili applicabili al cliente consumatore.'
        ]
      },
      {
        id: 'modifiche-termini',
        number: '14',
        heading: 'Modifiche ai termini',
        paragraphs: [
          'I presenti Termini e Condizioni possono essere modificati.\nLe modifiche vengono pubblicate su questa pagina con la data di ultimo aggiornamento.'
        ]
      },
      {
        id: 'contatti-termini',
        number: '15',
        heading: 'Contatti',
        paragraphs: [
          `Per qualsiasi domanda sui presenti termini puoi scrivermi a ${TITOLARE_EMAIL}.`
        ]
      }
    ]
  }
};
