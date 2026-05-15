'use client';

import Image from 'next/image';
import { ArrowRight } from '@phosphor-icons/react';
import { useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { gsap, useGSAP, ScrollTrigger } from '@/lib/gsap';
import { Section } from '@/components/ui/Section';
import type { ShowcaseTile } from '@/data/showcase';

interface WorksHorizontalProps {
  showcase: ShowcaseTile[];
}

/**
 * Pin + horizontal scrub gallery (containerAnimation pattern).
 *
 * Swiss compliance exception (2026-05-09): pin/horizontal scrub allowed
 * ONLY on home as signature section. matchMedia gates physics behind
 * `(min-width: 768px) and (prefers-reduced-motion: no-preference)` —
 * mobile + reduced-motion fallback to native overflow-x scroll-snap.
 */
export function WorksHorizontal({ showcase }: WorksHorizontalProps) {
  const wrap = useRef<HTMLElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const t = useTranslations('home.worksHorizontal');

  useGSAP(
    () => {
      const w = wrap.current;
      const t = track.current;
      if (!w || !t) return;

      const mm = gsap.matchMedia();
      mm.add(
        {
          desktop: '(min-width: 768px) and (prefers-reduced-motion: no-preference)',
          mobile: '(max-width: 767px)',
          reduced: '(prefers-reduced-motion: reduce)',
        },
        (ctx) => {
          if (ctx.conditions?.mobile || ctx.conditions?.reduced) {
            t.style.overflowX = 'auto';
            t.style.scrollSnapType = 'x mandatory';
            return;
          }

          const distance = () => Math.max(0, t.scrollWidth - window.innerWidth);
          const scrubTween = gsap.to(t, {
            x: () => -distance(),
            ease: 'none',
            scrollTrigger: {
              trigger: w,
              pin: true,
              // Default pinType: 'fixed' — keeps the fixed header anchored
              // correctly. (pinType: 'transform' would break the header.)
              start: 'top top',
              end: () => `+=${distance() + window.innerHeight * 0.6}`,
              scrub: 1,
              // anticipatePin telegrafa il pin in anticipo causando lo
              // "scatto" prima che la sezione raggiunga davvero il top,
              // soprattutto con Lenis che ha latenza visiva. Disattivato.
              anticipatePin: 0,
              invalidateOnRefresh: true,
            },
          });

          ScrollTrigger.refresh();
        }
      );
    },
    { scope: wrap }
  );

  return (
    <Section ref={wrap} spacing="none" fullBleed className="overflow-hidden">
      <div className="px-6 md:px-10 lg:px-14 pt-32 max-w-[1600px] mx-auto">
        <div className="flex items-baseline justify-between gap-6">
          <p
            className="text-[length:var(--text-eyebrow)] uppercase tracking-[0.2em]"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            {t('eyebrow', { count: showcase.length })}
          </p>
          <Link href="/lavori" className="text-sm uppercase tracking-[0.15em] hover:opacity-60 transition-opacity">
            {t('viewAll')}
          </Link>
        </div>
        <h2
          className="font-[family-name:var(--font-display)] mt-6 mb-16 max-w-[20ch]"
          style={{
            fontSize: 'var(--text-display-md)',
            fontWeight: 500,
            letterSpacing: '-0.025em',
            lineHeight: 1,
          }}
        >
          {t('h2')}
        </h2>
      </div>

      <div ref={track} className="flex gap-8 will-change-transform pl-6 md:pl-10 lg:pl-14 pb-16">
        {showcase.map((s) => {
          // Estrai slug da href `/lavori/{slug}` per il morph cross-route.
          const slug = s.href.startsWith('/lavori/')
            ? s.href.replace('/lavori/', '')
            : null;
          const morphName = slug ? `case-${slug}` : undefined;
          return (
          <Link
            key={s.src}
            href={s.href}
            className="work-card group shrink-0 flex flex-col"
            style={{ width: 'min(72vw, 640px)' }}
          >
            <div
              className="aspect-[4/3] mb-5 overflow-hidden relative"
              style={{ background: 'var(--color-line)' }}
            >
              <Image
                src={s.src}
                alt={s.client ? `${s.client} — ${s.title}` : s.title}
                fill
                sizes="(min-width: 1024px) 60vw, 90vw"
                className="work-card__img object-cover transition-transform duration-700 will-change-transform group-hover:scale-[1.04]"
                style={morphName ? { viewTransitionName: morphName } : undefined}
              />
              {(s.client || s.year > 0) && (
                <div
                  className="absolute inset-x-0 bottom-0 p-4 flex items-end justify-between gap-3"
                  style={{
                    background: 'linear-gradient(to top, rgba(0,0,0,0.45) 0%, transparent 60%)',
                  }}
                >
                  {s.client ? (
                    <span
                      className="text-xs uppercase tracking-[0.18em] font-medium"
                      style={{ color: '#fff' }}
                    >
                      {s.client}
                    </span>
                  ) : null}
                  {s.year > 0 ? (
                    <span
                      className="font-mono text-xs"
                      style={{ color: 'rgba(255,255,255,0.85)' }}
                    >
                      {s.year}
                    </span>
                  ) : null}
                </div>
              )}
            </div>
            <div className="work-card__meta">
              <div className="flex items-baseline justify-between gap-4 mb-2">
                <h3
                  className="font-[family-name:var(--font-display)] text-2xl md:text-3xl"
                  style={{ fontWeight: 500, letterSpacing: '-0.02em' }}
                >
                  {s.title}
                </h3>
                <span className="text-xs uppercase tracking-[0.18em] inline-flex items-center gap-2 transition-transform group-hover:translate-x-1"
                      style={{ color: 'var(--color-ink-muted)' }}>
                  {t('openLabel')} <ArrowRight size={14} weight="regular" aria-hidden />
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {s.tags.map((t) => (
                  <span
                    key={t}
                    className="text-xs uppercase tracking-[0.15em]"
                    style={{ color: 'var(--color-ink-muted)' }}
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          </Link>
          );
        })}
      </div>
    </Section>
  );
}
