/**
 * Adapter Turnstile → interfaccia CaptchaProvider.
 *
 * Riusa la verifica hardened esistente in `../turnstile.ts` (idempotency,
 * hostname binding, action binding). Stesso comportamento, signature unificata.
 */

import { verifyTurnstileTokenDetailed, isTurnstileConfigured } from '../turnstile';
import type { CaptchaProvider, CaptchaVerifyOptions, CaptchaVerifyResult } from './index';

export const turnstileProvider: CaptchaProvider = {
  name: 'turnstile',
  isConfigured: isTurnstileConfigured,
  async verify(token: string, opts: CaptchaVerifyOptions = {}): Promise<CaptchaVerifyResult> {
    // `siteKeyId` mappa 1:1 a Turnstile `expectedAction` — convenzione delle
    // chiamate esistenti (es. `portal_login`, `contact_form`).
    const result = await verifyTurnstileTokenDetailed(token, {
      remoteIp: opts.remoteIp,
      expectedAction: opts.siteKeyId,
    });
    return result;
  },
};
