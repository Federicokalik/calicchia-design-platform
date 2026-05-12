'use client';

import { useRef, type ReactNode } from 'react';
import { gsap, useGSAP, ScrollTrigger } from '@/lib/gsap';

interface HorizontalScrubProps {
  children: ReactNode;
  className?: string;
  /** Extra scroll length added to the pin (in viewport heights). */
  extra?: number;
}

/**
 * Pin the wrapper, translate the inner track horizontally as the user
 * scrolls vertically (containerAnimation pattern). Track must contain
 * the full-width content; this component computes its scroll length.
 *
 * Inner children are tweened with `ease: "none"` (mandatory for
 * containerAnimation correctness — see GSAP docs).
 */
export function HorizontalScrub({
  children,
  className,
  extra = 0.5,
}: HorizontalScrubProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);

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
        },
        (ctx) => {
          if (ctx.conditions?.mobile) {
            // Mobile fallback: native horizontal scroll, no pin.
            t.style.overflowX = 'auto';
            t.style.scrollSnapType = 'x mandatory';
            return;
          }
          const distance = () => Math.max(0, t.scrollWidth - window.innerWidth);
          gsap.to(t, {
            x: () => -distance(),
            ease: 'none',
            scrollTrigger: {
              trigger: w,
              pin: true,
              start: 'top top',
              end: () => `+=${distance() * (1 + extra)}`,
              scrub: 1,
              anticipatePin: 1,
              invalidateOnRefresh: true,
            },
          });
          ScrollTrigger.refresh();
        }
      );
    },
    { scope: wrap, dependencies: [extra] }
  );

  return (
    <section ref={wrap} className={className}>
      <div ref={track} style={{ display: 'flex', willChange: 'transform' }}>
        {children}
      </div>
    </section>
  );
}
