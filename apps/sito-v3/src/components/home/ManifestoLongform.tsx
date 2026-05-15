'use client';

import { useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Section } from '@/components/ui/Section';

const PILLAR_KEYS = ['details', 'ahead', 'crossSkills', 'oneContact', 'results'] as const;

interface ManifestoLongformProps {
  /** Hide the per-component eyebrow header (when composed under a shared header). */
  hideHeader?: boolean;
  /** Override the eyebrow index (default '06'). */
  index?: string;
}

/**
 * Editorial long-form — 5 pillars without pin/sticky.
 * Each block: numero ordinale + titolo + body, hairline 1px tra blocchi.
 */
export function ManifestoLongform({ hideHeader = false, index = '06' }: ManifestoLongformProps = {}) {
  const root = useRef<HTMLElement>(null);
  const t = useTranslations('home.manifestoLongform');

  const pillars = PILLAR_KEYS.map((key, i) => ({
    n: String(i + 1).padStart(2, '0'),
    key,
    title: t(`pillars.${key}.title`),
    body: t(`pillars.${key}.body`),
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
            {t('pillarsCount')}
          </span>
        </div>
      )}

      <ol className="flex flex-col">
        {pillars.map((p, idx) => (
          <li
            key={p.n}
            data-pillar
            className="grid grid-cols-1 md:grid-cols-12 gap-6 md:gap-12 py-12 md:py-16"
            style={{
              borderTop: idx === 0 ? '1px solid var(--color-line)' : undefined,
              borderBottom: '1px solid var(--color-line)',
            }}
          >
            <div className="md:col-span-2">
              <span className="inline-block overflow-hidden">
                <span
                  data-num
                  className="block font-[family-name:var(--font-display)] tabular-nums will-change-transform"
                  style={{
                    fontSize: 'clamp(3rem, 5vw, 5rem)',
                    fontWeight: 500,
                    lineHeight: 0.85,
                    letterSpacing: '-0.04em',
                    color: 'var(--color-accent-deep)',
                  }}
                >
                  {p.n}
                </span>
              </span>
            </div>

            <div className="md:col-span-6">
              <h3
                data-title
                className="font-[family-name:var(--font-display)] max-w-[18ch]"
                style={{
                  fontSize: 'clamp(1.75rem, 3vw, 2.75rem)',
                  fontWeight: 500,
                  letterSpacing: '-0.025em',
                  lineHeight: 1.05,
                }}
              >
                {p.title}
              </h3>
            </div>

            <p
              data-body
              className="md:col-span-4 text-base md:text-lg leading-relaxed max-w-[42ch]"
              style={{ color: 'var(--color-ink-muted)' }}
            >
              {p.body}
            </p>
          </li>
        ))}
      </ol>
    </Section>
  );
}
