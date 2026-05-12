/**
 * Shared cookie helpers.
 *
 * COOKIE_DOMAIN can be used in production when auth cookies must be scoped to
 * a parent domain shared by the public site, admin, and API.
 */

const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN;

interface CookieOpts {
  name: string;
  value: string;
  maxAge: number;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  path?: string;
}

export function buildCookie(opts: CookieOpts): string {
  const {
    name,
    value,
    maxAge,
    httpOnly = true,
    sameSite = 'Lax',
    path = '/',
  } = opts;

  const parts = [`${name}=${value}`, `Path=${path}`, `Max-Age=${maxAge}`, `SameSite=${sameSite}`];

  if (httpOnly) parts.push('HttpOnly');
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  if (COOKIE_DOMAIN) parts.push(`Domain=${COOKIE_DOMAIN}`);

  return parts.join('; ');
}

export function clearCookie(name: string): string {
  return buildCookie({ name, value: '', maxAge: 0 });
}

type HeaderSetter = { header: (name: string, value: string) => void };

export function setAuthCookie(c: HeaderSetter, token: string) {
  c.header('Set-Cookie', buildCookie({ name: 'auth_token', value: token, maxAge: 86400 * 7 }));
}

export function clearAuthCookie(c: HeaderSetter) {
  c.header('Set-Cookie', clearCookie('auth_token'));
}

export function setPortalCookie(c: HeaderSetter, token: string) {
  c.header('Set-Cookie', buildCookie({ name: 'portal_token', value: token, maxAge: 86400 * 30 }));
}

export function clearPortalCookie(c: HeaderSetter) {
  c.header('Set-Cookie', clearCookie('portal_token'));
}
