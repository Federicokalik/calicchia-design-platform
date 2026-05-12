'use client';

import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { useRef } from 'react';
import { gsap, useGSAP } from '@/lib/gsap';
import { SplitTextReveal } from '@/components/motion/SplitTextReveal';
import { Section } from '@/components/ui/Section';

interface PortraitBlockProps {
  years: number;
}

/**
 * Editorial portrait — Swiss restraint.
 * Foto boxed 4:5 con margine (no full-bleed, no clip-path drama, no hover-mask).
 * Bio long-form a destra, stats below.
 *
 * Reveal: clip-path inset(8% → 0) on enter (subtle, not full curtain).
 */
export function PortraitBlock({ years }: PortraitBlockProps) {
  const t = useTranslations('home.portrait');
  const root = useRef<HTMLElement>(null);
  const photoWrap = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const r = root.current;
      const w = photoWrap.current;
      if (!r || !w) return;

      const mm = gsap.matchMedia();
      mm.add(
        {
          motion: '(prefers-reduced-motion: no-preference)',
          reduced: '(prefers-reduced-motion: reduce)',
        },
        (ctx) => {
          if (ctx.conditions?.reduced) {
            gsap.set(w, { clipPath: 'inset(0)' });
            return;
          }
          gsap.set(w, { clipPath: 'inset(6% 6% 6% 6%)' });
          gsap.to(w, {
            clipPath: 'inset(0% 0 0 0)',
            duration: 1.2,
            ease: 'expo.out',
            scrollTrigger: { trigger: r, start: 'top 75%', once: true },
          });
        }
      );
    },
    { scope: root }
  );

  return (
    <Section ref={root} spacing="default">
      <div className="flex items-baseline justify-between gap-6 mb-16 md:mb-24">
        <p
          className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.25em]"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          {t('eyebrow')}
        </p>
        <span className="text-xs uppercase tracking-[0.18em]"
              style={{ color: 'var(--color-ink-subtle)' }}>
          {t('location')}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-10 md:gap-16">
        <div className="md:col-span-5 md:col-start-1">
          <div
            ref={photoWrap}
            className="relative aspect-[4/5] overflow-hidden will-change-[clip-path]"
            style={{ background: 'var(--color-line)' }}
          >
            <Image
              src="/img/federico-calicchia-ritratto-web-designer.webp"
              alt={t('portraitAlt')}
              fill
              sizes="(min-width: 1024px) 40vw, 100vw"
              className="object-cover"
              priority
            />
          </div>
        </div>

        <div className="md:col-span-6 md:col-start-7 flex flex-col justify-center gap-10">
          <SplitTextReveal
            as="h2"
            split="lines,words"
            scroll
            className="font-[family-name:var(--font-display)] max-w-[52ch] whitespace-pre-line text-justify"
          >
            {t('h2')}
          </SplitTextReveal>

          <p className="text-base md:text-lg leading-relaxed max-w-[52ch] whitespace-pre-line text-justify"
             style={{ color: 'var(--color-ink-muted)' }}>
            {t('bio')}
          </p>

          <ul
            className="grid grid-cols-2 gap-x-10 gap-y-6 max-w-md text-sm pt-6"
            style={{ borderTop: '1px solid var(--color-line)' }}
          >
            {[
              [`${years}+`, t('stats.years')],
              ['70+', t('stats.projects')],
              ['1', t('stats.contact')],
              ['0', t('stats.agencies')],
            ].map(([n, l]) => (
              <li key={l} className="flex flex-col gap-2">
                <span className="font-[family-name:var(--font-display)] text-3xl md:text-4xl tabular-nums"
                      style={{ fontWeight: 500, color: 'var(--color-accent-deep)', letterSpacing: '-0.03em' }}>
                  {n}
                </span>
                <span className="font-mono text-xs uppercase tracking-[0.15em]"
                      style={{ color: 'var(--color-ink-muted)' }}>
                  {l}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Section>
  );
}
