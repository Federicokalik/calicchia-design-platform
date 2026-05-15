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
 * Gallery editorial asimmetrica. Bierut purist: niente parallax per-tile,
 * niente cinematica scroll-tied. Le immagini stanno ferme — il visual si
 * costruisce dall'alternanza dei col-span (8/4/7) e dallo whitespace
 * intenzionale tra tile.
 */
export async function CaseGallery({ section, index = '06' }: CaseGalleryProps) {
  const t = await getTranslations('lavori.detail');

  if (!section.assets?.length) return null;

  return (
    <Section spacing="default">
      <p
        className="text-[length:var(--text-eyebrow)] uppercase tracking-[0.2em] mb-16"
        style={{ color: 'var(--color-ink-muted)' }}
      >
        {`${index} · ${section.title ?? t('gallery')}`}
      </p>

      <div className="grid grid-cols-12 gap-6 md:gap-8">
        {section.assets.map((a, idx) => {
          const layouts = [
            'col-span-12 md:col-span-8',
            'col-span-12 md:col-span-4 md:mt-24',
            'col-span-12 md:col-span-7 md:col-start-3',
          ];
          return (
            <figure
              key={a.src + idx}
              className={`relative overflow-hidden ${layouts[idx % layouts.length]}`}
            >
              <div
                className="aspect-[16/10] overflow-hidden"
                style={{ background: 'var(--color-line)' }}
              >
                <Image
                  src={a.src}
                  alt={a.alt}
                  width={a.width ?? 1600}
                  height={a.height ?? 1200}
                  sizes="(min-width: 1024px) 50vw, 100vw"
                  className="w-full h-full object-cover"
                />
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
