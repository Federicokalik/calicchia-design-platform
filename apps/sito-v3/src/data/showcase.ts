/**
 * `ShowcaseTile` — shape consumato da `WorksHorizontal` per la sezione
 * "Lavori" della home.
 *
 * Decisione utente 2026-05-06: la home carica i progetti più recenti dal DB
 * tramite `fetchAllPublishedProjects` (vedi `lib/projects-api.ts`) e li
 * adatta a questo shape inline in `app/[locale]/page.tsx`. Il vecchio array
 * `SHOWCASE` statico è stato eliminato. `client` e `year` possono essere
 * vuoti/0 quando provengono dal backend list endpoint (che non li espone) —
 * `WorksHorizontal` nasconde quel meta block se entrambi sono assenti.
 */
export interface ShowcaseTile {
  src: string;
  client: string;
  title: string;
  year: number;
  tags: string[];
  href: string;
}
