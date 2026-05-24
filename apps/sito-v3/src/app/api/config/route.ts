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

export interface PublicRuntimeConfig {
  gaMeasurementId: string;
  mouseflowId: string;
  turnstileSiteKey: string;
  googleMapsKey: string;
}

export async function GET() {
  const config: PublicRuntimeConfig = {
    gaMeasurementId: process.env.GA_MEASUREMENT_ID ?? '',
    mouseflowId: process.env.MOUSEFLOW_ID ?? '',
    turnstileSiteKey: process.env.TURNSTILE_SITE_KEY ?? '',
    googleMapsKey: process.env.GOOGLE_MAPS_KEY ?? '',
  };

  return NextResponse.json(config, {
    headers: {
      // Cache solo per qualche minuto in CDN: i valori cambiano solo a
      // restart container, ma vogliamo refresh rapido se l'admin li ruota.
      'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=60',
    },
  });
}
