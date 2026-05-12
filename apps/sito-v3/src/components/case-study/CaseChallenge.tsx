import { getTranslations } from 'next-intl/server';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { Heading } from '@/components/ui/Heading';
import { Section } from '@/components/ui/Section';
import type { ProjectSection } from '@/data/types';

interface CaseChallengeProps {
  section: ProjectSection;
  /** Section number prefix (es. "02"). Default mantiene back-compat. */
  index?: string;
}

/**
 * Sfida del progetto — layout 4+7 asimmetrico Bierut. Niente parallax
 * scrub, niente carattere ornamentale "⏅" gigante: il rail SX è solo
 * eyebrow + heading display, il body è plain prose con fade-in entry
 * minimal (CSS .case-fade-in, reduced-motion guard).
 *
 * Reference Pentagram-Jen: lo whitespace è elemento attivo, non bug.
 */
export async function CaseChallenge({ section, index = '02' }: CaseChallengeProps) {
  const t = await getTranslations('lavori.detail');

  return (
    <Section spacing="cinematic" bordered="both">
      <div className="grid grid-cols-1 md:grid-cols-12 gap-12 md:gap-16">
        <div className="md:col-span-4 flex flex-col gap-6">
          <Eyebrow>{`${index} · ${t('challenge')}`}</Eyebrow>
        </div>

        <div className="md:col-span-7 md:col-start-6">
          <Heading size="display-md" className="mb-10">
            {section.title ?? t('challengeFallbackHeading')}
          </Heading>
          {section.body && (
            <p
              className="case-fade-in text-lg md:text-xl leading-relaxed"
              style={{ color: 'var(--color-ink-muted)' }}
            >
              {section.body}
            </p>
          )}
        </div>
      </div>
    </Section>
  );
}
