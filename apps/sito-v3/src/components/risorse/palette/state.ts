/**
 * Stato del tool "Palette di settore" (porting dell'oggetto `state` del
 * prototipo in un reducer). Solo dati serializzabili o quasi: le foto
 * simulate e quelle dell'utente sono data URL, i colori del logo cluster.
 */

import {
  type Cluster,
  type ExportFormat,
  type Lab,
  type PalettePhoto,
  type PresetKey,
  fallbackMood,
  hashString,
  hydrateClusters,
  nextSeed,
  normalizeQuery,
  pickSubset,
} from '@calicchia/shared/palette';
import type { SectorCopy, SectorIndexEntry } from '@/data/risorse/palette/types';
import type { LogoResult } from '@/lib/palette/logo';
import { PHOTOS_PER_SECTOR } from '@/lib/palette/sector-palette';
import type { Locale } from '@/lib/i18n';
import type { VisionMode } from './strings';

/** Foto caricabili dall'utente. */
export const MAX_USER_PHOTOS = 3;

/** Settore pronto passato dal server (pagina settore o settore iniziale). */
export interface ToolSectorInit {
  slug: string;
  label: string;
  /** Stile del settore; null se i testi non sono arrivati. */
  preset: PresetKey | null;
  queriesEn: string[];
  copy: SectorCopy;
  photos: PalettePhoto[];
}

/** Risposta di `/api/palette-sector/{slug}`. */
export interface SectorCopyResponse {
  slug: string;
  preset: PresetKey;
  queriesEn: string[];
  copy: Record<Locale, SectorCopy>;
}

export type SectorSource = 'curated' | 'search' | 'simulated';
export type SectorMessage = { kind: 'simulated'; text: string } | { kind: 'photosMissing' } | null;

export interface SectorState {
  /** Chiave del seed: `sector:{slug}` o `custom:{testo normalizzato}`. */
  key: string;
  /** Slug del settore pronto; null per il testo libero. */
  slug: string | null;
  label: string;
  /** Stile del settore; null = dedotto dai colori. */
  preset: PresetKey | null;
  /** Ricerche inglesi su Unsplash da mostrare. */
  queries: string[];
  copy: SectorCopy;
  source: SectorSource;
  /** Foto disponibili (12 per i settori pronti): "Rigenera" ne sceglie 6. */
  pool: PalettePhoto[];
  /** Colori base delle foto simulate. */
  mood: string[] | null;
  message: SectorMessage;
}

export type ToolPhoto =
  | { kind: 'unsplash'; id: string; photo: PalettePhoto; clusters: Cluster[] }
  | { kind: 'sim'; id: string; n: number; dataUrl: string; clusters: Cluster[] }
  | { kind: 'user'; id: string; dataUrl: string; clusters: Cluster[] };

export interface ToolState {
  sector: SectorState;
  seed: number;
  variant: number;
  /** Foto simulate già generate per `sector.key` + `seed`; null = da generare. */
  simPhotos: ToolPhoto[] | null;
  userPhotos: ToolPhoto[];
  nextId: number;
  locked: { hex: string; lab: Lab }[];
  primaryHex: string | null;
  /** Stile scelto dall'utente; null = segue il suggerimento. */
  presetChoice: PresetKey | null;
  autofix: boolean;
  tab: ExportFormat;
  logo: LogoResult | null;
  vision: VisionMode;
  loading: boolean;
}

export type ToolAction =
  | { type: 'loading'; value: boolean }
  | { type: 'setSector'; sector: SectorState }
  | { type: 'setSimPhotos'; key: string; seed: number; photos: { dataUrl: string; clusters: Cluster[] }[] }
  | { type: 'regenerate' }
  | { type: 'addUserPhoto'; dataUrl: string; clusters: Cluster[] }
  | { type: 'removeUserPhoto'; id: string }
  | { type: 'toggleLock'; hex: string; lab: Lab }
  | { type: 'setPrimary'; hex: string }
  | { type: 'setPreset'; preset: PresetKey }
  | { type: 'setAutofix'; value: boolean }
  | { type: 'setTab'; tab: ExportFormat }
  | { type: 'setLogo'; logo: LogoResult | null }
  | { type: 'setVision'; vision: VisionMode };

export function initState(sector: SectorState): ToolState {
  return {
    sector,
    seed: hashString(sector.key),
    variant: 1,
    simPhotos: null,
    userPhotos: [],
    nextId: 1,
    locked: [],
    primaryHex: null,
    presetChoice: null,
    autofix: true,
    tab: 'css',
    logo: null,
    vision: 'none',
    loading: false,
  };
}

