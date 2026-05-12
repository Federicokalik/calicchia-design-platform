export type AdminLocale = 'it' | 'en';

export const ADMIN_LOCALES = ['it', 'en'] as const;
export const DEFAULT_ADMIN_LOCALE: AdminLocale = 'it';
export const ADMIN_LOCALE_STORAGE_KEY = 'admin.ui_locale';

export function isAdminLocale(value: unknown): value is AdminLocale {
  return value === 'it' || value === 'en';
}

export function getStoredAdminLocale(): AdminLocale {
  if (typeof window === 'undefined') return DEFAULT_ADMIN_LOCALE;
  const stored = window.localStorage.getItem(ADMIN_LOCALE_STORAGE_KEY);
  return isAdminLocale(stored) ? stored : DEFAULT_ADMIN_LOCALE;
}

export function setStoredAdminLocale(locale: AdminLocale) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(ADMIN_LOCALE_STORAGE_KEY, locale);
  window.dispatchEvent(new CustomEvent('admin-locale-changed', { detail: { locale } }));
}

export function toIntlLocale(locale: AdminLocale): 'it-IT' | 'en-US' {
  return locale === 'en' ? 'en-US' : 'it-IT';
}
