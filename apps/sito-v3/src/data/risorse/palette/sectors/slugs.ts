// Generato da scripts/generate-palette-sectors.mjs: non modificare a mano.
// Slug dei settori presenti in questa cartella, senza testi: lo importa chi
// deve solo sapere se un settore esiste (es. il box nelle landing della matrice).

export const SECTOR_SLUGS: readonly string[] = [
  "parrucchieri",
  "barbieri",
  "estetiste",
  "centri-estetici",
  "palestre",
  "personal-trainer",
  "saloni-di-bellezza",
  "make-up-artist",
  "onicotecniche",
  "yoga",
  "pilates",
  "scuole-di-danza",
  "centri-sportivi",
  "piscine",
  "scuole-calcio",
  "dentisti",
  "psicologi",
  "avvocati",
  "officine-meccaniche",
  "pizzerie",
  "agriturismi",
  "gelaterie",
  "fotografi"
];

const SECTOR_SLUG_SET = new Set(SECTOR_SLUGS);

export function hasPaletteSector(slug: string): boolean {
  return SECTOR_SLUG_SET.has(slug);
}
