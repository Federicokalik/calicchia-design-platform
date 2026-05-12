'use client';

import { useTranslations } from 'next-intl';
import { useRef } from 'react';
import { Section } from '@/components/ui/Section';
import { gsap, ScrollTrigger, useGSAP } from '@/lib/gsap';

const PRINCIPLES = [
  'siteAsSalesperson',
  'googlePositioning',
  'customerLanguage',
  'visitToContact',
  'trustFollowsForm',
  'noRecycledTemplates',
  'oneContact',
] as const;

export function ManifestoSlides() {
  const t = useTranslations('perche.manifesto');
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const section = root.current;
      if (!section) return;

      const mm = gsap.matchMedia();
      mm.add(
        {
          motion: '(prefers-reduced-motion: no-preference)',
          reduced: '(prefers-reduced-motion: reduce)',
        },
        (ctx) => {
          const rows = gsap.utils.toArray<HTMLElement>('[data-manifesto-row]', section);

          if (ctx.conditions?.reduced) {
            gsap.set(rows, { autoAlpha: 1, y: 0 });
            return;
          }

          rows.forEach((row) => {
            gsap.fromTo(
              row,
              { autoAlpha: 0, y: 28 },
              {
                autoAlpha: 1,
                y: 0,
                duration: 0.85,
                ease: 'power3.out',
                scrollTrigger: {
                  trigger: row,
                  start: 'top 82%',
                  once: true,
                },
              }
            );
          });

          if (document.fonts?.ready) {
            document.fonts.ready.then(() => ScrollTrigger.refresh());
          }
        }
      );

      return () => mm.revert();
    },
    { scope: root }
  );

  return (
    <Section ref={root} spacing="compact" bordered="top">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-x-12 gap-y-10">
        <div className="lg:col-span-4">
          {/* Swiss compliance 2026-05-09: rimosso 'lg:sticky lg:top-28' */}
          <div>
            <p
              className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.24em]"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              {t('eyebrow')}
            </p>
            <h2
              className="mt-7 font-[family-name:var(--font-display)] max-w-[10ch]"
              style={{
                fontSize: 'clamp(2.5rem, 4vw + 0.5rem, 4.75rem)',
                fontWeight: 500,
                letterSpacing: '-0.03em',
                lineHeight: 0.98,
              }}
            >
              {t('h2')}
            </h2>
          </div>
        </div>

        <div className="lg:col-span-8">
          <div
            className="divide-y"
            style={{ borderTop: '1px solid var(--color-border)', borderBottom: '1px solid var(--color-border)', borderColor: 'var(--color-border)' }}
          >
            {PRINCIPLES.map((item, idx) => (
              <article
                key={item}
                data-manifesto-row
                className="grid grid-cols-1 md:grid-cols-[8rem_1fr] gap-5 py-9 md:py-11"
              >
                <span
                  className="font-mono text-xs uppercase tracking-[0.18em]"
                  style={{ color: 'var(--color-ink-subtle)' }}
                >
                  {String(idx + 1).padStart(2, '0')}
                </span>
                <div>
                  <h3
                    className="font-[family-name:var(--font-display)]"
                    style={{
                      fontSize: 'clamp(1.75rem, 2vw + 1rem, 3rem)',
                      fontWeight: 500,
                      letterSpacing: '-0.025em',
                      lineHeight: 1,
                    }}
                  >
                    {t(`principles.${item}.label`)}
                  </h3>
                  <p
                    className="body-longform mt-5 max-w-[80ch] text-lg md:text-xl leading-snug"
                    style={{ color: 'var(--color-text-secondary)' }}
                  >
                    {t(`principles.${item}.text`)}
                  </p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}
