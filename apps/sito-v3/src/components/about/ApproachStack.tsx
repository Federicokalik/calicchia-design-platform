'use client';

import { useRef } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { gsap, useGSAP, SplitText } from '@/lib/gsap';
import { Section } from '@/components/ui/Section';
import { getApproach } from '@/data/approach';
import type { Locale } from '@/lib/i18n';

interface ApproachStackProps {
  /** Section number shown in the eyebrow */
  index?: string;
  /** Optional override; falls back to t('approachStack.eyebrowDefault'). */
  eyebrow?: string;
}

/**
 * 5-pillar editorial stack — riprende il pattern di ManifestoLongform ma
 * leggibile dai dati di `data/approach.ts` con icona Phosphor a sinistra.
 * Usato in `/perche-scegliere-me` (e potenzialmente nella home).
 */
export function ApproachStack({
  index = '02',
  eyebrow,
}: ApproachStackProps) {
  const root = useRef<HTMLElement>(null);
  const locale = useLocale() as Locale;
  const t = useTranslations('approachStack');
  const items = getApproach(locale);

  const eyebrowText = eyebrow ?? t('eyebrowDefault');

  useGSAP(
    () => {
      const r = root.current;
      if (!r) return;
      const mm = gsap.matchMedia();
      mm.add(
        {
          motion: '(prefers-reduced-motion: no-preference)',
          reduced: '(prefers-reduced-motion: reduce)',
        },
        (ctx) => {
          if (ctx.conditions?.reduced) return;
          const blocks = gsap.utils.toArray<HTMLElement>('[data-claim]', r);
          blocks.forEach((block) => {
            const num = block.querySelector<HTMLElement>('[data-num]');
            const icon = block.querySelector<HTMLElement>('[data-icon]');
            const title = block.querySelector<HTMLElement>('[data-title]');
            const body = block.querySelector<HTMLElement>('[data-body]');
            if (!num || !title || !body) return;
            const ts = new SplitText(title, { type: 'lines,words', mask: 'lines' });
            const bs = new SplitText(body, { type: 'lines', mask: 'lines' });
            gsap.set(num, { yPercent: 110, opacity: 0 });
            if (icon) gsap.set(icon, { scale: 0.6, opacity: 0 });
            gsap.set(ts.words, { yPercent: 110 });
            gsap.set(bs.lines, { yPercent: 110 });
            const tl = gsap.timeline({
              scrollTrigger: { trigger: block, start: 'top 80%', once: true },
              defaults: { ease: 'expo.out' },
            });
            tl.to(num, { yPercent: 0, opacity: 1, duration: 0.7 });
            if (icon) tl.to(icon, { scale: 1, opacity: 1, duration: 0.7 }, '<0.1');
            tl.to(ts.words, { yPercent: 0, duration: 0.9, stagger: 0.04 }, '<0.05')
              .to(bs.lines, { yPercent: 0, duration: 0.8, stagger: 0.06 }, '<0.2');
          });
        }
      );
    },
    { scope: root }
  );

  return (
    <Section ref={root} spacing="default" bordered="top">
      <div className="flex items-baseline justify-between gap-6 mb-16 md:mb-24">
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
          {t('pillarsCount', { count: items.length })}
        </span>
      </div>

      <ol className="flex flex-col">
        {items.map((p, idx) => (
          <li
            key={idx}
            data-claim
            className="grid grid-cols-1 md:grid-cols-12 gap-6 md:gap-12 py-12 md:py-16"
            style={{
              borderTop: idx === 0 ? '1px solid var(--color-line)' : undefined,
              borderBottom: '1px solid var(--color-line)',
            }}
          >
            <div className="md:col-span-2 flex items-start gap-4">
              <span className="inline-block overflow-hidden">
                <span
                  data-num
                  className="block font-[family-name:var(--font-display)] tabular-nums will-change-transform"
                  style={{
                    fontSize: 'clamp(2.25rem, 4vw, 3.75rem)',
                    fontWeight: 500,
                    lineHeight: 0.85,
                    letterSpacing: '-0.04em',
                    color: 'var(--color-accent-deep)',
                  }}
                >
                  {String(idx + 1).padStart(2, '0')}
                </span>
              </span>
            </div>

            <div className="md:col-span-6">
              <div className="flex items-center gap-4 mb-4">
                <i
                  data-icon
                  className={`${p.phosphorIcon} text-3xl will-change-transform`}
                  aria-hidden
                  style={{ color: 'var(--color-ink-muted)' }}
                />
              </div>
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
              className="body-longform md:col-span-4 text-base md:text-lg leading-relaxed max-w-[80ch]"
              style={{ color: 'var(--color-ink-muted)' }}
            >
              {p.description}
            </p>
          </li>
        ))}
      </ol>
    </Section>
  );
}
