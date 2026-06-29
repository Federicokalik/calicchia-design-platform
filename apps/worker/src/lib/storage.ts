/**
 * Local-filesystem storage for the worker — drop-in mirror of
 * apps/api/src/lib/s3.ts (the API now serves uploads from UPLOAD_DIR via
 * Hono static on /media/). The worker shares the `uploads_data` volume with
 * the API, so screenshots written here are immediately reachable by the
 * admin through the API's `/media/...` static route.
 *
 * The key shape mirrors `lib/s3.generateFileKey` so worker shots land in the
 * same `projects/<slug>/` namespace as the headless Fase 2 capture.
 */
import { mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'path';

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/uploads';
// Public base used to build the URL the admin loads. In compose the worker
// sits next to the API on app-net, so the internal base is http://api:3001;
// but the admin displays these URLs in the browser, which is on the public
// origin — so prefer PUBLIC_API_URL/API_URL (public) when set.
const API_URL =
  process.env.PUBLIC_API_URL ||
  process.env.API_URL ||
  'http://localhost:3001';

const RESOLVED_BASE = resolve(UPLOAD_DIR);
mkdirSync(UPLOAD_DIR, { recursive: true });

function safeJoin(key: string): string {
  const target = resolve(join(UPLOAD_DIR, key));
  // Reject path traversal — a key is operator-supplied via the project slug.
  // NB: lo slice precedente lasciava il "/" iniziale (rel = "/projects/…"),
  // così resolve(rel)===rel era SEMPRE vero → throw anche per path validi (lo
  // screenshot headful non si salvava mai). relative()+isAbsolute() è corretto.
  const rel = relative(RESOLVED_BASE, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Invalid storage path');
  }
  return target;
}

export function generateKey(slug: string, label: string): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).substring(2, 8);
  const safe = slug.toLowerCase().replace(/[^a-z0-9]/g, '-').substring(0, 50);
  return `projects/${safe}/${ts}-${rand}-${safe}-${label}.webp`;
}

export async function saveCapture(
  buffer: Buffer,
  slug: string,
  label: string,
): Promise<{ url: string; key: string; size: number }> {
  const key = generateKey(slug, label);
  const filePath = safeJoin(key);
  mkdirSync(dirname(filePath), { recursive: true });
  await writeFile(filePath, buffer);
  return { url: `${API_URL}/media/${key}`, key, size: buffer.length };
}