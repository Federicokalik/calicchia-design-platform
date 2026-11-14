/**
 * Tipi condivisi del tool "Palette di settore": foto con i loro cluster,
 * colori della palette e ruoli derivati.
 */

import type { Lab } from './color';
import type { Cluster } from './extract';

export type PaletteLocale = 'it' | 'en';

/** Cluster serializzato: quanto basta per ricostruire il Lab dall'hex. */
export interface StoredCluster {
  hex: string;
  w: number;
}

/**
 * Foto Unsplash con i colori già estratti. Stessa forma nei JSON
 * pre-calcolati (`public/palette-data/{slug}.json`) e nella risposta di
 * `GET /api/palette/search`. Gli URL restano su images.unsplash.com
 * (hotlink obbligatorio) con il parametro `ixid`.
 */
export interface PalettePhoto {
  id: string;
  /** URL ~400px per le miniature e l'anteprima. */
  small: string;
  /** URL ~1080px per l'anteprima grande e il post. */
  regular: string;
  width: number;
  height: number;
  blurHash: string | null;
  /** Colore medio dichiarato da Unsplash, fallback se l'immagine non carica. */
  color: string | null;
  alt: string | null;
  author: string;
  /** Profilo del fotografo, già con i parametri utm richiesti da Unsplash. */
  authorUrl: string;
  /** Pagina della foto su Unsplash, già con i parametri utm. */
  photoUrl: string;
  clusters: StoredCluster[];
}

/** Dati pre-calcolati di un settore. */
export interface SectorPhotoSet {
  slug: string;
  /** Query inglesi usate su Unsplash. */
  queries: string[];
  generatedAt: string;
  photos: PalettePhoto[];
}

/** Foto pronta per la selezione della palette (pesi già applicati). */
export interface PhotoInput {
  id: string;
  /** 1 per le foto di settore, 2 per quelle caricate dall'utente. */
  weight: number;
  clusters: Cluster[];
}

export interface PaletteColor {
  hex: string;
  lab: Lab;
  locked: boolean;
  /** Colore preso dal logo: fisso e mai sbloccabile. */
  fromLogo?: boolean;
  /** Peso nel logo, usato per scegliere il primario. */
  w?: number;
}

export type RoleFixKind = 'primary' | 'accentText';

export interface RoleFix {
  kind: RoleFixKind;
  from: string;
  to: string;
  ratio: number;
  /** Per il primario: colore del testo del bottone. */
  on?: string;
}

export interface PaletteRoles {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  /** Primario estratto. */
  primary: string;
  /** Primario usato nei bottoni (corretto se serve per il contrasto). */
  primaryUsed: string;
  onPrimary: string;
  accent: string;
  /** Accento usato come testo (corretto se serve per il contrasto). */
  accentText: string;
  fixes: RoleFix[];
}
