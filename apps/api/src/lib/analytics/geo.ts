/**
 * geo.ts — Cookieless geo resolution.
 *
 * Order of precedence:
 *  1. Cloudflare request headers (cf-ipcountry, cf-ipcity) — zero infra cost.
 *  2. MaxMind GeoLite2 lookup against ./data/GeoLite2-City.mmdb if MAXMIND_LICENSE_KEY
 *     was set at setup time and the file exists. Singleton reader, lazy-init.
 *  3. null / null.
 *
 * Everything happens server-side; the browser is never involved.
 */

import { existsSync } from 'fs';
import { resolve } from 'path';
import type { Context } from 'hono';

type GeoResult = { country: string | null; city: string | null };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let readerCache: { reader: any; ready: boolean } | null = null;
let readerInitPromise: Promise<void> | null = null;

const MMDB_PATH = resolve(
  process.env.MAXMIND_MMDB_PATH || './data/GeoLite2-City.mmdb',
);

async function initReader(): Promise<void> {
  if (readerCache) return;
  if (!existsSync(MMDB_PATH)) {
    readerCache = { reader: null, ready: false };
    return;
  }
  try {
    const { Reader } = await import('@maxmind/geoip2-node');
    const reader = await Reader.open(MMDB_PATH);
    readerCache = { reader, ready: true };
  } catch {
    readerCache = { reader: null, ready: false };
  }
}

function ensureInit(): Promise<void> {
  if (readerCache) return Promise.resolve();
  if (!readerInitPromise) readerInitPromise = initReader();
  return readerInitPromise;
}

function maxmindLookup(ip: string): GeoResult {
  if (!readerCache?.ready || !readerCache.reader) return { country: null, city: null };
  try {
    const r = readerCache.reader.city(ip);
    return {
      country: r?.country?.isoCode ?? null,
      city: r?.city?.names?.en ?? null,
    };
  } catch {
    return { country: null, city: null };
  }
}

/**
 * Resolves country (ISO 3166-1 alpha-2) and city from request headers + IP.
 * Always returns; never throws. Falls through to MaxMind only when CF headers
 * are absent. Initialises the MMDB reader on first call (best-effort).
 */
export async function resolveGeo(c: Context, ip: string | null): Promise<GeoResult> {
  const cfCountry = c.req.header('cf-ipcountry') || null;
  const cfCity = c.req.header('cf-ipcity') || null;
  if (cfCountry) return { country: cfCountry, city: cfCity };

  if (!ip) return { country: null, city: null };
  await ensureInit();
  return maxmindLookup(ip);
}
