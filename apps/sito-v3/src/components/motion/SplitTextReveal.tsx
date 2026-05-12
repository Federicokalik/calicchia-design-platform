'use client';

import { useRef, type ElementType, type ReactNode } from 'react';
import { gsap, useGSAP, SplitText, ScrollTrigger } from '@/lib/gsap';
import { ease, duration as dur, stagger as stg } from '@/lib/motion-tokens';

type SplitMode = 'words' | 'lines' | 'chars' | 'lines,words';

export interface SplitTextRevealProps {
  children: ReactNode;
  /** HTML element to render, e.g. 'h1', 'p'. */
  as?: ElementType;
  className?: string;
  /** Granularity of the split. `mask: 'lines'` clips overflow → no CLS. */
  split?: SplitMode;
  /** Delay before the reveal starts (seconds). */
  delay?: number;
  /** Stagger between successive units (seconds). */
  stagger?: number;
  /**
   * If true, animation is gated on a ScrollTrigger (`start: 'top 85%'`).
   * Default false — components above the fold animate immediately after font-ready.
   */
  scroll?: boolean;
}

/**
 * Reveal text by splitting into words/lines/chars and animating yPercent → 0.
 * - Awaits `document.fonts.ready` to avoid swap-induced re-layout glitch.
 * - Uses `mask: 'lines'` so no manual line wrappers/CLS are needed.
 * - Cleanup is automatic via useGSAP scope.
 */
export function SplitTextReveal({
  children,
  as: Tag = 'h2',
  className,
  split = 'lines,words',
  delay = 0,
  stagger = stg.tight,
  scroll = false,
}: SplitTextRevealProps) {
  const ref = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const el = ref.current;
      if (!el) return;

      const mm = gsap.matchMedia();
      mm.add(
        {
          motion: '(prefers-reduced-motion: no-preference)',
          reduced: '(prefers-reduced-motion: reduce)',
        },
        (ctx) => {
          const reduced = ctx.conditions?.reduced;
          if (reduced) {
            gsap.set(el, { opacity: 1 });
            return;
          }

          const splitInstance = new SplitText(el, {
            type: split,
            mask: split.includes('lines') ? 'lines' : undefined,
            linesClass: 'st-line',
            wordsClass: 'st-word',
            charsClass: 'st-char',
          });

          const targets =
            split.includes('words')
              ? splitInstance.words
              : split.includes('chars')
              ? splitInstance.chars
              : splitInstance.lines;

          const animate = () => {
            gsap.fromTo(
              targets,
              { yPercent: 110 },
              {
                yPercent: 0,
                duration: dur.long,
                ease: ease.expoOut,
                stagger,
                delay,
                scrollTrigger: scroll
                  ? { trigger: el, start: 'top 85%', once: true }
                  : undefined,
              }
            );
          };

          // Avoid FOUT-driven layout flash — wait fonts.
          if (document.fonts?.ready) {
            document.fonts.ready.then(() => {
              animate();
              ScrollTrigger.refresh();
            });
          } else {
            animate();
          }

          return () => {
            splitInstance.revert();
          };
        }
      );
    },
    { scope: ref }
  );

  return (
    <Tag ref={ref as React.Ref<HTMLElement>} className={className}>
      {children}
    </Tag>
  );
}
