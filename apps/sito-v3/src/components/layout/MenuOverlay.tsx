'use client';

import {
  ArrowRight,
  ArrowUpRight,
  CalendarBlank,
  EnvelopeSimple,
  Phone,
} from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { Link } from '@/i18n/navigation';
import { SITE } from '@/data/site';
import { getSocialIcon } from '@/data/social-icons';
import {
  stripLocale,
} from '@/lib/i18n';
import { LanguageSwitcher } from './LanguageSwitcher';

interface MenuOverlayProps {
  open: boolean;
  onClose: () => void;
}

interface NavTag {
  label: string;
  href: string;
}

interface NavEntry {
  label: string;
  href: string;
  meta: string;
  note: string;
  tags?: NavTag[];
}

// SERVICE_TAGS allineato a services.ts (4 matrix + 6 standalone = 10). Modificare qui
// quando si aggiunge/rimuove un servizio in `data/services.ts`. Branding rimosso 2026-05-08.
const SERVICE_TAGS: NavTag[] = [
  { label: 'Web Design', href: '/servizi/web-design' },
  { label: 'E-Commerce', href: '/servizi/e-commerce' },
  { label: 'Sviluppo Web', href: '/servizi/sviluppo-web' },
  { label: 'SEO', href: '/servizi/seo' },
  { label: 'Performance & CWV', href: '/servizi/performance-cwv' },
  { label: 'Accessibilità WCAG', href: '/servizi/accessibility-wcag' },
  { label: 'Analytics & GA4', href: '/servizi/analytics-setup' },
  { label: 'Manutenzione siti', href: '/servizi/manutenzione-siti' },
  { label: 'Assistenza WordPress', href: '/servizi/assistenza-wordpress' },
  { label: 'Migrazione WordPress', href: '/servizi/wordpress-migrazione' },
];

const NAV: NavEntry[] = [
  { label: 'Home', href: '/', meta: '01', note: 'Ingresso' },
  { label: 'Portfolio', href: '/lavori', meta: '02', note: 'Progetti selezionati' },
  {
    label: 'Servizi',
    href: '/servizi',
    meta: '03',
    note: 'Design, codice e crescita',
    tags: SERVICE_TAGS,
  },
  {
    label: 'Perché scegliere me',
    href: '/perche-scegliere-me',
    meta: '04',
    note: 'Metodo e responsabilità',
  },
  { label: 'Blog', href: '/blog', meta: '05', note: 'Journal' },
  { label: 'Contatti', href: '/contatti', meta: '06', note: 'Inizia da qui' },
];

const SECONDARY_LINKS = [
  { label: 'Area Clienti', href: '/clienti/login', description: 'Documenti, file e avanzamento progetto.' },
  { label: 'Servizi per professioni', href: '/servizi-per-professioni', description: 'Landing verticali per categorie e attività.' },
  { label: 'FAQ', href: '/faq', description: 'Dubbi frequenti prima di iniziare.' },
];

function isActivePath(currentPath: string, href: string) {
  if (href === '/') return currentPath === '/';
  return currentPath === href || currentPath.startsWith(`${href}/`);
}

