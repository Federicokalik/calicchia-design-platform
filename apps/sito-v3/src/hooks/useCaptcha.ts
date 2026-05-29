'use client';

/**
 * Hook captcha polimorfico — wrapper su Turnstile (legacy) o Cap (self-host).
 *
 * Stesso shape pubblico di `useTurnstile`: il consumer non sa quale provider
 * stia girando. Il provider viene scelto via `config.captcha.provider`
 * (default `turnstile` finché il pilot Cap non e` validato).
 *
 * Migrazione progressiva:
 *   - I form esistenti continuano a usare `useTurnstile` finche` non vengono
 *     migrati uno-a-uno a `useCaptcha` (Step D = pilot PortalLoginForm,
 *     Step E = rollout completo).
 *   - In dev e prod con `CAPTCHA_PROVIDER` non settato → comportamento identico
 *     a oggi (Turnstile).
 *
 * Vedi piano migrazione 2026-05-29.
 */

import { useCallback, useEffect, useRef, useState, type Ref } from 'react';
import { useTurnstile } from './useTurnstile';
import { useRuntimeConfig } from '@/lib/runtime-config';
import type { CaptchaFormId } from '@/app/api/config/route';

// cap-widget registra il custom element <cap-widget> globale.
// Importato solo come side-effect; il widget viene mountato via JSX nel
// `containerRef`, quindi non serve un'API React esposta.
import 'cap-widget';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'cap-widget': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          'data-cap-api-endpoint': string;
          'data-cap-hidden-field-name'?: string;
          'data-cap-worker-count'?: string | number;
        },
        HTMLElement
      >;
    }
  }

  interface HTMLElementEventMap {
    solve: CustomEvent<{ token: string }>;
    error: CustomEvent<{ message: string }>;
    reset: CustomEvent;
    progress: CustomEvent<{ progress: number }>;
  }
}

export interface UseCaptchaResult {
  /**
   * Ref del container dove il widget si renderizza. Implementato come callback
   * ref + state per gestire correttamente i container montati condizionalmente
   * (es. BookingWidget mostra il form solo dopo la scelta dello slot).
   */
  containerRef: Ref<HTMLDivElement>;
  /** Token corrente (null finche` non risolto / dopo reset). */
  token: string | null;
  /** Trigger un reset esplicito (es. dopo submit fallito). */
  reset: () => void;
  /** Widget pronto a produrre token. */
  ready: boolean;
  /** Stringa errore se il provider ha riportato fault. */
  error: string | null;
  /** Provider attivo (utile in DevTools per debug). */
  provider: 'turnstile' | 'cap';
}

/** Etichette i18n del widget Cap (usato solo quando provider=cap). */
export interface CaptchaI18n {
  initialState?: string;
  verifyingLabel?: string;
  solvedLabel?: string;
  errorLabel?: string;
  troubleshootingLabel?: string;
  wasmDisabled?: string;
  verifyAriaLabel?: string;
  verifyingAriaLabel?: string;
  verifiedAriaLabel?: string;
  requiredLabel?: string;
  errorAriaLabel?: string;
}

/** Default in italiano per il portale (IT-only). Altri form passano override. */
const CAPTCHA_I18N_IT: Required<CaptchaI18n> = {
  initialState: 'Verifica che sei umano',
  verifyingLabel: 'Verifica in corso…',
  solvedLabel: 'Verifica completata',
  errorLabel: 'Errore',
  troubleshootingLabel: 'Aiuto',
  wasmDisabled: 'Abilita WebAssembly per una verifica piu` rapida',
  verifyAriaLabel: 'Clicca per verificare che sei umano',
  verifyingAriaLabel: 'Verifica in corso, attendi',
  verifiedAriaLabel: 'Verifica completata',
  requiredLabel: 'Per inviare il modulo, completa la verifica anti-bot',
  errorAriaLabel: 'Si e` verificato un errore, riprova',
};

/**
 * Hook captcha polimorfico.
 *
 * @param action  identificativo del form (es. `portal_login`, `contact_form`).
 *                Per Turnstile = `expectedAction` binding.
 *                Per Cap = chiave per selezionare la site key (CAP_SITEKEY_<UPPER>).
 * @param i18n    override delle etichette Cap (default = italiano). Per form
 *                bilingual, passare le stringhe tradotte via `useTranslations`.
 */
