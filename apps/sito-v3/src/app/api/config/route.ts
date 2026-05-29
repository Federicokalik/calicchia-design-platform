import { NextResponse } from 'next/server';

// Runtime public config — read on every request, never cached. This is what
// lets us bake one immutable Docker image and inject GA / Mouseflow /
// Turnstile / Maps keys via docker-compose env at deploy time. The repo is
// public and the published GHCR images are public, so we deliberately avoid
// NEXT_PUBLIC_* (which Next inlines at build time and would let a fork pull
// our image and pollute our analytics).
//
// Returned values are all "browser-visible" by design (Turnstile site key,
// GA measurement ID, etc.) — they are not secrets, just per-environment.
// Hardened against accidental leak: only the keys listed below are echoed.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export type CaptchaFormId =
  | 'admin_login'
  | 'portal_login'
  | 'contact_form'
  | 'newsletter_subscribe'
  | 'gdpr_request'
  | 'booking_create'
  | 'booking_reschedule'
  | 'embed_lead';

export interface PublicCaptchaConfig {
  /**
   * Provider attivo. `turnstile` = legacy Cloudflare; `cap` = Cap self-hosted
   * (https://trycap.dev). Default `turnstile` finche` pilot Cap non e` validato.
   */
  provider: 'turnstile' | 'cap';
  /** Base URL del container Cap (es. `https://cap.calicchia.design`). Vuoto se non in uso. */
  capEndpoint: string;
  /** Site key Cap per form-id (mappate da env `CAP_SITEKEY_<UPPER>`). */
  siteKeys: Partial<Record<CaptchaFormId, string>>;
}

export interface PublicRuntimeConfig {
  gaMeasurementId: string;
  mouseflowId: string;
  /** @deprecated In transizione a `captcha.siteKeys`. Tenuto per back-compat (`useTurnstile`). */
  turnstileSiteKey: string;
  /** Provider-agnostic captcha config — consumato da `useCaptcha`. */
  captcha: PublicCaptchaConfig;
  googleMapsKey: string;
  /** Stripe publishable key (pk_test_ / pk_live_). Used by @stripe/stripe-js loadStripe(). */
  stripePublishableKey: string;
  /** PayPal SDK client ID (same merchant as PAYPAL_CLIENT_ID). Used by PayPalScriptProvider. */
  paypalClientId: string;
}

// .trim() difensivo: il parser dotenv di Docker Compose NON strippa i commenti
// inline (`KEY=value  # nota` arriva al container con `  # nota` letterale).
// Incident 2026-05-29: Turnstile site key + Google Maps key con commenti inline
// in .env.dockhand finivano corrotti. Qui togliamo almeno trailing/leading
// whitespace — la pulizia vera del file env resta ops-side.
const env = (name: string): string => (process.env[name] ?? '').trim();

/**
 * Costruisce la mappa form-id → Cap site key leggendo `CAP_SITEKEY_<UPPER>` per
 * ogni form-id conosciuto. Le entry mancanti restano `undefined` (la chiamata
 * `captcha.verify` server-side fallira` con `cap-keypair-not-configured`).
 */
function buildCapSiteKeys(): Partial<Record<CaptchaFormId, string>> {
  const ids: CaptchaFormId[] = [
    'admin_login',
    'portal_login',
    'contact_form',
    'newsletter_subscribe',
    'gdpr_request',
    'booking_create',
    'booking_reschedule',
    'embed_lead',
  ];
  const out: Partial<Record<CaptchaFormId, string>> = {};
  for (const id of ids) {
    const value = env(`CAP_SITEKEY_${id.toUpperCase()}`);
    if (value) out[id] = value;
  }
  return out;
}

export async function GET() {
  const providerEnv = env('CAPTCHA_PROVIDER').toLowerCase();
  const provider: 'turnstile' | 'cap' = providerEnv === 'cap' ? 'cap' : 'turnstile';

  const config: PublicRuntimeConfig = {
    gaMeasurementId: env('GA_MEASUREMENT_ID'),
    mouseflowId: env('MOUSEFLOW_ID'),
    turnstileSiteKey: env('TURNSTILE_SITE_KEY'),
    captcha: {
      provider,
      capEndpoint: env('CAP_PUBLIC_URL'),
      siteKeys: buildCapSiteKeys(),
    },
    googleMapsKey: env('GOOGLE_MAPS_KEY'),
    stripePublishableKey: env('STRIPE_PUBLISHABLE_KEY'),
    // PayPal SDK reads the same merchant client_id that the server uses
    // for OAuth. Allow override via PAYPAL_PUBLIC_CLIENT_ID for the rare
    // case where you want a sandbox SDK against a live API (or vice versa).
    paypalClientId: env('PAYPAL_PUBLIC_CLIENT_ID') || env('PAYPAL_CLIENT_ID'),
  };

  return NextResponse.json(config, {
    headers: {
      // Cache solo per qualche minuto in CDN: i valori cambiano solo a
      // restart container, ma vogliamo refresh rapido se l'admin li ruota.
      'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=60',
    },
  });
}
