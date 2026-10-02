'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  GLOSSARIO_CATEGORIES,
  GLOSSARIO_LEVELS,
  GLOSSARIO_UI,
  glossarioTermAnchor,
  normalizeSearch,
  type GlossarioCategory,
  type GlossarioLevel,
} from '@/data/glossario';
import { useLenisAnchor } from '@/hooks/useLenisAnchor';
import type { Locale } from '@/lib/i18n';

export interface GlossarioIndexItem {
  slug: string;
  letter: string;
  category?: GlossarioCategory;
  level: GlossarioLevel;
  /** term + fullName + aliases, già normalizzati con `normalizeSearch` */
  haystack: string;
}

type CategoryFilter = 'all' | GlossarioCategory;
type LevelFilter = 'all' | GlossarioLevel;

interface GlossarioFiltersProps {
  locale: Locale;
  index: GlossarioIndexItem[];
}

const CHIP_CLASS =
  'inline-flex min-h-[40px] shrink-0 items-center whitespace-nowrap border px-3 py-2 font-mono text-[length:var(--text-mono-xs)] uppercase tracking-[0.15em] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]';

function chipStyle(active: boolean) {
  return active
    ? { background: 'var(--color-ink)', color: 'var(--color-bg)', borderColor: 'var(--color-ink)' }
    : { color: 'var(--color-text-secondary)', borderColor: 'var(--color-border-strong)' };
}

/**
 * Ricerca live (termine, nome esteso, alias) + filtri per categoria e livello.
 *
 * Le voci sono renderizzate dal server: qui non si duplica il contenuto, si
 * genera solo un <style> che nasconde voci, lettere e voci dell'indice A-Z
 * che non corrispondono. Senza JavaScript la pagina resta completa.
 */
