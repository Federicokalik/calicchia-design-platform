'use client';

import { useRef, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { gsap, useGSAP } from '@/lib/gsap';

interface MagneticButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  /** How far the element follows the cursor (0–1). */
  strength?: number;
}

/**
 * Pulls the button toward the cursor on mouseenter; springs back on leave.
 * Uses GSAP quickTo for cheap per-frame writes (no React re-renders).
 * Disabled on touch + reduced-motion.
 */
export function MagneticButton({
  children,
  strength = 0.35,
  className,
  ...rest
}: MagneticButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);

  useGSAP(
    (_ctx, contextSafe) => {
      const el = ref.current;
      if (!el) return;
      const mm = gsap.matchMedia();
      mm.add(
        {
          motion: '(prefers-reduced-motion: no-preference) and (hover: hover)',
        },
        () => {
          const xTo = gsap.quickTo(el, 'x', { duration: 0.6, ease: 'expo.out' });
          const yTo = gsap.quickTo(el, 'y', { duration: 0.6, ease: 'expo.out' });

          const onMove = contextSafe!((e: MouseEvent) => {
            const rect = el.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            xTo((e.clientX - cx) * strength);
            yTo((e.clientY - cy) * strength);
          });
          const onLeave = contextSafe!(() => {
            xTo(0);
            yTo(0);
          });

          el.addEventListener('mousemove', onMove);
          el.addEventListener('mouseleave', onLeave);
          return () => {
            el.removeEventListener('mousemove', onMove);
            el.removeEventListener('mouseleave', onLeave);
          };
        }
      );
    },
    { scope: ref }
  );

  return (
    <button ref={ref} className={className} {...rest}>
      {children}
    </button>
  );
}
