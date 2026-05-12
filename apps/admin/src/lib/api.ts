import { getStoredAdminLocale, toIntlLocale } from './i18n-storage';

export const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

/**
 * Tracks when the user last successfully hit the API.
 * The server refreshes the JWT cookie on every authenticated request,
 * so this mirrors the server-side `last_activity` for warning the user
 * before the 30-minute idle timeout kicks in.
 */
export const sessionState = { lastActivity: Date.now() };

function isAuthRedirectExempt(): boolean {
  const path = window.location.pathname;
  return path === '/login' || path === '/setup' || path.startsWith('/firma/');
}

/**
 * Fetch wrapper that sends credentials (cookie-based auth) and auto-parses JSON.
 * Returns parsed JSON data directly.
 * Throws on non-ok responses. Redirects to /login on 401 (except on public pages).
 */
export async function apiFetch(
  endpoint: string,
  options: RequestInit = {}
): Promise<any> {
  const headers = new Headers(options.headers);

  // Don't set Content-Type for FormData (browser sets it with boundary)
  if (!headers.has('Content-Type') && options.body && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  const locale = getStoredAdminLocale();
  headers.set('Accept-Language', toIntlLocale(locale));
  headers.set('X-Admin-Locale', locale);

  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
    credentials: 'include',
  });

  // Parse JSON (or return empty object for non-JSON responses)
  let data: any;
  try {
    data = await res.json();
  } catch {
    data = {};
  }

  if (res.ok) {
    sessionState.lastActivity = Date.now();
    return data;
  }

  if (res.status === 401 && !isAuthRedirectExempt()) {
    // Preserve where we were so the user lands back here after login.
    const back = window.location.pathname + window.location.search;
    window.location.assign(`/login?next=${encodeURIComponent(back)}`);
  }

  throw new Error(data?.error || `HTTP ${res.status}`);
}
