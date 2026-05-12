import { NextResponse, type NextRequest } from 'next/server';

const API_BASE = (
  process.env.NEXT_PUBLIC_API_URL ??
  process.env.PORTAL_API_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');

interface RouteParams {
  params: Promise<{ locale: string; code: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { locale, code } = await params;
  const decodedCode = decodeURIComponent(code).trim();

  const dashboardUrl = new URL(`/${locale}/clienti/dashboard`, request.url);
  const loginUrl = new URL(`/${locale}/clienti/login`, request.url);

  if (!decodedCode) {
    loginUrl.searchParams.set('error', 'invalid_code');
    return NextResponse.redirect(loginUrl);
  }

  const apiRes = await fetch(`${API_BASE}/api/portal/login-by-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_code: decodedCode }),
    cache: 'no-store',
  }).catch(() => null);

  if (!apiRes || !apiRes.ok) {
    loginUrl.searchParams.set('error', 'invalid_code');
    return NextResponse.redirect(loginUrl);
  }

  const response = NextResponse.redirect(dashboardUrl);

  const setCookieHeaders =
    typeof (apiRes.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === 'function'
      ? (apiRes.headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
      : apiRes.headers.get('set-cookie')
      ? [apiRes.headers.get('set-cookie') as string]
      : [];

  for (const cookie of setCookieHeaders) {
    response.headers.append('Set-Cookie', cookie);
  }

  return response;
}