export function toolReducer(state: ToolState, action: ToolAction): ToolState {
  switch (action.type) {
    case 'loading':
      return { ...state, loading: action.value };
    case 'setSector':
      // Nuovo settore: si riparte da capo, tenendo logo e foto dell'utente.
      return {
        ...state,
        sector: action.sector,
        seed: hashString(action.sector.key),
        variant: 1,
        simPhotos: null,
        locked: [],
        primaryHex: null,
        presetChoice: null,
        loading: false,
      };
    case 'setSimPhotos': {
      if (action.key !== state.sector.key || action.seed !== state.seed) return state;
      let id = state.nextId;
      const simPhotos: ToolPhoto[] = action.photos.map((p, i) => ({
        kind: 'sim',
        id: `s${id++}`,
        n: i + 1,
        dataUrl: p.dataUrl,
        clusters: p.clusters,
      }));
      return { ...state, simPhotos, nextId: id };
    }
    case 'regenerate':
      return {
        ...state,
        seed: nextSeed(state.seed),
        variant: state.variant + 1,
        simPhotos: null,
      };
    case 'addUserPhoto': {
      const users = state.userPhotos.length >= MAX_USER_PHOTOS ? state.userPhotos.slice(1) : state.userPhotos;
      const photo: ToolPhoto = { kind: 'user', id: `u${state.nextId}`, dataUrl: action.dataUrl, clusters: action.clusters };
      return { ...state, userPhotos: [...users, photo], nextId: state.nextId + 1 };
    }
    case 'removeUserPhoto':
      return { ...state, userPhotos: state.userPhotos.filter((p) => p.id !== action.id) };
    case 'toggleLock': {
      const isLocked = state.locked.some((l) => l.hex === action.hex);
      return {
        ...state,
        locked: isLocked ? state.locked.filter((l) => l.hex !== action.hex) : [...state.locked, { hex: action.hex, lab: action.lab }],
      };
    }
    case 'setPrimary':
      return { ...state, primaryHex: action.hex };
    case 'setPreset':
      return { ...state, presetChoice: action.preset };
    case 'setAutofix':
      return { ...state, autofix: action.value };
    case 'setTab':
      return { ...state, tab: action.tab };
    case 'setLogo':
      return { ...state, logo: action.logo, primaryHex: null };
    case 'setVision':
      return { ...state, vision: action.vision };
  }
}

/** Foto di settore effettive: sottoinsieme deterministico del pool, o le simulate. */
export function sectorPhotosOf(sector: SectorState, seed: number, simPhotos: ToolPhoto[] | null): ToolPhoto[] {
  if (sector.source === 'simulated') return simPhotos ?? [];
  return pickSubset(sector.pool, PHOTOS_PER_SECTOR, seed).map((photo) => ({
    kind: 'unsplash' as const,
    id: photo.id,
    photo,
    clusters: hydrateClusters(photo.clusters),
  }));
}

export function curatedSector(init: ToolSectorInit): SectorState {
  return {
    key: `sector:${init.slug}`,
    slug: init.slug,
    label: init.label,
    preset: init.preset,
    queries: init.queriesEn,
    copy: init.copy,
    source: init.photos.length ? 'curated' : 'simulated',
    pool: init.photos,
    // Senza foto il settore ripiega sulle simulate, con colori generici.
    mood: init.photos.length ? null : fallbackMood(init.slug),
    message: init.photos.length ? null : { kind: 'photosMissing' },
  };
}

/** Settore da testo libero con foto simulate (nessuna foto Unsplash). */
export function simulatedSector(text: string, copy: SectorCopy, message: SectorMessage): SectorState {
  return {
    key: `custom:${normalizeQuery(text)}`,
    slug: null,
    label: capitalize(text),
    preset: null,
    queries: [],
    copy,
    source: 'simulated',
    pool: [],
    mood: fallbackMood(text),
    message,
  };
}

/** Settore da testo libero con le foto trovate dall'API. */
export function searchedSector(text: string, copy: SectorCopy, photos: PalettePhoto[], queryEn: string | null): SectorState {
  return {
    key: `custom:${normalizeQuery(text)}`,
    slug: null,
    label: capitalize(text),
    preset: null,
    queries: queryEn ? [queryEn] : [],
    copy,
    source: 'search',
    pool: photos,
    mood: null,
    message: null,
  };
}

/** Prima lettera maiuscola, massimo 40 caratteri. */
export function capitalize(text: string): string {
  const clean = text.trim().slice(0, 40);
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/**
 * Settore pronto che corrisponde al testo: prima l'etichetta esatta, poi le
 * radici (parola uguale alla radice, o radice di 4+ caratteri come prefisso).
 * Prima gli alias della lingua corrente, poi quelli dell'altra.
 */
export function matchSector(text: string, index: readonly SectorIndexEntry[], locale: Locale): string | null {
  const n = normalizeQuery(text);
  if (!n) return null;
  const exact = index.find((s) => normalizeQuery(s.label.it) === n || normalizeQuery(s.label.en) === n);
  if (exact) return exact.slug;
  const tokens = n.split(/[^a-z0-9&]+/).filter(Boolean);
  const other: Locale = locale === 'it' ? 'en' : 'it';
  for (const loc of [locale, other]) {
    for (const s of index) {
      for (const alias of s.aliases[loc] ?? []) {
        const a = normalizeQuery(alias);
        if (tokens.some((t) => t === a || (a.length >= 4 && t.startsWith(a)))) return s.slug;
      }
    }
  }
  return null;
}
