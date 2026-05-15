import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { Section } from '@/components/ui/Section';
import type { Project } from '@/data/types';

interface CaseNextProps {
  next?: Project;
}

/**
 * Closing CTA — pattern hairline editorial coerente col resto del case study.
 * Niente slab fullbleed arancione (single-accent rule violata: l'accent va
 * su 1 elemento, non su sfondo gigante). Lo stile resta Bierut: top border,
 * eyebrow mono "Prossimo progetto", display heading, link mono accent.
 *
 * v1: when next === current (self-loop) we render the "back to all" CTA
 * instead — avoids dead-link feeling on solo-project showcase.
 */
export async function CaseNext({ next }: CaseNextProps) {
  const t = await getTranslations('lavori.detail');
  const isLoop = !next;

  return (
    <Section spacing="default" bordered="top">
      <div className="grid grid-cols-1 md:grid-cols-12 gap-6 md:gap-10">
        <div className="md:col-span-3">
          <p
            className="font-mono text-xs uppercase tracking-[0.22em]"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            {isLoop ? t('seeMore') : t('next')}
          </p>
        </div>

        <div className="md:col-span-9">
          <Link
            href={isLoop ? '/lavori' : `/lavori/${next!.slug}`}
            className="group block"
          >
            <h2
              className="font-[family-name:var(--font-display)]"
              style={{
                fontSize: 'var(--text-display-xl)',
                fontWeight: 500,
                letterSpacing: '-0.035em',
                lineHeight: 0.92,
                color: 'var(--color-ink)',
              }}
            >
              {isLoop ? t('allProjects') : next!.title}
            </h2>

            <span
              className="mt-10 inline-flex items-center gap-3 font-mono text-xs uppercase tracking-[0.22em]"
              style={{ color: 'var(--color-accent-deep)' }}
            >
              {isLoop ? t('goToArchive') : t('goToCaseStudy')}
              <span
                className="transition-transform duration-200 group-hover:translate-x-1"
                aria-hidden
              >
                →
              </span>
            </span>
          </Link>
        </div>
      </div>
    </Section>
  );
}
