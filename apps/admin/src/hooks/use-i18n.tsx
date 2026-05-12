import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { literalEn, literalIt, messages } from '@/lib/i18n-dictionary';
import {
  getStoredAdminLocale,
  setStoredAdminLocale,
  toIntlLocale,
  type AdminLocale,
} from '@/lib/i18n-storage';

type Params = Record<string, string | number>;

interface I18nContextValue {
  locale: AdminLocale;
  intlLocale: 'it-IT' | 'en-US';
  setLocale: (locale: AdminLocale) => void;
  t: (key: string, params?: Params) => string;
  formatDate: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) => string;
  formatDateTime: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) => string;
  formatRelativeTime: (value: string | number | Date, options?: { compact?: boolean }) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatCurrency: (value: number, currency?: string) => string;
  formatLeadSource: (source: string) => string;
  formatStatus: (scope: string, status: string) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? `{${key}}`));
}

function shouldSkipNode(node: Node): boolean {
  const parent = node.parentElement;
  if (!parent) return true;
  return Boolean(parent.closest('input, textarea, select, option, pre, code, script, style, [contenteditable="true"], .ProseMirror'));
}

function translateLiteral(value: string, locale: AdminLocale): string {
  const trimmed = value.trim();
  if (!trimmed) return value;
  const map = locale === 'en' ? literalEn : literalIt;
  const translated = map[trimmed];
  return translated ? value.replace(trimmed, translated) : value;
}

function translateDom(root: Node & ParentNode, locale: AdminLocale) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node instanceof Text && !shouldSkipNode(node)) textNodes.push(node);
  }
  for (const node of textNodes) {
    const next = translateLiteral(node.nodeValue || '', locale);
    if (node.nodeValue !== next) node.nodeValue = next;
  }

  const attrNames = ['placeholder', 'title', 'aria-label'];
  for (const attr of attrNames) {
    for (const element of Array.from(root.querySelectorAll?.(`[${attr}]`) || [])) {
      if (element.closest('input, textarea, select, option, pre, code, [contenteditable="true"], .ProseMirror')) continue;
      const current = element.getAttribute(attr);
      if (current) {
        const next = translateLiteral(current, locale);
        if (next !== current) element.setAttribute(attr, next);
      }
    }
  }
}

function toDate(value: string | number | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function relativeUnit(diffMs: number) {
  const absSeconds = Math.max(0, Math.floor(Math.abs(diffMs) / 1000));
  if (absSeconds < 60) return { value: 0, unit: 'second' as Intl.RelativeTimeFormatUnit };
  const minutes = Math.floor(absSeconds / 60);
  if (minutes < 60) return { value: -minutes, unit: 'minute' as Intl.RelativeTimeFormatUnit };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { value: -hours, unit: 'hour' as Intl.RelativeTimeFormatUnit };
  const days = Math.floor(hours / 24);
  if (days < 30) return { value: -days, unit: 'day' as Intl.RelativeTimeFormatUnit };
  const months = Math.floor(days / 30);
  if (months < 12) return { value: -months, unit: 'month' as Intl.RelativeTimeFormatUnit };
  return { value: -Math.floor(months / 12), unit: 'year' as Intl.RelativeTimeFormatUnit };
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<AdminLocale>(() => getStoredAdminLocale());

  const setLocale = useCallback((next: AdminLocale) => {
    setLocaleState(next);
    setStoredAdminLocale(next);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dataset.adminLocale = locale;
    const run = () => translateDom(document.body, locale);
    run();
    const raf = window.requestAnimationFrame(run);
    const observer = new MutationObserver(() => window.requestAnimationFrame(run));
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => {
      window.cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [locale]);

  useEffect(() => {
    const onLocaleChanged = (event: Event) => {
      const next = (event as CustomEvent<{ locale?: AdminLocale }>).detail?.locale;
      if (next === 'it' || next === 'en') setLocaleState(next);
    };
    window.addEventListener('admin-locale-changed', onLocaleChanged);
    return () => window.removeEventListener('admin-locale-changed', onLocaleChanged);
  }, []);

  const value = useMemo<I18nContextValue>(() => {
    const intlLocale = toIntlLocale(locale);
    return {
      locale,
      intlLocale,
      setLocale,
      t: (key, params) => interpolate(messages[locale][key] || messages.it[key] || key, params),
      formatDate: (raw, options) => new Date(raw).toLocaleDateString(intlLocale, options),
      formatDateTime: (raw, options) => toDate(raw).toLocaleString(intlLocale, options),
      formatRelativeTime: (raw, options) => {
        const { value, unit } = relativeUnit(toDate(raw).getTime() - Date.now());
        if (value === 0) return messages[locale]['time.now'];
        return new Intl.RelativeTimeFormat(intlLocale, {
          numeric: 'auto',
          style: options?.compact ? 'narrow' : 'long',
        }).format(value, unit);
      },
      formatNumber: (raw, options) => raw.toLocaleString(intlLocale, options),
      formatCurrency: (raw, currency = 'EUR') =>
        raw.toLocaleString(intlLocale, { style: 'currency', currency }),
      formatLeadSource: (source) =>
        messages[locale][`lead.source.${source}`] || messages.it[`lead.source.${source}`] || source,
      formatStatus: (scope, status) =>
        messages[locale][`${scope}.status.${status}`] || messages.it[`${scope}.status.${status}`] || status,
    };
  }, [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used within I18nProvider');
  return value;
}
