'use client';

import {
  ArrowRight,
  ArrowUpRight,
  Cookie,
  EnvelopeSimple,
  FacebookLogo,
  GithubLogo,
  GitBranch,
  InstagramLogo,
  LinkedinLogo,
  MastodonLogo,
  Phone,
  TelegramLogo,
  UserCircle,
  WhatsappLogo,
} from '@phosphor-icons/react';
import { useLocale, useTranslations } from 'next-intl';
import { type ComponentType, useRef } from 'react';
import { Link } from '@/i18n/navigation';
import { SITE } from '@/data/site';
import { CookieConsentBanner } from '@/components/privacy/CookieConsentBanner';
import { TrustBadge } from '@/components/common/TrustBadge';
import { FooterMap } from './FooterMap';

interface FooterLink {
  label: string;
  href: string;
  counter?: string;
}

const FOOTER_NAV: FooterLink[] = [
  { label: 'Home', href: '/' },
  { label: 'Perché scegliere me', href: '/perche-scegliere-me' },
  { label: 'Portfolio', href: '/lavori', counter: '01' },
  { label: 'Servizi', href: '/servizi' },
  { label: 'Servizi per professioni', href: '/servizi-per-professioni' },
  { label: 'Zone servite', href: '/zone/frosinone' },
  { label: 'Blog', href: '/blog' },
  { label: 'Contatti', href: '/contatti' },
];

const LEGAL_LINKS: FooterLink[] = [
  { label: 'Privacy Policy', href: '/privacy-policy' },
  { label: 'Cookie Policy', href: '/cookie-policy' },
  { label: 'Termini e condizioni', href: '/termini-e-condizioni' },
  { label: 'Richiesta dati personali', href: '/privacy-request' },
  { label: 'Area Clienti', href: '/clienti/login' },
];

type FooterSocial = {
  label: string;
  url: string;
  Icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
};

const SOCIALS: FooterSocial[] = [
  { label: 'Instagram', url: 'https://instagram.com/calicchia.design', Icon: InstagramLogo },
  { label: 'LinkedIn', url: 'https://linkedin.com/in/federicocalicchia', Icon: LinkedinLogo },
  { label: 'GitHub', url: 'https://github.com/Federicokalik/', Icon: GithubLogo },
  { label: 'Gitea', url: 'https://git.calicchia.design/', Icon: GitBranch },
  { label: 'Facebook', url: 'https://facebook.com/calicchiadesign', Icon: FacebookLogo },
  { label: 'Telegram', url: 'https://t.me/calicchiadesign', Icon: TelegramLogo },
  { label: 'WhatsApp', url: 'https://wa.me/393517773467', Icon: WhatsappLogo },
  { label: 'Mastodon', url: 'https://mastodon.uno/@calicchiadesig', Icon: MastodonLogo },
];

function openCookiePreferences() {
  window.__openCookiePreferences?.();
}

