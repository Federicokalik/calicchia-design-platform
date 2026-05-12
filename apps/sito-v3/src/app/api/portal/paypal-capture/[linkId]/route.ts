import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';

const API_BASE = (
  process.env.NEXT_PUBLIC_API_URL ??
  process.env.PORTAL_API_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');

/**
 * POST /api/portal/paypal-capture/{linkId}
 *
 * Called by the success page after PayPal redirect. Forwards to Hono API which
 * calls `capturePaypalOrder` + `recordPaymentSuccess`. Idempotent — safe to retry.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ linkId: string }> },
) {
  const { linkId } = await params;
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  const res = await fetch(
    `${API_BASE}/api/portal/invoices/paypal-capture/${encodeURIComponent(linkId)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      cache: 'no-store',
    },
  );

  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
