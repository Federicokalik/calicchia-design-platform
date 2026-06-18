'use client';

import { useEffect } from 'react';
import { getConsent, type CookiePreferences } from '@/lib/cookie-consent';

/**
 * Bridges OUR cookie banner (lib/cookie-consent) to the Cloudflare Zaraz
 * Consent API, so tools loaded via Zaraz (GA4) fire only after the user has
 * granted the matching category — WITHOUT showing Zaraz's own consent modal
 * ("Mostra modalità di consenso" stays OFF in the dashboard). The Meta Pixel
 * is NOT on Zaraz: it is loaded from app code (see MetaPixel.tsx).
 *
 * Setup on Cloudflare side (Tag management → Consenti):
 *  1. "Abilita gestione del consenso" = ON, "Mostra modalità di consenso" = OFF.
 *  2. Create two "Scopi" (purposes) and copy their IDs into the constants below.
 *  3. Assign GA4 → Analytics purpose. Cloudflare Monitoring can stay
 *     "Ignora consenso" (exempt, first-party). The Marketing purpose has no
 *     Zaraz tools today but is kept for future use.
 *
 * Purpose IDs are stable per-zone identifiers, not secrets.
 */
const PURPOSE_ANALYTICS = 'AEMM';
const PURPOSE_MARKETING = 'TBPT';

const CONFIGURED =
  !PURPOSE_ANALYTICS.startsWith('__') && !PURPOSE_MARKETING.startsWith('__');

function syncZarazConsent(preferences?: CookiePreferences) {
  const consent = window.zaraz?.consent;
  if (!consent) return;

  consent.set({
    [PURPOSE_ANALYTICS]: preferences?.analytics === true,
    [PURPOSE_MARKETING]: preferences?.marketing === true,
  });
  // Flush pageviews/events Zaraz held back while consent was pending.
  consent.sendQueuedEvents?.();
}

export function ZarazConsent() {
  useEffect(() => {
    if (!CONFIGURED) return;

    const apply = () => syncZarazConsent(getConsent()?.preferences);

    // Initial sync once Zaraz's consent API is available.
    if (window.zaraz?.consent?.APIReady) {
      apply();
    } else {
      document.addEventListener('zarazConsentAPIReady', apply, { once: true });
    }

    // Re-sync whenever the user changes their choice in our banner.
    const onConsentChanged = (event: WindowEventMap['cookie-consent-changed']) => {
      syncZarazConsent(event.detail.preferences);
    };
    window.addEventListener('cookie-consent-changed', onConsentChanged);

    return () => {
      document.removeEventListener('zarazConsentAPIReady', apply);
      window.removeEventListener('cookie-consent-changed', onConsentChanged);
    };
  }, []);

  return null;
}