export function SiteFooter() {
  // common.json è SPREAD top-level in request.ts → footer è root namespace,
  // non common.footer. Pattern corretto: useTranslations('footer').
  const tFooter = useTranslations('footer');
  const locale = useLocale();
  const tNav = useTranslations('navigation');
  const root = useRef<HTMLElement>(null);
  const year = new Date().getFullYear();
  const hrefFor = (href: string) => href;
  const footerNavLabel = (href: string, fallback: string) =>
    ({
      '/': tNav('nav.home'),
      '/perche-scegliere-me': tNav('nav.percheScegliereMe'),
      '/lavori': tNav('nav.portfolio'),
      '/servizi': tNav('nav.servizi'),
      '/servizi-per-professioni': tNav('nav.serviziPerProfessioni'),
      '/zone/frosinone': tNav('nav.zoneServite'),
      '/blog': tNav('nav.blog'),
      '/contatti': tNav('nav.contatti'),
    })[href] ?? fallback;
  const legalLabel = (href: string, fallback: string) =>
    ({
      '/privacy-policy': tFooter('legal.privacy'),
      '/cookie-policy': tFooter('legal.cookie'),
      '/termini-e-condizioni': tFooter('legal.terms'),
      '/privacy-request': tFooter('legal.request'),
      '/clienti/login': tNav('nav.areaClienti'),
    })[href] ?? fallback;

  return (
    <>
      <footer
        ref={root}
        className="relative mt-16 px-6 pb-8 pt-20 md:px-10 md:pt-28 lg:px-14"
        style={{
          background: 'var(--color-ink)',
          color: 'var(--color-bg)',
          borderTop: '1px solid rgba(250,250,247,0.14)',
        }}
      >
        <div className="mx-auto max-w-[1600px]">
          <div className="grid grid-cols-1 gap-12 lg:grid-cols-12 lg:gap-x-10">
            <nav className="lg:col-span-4" aria-label={tFooter('navigationAriaLabel')}>
              <p
                className="font-mono text-[10px] uppercase tracking-[0.25em]"
                style={{ color: 'rgba(250,250,247,0.48)' }}
              >
                {tFooter('index')}
              </p>
              <ul
                className="mt-7 divide-y"
                style={{
                  borderTop: '1px solid rgba(250,250,247,0.14)',
                  borderColor: 'rgba(250,250,247,0.14)',
                }}
              >
                {FOOTER_NAV.map((item, index) => (
                  <li key={item.href}>
                    <Link
                      href={hrefFor(item.href)}
                      className="group grid grid-cols-[2.5rem_1fr_auto] items-center gap-4 py-4 transition-colors hover:text-[var(--color-accent)]"
                      style={{ color: '#FAFAF7' }}
                    >
                      <span
                        className="font-mono text-xs tabular-nums"
                        style={{ color: 'rgba(250,250,247,0.4)' }}
                      >
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <span
                        className="font-[family-name:var(--font-display)] text-2xl md:text-[1.7rem]"
                        style={{ fontWeight: 500, letterSpacing: '-0.025em', lineHeight: 1 }}
                      >
                        {footerNavLabel(item.href, item.label)}
                      </span>
                      <span className="inline-flex items-center gap-2">
                        {item.counter && (
                          <span
                            className="hidden font-mono text-xs uppercase tracking-[0.18em] md:inline"
                            style={{ color: 'rgba(250,250,247,0.42)' }}
                          >
                            {item.counter}
                          </span>
                        )}
                        <ArrowRight
                          aria-hidden
                          className="transition-transform group-hover:translate-x-1"
                          size={18}
                        />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>

            <section className="flex flex-col lg:col-span-5" aria-labelledby="footer-map-title">
              <p
                id="footer-map-title"
                className="font-mono text-[10px] uppercase tracking-[0.25em]"
                style={{ color: 'rgba(250,250,247,0.48)' }}
              >
                {tFooter('findMe')}
              </p>
              <div className="mt-7 lg:flex-1">
                <FooterMap />
              </div>
            </section>

            <section className="lg:col-span-3" aria-labelledby="footer-contact-title">
              <p
                id="footer-contact-title"
                className="font-mono text-[10px] uppercase tracking-[0.25em]"
                style={{ color: 'rgba(250,250,247,0.48)' }}
              >
                {tNav('nav.contatti')}
              </p>
              <div
                className="mt-7 grid gap-4 border-y py-5 text-sm"
                style={{ borderColor: 'rgba(250,250,247,0.14)', color: 'rgba(250,250,247,0.72)' }}
              >
                <a href={`mailto:${SITE.contact.email}`} className="inline-flex items-center gap-3 hover:text-white">
                  <EnvelopeSimple size={18} aria-hidden />
                  <span>{SITE.contact.email}</span>
                </a>
                <a href={`tel:${SITE.contact.phone.replace(/\s/g, '')}`} className="inline-flex items-center gap-3 hover:text-white">
                  <Phone size={18} aria-hidden />
                  <span>{SITE.contact.phone}</span>
                </a>
                <p>{SITE.contact.address}</p>
                <p style={{ color: 'rgba(250,250,247,0.48)' }}>{SITE.contact.vat}</p>
              </div>

              <div className="mt-8">
                <p
                  className="font-mono text-[10px] uppercase tracking-[0.25em]"
                  style={{ color: 'rgba(250,250,247,0.48)' }}
                >
                  {tFooter('usefulLinks')}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {LEGAL_LINKS.map((item) => (
                    <Link
                      key={item.href}
                      href={hrefFor(item.href)}
                      className="inline-flex min-h-[36px] items-center gap-2 border px-3 py-2 text-xs uppercase tracking-[0.16em] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                      style={{ borderColor: 'rgba(250,250,247,0.16)', color: 'rgba(250,250,247,0.68)' }}
                    >
                      {item.href === '/clienti/login' && <UserCircle size={14} aria-hidden />}
                      {legalLabel(item.href, item.label)}
                    </Link>
                  ))}
                  <button
                    type="button"
                    onClick={openCookiePreferences}
                    className="inline-flex min-h-[36px] items-center gap-2 border px-3 py-2 text-xs uppercase tracking-[0.16em] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                    style={{ borderColor: 'rgba(250,250,247,0.16)', color: 'rgba(250,250,247,0.68)' }}
                  >
                    <Cookie size={14} aria-hidden />
                    {tFooter('manageCookies')}
                  </button>
                </div>
              </div>

              {/* Trustindex badge — integrato nella colonna trust/legal della
                  destra. Il widget è una "white card" hard-coded da Trustindex
                  (lo stile vive nella loro dashboard), quindi qui resta come
                  piccolo timbro di garanzia adiacente ai link legali. */}
              <div className="mt-8">
                <p
                  className="font-mono text-[10px] uppercase tracking-[0.25em]"
                  style={{ color: 'rgba(250,250,247,0.48)' }}
                >
                  {tFooter('reviewsLabel')}
                </p>
                <div className="mt-4">
                  <TrustBadge locale={locale} />
                </div>
              </div>
            </section>
          </div>

          <div className="mt-14 border-t pt-8" style={{ borderColor: 'rgba(250,250,247,0.14)' }}>
            <p
              className="font-mono text-[10px] uppercase tracking-[0.25em]"
              style={{ color: 'rgba(250,250,247,0.48)' }}
            >
              {tFooter('social')}
            </p>
            <div
              className="mt-5 grid grid-cols-2 border-t md:grid-cols-4 xl:grid-cols-8"
              style={{ borderColor: 'rgba(250,250,247,0.14)' }}
            >
              {SOCIALS.map((social) => (
                <a
                  key={social.url}
                  href={social.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex min-h-[62px] items-center justify-between gap-3 border-b px-4 py-4 text-sm transition-colors hover:text-[var(--color-accent)] md:border-r xl:last:border-r-0"
                  style={{ borderColor: 'rgba(250,250,247,0.14)', color: '#FAFAF7' }}
                >
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <social.Icon size={17} aria-hidden />
                    <span className="truncate">{social.label}</span>
                  </span>
                  <ArrowUpRight
                    aria-hidden
                    className="shrink-0 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                    size={15}
                  />
                </a>
              ))}
            </div>
          </div>

          <div
            className="mt-14 flex flex-col gap-3 border-t pt-6 font-mono text-[10px] uppercase tracking-[0.2em] md:flex-row md:items-center md:justify-between"
            style={{ borderColor: 'rgba(250,250,247,0.14)', color: 'rgba(250,250,247,0.42)' }}
          >
            <span>{tFooter('copyrightLine', { year, legalName: SITE.legalName })}</span>
            <span>{tFooter('madeIn')}</span>
          </div>
        </div>
      </footer>
      <CookieConsentBanner />
    </>
  );
}
