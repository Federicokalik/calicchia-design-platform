/**
 * Local filesystem storage — drop-in replacement for the previous S3/Supabase Storage.
 * Files are saved to UPLOAD_DIR and served via Hono static on /media/.
 */
import { mkdirSync, unlinkSync, readdirSync, statSync, existsSync } from 'fs';
import { writeFile } from 'fs/promises';
import { dirname, extname, join, relative, resolve } from 'path';

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
const API_URL = process.env.API_URL || 'http://localhost:3001';

// Ensure upload directory exists
mkdirSync(UPLOAD_DIR, { recursive: true });

export function isS3Configured(): boolean {
  return true; // Local storage is always available
}

export function getFileUrl(key: string): string {
  return `${API_URL}/media/${key}`;
}

export async function uploadFile(
  buffer: Buffer,
  key: string,
  contentType: string,
  _metadata?: Record<string, string>
): Promise<{ url: string; key: string; size: number }> {
  const filePath = join(UPLOAD_DIR, key);
  const resolvedPath = resolve(filePath);
  const resolvedBase = resolve(UPLOAD_DIR);
  const rel = relative(resolvedBase, resolvedPath);
  if (rel.startsWith('..') || resolve(rel) === rel) {
    throw new Error('Invalid upload path');
  }
  // Ensure subdirectory exists
  mkdirSync(dirname(filePath), { recursive: true });

  await writeFile(filePath, buffer);
  return { url: getFileUrl(key), key, size: buffer.length };
}

export async function deleteFile(key: string): Promise<void> {
  const filePath = join(UPLOAD_DIR, key);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

export async function listFiles(
  prefix: string = '',
  maxKeys: number = 100
): Promise<{ key: string; size: number; lastModified: Date; url: string | null }[]> {
  const dir = prefix ? join(UPLOAD_DIR, prefix) : UPLOAD_DIR;

  if (!existsSync(dir)) return [];

  const results: { key: string; size: number; lastModified: Date; url: string | null }[] = [];

  function walk(currentDir: string, relBase: string) {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxKeys) break;
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
      const full = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(full, relPath);
      } else {
        const stat = statSync(full);
        const key = prefix ? `${prefix}/${relPath}` : relPath;
        results.push({
          key,
          size: stat.size,
          lastModified: stat.mtime,
          url: getFileUrl(key),
        });
      }
    }
  }

  walk(dir, '');
  return results.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
}

export async function getPresignedUrl(key: string): Promise<string> {
  return getFileUrl(key);
}

export function generateFileKey(filename: string, folder: string = 'uploads'): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  const ext = extname(filename).toLowerCase();
  const safeName = filename
    .replace(/\.[^/.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .substring(0, 50);

  return `${folder}/${timestamp}-${random}-${safeName}${ext}`;
}
