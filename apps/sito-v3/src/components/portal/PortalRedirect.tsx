'use client';

import { useEffect } from 'react';

/**
 * Client-side redirect helper per le pagine del portale.
 *
 * Storia (incident 2026-05-28):
 *   V1-V4 tentavano redirect server-side via `next/navigation.redirect()`.
 *   Il middleware-internal di Next.js (patched da `createNextIntlPlugin()`
 *   in next.config.ts) intercetta la Response e fa `new NextURL(Location)`
 *   sull'header senza base. Con URL relativo → ERR_INVALID_URL. Con URL
 *   assoluto same-origin Next.js lo strippa prima → stesso ERR.
 *
 *   V5 (questa): bypass totale. La page restituisce JSX che fa
 *   `window.location.replace()` dal client. Nessun throw NEXT_REDIRECT,
 *   nessun Location header processato.
 *
 * Trade-off accettato: flash visivo di ~50ms prima del redirect (vs un 307
 * istantaneo). Solo per il flusso non-autenticato del portale, accettabile.
 */
export function PortalRedirect({ to }: { to: string }) {
  useEffect(() => {
    window.location.replace(to);
  }, [to]);

  return (
    <div
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding: 24,
        color: 'var(--color-ink-muted, #666)',
        minHeight: '50vh',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        justifyContent: 'center',
      }}
    >
      <span>Reindirizzamento in corso…</span>
      <a href={to} style={{ color: '#0066cc' }}>
        Se non vieni reindirizzato automaticamente, clicca qui
      </a>
    </div>
  );
}
