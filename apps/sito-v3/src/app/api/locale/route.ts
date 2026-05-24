import { NextResponse, type NextRequest } from 'next/server';
import { isLocale } from '@/lib/i18n';

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Locale switch endpoint — set-cookie server-side + redirect a `next`.
 *
 * Usato dal LanguageSwitcher per evitare race condition tra cookie client-side
 * (`document.cookie = ...`) e middleware locale detection: il cookie scritto dal
 * server con Set-Cookie header è committed prima del 302 follow-up, quindi
 * proxy.ts vede il valore aggiornato e non re-redirige.
 *
 * Path `/api/*` è escluso dal middleware matcher, quindi questa rotta non passa
 * per next-intl localeDetection — pure cookie-set + redirect, niente magia.
 */
export function GET(req: NextRequest) {
  const url = new URL(req.url);
  const to = url.searchParams.get('to') ?? undefined;
  const nextParam = url.searchParams.get('next') ?? '/';

  if (!isLocale(to)) {
    return NextResponse.json({ error: 'invalid locale' }, { status: 400 });
  }

  // Sanitizza `next`: deve essere un path interno (no scheme, no host esterni)
  // per evitare open-redirect.
  const safeNext = nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '/';

  // Location relativa (path-only): il browser la risolve contro l'URL della
  // request, quindi il redirect punta sempre all'origin pubblico che il client
  // sta effettivamente vedendo. Evitiamo `new URL(safeNext, req.url)` perché
  // in standalone dietro reverse-proxy `req.url` può contenere l'host interno
  // del container (HOSTNAME=0.0.0.0:3000) e finire come Location assoluta che
  // butta l'utente fuori dal dominio pubblico.
  const response = new NextResponse(null, {
    status: 307,
    headers: { Location: safeNext },
  });
  response.cookies.set('NEXT_LOCALE', to, {
    path: '/',
    maxAge: COOKIE_MAX_AGE,
    sameSite: 'lax',
    // Defence in depth: a 1-year persistent preference cookie should not be
    // transmittable over plain HTTP. `Secure` is also valid on localhost per
    // browser spec since 2017, so dev keeps working.
    secure: true,
  });
  // Blocca cache del redirect (browser, CDN, RSC prefetch) — il client deve
  // sempre eseguire il flow Set-Cookie → redirect senza riusare risposte stale.
  response.headers.set('Cache-Control', 'no-store, must-revalidate');
  return response;
}