export function GlossarioFilters({ locale, index }: GlossarioFiltersProps) {
  const ui = GLOSSARIO_UI[locale];
  const searchId = useId();
  const scrollToAnchor = useLenisAnchor();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [level, setLevel] = useState<LevelFilter>('all');
  const pendingScroll = useRef<string | null>(null);

  const categories = useMemo(
    () =>
      GLOSSARIO_CATEGORIES.map((c) => ({
        id: c.id,
        label: c.label[locale],
        count: index.filter((i) => i.category === c.id).length,
      })).filter((c) => c.count > 0),
    [index, locale],
  );

  const visible = useMemo(() => {
    const tokens = normalizeSearch(query).split(/\s+/).filter(Boolean);
    return new Set(
      index
        .filter((item) => category === 'all' || item.category === category)
        .filter((item) => level === 'all' || item.level === level)
        .filter((item) => tokens.every((t) => item.haystack.includes(t)))
        .map((item) => item.slug),
    );
  }, [index, query, category, level]);

  const isFiltering = query.trim() !== '' || category !== 'all' || level !== 'all';

  const hiddenCss = useMemo(() => {
    if (!isFiltering) return '';
    const hiddenTerms = index.filter((i) => !visible.has(i.slug));
    const visibleLetters = new Set(index.filter((i) => visible.has(i.slug)).map((i) => i.letter));
    const hiddenLetters = Array.from(new Set(index.map((i) => i.letter))).filter(
      (l) => !visibleLetters.has(l),
    );
    // slug [a-z0-9-] e lettere [A-Z0-9]: sicuri dentro un selettore tra virgolette.
    const selectors = [
      ...hiddenTerms.map((i) => `[data-glossario-term="${i.slug}"]`),
      ...hiddenLetters.map((l) => `[data-glossario-letter="${l}"]`),
      ...hiddenLetters.map((l) => `li:has(> a[href="#letter-${l}"])`),
    ];
    return selectors.length ? `${selectors.join(',\n')} { display: none !important; }` : '';
  }, [index, visible, isFiltering]);

  const reset = useCallback(() => {
    setQuery('');
    setCategory('all');
    setLevel('all');
  }, []);

  // Link "Vedi anche": se la voce di destinazione è filtrata, azzera i filtri
  // e scorri dopo il re-render (quando la voce è di nuovo visibile).
  useEffect(() => {
    const onClick = (evt: MouseEvent) => {
      const link = (evt.target as HTMLElement | null)?.closest<HTMLAnchorElement>('a[data-glossario-link]');
      const slug = link?.dataset.glossarioLink;
      if (!slug) return;
      evt.preventDefault();
      history.replaceState(null, '', `#${glossarioTermAnchor(slug)}`);
      if (isFiltering && !visible.has(slug)) {
        pendingScroll.current = slug;
        reset();
      } else {
        scrollToAnchor(glossarioTermAnchor(slug));
      }
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [isFiltering, visible, reset, scrollToAnchor]);

  useEffect(() => {
    if (!pendingScroll.current || isFiltering) return;
    const slug = pendingScroll.current;
    pendingScroll.current = null;
    requestAnimationFrame(() => {
      // Lenis tiene in cache l'altezza della pagina filtrata: senza resize lo
      // scroll verso una voce appena tornata visibile si ferma al vecchio limite.
      (window.__lenis as { resize?: () => void } | undefined)?.resize?.();
      scrollToAnchor(glossarioTermAnchor(slug));
    });
  }, [isFiltering, scrollToAnchor]);

  // Link vecchi (#lcp, prima del prefisso term-): porta alla voce giusta.
  useEffect(() => {
    const slug = decodeURIComponent(window.location.hash.slice(1));
    if (!slug || !index.some((i) => i.slug === slug)) return;
    history.replaceState(null, '', `#${glossarioTermAnchor(slug)}`);
    requestAnimationFrame(() => scrollToAnchor(glossarioTermAnchor(slug)));
  }, [index, scrollToAnchor]);

  return (
    <div className="mb-4 flex flex-col gap-6 pb-10" role="search">
      <div>
        <label
          htmlFor={searchId}
          className="block font-mono text-[length:var(--text-mono-xs)] uppercase tracking-[0.22em]"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          {ui.searchLabel}
        </label>
        <input
          id={searchId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={ui.searchPlaceholder}
          autoComplete="off"
          className="mt-3 w-full border-0 border-b bg-transparent py-4 text-xl outline-none transition-colors placeholder:text-[var(--color-text-tertiary)] focus-visible:border-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-offset-4 md:text-2xl"
          style={{ borderBottom: '1px solid var(--color-border-strong)', color: 'var(--color-text-primary)' }}
        />
      </div>

      {/* Mobile: una riga scorrevole (9 categorie andrebbero su 5 righe); md+: a capo. */}
      <div
        role="group"
        aria-label={ui.categoryLabel}
        className="-mx-6 flex gap-2 overflow-x-auto px-6 pb-1 [scrollbar-width:none] md:mx-0 md:flex-wrap md:overflow-visible md:px-0 md:pb-0"
      >
        <button
          type="button"
          aria-pressed={category === 'all'}
          onClick={() => setCategory('all')}
          className={CHIP_CLASS}
          style={chipStyle(category === 'all')}
        >
          {ui.allCategories}
        </button>
        {categories.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-pressed={category === c.id}
            onClick={() => setCategory(category === c.id ? 'all' : c.id)}
            className={CHIP_CLASS}
            style={chipStyle(category === c.id)}
          >
            {c.label}
            <span className="ml-2 tabular-nums opacity-70">{c.count}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div role="group" aria-label={ui.levelLabel} className="flex flex-wrap gap-2">
          <button
            type="button"
            aria-pressed={level === 'all'}
            onClick={() => setLevel('all')}
            className={CHIP_CLASS}
            style={chipStyle(level === 'all')}
          >
            {ui.allLevels}
          </button>
          {GLOSSARIO_LEVELS.map((l) => (
            <button
              key={l.id}
              type="button"
              aria-pressed={level === l.id}
              onClick={() => setLevel(level === l.id ? 'all' : l.id)}
              className={CHIP_CLASS}
              style={chipStyle(level === l.id)}
            >
              {l.label[locale]}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-4">
          <p
            aria-live="polite"
            className="font-mono text-[length:var(--text-mono-xs)] uppercase tracking-[0.18em] tabular-nums"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            {ui.results(visible.size, index.length)}
          </p>
          {isFiltering ? (
            <button
              type="button"
              onClick={reset}
              className="font-mono text-[length:var(--text-mono-xs)] uppercase tracking-[0.18em] underline underline-offset-4 transition-colors hover:text-[var(--color-link-hover)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--color-focus)]"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              {ui.reset}
            </button>
          ) : null}
        </div>
      </div>

      {isFiltering && visible.size === 0 ? (
        <p className="text-lg" style={{ color: 'var(--color-text-secondary)' }}>
          {ui.noResults}
        </p>
      ) : null}

      {hiddenCss ? <style>{hiddenCss}</style> : null}
    </div>
  );
}
