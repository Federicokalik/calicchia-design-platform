/**
 * Browser-side multipart upload to S4 via the portal presigned-URL flow.
 *
 * Audit B-014: the previous Server Action variant streamed every file byte
 * through the Next.js server (FormData → 'use server' boundary → portal-api
 * uploadFile → PUT to S3). For 500MB uploads that pinned RAM + CPU on the
 * sito-v3 container for the whole transfer. This module runs entirely on the
 * client — only the chunk PUTs hit S4 directly, and the small JSON
 * init/url/done calls go to /api/portal/upload/* with the existing portal_token
 * cookie (SameSite=None + COOKIE_DOMAIN handle the cross-origin send in prod).
 *
 * Customer folder isolation is enforced server-side: /api/portal/upload/init
 * generates `clients/{customer_id}/{uuid}-{name}` and /url + /done verify the
 * customer_id on the client_uploads row before issuing more presigned URLs
 * or completing the multipart upload.
 */

const API_BASE = (
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
).replace(/\/$/, '');

interface InitResponse {
  uploadId: string;
  key: string;
  totalParts: number;
  chunkSize: number;
  dbId: string;
}

interface PartUrlResponse {
  url: string;
  partNumber: number;
}

interface DoneResponse {
  ok: true;
  id: string;
  key: string;
}

export interface UploadProgress {
  bytesUploaded: number;
  totalBytes: number;
  currentPart: number;
  totalParts: number;
}

export interface UploadOptions {
  projectId?: string;
  onProgress?: (p: UploadProgress) => void;
  /** Abort signal — when fired the in-flight chunk PUT cancels and the API
   *  abort endpoint is hit so S4 can release the partial. */
  signal?: AbortSignal;
}

async function apiPost<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_BASE}/api/portal/upload${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j?.error) message = j.error; } catch { /* not json */ }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export async function uploadFileFromBrowser(
  file: File,
  opts: UploadOptions = {},
): Promise<{ id: string; key: string }> {
  if (!(file instanceof File)) throw new Error('Seleziona un file da caricare.');

  const init = await apiPost<InitResponse>('/init', {
    fileName: file.name,
    fileSize: file.size,
    contentType: file.type || 'application/octet-stream',
    projectId: opts.projectId || undefined,
  }, opts.signal);

  const parts: Array<{ PartNumber: number; ETag: string }> = [];

  try {
    for (let partNumber = 1; partNumber <= init.totalParts; partNumber += 1) {
      if (opts.signal?.aborted) throw new Error('Upload annullato');

      const start = (partNumber - 1) * init.chunkSize;
      const end = Math.min(start + init.chunkSize, file.size);

      const { url } = await apiPost<PartUrlResponse>('/url', {
        uploadId: init.uploadId,
        key: init.key,
        partNumber,
      }, opts.signal);

      // PUT chunk directly to S4 — no proxy through sito-v3 server.
      const uploadRes = await fetch(url, {
        method: 'PUT',
        body: file.slice(start, end),
        cache: 'no-store',
        signal: opts.signal,
      });
      if (!uploadRes.ok) {
        throw new Error(`Upload chunk ${partNumber} fallito (HTTP ${uploadRes.status})`);
      }
      const etag = uploadRes.headers.get('ETag') ?? uploadRes.headers.get('etag');
      if (!etag) {
        throw new Error(
          `Chunk ${partNumber} senza ETag — verifica la CORS del bucket S4 (deve esporre ETag in Access-Control-Expose-Headers).`,
        );
      }
      parts.push({ PartNumber: partNumber, ETag: etag });

      opts.onProgress?.({
        bytesUploaded: end,
        totalBytes: file.size,
        currentPart: partNumber,
        totalParts: init.totalParts,
      });
    }

    const done = await apiPost<DoneResponse>('/done', {
      uploadId: init.uploadId,
      key: init.key,
      parts,
    });
    return { id: done.id, key: done.key };
  } catch (err) {
    // Best-effort abort to release the multipart on S4
    await apiPost('/abort', { uploadId: init.uploadId, key: init.key }).catch(() => undefined);
    throw err;
  }
}
