import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';

const API_BASE = (
  process.env.NEXT_PUBLIC_API_URL ??
  process.env.PORTAL_API_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');

/**
 * POST /api/portal/pay
 *
 * Client-side bridge to Hono API. The portal needs to call /api/portal/invoices/pay
 * with the customer's httpOnly cookie attached — but client-side fetch can't read
 * an httpOnly cookie. This route handler runs server-side, reads the cookie via
 * `cookies()`, and forwards the request.
 *
 * Body: `{ schedule_id: string, provider: 'stripe' | 'paypal' }`
 * Returns: `{ checkout_url: string, link_id: string }`
 */
export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const res = await fetch(`${API_BASE}/api/portal/invoices/pay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });

  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
