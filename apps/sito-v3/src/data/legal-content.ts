export type LegalSection = {
  id: string;
  number: string;
  heading: string;
  paragraphs?: string[];
  list?: string[];
  subsections?: LegalSection[];
};

export type LegalDocument = {
  slug: 'cookie-policy' | 'privacy-policy' | 'termini-e-condizioni' | 'dpa-clienti';
  title: string;
  intro: string;
  lastUpdated: string;
  sections: LegalSection[];
};

export const TITOLARE_EMAIL = 'mail@calicchia.design';
export const LAST_LEGAL_UPDATE = '2026-05-24';

/**
 * Major version dei documenti gating-ati nel portale clienti (T&C + DPA).
 * Mirror di `apps/api/src/lib/legal-versions.ts` — tenere sincronizzati.
 * Bump = nuovo prompt al prossimo login del cliente.
 */
export const LEGAL_MAJOR_VERSIONS = {
  'termini-e-condizioni': '1',
  'dpa-clienti': '1',
} as const;

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
              'cookie_consent: memorizza le preferenze cookie espresse; durata 6 mesi.',
              'NEXT_LOCALE: memorizza la lingua scelta (IT/EN) per non doverla riselezionare a ogni visita; durata 1 anno.',
              'LANG_BANNER_DISMISSED: ricorda la chiusura del banner che suggerisce la versione inglese; durata 1 anno.',
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
            id: 'analytics-google',
            number: '02.03',
            heading: 'Analytics aggregato',
            paragraphs: [
              'Se hai prestato consenso alla categoria Analytics, il sito carica strumenti di misurazione aggregata del traffico e di analisi di usabilità. I dati sono trattati in forma anonimizzata o aggregata, senza profilazione individuale.'
            ],
            list: [
              'Google Analytics 4: pagine viste, eventi, durata sessione. Cookie `_ga` e `_ga_<measurement-id>` con durata 13 mesi. Titolare: Google Ireland Ltd.',
              'Mouseflow: heatmap e session replay aggregati con input dei form mascherati di default. Cookie `mf_user` con durata 12 mesi. Titolare: Mouseflow ApS (Danimarca).'
            ]
          },
          {
            id: 'analytics-trustindex',
            number: '02.04',
            heading: 'Recensioni e widget di terze parti',
            paragraphs: [
              "Previo consenso alla categoria Marketing/Terze parti, il sito può caricare widget esterni che mostrano contenuti di terze parti."
            ],
            list: [
              'TrustIndex: widget recensioni verificate; carica contenuto dalla CDN del fornitore. Cookie `ti-cookie` di sessione. Titolare: Trustindex Innovacios Kft. (Ungheria).'
            ]
          },
          {
            id: 'error-tracking-bugsink',
            number: '02.05',
            heading: 'Error tracking',
            paragraphs: [
              "Per garantire la stabilità del sito raccolgo errori tecnici tramite un'istanza Bugsink self-hosted. La raccolta avviene anche in assenza di consenso ai cookie analytics/marketing perché basata su interesse legittimo (art. 6(1)(f) GDPR) e limitata a stack trace e breadcrumb tecnici.",
              'Email, telefono, nome, token e indirizzo IP vengono filtrati lato client e sostituiti con [redacted] prima dell\'invio (hook `beforeSend` dello SDK Sentry). Bugsink è ospitato sulla mia infrastruttura, nessun trasferimento extra-UE.'
            ],
            list: [
              'Bugsink (self-hosted): stack trace, breadcrumb UI, URL anonimizzato (querystring rimossa). Conservazione 90 giorni. Titolare: Calicchia Design (self-hosted).'
            ]
          },
          {
            id: 'mappe-google',
            number: '02.06',
            heading: 'Mappe e contenuti esterni',
            paragraphs: [
              'La mappa nel footer può caricare Google Maps solo dopo consenso ai contenuti di terze parti.\nPrima del consenso viene mostrato un placeholder.'
            ],
            list: [
              'Google Maps: visualizzazione mappa e indicazioni. Cookie `NID` con durata 6 mesi. Può trattare IP e dati tecnici del browser secondo le policy del fornitore. Titolare: Google Ireland Ltd.'
            ]
          },
          {
            id: 'servizi-rimossi',
            number: '02.07',
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
          'Dati newsletter, se il servizio viene attivato: email, nome facoltativo, IP e user-agent al momento dell’iscrizione e della conferma (prova del consenso).',
          'Dati area clienti: nome, email, ragione sociale, indirizzo di fatturazione, telefono, documenti e informazioni di progetto.',
          'Comunicazioni WhatsApp con clienti e contatti commerciali: numero di telefono, contenuto dei messaggi scambiati, metadati tecnici (timestamp, stato lettura), preferenze di comunicazione e relativi opt-in/opt-out.',
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
          'Diagnosticare errori tecnici e garantire la stabilità del sito tramite error tracking self-hosted, con PII filtrate lato client prima dell\'invio: art. 6(1)(f) GDPR, interesse legittimo.',
          'Inviare comunicazioni WhatsApp transazionali (fatture, scadenze, avvisi di sicurezza) a clienti contrattualizzati: art. 6(1)(b) GDPR, esecuzione del contratto.',
          'Inviare comunicazioni WhatsApp operative (reminder appuntamenti, follow-up progetti) con possibilità di opt-out granulare: art. 6(1)(f) GDPR, interesse legittimo.',
          'Inviare comunicazioni WhatsApp di marketing solo su consenso esplicito e revocabile (default OFF): art. 6(1)(a) GDPR, consenso.',
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
          'Messaggi WhatsApp transazionali (fatture, scadenze): 10 anni allineati agli obblighi fiscali. Messaggi operativi e di marketing: cancellabili a opt-out o su richiesta GDPR.',
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
          'Google Analytics 4 e Mouseflow: misurazione aggregata e analisi di usabilità, caricati solo previo consenso analytics.',
          'Bugsink (self-hosted): error tracking tecnico su base di interesse legittimo, con PII filtrate prima dell\'invio.',
          'Meta Platforms Ireland Ltd. / WhatsApp LLC: i messaggi WhatsApp transitano per l\'infrastruttura Meta per essere recapitati al dispositivo del destinatario. Il gateway tecnico (GOWA) è self-hosted, ma Meta riceve metadati e contenuto dei messaggi secondo i termini WhatsApp Business.'
        ]
      },
      {
        id: 'trasferimenti-extra-ue',
        number: '09',
        heading: 'Trasferimenti extra UE',
        paragraphs: [
          'Alcuni fornitori tecnici possono avere sede o infrastrutture fuori dallo Spazio Economico Europeo.\nIn questi casi il trasferimento avviene sulla base di garanzie adeguate,\ncome EU-US Data Privacy Framework ove applicabile o Standard Contractual Clauses approvate dalla Commissione Europea.',
          'In particolare Meta Platforms (WhatsApp) e Google aderiscono all\'EU-US Data Privacy Framework; Mouseflow ha sede in Danimarca (UE).'
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
          'I presenti Termini e Condizioni regolano l’utilizzo del sito Calicchia Design (Federico Calicchia)\ne i rapporti contrattuali relativi ai servizi professionali offerti.\nL’uso del sito comporta accettazione integrale di queste condizioni.'
        ]
      },
      {
        id: 'uso-del-sito',
        number: '03',
        heading: 'Uso del sito',
        paragraphs: [
          'Il sito è messo a disposizione gratuitamente per finalità di informazione,\nconsultazione del portfolio e richiesta di preventivi.\nL’accesso e l’uso devono avvenire nel rispetto della legge e dei presenti Termini.'
        ],
        list: [
          'È vietato qualsiasi uso automatizzato del sito (scraping massivo, crawling intensivo, bot non autorizzati) che possa comprometterne la stabilità o aggirare le misure anti-bot.',
          'È vietato tentare di accedere ad aree riservate, alterare contenuti, o compromettere la sicurezza del sito o dei suoi utenti.',
          'I contenuti del sito (testi, immagini, layout, codice) sono protetti da diritto d’autore. Sono ammessi citazione e link in conformità alla normativa applicabile.',
          'Mi riservo il diritto di sospendere o limitare l’accesso in caso di abuso, attività illecita o violazione dei presenti Termini.'
        ]
      },
      {
        id: 'servizi-offerti',
        number: '04',
        heading: 'Servizi offerti',
        paragraphs: [
          'I servizi sono organizzati in cinque aree principali.\nEventuali attività accessorie vengono concordate nel preventivo e\nnon costituiscono automaticamente un servizio autonomo.'
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
        number: '05',
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
        number: '06',
        heading: 'Prezzi e pagamenti',
        list: [
          'I prezzi indicati nel preventivo sono comprensivi di IVA se dovuta.',
          'Modalità standard, salvo diversa pattuizione: acconto all’accettazione, saldo o milestone intermedie durante il progetto.',
          'Per importi superiori a 1.000 euro può essere concordato un pagamento rateale senza interessi.',
          'I pagamenti possono essere effettuati tramite bonifico bancario, Stripe, PayPal o altri metodi indicati nel preventivo.',
          'In caso di ritardato pagamento il progetto può essere sospeso fino al saldo. Decorsi 30 giorni dalla scadenza possono essere applicati interessi moratori ai sensi del D.Lgs. 231/2002 per i rapporti tra professionisti.'
        ]
      },
      {
        id: 'tempistiche',
        number: '07',
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
        number: '08',
        heading: 'Revisioni e modifiche',
        list: [
          'Il preventivo include il numero di revisioni specificato nell’offerta.',
          'Revisioni aggiuntive oltre quelle incluse vengono quotate separatamente.',
          'Le richieste di revisione devono essere comunicate in modo chiaro e completo.'
        ]
      },
      {
        id: 'proprieta-intellettuale',
        number: '09',
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
        number: '10',
        heading: 'Hosting e terze parti',
        list: [
          'Hosting, dominio e servizi di terze parti non sono inclusi nel prezzo, salvo diversa indicazione nel preventivo.',
          'Posso consigliare provider specifici, ma la scelta finale spetta al cliente.',
          'Non rispondo di disservizi causati da provider esterni, salvo responsabilità diretta e provata.'
        ]
      },
      {
        id: 'trattamento-dati-tc',
        number: '11',
        heading: 'Trattamento dei dati personali',
        paragraphs: [
          'I dati personali raccolti tramite il sito o nell’ambito dell’esecuzione dei servizi\nsono trattati secondo quanto descritto nella Privacy Policy e nella Cookie Policy,\nche costituiscono parte integrante dei presenti Termini.'
        ],
        list: [
          'Le basi giuridiche, le finalità, i periodi di conservazione e i diritti dell’interessato sono descritti nella Privacy Policy.',
          'Per esercitare i diritti previsti dagli artt. 15-22 GDPR è disponibile il modulo /privacy-request o l’email indicata nei contatti.',
          'Quando i servizi commissionati comportano il trattamento di dati personali di cui il cliente è titolare (es. gestione hosting, manutenzione con accesso al backend, gestione mailing list o account analytics del cliente), si applica automaticamente il Data Processing Agreement ai sensi dell’art. 28 GDPR disponibile su /dpa-clienti, che costituisce parte integrante dei presenti Termini.'
        ]
      },
      {
        id: 'garanzia-supporto',
        number: '12',
        heading: 'Garanzia e supporto',
        list: [
          'Ogni progetto include il supporto indicato nel preventivo; in assenza di indicazione specifica, 30 giorni dalla consegna.',
          'Il supporto copre bug e malfunzionamenti imputabili al lavoro consegnato, non nuove funzionalità o modifiche fuori scope.',
          'Pacchetti di manutenzione continuativa possono essere concordati separatamente.'
        ]
      },
      {
        id: 'limitazione-responsabilita',
        number: '13',
        heading: 'Limitazione di responsabilità',
        paragraphs: [
          'Nei limiti consentiti dalla legge, non sono responsabile per eventi che dipendono da uso improprio,\nservizi di terze parti, contenuti forniti dal cliente o fattori fuori dal mio controllo diretto.\nResta in ogni caso impregiudicata la responsabilità per dolo o colpa grave e i diritti inderogabili del consumatore.'
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
        number: '14',
        heading: 'Recesso',
        list: [
          'Il cliente può recedere dal contratto in qualsiasi momento con comunicazione scritta (email).',
          'In caso di recesso sono dovuti i compensi per il lavoro già svolto e per i costi non recuperabili sostenuti.',
          'L’acconto versato non è rimborsabile se il lavoro è già stato avviato, salvo diverso accordo scritto.',
          'Per il diritto di recesso del consumatore nei contratti a distanza vedi la sezione dedicata.'
        ]
      },
      {
        id: 'diritti-consumatore',
        number: '15',
        heading: 'Diritti del consumatore',
        paragraphs: [
          'Le presenti disposizioni si applicano esclusivamente ai contratti conclusi a distanza con persone fisiche\nche agiscono per scopi estranei alla propria attività professionale (consumatori),\nai sensi del Codice del Consumo (D.Lgs. 206/2005).'
        ],
        list: [
          'Il consumatore ha diritto di recedere senza fornire alcuna motivazione entro 14 giorni dalla conclusione del contratto (art. 52 D.Lgs. 206/2005).',
          'Il recesso si esercita inviando comunicazione scritta a ' + TITOLARE_EMAIL + ' prima della scadenza del termine.',
          'Il diritto di recesso non si applica una volta che il servizio è stato completamente eseguito con il consenso espresso del consumatore e con la sua accettazione del fatto di perdere il diritto di recesso a seguito della piena esecuzione (art. 59 lett. a, D.Lgs. 206/2005).',
          'In caso di esecuzione parziale già autorizzata dal consumatore, è dovuto un importo proporzionale al servizio prestato.',
          'Risoluzione alternativa controversie (ODR): la Commissione Europea mette a disposizione una piattaforma online accessibile all’indirizzo https://ec.europa.eu/consumers/odr.'
        ]
      },
      {
        id: 'foro-competente',
        number: '16',
        heading: 'Foro competente',
        paragraphs: [
          'Per qualsiasi controversia derivante dai presenti Termini e Condizioni\nè competente in via esclusiva il Foro di Frosinone,\nsalvo norme inderogabili applicabili al cliente consumatore\n(che potrà rivolgersi al foro della propria residenza o domicilio elettivo).'
        ]
      },
      {
        id: 'modifiche-termini',
        number: '17',
        heading: 'Modifiche ai termini',
        paragraphs: [
          'I presenti Termini e Condizioni possono essere modificati.\nLe modifiche vengono pubblicate su questa pagina con la data di ultimo aggiornamento.\nPer i contratti già in corso si applicano i Termini in vigore alla data di accettazione del preventivo.'
        ]
      },
      {
        id: 'contatti-termini',
        number: '18',
        heading: 'Contatti',
        paragraphs: [
          `Per qualsiasi domanda sui presenti termini puoi scrivermi a ${TITOLARE_EMAIL}.`
        ]
      }
    ]
  },
  'dpa-clienti': {
    slug: 'dpa-clienti',
    title: 'Accordo sul Trattamento dei Dati (DPA)',
    intro:
      'Accordo standard ai sensi dell’art. 28 GDPR per i servizi che comportano\ntrattamento di dati personali per conto del cliente.\nParte integrante dei Termini e Condizioni.',
    lastUpdated: LAST_LEGAL_UPDATE,
    sections: [
      {
        id: 'premessa-dpa',
        number: '01',
        heading: 'Premessa e ambito di applicazione',
        paragraphs: [
          'Il presente Accordo sul Trattamento dei Dati ("DPA") integra i Termini e Condizioni\ne disciplina i casi in cui — nell’esecuzione dei servizi commissionati — il prestatore\ntratta dati personali di cui il cliente è titolare ai sensi del Regolamento UE 2016/679 ("GDPR").',
          'Il DPA si applica automaticamente, senza necessità di sottoscrizione separata,\nquando i servizi includono almeno una delle seguenti attività:'
        ],
        list: [
          'gestione di hosting, dominio, certificati o infrastruttura del sito del cliente, con accesso ai dati ivi contenuti;',
          'manutenzione continuativa, evolutiva o correttiva con accesso al backend, database o repository del cliente;',
          'gestione di liste contatti o newsletter del cliente tramite account di terze parti (es. Resend, Mailchimp) operati dal prestatore;',
          'attività SEO o analytics con accesso ad account Google (Search Console, Analytics, Tag Manager) o equivalenti del cliente;',
          'sviluppo di funzionalità con accesso temporaneo o stabile a dati personali in chiaro del cliente.'
        ]
      },
      {
        id: 'parti',
        number: '02',
        heading: 'Identificazione delle parti',
        list: [
          `Responsabile del trattamento ("Responsabile"): ${TITOLARE}, ${TITOLARE_ADDRESS}, ${TITOLARE_VAT}, ${TITOLARE_EMAIL}.`,
          'Titolare del trattamento ("Titolare"): il cliente identificato nel preventivo accettato e nei dati di fatturazione, che resta unico responsabile della liceità del trattamento dei dati conferiti al Responsabile.'
        ]
      },
      {
        id: 'oggetto-durata',
        number: '03',
        heading: 'Oggetto, durata, natura e finalità',
        list: [
          'Oggetto: trattamento dei dati personali necessari all’esecuzione dei servizi descritti nel preventivo accettato.',
          'Durata: per tutta la durata del contratto commerciale, prorogata di 30 giorni per consentire la restituzione o cancellazione dei dati a fine rapporto.',
          'Natura: operazioni tecniche di raccolta, registrazione, organizzazione, conservazione, consultazione, modifica, comunicazione, cancellazione, eseguite con strumenti elettronici.',
          'Finalità: limitatamente all’esecuzione delle attività concordate; nessun uso autonomo dei dati per finalità diverse.'
        ]
      },
      {
        id: 'tipi-dati-interessati',
        number: '04',
        heading: 'Tipo di dati personali e categorie di interessati',
        paragraphs: [
          'A seconda dei servizi attivati, le categorie di dati e interessati possono includere:'
        ],
        list: [
          'Dati identificativi e di contatto: nome, email, telefono, ragione sociale, indirizzo, codice fiscale/P.IVA.',
          'Dati di navigazione e tecnici: indirizzo IP, user-agent, log di accesso, cookie.',
          'Contenuto delle comunicazioni: messaggi inviati tramite form, email, chat o canali equivalenti.',
          'Dati di fatturazione e pagamento dei clienti finali del Titolare.',
          'Categorie di interessati: visitatori del sito, clienti del Titolare, dipendenti o collaboratori del Titolare nella misura in cui i loro dati siano trattati.',
          'Categorie particolari (art. 9 GDPR) o dati relativi a condanne penali (art. 10 GDPR): di regola non trattati. Eventuali eccezioni richiedono integrazione scritta del DPA prima dell’inizio del trattamento.'
        ]
      },
      {
        id: 'istruzioni-titolare',
        number: '05',
        heading: 'Istruzioni del Titolare (art. 28(3)(a))',
        paragraphs: [
          'Il Responsabile tratta i dati personali esclusivamente su istruzioni documentate del Titolare,\nanche in caso di trasferimento di dati verso un Paese terzo o un’organizzazione internazionale,\nsalvo che il diritto dell’Unione o dello Stato membro cui è soggetto il Responsabile lo obblighi diversamente.'
        ],
        list: [
          'Costituiscono istruzioni documentate il presente DPA, i Termini e Condizioni, il preventivo accettato, le email scambiate tra le parti, le configurazioni esplicitamente richieste dal Titolare.',
          'Il Responsabile informa immediatamente il Titolare se, a suo parere, un’istruzione viola il GDPR o altre disposizioni applicabili in materia di protezione dei dati.'
        ]
      },
      {
        id: 'riservatezza',
        number: '06',
        heading: 'Riservatezza del personale (art. 28(3)(b))',
        paragraphs: [
          'Il Responsabile è un libero professionista che opera personalmente sui dati conferiti.\nEventuali collaboratori esterni occasionali sono vincolati per iscritto a obbligo di riservatezza\nequivalente al presente DPA prima di qualsiasi accesso ai dati del Titolare.'
        ]
      },
      {
        id: 'misure-sicurezza',
        number: '07',
        heading: 'Misure tecniche e organizzative (art. 28(3)(c) + art. 32)',
        paragraphs: [
          'Il Responsabile adotta misure proporzionate al rischio, tra cui in particolare:'
        ],
        list: [
          'Cifratura in transito tramite TLS per tutti gli accessi e le comunicazioni.',
          'Cifratura a riposo dei segreti applicativi (envelope encryption AES-256-GCM).',
          'Accessi amministrativi protetti da autenticazione multi-fattore (TOTP) e password con hashing bcrypt.',
          'Cookie di sessione con flag HttpOnly e Secure, scadenza sliding (30 minuti di inattività).',
          'Protezione anti-bot dei form pubblici tramite Cloudflare Turnstile.',
          'Log di accesso e audit trail conservati nei limiti previsti dalla policy di retention.',
          'Backup periodici dei dati con conservazione separata dall’istanza primaria.',
          'Procedure di hardening sistematico (security headers, CSP, rate limiting, mascheramento PII nei log).',
          'Procedura documentata di notifica data breach (cfr. art. 11 del presente DPA).'
        ]
      },
      {
        id: 'sub-responsabili',
        number: '08',
        heading: 'Sub-responsabili (art. 28(2) e 28(4))',
        paragraphs: [
          'Il Titolare autorizza in via generale il Responsabile a ricorrere ai sub-responsabili indicati di seguito,\nai quali sono imposti per contratto obblighi di protezione dei dati equivalenti a quelli del presente DPA.\nIl Responsabile resta pienamente responsabile dell’adempimento degli obblighi del sub-responsabile.'
        ],
        list: [
          'Hosting e infrastruttura: provider IaaS UE (es. Hetzner, Germania).',
          'Sicurezza ed edge: Cloudflare, Inc. (Irlanda) per WAF, anti-bot Turnstile, CDN.',
          'Email transazionali: Resend, Inc. (USA, DPF) o provider equivalente concordato.',
          'Pagamenti: Stripe Payments Europe Ltd. (Irlanda), PayPal (Europe) S.à r.l. et Cie, S.C.A. (Lussemburgo).',
          'Error tracking: istanza Bugsink self-hosted del Responsabile (nessun trasferimento a terzi).',
          'Eventuali ulteriori sub-responsabili sono comunicati al Titolare con preavviso di almeno 30 giorni; il Titolare può opporsi entro 15 giorni dal ricevimento della comunicazione, nel qual caso le parti concordano in buona fede una soluzione alternativa o, in mancanza, la risoluzione anticipata della parte di servizio interessata.'
        ]
      },
      {
        id: 'trasferimenti-extra-ue-dpa',
        number: '09',
        heading: 'Trasferimenti extra UE',
        list: [
          'Eventuali trasferimenti di dati verso Paesi terzi avvengono solo sulla base di idonee garanzie ai sensi del Capo V GDPR:',
          'EU-US Data Privacy Framework, ove il destinatario sia certificato (Stripe, PayPal, Cloudflare, Resend, Google).',
          'Clausole Contrattuali Tipo approvate dalla Commissione Europea (Decisione 2021/914) per i trasferimenti non coperti da decisione di adeguatezza o DPF.',
          'Il Responsabile rende disponibile copia delle garanzie su richiesta scritta del Titolare.'
        ]
      },
      {
        id: 'diritti-interessati-dpa',
        number: '10',
        heading: 'Assistenza per diritti degli interessati (art. 28(3)(e))',
        paragraphs: [
          'Il Responsabile assiste il Titolare con misure tecniche e organizzative adeguate,\nnella misura possibile, a rispondere alle richieste degli interessati relative\nall’esercizio dei diritti previsti dagli artt. 15-22 GDPR.'
        ],
        list: [
          'Le richieste ricevute direttamente dal Responsabile vengono inoltrate al Titolare entro 5 giorni lavorativi.',
          'L’assistenza include estrazione, rettifica o cancellazione dei dati e — ove tecnicamente fattibile — fornitura dei dati in formato strutturato e comunemente leggibile (art. 20 GDPR).',
          'Le attività di assistenza che superino l’ordinaria amministrazione possono essere fatturate al Titolare secondo le tariffe correnti, previo preventivo scritto.'
        ]
      },
      {
        id: 'sicurezza-breach-dpa',
        number: '11',
        heading: 'Notifica violazioni (art. 28(3)(f) + art. 33)',
        paragraphs: [
          'In caso di violazione dei dati personali ("data breach") che riguardi dati trattati per conto del Titolare,\nil Responsabile notifica il Titolare senza ingiustificato ritardo dopo esserne venuto a conoscenza,\ne in ogni caso entro 24 ore.'
        ],
        list: [
          'La notifica include: descrizione della natura della violazione, categorie e numero approssimativo di interessati e record interessati, conseguenze probabili, misure adottate o proposte per attenuare gli effetti.',
          'Il Responsabile fornisce al Titolare ogni informazione ragionevolmente necessaria per consentire la notifica all’Autorità di controllo entro 72 ore (art. 33 GDPR) e, ove richiesta, agli interessati (art. 34 GDPR).',
          'Il Responsabile coopera nell’indagine, contenimento e remediation, e documenta nel proprio registro interno violazioni la cronologia degli eventi.'
        ]
      },
      {
        id: 'dpia-consultazione',
        number: '12',
        heading: 'Valutazione di impatto e consultazione preventiva (art. 28(3)(f) + artt. 35-36)',
        paragraphs: [
          'Il Responsabile assiste il Titolare nella conduzione di una valutazione d’impatto sulla protezione dei dati (DPIA)\ne nella consultazione preventiva del Garante, ove ricorrano i presupposti dell’art. 35 GDPR,\nfornendo le informazioni tecniche nella propria disponibilità.'
        ]
      },
      {
        id: 'fine-rapporto',
        number: '13',
        heading: 'Restituzione o cancellazione a fine rapporto (art. 28(3)(g))',
        paragraphs: [
          'Al termine della prestazione dei servizi, su scelta del Titolare comunicata per iscritto entro 15 giorni dalla cessazione:'
        ],
        list: [
          'il Responsabile restituisce al Titolare tutti i dati personali trattati per suo conto, in formato strutturato e comunemente leggibile; oppure',
          'il Responsabile cancella i dati personali trattati per conto del Titolare, salvo che il diritto dell’Unione o dello Stato membro richieda la conservazione (in particolare, le fatture, i pagamenti e i preventivi connessi al rapporto commerciale restano conservati per 10 anni ai sensi dell’art. 2220 c.c. e della normativa fiscale).',
          'In mancanza di indicazioni del Titolare entro 30 giorni dalla cessazione, il Responsabile procede alla cancellazione dei dati di esclusiva pertinenza del Titolare, conservando solo i record fiscalmente obbligatori in forma anonimizzata ove possibile.',
          'Il Responsabile rilascia, su richiesta, dichiarazione di avvenuta cancellazione.'
        ]
      },
      {
        id: 'audit-ispezioni',
        number: '14',
        heading: 'Audit e ispezioni (art. 28(3)(h))',
        paragraphs: [
          'Il Responsabile mette a disposizione del Titolare tutte le informazioni necessarie per dimostrare\nil rispetto degli obblighi del presente DPA e contribuisce alle attività di revisione condotte\ndal Titolare o da soggetto da questi incaricato.'
        ],
        list: [
          'Le richieste di informazioni vengono evase entro 15 giorni lavorativi.',
          'Ispezioni in loco sono concordate con preavviso scritto di almeno 30 giorni, durante orario lavorativo, senza intralcio dell’operatività ordinaria del Responsabile.',
          'Le spese ragionevoli dell’audit sono a carico del Titolare, salvo che dall’audit emergano violazioni del DPA imputabili al Responsabile.',
          'Il Responsabile può proporre, in alternativa, certificazioni o rapporti di terzi indipendenti (es. ISO 27001) come prova del rispetto degli obblighi.'
        ]
      },
      {
        id: 'limitazione-resp-dpa',
        number: '15',
        heading: 'Limitazione di responsabilità',
        paragraphs: [
          'Nei limiti consentiti dalla legge, la responsabilità del Responsabile per i danni derivanti dal trattamento\ndei dati personali per conto del Titolare è limitata ai casi di dolo o colpa grave.',
          'Resta in ogni caso impregiudicata la responsabilità solidale tra Titolare e Responsabile ai sensi dell’art. 82 GDPR\nnei confronti degli interessati.'
        ]
      },
      {
        id: 'modifiche-dpa',
        number: '16',
        heading: 'Modifiche al DPA',
        paragraphs: [
          'Il Responsabile può aggiornare il presente DPA per adeguarlo a modifiche normative,\nlinee guida delle Autorità di controllo o evoluzioni tecniche dei servizi.\nLa versione aggiornata è pubblicata su /dpa-clienti con la data di ultimo aggiornamento;\nle modifiche sostanziali sono comunicate al Titolare per iscritto con almeno 30 giorni di preavviso.'
        ]
      },
      {
        id: 'foro-dpa',
        number: '17',
        heading: 'Foro competente e legge applicabile',
        paragraphs: [
          'Il presente DPA è regolato dal diritto italiano.\nPer qualsiasi controversia derivante dall’accordo è competente in via esclusiva il Foro di Frosinone,\nsalvo norme inderogabili applicabili in caso di Titolare consumatore.'
        ]
      },
      {
        id: 'contatti-dpa',
        number: '18',
        heading: 'Contatti',
        paragraphs: [
          `Per qualsiasi richiesta relativa al presente DPA, per la notifica di un data breach o per esercitare i diritti contrattuali quivi previsti, scrivere a ${TITOLARE_EMAIL}.`
        ]
      }
    ]
  }
};
