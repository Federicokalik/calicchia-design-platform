'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Intercetta i click su `<a>` interni e wrappa la navigazione in
 * `document.startViewTransition()`. Necessario perché Next 16 stable +
 * React 19.2 non hanno ancora `unstable_ViewTransition` esposto, quindi
 * il flag `experimental.viewTransition` da solo è inerte.
 *
 * Skip:
 *  - External, mailto:, tel:, javascript:, target=_blank
 *  - Modifier keys (cmd/ctrl/shift) → permette open-in-new-tab
 *  - Hash-only (anchor scroll same-page)
 *  - download attribute
 *  - Fallback grazioso se browser non supporta startViewTransition
 */
export function ViewTransitionsBootstrap() {
  const router = useRouter();

  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (typeof document.startViewTransition !== 'function') return;

    const handler = (e: MouseEvent) => {
      // Modifier keys → lascia comportamento default (open in new tab, etc.)
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (e.button !== 0) return;

      const link = (e.target as Element | null)?.closest?.(
        'a[href]'
      ) as HTMLAnchorElement | null;
      if (!link) return;
      if (link.target && link.target !== '_self') return;
      if (link.hasAttribute('download')) return;

      const href = link.getAttribute('href') || '';
      if (!href || href.startsWith('mailto:') || href.startsWith('tel:'))
        return;
      if (href.startsWith('javascript:')) return;

      let url: URL;
      try {
        url = new URL(link.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;

      // Same path → no transition (would hide content during anchor scroll)
      if (
        url.pathname === window.location.pathname &&
        url.search === window.location.search
      ) {
        return;
      }

      // Capture phase: blocchiamo Next Link onClick prima che chiami router.push.
      // Stop propagation impedisce a Next di triggerare la navigazione senza VT.
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      const target = url.pathname + url.search + url.hash;
      document.startViewTransition(() => {
        router.push(target);
      });
    };

    // Capture phase: intercept BEFORE Next Link's React onClick handler.
    document.addEventListener('click', handler, { capture: true });
    return () =>
      document.removeEventListener('click', handler, { capture: true });
  }, [router]);

  return null;
}
