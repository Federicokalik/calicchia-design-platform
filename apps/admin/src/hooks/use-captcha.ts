import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import 'cap-widget';

/**
 * Hook Cap captcha per l'admin SPA (Vite). Mirror semplificato di
 * `apps/sito-v3/src/hooks/useCaptcha.ts` — qui non c'e` runtime config: i
 * valori arrivano via build-time env (`VITE_CAP_PUBLIC_URL`,
 * `VITE_CAP_SITEKEY_ADMIN_LOGIN`).
 *
 * Migrazione 2026-05-29: sostituisce `use-turnstile.ts` (rimosso allo Step E).
 */

const CAP_PUBLIC_URL =
  (import.meta.env.VITE_CAP_PUBLIC_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const ADMIN_LOGIN_SITEKEY =
  (import.meta.env.VITE_CAP_SITEKEY_ADMIN_LOGIN as string | undefined) ?? '';

/** i18n italiano del widget Cap (admin UI = italiano fisso). */
const I18N: Record<string, string> = {
  'data-cap-i18n-initial-state': 'Verifica che sei umano',
  'data-cap-i18n-verifying-label': 'Verifica in corso…',
  'data-cap-i18n-solved-label': 'Verifica completata',
  'data-cap-i18n-error-label': 'Errore',
  'data-cap-i18n-troubleshooting-label': 'Aiuto',
  'data-cap-i18n-wasm-disabled': 'Abilita WebAssembly per una verifica piu` rapida',
  'data-cap-i18n-verify-aria-label': 'Clicca per verificare che sei umano',
  'data-cap-i18n-verifying-aria-label': 'Verifica in corso, attendi',
  'data-cap-i18n-verified-aria-label': 'Verifica completata',
  'data-cap-i18n-required-label': 'Completa la verifica anti-bot per accedere',
  'data-cap-i18n-error-aria-label': 'Si e` verificato un errore, riprova',
};

export interface UseCaptchaResult {
  containerRef: RefObject<HTMLDivElement | null>;
  token: string | null;
  reset: () => void;
  ready: boolean;
  error: string | null;
}

/**
 * Monta `<cap-widget>` nel container e ritorna il token quando l'utente
 * risolve il PoW. L'admin ha un solo form: `admin_login`.
 */
export function useCaptcha(action: 'admin_login' = 'admin_login'): UseCaptchaResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setToken(null);
    setError(null);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!CAP_PUBLIC_URL || !ADMIN_LOGIN_SITEKEY) {
      setError('Captcha non configurato (VITE_CAP_* env mancanti)');
      return;
    }

    container.innerHTML = '';
    const widget = document.createElement('cap-widget');
    widget.setAttribute('data-cap-api-endpoint', `${CAP_PUBLIC_URL}/${ADMIN_LOGIN_SITEKEY}/`);
    widget.setAttribute('data-cap-hidden-field-name', 'cap-token');
    for (const [key, value] of Object.entries(I18N)) widget.setAttribute(key, value);

    const handleSolve = (e: Event) => {
      const detail = (e as CustomEvent<{ token: string }>).detail;
      setToken(detail.token);
      setError(null);
    };
    const handleError = (e: Event) => {
      const detail = (e as CustomEvent<{ message: string }>).detail;
      setToken(null);
      setError(detail?.message ?? 'Verifica anti-bot non riuscita.');
    };
    const handleReset = () => {
      setToken(null);
      setError(null);
    };

    widget.addEventListener('solve', handleSolve);
    widget.addEventListener('error', handleError);
    widget.addEventListener('reset', handleReset);

    container.appendChild(widget);
    setReady(true);

    return () => {
      widget.removeEventListener('solve', handleSolve);
      widget.removeEventListener('error', handleError);
      widget.removeEventListener('reset', handleReset);
      if (widget.parentElement === container) container.removeChild(widget);
      setReady(false);
    };
  }, [action]);

  return { containerRef, token, reset, ready, error };
}
