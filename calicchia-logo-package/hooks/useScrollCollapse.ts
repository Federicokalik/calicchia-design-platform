'use client';

import { useEffect, useState } from 'react';

/**
 * Hook che restituisce `true` quando l'utente ha scrollato oltre `threshold` px.
 *
 * Implementazione: usa un sentinel invisibile alla quota threshold + IntersectionObserver.
 * Più performante di un classico scroll listener (che fire 60+ volte al secondo)
 * perché il browser notifica solo quando il sentinel entra/esce dal viewport.
 *
 * SSR-safe: durante il render server `collapsed` è sempre `false`,
 * il valore reale viene calcolato al mount client.
 *
 * @param threshold soglia in px (default 80)
 * @returns boolean — true se scroll > threshold
 */
export function useScrollCollapse(threshold: number = 80): boolean {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    // Guardia SSR (ridondante con 'use client' ma esplicita)
    if (typeof document === 'undefined') return;

    // Sentinel invisibile posizionato alla quota threshold.
    // Quando esce dal viewport (scroll > threshold), il logo va in stato collapsed.
    const sentinel = document.createElement('div');
    Object.assign(sentinel.style, {
      position: 'absolute',
      top: `${threshold}px`,
      left: '0',
      height: '1px',
      width: '1px',
      pointerEvents: 'none',
      visibility: 'hidden',
    } satisfies Partial<CSSStyleDeclaration>);

    document.body.prepend(sentinel);

    const io = new IntersectionObserver(
      ([entry]) => {
        setCollapsed(!entry.isIntersecting);
      },
      { threshold: 0 }
    );

    io.observe(sentinel);

    // Cleanup: rimuovi observer e sentinel su unmount o re-run dell'effect
    return () => {
      io.disconnect();
      sentinel.remove();
    };
  }, [threshold]);

  return collapsed;
}
