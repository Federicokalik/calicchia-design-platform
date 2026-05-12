import { randomBytes, createHash } from 'crypto';
import { sql } from '../db';

const TOKEN_BYTES = 32; // 256 bits → ~43 chars base64url, plenty of entropy
const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

export interface MagicLinkToken {
  /** The plaintext token to embed in the email URL (NEVER stored). */
  plaintext: string;
  /** Sha256 hex digest — what we persist for lookup. */
  hash: string;
  /** Absolute expiry timestamp (ms epoch). */
  expires_at: Date;
}

/** sha256 hex digest — fast, deterministic, sufficient for single-use tokens. */
function hashToken(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

/**
 * Generate a fresh single-use magic link token for a customer and persist it.
 * Also clears any previous unused tokens for that customer (prevents replay
 * via stale links if user requests multiple in a row).
 */
export async function issueMagicLink(
  customerId: string,
  ip: string | null,
  ua: string | null
): Promise<MagicLinkToken> {
  const plaintext = randomBytes(TOKEN_BYTES).toString('base64url');
  const hash = hashToken(plaintext);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  // Invalidate any prior unused tokens for the same customer.
  await sql`
    UPDATE portal_login_tokens
    SET used_at = NOW()
    WHERE customer_id = ${customerId} AND used_at IS NULL
  `;

  await sql`
    INSERT INTO portal_login_tokens
      (customer_id, token_hash, expires_at, requested_ip, requested_ua)
    VALUES
      (${customerId}, ${hash}, ${expiresAt.toISOString()}, ${ip}, ${ua})
  `;

  return { plaintext, hash, expires_at: expiresAt };
}

export type ConsumeResult =
  | { ok: true; customer_id: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'used' };

/**
 * Validate + consume a magic link token. Marks used_at on success (single-use).
 */
export async function consumeMagicLink(plaintext: string): Promise<ConsumeResult> {
  if (!plaintext || typeof plaintext !== 'string') return { ok: false, reason: 'invalid' };
  const hash = hashToken(plaintext);

  const rows = (await sql`
    SELECT id, customer_id, expires_at, used_at
    FROM portal_login_tokens
    WHERE token_hash = ${hash}
    LIMIT 1
  `) as Array<{ id: string; customer_id: string; expires_at: string; used_at: string | null }>;

  const row = rows[0];
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.used_at) return { ok: false, reason: 'used' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };

  await sql`
    UPDATE portal_login_tokens
    SET used_at = NOW()
    WHERE id = ${row.id} AND used_at IS NULL
  `;

  return { ok: true, customer_id: row.customer_id };
}
