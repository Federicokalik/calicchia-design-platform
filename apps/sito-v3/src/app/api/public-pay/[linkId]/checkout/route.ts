import { NextResponse, type NextRequest } from 'next/server';

const API_BASE = (
  process.env.NEXT_PUBLIC_API_URL ??
  process.env.PORTAL_API_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');

/**
 * POST /api/public-pay/{linkId}/checkout
 *
 * Proxy to Hono /api/public-pay/:id/checkout. Mints client_secret (Stripe) /
 * order_id (PayPal) / bank_details (bonifico) for the embedded UI on /pay/[linkId].
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ linkId: string }> },
) {
  const { linkId } = await params;
  const res = await fetch(
    `${API_BASE}/api/public-pay/${encodeURIComponent(linkId)}/checkout`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
    },
  );
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
