'use client';

import { useRef } from 'react';
import { useTranslations } from 'next-intl';
import { gsap, useGSAP } from '@/lib/gsap';
import { Section } from '@/components/ui/Section';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import type { ProcessStep } from '@/data/services-detail';

interface ServiceProcessProps {
  steps: ProcessStep[];
  index?: string;
}

export function ServiceProcess({ steps, index = '03' }: ServiceProcessProps) {
  const t = useTranslations('servizi.detail');
  const root = useRef<HTMLElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  useGSAP(
    () => {
      const r = root.current;
      if (!r) return;
      const blocks = gsap.utils.toArray<HTMLElement>('[data-step]', r);
      if (!blocks.length) return;
      if (
        prefersReducedMotion ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ) {
        gsap.set(blocks, { opacity: 1, y: 0 });
        return;
      }
      gsap.from(r, {
        opacity: 0,
        y: 16,
        duration: 0.2,
        ease: 'power2.out',
        scrollTrigger: { trigger: r, start: 'top 80%', once: true },
      });
      gsap.from(blocks, {
        opacity: 0,
        y: 12,
        duration: 0.2,
        stagger: 0.06,
        ease: 'power2.out',
        scrollTrigger: { trigger: r, start: 'top 78%', once: true },
      });
    },
    { scope: root, dependencies: [prefersReducedMotion], revertOnUpdate: true }
  );

  return (
    <Section ref={root} spacing="default" bordered="top">
      <div className="flex items-baseline justify-between gap-6 mb-16 md:mb-24">
        <p
          className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.25em]"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          {index} — {t('process')}
        </p>
        <span
          className="text-xs uppercase tracking-[0.18em]"
          style={{ color: 'var(--color-ink-subtle)' }}
        >
          {t('processCount', { count: steps.length })}
        </span>
      </div>

      <ol className="flex flex-col">
        {steps.map((s, idx) => (
          <li
            key={s.step}
            data-step
            className="grid grid-cols-1 md:grid-cols-12 gap-8 md:gap-14 py-12 md:py-20"
            style={{
              borderTop: idx === 0 ? '1px solid var(--color-line)' : undefined,
              borderBottom: '1px solid var(--color-line)',
            }}
          >
            <div className="md:col-span-2">
              <span className="inline-block overflow-hidden">
                <span
                  data-num
                  className="block font-[family-name:var(--font-display)] tabular-nums"
                  style={{
                    fontSize: 'clamp(2.5rem, 4vw, 4rem)',
                    fontWeight: 500,
                    lineHeight: 0.85,
                    letterSpacing: '-0.04em',
                    color: 'var(--color-ink-muted)',
                  }}
                >
                  {String(s.step).padStart(2, '0')}
                </span>
              </span>
            </div>

            <div className="md:col-span-5">
              <h3
                data-title
                className="font-[family-name:var(--font-display)] max-w-[18ch]"
                style={{
                  fontSize: 'clamp(1.75rem, 3vw, 2.5rem)',
                  fontWeight: 500,
                  letterSpacing: '-0.025em',
                  lineHeight: 1.05,
                }}
              >
                {s.title}
              </h3>
            </div>

            <p
              data-body
              className="body-longform md:col-span-5 text-base md:text-lg leading-relaxed self-center max-w-[80ch] whitespace-pre-line text-justify"
              style={{ color: 'var(--color-ink-muted)' }}
            >
              {s.description}
            </p>
          </li>
        ))}
      </ol>
    </Section>
  );
}
