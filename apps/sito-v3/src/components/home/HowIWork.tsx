'use client';

import { useTranslations } from 'next-intl';
import { Heading } from '@/components/ui/Heading';
import { Section } from '@/components/ui/Section';
import { ManifestoLongform } from './ManifestoLongform';
import { ProcessLongform } from './ProcessLongform';

/**
 * Come lavoro — unified narrative section that combines:
 *   1. Manifesto (5 pillars: principles)
 *   2. Process (5 fasi: how the principles become work)
 *
 * Renders one shared header on top, then the two sub-blocks back-to-back
 * without their own eyebrows. Each retains its own GSAP animations
 * because hideHeader only suppresses the header, not the rest.
 *
 * The standalone components stay exported for re-use on /perche-scegliere-me
 * and other pages that may want them in isolation.
 */
export function HowIWork() {
  const t = useTranslations('home.howIWork');

  return (
    <Section
      spacingTop="default"
      spacingBottom="tight"
      bordered="top"
      fullBleed
      className="max-w-[1600px] mx-auto"
      aria-labelledby="how-i-work-heading"
    >
      <div className="px-6 md:px-10 lg:px-14 mb-16 md:mb-24">
        <div className="flex items-baseline justify-between gap-6 mb-12 md:mb-16">
          <p
            className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.25em]"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            {t('eyebrow')}
          </p>
          <span
            className="text-xs uppercase tracking-[0.18em]"
            style={{ color: 'var(--color-ink-subtle)' }}
          >
            {t('meta')}
          </span>
        </div>

        <Heading id="how-i-work-heading" size="display-lg" style={{ maxWidth: '18ch' }}>
          {t('h2')}
        </Heading>

        <p
          className="mt-8 text-base md:text-lg leading-relaxed max-w-[58ch]"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          {t('lead')}
        </p>
      </div>

      <div className="flex flex-col">
        <ManifestoLongform hideHeader index="06" />
        <ProcessLongform hideHeader index="06" />
      </div>
    </Section>
  );
}
