// Roadmap servizi unificata — 5 step generici riusati su tutti i servizi.
// Sostituisce i process[] hard-coded per servizio (decision 2026-05-14):
// l'owner ha confermato che il flusso reale e' sempre Call -> Preventivo ->
// Design/Strategia -> Build -> Lancio & follow-up indipendentemente dal
// servizio specifico. Tenere 10 process[] diversi non riflette la realta'
// operativa e l'owner vuole una promessa coerente.
//
// Source of truth unica: questo file. Non rigenerare via
// scripts/generate-services-copy.mjs (il prompt "process" e' deprecato).

import type { ProcessStep } from '../../services-detail';

export const PROCESS_STEPS_IT: ProcessStep[] = [
  {
    step: 1,
    title: 'Call iniziale',
    description:
      "30 minuti gratis per capire il bisogno reale. Ascolto, faccio domande, prendo appunti. Niente preventivi a freddo: prima devo sapere cosa stai costruendo davvero.",
  },
  {
    step: 2,
    title: 'Preventivo',
    description:
      "Forfait chiaro con scope, tempi e costi. Niente sorprese: se qualcosa e' fuori scope te lo dico prima, non a fattura emessa.",
  },
  {
    step: 3,
    title: 'Design / Strategia',
    description:
      "Wireframe, moodboard o audit con piano d'azione — dipende dal servizio. Ti mostro la direzione prima di mettere mano al codice o ai contenuti.",
  },
  {
    step: 4,
    title: 'Build',
    description:
      'Sviluppo, intervento tecnico o esecuzione operativa. Check-in periodici concordati, niente "ci sentiamo a fine mese e vediamo".',
  },
  {
    step: 5,
    title: 'Lancio & follow-up',
    description:
      'Go-live + 30 giorni di assistenza inclusa. Documentazione, training se serve, e una porta sempre aperta per le piccole cose.',
  },
];

export const PROCESS_STEPS_EN: ProcessStep[] = [
  {
    step: 1,
    title: 'Discovery call',
    description:
      "30 free minutes to understand the real need. I listen, ask questions, take notes. No cold quotes: I need to know what you're actually building first.",
  },
  {
    step: 2,
    title: 'Quote',
    description:
      "Flat fee with clear scope, timeline and costs. No surprises: if something falls out of scope I tell you upfront, not when the invoice lands.",
  },
  {
    step: 3,
    title: 'Design / Strategy',
    description:
      'Wireframes, moodboard or audit with action plan — depends on the service. You see the direction before any code or content gets touched.',
  },
  {
    step: 4,
    title: 'Build',
    description:
      'Development, technical work or operational execution. Agreed check-ins along the way, none of that "let\'s sync end of month".',
  },
  {
    step: 5,
    title: 'Launch & follow-up',
    description:
      "Go-live + 30 days of assistance included. Documentation, training if needed, and an open door for the small things later.",
  },
];
