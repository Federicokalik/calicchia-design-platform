/**
 * Adapter Cap (https://trycap.dev) → interfaccia CaptchaProvider.
 *
 * Cap espone `POST <CAP_URL>/<site-key>/siteverify` con body
 * `{ secret, response }`. Risposta: `{ success: boolean }`. Token monouso,
 * scadenza 5 min, gestita server-side da Valkey.
 *
 * Per emulare l'action binding Turnstile usiamo una site key DIVERSA per ogni
 * `siteKeyId` (es. `portal_login`, `contact_form`). La separazione è enforced
 * dal fatto che ogni site key ha il proprio secret nel siteverify path, quindi
 * un token catturato dal contact form NON verifica contro la chiave del portal.
 *
 * Env vars attese:
 *   - CAP_URL                          base URL del container Cap (es. `https://cap.calicchia.design`).
 *   - CAP_SITEKEY_<UPPER_ID>           public site key per form-id (esposta al browser).
 *   - CAP_SECRET_<UPPER_ID>            secret server-side per form-id.
 *   - CAP_DEFAULT_SITEKEY (opt)        fallback se `siteKeyId` non specificato.
 *   - CAP_DEFAULT_SECRET  (opt)        fallback secret.
 */

import { logger } from '../logger';
import type { CaptchaProvider, CaptchaVerifyOptions, CaptchaVerifyResult } from './index';

const log = logger.child({ scope: 'captcha-cap' });

const CAP_URL = (process.env.CAP_URL || '').replace(/\/$/, '');

interface CapKeyPair {
  siteKey: string;
  secret: string;
}

function envName(prefix: 'SITEKEY' | 'SECRET', id: string): string {
  return `CAP_${prefix}_${id.toUpperCase()}`;
}

function resolveKeyPair(siteKeyId?: string): CapKeyPair | null {
  if (siteKeyId) {
    const siteKey = (process.env[envName('SITEKEY', siteKeyId)] ?? '').trim();
    const secret = (process.env[envName('SECRET', siteKeyId)] ?? '').trim();
    if (siteKey && secret) return { siteKey, secret };
  }
  const fallbackSite = (process.env.CAP_DEFAULT_SITEKEY ?? '').trim();
  const fallbackSecret = (process.env.CAP_DEFAULT_SECRET ?? '').trim();
  if (fallbackSite && fallbackSecret) {
    return { siteKey: fallbackSite, secret: fallbackSecret };
  }
  return null;
}

interface CapSiteVerifyResponse {
  success: boolean;
  challenge_ts?: string;
  errors?: string[];
}

export const capProvider: CaptchaProvider = {
  name: 'cap',

  isConfigured(): boolean {
    if (!CAP_URL) return false;
    // Configurato se ALMENO un site-key è settato (default OR un form-specific).
    if (process.env.CAP_DEFAULT_SITEKEY && process.env.CAP_DEFAULT_SECRET) return true;
    return Object.keys(process.env).some(
      (k) => k.startsWith('CAP_SITEKEY_') || k.startsWith('CAP_SECRET_'),
    );
  },

  async verify(token: string, opts: CaptchaVerifyOptions = {}): Promise<CaptchaVerifyResult> {
    if (!CAP_URL) {
      if (process.env.NODE_ENV === 'production') {
        log.error('CAP_URL non configurato in produzione — blocco richiesta');
        return { ok: false, errorCodes: ['cap-url-not-configured'] };
      }
      // Dev convenience: skip se non configurato.
      return { ok: true, errorCodes: [] };
    }

    if (!token) return { ok: false, errorCodes: ['missing-token'] };

    const keyPair = resolveKeyPair(opts.siteKeyId);
    if (!keyPair) {
      log.error({ siteKeyId: opts.siteKeyId }, 'Cap key pair non configurata per siteKeyId');
      return { ok: false, errorCodes: ['cap-keypair-not-configured'] };
    }

    let parsed: CapSiteVerifyResponse;
    try {
      const res = await fetch(`${CAP_URL}/${keyPair.siteKey}/siteverify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: keyPair.secret,
          response: token,
        }),
      });
      parsed = (await res.json().catch(() => ({ success: false }))) as CapSiteVerifyResponse;
    } catch (err) {
      log.error({ err, siteKeyId: opts.siteKeyId }, 'Cap siteverify network error');
      return { ok: false, errorCodes: ['network-error'] };
    }

    const errorCodes = Array.isArray(parsed.errors) ? [...parsed.errors] : [];

    if (!parsed.success) {
      log.warn({ errorCodes, siteKeyId: opts.siteKeyId }, 'Cap verify failed');
      return { ok: false, errorCodes };
    }

    return { ok: true, errorCodes };
  },
};