export function MenuOverlay({ open, onClose }: MenuOverlayProps) {
  const t = useTranslations('navigation');
  const root = useRef<HTMLDivElement>(null);
  const hasInteractedRef = useRef(false);
  const pathname = usePathname();
  const prevPathnameRef = useRef(pathname);
  const currentPath = stripLocale(pathname ?? '/');

  useEffect(() => {
    if (!open) return;
    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.body.dataset.menuOpen = 'true';
    return () => {
      document.documentElement.style.overflow = prev;
      delete document.body.dataset.menuOpen;
    };
  }, [open]);

  // Auto-close su pathname change (necessario perché ViewTransitionsBootstrap
  // intercetta i click in capture phase con stopImmediatePropagation, quindi
  // l'`onClick={onClose}` dei Link nel menu non viene mai invocato).
  useEffect(() => {
    if (prevPathnameRef.current !== pathname) {
      prevPathnameRef.current = pathname;
      if (open) onClose();
    }
  }, [pathname, open, onClose]);

  useEffect(() => {
    if (!open) return;
    const dialog = root.current;
    if (!dialog) return;

    const previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const getFocusable = (): HTMLElement[] =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => !el.hasAttribute('aria-hidden') && el.offsetParent !== null);

    const focusTimer = window.setTimeout(() => {
      getFocusable()[0]?.focus();
    }, 90);

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;
      const focusable = getFocusable();
      if (!focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', onKey);
      previousActive?.focus();
    };
  }, [open, onClose]);

  useEffect(() => {
    const dialog = root.current;
    if (!dialog) return;

    if (!open && !hasInteractedRef.current) return;
    if (open) hasInteractedRef.current = true;

    if (open) {
      dialog.style.display = 'block';
      dialog.classList.remove('is-closing');
      const frame = window.requestAnimationFrame(() => {
        dialog.classList.add('is-open');
      });
      return () => window.cancelAnimationFrame(frame);
    } else {
      dialog.classList.remove('is-open');
      dialog.classList.add('is-closing');

      const id = window.setTimeout(() => {
        if (dialog.classList.contains('is-closing')) {
          dialog.style.display = 'none';
          dialog.classList.remove('is-closing');
        }
      }, 180);

      return () => window.clearTimeout(id);
    }
  }, [open]);

  const menuHref = (href: string) => href;
  const navLabel = (href: string, fallback: string) =>
    ({
      '/': t('nav.home'),
      '/lavori': t('nav.portfolio'),
      '/servizi': t('nav.servizi'),
      '/perche-scegliere-me': t('nav.percheScegliereMe'),
      '/blog': t('nav.blog'),
      '/contatti': t('nav.contatti'),
    })[href] ?? fallback;
  const navNote = (href: string, fallback: string) =>
    ({
      '/': t('menuOverlay.notes.home'),
      '/lavori': t('menuOverlay.notes.portfolio'),
      '/servizi': t('menuOverlay.notes.services'),
      '/perche-scegliere-me': t('menuOverlay.notes.why'),
      '/blog': t('menuOverlay.notes.blog'),
      '/contatti': t('menuOverlay.notes.contact'),
    })[href] ?? fallback;
  const secondaryLabel = (href: string, fallback: string) =>
    ({
      '/clienti/login': t('nav.areaClienti'),
      '/servizi-per-professioni': t('nav.serviziPerProfessioni'),
      '/faq': t('nav.faq'),
    })[href] ?? fallback;
  const secondaryDescription = (href: string, fallback: string) =>
    ({
      '/clienti/login': t('menuOverlay.secondary.clientAreaDescription'),
      '/servizi-per-professioni': t('menuOverlay.secondary.professionsDescription'),
      '/faq': t('menuOverlay.secondary.faqDescription'),
    })[href] ?? fallback;
  const serviceTagLabel = (href: string, fallback: string) =>
    ({
      '/servizi/web-design': t('menuOverlay.serviceTags.webDesign'),
      '/servizi/e-commerce': t('menuOverlay.serviceTags.eCommerce'),
      '/servizi/sviluppo-web': t('menuOverlay.serviceTags.webDevelopment'),
      '/servizi/seo': t('menuOverlay.serviceTags.seo'),
      '/servizi/performance-cwv': t('menuOverlay.serviceTags.performance'),
      '/servizi/accessibility-wcag': t('menuOverlay.serviceTags.accessibility'),
      '/servizi/analytics-setup': t('menuOverlay.serviceTags.analytics'),
      '/servizi/manutenzione-siti': t('menuOverlay.serviceTags.maintenance'),
      '/servizi/assistenza-wordpress': t('menuOverlay.serviceTags.wordpressSupport'),
      '/servizi/wordpress-migrazione': t('menuOverlay.serviceTags.wordpressMigration'),
    })[href] ?? fallback;

  return (
    /*
     * Swiss compliance audit 2026-05-09: `fixed inset-0` formalizzato come
     * ECCEZIONE MODALE FUNZIONALE (decisione utente). role=dialog + aria-modal
     * + focus trap + Escape close + body scroll lock = pattern modal standard.
     * "fixed consentiti solo per modali funzionali e CTA/finder bottom-right"
     * (Master report).
     */
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-hidden={!open}
      aria-label={t('menuOverlay.ariaLabel')}
      className="fixed inset-0"
      style={{
        display: 'none',
        zIndex: 80,
        background: 'var(--color-ink)',
        color: '#FAFAF7',
      }}
    >
      <style>{`
        .caldes-menu-overlay-scroll::-webkit-scrollbar { display: none; width: 0; height: 0; }
      `}</style>
      <div
        data-lenis-prevent
        className="caldes-menu-overlay-scroll absolute inset-0 overflow-y-auto"
        style={{
          overscrollBehavior: 'contain',
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
        }}
      >
        <div className="grid min-h-[100dvh] grid-cols-1 lg:grid-cols-[minmax(0,1.52fr)_minmax(340px,0.72fr)]">
          <div data-band="left" className="caldes-menu-band">
            <div className="flex flex-col px-6 pb-12 pt-28 md:px-10 md:pt-32 lg:px-14">
              <div className="mb-6 flex items-center justify-between gap-4 md:mb-8">
                <p
                  data-menu-meta
                  className="font-mono text-[10px] uppercase tracking-[0.26em]"
                  style={{ color: 'rgba(250,250,247,0.46)' }}
                >
                  {t('menuOverlay.metaCount', { count: String(NAV.length).padStart(2, '0') })}
                </p>
                <LanguageSwitcher variant="dark" />
              </div>

              <nav aria-label={t('menuOverlay.mainNavAriaLabel')} className="flex-1">
                <ul className="divide-y" style={{ borderTop: '1px solid rgba(250,250,247,0.12)', borderColor: 'rgba(250,250,247,0.12)' }}>
                  {NAV.map((item) => {
                    const active = isActivePath(currentPath, item.href);
                    return (
                  <li key={item.href} className="py-2.5 md:py-3">
                        <div className="grid grid-cols-[2.75rem_1fr] gap-4 md:grid-cols-[4rem_1fr_13rem] md:items-baseline">
                          <span
                            data-menu-meta
                            className="font-mono text-xs tabular-nums"
                            style={{ color: active ? 'var(--color-accent)' : 'rgba(250,250,247,0.38)' }}
                          >
                            {item.meta}
                          </span>
                          <div className="overflow-hidden" style={{ paddingBottom: '0.18em' }}>
                            <Link
                              data-menu-link
                              href={menuHref(item.href)}
                              onClick={onClose}
                              className="group inline-flex max-w-full items-baseline gap-3 font-[family-name:var(--font-display)] transition-colors hover:text-[var(--color-accent)]"
                              style={{
                                color: active ? 'var(--color-accent)' : '#FAFAF7',
                                fontSize: 'clamp(2.15rem, 4.65vw, 5.1rem)',
                                fontWeight: 500,
                                letterSpacing: '-0.045em',
                                lineHeight: 1.0,
                              }}
                            >
                              <span>{navLabel(item.href, item.label)}</span>
                              <ArrowRight
                                aria-hidden
                                className="hidden shrink-0 transition-transform group-hover:translate-x-1 md:block"
                                size={32}
                                weight="regular"
                              />
                            </Link>
                          </div>
                          <p
                            data-menu-meta
                            className="col-start-2 text-xs uppercase tracking-[0.16em] md:col-start-auto"
                            style={{ color: 'rgba(250,250,247,0.44)' }}
                          >
                            {navNote(item.href, item.note)}
                          </p>
                        </div>

                        {item.tags && (
                          <div className="ml-[4.75rem] mt-3 flex max-w-[850px] flex-wrap gap-2 md:ml-[5rem]">
                            {item.tags.map((tag) => (
                              <Link
                                key={tag.href}
                                data-menu-tag
                                href={menuHref(tag.href)}
                                onClick={onClose}
                                className="inline-flex min-h-[34px] items-center border px-3 py-2 text-[11px] uppercase tracking-[0.16em] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                                style={{
                                  borderColor: 'rgba(250,250,247,0.16)',
                                  color: 'rgba(250,250,247,0.68)',
                                }}
                              >
                                {serviceTagLabel(tag.href, tag.label)}
                              </Link>
                            ))}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </nav>
            </div>
          </div>

          <aside
            data-band="right"
            className="caldes-menu-band border-t lg:border-l lg:border-t-0"
            style={{ borderColor: 'rgba(250,250,247,0.12)', background: '#11110F' }}
          >
            <div className="flex flex-col px-6 pb-12 pt-8 md:px-10 lg:px-10 lg:pt-32">
              <div data-menu-panel className="border-y py-6" style={{ borderColor: 'rgba(250,250,247,0.14)' }}>
                <div className="flex items-center gap-3">
                  <CalendarBlank size={22} weight="regular" aria-hidden />
                  <p className="font-mono text-[10px] uppercase tracking-[0.24em]" style={{ color: 'rgba(250,250,247,0.5)' }}>
                    {t('menuOverlay.consultationMeta')}
                  </p>
                </div>
                <h2
                  className="mt-5 font-[family-name:var(--font-display)] text-4xl leading-none md:text-5xl"
                  style={{ fontWeight: 500, letterSpacing: '-0.035em' }}
                >
                  {t('menuOverlay.consultationTitle')}
                </h2>
                <p className="mt-5 max-w-[36ch] text-sm leading-relaxed" style={{ color: 'rgba(250,250,247,0.66)' }}>
                  {t('menuOverlay.consultationText')}
                </p>
                <Link
                  href={menuHref(SITE.contact.cal)}
                  onClick={onClose}
                  className="mt-7 inline-flex min-h-[44px] items-center gap-3 border px-5 py-3 text-xs font-medium uppercase tracking-[0.18em] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-ink)]"
                  style={{ borderColor: 'rgba(250,250,247,0.28)', color: '#FAFAF7' }}
                >
                  {t('menuOverlay.chooseTime')}
                  <ArrowRight size={16} weight="regular" aria-hidden />
                </Link>
              </div>

              <div data-menu-panel className="border-b py-6" style={{ borderColor: 'rgba(250,250,247,0.14)' }}>
                <p className="font-mono text-[10px] uppercase tracking-[0.24em]" style={{ color: 'rgba(250,250,247,0.5)' }}>
                  {t('menuOverlay.quickPaths')}
                </p>
                <div className="mt-5 divide-y" style={{ borderTop: '1px solid rgba(250,250,247,0.1)', borderColor: 'rgba(250,250,247,0.1)' }}>
                  {SECONDARY_LINKS.map((link) => (
                    <Link
                      key={link.href}
                      href={menuHref(link.href)}
                      onClick={onClose}
                      className="group grid grid-cols-[1fr_auto] gap-4 py-4 transition-colors hover:text-[var(--color-accent)]"
                      style={{ color: '#FAFAF7' }}
                    >
                      <span>
                        <span className="block font-[family-name:var(--font-display)] text-xl" style={{ fontWeight: 500, letterSpacing: '-0.015em' }}>
                          {secondaryLabel(link.href, link.label)}
                        </span>
                        <span className="mt-1 block text-sm leading-relaxed" style={{ color: 'rgba(250,250,247,0.54)' }}>
                          {secondaryDescription(link.href, link.description)}
                        </span>
                      </span>
                      <ArrowUpRight
                        aria-hidden
                        className="mt-1 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                        size={18}
                        weight="regular"
                      />
                    </Link>
                  ))}
                </div>
              </div>

              <div data-menu-panel className="mt-auto pt-6">
                <p className="font-mono text-[10px] uppercase tracking-[0.24em]" style={{ color: 'rgba(250,250,247,0.5)' }}>
                  {t('menuOverlay.studio')}
                </p>
                <div className="mt-4 grid gap-3 text-sm" style={{ color: 'rgba(250,250,247,0.74)' }}>
                  <a href={`mailto:${SITE.contact.email}`} className="inline-flex items-center gap-3 hover:text-white">
                    <EnvelopeSimple size={18} aria-hidden />
                    <span>{SITE.contact.email}</span>
                  </a>
                  <a href={`tel:${SITE.contact.phone.replace(/\s/g, '')}`} className="inline-flex items-center gap-3 hover:text-white">
                    <Phone size={18} aria-hidden />
                    <span>{SITE.contact.phone}</span>
                  </a>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-3 pt-2">
                    {SITE.social.map((s) => {
                      const Icon = getSocialIcon(s.icon);
                      return (
                        <a
                          key={s.url}
                          href={s.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={s.label}
                          title={s.label}
                          className="inline-flex items-center justify-center w-9 h-9 transition-opacity hover:opacity-100"
                          style={{ color: 'rgba(250,250,247,0.74)', opacity: 0.74 }}
                        >
                          <Icon size={20} weight="regular" aria-hidden />
                        </a>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
