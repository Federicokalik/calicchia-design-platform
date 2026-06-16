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
  // NB: glossari migrati sotto /risorse (2026-06-16). seo/e-commerce sono ora
  // bilingui same-slug (/risorse/glossario-* — default pass-through, EN ok);
  // web-design resta IT-only via EN_PATH_DISALLOWED_PREFIXES sotto.
  // Pillar SEO MEDIA/BASSA priorità — bilingual EN content live (segment-translated slugs):
  '/freelance-vs-agenzia-2026',
  '/migrazione-google-analytics-4',
  '/wordpress-vs-headless',
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
  // Glossario Web Design: IT-only (resta tale dopo la migrazione sotto /risorse).
  '/risorse/glossario-web-design',
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

/**
 * Path idonei alla rappresentazione markdown via content negotiation.
 * Esclude portale clienti (privato), /pay (checkout) e il mirror stesso.
 */
function isMarkdownEligible(pathname: string): boolean {
  const parts = pathname.split('/').filter(Boolean);
  const first = parts[0];
  const rest = (LOCALES as readonly string[]).includes(first) ? parts.slice(1) : parts;
  const head = rest[0];
  if (head === 'clienti' || head === 'clients' || head === 'pay') return false;
  if (first === 'md') return false;
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

// Baked-in al build (Dockerfile ARG PUBLIC_SITE_URL → ENV). Fallback locale per
// dev. Usato come base assoluta del redirect a /clienti/login per evitare
// dipendenza da x-forwarded-host (CloudPanel a volte non lo setta o include la
// porta :3000, causando Location: https://calicchia.design:3000/... che il
// browser segue verso una porta non esposta → timeout. Incident 2026-05-29).
const PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL || 'http://localhost:3000';

function redirectToPortalLogin(req: NextRequest, locale: string | null) {
  // localePrefix 'as-needed': IT (default) senza prefix, EN con /en/.
  const prefix = locale && locale !== 'it' ? `/${locale}` : '';
  const loginUrl = new URL(`${prefix}/clienti/login`, PUBLIC_SITE_URL);
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

  // 2.5 Markdown for Agents — content negotiation: `Accept: text/markdown`
  // su una pagina pubblica → rewrite al mirror markdown esistente
  // (`app/md/[[...slug]]/route.ts`, lo stesso che serve gli URL `/<path>.md`
  // via rewrite next.config). Substring match sull'Accept: i q-values sono
  // ignorati, gli agenti reali mandano l'header esplicito. L'header
  // `x-md-source` distingue questa via dal suffisso `.md` nel tracking.
  // Il rewrite NON ri-esegue il middleware → nessun rischio di loop.
  const accept = req.headers.get('accept') ?? '';
  if (
    req.method === 'GET' &&
    accept.includes('text/markdown') &&
    !portal &&
    isMarkdownEligible(pathname)
  ) {
    const url = req.nextUrl.clone();
    url.pathname = pathname === '/' ? '/md' : `/md${pathname}`;
    url.search = '';
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set('x-md-source', 'negotiation');
    const mdRes = NextResponse.rewrite(url, { request: { headers: requestHeaders } });
    mdRes.headers.append('Vary', 'Accept');
    return mdRes;
  }

  // 3. Delega a next-intl
  const res = intlMiddleware(req);

  // Discovery markdown per agenti AI: appende /llms.txt all'header `Link`
  // accanto agli hreflang di next-intl. Qui e non in next.config headers():
  // next-intl fa set() di Link e sovrascriverebbe la entry. Speculare a
  // metadata.alternates.types nel root layout.
  // NB: Vary: Accept sulle risposte HTML non è impostabile — Next sovrascrive
  // il Vary delle pagine con i propri header RSC. Rischio reale ~zero finché
  // Cloudflare non cache-a HTML; la risposta text/markdown il suo Vary ce l'ha.
  res.headers.append(
    'Link',
    '</llms.txt>; rel="alternate"; type="text/markdown"; title="LLM-friendly content index"',
  );

  return res;
}

export const config = {
  matcher: [
    // exclude _next, api, the dynamic OG image route, asset files, well-known
    // crawler endpoints. `/og` is a top-level route handler (outside [locale]) —
    // without this exclusion next-intl would rewrite it to `/it/og` and 404.
    '/((?!_next/|api/|og(?:/|$)|favicon|robots\\.txt|sitemap\\.xml|rss\\.xml|.*\\..*).*)',
  ],
};
