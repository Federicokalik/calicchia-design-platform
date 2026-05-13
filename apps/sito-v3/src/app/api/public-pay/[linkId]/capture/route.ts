import { NextResponse, type NextRequest } from 'next/server';

const API_BASE = (
  process.env.NEXT_PUBLIC_API_URL ??
  process.env.PORTAL_API_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');

/**
 * POST /api/public-pay/{linkId}/capture
 *
 * Proxy to Hono /api/public-pay/:id/capture. Finalizes PayPal payment after
 * the user approves it via Buttons / Card Fields. Idempotent.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ linkId: string }> },
) {
  const { linkId } = await params;
  const res = await fetch(
    `${API_BASE}/api/public-pay/${encodeURIComponent(linkId)}/capture`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
    },
  );
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
