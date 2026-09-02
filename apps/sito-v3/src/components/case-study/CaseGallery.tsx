import Image from 'next/image';
import { getTranslations } from 'next-intl/server';
import { Section } from '@/components/ui/Section';
import type { ProjectSection } from '@/data/types';

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
 * Le immagini stanno ferme (niente parallax). Aspect ratio naturale (da
 * width/height dell'asset), `object-contain`, sfondo trasparente: gli
 * screenshot PNG con ombra alpha si fondono con lo sfondo pagina.
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

type Tile = { span: number; start?: number; mt?: 'md' | 'lg' };

// Layout espliciti per 1-3 (le regole dettate dal brand).
const FIXED_LAYOUTS: Record<number, Tile[]> = {
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

function galleryTiles(count: number, seed: number): Tile[] {
  if (count <= 0) return [];
  if (FIXED_LAYOUTS[count]) return FIXED_LAYOUTS[count];

  const tiles: Tile[] = [];
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

// Classi literal (Tailwind v4 non rileva template-string dinamiche).
const SPAN_CLASS: Record<number, string> = {
  4: 'md:col-span-4',
  5: 'md:col-span-5',
  7: 'md:col-span-7',
  8: 'md:col-span-8',
  12: 'md:col-span-12',
};
const START_CLASS: Record<number, string> = {
  3: 'md:col-start-3',
  9: 'md:col-start-9',
};
const MT_CLASS: Record<'md' | 'lg', string> = {
  md: 'md:mt-16',
  lg: 'md:mt-24 lg:mt-32',
};

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

      <div className="grid grid-cols-12 gap-6 md:gap-10">
        {assets.map((a, idx) => {
          const tile = tiles[idx] ?? { span: 8 };
          const isVideo = a.type === 'video' || !!a.video;
          const ratioW = a.width || 1600;
          const ratioH = a.height || 1067;
          const cls = [
            'relative min-w-0 col-span-12',
            SPAN_CLASS[tile.span] ?? 'md:col-span-8',
            tile.start ? START_CLASS[tile.start] : '',
            tile.mt ? MT_CLASS[tile.mt] : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <figure key={a.src + idx} className={cls}>
              <div
                className="overflow-hidden"
                style={{ aspectRatio: `${ratioW} / ${ratioH}` }}
              >
                {isVideo ? (
                  <video
                    src={a.video ?? a.src}
                    poster={a.poster}
                    controls
                    playsInline
                    preload="metadata"
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <Image
                    src={a.src}
                    alt={a.alt}
                    width={ratioW}
                    height={ratioH}
                    sizes="(min-width: 1024px) 60vw, 100vw"
                    className="h-full w-full object-contain"
                  />
                )}
              </div>
              {a.alt && (
                <figcaption
                  className="mt-3 text-xs uppercase tracking-[0.18em]"
                  style={{ color: 'var(--color-ink-subtle)' }}
                >
                  {a.alt}
                </figcaption>
              )}
            </figure>
          );
        })}
      </div>
    </Section>
  );
}
