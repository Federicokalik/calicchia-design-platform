import { useState, useCallback } from 'react';

const STORAGE_KEY = 'admin-ai-panel-open';

export function useAiPanel() {
  const [open, setOpen] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem(STORAGE_KEY) === 'true';
    }
    return false;
  });

  const toggle = useCallback(() => {
    setOpen((o) => {
      const next = !o;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    localStorage.setItem(STORAGE_KEY, 'false');
  }, []);

  return { open, toggle, close };
}
