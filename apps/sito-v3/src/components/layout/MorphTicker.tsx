'use client';

import { ArrowRight } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import {
  getMatrixServices,
  getMatrixProfessions,
  getValidProfessions,
  groupProfessionsByCategory,
  buildMatrixUrl,
  type MatrixService,
  type MatrixProfession,
} from '@/data/service-matrix';
import type { Locale } from '@/lib/i18n';

/**
 * Routes "matrice" che già forniscono il funnel servizio×professione —
 * lì il MorphTicker non serve. Match su pattern URL:
 *  - `/{service-prefix}-{prof-slug}` (es. /sito-web-per-avvocati)
 *  - `/zone/{comune}/{service}` (es. /zone/frosinone/seo)
 *  - `/zone/{comune}` (es. /zone/frosinone)
 *  - `/servizi-per-professioni`
 *  - `/sito-web-per-pmi`
 */
const MATRIX_SERVICE_PREFIXES = [
  'sito-web-per',
  'e-commerce-per',
  'sviluppo-web-per',
  'seo-per',
];

function isMatrixPathname(pathname: string | null): boolean {
  if (!pathname) return false;
  // Strip leading locale segment (es. /it/...).
  const stripped = pathname.replace(/^\/(it|en)(?=\/|$)/, '') || '/';
  if (stripped.startsWith('/zone/')) return true;
  // IT canonical + EN translated slug (PATHNAMES: /servizi-per-professioni →
  // /services-by-profession). Match both so the MorphTicker hides on the hub
  // in both locales.
  if (
    stripped === '/servizi-per-professioni' ||
    stripped === '/services-by-profession'
  )
    return true;
  if (stripped === '/sito-web-per-pmi') return true;
  // Match `/{service-prefix}-...`
  for (const prefix of MATRIX_SERVICE_PREFIXES) {
    if (stripped.startsWith(`/${prefix}-`)) return true;
  }
  return false;
}

/**
 * Blog post articles (`/blog/[slug]`): MorphTicker hidden by user request
 * 2026-05-06 — il widget non serve in modalità "leggo un articolo".
 * Blog index `/blog` resta autorizzato (l'utente sta esplorando, non leggendo).
 */
function isBlogPostPathname(pathname: string | null): boolean {
  if (!pathname) return false;
  const stripped = pathname.replace(/^\/(it|en)(?=\/|$)/, '') || '/';
  return /^\/blog\/[^/]+$/.test(stripped);
}

/**
 * Portal client area (`/clienti/*`): è un'area autenticata, non un funnel
 * marketing — niente CTA "in cosa posso aiutarti".
 */
function isPortalPathname(pathname: string | null): boolean {
  if (!pathname) return false;
  const stripped = pathname.replace(/^\/(it|en)(?=\/|$)/, '') || '/';
  return stripped.startsWith('/clienti');
}

/**
 * MorphTicker — Pentagram filter, Swiss-restraint shape.
 *
 * - **Idle**: tab "In cosa posso aiutarti?" (squadrato, cursor-pointer).
 * - **Active**: pill orizzontale con segmenti separati da hairline.
 * - **Dropdown**: aperto con larghezza = intera pill (full width), griglia
 *   multi-colonna per servizi (4 col) e professioni (4 col raggruppate per
 *   categoria) — si vedono molte più voci a colpo d'occhio.
 * - Slot auto-ciclano i valori prima della selezione (placeholder rotanti).
 */
const DISMISS_KEY = 'morph-ticker-dismissed';

