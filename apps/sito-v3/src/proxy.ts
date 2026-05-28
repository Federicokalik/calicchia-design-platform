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
  // NB: /servizi-per-professioni rimosso (2026-05-15) — l'hub è ora bilingual,
  // EN serve come /en/services-by-profession via PATHNAMES rewrite.
  '/quanto-costa-sito-web',
  // NB (2026-05-15): /privacy-policy, /cookie-policy, /termini-e-condizioni,
  // /privacy-request, /faq, /prenota, /prenotazione rimossi da DISALLOWED.
  // Devono esistere anche su EN (traduzioni deferred Phase 2). Pattern come
  // /clienti: route risponde 200 con IT fallback, robots.txt disallow nasconde
  // ai crawler finché la traduzione non è pubblicata.
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

  // Matrix + città pattern: /<service>-{per|for}-<profession>-a-<city> è IT-only
  // (le rotte città sono geo-IT, decisione utente 2026-05-15). Le matrix
  // profession-only (/sito-web-per-avvocati, /en/website-for-lawyers) restano
  // EN-accessible. Match: include "-per-" OR "-for-" AND "-a-".
  if (/-(per|for)-/.test(path) && /-a-/.test(path)) {
    return false;
  }

  // NOTA: il catch-all matrix `/<service>-per-<professione>` è stato rimosso
  // (decisione 2026-05-15). Solo le route geo-locali ("/zone", "/sito-web-per-pmi",
  // "/web-design-freelance-ciociaria") restano bloccate in EN — le matrix pages
  // servizio×professione (/sito-web-per-avvocati, /e-commerce-per-dentisti, ecc.)
  // sono accessibili su EN per coerenza col selettore matrix tradotto.

  // Enabled prefix → true
  for (const prefix of EN_PATH_PREFIXES_ENABLED) {
    if (prefix === '/' && path === '/') return true;
    if (prefix !== '/' && (path === prefix || path.startsWith(`${prefix}/`))) return true;
  }

  // Default: pass-through (DB-driven /lavori/[slug], /blog/[anno]/[mese]/[slug],
  // /servizi/[slug], matrix /<service>-per-<prof> — il page-level component
  // decide il fallback).
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
  const prefix = locale ? `/${locale}` : '';

  // Incident 2026-05-28: la versione precedente faceva
  //   new NextResponse(null, { status: 307, headers: { Location: '/clienti/login?next=...' } })
  // con path RELATIVO. Next.js 16 core processa ogni middleware Response e
  // chiama `new NextURL(Location)` per riscriverla — fallisce con
  // ERR_INVALID_URL su path relativi senza base, crashando ogni accesso non
  // autenticato a /clienti/* con 500.
  //
  // Fix: costruiamo un URL ASSOLUTO clonando req.nextUrl, e onoriamo
  // x-forwarded-host/proto per non leakare la porta interna :3000 dietro
  // CloudPanel/reverse proxy (motivo del commento "path-only Location" prima).
  const loginUrl = req.nextUrl.clone();
  const fwdHost = req.headers.get('x-forwarded-host');
  if (fwdHost) {
    loginUrl.host = fwdHost;
    loginUrl.port = '';
  }
  const fwdProto = req.headers.get('x-forwarded-proto');
  if (fwdProto) loginUrl.protocol = fwdProto;
  loginUrl.pathname = `${prefix}/clienti/login`;
  loginUrl.search = `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;

  return NextResponse.redirect(loginUrl, 307);
}

const intlMiddleware = createMiddleware(routing);

function getPortalJwtSecret(): Uint8Array | null {
  const secret = process.env.JWT_SECRET;
  return secret ? new TextEncoder().encode(secret) : null;
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeBase64UrlJson(value: string): Record<string, unknown> | null {
  try {
    const bytes = base64UrlToBytes(value);
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function hasValidPortalToken(token: string): Promise<boolean> {
  const secret = getPortalJwtSecret();
  if (!secret) return false;

  try {
    const [encodedHeader, encodedPayload, encodedSignature, extra] = token.split('.');
    if (!encodedHeader || !encodedPayload || !encodedSignature || extra) return false;

    const header = decodeBase64UrlJson(encodedHeader);
    const payload = decodeBase64UrlJson(encodedPayload);
    if (!payload) return false;
    if (header?.alg !== 'HS256' || (header?.typ && header.typ !== 'JWT')) return false;

    const key = await crypto.subtle.importKey(
      'raw',
      secret,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const validSignature = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlToBytes(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
    );
    if (!validSignature) return false;

    const exp = typeof payload?.exp === 'number' ? payload.exp : null;
    if (!exp || exp <= Math.floor(Date.now() / 1000)) return false;

    return payload.role === 'client' || payload.role === 'collaborator';
  } catch {
    return false;
  }
}

function clearPortalCookie(response: NextResponse) {
  response.cookies.delete(PORTAL_COOKIE_NAME);
  const cookieDomain = process.env.COOKIE_DOMAIN;
  if (cookieDomain) {
    response.cookies.set(PORTAL_COOKIE_NAME, '', {
      domain: cookieDomain,
      path: '/',
      maxAge: 0,
    });
  }
}

/**
 * Middleware composito:
 *   1. Portal auth check (priorità — se non autenticato, redirect a login senza
 *      passare per next-intl).
 *   2. EN-availability route guard (404 per `/en/<path-it-only>` invece di
 *      fallback IT — evita duplicate content cross-lang).
 *   3. next-intl middleware: gestisce locale routing, Accept-Language detection,
 *      cookie NEXT_LOCALE, redirect 302 a locale preferito su prima visita.
 */
export default async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const portal = getPortalMatch(pathname);

  // 1. Portal auth check
  if (portal && !isPublicPortalPath(portal.portalPath)) {
    const token = req.cookies.get(PORTAL_COOKIE_NAME)?.value;
    if (!token) return redirectToPortalLogin(req, portal.locale);
    if (!(await hasValidPortalToken(token))) {
      const response = redirectToPortalLogin(req, portal.locale);
      clearPortalCookie(response);
      return response;
    }
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
