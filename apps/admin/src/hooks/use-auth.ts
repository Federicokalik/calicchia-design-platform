import { useState, useEffect, useCallback } from 'react';
import { API_BASE } from '@/lib/api';
import { getStoredAdminLocale, setStoredAdminLocale, toIntlLocale, type AdminLocale } from '@/lib/i18n-storage';

export interface AuthUser {
  id: string;
  email: string;
  role: string;
  ui_locale?: AdminLocale;
}

interface AuthState {
  user: AuthUser | null;
  isLoading: boolean;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    user: null,
    isLoading: true,
  });

  useEffect(() => {
    const locale = getStoredAdminLocale();
    fetch(`${API_BASE}/api/auth/me`, {
      credentials: 'include',
      headers: { 'Accept-Language': toIntlLocale(locale), 'X-Admin-Locale': locale },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.user?.ui_locale) setStoredAdminLocale(data.user.ui_locale);
        setState({ user: data?.user ?? null, isLoading: false });
      })
      .catch(() => {
        setState({ user: null, isLoading: false });
      });
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept-Language': toIntlLocale(getStoredAdminLocale()),
        'X-Admin-Locale': getStoredAdminLocale(),
      },
      body: JSON.stringify({ email, password }),
      credentials: 'include',
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Errore durante il login');
    if (data.user?.ui_locale) setStoredAdminLocale(data.user.ui_locale);

    setState({ user: data.user, isLoading: false });
    return data;
  }, []);

  const signOut = useCallback(async () => {
    await fetch(`${API_BASE}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    }).catch((err) => console.error('Logout request failed:', err));
    setState({ user: null, isLoading: false });
  }, []);

  return {
    user: state.user,
    isLoading: state.isLoading,
    signIn,
    signOut,
  };
}
