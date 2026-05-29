/**
 * Provider-agnostic captcha verification.
 *
 * Switcha tra Cloudflare Turnstile (provider legacy) e Cap (https://trycap.dev,
 * self-hosted PoW WASM, Apache 2.0). Selezione via env `CAPTCHA_PROVIDER`:
 *   - `cap`        → Cap self-host (preferito, GDPR-aligned)
 *   - `turnstile`  → Cloudflare Turnstile (default per back-compat)
 *
 * Vedi piano migrazione 2026-05-29 in plans/.
 */

import { capProvider } from './cap';
import { turnstileProvider } from './turnstile';

export interface CaptchaVerifyOptions {
  /** Remote IP del client — alcuni provider lo usano per rate-limit / risk scoring. */
  remoteIp?: string;
  /**
   * Identificativo del form / azione (es. `portal_login`, `contact_form`).
   * Turnstile lo usa come `expectedAction` binding sul token.
   * Cap lo usa per selezionare la site key + secret giusti (`CAP_SITEKEY_<ID>` /
   * `CAP_SECRET_<ID>` env), garantendo che un token catturato da un form non
   * possa essere replicato contro un altro endpoint.
   */
  siteKeyId?: string;
}

export interface CaptchaVerifyResult {
  /** True solo se il provider ha confermato il token come valido. */
  ok: boolean;
  /** Codici errore concatenati dal provider + nostri (per logging/telemetria). */
  errorCodes: string[];
}

export interface CaptchaProvider {
  verify(token: string, opts?: CaptchaVerifyOptions): Promise<CaptchaVerifyResult>;
  isConfigured(): boolean;
  /** Nome del provider per logging. */
  readonly name: 'turnstile' | 'cap';
}

function pickProvider(): CaptchaProvider {
  const explicit = (process.env.CAPTCHA_PROVIDER ?? '').toLowerCase().trim();
  if (explicit === 'cap') return capProvider;
  if (explicit === 'turnstile') return turnstileProvider;
  // Default: turnstile (back-compat finché il pilot Cap non è validato).
  return turnstileProvider;
}

export const captcha: CaptchaProvider = pickProvider();
