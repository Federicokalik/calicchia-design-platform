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

  // Relative Location paths: il browser le risolve sull'origin della request.
  // localePrefix 'as-needed': IT (default) non ha prefix, EN sì → evita un
  // 308 extra di next-intl che rewriterebbe /it/... → /...
  const localePrefix = locale === 'it' ? '' : `/${locale}`;
  const loginErrorPath = `${localePrefix}/clienti/login?error=invalid_code`;

  if (!decodedCode) {
    return new NextResponse(null, { status: 307, headers: { Location: loginErrorPath } });
  }

  const apiRes = await fetch(`${API_BASE}/api/portal/login-by-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_code: decodedCode }),
    cache: 'no-store',
  }).catch(() => null);

  if (!apiRes || !apiRes.ok) {
    return new NextResponse(null, { status: 307, headers: { Location: loginErrorPath } });
  }

  const data = (await apiRes.json().catch(() => ({}))) as {
    customer?: { role?: 'client' | 'collaborator' };
  };
  const destinationPath =
    data.customer?.role === 'collaborator'
      ? `${localePrefix}/clienti/progetti`
      : `${localePrefix}/clienti/dashboard`;

  const response = new NextResponse(null, { status: 307, headers: { Location: destinationPath } });

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
