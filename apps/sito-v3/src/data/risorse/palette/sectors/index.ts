/**
 * Elenco dei settori curati del tool "Palette di settore".
 *
 * Un file per categoria di `seo-professions.ts` (`./{categoryId}.ts`, ognuno
 * esporta un array di `PaletteSectorContent`), aggregati qui nell'ordine delle
 * categorie. I file sono generati da `scripts/generate-palette-sectors.mjs` e
 * rivisti a mano.
 *
 * Niente import runtime con alias `@/` né `server-only` in questa cartella:
 * la legge anche lo script di pre-calcolo dell'API (tsx, fuori da Next).
 * Il vincolo server-only sta nell'accessor `../index.ts`.
 */

import type { PaletteSectorContent } from '../types';
import { AUTO_MOBILITA_SECTORS } from './auto-mobilita';
import { BEAUTY_WELLNESS_SECTORS } from './beauty-wellness';
import { CASA_EDILIZIA_SECTORS } from './casa-edilizia';
import { CREATIVITA_EVENTI_SECTORS } from './creativita-eventi';
import { FOOD_HOSPITALITY_SECTORS } from './food-hospitality';
import { RETAIL_NEGOZI_SECTORS } from './retail-negozi';
import { SANITA_SALUTE_SECTORS } from './sanita-salute';
import { STUDI_PROFESSIONALI_SECTORS } from './studi-professionali';

export const PALETTE_SECTORS: PaletteSectorContent[] = [
  ...BEAUTY_WELLNESS_SECTORS,
  ...SANITA_SALUTE_SECTORS,
  ...STUDI_PROFESSIONALI_SECTORS,
  ...CASA_EDILIZIA_SECTORS,
  ...AUTO_MOBILITA_SECTORS,
  ...FOOD_HOSPITALITY_SECTORS,
  ...RETAIL_NEGOZI_SECTORS,
  ...CREATIVITA_EVENTI_SECTORS,
];
