import createMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';
import { LOCALES, canonicalItPath } from '@/lib/i18n';
import { routing } from '@/i18n/routing';

const PORTAL_COOKIE_NAME = 'portal_token';

/**
 * EN-availability allow-list — paths che hanno una versione EN tradotta.
 * Quando F3 implementa traduzioni macro-page, sposta path da DISALLOWED a ENABLED.
 */
const EN_PATH_PREFIXES_ENABLED = [
  '/',
  '/lavori',
  '/servizi',
  '/blog',
  '/contatti',
  '/perche-scegliere-me',
  '/web-design-freelance',
  '/web-design-vs-agenzia',
  '/glossario-web-design',
  // Pillar SEO MEDIA/BASSA priorità — bilingual EN content live (segment-translated slugs):
  '/freelance-vs-agenzia-2026',
  '/migrazione-google-analytics-4',
  '/wordpress-vs-headless',
  '/glossario-seo',
  '/glossario-e-commerce',
  // Pillar SEO ALTA priorità — bilingual EN content live (slug uguale IT/EN):
  '/web-designer-vs-developer',
  '/european-accessibility-act-2025',
  '/core-web-vitals-audit',
  // EN-only local pillar:
  '/freelance-web-designer-italy',
  '/english-speaking-web-designer-italy',
  '/italian-web-designer-for-european-business',
  // EN-only Canada-target pillar:
  '/freelance-web-designer-canada',
  '/freelance-web-designer-toronto-gta',
  // EN-only Italian-Canadian vertical pillar:
  '/italian-businesses-toronto-website-design',
  '/italian-restaurants-website-design',
];

const EN_PATH_DISALLOWED_PREFIXES = [
  // Pillar IT-only locale/geo (chi cerca "ciociaria" o "frosinone" in EN: nessuno)
  '/web-design-freelance-ciociaria',
  '/sito-web-per-pmi',
  '/zone',
  '/servizi-per-professioni',
  '/quanto-costa-sito-web',
  // Legal IT-only (giurisdizione)
  '/privacy-policy',
  '/cookie-policy',
  '/termini-e-condizioni',
  '/privacy-request',
  '/faq',
  // Booking IT-only MVP
  '/prenota',
  '/prenotazione',
  // NB: /clienti rimosso da DISALLOWED. Next-intl localeDetection redirect i
  // browser EN su /en/clienti/* → bloccarlo causerebbe 404 al login. Portal
  // content è IT-only (deferred Phase 2 traduzione full), ma le route devono
  // rispondere 200. Robots.txt continua a disallow /en/clienti per crawler.
];

function isEnPathAvailable(pathname: string): boolean {
  // Normalizza URL EN (es. /en/works/foo) a canonical IT (/lavori/foo) per
  // confronto contro le allow/deny list (che usano canonical IT).
  const path = canonicalItPath(pathname);

  // Disallowed prefix → false
  for (const prefix of EN_PATH_DISALLOWED_PREFIXES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return false;
  }

  // Matrix path catch-all: i path con pattern `<service-prefix>-<profession>`
  // (es. `/web-design-per-dentista`) sono IT-only.
  if (/-per-/.test(path) && !EN_PATH_PREFIXES_ENABLED.some((p) => path === p || path.startsWith(`${p}/`))) {
    return false;
  }

  // Enabled prefix → true
  for (const prefix of EN_PATH_PREFIXES_ENABLED) {
    if (prefix === '/' && path === '/') return true;
    if (prefix !== '/' && (path === prefix || path.startsWith(`${prefix}/`))) return true;
  }

  // Default: pass-through (DB-driven /lavori/[slug], /blog/[anno]/[mese]/[slug],
  // /servizi/[slug] — il page-level component decide il fallback).
  return true;
}

function getPortalMatch(pathname: string) {
  const parts = pathname.split('/').filter(Boolean);
  const first = parts[0];
  const hasLocale = (LOCALES as readonly string[]).includes(first);
  const clientIndex = hasLocale ? 1 : 0;

  if (parts[clientIndex] !== 'clienti') return null;

  return {
    locale: hasLocale ? first : null,
    portalPath: parts.slice(clientIndex + 1),
  };
}

function isPublicPortalPath(portalPath: string[]) {
  const [first] = portalPath;
  return first === 'login' || first === 'logout' || first === 'p';
}

function redirectToPortalLogin(req: NextRequest, locale: string | null) {
  const url = req.nextUrl.clone();
  const prefix = locale ? `/${locale}` : '';
  url.pathname = `${prefix}/clienti/login`;
  url.search = '';
  url.searchParams.set('next', req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

const intlMiddleware = createMiddleware(routing);

/**
 * Middleware composito:
 *   1. Portal auth check (priorità — se non autenticato, redirect a login senza
 *      passare per next-intl).
 *   2. EN-availability route guard (404 per `/en/<path-it-only>` invece di
 *      fallback IT — evita duplicate content cross-lang).
 *   3. next-intl middleware: gestisce locale routing, Accept-Language detection,
 *      cookie NEXT_LOCALE, redirect 302 a locale preferito su prima visita.
 */
export default function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const portal = getPortalMatch(pathname);

  // 1. Portal auth check
  if (portal && !isPublicPortalPath(portal.portalPath)) {
    const token = req.cookies.get(PORTAL_COOKIE_NAME)?.value;
    if (!token) return redirectToPortalLogin(req, portal.locale);
  }

  // 2. EN-availability route guard
  const seg = pathname.split('/')[1];
  if (seg === 'en' && !isEnPathAvailable(pathname)) {
    return new NextResponse(null, { status: 404 });
  }

  // 3. Delega a next-intl
  return intlMiddleware(req);
}

export const config = {
  matcher: [
    // exclude _next, api, asset files, well-known crawler endpoints
    '/((?!_next/|api/|favicon|robots\\.txt|sitemap\\.xml|rss\\.xml|.*\\..*).*)',
  ],
};
