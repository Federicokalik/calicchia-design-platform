export interface Curiosita {
  label: string;
  text: string;
}

export const CURIOSITA: Curiosita[] = [
  {
    label: 'Designer da sempre',
    text: 'I primi layout li facevo da ragazzino con AutoCAD e Photoshop.\nNon ho scelto il design come lavoro — è il design che ha scelto me, e non ha mai smesso.',
  },
  {
    label: 'Geometra di formazione',
    text: 'Precisione, progettazione, attenzione maniacale ai dettagli.\nIl diploma da geometra mi ha insegnato a misurare tutto due volte.\nSi vede in ogni pixel che consegno.',
  },
  {
    label: 'Imprenditore, non solo freelance',
    text: 'Nel 2021 ho co-fondato Aeron Sim, nel mondo dei simulatori di guida.\nSo cosa vuol dire costruire un brand da zero — con i propri soldi, i propri errori e le proprie vittorie.',
  },
  {
    label: 'Render 3D e video',
    text: 'Video editing, motion graphics, post-produzione e persino render 3D interattivi.\nSe il tuo progetto ha bisogno di prendere vita, so come farlo.',
  },
  {
    label: 'Certificato Google',
    text: 'Digital marketing non è una buzzword per me.\nHo la certificazione Google e anni di pratica sul campo tra SEO, campagne e analisi dati.',
  },
  {
    label: 'Mentalità da problem solver',
    text: 'Modding Android, reverse-engineering, automazioni.\nQuando qualcosa non funziona, non mi fermo — trovo un modo. È più forte di me.',
  },
];

export const CURIOSITA_BIO_LINK = 'https://federico.im';

// ─── EN translations (Round 5b, 2026-05-08) ─────────────────────────
// Personal voice preserved (AutoCAD, Photoshop, Aeron Sim 2021, Google cert, Android modding).
export const CURIOSITA_EN: Curiosita[] = [
  {
    label: 'Designer from day one',
    text: "I made my first layouts as a kid in AutoCAD and Photoshop.\nI did not pick design as a job — design picked me, and never let go.",
  },
  {
    label: 'Surveyor by training',
    text: "Precision, planning, obsessive attention to detail.\nThe surveyor diploma taught me to measure everything twice.\nYou can see it in every pixel I ship.",
  },
  {
    label: 'Founder, not just freelance',
    text: "In 2021 I co-founded Aeron Sim, in the racing simulators world.\nI know what it means to build a brand from zero — with your own money, your own mistakes and your own wins.",
  },
  {
    label: '3D renders and video',
    text: "Video editing, motion graphics, post-production and even interactive 3D renders.\nIf your project needs to come alive, I know how to make it happen.",
  },
  {
    label: 'Google certified',
    text: "Digital marketing is not a buzzword for me.\nI have the Google certification and years of hands-on practice across SEO, campaigns and data analysis.",
  },
  {
    label: 'Problem-solver mindset',
    text: "Android modding, reverse-engineering, automations.\nWhen something does not work, I do not stop — I find a way. It is stronger than me.",
  },
];

import type { Locale } from '@/lib/i18n';

/** Locale-aware getter for /perche-scegliere-me curiosita list. */
export function getCuriosita(locale: Locale = 'it'): Curiosita[] {
  return locale === 'en' ? CURIOSITA_EN : CURIOSITA;
}
