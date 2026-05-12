export interface FaqItem {
  question: string;
  answer: string;
}

/** FAQ specifiche per la pagina /perche-scegliere-me — risposte qualitative,
 *  niente cifre. Le tariffe restano fuori per evitare commitment a prezzi. */
export const PERCHI_FAQS: FaqItem[] = [
  {
    question: "Perché dovrei scegliere un freelance e non un'agenzia?",
    answer:
      "Bella domanda. Con un'agenzia il tuo progetto passa tra 4-5 persone diverse, ognuna con le sue priorità.\nCon me parli con una persona sola — quella che lo progetta, lo sviluppa e lo mette online.\nPiù veloce, più coerente, e soprattutto: nessun dettaglio si perde per strada."
  },
  {
    question: 'Che tipo di progetti segui?',
    answer:
      'Siti web, e-commerce, landing page, branding e strategie digitali.\nLavoro con PMI, professionisti e startup che vogliono fare sul serio online.\nNiente template riadattati: ogni progetto parte da zero, dai tuoi obiettivi reali.'
  },
  {
    question: 'Ok, ma quanto costa?',
    answer:
      'Dipende da cosa ti serve davvero — e te lo dico subito, senza girarci intorno.\nDopo una prima chiacchierata (gratuita, senza impegno) ti scrivo nero su bianco cosa ottieni, in quanto tempo, con quale impegno economico.\nNiente sorprese a fine progetto. Niente listini gonfiati. Niente catena di fornitori che alza il conto. Decidi tu.'
  },
  {
    question: 'E dopo che il sito è online?',
    answer:
      'Il lancio è solo l\'inizio.\nOffro piani di manutenzione per tenere il tuo sito sicuro, aggiornato e veloce nel tempo.\nAggiornamenti, backup, monitoraggio — tutto incluso. Non ti lascio da solo dopo la consegna.'
  },
  {
    question: 'Lavori da solo o hai un team?',
    answer:
      'Io sono il tuo unico punto di contatto, sempre.\nMa quando un progetto richiede competenze specifiche — copywriting, fotografia, campagne ADV — mi affianco a professionisti fidati che condividono i miei standard.\nIl risultato? Tu parli con me, ma hai un team intero che lavora per te.'
  },
  {
    question: 'Come funziona il processo di lavoro?',
    answer:
      'Si parte da una chiacchierata per capire dove vuoi arrivare.\nPoi disegno il progetto e te lo mostro prima di scrivere una riga di codice.\nSviluppo, test su ogni dispositivo, lancio — e accompagnamento anche dopo. In ogni fase, sai sempre a che punto siamo.'
  }
];

// ─── EN translations (Round 5b, 2026-05-08) ─────────────────────────
// Voice anti-marketing preserved. NO PRICES (memory: feedback_no_prezzi_in_copy).
export const PERCHI_FAQS_EN: FaqItem[] = [
  {
    question: "Why should I pick a freelance instead of an agency?",
    answer:
      "Fair question. With an agency your project passes through 4–5 different people, each with their own priorities.\nWith me you talk to one person — the one who designs it, builds it and ships it.\nFaster, more consistent, and most importantly: nothing falls through the cracks."
  },
  {
    question: "What kind of projects do you take on?",
    answer:
      "Websites, e-commerce, landing pages, branding and digital strategy.\nI work with SMEs, professionals and startups that want to do serious things online.\nNo retro-fitted templates: every project starts from zero, from your real goals."
  },
  {
    question: "OK, but how much does it cost?",
    answer:
      "It depends on what you actually need — and I tell you straight, without dressing it up.\nAfter a first call (free, no commitment) I write you in black and white what you get, in what timeline, for what budget.\nNo surprises at the end. No inflated price lists. No supplier chain padding the bill. You decide."
  },
  {
    question: "And after the site is online?",
    answer:
      "Launch is just the start.\nI offer maintenance plans to keep your site safe, updated and fast over time.\nUpdates, backups, monitoring — all included. I do not leave you alone after delivery."
  },
  {
    question: "Do you work alone or do you have a team?",
    answer:
      "I am your single point of contact, always.\nBut when a project needs specific skills — copywriting, photography, ad campaigns — I bring in trusted professionals who share my standard.\nThe result? You talk to me, but you have a whole team working for you."
  },
  {
    question: "How does the process work?",
    answer:
      "It starts with a conversation to understand where you want to get to.\nThen I design the project and show it to you before writing a line of code.\nDevelopment, testing on every device, launch — and follow-up afterwards. At every step, you always know where we are."
  }
];

import type { Locale } from '@/lib/i18n';

/** Locale-aware getter for /perche-scegliere-me FAQs. */
export function getPerchiFaqs(locale: Locale = 'it'): FaqItem[] {
  return locale === 'en' ? PERCHI_FAQS_EN : PERCHI_FAQS;
}
