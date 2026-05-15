'use client';

import Image from 'next/image';
import { useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Section } from '@/components/ui/Section';

const STEP_KEYS = ['brief', 'strategy', 'design', 'build', 'launch'] as const;

const STEP_IMAGES: Record<typeof STEP_KEYS[number], string> = {
  brief: '/img/illustrations/1200x800_cpb-01.webp',
  strategy: '/img/illustrations/1200x800_cpb-02.webp',
  design: '/img/illustrations/1200x800_cpb-03.webp',
  build: '/img/illustrations/1200x800_cpb-04.webp',
  launch: '/img/illustrations/1200x800_cpb-05.webp',
};

interface ProcessLongformProps {
  /** Hide the per-component eyebrow header (when composed under a shared header). */
  hideHeader?: boolean;
  /** Override the eyebrow index (default '07'). */
  index?: string;
}

/**
 * Editorial long-form — 5 fasi senza sticky-stack.
 * Layout asimmetrico per fase: alternate img sx/dx per ritmo.
 */
export function ProcessLongform({ hideHeader = false, index = '07' }: ProcessLongformProps = {}) {
  const root = useRef<HTMLElement>(null);
  const t = useTranslations('home.processLongform');

  const steps = STEP_KEYS.map((key, i) => ({
    n: String(i + 1).padStart(2, '0'),
    key,
    label: t(`steps.${key}.label`),
    title: t(`steps.${key}.title`),
    body: t(`steps.${key}.body`),
    img: STEP_IMAGES[key],
  }));

  return (
    <Section ref={root} spacing={hideHeader ? 'none' : 'default'}>
      {!hideHeader && (
        <div className="flex items-baseline justify-between gap-6 mb-16 md:mb-24">
          <p
            className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.25em]"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            {index} — {t('eyebrowSuffix')}
          </p>
          <span
            className="text-xs uppercase tracking-[0.18em]"
            style={{ color: 'var(--color-ink-subtle)' }}
          >
            {t('phasesMeta')}
          </span>
        </div>
      )}

      <ol className="flex flex-col">
        {steps.map((s, idx) => {
          const reverse = idx % 2 === 1; // alterna img sx / dx
          return (
            <li
              key={s.n}
              data-step
              className="grid grid-cols-1 md:grid-cols-12 gap-8 md:gap-14 py-16 md:py-24 items-center"
              style={{
                borderTop: idx === 0 ? '1px solid var(--color-line)' : undefined,
                borderBottom: '1px solid var(--color-line)',
              }}
            >
              {/* Foto boxed con margine */}
              <div className={`md:col-span-5 ${reverse ? 'md:order-2 md:col-start-8' : ''}`}>
                <div
                  className="relative aspect-[4/3] overflow-hidden"
                  style={{ background: 'var(--color-line)' }}
                >
                  <Image
                    data-img
                    src={s.img}
                    alt=""
                    aria-hidden
                    fill
                    sizes="(min-width: 1024px) 50vw, 100vw"
                    className="object-cover will-change-transform"
                  />
                </div>
              </div>

              {/* Numero + titolo + body */}
              <div className={`md:col-span-6 ${reverse ? 'md:order-1 md:col-start-1' : ''}`}>
                <div className="flex items-baseline gap-6 mb-6">
                  <span className="inline-block overflow-hidden">
                    <span
                      data-num
                      className="block font-[family-name:var(--font-display)] tabular-nums will-change-transform"
                      style={{
                        fontSize: 'clamp(2.5rem, 4vw, 4rem)',
                        fontWeight: 500,
                        lineHeight: 0.85,
                        letterSpacing: '-0.04em',
                        color: 'var(--color-accent-deep)',
                      }}
                    >
                      {s.n}
                    </span>
                  </span>
                  <span
                    className="font-mono text-xs uppercase tracking-[0.25em] pt-2"
                    style={{ color: 'var(--color-ink-subtle)' }}
                  >
                    {s.label}
                  </span>
                </div>

                <h3
                  data-title
                  className="font-[family-name:var(--font-display)] mb-6 max-w-[16ch]"
                  style={{
                    fontSize: 'clamp(2rem, 4vw, 3.5rem)',
                    fontWeight: 500,
                    letterSpacing: '-0.03em',
                    lineHeight: 1.0,
                  }}
                >
                  {s.title}
                </h3>

                <p
                  data-body
                  className="text-base md:text-lg leading-relaxed max-w-[48ch]"
                  style={{ color: 'var(--color-ink-muted)' }}
                >
                  {s.body}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}
