/**
 * Cookieless analytics identity — Umami-style HMAC hashing.
 *
 * Visitor and visit identities are derived server-side from:
 *   IP + User-Agent + website ID + time bucket + pepper
 *
 * No cookies, no storage, no filesystem writes.
 * All output is deterministic for the same inputs.
 *
 * Design notes:
 * - Two visitors with the same IP but different User-Agents → different IDs
 *   (HMAC payload includes both ip and userAgent separated by a newline).
 * - Same visitor at 23:55 and 00:05 UTC → different visit_id because they
 *   fall in different hour buckets; bridge logic (visitIdYesterday) lives in
 *   the caller, not here.
 * - Cross-month boundary → session_id rotates monthly (expected & intentional).
 * - Empty or unusual User-Agent strings are handled without errors.
 */

import { createHmac } from 'crypto';

// ---------------------------------------------------------------------------
// Pepper — lazy, cached, never throws at import time
// ---------------------------------------------------------------------------

let pepperCache: Buffer | null = null;

/**
 * Returns the decoded pepper Buffer.
 * Reads ANALYTICS_PEPPER (base64-encoded 256-bit secret) from the environment
 * on first call and caches the result. Throws if the variable is absent.
 */
export function getPepper(): Buffer {
  if (pepperCache !== null) return pepperCache;
  const raw = process.env.ANALYTICS_PEPPER;
  if (!raw) throw new Error('ANALYTICS_PEPPER env var is required');
  pepperCache = Buffer.from(raw, 'base64');
  return pepperCache;
}

// ---------------------------------------------------------------------------
// Private time-bucket helpers (UTC only)
// ---------------------------------------------------------------------------

function monthBucket(when: Date): string {
  const y = when.getUTCFullYear();
  const m = String(when.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function hourBucket(when: Date): string {
  const y = when.getUTCFullYear();
  const m = String(when.getUTCMonth() + 1).padStart(2, '0');
  const d = String(when.getUTCDate()).padStart(2, '0');
  const h = String(when.getUTCHours()).padStart(2, '0');
  return `${y}-${m}-${d}-${h}`;
}

// ---------------------------------------------------------------------------
// Private salt derivation helpers
// ---------------------------------------------------------------------------

function sessionSalt(websiteId: string, when: Date): Buffer {
  return createHmac('sha256', getPepper())
    .update(`session:${monthBucket(when)}:${websiteId}`)
    .digest();
}

function visitSalt(websiteId: string, when: Date): Buffer {
  return createHmac('sha256', getPepper())
    .update(`visit:${hourBucket(when)}:${websiteId}`)
    .digest();
}

// ---------------------------------------------------------------------------
// Exported identity functions
// ---------------------------------------------------------------------------

/**
 * Derives a monthly session identifier from IP + User-Agent.
 * Rotates every calendar month in UTC — expected behaviour for cookieless tracking.
 */
export function sessionId(
  websiteId: string,
  ip: string,
  userAgent: string,
  when: Date = new Date(),
): string {
  return createHmac('sha256', sessionSalt(websiteId, when))
    .update(`${ip}\n${userAgent}`)
    .digest('hex');
}

/**
 * Derives an hourly visit identifier from IP + User-Agent.
 * Rotates every UTC hour. Cross-midnight continuity is handled by the caller
 * using visitIdYesterday.
 */
export function visitId(
  websiteId: string,
  ip: string,
  userAgent: string,
  when: Date = new Date(),
): string {
  return createHmac('sha256', visitSalt(websiteId, when))
    .update(`${ip}\n${userAgent}`)
    .digest('hex');
}

/**
 * Returns the visit_id that would have been assigned at 23:00 UTC yesterday.
 * Call this only when when.getUTCHours() === 0 to check for cross-midnight
 * session continuity. The caller queries the DB for a recent event matching
 * this ID and reuses it if found.
 */
export function visitIdYesterday(
  websiteId: string,
  ip: string,
  userAgent: string,
  when: Date = new Date(),
): string {
  const yesterday23 = new Date(
    Date.UTC(
      when.getUTCFullYear(),
      when.getUTCMonth(),
      when.getUTCDate() - 1,
      23,
      0,
      0,
      0,
    ),
  );
  return visitId(websiteId, ip, userAgent, yesterday23);
}
