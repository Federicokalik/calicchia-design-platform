export interface FaqEntry {
  question: string;
  answer: string;
}

/** FAQ generiche per la pagina /faq — port dal legacy ma senza prezzi specifici.
 *  Le tempistiche restano (10/30/90gg) perché non sono prezzi. */
export const FAQS: FaqEntry[] = [
  {
    question: 'Quali servizi offri?',
    answer:
      'Quattro core verticali nella matrice: web design, e-commerce, sviluppo web (gestionali, web app, integrazioni) e SEO.\nIn più, fuori matrice, branding, manutenzione siti e assistenza WordPress (security, performance, migrazioni).\nUn solo contatto, niente catena di fornitori.'
  },
  {
    question: 'Come si determina il prezzo del progetto?',
    answer:
      'Ogni progetto è cucito sul caso reale — niente listino preconfezionato.\nDopo una chiacchierata gratuita di 30 minuti capisco cosa ti serve, ti scrivo nero su bianco cosa ottieni, in quanto tempo, con quale impegno economico.\nPossibilità di pagamento dilazionato. Niente sorprese a fine lavoro.'
  },
  {
    question: 'Quanto tempo ci vuole per realizzare un progetto?',
    answer:
      'I tempi variano in base alla complessità: un sito One Page richiede circa 10 giorni lavorativi, un Multipagina fino a 30 giorni, un e-commerce fino a 90 giorni.\nFornisco tempistiche chiare e aggiornamenti costanti ad ogni fase.'
  },
  {
    question: 'Posso gestire i contenuti del sito da solo?',
    answer:
      'Assolutamente sì.\nIncludo formazione completa e documentazione per permetterti di gestire i contenuti in totale autonomia.\nChe sia WordPress o un CMS custom, ti metto nelle condizioni di essere indipendente.'
  },
  {
    question: 'Il SEO è incluso nel sito web?',
    answer:
      'Ogni sito include SEO tecnico di base: meta tag, sitemap, robots.txt, ottimizzazione velocità e configurazione Google Search Console.\nPer strategie SEO avanzate con content strategy e link building, offro pacchetti dedicati su misura.'
  },
  {
    question: 'Offri assistenza dopo il lancio?',
    answer:
      'Sì, ogni progetto include assistenza gratuita post-lancio.\nSuccessivamente offro piani di manutenzione mensile che includono backup, aggiornamenti, monitoraggio e supporto tecnico — per tenere il sito sicuro e veloce nel tempo.'
  },
  {
    question: 'Come iniziamo a lavorare insieme?',
    answer:
      'È semplice: contattami tramite il sito o prenota una consulenza gratuita di 30 minuti.\nDiscuteremo i tuoi obiettivi, le tue esigenze e il budget.\nPoi ti invierò una proposta dettagliata con timeline e costi. Nessun impegno, nessuna pressione.'
  }
];
