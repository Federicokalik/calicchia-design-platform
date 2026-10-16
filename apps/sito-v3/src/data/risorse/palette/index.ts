import 'server-only';

/**
 * Accessor server-only dei dati di settore del tool "Palette di settore".
 *
 * Slug, etichetta IT, categoria e tier vengono da `seo-professions.ts`; le
 * etichette EN da `seo-professions-labels-en.ts`; testi e stile da
 * `./sectors` (PALETTE_SECTORS); le foto con i colori già estratti da
 * `public/palette-data/{slug}.json`.
 *
 * Al client arriva solo l'indice minimo (`getSectorIndex`) e, sulle pagine
 * settore, i testi del settore aperto: mai `seo-professions.ts` né l'elenco
 * completo dei testi.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SectorPhotoSet } from '@calicchia/shared/palette';
import { getProfessionBySlug, SEO_PROFESSIONS, type SeoProfession } from '@/data/seo-professions';
import { PROFESSION_LABELS_EN } from '@/data/seo-professions-labels-en';
import type { Locale } from '@/lib/i18n';
import { sanitizePhotos } from '@/lib/palette/photos';
import { PALETTE_SECTORS } from './sectors';
import type { PaletteSectorContent, SectorIndexEntry } from './types';

/** Solo i settori con uno slug che esiste davvero tra le professioni. */
const CONTENT_BY_SLUG = new Map<string, PaletteSectorContent>(
  PALETTE_SECTORS.filter((s) => getProfessionBySlug(s.slug)).map((s) => [s.slug, s]),
);

/** Ordine stabile: quello di `SEO_PROFESSIONS` (categoria, poi tier). */
const ORDERED_SLUGS = SEO_PROFESSIONS.map((p) => p.slug).filter((slug) => CONTENT_BY_SLUG.has(slug));

const PHOTO_DIR = join(process.cwd(), 'public', 'palette-data');
const IS_DEV = process.env.NODE_ENV === 'development';
const photoCache = new Map<string, SectorPhotoSet | null>();

export interface SectorProfession {
  slug: string;
  categoryId: string;
  tier: 1 | 2 | 3;
  label: Record<Locale, string>;
}

function toSectorProfession(p: SeoProfession): SectorProfession {
  return {
    slug: p.slug,
    categoryId: p.categoryId,
    tier: p.tier,
    label: { it: p.label, en: PROFESSION_LABELS_EN[p.slug] ?? p.label },
  };
}

/** Professione (slug, categoria, tier, etichette IT/EN) di qualunque slug noto. */
export function getSectorProfession(slug: string): SectorProfession | null {
  const p = getProfessionBySlug(slug);
  return p ? toSectorProfession(p) : null;
}

/** Tutte le professioni, raggruppate per categoria nell'ordine di `seo-professions.ts`. */
export function listProfessionsByCategory(): { categoryId: string; professions: SectorProfession[] }[] {
  const groups = new Map<string, SectorProfession[]>();
  for (const p of SEO_PROFESSIONS) {
    const list = groups.get(p.categoryId) ?? [];
    list.push(toSectorProfession(p));
    groups.set(p.categoryId, list);
  }
  return [...groups].map(([categoryId, professions]) => ({ categoryId, professions }));
}

export function getSectorContent(slug: string): PaletteSectorContent | null {
  return CONTENT_BY_SLUG.get(slug) ?? null;
}

/** Settore curato (con testi). Vale anche come `isKnownSector` del link condiviso. */
export function isKnownSector(slug: string): boolean {
  return CONTENT_BY_SLUG.has(slug);
}

/** Slug dei settori curati (con testi), nell'ordine delle professioni. */
export function listSectorSlugs(): string[] {
  return [...ORDERED_SLUGS];
}

/** Indice leggero per il client: matching del testo libero e chip dei settori. */
export function getSectorIndex(): SectorIndexEntry[] {
  return ORDERED_SLUGS.map((slug) => {
    const p = getProfessionBySlug(slug)!;
    const c = CONTENT_BY_SLUG.get(slug)!;
    return {
      slug,
      categoryId: p.categoryId,
      tier: p.tier,
      label: { it: p.label, en: PROFESSION_LABELS_EN[slug] ?? p.label },
      aliases: c.aliases,
    };
  });
}

function loadPhotoSet(slug: string): SectorPhotoSet | null {
  const file = join(PHOTO_DIR, `${slug}.json`);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<SectorPhotoSet>;
    const photos = sanitizePhotos(raw.photos);
    if (!photos.length) return null;
    return {
      slug,
      queries: Array.isArray(raw.queries) ? raw.queries.filter((q): q is string => typeof q === 'string') : [],
      generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
      photos,
    };
  } catch {
    return null;
  }
}

/**
 * Foto pre-calcolate di un settore curato (`public/palette-data/{slug}.json`).
 * Null se il settore non è curato, se il file manca o non è valido. Lo slug
 * passa dalla mappa dei settori prima di diventare un path: niente traversal.
 */
export function readSectorPhotoSet(slug: string): SectorPhotoSet | null {
  if (!CONTENT_BY_SLUG.has(slug)) return null;
  if (!IS_DEV && photoCache.has(slug)) return photoCache.get(slug) ?? null;
  const set = loadPhotoSet(slug);
  if (!IS_DEV) photoCache.set(slug, set);
  return set;
}

/** Settori con testi E foto: quelli che hanno una pagina. */
export function listSectorPageSlugs(): string[] {
  return ORDERED_SLUGS.filter((slug) => readSectorPhotoSet(slug) !== null);
}

/**
 * Pagina settore indicizzabile: tier 1-2 E testi rivisti a mano. I tier 3
 * restano noindex (a differenza di `shouldIndex()` della matrice, che
 * indicizza tutto): sono testi generati, li apriamo solo dopo la revisione.
 */
export function isIndexable(slug: string): boolean {
  const p = getProfessionBySlug(slug);
  const c = CONTENT_BY_SLUG.get(slug);
  return !!p && !!c && p.tier <= 2 && c.reviewed;
}

/** Settore pronto da passare al tool: testi nella lingua della pagina e tutte le foto. */
export interface ToolSectorData {
  slug: string;
  label: string;
  preset: PaletteSectorContent['preset'];
  queriesEn: string[];
  copy: PaletteSectorContent['copy'][Locale];
  photos: SectorPhotoSet['photos'];
}

export function getToolSector(slug: string, locale: Locale): ToolSectorData | null {
  const content = CONTENT_BY_SLUG.get(slug);
  const profession = getSectorProfession(slug);
  if (!content || !profession) return null;
  return {
    slug,
    label: profession.label[locale],
    preset: content.preset,
    queriesEn: [...content.queriesEn],
    copy: content.copy[locale],
    photos: readSectorPhotoSet(slug)?.photos ?? [],
  };
}

/**
 * Settori proposti come chip: i dieci settori pilota se ci sono, altrimenti i
 * primi settori pronti di tier 1.
 */
const FEATURED_SLUGS = [
  'pizzerie',
  'dentisti',
  'avvocati',
  'parrucchieri',
  'palestre',
  'agriturismi',
  'officine-meccaniche',
  'fotografi',
  'gelaterie',
  'psicologi',
];

export function listFeaturedSlugs(limit = 10): string[] {
  const featured = FEATURED_SLUGS.filter((slug) => CONTENT_BY_SLUG.has(slug));
  if (featured.length) return featured.slice(0, limit);
  return ORDERED_SLUGS.filter((slug) => getProfessionBySlug(slug)?.tier === 1).slice(0, limit);
}
