/**
 * Sorgente delle pagine statiche per il mirror Markdown `<path>.md`.
 *
 * Pattern ibrido:
 *   1. Per le pagine principali esiste un file `.md` reale in
 *      `apps/sito-v3/src/content/_md/<page>.<locale>.md` — il route handler
 *      lo legge a runtime via `fs.readFile`. Permette di editare il contenuto
 *      del mirror senza toccare TypeScript.
 *   2. Per le pagine secondarie (legali, glossari, zone, ecc.) il content
 *      vive qui sotto come const TypeScript. Refactor incrementale: nuove
 *      pagine partono dal const, vengono migrate a file `.md` quando il body
 *      richiede una scrittura più curata.
 *
 * Vedi `app/_md/[[...slug]]/route.ts` per la logica di lookup.
 */
import { SITE } from '@/data/site';

export interface StaticPageMeta {
  title: string;
  description: string;
  body?: string;
  related: Array<{ name: string; path: string }>;
}

const REL_HOME = [
  { name: 'Portfolio', path: '/lavori' },
  { name: 'Servizi', path: '/servizi' },
  { name: 'Perché scegliermi', path: '/perche-scegliere-me' },
  { name: 'Contatti', path: '/contatti' },
  { name: 'Blog', path: '/blog' },
];

export const STATIC_PAGES: Record<string, StaticPageMeta> = {
  '/': {
    title: 'Federico Calicchia — Web Designer & Developer Freelance',
    description:
      'Web Designer & Developer Freelance a Frosinone, in Ciociaria. Siti web, e-commerce, sviluppo, SEO, manutenzione e assistenza WordPress. Lavoro con clienti in tutta Italia e all\'estero.',
    related: REL_HOME,
  },
  '/lavori': {
    title: 'Portfolio · Progetti che hanno fatto guadagnare i miei clienti',
    description:
      'Web design e e-commerce: progetti reali, numeri verificabili, clienti veri. Niente render finti, niente concept art. Solo lavori che lavorano.',
    related: REL_HOME,
  },
  '/servizi': {
    title: 'Servizi · Web Design, E-Commerce, Sviluppo, SEO, WordPress, Performance, Accessibilità',
    description:
      'Undici servizi, un solo standard. Web design, e-commerce, sviluppo custom, SEO, WordPress, branding, manutenzione, performance Core Web Vitals, accessibilità WCAG, analytics.',
    related: REL_HOME,
  },
  '/contatti': {
    title: 'Contatti — Niente PowerPoint, niente promesse vuote',
    description:
      'Web Designer & Developer Freelance a Ceccano (FR). Scrivimi, chiamami o prenota una consulenza gratuita di 30 minuti.',
    body: [
      `**Email:** ${SITE.contact.email}`,
      `**Telefono:** ${SITE.contact.phone}`,
      `**Indirizzo:** ${SITE.contact.address}`,
      `**P.IVA:** ${SITE.contact.vat}`,
      `**Prenota una call:** <${SITE.url}${SITE.contact.cal}>`,
    ].join('\n\n'),
    related: REL_HOME,
  },
  '/perche-scegliere-me': {
    title: 'Perché scegliere un Web Designer & Developer Freelance',
    description:
      'Un solo contatto per siti, e-commerce, sviluppo, SEO, manutenzione e WordPress. Niente passaggi di mano, niente agenzia a sei mani. Manifesto, approccio in 5 pilastri, FAQ.',
    related: REL_HOME,
  },
  '/blog': {
    title: 'Blog · Web design, sviluppo, SEO senza fumo',
    description:
      'Articoli su web design, sviluppo, SEO, performance, accessibilità. Niente listicle riciclate, niente trending topic senza sostanza. Solo analisi e tutorial usabili.',
    related: REL_HOME,
  },
  '/faq': {
    title: 'FAQ Web Design Freelance',
    description:
      'Risposte secche su tempi, processo, manutenzione, SEO, prezzi. Niente fronzoli, niente promesse vuote.',
    related: REL_HOME,
  },
  '/privacy-policy': {
    title: 'Privacy Policy',
    description:
      'Informativa privacy: dati raccolti, finalità, base giuridica, diritti dell\'interessato, tempi di conservazione, modalità di esercizio dei diritti GDPR.',
    related: [
      { name: 'Cookie Policy', path: '/cookie-policy' },
      { name: 'Termini e Condizioni', path: '/termini-e-condizioni' },
      { name: 'DPA Clienti', path: '/dpa-clienti' },
    ],
  },
  '/cookie-policy': {
    title: 'Cookie Policy',
    description:
      'Informativa sui cookie utilizzati dal sito: cookie tecnici, di sicurezza, analitici aggregati. Come gestire il consenso.',
    related: [{ name: 'Privacy Policy', path: '/privacy-policy' }],
  },
  '/termini-e-condizioni': {
    title: 'Termini e Condizioni',
    description:
      'Termini d\'uso del sito e dei rapporti contrattuali per i servizi professionali: preventivi, pagamenti, tempistiche, proprietà intellettuale, recesso.',
    related: [{ name: 'DPA Clienti', path: '/dpa-clienti' }],
  },
  '/dpa-clienti': {
    title: 'DPA — Data Processing Agreement',
    description:
      'Accordo standard sul trattamento dei dati personali ai sensi dell\'art. 28 GDPR. Parte integrante dei Termini e Condizioni.',
    related: [{ name: 'Privacy Policy', path: '/privacy-policy' }],
  },
  '/glossario-seo': {
    title: 'Glossario SEO',
    description:
      'Termini chiave SEO spiegati senza fumo: cosa significano, perché ti interessano e cosa pretendere dal tuo professionista.',
    related: [
      { name: 'Glossario Web Design', path: '/glossario-web-design' },
      { name: 'Glossario E-Commerce', path: '/glossario-e-commerce' },
    ],
  },
  '/glossario-e-commerce': {
    title: 'Glossario E-Commerce',
    description:
      'Termini chiave dell\'e-commerce spiegati senza fumo: dropshipping, checkout, conversion rate, AOV, CAC, LTV.',
    related: [
      { name: 'Glossario SEO', path: '/glossario-seo' },
      { name: 'Glossario Web Design', path: '/glossario-web-design' },
    ],
  },
  '/glossario-web-design': {
    title: 'Glossario Web Design',
    description:
      'Termini chiave del web design spiegati senza fumo: cosa significano, perché ti interessano e cosa pretendere dal tuo web designer.',
    related: [
      { name: 'Glossario SEO', path: '/glossario-seo' },
      { name: 'Glossario E-Commerce', path: '/glossario-e-commerce' },
    ],
  },
  '/zone': {
    title: 'Zone — Web Designer Freelance in Ciociaria e Lazio',
    description:
      'Web designer freelance attivo in tutta la provincia di Frosinone (Ciociaria) e nel Lazio. Lavoro in remoto con clienti italiani e internazionali.',
    related: REL_HOME,
  },
  '/servizi-per-professioni': {
    title: 'Servizi per professione — Sito web per ogni mestiere',
    description:
      'Web design freelance per professioni e categorie: dentisti, avvocati, ristoratori, artigiani, hotel, e-commerce. Servizi su misura per il tuo settore.',
    related: REL_HOME,
  },
};
