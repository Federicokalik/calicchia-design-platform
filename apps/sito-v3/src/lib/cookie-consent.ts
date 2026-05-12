'use client';

export interface CookiePreferences {
  necessary: true;
  analytics: boolean;
  marketing: boolean;
}

export interface ConsentRecord {
  preferences: CookiePreferences;
  timestamp: number;
  version: string;
}

export const CONSENT_VERSION = '2026-03-19';

const COOKIE_NAME = 'cookie_consent';
const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000;

export const DEFAULT_PREFERENCES: CookiePreferences = {
  necessary: true,
  analytics: false,
  marketing: false,
};

function getCookieValue(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : null;
}

export function getConsent(): ConsentRecord | null {
  if (typeof document === 'undefined') return null;

  try {
    const raw = getCookieValue(COOKIE_NAME);
    if (!raw) return null;
    const parsed = JSON.parse(decodeURIComponent(raw)) as ConsentRecord;
    if (!parsed.preferences || !parsed.timestamp) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function hasConsent(category: keyof CookiePreferences): boolean {
  const consent = getConsent();
  if (!consent) return category === 'necessary';
  return consent.preferences[category] === true;
}

export function setConsent(preferences: Partial<CookiePreferences>): ConsentRecord {
  const current = getConsent()?.preferences ?? DEFAULT_PREFERENCES;
  const record: ConsentRecord = {
    preferences: {
      necessary: true,
      analytics: preferences.analytics ?? current.analytics,
      marketing: preferences.marketing ?? current.marketing,
    },
    timestamp: Date.now(),
    version: CONSENT_VERSION,
  };

  const value = encodeURIComponent(JSON.stringify(record));
  const expires = new Date(Date.now() + SIX_MONTHS_MS).toUTCString();
  document.cookie = `${COOKIE_NAME}=${value}; path=/; expires=${expires}; SameSite=Lax; Secure`;
  window.dispatchEvent(new CustomEvent('cookie-consent-changed', { detail: record }));
  return record;
}

export function acceptAll(): ConsentRecord {
  return setConsent({ analytics: true, marketing: true });
}

export function rejectAll(): ConsentRecord {
  return setConsent({ analytics: false, marketing: false });
}

export function shouldShowBanner(): boolean {
  const consent = getConsent();
  if (!consent) return true;
  if (Date.now() - consent.timestamp > SIX_MONTHS_MS) return true;
  if (consent.version !== CONSENT_VERSION) return true;
  return false;
}

export async function logConsentToServer(record: ConsentRecord): Promise<void> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

  try {
    await fetch(`${apiUrl}/api/cookie-consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        preferences: record.preferences,
        timestamp: record.timestamp,
        version: record.version,
      }),
    });
  } catch {
    // Non-blocking: consent remains valid even if audit logging is unavailable.
  }
}

export function installCookieConsentGlobals() {
  if (typeof window === 'undefined') return;

  window.__cookieConsent = {
    read: getConsent,
    has: hasConsent,
    save: setConsent,
  };
}
