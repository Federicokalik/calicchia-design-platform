'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * True (sticky) quando l'elemento `sentinelRef` entra nel viewport del suo
 * scroll-container piu` vicino. Usato per il gating del checkbox "Ho letto"
 * sulla pagina /clienti/accettazione-legale: il sentinel viene piazzato a
 * fine documento, l'IntersectionObserver root e` il container scrollabile.
 *
 * Implementation note: il container scrollabile e` determinato cercando il
 * piu` vicino antenato con `overflow-y: auto|scroll`. Se non trovato, fallback
 * al viewport (root: null). Lo state diventa true UNA volta e non torna piu`
 * indietro — utile per evitare oscillazioni se l'utente ri-scrolla in alto.
 */
export function useScrollToBottom(sentinelRef: RefObject<HTMLElement | null>): boolean {
  const [reached, setReached] = useState(false);
  const reachedRef = useRef(false);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    // Trova il container scrollabile piu` vicino. Falla al viewport.
    let root: Element | null = sentinel.parentElement;
    while (root) {
      const overflowY = getComputedStyle(root).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') break;
      root = root.parentElement;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !reachedRef.current) {
            reachedRef.current = true;
            setReached(true);
          }
        }
      },
      {
        root,
        rootMargin: '0px',
        threshold: 0.1,
      },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinelRef]);

  return reached;
}
