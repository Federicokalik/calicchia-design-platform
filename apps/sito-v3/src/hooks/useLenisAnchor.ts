'use client';

import { useCallback } from 'react';

interface LenisLike {
  scrollTo: (
    target: HTMLElement | number,
    opts?: { offset?: number; immediate?: boolean }
  ) => void;
}

declare global {
  interface Window {
    __lenis?: LenisLike;
  }
}

/**
 * useLenisAnchor — smooth scroll a un id pagina, con offset header.
 * Usa la Lenis instance esposta da `SmoothScrollProvider` se disponibile,
 * altrimenti fallback nativo `window.scrollTo({ behavior: 'smooth' })`.
 *
 * Default offset -100px (compensa header sticky).
 */
export function useLenisAnchor() {
  return useCallback((targetId: string, offset = -100) => {
    if (typeof window === 'undefined') return;
    const lenis = window.__lenis;
    const target = document.getElementById(targetId);
    if (!target) return;

    if (lenis && typeof lenis.scrollTo === 'function') {
      lenis.scrollTo(target, { offset });
      return;
    }

    const top = target.getBoundingClientRect().top + window.scrollY + offset;
    window.scrollTo({ top, behavior: 'smooth' });
  }, []);
}
