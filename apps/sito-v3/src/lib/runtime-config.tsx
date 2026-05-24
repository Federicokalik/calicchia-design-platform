'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { PublicRuntimeConfig } from '@/app/api/config/route';

// Runtime config provider — fetches /api/config once at mount, exposes via
// React context, and lets client components read deploy-time values without
// any NEXT_PUBLIC_* baked into the Docker image. See app/api/config/route.ts
// for the rationale.
//
// Until the fetch resolves, the context value is `null`. Consumers should
// treat `null` as "config still loading" and render a placeholder / hold
// off third-party script injection. Most analytics + Turnstile components
// already wait for their key before doing work, so the small delay
// (typically <100 ms, often cached by the SW or browser) is invisible.

const EMPTY_CONFIG: PublicRuntimeConfig = {
  gaMeasurementId: '',
  mouseflowId: '',
  turnstileSiteKey: '',
  googleMapsKey: '',
};

interface RuntimeConfigState {
  config: PublicRuntimeConfig;
  ready: boolean;
}

const RuntimeConfigContext = createContext<RuntimeConfigState>({
  config: EMPTY_CONFIG,
  ready: false,
});

let inflight: Promise<PublicRuntimeConfig> | null = null;

function fetchConfig(): Promise<PublicRuntimeConfig> {
  if (inflight) return inflight;
  inflight = fetch('/api/config', { credentials: 'omit' })
    .then((res) => {
      if (!res.ok) throw new Error(`config fetch ${res.status}`);
      return res.json() as Promise<PublicRuntimeConfig>;
    })
    .catch(() => EMPTY_CONFIG);
  return inflight;
}

export function RuntimeConfigProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<RuntimeConfigState>({
    config: EMPTY_CONFIG,
    ready: false,
  });

  useEffect(() => {
    let cancelled = false;
    fetchConfig().then((config) => {
      if (cancelled) return;
      setState({ config, ready: true });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <RuntimeConfigContext.Provider value={state}>
      {children}
    </RuntimeConfigContext.Provider>
  );
}

export function useRuntimeConfig(): RuntimeConfigState {
  return useContext(RuntimeConfigContext);
}
