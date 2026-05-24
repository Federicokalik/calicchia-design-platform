import { randomUUID } from 'crypto';
import { logger } from './logger';

const log = logger.child({ scope: 'turnstile' });

const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY || '';
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Allowed hostnames where our Turnstile widget can legitimately render.
// If unset, hostname binding is skipped. Multi-value comma-separated.
const ALLOWED_HOSTNAMES = (process.env.TURNSTILE_ALLOWED_HOSTNAMES || '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

export function isTurnstileConfigured(): boolean {
  return TURNSTILE_SECRET.length > 0;
}

export interface VerifyTurnstileOptions {
  /** Remote IP of the user — sent as `remoteip` to Cloudflare for better signal. */
  remoteIp?: string;
  /**
   * Action label expected for this submission (must match the `action` passed
   * to `turnstile.render()` on the frontend). Skipped if undefined.
   * Cloudflare returns `action` in the siteverify response.
   */
  expectedAction?: string;
}

export interface VerifyTurnstileResult {
  /** True only if Cloudflare returned `success: true` AND all our extra checks passed. */
  ok: boolean;
  /** Concatenated error codes (Cloudflare's + our own) for logging/telemetry. */
  errorCodes: string[];
}

interface SiteVerifyResponse {
  success: boolean;
  challenge_ts?: string;
  hostname?: string;
  action?: string;
  cdata?: string;
  'error-codes'?: string[];
}

/**
 * Verify a Cloudflare Turnstile token following the official guidelines:
 * - https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 *
 * Hardening beyond the bare-minimum `success` check:
 * - Sends `idempotency_key` (UUIDv4) so retries don't trigger "timeout-or-duplicate".
 * - Sends `remoteip` when available for better Cloudflare risk scoring.
 * - Enforces `hostname` matches `TURNSTILE_ALLOWED_HOSTNAMES` (if configured)
 *   so a stolen token from another origin is rejected.
 * - Enforces `action` matches `expectedAction` (if provided) so a token captured
 *   from one form cannot be replayed against another endpoint.
 * - Logs Cloudflare's `error-codes` array so failures are diagnosable.
 *
 * Tokens are single-use by design on Cloudflare's side; we never call siteverify
 * twice for the same token.
 */
export async function verifyTurnstileToken(
  token: string,
  remoteIpOrOptions?: string | VerifyTurnstileOptions,
): Promise<boolean> {
  const result = await verifyTurnstileTokenDetailed(token, remoteIpOrOptions);
  return result.ok;
}

/**
 * Same as {@link verifyTurnstileToken} but returns the structured result with
 * error codes. Use this when you want to surface specific Cloudflare errors
 * to logs or to the API response.
 */
export async function verifyTurnstileTokenDetailed(
  token: string,
  remoteIpOrOptions?: string | VerifyTurnstileOptions,
): Promise<VerifyTurnstileResult> {
  const options: VerifyTurnstileOptions =
    typeof remoteIpOrOptions === 'string'
      ? { remoteIp: remoteIpOrOptions }
      : remoteIpOrOptions ?? {};

  if (!isTurnstileConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      log.error('TURNSTILE_SECRET_KEY not configured in production — blocking request');
      return { ok: false, errorCodes: ['secret-not-configured'] };
    }
    // Dev convenience: skip verification entirely.
    return { ok: true, errorCodes: [] };
  }

  if (!token) return { ok: false, errorCodes: ['missing-token'] };

  const body: Record<string, string> = {
    secret: TURNSTILE_SECRET,
    response: token,
    // UUIDv4 per request: lets us safely retry network failures without
    // Cloudflare returning "timeout-or-duplicate" on the second attempt.
    idempotency_key: randomUUID(),
  };
  if (options.remoteIp) body.remoteip = options.remoteIp;

  let parsed: SiteVerifyResponse;
  try {
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    parsed = (await res.json()) as SiteVerifyResponse;
  } catch (err) {
    log.error({ err }, 'Turnstile siteverify network error');
    return { ok: false, errorCodes: ['network-error'] };
  }

  const errorCodes: string[] = Array.isArray(parsed['error-codes'])
    ? [...parsed['error-codes']]
    : [];

  if (!parsed.success) {
    log.warn({ errorCodes, action: parsed.action, hostname: parsed.hostname }, 'Turnstile verify failed');
    return { ok: false, errorCodes };
  }

  // Defense in depth: reject tokens that came from an unexpected hostname.
  if (
    ALLOWED_HOSTNAMES.length > 0 &&
    parsed.hostname &&
    !ALLOWED_HOSTNAMES.includes(parsed.hostname.toLowerCase())
  ) {
    log.warn(
      { hostname: parsed.hostname, allowed: ALLOWED_HOSTNAMES },
      'Turnstile token rejected: hostname not in allowlist',
    );
    return { ok: false, errorCodes: [...errorCodes, 'hostname-mismatch'] };
  }

  // Per-form binding: reject tokens captured from another form.
  if (options.expectedAction && parsed.action !== options.expectedAction) {
    log.warn(
      { expected: options.expectedAction, got: parsed.action },
      'Turnstile token rejected: action mismatch',
    );
    return { ok: false, errorCodes: [...errorCodes, 'action-mismatch'] };
  }

  return { ok: true, errorCodes };
}
