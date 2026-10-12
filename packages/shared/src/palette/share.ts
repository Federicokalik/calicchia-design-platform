/**
 * Link condivisibile e palette salvata sul lead.
 *
 * Il payload contiene solo dati validabili: hex, uno stile della lista, lo
 * slug di un settore curato. Il testo libero cercato dall'utente, il logo e
 * le foto caricate non entrano mai nel link (né quindi nell'immagine OG o
 * nella pagina `condividi`).
 *
 * Forma querystring: `v=1&k=pizzerie&c=C63D2B,EFE5D2,...&s=morbido&p=0`.
 */

import { z } from 'zod';
import { PRESET_KEYS } from './presets';

export const SHARE_VERSION = 1;
export const SHARE_MIN_COLORS = 2;
export const SHARE_MAX_COLORS = 8;

const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(60);
const hexSchema = z
  .string()
  .regex(/^#?[0-9A-Fa-f]{6}$/)
  .transform((v) => `#${v.replace('#', '').toUpperCase()}`);

/** Palette condivisa: stessa forma nel link e sul lead. */
export const sharedPaletteSchema = z
  .object({
    v: z.literal(SHARE_VERSION),
    /** Slug di un settore curato; assente per ricerche libere. */
    sector: slugSchema.optional(),
    preset: z.enum(PRESET_KEYS),
    colors: z.array(hexSchema).min(SHARE_MIN_COLORS).max(SHARE_MAX_COLORS),
    /** Indice del primario in `colors`. */
    primary: z.number().int().min(0),
  })
  .refine((p) => p.primary < p.colors.length, { message: 'primary fuori dalla palette', path: ['primary'] });

export type SharedPalette = z.infer<typeof sharedPaletteSchema>;

/** Palette salvata su contacts/leads (`brand_palette`): quella condivisa più la lingua del visitatore. */
export const brandPaletteSchema = z
  .object({
    v: z.literal(SHARE_VERSION),
    sector: slugSchema.optional(),
    preset: z.enum(PRESET_KEYS),
    colors: z.array(hexSchema).min(SHARE_MIN_COLORS).max(SHARE_MAX_COLORS),
    primary: z.number().int().min(0),
    locale: z.enum(['it', 'en']),
  })
  .refine((p) => p.primary < p.colors.length, { message: 'primary fuori dalla palette', path: ['primary'] });

export type BrandPalette = z.infer<typeof brandPaletteSchema>;

/** Querystring del link condiviso (senza `?`). */
export function encodeSharedPalette(p: SharedPalette): string {
  const params = new URLSearchParams();
  params.set('v', String(SHARE_VERSION));
  if (p.sector) params.set('k', p.sector);
  params.set('c', p.colors.map((c) => c.replace('#', '').toUpperCase()).join(','));
  params.set('s', p.preset);
  params.set('p', String(p.primary));
  return params.toString();
}

type ParamSource = URLSearchParams | Record<string, string | string[] | undefined>;

function readParam(source: ParamSource, key: string): string | undefined {
  if (source instanceof URLSearchParams) return source.get(key) ?? undefined;
  const v = source[key];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Decodifica e valida un link condiviso. Restituisce null se manca qualcosa,
 * se un valore non è valido o se lo slug non è un settore noto (quando viene
 * passato `isKnownSector`): in quel caso il settore viene scartato, non
 * l'intera palette.
 */
export function decodeSharedPalette(source: ParamSource, isKnownSector?: (slug: string) => boolean): SharedPalette | null {
  const rawColors = readParam(source, 'c');
  if (!rawColors || rawColors.length > SHARE_MAX_COLORS * 7) return null;
  const sector = readParam(source, 'k');
  const candidate = {
    v: Number(readParam(source, 'v')),
    sector: sector && (!isKnownSector || isKnownSector(sector)) ? sector : undefined,
    preset: readParam(source, 's'),
    colors: rawColors.split(','),
    primary: Number(readParam(source, 'p') ?? '0'),
  };
  const parsed = sharedPaletteSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
