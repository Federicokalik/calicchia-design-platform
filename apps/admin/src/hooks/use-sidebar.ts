import { useState, useCallback, useEffect } from 'react';

const STORAGE_KEY = 'admin-sidebar-collapsed';

export function useSidebar() {
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem(STORAGE_KEY) === 'true';
    }
    return false;
  });

  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(collapsed));
  }, [collapsed]);

  const toggle = useCallback(() => setCollapsed((c) => !c), []);
  const toggleMobile = useCallback(() => setMobileOpen((o) => !o), []);
  const closeMobile = useCallback(() => setMobileOpen(false), []);

  return { collapsed, toggle, mobileOpen, toggleMobile, closeMobile };
}
