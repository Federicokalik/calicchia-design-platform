/**
 * MEGA S4 Storage Client (S3-compatible)
 * Handles multipart uploads for client file uploads.
 *
 * Environment variables (canonical names match .env.example + docker-compose.prod.yml):
 * - S4_ACCESS_KEY_ID, S4_SECRET_ACCESS_KEY (audit J-K-14: legacy S4_ACCESS_KEY /
 *   S4_SECRET_KEY are still accepted as fallback so existing local .envs keep
 *   working, but new deploys should set the *_ID / *_ACCESS_* names — that's
 *   what admin-kb.ts and the prod compose use, and a mismatch made the portal
 *   upload break in production).
 * - S4_BUCKET (default: client-uploads)
 * - S4_REGION (default: eu-central-1)
 * - S4_ENDPOINT (default: https://s3.eu-central-1.s4.mega.io)
 */

import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const bucket = process.env.S4_BUCKET || 'client-uploads';

let _client: S3Client | null = null;

function getClient(): S3Client {
  if (_client) return _client;

  const accessKeyId = process.env.S4_ACCESS_KEY_ID || process.env.S4_ACCESS_KEY;
  const secretAccessKey = process.env.S4_SECRET_ACCESS_KEY || process.env.S4_SECRET_KEY;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error('S4_ACCESS_KEY_ID and S4_SECRET_ACCESS_KEY are required for MEGA S4 uploads');
  }

  _client = new S3Client({
    region: process.env.S4_REGION || 'eu-central-1',
    endpoint: process.env.S4_ENDPOINT || 'https://s3.eu-central-1.s4.mega.io',
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });

  return _client;
}

/**
 * Start a multipart upload. Returns the UploadId.
 */
export async function initMultipartUpload(key: string, contentType: string): Promise<string> {
  const client = getClient();
  const command = new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });

  const result = await client.send(command);
  if (!result.UploadId) throw new Error('Failed to initiate multipart upload');
  return result.UploadId;
}

/**
 * Generate a presigned PUT URL for uploading a single part.
 * The client uses this URL to PUT the chunk directly to S4.
 */
export async function getPresignedPartUrl(
  key: string,
  uploadId: string,
  partNumber: number,
  expiresIn = 600,
): Promise<string> {
  const client = getClient();
  const command = new UploadPartCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
  });

  return getSignedUrl(client, command, { expiresIn });
}

/**
 * Complete a multipart upload after all parts have been uploaded.
 * @param parts Array of { PartNumber, ETag } from each uploaded part
 */
export async function completeMultipartUpload(
  key: string,
  uploadId: string,
  parts: Array<{ PartNumber: number; ETag: string }>,
): Promise<void> {
  const client = getClient();
  const command = new CompleteMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: {
      Parts: parts.sort((a, b) => a.PartNumber - b.PartNumber),
    },
  });

  await client.send(command);
}

/**
 * Abort a multipart upload (cleanup incomplete uploads).
 */
export async function abortMultipartUpload(key: string, uploadId: string): Promise<void> {
  const client = getClient();
  const command = new AbortMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
  });

  await client.send(command);
}

/**
 * Read the first N bytes of a completed object (for magic-byte sniffing).
 */
export async function getObjectHead(key: string, bytes = 32): Promise<Buffer> {
  const client = getClient();
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    Range: `bytes=0-${bytes - 1}`,
  });
  const result = await client.send(command);
  if (!result.Body) throw new Error('Empty object body');
  const chunks: Uint8Array[] = [];
  // @ts-expect-error: AWS SDK Body is an async iterable in Node
  for await (const chunk of result.Body) {
    chunks.push(chunk as Uint8Array);
    if (Buffer.concat(chunks).length >= bytes) break;
  }
  return Buffer.concat(chunks).subarray(0, bytes);
}

/**
 * RFC 6266 Content-Disposition with an ASCII fallback plus the RFC 5987
 * `filename*` form, so accented / non-Latin names survive the download.
 */
function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Presigned GET URL for reading a private object (admin download / preview).
 * The bucket is private: the signature is the only capability, so keep the
 * expiry short. `filename` restores the original name the client uploaded
 * (the key carries a UUID prefix + sanitized name).
 */
export async function getPresignedDownloadUrl(
  key: string,
  opts: { filename: string; inline?: boolean; contentType?: string; expiresIn?: number },
): Promise<string> {
  const client = getClient();
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: contentDisposition(opts.inline ? 'inline' : 'attachment', opts.filename),
    // Pin the served type when rendering inline: an <iframe>/<video> fed a
    // generic octet-stream would download instead of display.
    ...(opts.contentType ? { ResponseContentType: opts.contentType } : {}),
  });

  return getSignedUrl(client, command, { expiresIn: opts.expiresIn ?? 300 });
}

/**
 * Delete an object (used to clean up files that fail post-upload validation).
 */
export async function deleteObject(key: string): Promise<void> {
  const client = getClient();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
