/**
 * Private file storage (SEC-10).
 *
 * Quote PDFs, payment receipts and inbound WhatsApp media must NOT be reachable
 * at a public URL. They are stored under PRIVATE_UPLOAD_DIR — a directory that,
 * unlike UPLOAD_DIR, is never mounted on the public `/media/*` static route —
 * and are retrieved only through `/api/files/*` with a signed, expiring URL.
 *
 * The signature (HMAC-SHA256 over "category/name:exp", keyed by JWT_SECRET) is
 * the capability: it lets emailed receipt/quote links work without a login
 * while keeping the files unguessable and access-gated.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join, relative, resolve } from 'path';

const PRIVATE_DIR = process.env.PRIVATE_UPLOAD_DIR || './private-uploads';
const API_URL = process.env.API_URL || 'http://localhost:3001';
const RESOLVED_BASE = resolve(PRIVATE_DIR);

// Signed-URL lifetime — generous on purpose: an emailed receipt or quote link
// must still open weeks/months later. Tunable via env.
const URL_TTL_SEC = (Number(process.env.PRIVATE_URL_TTL_DAYS) || 180) * 24 * 60 * 60;

export const PRIVATE_CATEGORIES = ['quotes', 'receipts', 'whatsapp'] as const;
export type PrivateCategory = (typeof PRIVATE_CATEGORIES)[number];

mkdirSync(PRIVATE_DIR, { recursive: true });

const NAME_RE = /^[A-Za-z0-9._-]+$/;

function isCategory(value: string): value is PrivateCategory {
  return (PRIVATE_CATEGORIES as readonly string[]).includes(value);
}

function hmacSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required for private-file signing');
  return secret;
}

function sign(category: string, name: string, exp: number): string {
  return createHmac('sha256', hmacSecret()).update(`${category}/${name}:${exp}`).digest('hex');
}

/** Build an absolute, signed, expiring URL for a private file. */
export function signFileUrl(category: PrivateCategory, name: string, ttlSec = URL_TTL_SEC): string {
  if (!isCategory(category) || !NAME_RE.test(name)) {
    throw new Error('Invalid private-file reference');
  }
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return `${API_URL}/api/files/${category}/${name}?exp=${exp}&sig=${sign(category, name, exp)}`;
}

/** Constant-time check of a signed-URL request (signature + expiry). */
export function verifyFileSig(
  category: string,
  name: string,
  exp: string | undefined,
  sig: string | undefined,
): boolean {
  if (!exp || !sig || !isCategory(category) || !NAME_RE.test(name)) return false;
  const expNum = Number(exp);
  if (!Number.isInteger(expNum) || expNum * 1000 < Date.now()) return false;
  const provided = Buffer.from(sig);
  const expected = Buffer.from(sign(category, name, expNum));
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** Absolute path of a private file, guarded against path traversal. */
function privateFilePath(category: string, name: string): string {
  if (!isCategory(category) || !NAME_RE.test(name)) {
    throw new Error('Invalid private-file reference');
  }
  const target = resolve(join(PRIVATE_DIR, category, name));
  const rel = relative(RESOLVED_BASE, target);
  if (rel.startsWith('..') || resolve(rel) === rel) {
    throw new Error('Invalid private-file path');
  }
  return target;
}

/** Persist a buffer under a private category. */
export async function savePrivateFile(category: PrivateCategory, name: string, data: Buffer): Promise<void> {
  mkdirSync(join(PRIVATE_DIR, category), { recursive: true });
  await writeFile(privateFilePath(category, name), data);
}

export function privateFileExists(category: string, name: string): boolean {
  try {
    return existsSync(privateFilePath(category, name));
  } catch {
    return false;
  }
}

export async function readPrivateFile(category: string, name: string): Promise<Buffer> {
  return readFile(privateFilePath(category, name));
}
