'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getCustomer, type PortalCustomer } from '@/lib/portal-api';

const API_BASE = (
  process.env.NEXT_PUBLIC_API_URL ??
  process.env.PORTAL_API_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');

const PORTAL_COOKIE_NAME = 'portal_token';

// Schema kept private — Next 16 'use server' modules can only export
// async functions, not runtime objects (z.object).
const loginByCodeSchema = z.object({
  code: z.string().trim().min(1, 'Inserisci il codice ricevuto via email.').max(64),
});

type LoginResult = { ok: true; redirect: string } | { ok: false; error: string };

type CookieSameSite = 'strict' | 'lax' | 'none';

function parseSetCookie(header: string) {
  const segments = header.split(';').map((part) => part.trim());
  const [pair, ...attrs] = segments;
  const eq = pair.indexOf('=');
  if (eq === -1) return null;

  const parsed: {
    name: string;
    value: string;
    path?: string;
    domain?: string;
    maxAge?: number;
    expires?: Date;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: CookieSameSite;
  } = {
    name: pair.slice(0, eq),
    value: pair.slice(eq + 1),
  };

  for (const attr of attrs) {
    const [rawKey, ...rawValue] = attr.split('=');
    const key = rawKey.toLowerCase();
    const value = rawValue.join('=');

    if (key === 'path') parsed.path = value || '/';
    if (key === 'domain') parsed.domain = value;
    if (key === 'max-age') parsed.maxAge = Number(value);
    if (key === 'expires') parsed.expires = new Date(value);
    if (key === 'httponly') parsed.httpOnly = true;
    if (key === 'secure') parsed.secure = true;
    if (key === 'samesite') parsed.sameSite = value.toLowerCase() as CookieSameSite;
  }

  return parsed;
}

function getSetCookieHeaders(res: Response): string[] {
  const withGetSetCookie = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetSetCookie.getSetCookie === 'function') {
    return withGetSetCookie.getSetCookie();
  }
  const single = res.headers.get('set-cookie');
  return single ? [single] : [];
}

async function forwardApiCookies(res: Response) {
  const cookieStore = await cookies();
  for (const header of getSetCookieHeaders(res)) {
    const parsed = parseSetCookie(header);
    if (!parsed) continue;
    cookieStore.set(parsed.name, parsed.value, {
      path: parsed.path ?? '/',
      domain: parsed.domain,
      maxAge: parsed.maxAge,
      expires: parsed.expires,
      httpOnly: parsed.httpOnly,
      secure: parsed.secure,
      sameSite: parsed.sameSite,
    });
  }
}

export async function loginByCode(input: { code: string }): Promise<LoginResult> {
  const parsed = loginByCodeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Codice non valido' };
  }

  const res = await fetch(`${API_BASE}/api/portal/login-by-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_code: parsed.data.code }),
    cache: 'no-store',
  });

  if (res.ok) {
    await forwardApiCookies(res);
    return { ok: true, redirect: '/clienti/dashboard' };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: 'Codice non valido' };
  }

  return { ok: false, error: 'Accesso non disponibile. Riprova tra poco.' };
}

export async function logout(): Promise<void> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  const res = await fetch(`${API_BASE}/api/portal/logout`, {
    method: 'POST',
    headers: cookieHeader ? { Cookie: cookieHeader } : undefined,
    cache: 'no-store',
  }).catch(() => null);

  if (res) await forwardApiCookies(res).catch(() => undefined);
  cookieStore.delete(PORTAL_COOKIE_NAME);
  redirect('/clienti/login');
}

export async function requireAuth(): Promise<PortalCustomer> {
  const customer = await getCustomer();
  if (!customer) redirect('/clienti/login?next=/clienti/dashboard');
  return customer;
}
