import { NextResponse, type NextRequest } from 'next/server';

const API_BASE = (
  process.env.NEXT_PUBLIC_API_URL ??
  process.env.PORTAL_API_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');

const PORTAL_COOKIE_NAME = 'portal_token';

interface RouteParams {
  params: Promise<{ locale: string }>;
}

/**
 * Logout handler — Route Handler (NOT a page) because cookies() mutation
 * (.delete / .set) is only allowed in Server Actions or Route Handlers,
 * not during page render in Next 16. The previous page.tsx version
 * crashed with "Cookies can only be modified in a Server Action or
 * Route Handler".
 *
 * Flow:
 *   1. Forward portal_token cookie to API /api/portal/logout (best-effort)
 *   2. Mirror any Set-Cookie headers from API response into our response
 *   3. Clear the portal_token cookie locally as belt-and-braces
 *   4. 307 redirect to /clienti/login (locale prefix preserved by browser)
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { locale } = await params;

  const cookieHeader = request.headers.get('cookie') ?? '';
  const apiRes = await fetch(`${API_BASE}/api/portal/logout`, {
    method: 'POST',
    headers: cookieHeader ? { Cookie: cookieHeader } : undefined,
    cache: 'no-store',
  }).catch(() => null);

  const loginUrl = new URL(`/${locale}/clienti/login`, request.url);
  const response = NextResponse.redirect(loginUrl);

  // Forward any Set-Cookie from API (typically the API clears its own token).
  if (apiRes) {
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
  }

  // Belt-and-braces: clear the cookie locally even if the API call failed.
  response.cookies.set(PORTAL_COOKIE_NAME, '', {
    path: '/',
    maxAge: 0,
    httpOnly: true,
    sameSite: 'lax',
  });

  return response;
}
