/**
 * Knowledge-base bootstrap.
 *
 * The AI knowledge bases (`pricing_knowledge_base.md`, `profile_knowledge_base.md`
 * and any `*_private.md`) contain real business data and are gitignored — they
 * are NOT in the Docker build context. In production they are delivered via a
 * private MEGA S4 bucket (S3-compatible object storage): this module downloads
 * them into `KB_DIR` at boot, before `assertKBsValid()` and before `lib/agent`
 * (which reads the pricing KB at module load) is evaluated.
 *
 * No-op when the `S4_*` env vars are not set — local dev reads the files that
 * already exist on disk in this directory.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

// This file lives in apps/api/src/lib/agent/, so its directory IS the agent dir
// where the KB files are read from in local dev.
const AGENT_DIR = dirname(fileURLToPath(import.meta.url));

/** Directory KB files are read from at runtime (see lib/agent + lib/quotes). */
export const KB_DIR = process.env.KB_DIR || AGENT_DIR;

const KB_PREFIX = 'kb/';
// assertKBsValid() requires these two; always attempted even if listing fails.
const REQUIRED_KB = ['pricing_knowledge_base.md', 'profile_knowledge_base.md'];

function getS4(): { client: S3Client; bucket: string } | null {
  const endpoint = process.env.S4_ENDPOINT;
  const bucket = process.env.S4_BUCKET;
  const accessKeyId = process.env.S4_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S4_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    bucket,
    client: new S3Client({
      endpoint,
      region: process.env.S4_REGION || 'auto',
      credentials: { accessKeyId, secretAccessKey },
      // Most S3-compatible providers (incl. MEGA S4) expect path-style URLs.
      forcePathStyle: process.env.S4_FORCE_PATH_STYLE !== 'false',
    }),
  };
}

/**
 * Download the knowledge-base files from MEGA S4 into KB_DIR.
 * Safe to call unconditionally: returns immediately if S4 is not configured.
 */
export async function bootstrapKBs(): Promise<void> {
  const s4 = getS4();
  if (!s4) {
    console.log('[kb-bootstrap] S4 not configured — using on-disk knowledge bases');
    return;
  }
  const { client, bucket } = s4;
  mkdirSync(KB_DIR, { recursive: true });

  // Discover every .md object under kb/ so *_private.md files are picked up too.
  const keys = new Set<string>(REQUIRED_KB.map((f) => KB_PREFIX + f));
  try {
    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: KB_PREFIX }),
    );
    for (const obj of listed.Contents || []) {
      if (obj.Key && obj.Key.endsWith('.md')) keys.add(obj.Key);
    }
  } catch (err) {
    console.error(
      '[kb-bootstrap] cannot list S4 bucket (will still try required files):',
      err instanceof Error ? err.message : err,
    );
  }

  let downloaded = 0;
  for (const key of keys) {
    const filename = key.slice(KB_PREFIX.length);
    if (!filename || filename.includes('/')) continue; // skip nested paths
    try {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = await res.Body?.transformToString('utf-8');
      if (body) {
        writeFileSync(resolve(KB_DIR, filename), body, 'utf-8');
        downloaded++;
      }
    } catch (err) {
      console.error(
        `[kb-bootstrap] failed to fetch ${key}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  console.log(`[kb-bootstrap] downloaded ${downloaded} knowledge-base file(s) from S4 into ${KB_DIR}`);
}
