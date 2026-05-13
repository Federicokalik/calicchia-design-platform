'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { getConsent, installCookieConsentGlobals, type CookiePreferences } from '@/lib/cookie-consent';

const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID || '';
const GA_SCRIPT_ID = 'google-analytics-gtag-script';

type ConsentValue = 'granted' | 'denied';

type GoogleConsentState = {
  ad_personalization: ConsentValue;
  ad_storage: ConsentValue;
  ad_user_data: ConsentValue;
  analytics_storage: ConsentValue;
};

function consentState(preferences?: CookiePreferences): GoogleConsentState {
  const analytics = preferences?.analytics === true ? 'granted' : 'denied';
  const marketing = preferences?.marketing === true ? 'granted' : 'denied';

  return {
    ad_personalization: marketing,
    ad_storage: marketing,
    ad_user_data: marketing,
    analytics_storage: analytics
  };
}

function ensureGtag() {
  window.dataLayer = window.dataLayer || [];
  window.gtag =
    window.gtag ||
    function gtag(...args: unknown[]) {
      window.dataLayer?.push(args);
    };
}

function ensureGoogleAnalyticsScript() {
  if (document.getElementById(GA_SCRIPT_ID)) return;

  const script = document.createElement('script');
  script.id = GA_SCRIPT_ID;
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
  document.head.appendChild(script);
}

function updateConsent(preferences?: CookiePreferences) {
  ensureGtag();
  window.gtag?.('consent', 'update', consentState(preferences));
}

export function GoogleAnalytics() {
  const pathname = usePathname();

  useEffect(() => {
    if (!GA_MEASUREMENT_ID) return;
    installCookieConsentGlobals();
    window[`ga-disable-${GA_MEASUREMENT_ID}`] = false;

    ensureGtag();
    if (!window.__googleAnalyticsConfigured) {
      window.gtag?.('consent', 'default', consentState());
      window.gtag?.('js', new Date());
      window.gtag?.('config', GA_MEASUREMENT_ID, { send_page_view: false });
      window.__googleAnalyticsConfigured = true;
    }

    updateConsent(getConsent()?.preferences);
    ensureGoogleAnalyticsScript();

    const onConsentChanged = (event: WindowEventMap['cookie-consent-changed']) => {
      updateConsent(event.detail.preferences);
    };

    window.addEventListener('cookie-consent-changed', onConsentChanged);
    return () => {
      window.removeEventListener('cookie-consent-changed', onConsentChanged);
      window[`ga-disable-${GA_MEASUREMENT_ID}`] = true;
    };
  }, []);

  useEffect(() => {
    if (!GA_MEASUREMENT_ID) return;
    if (!pathname) return;

    ensureGtag();
    window[`ga-disable-${GA_MEASUREMENT_ID}`] = false;

    const pagePath = `${pathname}${window.location.search}`;
    if (window.__lastGoogleAnalyticsPageView === pagePath) return;
    window.__lastGoogleAnalyticsPageView = pagePath;

    window.gtag?.('event', 'page_view', {
      page_location: window.location.href,
      page_path: pagePath,
      page_title: document.title,
      send_to: GA_MEASUREMENT_ID
    });
  }, [pathname]);

  return null;
}
