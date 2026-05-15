'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import {
  getAllSeoServicesLocalized,
  getServicesForProfession,
  type SeoService,
} from '@/data/seo-service-matrix';
import {
  getAllProfessionsLocalized,
  getProfessionCategories,
  type SeoProfession,
} from '@/data/seo-professions';
import type { Locale } from '@/lib/i18n';

interface PerChiLavoroProps {
  index?: string;
  /** Optional override; falls back to t('perChiLavoro.eyebrowDefault'). */
  eyebrow?: string;
  /** Optional override; falls back to t('perChiLavoro.titleDefault'). */
  title?: string;
  /** Optional override; falls back to t('perChiLavoro.subtitleDefault'). */
  subtitle?: string;
}

// Profession + service labels sono locale-aware (vedi seo-professions-labels-en.ts
// e SERVICE_LABELS_EN in seo-service-matrix.ts). Le pagine matrice
// /sito-web-per-* restano IT-only (route guard EN), ma il SELETTORE qui
// appare anche su pagine EN bilingual e deve mostrare label tradotte.
// Le liste vengono lette dentro al component con `useMemo([locale])`.

function normalizeSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function formatCount(value: number): string {
  return value.toString().padStart(2, '0');
}

export function PerChiLavoro({
  index = '10',
  eyebrow,
  title,
  subtitle,
}: PerChiLavoroProps) {
  const locale = useLocale() as Locale;
  const t = useTranslations('perChiLavoro');

  // Locale-aware data (label, categorie, etc.) — derived da locale corrente.
  const ALL_PROFESSIONS = useMemo(() => getAllProfessionsLocalized(locale), [locale]);
  const ALL_SERVICES = useMemo(() => getAllSeoServicesLocalized(locale), [locale]);
  const PROFESSION_BY_SLUG = useMemo(
    () => new Map(ALL_PROFESSIONS.map((p) => [p.slug, p])),
    [ALL_PROFESSIONS],
  );
  const PROFESSION_CATEGORIES = getProfessionCategories(locale);
  const CATEGORY_ORDER = useMemo(
    () => Object.values(PROFESSION_CATEGORIES),
    [PROFESSION_CATEGORIES],
  );
  const PROFESSIONS_BY_CATEGORY = useMemo<Record<string, SeoProfession[]>>(() => {
    const out: Record<string, SeoProfession[]> = {};
    for (const cat of CATEGORY_ORDER) {
      out[cat.id] = ALL_PROFESSIONS.filter((p) => p.categoryId === cat.id);
    }
    return out;
  }, [CATEGORY_ORDER, ALL_PROFESSIONS]);

  const getCategoryLabel = (profession: SeoProfession): string =>
    PROFESSION_CATEGORIES[profession.categoryId]?.label ?? profession.categoryId;

  const matchesQuery = (profession: SeoProfession, query: string): boolean => {
    const normalizedQuery = normalizeSearch(query);
    if (!normalizedQuery) return true;
    const searchable = normalizeSearch(
      `${profession.label} ${profession.slug} ${profession.categoryId} ${getCategoryLabel(profession)}`,
    );
    const queryTokens = normalizedQuery.split(/\s+/).filter(Boolean);
    return queryTokens.every((token) => searchable.includes(token));
  };

  // 3-step funnel: category → profession → services.
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const titleId = useId();
  const searchId = useId();
  const firstServiceRef = useRef<HTMLAnchorElement | null>(null);
  const firstProfessionRef = useRef<HTMLButtonElement | null>(null);

  const selectedProfession = selectedSlug
    ? PROFESSION_BY_SLUG.get(selectedSlug)
    : undefined;

  const isSearching = normalizeSearch(query).length > 0;
  const step: 'category' | 'profession' | 'service' = selectedProfession
    ? 'service'
    : selectedCategoryId || isSearching
      ? 'profession'
      : 'category';

  const visibleProfessions = useMemo<SeoProfession[]>(() => {
    if (step === 'service') return [];
    if (isSearching) {
      return ALL_PROFESSIONS.filter((p) => matchesQuery(p, query));
    }
    if (selectedCategoryId) {
      return PROFESSIONS_BY_CATEGORY[selectedCategoryId] ?? [];
    }
    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, isSearching, query, selectedCategoryId, PROFESSIONS_BY_CATEGORY]);

  const validServices = useMemo<SeoService[]>(() => {
    if (!selectedProfession) return ALL_SERVICES;
    // getServicesForProfession ritorna SEO_SERVICES IT — applichiamo locale.
    const itServices = getServicesForProfession(selectedProfession.slug);
    if (locale === 'it') return itServices;
    const bySlug = new Map(ALL_SERVICES.map((s) => [s.slug, s]));
    return itServices.map((s) => bySlug.get(s.slug) ?? s);
  }, [selectedProfession, ALL_SERVICES, locale]);

  useEffect(() => {
    if (step === 'service' && selectedProfession) {
      const f = window.requestAnimationFrame(() =>
        firstServiceRef.current?.focus(),
      );
      return () => window.cancelAnimationFrame(f);
    }
    if (step === 'profession' && selectedCategoryId && !isSearching) {
      const f = window.requestAnimationFrame(() =>
        firstProfessionRef.current?.focus(),
      );
      return () => window.cancelAnimationFrame(f);
    }
  }, [step, selectedProfession, selectedCategoryId, isSearching]);

  const goBackToCategory = () => {
    setSelectedSlug(null);
    setSelectedCategoryId(null);
    setQuery('');
  };

  const goBackToProfession = () => {
    setSelectedSlug(null);
  };

  const eyebrowText = eyebrow ?? t('eyebrowDefault');
  const titleText = title ?? t('titleDefault');
  const subtitleText = subtitle ?? t('subtitleDefault');

  const counterText = (() => {
    if (step === 'service' && selectedProfession) {
      return t('servicesCount', { count: validServices.length });
    }
    if (step === 'profession') {
      return isSearching
        ? t('activitiesFound', { count: visibleProfessions.length })
        : t('activitiesInCategory', { count: visibleProfessions.length });
    }
    return t('sectorsAndActivities', {
      sectors: CATEGORY_ORDER.length,
      activities: ALL_PROFESSIONS.length,
    });
  })();

  return (
    <section
      role="region"
      aria-labelledby={titleId}
      data-matrix-section
      className="relative mx-auto max-w-[1600px] px-6 py-32 md:px-10 md:py-44 lg:px-14"
      style={{ borderTop: '1px solid var(--color-border)' }}
    >
      <div className="mb-12 flex items-baseline justify-between gap-6 md:mb-20">
        <p
          className="font-mono text-[length:var(--text-mono-xs)] uppercase tracking-[0.25em]"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          {index} — {eyebrowText}
        </p>
        <span
          className="text-right font-mono text-[length:var(--text-mono-xs)] uppercase tracking-[0.18em]"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          {counterText}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-12 md:grid-cols-12 md:gap-16">
        <div className="md:col-span-5">
          <h2
            id={titleId}
            className="mb-8 max-w-[14ch] font-[family-name:var(--font-display)]"
            style={{
              color: 'var(--color-text-primary)',
              fontSize: 'clamp(2.5rem, 4.5vw, 4rem)',
              fontWeight: 500,
              lineHeight: 0.95,
            }}
          >
            {titleText}
          </h2>
          <p
            className="max-w-[42ch] text-lg leading-relaxed md:text-xl"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            {subtitleText}
          </p>
        </div>

        <div className="md:col-span-7">
          {step !== 'service' && (
            <div className="mb-8">
              <label
                htmlFor={searchId}
                className="block font-mono text-[length:var(--text-mono-xs)] uppercase tracking-[0.22em]"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                {t('searchLabel')}
              </label>
              <input
                id={searchId}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('searchPlaceholder')}
                className="mt-3 w-full border-0 border-b bg-transparent py-4 text-xl outline-none transition-colors placeholder:text-[var(--color-text-tertiary)] focus-visible:border-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-offset-4 md:text-2xl"
                style={{
                  borderBottom: '1px solid var(--color-border-strong)',
                  color: 'var(--color-text-primary)',
                }}
              />
            </div>
          )}

          {/* STEP 1 — Categories */}
          {step === 'category' && (
            <div role="list" aria-label={t('sectorsListLabel')} style={{ borderTop: '1px solid var(--color-border)' }}>
              {CATEGORY_ORDER.map((cat, idx) => {
                const count = PROFESSIONS_BY_CATEGORY[cat.id]?.length ?? 0;
                if (count === 0) return null;
                return (
                  <div
                    key={cat.id}
                    role="listitem"
                    style={{ borderBottom: '1px solid var(--color-border)' }}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedCategoryId(cat.id)}
                      className="group grid min-h-[64px] w-full grid-cols-[3rem_1fr_auto] items-center gap-4 py-5 text-left transition-colors hover:bg-[var(--color-surface-elev)] focus-visible:bg-[var(--color-surface-elev)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-text-primary)]"
                    >
                      <span
                        className="font-mono text-[length:var(--text-mono-xs)] tabular-nums"
                        style={{ color: 'var(--color-text-secondary)' }}
                      >
                        {formatCount(idx + 1)}
                      </span>
                      <span className="flex flex-col gap-1">
                        <span
                          className="font-[family-name:var(--font-display)] text-2xl leading-tight md:text-3xl"
                          style={{ color: 'var(--color-text-primary)', fontWeight: 500 }}
                        >
                          {cat.label}
                        </span>
                        <span
                          className="font-mono text-[length:var(--text-mono-xs)] uppercase tracking-[0.16em]"
                          style={{ color: 'var(--color-text-tertiary)' }}
                        >
                          {t('activitiesCountInCategory', { count })}
                        </span>
                      </span>
                      <span
                        aria-hidden="true"
                        className="text-2xl transition-transform group-hover:translate-x-1"
                        style={{ color: 'var(--color-accent-deep)' }}
                      >
                        →
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* STEP 2 — Activities */}
          {step === 'profession' && (
            <div>
              {!isSearching && selectedCategoryId && (
                <div className="mb-6 flex items-baseline justify-between gap-4">
                  <p
                    className="font-mono text-[length:var(--text-mono-xs)] uppercase tracking-[0.22em]"
                    style={{ color: 'var(--color-accent-deep)' }}
                  >
                    {PROFESSION_CATEGORIES[selectedCategoryId]?.label ?? ''}
                  </p>
                  <button
                    type="button"
                    onClick={goBackToCategory}
                    className="font-mono text-[length:var(--text-mono-xs)] uppercase tracking-[0.18em] underline underline-offset-4 transition-colors hover:text-[var(--color-accent-deep)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--color-text-primary)]"
                    style={{ color: 'var(--color-text-secondary)' }}
                  >
                    {t('backToSector')}
                  </button>
                </div>
              )}

              {visibleProfessions.length > 0 ? (
                <div
                  role="list"
                  aria-label={t('activitiesListLabel')}
                  style={{ borderTop: '1px solid var(--color-border)' }}
                >
                  {visibleProfessions.map((profession, idx) => (
                    <div
                      key={profession.slug}
                      role="listitem"
                      style={{ borderBottom: '1px solid var(--color-border)' }}
                    >
                      <button
                        ref={idx === 0 ? firstProfessionRef : undefined}
                        type="button"
                        onClick={() => setSelectedSlug(profession.slug)}
                        className="group grid min-h-[56px] w-full grid-cols-[3rem_1fr_auto] items-center gap-4 py-4 text-left transition-colors hover:bg-[var(--color-surface-elev)] focus-visible:bg-[var(--color-surface-elev)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-text-primary)]"
                      >
                        <span
                          className="font-mono text-[length:var(--text-mono-xs)] tabular-nums"
                          style={{ color: 'var(--color-text-secondary)' }}
                        >
                          {formatCount(idx + 1)}
                        </span>
                        <span className="flex flex-col gap-1">
                          <span
                            className="font-[family-name:var(--font-display)] text-2xl leading-tight md:text-3xl"
                            style={{ color: 'var(--color-text-primary)', fontWeight: 500 }}
                          >
                            {profession.label}
                          </span>
                          {isSearching && (
                            <span
                              className="font-mono text-[length:var(--text-mono-xs)] uppercase tracking-[0.16em]"
                              style={{ color: 'var(--color-text-tertiary)' }}
                            >
                              {getCategoryLabel(profession)}
                            </span>
                          )}
                        </span>
                        <span
                          aria-hidden="true"
                          className="text-2xl transition-transform group-hover:translate-x-1"
                          style={{ color: 'var(--color-accent-deep)' }}
                        >
                          →
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p
                  className="border-y py-8 text-lg"
                  style={{
                    borderColor: 'var(--color-border)',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  {t('noActivitiesFound')}
                </p>
              )}
            </div>
          )}

          {/* STEP 3 — Services */}
          {step === 'service' && selectedProfession && (
            <div>
              <div className="mb-8 flex flex-col gap-5 border-b pb-8 md:flex-row md:items-end md:justify-between">
                <div>
                  <p
                    className="font-mono text-[length:var(--text-mono-xs)] uppercase tracking-[0.22em]"
                    style={{ color: 'var(--color-text-secondary)' }}
                  >
                    {t('youPicked')}
                  </p>
                  <h3
                    className="mt-3 font-[family-name:var(--font-display)] text-3xl leading-none md:text-5xl"
                    style={{ color: 'var(--color-text-primary)', fontWeight: 500 }}
                  >
                    {selectedProfession.label}
                  </h3>
                </div>
                <div className="flex flex-col gap-3 md:items-end">
                  <button
                    type="button"
                    onClick={goBackToProfession}
                    className="self-start font-mono text-[length:var(--text-mono-xs)] uppercase tracking-[0.18em] underline underline-offset-4 transition-colors hover:text-[var(--color-accent-deep)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--color-text-primary)] md:self-auto"
                    style={{ color: 'var(--color-text-secondary)' }}
                  >
                    {t('backToActivity')}
                  </button>
                  <button
                    type="button"
                    onClick={goBackToCategory}
                    className="self-start font-mono text-[length:var(--text-mono-xs)] uppercase tracking-[0.18em] underline underline-offset-4 transition-colors hover:text-[var(--color-accent-deep)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--color-text-primary)] md:self-auto"
                    style={{ color: 'var(--color-text-tertiary)' }}
                  >
                    {t('backToSector')}
                  </button>
                </div>
              </div>

              {validServices.length > 0 ? (
                <div
                  role="list"
                  aria-label={t('servicesForActivity', { activity: selectedProfession.label })}
                  style={{ borderTop: '1px solid var(--color-border)' }}
                >
                  {validServices.map((service, idx) => (
                    <div
                      key={service.slug}
                      role="listitem"
                      style={{ borderBottom: '1px solid var(--color-border)' }}
                    >
                      <Link
                        ref={idx === 0 ? firstServiceRef : undefined}
                        href={`/${service.urlPrefix}-${selectedProfession.slug}`}
                        className="group grid min-h-[64px] grid-cols-[3rem_1fr_auto] items-center gap-4 py-5 transition-colors hover:bg-[var(--color-surface-elev)] focus-visible:bg-[var(--color-surface-elev)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-text-primary)]"
                      >
                        <span
                          className="font-mono text-[length:var(--text-mono-xs)] tabular-nums"
                          style={{ color: 'var(--color-text-secondary)' }}
                        >
                          {formatCount(idx + 1)}
                        </span>
                        <span
                          className="font-[family-name:var(--font-display)] text-2xl leading-tight md:text-3xl"
                          style={{ color: 'var(--color-text-primary)', fontWeight: 500 }}
                        >
                          {service.label}
                        </span>
                        <span
                          className="font-mono text-[length:var(--text-mono-xs)] uppercase tracking-[0.16em] transition-transform group-hover:translate-x-1"
                          style={{ color: 'var(--color-accent-deep)' }}
                        >
                          {t('openPage')}
                        </span>
                      </Link>
                    </div>
                  ))}
                </div>
              ) : (
                <div
                  className="border-y py-8"
                  style={{
                    borderColor: 'var(--color-border)',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  <p className="max-w-[52ch] text-lg leading-relaxed">
                    {t('noServicesYet')}
                  </p>
                  <Link
                    href="/contatti"
                    className="mt-6 inline-flex font-mono text-[length:var(--text-mono-xs)] uppercase tracking-[0.18em] underline underline-offset-4 hover:text-[var(--color-accent-deep)]"
                  >
                    {t('writeToMe')}
                  </Link>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
