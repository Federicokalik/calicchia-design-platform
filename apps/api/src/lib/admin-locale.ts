import type { Context } from 'hono';

export type AdminLocale = 'it' | 'en';

export const ADMIN_LOCALES = ['it', 'en'] as const;

export function isAdminLocale(value: unknown): value is AdminLocale {
  return value === 'it' || value === 'en';
}

export function getAdminLocale(c: Context): AdminLocale {
  const explicit = c.req.header('x-admin-locale');
  if (isAdminLocale(explicit)) return explicit;

  const accepted = c.req.header('accept-language') || '';
  const first = accepted.split(',')[0]?.trim().toLowerCase();
  if (first?.startsWith('en')) return 'en';

  return 'it';
}

const messages = {
  it: {
    authRequired: 'Non autorizzato',
    invalidToken: 'Token non valido',
    invalidOrExpiredToken: 'Token non valido o scaduto',
    invalidCredentials: 'Credenziali non valide',
    adminOnly: 'Accesso non autorizzato. Solo gli admin possono accedere.',
    emailPasswordRequired: 'Email e password richiesti',
    userNotFound: 'Utente non trovato',
    unsupportedLocale: 'Lingua non supportata (it|en)',
    settingsKeyUnsupported: 'Chiave settings non supportata',
    invalidJson: 'Payload JSON non valido',
    validationFailed: 'Validazione fallita',
  },
  en: {
    authRequired: 'Unauthorized',
    invalidToken: 'Invalid token',
    invalidOrExpiredToken: 'Invalid or expired token',
    invalidCredentials: 'Invalid credentials',
    adminOnly: 'Unauthorized access. Only admins can sign in.',
    emailPasswordRequired: 'Email and password are required',
    userNotFound: 'User not found',
    unsupportedLocale: 'Unsupported language (it|en)',
    settingsKeyUnsupported: 'Unsupported settings key',
    invalidJson: 'Invalid JSON payload',
    validationFailed: 'Validation failed',
  },
} as const;

export type AdminMessageKey = keyof typeof messages.it;

export function adminMessage(c: Context, key: AdminMessageKey): string {
  return messages[getAdminLocale(c)][key];
}
