'use client';

import Link from 'next/link';
import { ArrowRight } from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { useRef } from 'react';
import { gsap, useGSAP, SplitText } from '@/lib/gsap';
import { Section } from '@/components/ui/Section';

/**
 * Closing CTA — Swiss restraint.
 * Niente slab amber full-width. Sfondo neutro, tipografia gigantesca,
 * magnetic CTA button (l'unico magnetic della home — è il momento di azione).
 */
export function FinalCTA() {
  const t = useTranslations('home.finalCta');
  const root = useRef<HTMLElement>(null);
  const headlineRef = useRef<HTMLHeadingElement>(null);
  const buttonRef = useRef<HTMLAnchorElement>(null);

  useGSAP(
    (_ctx, contextSafe) => {
      const headline = headlineRef.current;
      const btn = buttonRef.current;
      if (!headline || !btn) return;

      const mm = gsap.matchMedia();
      mm.add(
        {
          motion: '(prefers-reduced-motion: no-preference)',
          reduced: '(prefers-reduced-motion: reduce)',
          hover: '(hover: hover)',
        },
        (ctx) => {
          if (ctx.conditions?.reduced) {
            gsap.set(headline, { opacity: 1 });
            return;
          }

          const split = new SplitText(headline, {
            type: 'lines,words',
            mask: 'lines',
          });
          gsap.fromTo(
            split.words,
            { yPercent: 110 },
            {
              yPercent: 0,
              duration: 0.9,
              ease: 'expo.out',
              stagger: 0.04,
              scrollTrigger: { trigger: headline, start: 'top 80%', once: true },
            }
          );

          if (ctx.conditions?.hover) {
            const xTo = gsap.quickTo(btn, 'x', { duration: 0.5, ease: 'expo.out' });
            const yTo = gsap.quickTo(btn, 'y', { duration: 0.5, ease: 'expo.out' });
            const onMove = contextSafe!((e: MouseEvent) => {
              const rect = btn.getBoundingClientRect();
              xTo((e.clientX - (rect.left + rect.width / 2)) * 0.25);
              yTo((e.clientY - (rect.top + rect.height / 2)) * 0.25);
            });
            const onLeave = contextSafe!(() => {
              xTo(0);
              yTo(0);
            });
            btn.addEventListener('mousemove', onMove);
            btn.addEventListener('mouseleave', onLeave);
            return () => {
              btn.removeEventListener('mousemove', onMove);
              btn.removeEventListener('mouseleave', onLeave);
              split.revert();
            };
          }
          return () => split.revert();
        }
      );
    },
    { scope: root }
  );

  return (
    <Section
      ref={root}
      spacing="epic"
      style={{ background: 'var(--color-bg)' }}
    >
      <div className="flex items-baseline justify-between gap-6 mb-16">
        <p
          className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.25em]"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          {t('eyebrow')}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-12 items-end">
        <h2
          ref={headlineRef}
          className="md:col-span-9 font-[family-name:var(--font-display)] max-w-[14ch]"
          style={{
            fontSize: 'clamp(3.25rem, 9vw, 11rem)',
            fontWeight: 500,
            letterSpacing: '-0.04em',
            lineHeight: 0.92,
            color: 'var(--color-ink)',
          }}
        >
          {t('h2Line1')}
          <br />
          {t('h2Line2')}
        </h2>

        <div className="md:col-span-3 md:justify-self-end">
          <Link
            ref={buttonRef}
            href="/contatti"
            className="inline-flex items-center gap-3 px-9 py-5 text-sm uppercase tracking-[0.2em] font-medium will-change-transform min-h-[56px]"
            style={{
              background: 'var(--color-ink)',
              color: '#FAFAF7',
              border: '1px solid var(--color-ink)',
            }}
          >
            {t('cta')}
            <ArrowRight size={16} weight="regular" aria-hidden />
          </Link>
        </div>
      </div>
    </Section>
  );
}
