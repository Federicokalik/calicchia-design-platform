import { NextResponse, type NextRequest } from 'next/server';

const API_BASE = (
  process.env.NEXT_PUBLIC_API_URL ??
  process.env.PORTAL_API_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');

/**
 * GET /api/public-pay/{linkId}
 *
 * Proxy to Hono /api/public-pay/:id — fetches safe metadata for the public pay page.
 * No auth: the linkId UUID is the capability.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ linkId: string }> },
) {
  const { linkId } = await params;
  const res = await fetch(
    `${API_BASE}/api/public-pay/${encodeURIComponent(linkId)}`,
    { method: 'GET', cache: 'no-store' },
  );
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
