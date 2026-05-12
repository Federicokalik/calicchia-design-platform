'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { Lenis, lenisOptions } from '@/lib/lenis';
import { gsap, ScrollTrigger } from '@/lib/gsap';

/**
 * Mounts a single Lenis instance and bridges it to ScrollTrigger.
 * - Disabled below 768px (mobile touch + pin = jitter on Safari).
 * - Honors prefers-reduced-motion: reduce → falls back to native scroll.
 * - RAF loop pumps both Lenis and ScrollTrigger; cleanup is mandatory.
 */
export function SmoothScrollProvider({ children }: { children: ReactNode }) {
  const lenisRef = useRef<Lenis | null>(null);

  useEffect(() => {
    const isMobile = window.matchMedia('(max-width: 767px)').matches;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (isMobile || reduceMotion) {
      // Native scroll — ScrollTrigger uses the default scroller (window).
      return;
    }

    const lenis = new Lenis(lenisOptions);
    lenisRef.current = lenis;

    // Expose globally for hooks like `useLenisAnchor` to coordinate
    // smooth-scroll on anchor links / TOC clicks without prop drilling.
    (window as unknown as { __lenis?: Lenis }).__lenis = lenis;

    // Disable browser's auto scroll restoration — Lenis handles it.
    let prevRestoration: ScrollRestoration | null = null;
    if ('scrollRestoration' in history) {
      prevRestoration = history.scrollRestoration;
      history.scrollRestoration = 'manual';
    }

    // Bridge: ScrollTrigger.update fires on every Lenis frame so triggers stay in sync.
    lenis.on('scroll', ScrollTrigger.update);

    // GSAP ticker drives the RAF loop — single source of truth.
    const tick = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);

    // Note: NO popstate handler. Next.js App Router gestisce scroll
    // restoration su back/forward via la sua logica interna. Aggiungere
    // un nostro handler sovrascriverebbe quel comportamento (decisione
    // skill check Wave 4).

    return () => {
      gsap.ticker.remove(tick);
      lenis.destroy();
      lenisRef.current = null;
      delete (window as unknown as { __lenis?: Lenis }).__lenis;
      if (prevRestoration && 'scrollRestoration' in history) {
        history.scrollRestoration = prevRestoration;
      }
    };
  }, []);

  return <>{children}</>;
}
