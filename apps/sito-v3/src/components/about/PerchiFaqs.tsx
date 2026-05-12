'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Section } from '@/components/ui/Section';
import { getPerchiFaqs } from '@/data/perchi-faqs';
import type { Locale } from '@/lib/i18n';

interface PerchiFaqsProps {
  index?: string;
  /** Optional override; falls back to t('perchiFaqs.eyebrowDefault'). */
  eyebrow?: string;
  /** Optional override; falls back to t('perchiFaqs.titleDefault'). */
  title?: string;
  /** Optional override; falls back to t('perchiFaqs.subtitleDefault'). */
  subtitle?: string;
}

/**
 * Accordion FAQ specifico per la pagina /perche-scegliere-me.
 * Single-open behavior (un solo item aperto alla volta).
 * Niente cifre nelle risposte (vedi data/perchi-faqs.ts).
 */
export function PerchiFaqs({
  index = '06',
  eyebrow,
  title,
  subtitle,
}: PerchiFaqsProps) {
  const locale = useLocale() as Locale;
  const t = useTranslations('perchiFaqs');
  const faqs = getPerchiFaqs(locale);

  const [openIndex, setOpenIndex] = useState<number | null>(0);

  const eyebrowText = eyebrow ?? t('eyebrowDefault');
  const titleText = title ?? t('titleDefault');
  const subtitleText = subtitle ?? t('subtitleDefault');

  return (
    <Section spacing="default" bordered="top">
      <div className="flex items-baseline justify-between gap-6 mb-12 md:mb-20">
        <p
          className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.25em]"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          {index} — {eyebrowText}
        </p>
        <span
          className="text-xs uppercase tracking-[0.18em]"
          style={{ color: 'var(--color-ink-subtle)' }}
        >
          {t('questionsCount', { count: faqs.length })}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-12 md:gap-16">
        <div className="md:col-span-5">
          <h2
            className="font-[family-name:var(--font-display)] mb-6 max-w-[14ch]"
            style={{
              fontSize: 'clamp(2.5rem, 4.5vw, 4rem)',
              fontWeight: 500,
              letterSpacing: '-0.03em',
              lineHeight: 0.95,
            }}
          >
            {titleText}
          </h2>
          <p
            className="text-lg md:text-xl leading-relaxed max-w-[42ch]"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            {subtitleText}
          </p>
        </div>

        <ul className="md:col-span-7 flex flex-col">
          {faqs.map((faq, idx) => {
            const open = openIndex === idx;
            const id = `perchi-faq-${idx}`;
            return (
              <li
                key={idx}
                style={{
                  borderTop: idx === 0 ? '1px solid var(--color-line)' : undefined,
                  borderBottom: '1px solid var(--color-line)',
                }}
              >
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={id}
                  onClick={() => setOpenIndex(open ? null : idx)}
                  className="w-full text-left py-6 md:py-8 flex items-start justify-between gap-6 transition-colors hover:bg-[var(--color-bg-elev)] min-h-[44px]"
                >
                  <span
                    className="font-[family-name:var(--font-display)] flex-1"
                    style={{
                      fontSize: 'clamp(1.25rem, 2vw, 1.625rem)',
                      fontWeight: 500,
                      letterSpacing: '-0.015em',
                      lineHeight: 1.25,
                    }}
                  >
                    {faq.question}
                  </span>
                  <span
                    aria-hidden
                    className="font-mono text-2xl pt-1 transition-transform"
                    style={{
                      color: 'var(--color-accent-deep)',
                      transform: open ? 'rotate(45deg)' : 'rotate(0deg)',
                    }}
                  >
                    +
                  </span>
                </button>

                <div
                  id={id}
                  hidden={!open}
                  className="pb-6 md:pb-8 pr-12"
                >
                  <p
                    className="text-base md:text-lg leading-relaxed max-w-[55ch]"
                    style={{ color: 'var(--color-ink-muted)' }}
                  >
                    {faq.answer}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </Section>
  );
}
