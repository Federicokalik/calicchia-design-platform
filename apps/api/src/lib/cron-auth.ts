import { createHash, timingSafeEqual } from 'crypto';

/**
 * Constant-time check of a caller-supplied cron secret against CRON_SECRET
 * (SEC-13). Both sides are SHA-256 hashed first so timingSafeEqual always gets
 * equal-length buffers and the comparison leaks neither content nor length.
 */
export function verifyCronSecret(provided: string | undefined | null): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected || !provided) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
