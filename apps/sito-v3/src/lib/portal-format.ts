import { redirect } from 'next/navigation';
import type { PortalCustomer } from '@/lib/portal-api';

/**
 * Translation function shape compatible with both `useTranslations('portal')`
 * and `await getTranslations('portal')` from next-intl.
 */
type PortalT = (key: string, values?: Record<string, string | number>) => string;

/** Map locale code to Intl format locale (en → en-US, default → it-IT). */
function intlLocale(locale: string): string {
  return locale === 'en' ? 'en-US' : 'it-IT';
}

export function formatPortalDate(
  value: string | null | undefined,
  locale: string,
  options?: Intl.DateTimeFormatOptions
): string {
  if (!value) return locale === 'en' ? 'Not set' : 'Non definita';
  return new Intl.DateTimeFormat(intlLocale(locale), {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...options,
  }).format(new Date(value));
}

export function formatPortalMonth(month: number, year: number, locale: string): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    month: 'long',
    year: 'numeric',
  }).format(new Date(year, month - 1, 1));
}

export function formatPortalCurrency(
  value: number | null | undefined,
  locale: string,
  currency = 'EUR'
): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value ?? 0);
}

export function formatPortalBytes(bytes?: number | null) {
  const value = bytes ?? 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function getPortalCustomerLabel(customer: PortalCustomer | null, t: PortalT): string {
  return (
    customer?.company_name ?? customer?.contact_name ?? customer?.email ?? t('shell.userFallback')
  );
}

/**
 * Translate a known status key via `portal.status.<key>`. If the key is not
 * in the dictionary, falls back to the raw status with underscores replaced.
 */
export function formatPortalStatus(status: string | null | undefined, t: PortalT): string {
  if (!status) return t('format.statusNotDefined');
  const translated = t(`status.${status}`);
  // next-intl returns the key path on miss; detect and fall back.
  if (translated === `status.${status}`) return status.replace(/_/g, ' ');
  return translated;
}

/**
 * Throw-redirect al login del portale preservando `?next=<original-path>`.
 *
 * Importante: usa il `redirect` nativo di `next/navigation`, NON quello
 * tipato di `@/i18n/navigation`. Il wrapper next-intl parsa l'argomento
 * con `new URL()` per matcharlo contro PATHNAMES e una stringa con query
 * (`/clienti/login?next=...`) fa esplodere con `ERR_INVALID_URL` (URL
 * relativi non hanno base). I call site esistenti hanno la forma:
 *   redirect(portalLoginRedirect('/clienti/x'));
 * Visto che questa funzione ora throw `NEXT_REDIRECT` prima di tornare,
 * il `redirect(...)` esterno non viene mai eseguito — compatibilita`
 * mantenuta senza toccare i 14+ call site del portale.
 */
export function portalLoginRedirect(next: string): never {
  redirect(`/clienti/login?next=${encodeURIComponent(next)}`);
}
