'use client';

import { useRef, type ReactNode } from 'react';
import { gsap, useGSAP } from '@/lib/gsap';

interface PinSectionProps {
  children: ReactNode;
  /** Additional scroll length while pinned. Default 1 → pin lasts 1 viewport. */
  length?: number;
  className?: string;
}

/**
 * Generic pin primitive — wraps children, pins for `length` viewports.
 * Use when a sticky-stack or staged reveal needs a controlled scrub range.
 * Children should manage their own internal animations via ScrollTrigger
 * targeting nested elements.
 */
export function PinSection({ children, length = 1, className }: PinSectionProps) {
  const ref = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const el = ref.current;
      if (!el) return;
      const mm = gsap.matchMedia();
      mm.add(
        { desktop: '(min-width: 768px) and (prefers-reduced-motion: no-preference)' },
        () => {
          gsap.to(el, {
            scrollTrigger: {
              trigger: el,
              pin: true,
              start: 'top top',
              end: () => `+=${window.innerHeight * length}`,
              anticipatePin: 1,
              invalidateOnRefresh: true,
            },
          });
        }
      );
    },
    { scope: ref, dependencies: [length] }
  );

  return (
    <section ref={ref} className={className}>
      {children}
    </section>
  );
}
