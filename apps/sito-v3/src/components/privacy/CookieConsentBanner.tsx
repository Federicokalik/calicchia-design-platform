'use client';

import { CaretDown, X } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import {
  acceptAll,
  getConsent,
  installCookieConsentGlobals,
  logConsentToServer,
  rejectAll,
  setConsent,
  shouldShowBanner,
  type ConsentRecord,
} from '@/lib/cookie-consent';
import {
  VENDORS_BY_CATEGORY,
  type ConsentCategory,
  type VendorDisclosure,
} from '@/data/cookie-vendors';
import {
  DEFAULT_LOCALE,
  isLocale,
  localizedPath,
  type Locale,
} from '@/lib/i18n';

type BannerView = 'main' | 'preferences';

function persist(record: ConsentRecord) {
  void logConsentToServer(record);
}

function localeFromPath(pathname: string | null): Locale {
  const firstSeg = (pathname ?? '/').split('/')[1];
  return isLocale(firstSeg) ? firstSeg : DEFAULT_LOCALE;
}

/**
 * GDPR cookie consent banner — bottom-anchored sheet, equal-weight Accept/Reject,
 * vendor accordion in the preferences view.
 *
 * Compliance anchors (May 2026 baseline):
 *  - Garante Italia "Linee guida cookie" 2021 §6 (6-month silence after reject),
 *    §10.b (X = refuse, equal prominence of Accept/Reject), §10.f (vendor list).
 *  - EDPB Cookie Banner Taskforce Report 2023 §4.1-4.3 (reject equally
 *    prominent on first layer, no nudging via color/wording, granular per-purpose).
 *  - GDPR art. 7(3) (withdraw consent as easy as give it — wired via the
 *    footer "Gestisci cookie" button calling window.__openCookiePreferences()).
 */
