/**
 * Elenco dei settori curati del tool "Palette di settore".
 *
 * Un file per categoria di `seo-professions.ts` (`./{categoryId}.ts`, ognuno
 * esporta un array di `PaletteSectorContent`), aggregati qui. I file sono
 * generati da `scripts/generate-palette-sectors.mjs` e rivisti a mano.
 *
 * Niente import runtime con alias `@/` né `server-only` in questa cartella:
 * la legge anche lo script di pre-calcolo dell'API (tsx, fuori da Next).
 * Il vincolo server-only sta nell'accessor `../index.ts`.
 */

import type { PaletteSectorContent } from '../types';

export const PALETTE_SECTORS: PaletteSectorContent[] = [];