export function useCaptcha(action: CaptchaFormId, i18n?: CaptchaI18n): UseCaptchaResult {
  const { config } = useRuntimeConfig();
  const captchaCfg = config.captcha;
  // Provider risolto: prima override per-form, poi default globale.
  const provider = captchaCfg?.providers?.[action] ?? captchaCfg?.provider ?? 'turnstile';

  // Cas (B): provider 'turnstile' — delega al hook esistente con back-compat.
  // `useTurnstile` accetta la siteKey legacy come argomento; passiamo quella
  // attuale (config.turnstileSiteKey) per zero impatto.
  const turnstileResult = useTurnstile(
    provider === 'turnstile' ? config.turnstileSiteKey : undefined,
    action,
  );

  // Cas (A): provider 'cap' — montiamo <cap-widget> e ascoltiamo `solve`/`error`/`reset`.
  // Callback ref + state: re-mount funziona anche se il container viene reso
  // dopo l'iniziale (es. dopo selezione slot in BookingWidget).
  const [capContainer, setCapContainer] = useState<HTMLDivElement | null>(null);
  const capContainerRef = useCallback((el: HTMLDivElement | null) => {
    setCapContainer(el);
  }, []);
  const [capToken, setCapToken] = useState<string | null>(null);
  const [capReady, setCapReady] = useState(false);
  const [capError, setCapError] = useState<string | null>(null);
  // Nonce: incrementato in reset() per forzare la remount del widget. Cap non
  // espone un metodo reset() pubblico — post-solve il widget mostra "Verifica
  // completata ✓" e non puo` essere ri-solto. Per flussi che consumano il token
  // e richiedono fresh challenge (es. 2FA step 2, retry dopo submit fail)
  // occorre distruggere e ricreare il widget.
  const [capNonce, setCapNonce] = useState(0);

  const capReset = useCallback(() => {
    setCapToken(null);
    setCapError(null);
    setCapNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (provider !== 'cap') return;
    const container = capContainer;
    if (!container || !captchaCfg?.capEndpoint) return;

    const siteKey = captchaCfg.siteKeys?.[action];
    if (!siteKey) {
      setCapError(`Site key Cap mancante per "${action}"`);
      return;
    }

    // Pulisci eventuali widget precedenti (in caso di re-mount).
    container.innerHTML = '';

    const widget = document.createElement('cap-widget');
    widget.setAttribute(
      'data-cap-api-endpoint',
      `${captchaCfg.capEndpoint.replace(/\/$/, '')}/${siteKey}/`,
    );
    widget.setAttribute('data-cap-hidden-field-name', 'cap-token');

    // i18n: merge default IT + override caller. Ogni etichetta si applica come
    // attributo `data-cap-i18n-<kebab>` letta da cap-widget al render.
    const labels: Required<CaptchaI18n> = { ...CAPTCHA_I18N_IT, ...i18n };
    const i18nMap: Record<keyof CaptchaI18n, string> = {
      initialState: 'data-cap-i18n-initial-state',
      verifyingLabel: 'data-cap-i18n-verifying-label',
      solvedLabel: 'data-cap-i18n-solved-label',
      errorLabel: 'data-cap-i18n-error-label',
      troubleshootingLabel: 'data-cap-i18n-troubleshooting-label',
      wasmDisabled: 'data-cap-i18n-wasm-disabled',
      verifyAriaLabel: 'data-cap-i18n-verify-aria-label',
      verifyingAriaLabel: 'data-cap-i18n-verifying-aria-label',
      verifiedAriaLabel: 'data-cap-i18n-verified-aria-label',
      requiredLabel: 'data-cap-i18n-required-label',
      errorAriaLabel: 'data-cap-i18n-error-aria-label',
    };
    for (const key of Object.keys(i18nMap) as Array<keyof CaptchaI18n>) {
      widget.setAttribute(i18nMap[key], labels[key]);
    }

    const handleSolve = (e: Event) => {
      const detail = (e as CustomEvent<{ token: string }>).detail;
      setCapToken(detail.token);
      setCapError(null);
    };
    const handleError = (e: Event) => {
      const detail = (e as CustomEvent<{ message: string }>).detail;
      setCapToken(null);
      setCapError(detail?.message ?? 'Verifica anti-bot non riuscita.');
    };
    const handleReset = () => {
      setCapToken(null);
      setCapError(null);
    };

    widget.addEventListener('solve', handleSolve);
    widget.addEventListener('error', handleError);
    widget.addEventListener('reset', handleReset);

    container.appendChild(widget);
    setCapReady(true);

    return () => {
      widget.removeEventListener('solve', handleSolve);
      widget.removeEventListener('error', handleError);
      widget.removeEventListener('reset', handleReset);
      if (widget.parentElement === container) container.removeChild(widget);
      setCapReady(false);
    };
  }, [provider, captchaCfg, action, capContainer, capNonce, i18n]);

  if (provider === 'cap') {
    return {
      containerRef: capContainerRef,
      token: capToken,
      reset: capReset,
      ready: capReady,
      error: capError,
      provider: 'cap',
    };
  }

  // provider === 'turnstile'
  return {
    containerRef: turnstileResult.containerRef,
    token: turnstileResult.token,
    reset: turnstileResult.reset,
    ready: turnstileResult.ready,
    error: turnstileResult.error,
    provider: 'turnstile',
  };
}