export function CookieConsentBanner() {
  const pathname = usePathname();
  const locale = localeFromPath(pathname);
  const intlLocale = useLocale() as Locale;
  const t = useTranslations('cookies.banner');
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [view, setView] = useState<BannerView>('main');
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);

  useEffect(() => {
    installCookieConsentGlobals();
    setMounted(true);
    setVisible(shouldShowBanner());

    window.__openCookiePreferences = () => {
      const consent = getConsent();
      setAnalytics(consent?.preferences.analytics ?? false);
      setMarketing(consent?.preferences.marketing ?? false);
      setView('preferences');
      setVisible(true);
    };

    return () => {
      if (window.__openCookiePreferences) {
        delete window.__openCookiePreferences;
      }
    };
  }, []);

  const closeWithNecessary = () => {
    const record = rejectAll();
    persist(record);
    setVisible(false);
    setView('main');
  };

  const accept = () => {
    const record = acceptAll();
    persist(record);
    setVisible(false);
    setView('main');
  };

  const savePreferences = () => {
    const record = setConsent({ analytics, marketing });
    persist(record);
    setVisible(false);
    setView('main');
  };

  const goToPreferences = () => {
    const consent = getConsent();
    setAnalytics(consent?.preferences.analytics ?? false);
    setMarketing(consent?.preferences.marketing ?? false);
    setView('preferences');
  };

  if (!mounted || !visible) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('kicker')}
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[120] flex items-end justify-center md:px-6 md:pb-6"
    >
      {/* Dim backdrop only — NO click-to-dismiss. Per Garante 2021 §6 an
          ambiguous dismissal cannot be interpreted as consent. The user must
          pick X (= refuse), "Solo necessari" (= refuse) or "Accetta tutti". */}
      <div className="pointer-events-auto absolute inset-0 bg-black/30" aria-hidden />

      <div
        className="pointer-events-auto relative max-h-[85vh] w-full max-w-[720px] overflow-y-auto border"
        style={{
          background: 'var(--color-ink)',
          color: 'var(--color-bg)',
          borderColor: 'rgba(250,250,247,0.14)',
        }}
      >
        <button
          type="button"
          onClick={closeWithNecessary}
          aria-label={t('closeAriaLabel')}
          className="absolute right-4 top-4 inline-flex size-11 items-center justify-center border transition-colors hover:bg-white/10"
          style={{ borderColor: 'rgba(250,250,247,0.18)' }}
        >
          <X size={18} aria-hidden />
        </button>

        <div className="p-6 md:p-8">
          {view === 'main' ? (
            <MainView
              locale={locale}
              onReject={closeWithNecessary}
              onAccept={accept}
              onCustomize={goToPreferences}
            />
          ) : (
            <PreferencesView
              locale={intlLocale}
              analytics={analytics}
              marketing={marketing}
              onAnalyticsChange={setAnalytics}
              onMarketingChange={setMarketing}
              onBack={() => setView('main')}
              onSave={savePreferences}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ────────────────────── Main view (first layer) ──────────────────────

interface MainViewProps {
  locale: Locale;
  onReject: () => void;
  onAccept: () => void;
  onCustomize: () => void;
}

function MainView({ locale, onReject, onAccept, onCustomize }: MainViewProps) {
  const t = useTranslations('cookies.banner');
  return (
    <>
      <p
        className="font-mono text-[10px] uppercase tracking-[0.24em]"
        style={{ color: 'rgba(250,250,247,0.52)' }}
      >
        {t('kicker')}
      </p>
      <h2
        className="mt-5 max-w-[14ch] font-[family-name:var(--font-display)] text-3xl md:text-4xl"
        style={{ fontWeight: 500, letterSpacing: '-0.035em', lineHeight: 0.98 }}
      >
        {t('title')}
      </h2>
      <p
        className="mt-5 max-w-[58ch] text-sm leading-relaxed"
        style={{ color: 'rgba(250,250,247,0.68)' }}
      >
        {t('intro')}
      </p>
      <p className="mt-4 text-sm" style={{ color: 'rgba(250,250,247,0.62)' }}>
        <Link
          href={localizedPath('/cookie-policy', locale)}
          className="underline underline-offset-4"
        >
          {t('cookiePolicy')}
        </Link>
        {' / '}
        <Link
          href={localizedPath('/privacy-policy', locale)}
          className="underline underline-offset-4"
        >
          {t('privacyPolicy')}
        </Link>
      </p>

      {/* Equal-weight Accept/Reject: same border, same typography, same height,
          no accent fill on Accept. Order is Reject-then-Accept (EDPB Taskforce
          2023 §4.1 anti-nudging convention). */}
      <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={onReject}
          className="min-h-[44px] border px-5 py-3 text-xs font-medium uppercase tracking-[0.18em] transition-colors hover:bg-white/10"
          style={{ borderColor: 'rgba(250,250,247,0.22)' }}
        >
          {t('rejectAll')}
        </button>
        <button
          type="button"
          onClick={onAccept}
          className="min-h-[44px] border px-5 py-3 text-xs font-medium uppercase tracking-[0.18em] transition-colors hover:bg-white/10"
          style={{ borderColor: 'rgba(250,250,247,0.22)' }}
        >
          {t('acceptAll')}
        </button>
      </div>
      <button
        type="button"
        onClick={onCustomize}
        className="mt-4 inline-flex items-center text-xs font-medium uppercase tracking-[0.18em] underline underline-offset-4 transition-opacity hover:opacity-70"
        style={{ color: 'rgba(250,250,247,0.78)' }}
      >
        {t('customize')}
      </button>
    </>
  );
}

// ────────────────────── Preferences view (second layer) ──────────────────────

interface PreferencesViewProps {
  locale: Locale;
  analytics: boolean;
  marketing: boolean;
  onAnalyticsChange: (next: boolean) => void;
  onMarketingChange: (next: boolean) => void;
  onBack: () => void;
  onSave: () => void;
}

function PreferencesView({
  locale,
  analytics,
  marketing,
  onAnalyticsChange,
  onMarketingChange,
  onBack,
  onSave,
}: PreferencesViewProps) {
  const t = useTranslations('cookies.banner');
  return (
    <>
      <p
        className="font-mono text-[10px] uppercase tracking-[0.24em]"
        style={{ color: 'rgba(250,250,247,0.52)' }}
      >
        {t('preferencesKicker')}
      </p>
      <h2
        className="mt-5 font-[family-name:var(--font-display)] text-3xl md:text-4xl"
        style={{ fontWeight: 500, letterSpacing: '-0.035em', lineHeight: 0.98 }}
      >
        {t('preferencesTitle')}
      </h2>
      <p
        className="mt-4 max-w-[58ch] text-sm leading-relaxed"
        style={{ color: 'rgba(250,250,247,0.68)' }}
      >
        {t('preferencesIntro')}
      </p>

      <div
        className="mt-8 divide-y"
        style={{
          borderTop: '1px solid rgba(250,250,247,0.14)',
          borderColor: 'rgba(250,250,247,0.14)',
        }}
      >
        <CategoryBlock category="necessary" locale={locale} alwaysOn />
        <CategoryBlock
          category="analytics"
          locale={locale}
          checked={analytics}
          onChange={onAnalyticsChange}
        />
        <CategoryBlock
          category="marketing"
          locale={locale}
          checked={marketing}
          onChange={onMarketingChange}
        />
      </div>

      <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={onBack}
          className="min-h-[44px] border px-5 py-3 text-xs font-medium uppercase tracking-[0.18em] transition-colors hover:bg-white/10"
          style={{ borderColor: 'rgba(250,250,247,0.22)' }}
        >
          {t('back')}
        </button>
        <button
          type="button"
          onClick={onSave}
          className="min-h-[44px] border px-5 py-3 text-xs font-medium uppercase tracking-[0.18em] transition-colors hover:bg-white/10"
          style={{ borderColor: 'rgba(250,250,247,0.22)' }}
        >
          {t('save')}
        </button>
      </div>
    </>
  );
}

// ────────────────────── Category block + vendor accordion ──────────────────────

interface CategoryBlockProps {
  category: ConsentCategory;
  locale: Locale;
  alwaysOn?: boolean;
  checked?: boolean;
  onChange?: (next: boolean) => void;
}

function CategoryBlock({ category, locale, alwaysOn, checked, onChange }: CategoryBlockProps) {
  const t = useTranslations('cookies.banner');
  const vendors = VENDORS_BY_CATEGORY[category];
  const categoryLabel = t(`categories.${category}.label`);

  return (
    <div className="py-5">
      <div className="grid grid-cols-[1fr_auto] items-start gap-5">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.14em]">{categoryLabel}</p>
          <p
            className="mt-2 text-sm leading-relaxed"
            style={{ color: 'rgba(250,250,247,0.62)' }}
          >
            {t(`categories.${category}.description`)}
          </p>
        </div>
        {alwaysOn ? (
          <span
            className="font-mono text-xs uppercase tracking-[0.18em]"
            style={{ color: 'rgba(250,250,247,0.5)' }}
          >
            {t('categories.necessary.always')}
          </span>
        ) : (
          <label className="inline-flex cursor-pointer items-center">
            <span className="sr-only">{categoryLabel}</span>
            <input
              type="checkbox"
              checked={checked ?? false}
              onChange={(event) => onChange?.(event.target.checked)}
              className="size-5 accent-[var(--color-accent)]"
            />
          </label>
        )}
      </div>

      {vendors.length > 0 && (
        <details className="group mt-4 [&::-webkit-details-marker]:hidden">
          <summary
            className="flex cursor-pointer list-none items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] transition-opacity hover:opacity-80 [&::-webkit-details-marker]:hidden"
            style={{ color: 'rgba(250,250,247,0.62)' }}
            aria-label={t('table.expandCategoryAria', { category: categoryLabel })}
          >
            <CaretDown
              size={12}
              aria-hidden
              className="transition-transform group-open:rotate-180"
            />
            {vendors.length} vendor
          </summary>
          <ul
            className="mt-4 flex flex-col gap-5 border-t pt-4"
            style={{ borderColor: 'rgba(250,250,247,0.08)' }}
          >
            {vendors.map((vendor) => (
              <VendorRow key={vendor.id} vendor={vendor} locale={locale} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

interface VendorRowProps {
  vendor: VendorDisclosure;
  locale: Locale;
}

function VendorRow({ vendor, locale }: VendorRowProps) {
  const t = useTranslations('cookies.banner.table');
  const isExternal = vendor.policyUrl.startsWith('http');
  const labelClass =
    'font-mono text-[10px] uppercase tracking-[0.18em]';
  const labelStyle = { color: 'rgba(250,250,247,0.5)' } as const;

  return (
    <li
      className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[140px_1fr]"
      style={{ color: 'rgba(250,250,247,0.78)' }}
    >
      <span className={labelClass} style={labelStyle}>{t('vendor')}</span>
      <span className="text-sm font-medium">{vendor.name}</span>

      <span className={labelClass} style={labelStyle}>{t('cookies')}</span>
      <span className="font-mono text-[12px]" style={{ color: 'rgba(250,250,247,0.72)' }}>
        {vendor.serverProcessing ? t('serverOnly') : vendor.cookies.join(', ')}
      </span>

      <span className={labelClass} style={labelStyle}>{t('purpose')}</span>
      <span className="text-[13px] leading-relaxed">{vendor.purpose[locale]}</span>

      <span className={labelClass} style={labelStyle}>{t('duration')}</span>
      <span className="text-[13px]">{vendor.duration[locale]}</span>

      <span className={labelClass} style={labelStyle}>{t('processor')}</span>
      <span className="text-[13px]">{vendor.processor}</span>

      <span className={labelClass} style={labelStyle}>{t('policy')}</span>
      <a
        href={vendor.policyUrl}
        target={isExternal ? '_blank' : undefined}
        rel={isExternal ? 'noopener noreferrer' : undefined}
        className="text-[13px] underline underline-offset-4 hover:opacity-80"
      >
        {t('policyLink')}
      </a>
    </li>
  );
}
