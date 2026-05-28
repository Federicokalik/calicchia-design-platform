/**
 * /api/revalidate — endpoint di rivalidazione on-demand.
 *
 * Chiamato dall'API admin (`@caldes/api`) dopo ogni publish/update/delete su
 * contenuti CMS che impattano la sitemap o le pagine del sito (blog posts,
 * projects, services, cities, glossario, faqs).
 *
 * Auth: header `X-Revalidate-Token` confrontato in constant-time contro
 * `REVALIDATE_SECRET`. Senza token o con token errato → 404 (no information
 * leak — niente 401, sembra una route inesistente).
 *
 * Body JSON opzionale: `{ tags?: string[], paths?: string[] }`. Default
 * `tags: ['sitemap']`. La sitemap, llms.txt e llms-full.txt sono già taggati
 * con 'sitemap', quindi un solo revalidateTag('sitemap') li aggiorna tutti.
 *
 * Rate-limit lieve: 10 req/min/IP via Map in-memory. Senza limite, un attacker
 * con il token corretto potrebbe ddosare la regenerazione ISR.
 */
import { NextResponse } from 'next/server';
import { revalidateTag, revalidatePath } from 'next/cache';
import { timingSafeEqual } from 'node:crypto';

export const dynamic = 'force-dynamic';

const SECRET = process.env.REVALIDATE_SECRET ?? '';

function safeEqual(a: string, b: string): boolean {
  const buf1 = Buffer.from(a);
  const buf2 = Buffer.from(b);
  if (buf1.length !== buf2.length) return false;
  return timingSafeEqual(buf1, buf2);
}

// ─── Rate-limit in-memory ─────────────────────────────────────────────
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) {
    hits.set(ip, arr);
    return true;
  }
  arr.push(now);
  hits.set(ip, arr);
  return false;
}

function notFound(): NextResponse {
  return NextResponse.json({ error: 'not found' }, { status: 404 });
}

interface Body {
  tags?: string[];
  paths?: string[];
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!SECRET) {
    // Misconfig: production should always have REVALIDATE_SECRET. Don't
    // leak the misconfig — pretend the endpoint doesn't exist.
    return notFound();
  }

  const token = req.headers.get('x-revalidate-token') ?? '';
  if (!safeEqual(token, SECRET)) return notFound();

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown';
  if (rateLimited(ip)) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 });
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    // empty/invalid body → default behaviour (sitemap tag)
  }

  const tags = Array.isArray(body.tags) && body.tags.length > 0 ? body.tags : ['sitemap'];
  const paths = Array.isArray(body.paths) ? body.paths : [];

  const revalidated: { tags: string[]; paths: string[] } = { tags: [], paths: [] };
  for (const tag of tags) {
    try {
      // Next 16: revalidateTag(tag, profile) — `{ expire: 0 }` means "expire
      // immediately", forcing the next request to revalidate from origin.
      revalidateTag(tag, { expire: 0 });
      revalidated.tags.push(tag);
    } catch {
      // continue best-effort
    }
  }
  for (const path of paths) {
    try {
      revalidatePath(path, 'page');
      revalidated.paths.push(path);
    } catch {
      // continue
    }
  }

  return NextResponse.json({ revalidated, now: new Date().toISOString() });
}
