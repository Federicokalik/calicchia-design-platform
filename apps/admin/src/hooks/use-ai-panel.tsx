import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

const STORAGE_KEY = 'admin-ai-panel-open';

interface AiPanelCtx {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
  close: () => void;
}

const AiPanelContext = createContext<AiPanelCtx | null>(null);

/**
 * Shared open-state for the AI assistant panel. Lives at the layout level so
 * both the floating AiBar and the sidebar trigger control the same panel.
 * Persists across reloads via localStorage.
 */
export function AiPanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpenState] = useState(() => {
    if (typeof window !== 'undefined') return localStorage.getItem(STORAGE_KEY) === 'true';
    return false;
  });

  const persist = (v: boolean) => {
    try { localStorage.setItem(STORAGE_KEY, String(v)); } catch { /* ignore */ }
  };

  const setOpen = useCallback((v: boolean) => {
    setOpenState(v);
    persist(v);
  }, []);

  const toggle = useCallback(() => {
    setOpenState((o) => {
      const next = !o;
      persist(next);
      return next;
    });
  }, []);

  const close = useCallback(() => setOpen(false), [setOpen]);

  const value = useMemo(() => ({ open, setOpen, toggle, close }), [open, setOpen, toggle, close]);

  return <AiPanelContext.Provider value={value}>{children}</AiPanelContext.Provider>;
}

export function useAiPanel(): AiPanelCtx {
  const ctx = useContext(AiPanelContext);
  if (!ctx) throw new Error('useAiPanel must be used within AiPanelProvider');
  return ctx;
}
