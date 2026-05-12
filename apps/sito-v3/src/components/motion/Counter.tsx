'use client';

import { useRef } from 'react';
import { gsap, useGSAP } from '@/lib/gsap';

interface CounterProps {
  to: number;
  from?: number;
  /** Suffix glued to the number — e.g. "+", "%", "/100". */
  suffix?: string;
  className?: string;
  /** Tween duration (seconds). */
  duration?: number;
}

/**
 * Counts from `from` to `to` once when the element enters the viewport.
 * Snaps to integers; respects reduced-motion (renders final value statically).
 */
export function Counter({
  to,
  from = 0,
  suffix = '',
  className,
  duration = 1.6,
}: CounterProps) {
  const ref = useRef<HTMLSpanElement>(null);

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
          if (ctx.conditions?.reduced) {
            el.textContent = `${to}${suffix}`;
            return;
          }
          const obj = { val: from };
          gsap.to(obj, {
            val: to,
            duration,
            ease: 'power2.out',
            snap: { val: 1 },
            scrollTrigger: { trigger: el, start: 'top 85%', once: true },
            onUpdate: () => {
              el.textContent = `${Math.round(obj.val)}${suffix}`;
            },
          });
        }
      );
    },
    { scope: ref, dependencies: [to, from, suffix] }
  );

  return (
    <span ref={ref} className={className}>
      {from}
      {suffix}
    </span>
  );
}
