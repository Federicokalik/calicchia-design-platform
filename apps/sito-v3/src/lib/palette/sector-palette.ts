/**
 * Palette calcolate fuori dal tool, senza DOM: la pagina settore (sezione
 * "perché questi colori" e immagine OG) deve mostrare esattamente la prima
 * palette che il tool genera nel browser, e la pagina `condividi` ricostruisce
 * i ruoli dai colori del link.
 */

import {
  type PaletteColor,
  type PalettePhoto,
  type PaletteRoles,
  type PresetKey,
  type PresetSuggestion,
  type SharedPalette,
  deriveRoles,
  hashString,
  hexToLab,
  hydrateClusters,
  pickSubset,
  selectPalette,
  suggestPreset,
} from '@calicchia/shared/palette';

/** Foto mostrate per settore: "Rigenera" ne sceglie altre tra quelle disponibili. */
export const PHOTOS_PER_SECTOR = 6;

/** Seed iniziale di un settore pronto: stesso valore del tool (`sector:{slug}`). */
export const sectorSeed = (slug: string): number => hashString(`sector:${slug}`);

export interface ComputedPalette {
  palette: PaletteColor[];
  roles: PaletteRoles;
  suggestion: PresetSuggestion;
  /** Le foto usate (sottoinsieme deterministico). */
  photos: PalettePhoto[];
}

/** Prima palette del tool per un settore pronto. Null se le foto non bastano. */
export function computeSectorPalette(slug: string, photos: readonly PalettePhoto[], preset: PresetKey | null): ComputedPalette | null {
  const subset = pickSubset(photos, PHOTOS_PER_SECTOR, sectorSeed(slug));
  const palette = selectPalette({
    photos: subset.map((p) => ({ id: p.id, weight: 1, clusters: hydrateClusters(p.clusters) })),
  });
  if (!palette.length) return null;
  return { palette, roles: deriveRoles(palette), suggestion: suggestPreset(palette, preset), photos: subset };
}

/** Palette e ruoli dai colori di un link condiviso. */
export function paletteFromShared(shared: SharedPalette): { palette: PaletteColor[]; roles: PaletteRoles } {
  const palette: PaletteColor[] = shared.colors.map((hex) => ({ hex, lab: hexToLab(hex), locked: false }));
  return { palette, roles: deriveRoles(palette, { primaryHex: shared.colors[shared.primary] ?? null }) };
}
