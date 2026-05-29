/**
 * Provider-agnostic captcha verification.
 *
 * Switcha tra Cloudflare Turnstile (provider legacy) e Cap (https://trycap.dev,
 * self-hosted PoW WASM, Apache 2.0). Selezione del provider:
 *   1. Override per-form: `CAPTCHA_PROVIDER_<UPPER_SITEKEY_ID>` (es.
 *      `CAPTCHA_PROVIDER_PORTAL_LOGIN=cap`). Permette pilot mirato di un
 *      singolo form senza muovere tutta l'app.
 *   2. Fallback globale: `CAPTCHA_PROVIDER` (`turnstile` di default).
 *
 * Vedi piano migrazione Step D (pilot) e Step E (rollout completo).
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

function parseProvider(raw: string | undefined): CaptchaProvider | null {
  const v = (raw ?? '').toLowerCase().trim();
  if (v === 'cap') return capProvider;
  if (v === 'turnstile') return turnstileProvider;
  return null;
}

/** Provider risolto al momento della chiamata in base a `siteKeyId`. */
function resolveProvider(siteKeyId?: string): CaptchaProvider {
  // 1. Override per-form (priorita` massima per i pilot).
  if (siteKeyId) {
    const override = parseProvider(process.env[`CAPTCHA_PROVIDER_${siteKeyId.toUpperCase()}`]);
    if (override) return override;
  }
  // 2. Fallback globale.
  const global = parseProvider(process.env.CAPTCHA_PROVIDER);
  if (global) return global;
  // 3. Default sicuro: Turnstile (back-compat).
  return turnstileProvider;
}

/**
 * Facade `captcha`: dispatch dinamico al provider giusto in base al
 * `siteKeyId` di ogni chiamata. Consumatori chiamano sempre `captcha.verify`
 * senza preoccuparsi di quale provider stia girando dietro.
 */
export const captcha = {
  get name(): CaptchaProvider['name'] {
    // Nome del provider globale (default), per logging generale.
    return resolveProvider().name;
  },
  isConfigured(): boolean {
    // True se almeno un provider globale e` configurato.
    return resolveProvider().isConfigured();
  },
  async verify(token: string, opts: CaptchaVerifyOptions = {}): Promise<CaptchaVerifyResult> {
    const provider = resolveProvider(opts.siteKeyId);
    return provider.verify(token, opts);
  },
};

/**
 * Utility per debug/diagnostica — espone il provider che verrebbe scelto per
 * un dato `siteKeyId`. Non usato in produzione; utile per i test.
 */
export function captchaProviderFor(siteKeyId?: string): CaptchaProvider {
  return resolveProvider(siteKeyId);
}
