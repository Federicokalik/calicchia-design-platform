import { NextResponse, type NextRequest } from 'next/server';

const API_BASE = (
  process.env.NEXT_PUBLIC_API_URL ??
  process.env.PORTAL_API_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');

interface RouteParams {
  params: Promise<{ locale: string }>;
}

/**
 * Magic-link verifier — receives ?token=<plaintext> from the email link,
 * exchanges it server-side at the API, forwards the Set-Cookie containing
 * the portal JWT, and 307-redirects to /clienti/dashboard.
 *
 * Same pattern as /clienti/p/[code] — Route Handler is the only context
 * in Next 16 where we can both set cookies AND issue a redirect.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { locale } = await params;
  const token = request.nextUrl.searchParams.get('token')?.trim() ?? '';

  const dashboardUrl = new URL(`/${locale}/clienti/dashboard`, request.url);
  const loginUrl = new URL(`/${locale}/clienti/login`, request.url);

  if (!token) {
    loginUrl.searchParams.set('error', 'invalid_link');
    return NextResponse.redirect(loginUrl);
  }

  const apiRes = await fetch(`${API_BASE}/api/portal/exchange-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
    cache: 'no-store',
  }).catch(() => null);

  if (!apiRes || !apiRes.ok) {
    loginUrl.searchParams.set('error', 'invalid_link');
    return NextResponse.redirect(loginUrl);
  }

  const response = NextResponse.redirect(dashboardUrl);

  // Forward Set-Cookie header(s) from API (the portal_token JWT lives here).
  const getSetCookie =
    (apiRes.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.bind(
      apiRes.headers
    ) ??
    (() => {
      const single = apiRes.headers.get('set-cookie');
      return single ? [single] : [];
    });
  for (const cookie of getSetCookie()) {
    response.headers.append('Set-Cookie', cookie);
  }

  return response;
}