export function MorphTicker() {
  const t = useTranslations('navigation.morphTicker');
  const locale = useLocale() as Locale;
  const rootRef = useRef<HTMLDivElement>(null);

  // Locale-aware liste: servizi + professioni con label tradotte. Memoized
  // per evitare ricomputazioni inutili.
  const SERVICES = useMemo(() => getMatrixServices(locale), [locale]);
  const PROFESSIONS = useMemo(() => getMatrixProfessions(locale), [locale]);

  const pathname = usePathname();
  const onMatrixRoute = useMemo(() => isMatrixPathname(pathname), [pathname]);
  const onBlogPostRoute = useMemo(() => isBlogPostPathname(pathname), [pathname]);
  const onPortalRoute = useMemo(() => isPortalPathname(pathname), [pathname]);

  const [phase, setPhase] = useState<'idle' | 'active'>('idle');
  const [service, setService] = useState<MatrixService | null>(null);
  const [profession, setProfession] = useState<MatrixProfession | null>(null);
  const [openMenu, setOpenMenu] = useState<'service' | 'profession' | null>(null);
  const [footerVisible, setFooterVisible] = useState(false);
  const [matrixSectionVisible, setMatrixSectionVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  // Hidden until the user scrolls past the hero (~60% of the viewport).
  // Reset on route change so each landing page restarts with the widget hidden.
  const [scrolledPastHero, setScrolledPastHero] = useState(false);

  // Restore dismissal from session
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (sessionStorage.getItem(DISMISS_KEY) === '1') setDismissed(true);
  }, []);

  // Mobile detection — Swiss compliance unification 2026-05-09: MorphTicker
  // is the SINGLE bottom-right CTA across viewports (replaces ServiceFinderMobile).
  // Desktop renders the horizontal pill; mobile renders the matrix flow as a
  // full-width bottom sheet.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 767px)');
    setIsMobile(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Mobile body scroll lock when active sheet is open
  useEffect(() => {
    if (!isMobile || phase !== 'active') return;
    if (typeof document === 'undefined') return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [isMobile, phase]);

  // Reset profession if service change makes it invalid
  useEffect(() => {
    if (!service || !profession) return;
    const validList = getValidProfessions(service.slug, locale);
    if (!validList.find((p) => p.slug === profession.slug)) {
      setProfession(null);
    }
  }, [service, profession, locale]);

  // Click outside / Esc closes dropdowns + collapses to idle on Esc when empty
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const root = rootRef.current;
      if (!root || !openMenu) return;
      if (!root.contains(e.target as Node)) setOpenMenu(null);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (openMenu) setOpenMenu(null);
      else if (phase === 'active' && !service && !profession) setPhase('idle');
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [openMenu, phase, service, profession]);

  // Hide on hero — reveal once the user scrolls past ~60% of the viewport.
  // Threshold is viewport-relative so it works across all page heroes (home,
  // matrix, blog, zone, etc.) without per-page tagging.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setScrolledPastHero(false);
    const threshold = () => Math.max(240, window.innerHeight * 0.6);
    const check = () => {
      setScrolledPastHero(window.scrollY > threshold());
    };
    check();
    window.addEventListener('scroll', check, { passive: true });
    window.addEventListener('resize', check);
    return () => {
      window.removeEventListener('scroll', check);
      window.removeEventListener('resize', check);
    };
  }, [pathname]);

  // Footer observer — robust against late mounts, locale switches, and
  // client-side navigation across (site) pages. Same MutationObserver +
  // pathname dep pattern as the matrix-section observer below: the previous
  // setup (empty deps + single querySelector at mount) attached to a stale
  // footer node when navigating between EN/IT or pages within the same
  // locale, causing the badge to ignore the footer.
  useEffect(() => {
    if (typeof document === 'undefined') return;

    let currentFooter: Element | null = null;

    const intersectionObserver = new IntersectionObserver(
      ([entry]) => {
        const visible = entry.isIntersecting;
        setFooterVisible(visible);
        if (visible) {
          setOpenMenu(null);
          setPhase('idle');
        }
      },
      { root: null, threshold: 0.04 },
    );

    const attach = (footer: Element | null) => {
      if (footer === currentFooter) return;
      if (currentFooter) intersectionObserver.unobserve(currentFooter);
      currentFooter = footer;
      if (footer) intersectionObserver.observe(footer);
      else setFooterVisible(false);
    };

    attach(document.querySelector('footer'));

    const mutationObserver = new MutationObserver(() => {
      attach(document.querySelector('footer'));
    });
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return () => {
      intersectionObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [pathname]);

  // Hide quando una sezione marcata `data-matrix-section` è visibile
  // (es. PerChiLavoro funnel — duplica funzione del MorphTicker).
  // Usa MutationObserver per intercettare anche le sezioni mountate dopo il
  // primo render (Next App Router + client component lazy hydration).
  useEffect(() => {
    if (typeof document === 'undefined') return;

    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        // Verifica TUTTE le sezioni osservate (non solo le entries del firing).
        const anyVisible = Array.from(observed).some((el) => {
          const r = el.getBoundingClientRect();
          return (
            r.bottom > 0 &&
            r.top < window.innerHeight &&
            r.right > 0 &&
            r.left < window.innerWidth
          );
        });
        setMatrixSectionVisible(anyVisible);
        if (anyVisible) {
          setOpenMenu(null);
          setPhase('idle');
        }
      },
      { root: null, threshold: 0.1 }
    );

    const observed = new Set<Element>();
    const observe = (el: Element) => {
      if (observed.has(el)) return;
      observed.add(el);
      intersectionObserver.observe(el);
    };

    // Initial scan
    document
      .querySelectorAll('[data-matrix-section]')
      .forEach((el) => observe(el));

    // Watch for future additions
    const mutationObserver = new MutationObserver((records) => {
      for (const r of records) {
        r.addedNodes.forEach((n) => {
          if (!(n instanceof Element)) return;
          if (n.matches?.('[data-matrix-section]')) observe(n);
          n.querySelectorAll?.('[data-matrix-section]').forEach((el) =>
            observe(el)
          );
        });
      }
    });
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return () => {
      intersectionObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [pathname]);

  const validProfessions = useMemo(
    () => getValidProfessions(service?.slug ?? null, locale),
    [service?.slug, locale],
  );
  const grouped = useMemo(
    () => groupProfessionsByCategory(validProfessions, locale),
    [validProfessions, locale],
  );
  const matrixUrl =
    service && profession ? buildMatrixUrl(service.slug, profession.slug, locale) : null;

  const reset = () => {
    setService(null);
    setProfession(null);
    setOpenMenu(null);
    setPhase('idle');
  };

  const dismiss = () => {
    if (typeof window !== 'undefined') {
      sessionStorage.setItem(DISMISS_KEY, '1');
    }
    setDismissed(true);
  };

  if (
    footerVisible ||
    matrixSectionVisible ||
    onMatrixRoute ||
    onBlogPostRoute ||
    onPortalRoute ||
    dismissed
  )
    return null;

  // Mobile + active: render full-width bottom sheet (Swiss compliance unification).
  if (isMobile && phase === 'active') {
    return (
      <MobileMatrixSheet
        service={service}
        profession={profession}
        services={SERVICES}
        validProfessions={validProfessions}
        grouped={grouped}
        matrixUrl={matrixUrl}
        onSelectService={(s) => setService(s)}
        onSelectProfession={(p) => setProfession(p)}
        onClose={reset}
      />
    );
  }

  return (
    <div
      ref={rootRef}
      role="presentation"
      data-morph-ticker
      aria-hidden={!scrolledPastHero || undefined}
      className="fixed right-4 bottom-[10px] pointer-events-none"
      style={{
        zIndex: 50,
        // Pure-translate slide — mirrors the Logo "Calicchia" exit motion
        // (translateX + opacity, no scaling). The pill slides off the right
        // edge of the viewport and fades. Power3.out matches header chrome.
        opacity: scrolledPastHero ? 1 : 0,
        transform: scrolledPastHero
          ? 'translateX(0)'
          : 'translateX(calc(100% + 1rem))',
        visibility: scrolledPastHero ? 'visible' : 'hidden',
        willChange: 'transform, opacity',
        transition: scrolledPastHero
          ? 'opacity 450ms cubic-bezier(0.215, 0.61, 0.355, 1), transform 450ms cubic-bezier(0.215, 0.61, 0.355, 1), visibility 0s linear 0s'
          : 'opacity 400ms cubic-bezier(0.215, 0.61, 0.355, 1), transform 400ms cubic-bezier(0.215, 0.61, 0.355, 1), visibility 0s linear 400ms',
      }}
    >
      {/* IDLE TAB — pill with dismiss button */}
      {phase === 'idle' && (
        <div className="pointer-events-auto inline-flex items-stretch" style={{ animation: 'caldes-morph-pop 0.4s ease-out' }}>
        <button
          type="button"
          onClick={() => setPhase('active')}
          className="inline-flex items-center gap-3 px-5 py-3 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          style={{
            background: 'var(--color-ink)',
            color: '#FAFAF7',
            fontFamily: 'var(--font-display)',
            fontSize: 'clamp(0.85rem, 1vw, 1rem)',
            fontWeight: 500,
            letterSpacing: '-0.005em',
            lineHeight: 1,
            border: '1px solid var(--color-border-inverse)',
            boxShadow: 'var(--color-shadow-elevated)',
            borderRadius: 2,
            minHeight: 44,
            animation: 'caldes-morph-pop 0.4s ease-out',
          }}
          aria-label={t('openLabel')}
        >
          <span
            aria-hidden
            className="inline-block size-1.5"
            style={{ background: 'var(--color-accent)' }}
          />
          <span>{t('label')}</span>
          <span
            aria-hidden
            className="caldes-arrow"
            style={{
              color: 'rgba(250,250,247,0.55)',
              fontSize: '1em',
              transform: 'rotate(-45deg)',
              display: 'inline-block',
              transition: 'transform 0.3s ease',
              lineHeight: 1,
            }}
          >
            →
          </span>
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t('dismissLabel')}
          className="inline-flex items-center justify-center w-9 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-white/40 transition-opacity opacity-50 hover:opacity-100"
          style={{
            background: 'var(--color-ink)',
            color: '#FAFAF7',
            border: '1px solid var(--color-border-inverse)',
            borderLeft: '1px solid rgba(250, 250, 247, 0.06)',
            boxShadow: 'var(--color-shadow-elevated)',
            borderRadius: 2,
            minHeight: 44,
          }}
        >
          <span aria-hidden style={{ fontSize: '0.95em' }}>×</span>
        </button>
        </div>
      )}

      {/* ACTIVE FILTER (desktop horizontal pill — mobile is handled by MobileMatrixSheet above) */}
      {phase === 'active' && !isMobile && (
        <div
          className="pointer-events-auto"
          style={{ animation: 'caldes-morph-expand 0.55s cubic-bezier(0.22,1,0.36,1)' }}
        >
          <div
            className="relative inline-flex items-stretch whitespace-nowrap"
            style={{
              background: 'var(--color-ink)',
              color: '#FAFAF7',
              fontFamily: 'var(--font-display)',
              fontSize: 'clamp(0.85rem, 1vw, 1rem)',
              fontWeight: 500,
              letterSpacing: '-0.005em',
              lineHeight: 1,
              border: '1px solid var(--color-border-inverse)',
              boxShadow: 'var(--color-shadow-elevated)',
              borderRadius: 2,
              minHeight: 48,
            }}
          >
            <Segment color="rgba(250,250,247,0.65)">{t('iNeed')}</Segment>

            <Divider />

            <SegmentTrigger
              selected={service}
              placeholderItems={SERVICES.map((s) => s.label)}
              ariaLabel={t('ariaServicesAvailable')}
              accent="var(--color-accent)"
              cycleStartOffset={0}
              open={openMenu === 'service'}
              onToggle={() =>
                setOpenMenu((m) => (m === 'service' ? null : 'service'))
              }
            />

            <Divider />

            <Segment color="rgba(250,250,247,0.65)">{t('for')}</Segment>

            <Divider />

            <SegmentTrigger
              selected={profession}
              placeholderItems={validProfessions.map((p) => p.label)}
              ariaLabel={
                service
                  ? t('ariaForWhomWithService', {
                      count: validProfessions.length,
                      service: service.label,
                    })
                  : t('ariaForWhom')
              }
              accent="#FAFAF7"
              cycleStartOffset={1100}
              open={openMenu === 'profession'}
              onToggle={() =>
                setOpenMenu((m) => (m === 'profession' ? null : 'profession'))
              }
            />

            <Divider />

            {matrixUrl ? (
              <Link
                href={matrixUrl}
                prefetch={false}
                className="inline-flex items-center gap-1.5 px-5 text-xs uppercase tracking-[0.22em] cursor-pointer transition-transform hover:gap-2.5 outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                style={{
                  background: 'var(--color-accent)',
                  color: 'var(--color-accent-ink)',
                  fontWeight: 500,
                }}
              >
                {t('go')}
                <ArrowRight size={14} weight="regular" aria-hidden />
              </Link>
            ) : (
              <Segment color="rgba(250,250,247,0.4)" italic>
                <span className="text-xs uppercase tracking-[0.18em]">
                  {t('choose')}
                </span>
              </Segment>
            )}

            <Divider />

            <button
              type="button"
              onClick={reset}
              aria-label={t('ariaCloseFilter')}
              className="inline-flex items-center justify-center w-10 cursor-pointer transition-opacity opacity-60 hover:opacity-100 outline-none focus-visible:ring-1 focus-visible:ring-white/40"
              style={{ color: '#FAFAF7' }}
            >
              <span aria-hidden style={{ fontSize: '1.1em' }}>
                ×
              </span>
            </button>

            {/* DROPDOWN — full pill width, multi-column grid */}
            {openMenu === 'service' && (
              <FullWidthMenu>
                <div className="px-5 py-5">
                  <div
                    className="font-mono text-[10px] uppercase tracking-[0.22em] mb-3"
                    style={{ color: 'rgba(250,250,247,0.4)' }}
                  >
                    {t('serviceDropdownHeader', { count: SERVICES.length })}
                  </div>
                  <div className="grid grid-cols-4 gap-x-6 gap-y-1">
                    {SERVICES.map((s) => (
                      <GridOption
                        key={s.slug}
                        active={service?.slug === s.slug}
                        accent="var(--color-accent)"
                        onClick={() => {
                          setService(s);
                          setOpenMenu(null);
                        }}
                      >
                        {s.label}
                      </GridOption>
                    ))}
                  </div>
                </div>
              </FullWidthMenu>
            )}

            {openMenu === 'profession' && (
              <FullWidthMenu>
                <div className="px-5 py-5">
                  <div
                    className="font-mono text-[10px] uppercase tracking-[0.22em] mb-3 flex items-baseline justify-between"
                    style={{ color: 'rgba(250,250,247,0.4)' }}
                  >
                    <span>
                      {t('professionDropdownHeader', { count: validProfessions.length })}
                      {service && ` ${t('professionDropdownHeaderCompatible')} `}
                      {service && (
                        <span style={{ color: 'var(--color-accent)' }}>
                          {service.label}
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="flex flex-col gap-4">
                    {grouped.map(({ category, items }) => (
                      <div key={category}>
                        <div
                          className="font-mono text-[10px] uppercase tracking-[0.22em] mb-1.5"
                          style={{ color: 'rgba(250,250,247,0.32)' }}
                        >
                          {category}
                        </div>
                        <div className="grid grid-cols-4 gap-x-6 gap-y-0.5">
                          {items.map((p) => (
                            <GridOption
                              key={p.slug}
                              active={profession?.slug === p.slug}
                              accent="#FAFAF7"
                              onClick={() => {
                                setProfession(p);
                                setOpenMenu(null);
                              }}
                            >
                              {p.label}
                            </GridOption>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </FullWidthMenu>
            )}
          </div>
        </div>
      )}

      <span className="sr-only">
        {phase === 'idle'
          ? t('closedDescription')
          : t('openDescription', {
              services: SERVICES.length,
              professions: validProfessions.length,
            })}
      </span>

      <style>{`
        @keyframes caldes-morph-pop {
          from { transform: scale(0.92); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
        @keyframes caldes-morph-expand {
          from { transform: scale(0.92); opacity: 0; filter: blur(2px); }
          to { transform: scale(1); opacity: 1; filter: blur(0); }
        }
        @keyframes caldes-menu-down {
          from { transform: translateY(-8px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        button[aria-label="Apri il filtro: in cosa posso aiutarti"]:hover .caldes-arrow {
          transform: rotate(-45deg) translate(2px, 0) !important;
        }
        /* On-theme scrollbar — dark + accent thumb */
        .caldes-menu-scroll {
          scrollbar-width: thin;
          scrollbar-color: rgba(250,250,247,0.18) transparent;
        }
        .caldes-menu-scroll::-webkit-scrollbar { width: 8px; }
        .caldes-menu-scroll::-webkit-scrollbar-track {
          background: transparent;
        }
        .caldes-menu-scroll::-webkit-scrollbar-thumb {
          background: rgba(250,250,247,0.14);
          border: 2px solid #111111;
          border-radius: 4px;
        }
        .caldes-menu-scroll::-webkit-scrollbar-thumb:hover {
          background: rgba(250,250,247,0.28);
        }
      `}</style>
    </div>
  );
}

/* ─── Sub-components ─── */

function Segment({
  children,
  color,
  italic,
}: {
  children: React.ReactNode;
  color: string;
  italic?: boolean;
}) {
  return (
    <span
      className="inline-flex items-center px-4"
      style={{ color, fontStyle: italic ? 'italic' : 'normal' }}
    >
      {children}
    </span>
  );
}

function Divider() {
  return (
    <span
      aria-hidden
      className="self-stretch"
      style={{ width: 1, background: 'rgba(250, 250, 247, 0.1)' }}
    />
  );
}

interface SegmentTriggerProps<T extends { slug: string; label: string }> {
  selected: T | null;
  placeholderItems: string[];
  ariaLabel: string;
  accent: string;
  cycleStartOffset?: number;
  open: boolean;
  onToggle: () => void;
}

function SegmentTrigger<T extends { slug: string; label: string }>({
  selected,
  placeholderItems,
  ariaLabel,
  accent,
  cycleStartOffset = 0,
  open,
  onToggle,
}: SegmentTriggerProps<T>) {
  const [cycleIndex, setCycleIndex] = useState(0);
  const [reduced, setReduced] = useState(false);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const h = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);

  useEffect(() => {
    if (selected || open || reduced || hovered || placeholderItems.length < 2) return;
    const delay = cycleIndex === 0 ? 2400 + cycleStartOffset : 2400;
    const id = setTimeout(() => {
      setCycleIndex((i) => (i + 1) % placeholderItems.length);
    }, delay);
    return () => clearTimeout(id);
  }, [
    cycleIndex,
    selected,
    open,
    reduced,
    hovered,
    placeholderItems.length,
    cycleStartOffset,
  ]);

  const displayed = selected
    ? selected.label
    : placeholderItems[cycleIndex] ?? placeholderItems[0] ?? '';

  const longest = placeholderItems.reduce(
    (a, b) => (b.length > a.length ? b : a),
    placeholderItems[0] ?? ''
  );

  return (
    <button
      type="button"
      onClick={onToggle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label={`${ariaLabel}: ${displayed}. Cambia.`}
      className="group relative inline-flex items-center gap-2 px-4 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-white/40 transition-colors"
      style={{
        color: selected ? accent : 'rgba(250,250,247,0.85)',
        background: open ? 'rgba(250,250,247,0.06)' : 'transparent',
      }}
    >
      {/* width sizer */}
      <span
        aria-hidden
        className="inline-block invisible whitespace-nowrap"
        style={{ height: 0 }}
      >
        {longest}
      </span>
      <span
        className="absolute left-4 right-9 inline-block whitespace-nowrap"
        style={{
          fontStyle: selected ? 'normal' : 'italic',
          top: '50%',
          transform: 'translateY(-50%)',
        }}
        key={displayed}
      >
        {displayed}
      </span>
      <span
        aria-hidden
        className="inline-block transition-transform"
        style={{
          color: 'rgba(250,250,247,0.55)',
          fontSize: '0.7em',
          transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          marginLeft: 'auto',
          position: 'relative',
          zIndex: 1,
        }}
      >
        ▾
      </span>
    </button>
  );
}

function FullWidthMenu({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="listbox"
      data-lenis-prevent
      className="absolute left-0 right-0 caldes-menu-scroll"
      style={{
        bottom: 'calc(100% + 12px)',
        background: 'var(--color-ink)',
        border: '1px solid var(--color-border-inverse)',
        boxShadow: 'var(--color-shadow-elevated)',
        borderRadius: 2,
        zIndex: 60,
        maxHeight: 'min(60vh, 480px)',
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        animation: 'caldes-menu-down 0.3s cubic-bezier(0.22,1,0.36,1)',
      }}
    >
      {children}
    </div>
  );
}

function GridOption({
  active,
  accent,
  onClick,
  children,
}: {
  active: boolean;
  accent: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onClick}
      className="group inline-flex items-center text-left text-sm py-2 px-2 -mx-2 cursor-pointer transition-colors hover:bg-white/[0.04] focus-visible:bg-white/[0.04] outline-none whitespace-nowrap"
      style={{
        color: active ? accent : 'rgba(250,250,247,0.78)',
        fontWeight: active ? 500 : 400,
      }}
    >
      <span
        aria-hidden
        className="inline-block size-1 mr-2 transition-opacity"
        style={{
          background: active ? accent : 'rgba(250,250,247,0.3)',
          opacity: active ? 1 : 0,
        }}
      />
      <span className="group-hover:translate-x-0.5 transition-transform">
        {children}
      </span>
    </button>
  );
}

/* ─── Mobile responsive sheet (Swiss compliance unification 2026-05-09) ─── */

interface MobileMatrixSheetProps {
  service: MatrixService | null;
  profession: MatrixProfession | null;
  services: MatrixService[];
  validProfessions: MatrixProfession[];
  grouped: ReturnType<typeof groupProfessionsByCategory>;
  matrixUrl: string | null;
  onSelectService: (s: MatrixService) => void;
  onSelectProfession: (p: MatrixProfession) => void;
  onClose: () => void;
}

function MobileMatrixSheet({
  service,
  profession,
  services,
  validProfessions,
  grouped,
  matrixUrl,
  onSelectService,
  onSelectProfession,
  onClose,
}: MobileMatrixSheetProps) {
  const t = useTranslations('navigation.morphTicker');
  const sheetRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Focus restoration + initial focus
  useEffect(() => {
    if (typeof window === 'undefined') return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const id = requestAnimationFrame(() => {
      sheetRef.current?.querySelector<HTMLElement>('button')?.focus();
    });
    return () => {
      cancelAnimationFrame(id);
      previousFocusRef.current?.focus?.();
    };
  }, []);

  // Escape closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Focus trap
  useEffect(() => {
    const root = sheetRef.current;
    if (!root) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'button, [href], input, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener('keydown', onKeyDown);
    return () => root.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('label')}
      className="md:hidden fixed inset-0"
      style={{ zIndex: 60 }}
    >
      {/* Scrim */}
      <button
        type="button"
        aria-label={t('dismissLabel')}
        onClick={onClose}
        tabIndex={-1}
        className="absolute inset-0"
        style={{
          background: 'var(--color-scrim)',
          animation: 'caldes-fade-in 200ms ease-out',
        }}
      />

      {/* Sheet */}
      <div
        ref={sheetRef}
        className="absolute inset-x-0 bottom-0 flex flex-col"
        style={{
          background: 'var(--color-ink)',
          color: '#FAFAF7',
          borderTop: '1px solid var(--color-border-inverse)',
          maxHeight: 'min(88vh, 760px)',
          animation: 'caldes-sheet-up 280ms cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4"
          style={{ borderBottom: '1px solid rgba(250, 250, 247, 0.12)' }}
        >
          <span
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: 'rgba(250,250,247,0.55)' }}
          >
            {t('label')}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('dismissLabel')}
            className="inline-flex items-center justify-center w-10 h-10 -mr-2"
            style={{ color: 'rgba(250,250,247,0.7)' }}
          >
            <span aria-hidden style={{ fontSize: '1.4em', lineHeight: 1 }}>
              ×
            </span>
          </button>
        </div>

        {/* Body — vertical stack */}
        <div className="flex-1 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
          {/* Step 1: Service */}
          <section className="px-5 pt-5 pb-4">
            <p
              className="font-mono text-[10px] uppercase tracking-[0.22em] mb-3"
              style={{ color: 'rgba(250,250,247,0.4)' }}
            >
              {t('iNeedCount', { count: services.length })}
            </p>
            <ul role="list" className="flex flex-col">
              {services.map((s) => {
                const active = service?.slug === s.slug;
                return (
                  <li
                    key={s.slug}
                    style={{ borderTop: '1px solid rgba(250,250,247,0.08)' }}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectService(s)}
                      aria-pressed={active}
                      className="w-full flex items-baseline gap-3 py-3 text-left"
                      style={{
                        color: active ? 'var(--color-accent)' : '#FAFAF7',
                        fontWeight: active ? 500 : 400,
                      }}
                    >
                      <span
                        aria-hidden
                        className="inline-block size-1 transition-opacity"
                        style={{
                          background: active ? 'var(--color-accent)' : 'rgba(250,250,247,0.3)',
                          opacity: active ? 1 : 0,
                        }}
                      />
                      <span className="flex-1">{s.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* Step 2: Profession (only if service selected) */}
          {service ? (
            <section
              className="px-5 pt-5 pb-4"
              style={{ borderTop: '1px solid rgba(250,250,247,0.08)' }}
            >
              <p
                className="font-mono text-[10px] uppercase tracking-[0.22em] mb-3"
                style={{ color: 'rgba(250,250,247,0.4)' }}
              >
                {t('forWhomCount', { count: validProfessions.length })}
              </p>
              <div className="flex flex-col gap-5">
                {grouped.map(({ category, items }) => (
                  <div key={category}>
                    <p
                      className="font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
                      style={{ color: 'rgba(250,250,247,0.32)' }}
                    >
                      {category}
                    </p>
                    <ul role="list" className="flex flex-col">
                      {items.map((p) => {
                        const active = profession?.slug === p.slug;
                        return (
                          <li
                            key={p.slug}
                            style={{ borderTop: '1px solid rgba(250,250,247,0.06)' }}
                          >
                            <button
                              type="button"
                              onClick={() => onSelectProfession(p)}
                              aria-pressed={active}
                              className="w-full flex items-baseline gap-3 py-2.5 text-left text-sm"
                              style={{
                                color: active ? '#FAFAF7' : 'rgba(250,250,247,0.78)',
                                fontWeight: active ? 500 : 400,
                              }}
                            >
                              <span
                                aria-hidden
                                className="inline-block size-1"
                                style={{
                                  background: active ? '#FAFAF7' : 'rgba(250,250,247,0.3)',
                                  opacity: active ? 1 : 0,
                                }}
                              />
                              <span className="flex-1 capitalize">{p.label}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>

        {/* Footer CTA */}
        <div
          className="px-5 py-4"
          style={{ borderTop: '1px solid rgba(250,250,247,0.12)' }}
        >
          {matrixUrl ? (
            <Link
              href={matrixUrl}
              prefetch={false}
              onClick={onClose}
              className="w-full inline-flex items-center justify-center gap-2 px-5 py-4 text-xs uppercase tracking-[0.22em]"
              style={{
                background: 'var(--color-accent)',
                color: 'var(--color-accent-ink)',
                fontWeight: 500,
                borderRadius: 2,
              }}
            >
              {t('go')}
              <ArrowRight size={14} weight="regular" aria-hidden />
            </Link>
          ) : (
            <p
              className="text-center text-xs uppercase tracking-[0.18em]"
              style={{ color: 'rgba(250,250,247,0.4)', fontStyle: 'italic' }}
            >
              {service ? t('chooseProfession') : t('chooseService')}
            </p>
          )}
        </div>
      </div>

      <style>{`
        @keyframes caldes-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes caldes-sheet-up {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          [role="dialog"] > * {
            animation: caldes-fade-in 120ms ease-out !important;
            transform: none !important;
          }
        }
      `}</style>
    </div>
  );
}
