import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';

const API_BASE = (
  process.env.NEXT_PUBLIC_API_URL ??
  process.env.PORTAL_API_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');

/**
 * GET /api/portal/invoices/payment-links/{linkId}/status
 *
 * Polled by the payment success page after Stripe redirect. Forwards to the
 * Hono API (webhook-authoritative link status) with the portal cookie.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ linkId: string }> },
) {
  const { linkId } = await params;
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  const res = await fetch(
    `${API_BASE}/api/portal/invoices/payment-links/${encodeURIComponent(linkId)}/status`,
    {
      headers: cookieHeader ? { Cookie: cookieHeader } : {},
      cache: 'no-store',
    },
  );

  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
