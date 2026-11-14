/**
 * Tipi dei dati di settore del tool "Palette di settore".
 *
 * I settori sono le professioni di `data/seo-professions.ts` (slug, etichetta,
 * categoria e tier vengono da lì, non si duplicano). Per ogni settore:
 *  - i testi (`sectors/{categoryId}.ts`, server-only) generati da
 *    `scripts/generate-palette-sectors.mjs` e rivisti a mano;
 *  - le foto con i colori estratti (`public/palette-data/{slug}.json`,
 *    forma `SectorPhotoSet` di `@calicchia/shared/palette`) generate da
 *    `apps/api/scripts/precompute-palettes.ts`.
 *
 * Indicizzazione: una pagina settore è indicizzabile solo se tier 1-2 E
 * `reviewed: true`. I tier 3 restano `noindex` (diverso da `shouldIndex()`
 * della matrice, che indicizza tutto: scelta voluta per contenuti generati).
 */

import type { PresetKey } from '@calicchia/shared/palette';
import type { Locale } from '@/lib/i18n';

export interface SectorCard {
  title: string;
  description: string;
  /** Prezzo, orario o nota breve mostrata in fondo alla card. */
  meta: string;
}

/** Testi fittizi della home di esempio e dei supporti (biglietto, insegna, post). */
export interface SectorCopy {
  /** Nome di un'attività inventata, plausibile per il settore. */
  name: string;
  /** Voce del bottone in navigazione (es. "Prenota"). */
  nav: string;
  eyebrow: string;
  h1: string;
  lead: string;
  btn1: string;
  btn2: string;
  cards: [SectorCard, SectorCard, SectorCard];
  banner: string;
}

export interface PaletteSectorContent {
  /** = `SeoProfession.slug`. */
  slug: string;
  /** Stile suggerito per il settore. */
  preset: PresetKey;
  /** Ricerche Unsplash in inglese (3, concrete e visive). */
  queriesEn: [string, string, string];
  /**
   * Radici per riconoscere il testo libero, già normalizzate (minuscolo,
   * senza accenti). Una parola del visitatore combacia se è uguale a una
   * radice o, con radici di 4+ caratteri, se inizia con essa.
   */
  aliases: Record<Locale, string[]>;
  copy: Record<Locale, SectorCopy>;
  /** Introduzione SEO della pagina settore: 2-3 paragrafi separati da riga vuota. */
  intro: Record<Locale, string>;
  /** True dopo la revisione umana dei testi. */
  reviewed: boolean;
}

/** Voce dell'indice leggero passato al client per il matching del testo libero. */
export interface SectorIndexEntry {
  slug: string;
  categoryId: string;
  tier: 1 | 2 | 3;
  label: Record<Locale, string>;
  aliases: Record<Locale, string[]>;
}
