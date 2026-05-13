/**
 * ua.ts — User-Agent parsing helpers for cookieless analytics.
 *
 * Wraps `ua-parser-js` (browser/OS/device extraction) and
 * `isbot` (bot detection). All functions are pure and never throw.
 */

import { UAParser } from 'ua-parser-js';
import { isbot } from 'isbot';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ParsedUA = {
  /** Browser name as reported by ua-parser-js, e.g. 'Chrome', 'Safari'. */
  browser: string | null;
  /** OS name, e.g. 'Windows', 'macOS', 'iOS', 'Android', 'Linux'. */
  os: string | null;
  /** Coarse device category. */
  device_type: 'desktop' | 'mobile' | 'tablet' | 'bot' | 'unknown';
};

// ─── Bot detection ────────────────────────────────────────────────────────────

/**
 * Returns `true` when the UA string is absent or recognised as a bot/crawler.
 * Never throws.
 */
export function isBotUA(userAgent: string | null | undefined): boolean {
  if (!userAgent) return true;
  try {
    return isbot(userAgent);
  } catch {
    return true;
  }
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Parses a User-Agent string into browser name, OS name, and device category.
 * Returns safe defaults on missing or malformed input. Never throws.
 */
export function parseUA(userAgent: string | null | undefined): ParsedUA {
  if (!userAgent) {
    return { browser: null, os: null, device_type: 'unknown' };
  }

  if (isBotUA(userAgent)) {
    return { browser: null, os: null, device_type: 'bot' };
  }

  try {
    const result = new UAParser(userAgent).getResult();

    const browser = result.browser.name ?? null;

    const rawOs = result.os.name ?? null;
    // Normalise ua-parser-js's 'Mac OS' to Apple's preferred 'macOS'.
    const os = rawOs === 'Mac OS' ? 'macOS' : rawOs;

    const dt = result.device.type;
    let device_type: ParsedUA['device_type'];
    if (dt === 'mobile') device_type = 'mobile';
    else if (dt === 'tablet') device_type = 'tablet';
    else if (dt === undefined) device_type = 'desktop'; // ua-parser-js omits type for desktops
    else device_type = 'unknown'; // smarttv, console, wearable, embedded, …

    return { browser, os, device_type };
  } catch {
    return { browser: null, os: null, device_type: 'unknown' };
  }
}
