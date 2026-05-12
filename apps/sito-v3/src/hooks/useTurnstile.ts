'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: TurnstileRenderOptions) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
      getResponse: (widgetId: string) => string | undefined;
    };
    onloadTurnstile?: () => void;
  }
}

interface TurnstileRenderOptions {
  sitekey: string;
  theme?: 'light' | 'dark' | 'auto';
  size?: 'normal' | 'compact' | 'invisible';
  appearance?: 'always' | 'execute' | 'interaction-only';
  callback?: (token: string) => void;
  'error-callback'?: () => void;
  'expired-callback'?: () => void;
  'timeout-callback'?: () => void;
}

export interface UseTurnstileResult {
  /** Mount the Turnstile widget on the given container ref. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** Latest token (cleared on submit / reset). */
  token: string | null;
  /** Manually trigger reset (e.g. after submit failure to get a fresh token). */
  reset: () => void;
  /** Whether the script + widget are ready. */
  ready: boolean;
  /** Error string if widget reported a failure. */
  error: string | null;
}

const SCRIPT_ID = 'cloudflare-turnstile-script';
const SCRIPT_SRC =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onloadTurnstile';

let loadPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (loadPromise) return loadPromise;

  loadPromise = new Promise<void>((resolve, reject) => {
    const previousOnload = window.onloadTurnstile;

    window.onloadTurnstile = () => {
      previousOnload?.();
      resolve();
    };

    const existingScript = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (existingScript) {
      existingScript.addEventListener('load', () => resolve(), { once: true });
      existingScript.addEventListener(
        'error',
        () => {
          loadPromise = null;
          reject(new Error('Impossibile caricare la verifica anti-bot.'));
        },
        { once: true }
      );
      return;
    }

    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onerror = () => {
      loadPromise = null;
      reject(new Error('Impossibile caricare la verifica anti-bot.'));
    };

    document.head.appendChild(script);
  });

  return loadPromise;
}

export function useTurnstile(siteKey: string | undefined): UseTurnstileResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setToken(null);
    setError(null);

    if (typeof window === 'undefined') return;
    if (!widgetIdRef.current || !window.turnstile) return;

    window.turnstile.reset(widgetIdRef.current);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !siteKey) {
      setReady(false);
      setToken(null);
      setError(null);
      return;
    }

    let cancelled = false;

    setReady(false);
    setToken(null);
    setError(null);

    loadTurnstileScript()
      .then(() => {
        if (cancelled) return;

        const container = containerRef.current;
        if (!container || !window.turnstile) {
          setError('Verifica anti-bot non disponibile.');
          return;
        }

        if (widgetIdRef.current) {
          window.turnstile.remove(widgetIdRef.current);
          widgetIdRef.current = null;
        }

        widgetIdRef.current = window.turnstile.render(container, {
          sitekey: siteKey,
          theme: 'light',
          size: 'invisible',
          callback: (nextToken) => {
            setToken(nextToken);
            setError(null);
          },
          'error-callback': () => {
            setToken(null);
            setError('Verifica anti-bot non riuscita. Riprova.');
          },
          'expired-callback': () => {
            setToken(null);
            setError('Verifica anti-bot scaduta. Riprova.');
          },
          'timeout-callback': () => {
            setToken(null);
            setError('Verifica anti-bot scaduta. Riprova.');
          },
        });

        setReady(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Verifica anti-bot non disponibile.');
      });

    return () => {
      cancelled = true;

      if (typeof window === 'undefined') return;
      if (!widgetIdRef.current || !window.turnstile) return;

      window.turnstile.remove(widgetIdRef.current);
      widgetIdRef.current = null;
    };
  }, [siteKey]);

  return {
    containerRef,
    token,
    reset,
    ready,
    error,
  };
}
