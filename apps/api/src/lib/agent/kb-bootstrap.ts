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
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { logger } from '../logger';

const log = logger.child({ scope: 'kb-bootstrap' });

// This file lives in apps/api/src/lib/agent/, so its directory IS the agent dir
// where the KB files are read from in local dev.
const AGENT_DIR = dirname(fileURLToPath(import.meta.url));

/** Directory KB files are read from at runtime (see lib/agent + lib/quotes). */
export const KB_DIR = process.env.KB_DIR || AGENT_DIR;

const KB_PREFIX = 'kb/';
// assertKBsValid() requires these two; always attempted even if listing fails.
const REQUIRED_KB = ['pricing_knowledge_base.md', 'profile_knowledge_base.md'];

/** Freshness metadata written into KB_DIR after an S4 bootstrap; read by /api/health/kb. */
const KB_METADATA_FILE = '.kb-metadata.json';

export interface KbMetadata {
  /** 's4' when fetched from the MEGA S4 bucket, 'local' when read from disk (dev). */
  source: 's4' | 'local';
  file_count: number;
  /** ISO timestamp of the most recently modified KB file, or null if none found. */
  latest_modified: string | null;
  /** ISO timestamp of when bootstrapKBs() last ran (S4 source only). */
  loaded_at?: string;
}

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
    log.info('S4 not configured — using on-disk knowledge bases');
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
    log.error(
      { err: err instanceof Error ? err.message : err },
      'cannot list S4 bucket (will still try required files)',
    );
  }

  let downloaded = 0;
  let latestModified: Date | null = null;
  for (const key of keys) {
    const filename = key.slice(KB_PREFIX.length);
    if (!filename || filename.includes('/')) continue; // skip nested paths
    try {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = await res.Body?.transformToString('utf-8');
      if (body) {
        writeFileSync(resolve(KB_DIR, filename), body, 'utf-8');
        downloaded++;
        if (res.LastModified && (!latestModified || res.LastModified > latestModified)) {
          latestModified = res.LastModified;
        }
      }
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : err },
        `failed to fetch ${key}`,
      );
    }
  }
  log.info(`downloaded ${downloaded} knowledge-base file(s) from S4 into ${KB_DIR}`);

  // Persist freshness metadata so /api/health/kb can report staleness without
  // re-hitting S4. Best-effort: a write failure must not abort the boot.
  const metadata: KbMetadata = {
    source: 's4',
    file_count: downloaded,
    latest_modified: latestModified ? latestModified.toISOString() : null,
    loaded_at: new Date().toISOString(),
  };
  try {
    writeFileSync(
      resolve(KB_DIR, KB_METADATA_FILE),
      JSON.stringify(metadata, null, 2),
      'utf-8',
    );
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : err },
      'cannot write KB metadata file',
    );
  }
}

/**
 * Read knowledge-base freshness metadata for the `/api/health/kb` endpoint.
 *
 * Prefers the `.kb-metadata.json` written by {@link bootstrapKBs} (S4 production
 * path). Falls back to stat-ing the on-disk `.md` files — covers local dev
 * (S4 unset, no metadata file) and the case where an S4 bootstrap failed to
 * write metadata.
 */
export function readKbMetadata(): KbMetadata {
  try {
    const raw = readFileSync(resolve(KB_DIR, KB_METADATA_FILE), 'utf-8');
    return JSON.parse(raw) as KbMetadata;
  } catch {
    // No metadata file — derive freshness from the .md files currently on disk.
  }

  let fileCount = 0;
  let latestMs: number | null = null;
  try {
    for (const entry of readdirSync(KB_DIR)) {
      // Count real KB files only — skip the committed `*.example.md` templates.
      if (!entry.endsWith('.md') || entry.endsWith('.example.md')) continue;
      fileCount++;
      const { mtimeMs } = statSync(resolve(KB_DIR, entry));
      if (latestMs === null || mtimeMs > latestMs) latestMs = mtimeMs;
    }
  } catch {
    // KB_DIR unreadable — report zero files; the endpoint flags this as degraded.
  }

  return {
    source: 'local',
    file_count: fileCount,
    latest_modified: latestMs === null ? null : new Date(latestMs).toISOString(),
  };
}
