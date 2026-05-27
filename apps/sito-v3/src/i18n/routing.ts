import { defineRouting } from 'next-intl/routing';
import { LOCALES, DEFAULT_LOCALE } from '@/lib/i18n';

/**
 * next-intl routing config — single source of truth per locale + URL strategy.
 *
 * - localePrefix 'as-needed': IT senza prefix, EN con `/en/...`.
 * - localeDetection FALSE: il middleware NON auto-redirige in base ad
 *   Accept-Language né auto-aggiorna il cookie su navigation. Il cookie
 *   NEXT_LOCALE è settato SOLO via /api/locale (LanguageSwitcher), così
 *   visitare /en/<x> non override la scelta IT dell'utente. Trade-off:
 *   utenti EN su prima visita vedono IT, devono cliccare lo switcher.
 *   Decisione 2026-05-09 dopo bug: localeDetection true causa cookie-flip
 *   ad ogni navigation cross-locale → la home / re-redirige a /en.
 * - localeCookie persistente 1 anno (settato dal switcher endpoint).
 * - pathnames: mapping IT canonical → EN translated per URL search-friendly.
 *   Filesystem resta IT-canonical (app/[locale]/(site)/lavori/page.tsx);
 *   next-intl rewrita internamente `/en/works` → `/en/lavori` per matching.
 *
 * Compatibilità: i path EN-not-available sono filtrati via middleware
 * EN-availability route guard (404 invece di fallback IT su URL EN).
 *
 * Path NON listati in pathnames → stesso slug nei due locale (es. /blog,
 * /web-design-freelance, /freelance-web-designer-italy, ecc.).
 */
/**
 * NOTE: solo path STATICI sono inclusi. Template dinamici (`/servizi/[slug]`,
 * `/lavori/[slug]`) sono volutamente esclusi: con typed pathnames next-intl
 * richiede il form `<Link href={{pathname, params}}>` per template dinamici, e
 * la maggior parte dei componenti usa string href runtime-built (es.
 * `/servizi/${slug}`). Compromesso: detail page restano `/en/servizi/<slug>`
 * (segment IT) ma gli slug stessi sono già EN-friendly (web-design, e-commerce,
 * seo, ecc.).
 *
 * Per tradurre anche detail pages: refactor incrementale dei call-site a
 * `<Link href={{pathname: '/servizi/[slug]', params: {slug}}}>` poi reintrodurre
 * le entry dinamiche qui.
 */
export const PATHNAMES = {
  '/': '/',
  '/lavori': { it: '/lavori', en: '/works' },
  '/lavori/[slug]': { it: '/lavori/[slug]', en: '/works/[slug]' },
  '/servizi': { it: '/servizi', en: '/services' },
  '/servizi/[slug]': { it: '/servizi/[slug]', en: '/services/[slug]' },
  '/servizi-per-professioni': {
    it: '/servizi-per-professioni',
    en: '/services-by-profession',
  },
  '/contatti': { it: '/contatti', en: '/contact' },
  '/perche-scegliere-me': {
    it: '/perche-scegliere-me',
    en: '/why-choose-me',
  },
  // Pillar SEO MEDIA/BASSA priorità — bilingual content with translated slugs
  '/freelance-vs-agenzia-2026': {
    it: '/freelance-vs-agenzia-2026',
    en: '/freelance-vs-agency-2026',
  },
  '/migrazione-google-analytics-4': {
    it: '/migrazione-google-analytics-4',
    en: '/google-analytics-4-migration',
  },
  '/glossario-seo': {
    it: '/glossario-seo',
    en: '/seo-glossary',
  },
  '/glossario-e-commerce': {
    it: '/glossario-e-commerce',
    en: '/e-commerce-glossary',
  },
  // wordpress-vs-headless: same slug both locales (already EN-friendly), no entry needed
  // Portal area — segment-translated URLs (clienti→clients, progetti→projects, ecc.).
  // Filesystem resta IT-canonical in app/[locale]/(portal)/clienti/*, next-intl
  // rewrita /en/clients/projects → /en/clienti/progetti per matching.
  '/clienti/login': { it: '/clienti/login', en: '/clients/sign-in' },
  '/clienti/dashboard': { it: '/clienti/dashboard', en: '/clients/dashboard' },
  '/clienti/progetti': { it: '/clienti/progetti', en: '/clients/projects' },
  '/clienti/progetti/[id]': {
    it: '/clienti/progetti/[id]',
    en: '/clients/projects/[id]',
  },
  '/clienti/file': { it: '/clienti/file', en: '/clients/files' },
  '/clienti/upload': { it: '/clienti/upload', en: '/clients/upload' },
  '/clienti/investimento': { it: '/clienti/investimento', en: '/clients/billing' },
  '/clienti/rinnovi': { it: '/clienti/rinnovi', en: '/clients/renewals' },
  '/clienti/preferenze': { it: '/clienti/preferenze', en: '/clients/preferences' },
  '/preferenze/[token]': { it: '/preferenze/[token]', en: '/preferences/[token]' },
  '/clienti/report': { it: '/clienti/report', en: '/clients/reports' },
  '/clienti/report/[id]': {
    it: '/clienti/report/[id]',
    en: '/clients/reports/[id]',
  },
  '/clienti/p/[code]': { it: '/clienti/p/[code]', en: '/clients/p/[code]' },
  '/clienti/logout': { it: '/clienti/logout', en: '/clients/logout' },
  // Portal sections previously missing from PATHNAMES (audit B-012). Without
  // these entries EN users navigating /clienti/<x> would mix IT + EN segments
  // in the same session and Links resolved with IT slugs even under /en.
  '/clienti/fatture': { it: '/clienti/fatture', en: '/clients/invoices' },
  '/clienti/fatture/[id]': {
    it: '/clienti/fatture/[id]',
    en: '/clients/invoices/[id]',
  },
  '/clienti/abbonamenti': { it: '/clienti/abbonamenti', en: '/clients/subscriptions' },
  '/clienti/accettazione-legale': {
    it: '/clienti/accettazione-legale',
    en: '/clients/legal-acceptance',
  },
  '/clienti/pagamento/successo': {
    it: '/clienti/pagamento/successo',
    en: '/clients/payment/success',
  },
  '/clienti/pagamento/annullato': {
    it: '/clienti/pagamento/annullato',
    en: '/clients/payment/cancelled',
  },
  '/clienti/auth/verify': { it: '/clienti/auth/verify', en: '/clients/auth/verify' },
} as const;

export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: 'as-needed',
  localeDetection: false,
  localeCookie: {
    name: 'NEXT_LOCALE',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  },
  pathnames: PATHNAMES,
});
