import { NextResponse } from 'next/server';

const API_BASE = (
  process.env.NEXT_PUBLIC_API_URL ??
  process.env.PORTAL_API_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');

/**
 * GET /api/paypal/client-token
 *
 * Proxy to Hono /api/paypal/client-token. Used by the PayPal SDK in the browser
 * to enable Advanced Credit/Debit Card Payments (Card Fields).
 *
 * No auth headers forwarded — the underlying endpoint is public.
 */
export async function GET() {
  const res = await fetch(`${API_BASE}/api/paypal/client-token`, {
    method: 'GET',
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
