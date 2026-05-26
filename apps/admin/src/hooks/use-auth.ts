import { useState, useEffect, useCallback } from 'react';
import { API_BASE, refreshAdminSession, sessionState } from '@/lib/api';
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
    const fetchMe = () =>
      fetch(`${API_BASE}/api/auth/me`, {
        credentials: 'include',
        headers: { 'Accept-Language': toIntlLocale(locale), 'X-Admin-Locale': locale },
      });

    fetchMe()
      .then(async (res) => {
        if (res.ok) return res.json();
        if (res.status === 401 && (await refreshAdminSession())) {
          const retry = await fetchMe();
          return retry.ok ? retry.json() : null;
        }
        return null;
      })
      .then((data) => {
        if (data?.user?.ui_locale) setStoredAdminLocale(data.user.ui_locale);
        if (data?.user) sessionState.lastActivity = Date.now();
        setState({ user: data?.user ?? null, isLoading: false });
      })
      .catch(() => {
        setState({ user: null, isLoading: false });
      });
  }, []);

  const signIn = useCallback(async (
    email: string,
    password: string,
    turnstileToken?: string | null,
    mfaCode?: string | null,
    rememberMe?: boolean,
  ): Promise<{ mfaRequired: true } | { mfaRequired: false; user: AuthUser }> => {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept-Language': toIntlLocale(getStoredAdminLocale()),
        'X-Admin-Locale': getStoredAdminLocale(),
      },
      body: JSON.stringify({
        email,
        password,
        turnstile_token: turnstileToken ?? undefined,
        mfa_code: mfaCode ?? undefined,
        remember_me: rememberMe === true,
      }),
      credentials: 'include',
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Errore durante il login');

    // SEC-06: step 1 (password only) on an MFA account — caller must collect a code.
    if (data.mfa_required) return { mfaRequired: true };

    if (data.user?.ui_locale) setStoredAdminLocale(data.user.ui_locale);
    sessionState.lastActivity = Date.now();
    setState({ user: data.user, isLoading: false });
    return { mfaRequired: false, user: data.user };
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
