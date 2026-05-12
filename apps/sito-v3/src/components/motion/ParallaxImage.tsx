'use client';

import Image, { type ImageProps } from 'next/image';
import { useRef } from 'react';
import { gsap, useGSAP } from '@/lib/gsap';
import { cn } from '@/lib/utils';

interface ParallaxImageProps extends Omit<ImageProps, 'placeholder'> {
  /** -1..1 — negative slows down (image moves up slower than scroll). */
  speed?: number;
  containerClassName?: string;
}

/**
 * Wraps next/image in a parallax shell. SSR renders identity transform —
 * effect is applied post-mount only (no hydration mismatch).
 */
export function ParallaxImage({
  speed = -0.15,
  className,
  containerClassName,
  alt,
  ...rest
}: ParallaxImageProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const w = wrap.current;
      const i = inner.current;
      if (!w || !i) return;
      const mm = gsap.matchMedia();
      mm.add({ motion: '(prefers-reduced-motion: no-preference)' }, () => {
        gsap.to(i, {
          yPercent: speed * 100,
          ease: 'none',
          scrollTrigger: { trigger: w, start: 'top bottom', end: 'bottom top', scrub: true },
        });
      });
    },
    { scope: wrap, dependencies: [speed] }
  );

  return (
    <div
      ref={wrap}
      className={cn('relative overflow-hidden', containerClassName)}
    >
      <div ref={inner} className="will-change-transform">
        <Image alt={alt} className={className} {...rest} />
      </div>
    </div>
  );
}
