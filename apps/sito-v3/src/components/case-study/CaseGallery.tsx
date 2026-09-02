import { getTranslations } from 'next-intl/server';
import { Section } from '@/components/ui/Section';
import type { ProjectSection } from '@/data/types';
import { GalleryLightbox, type GalleryTile } from './GalleryLightbox';

interface CaseGalleryProps {
  section: ProjectSection;
  /** Section number prefix (es. "06"). Default mantiene back-compat. */
  index?: string;
}

/**
 * Gallery editorial asimmetrica — Swiss/Bierut. Regola di composizione:
 *   1 immagine  → una grande (full width)
 *   2 immagini  → una grande + una piccola
 *   3 immagini  → una grande + due piccole (diagonale)
 *   4+          → righe da due (dominante + spalla) alternate lato per lato,
 *                 rotazione seedata dal contenuto → deterministico (niente
 *                 reshuffle a ogni render, niente hydration drift). Un'ultima
 *                 immagine dispari va full width.
 *
 * Il layout si calcola qui (server); griglia + lightbox in <GalleryLightbox>
 * (client). Aspect ratio naturale, `object-contain`, sfondo trasparente.
 */

// FNV-1a — seed stabile dai src della gallery.
function seedFrom(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Layout espliciti per 1-3 (le regole dettate dal brand).
const FIXED_LAYOUTS: Record<number, GalleryTile[]> = {
  1: [{ span: 12 }],
  2: [{ span: 8 }, { span: 4, start: 9, mt: 'md' }],
  3: [{ span: 8 }, { span: 4, start: 9 }, { span: 5, start: 3, mt: 'lg' }],
};

// Righe da 12 (nessun overlap in griglia) per 4+ immagini.
const ROW_TEMPLATES: number[][] = [
  [8, 4],
  [4, 8],
  [7, 5],
  [5, 7],
];

function galleryTiles(count: number, seed: number): GalleryTile[] {
  if (count <= 0) return [];
  if (FIXED_LAYOUTS[count]) return FIXED_LAYOUTS[count];

  const tiles: GalleryTile[] = [];
  let remaining = count;
  let t = seed % ROW_TEMPLATES.length;
  while (remaining >= 2) {
    const [a, b] = ROW_TEMPLATES[t % ROW_TEMPLATES.length];
    tiles.push({ span: a });
    tiles.push({ span: b, mt: b <= 5 ? 'md' : undefined });
    remaining -= 2;
    t += 1;
  }
  if (remaining === 1) tiles.push({ span: 12 });
  return tiles;
}

export async function CaseGallery({ section, index = '06' }: CaseGalleryProps) {
  const t = await getTranslations('lavori.detail');
  const assets = section.assets ?? [];
  if (!assets.length) return null;

  const seed = seedFrom(assets.map((a) => a.src).join('|'));
  const tiles = galleryTiles(assets.length, seed);

  return (
    <Section spacing="default">
      <p
        className="text-[length:var(--text-eyebrow)] uppercase tracking-[0.2em] mb-16"
        style={{ color: 'var(--color-ink-muted)' }}
      >
        {`${index} · ${section.title ?? t('gallery')}`}
      </p>

      <GalleryLightbox
        assets={assets}
        tiles={tiles}
        labels={{
          open: t('lightbox.open'),
          close: t('lightbox.close'),
          prev: t('lightbox.prev'),
          next: t('lightbox.next'),
          ariaLabel: t('lightbox.ariaLabel'),
        }}
      />
    </Section>
  );
}
