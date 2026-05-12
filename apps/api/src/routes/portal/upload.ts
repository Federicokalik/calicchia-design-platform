import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import { sql } from '../../db';
import { fail } from '../../lib/responses';
import { portalAuth, type PortalEnv } from './auth';

export const uploadRoutes = new Hono<PortalEnv>();

const CHUNK_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB
const PRESIGNED_EXPIRY = 600; // 10 minutes

const ALLOWED_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/tiff', 'image/svg+xml',
  'application/pdf',
  'application/zip', 'application/x-rar-compressed', 'application/x-7z-compressed',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'video/mp4', 'video/quicktime',
  'application/postscript', 'image/vnd.adobe.photoshop',
  'application/illustrator',
]);

/**
 * Detect MIME type by inspecting the first bytes of a file. Returns the MIME
 * inferred from magic bytes, or null if the format isn't recognized.
 *
 * Coverage matches ALLOWED_TYPES — a file outside this whitelist will return
 * null (caller treats null as a content/type mismatch).
 */
function sniffMime(buf: Buffer): string | null {
  if (buf.length < 4) return null;

  // image/jpeg: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';

  // image/png: 89 50 4E 47 0D 0A 1A 0A
  if (buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png';

  // image/webp: "RIFF"....."WEBP"
  if (buf.length >= 12 &&
      buf.slice(0, 4).toString('ascii') === 'RIFF' &&
      buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';

  // image/tiff: 49 49 2A 00 (LE) or 4D 4D 00 2A (BE)
  if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
      (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)) return 'image/tiff';

  // application/pdf + application/illustrator (AI v9+ is PDF-based): "%PDF-"
  if (buf.length >= 5 && buf.slice(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';

  // application/postscript + AI v8 and earlier: "%!PS"
  if (buf.length >= 4 && buf.slice(0, 4).toString('ascii') === '%!PS') return 'application/postscript';

  // application/zip (and OOXML docx/xlsx/pptx — caller resolves by extension): PK\x03\x04
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'application/zip';

  // application/x-rar-compressed: "Rar!\x1A\x07"
  if (buf.length >= 6 &&
      buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21 &&
      buf[4] === 0x1a && buf[5] === 0x07) return 'application/x-rar-compressed';

  // application/x-7z-compressed: 37 7A BC AF 27 1C
  if (buf.length >= 6 &&
      buf[0] === 0x37 && buf[1] === 0x7a && buf[2] === 0xbc && buf[3] === 0xaf &&
      buf[4] === 0x27 && buf[5] === 0x1c) return 'application/x-7z-compressed';

  // image/vnd.adobe.photoshop: "8BPS"
  if (buf.length >= 4 && buf.slice(0, 4).toString('ascii') === '8BPS') return 'image/vnd.adobe.photoshop';

  // video/mp4 + video/quicktime: bytes 4-7 = "ftyp", brand identifies container
  if (buf.length >= 12 && buf.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.slice(8, 12).toString('ascii');
    if (brand === 'qt  ') return 'video/quicktime';
    return 'video/mp4'; // isom, mp42, M4V, etc.
  }

  // image/svg+xml: text-based — must start with "<?xml" or "<svg" (whitespace-tolerant)
  const head = buf.toString('utf8', 0, Math.min(buf.length, 32)).trimStart().toLowerCase();
  if (head.startsWith('<?xml') || head.startsWith('<svg')) return 'image/svg+xml';

  return null;
}

/**
 * Resolve whether a sniffed MIME is compatible with what the client declared.
 * OOXML formats (docx/xlsx/pptx) all sniff as application/zip — accept that.
 * Illustrator files may sniff as application/pdf or application/postscript.
 */
function mimeMatches(declared: string, sniffed: string): boolean {
  if (declared === sniffed) return true;
  if (sniffed === 'application/zip' && declared.startsWith('application/vnd.openxmlformats-officedocument')) return true;
  if (declared === 'application/illustrator' && (sniffed === 'application/pdf' || sniffed === 'application/postscript')) return true;
  return false;
}

// ── Init multipart upload ────────────────────────────────
uploadRoutes.post('/init', portalAuth, async (c) => {
  const customerId = c.get('customer_id') as string;
  const { fileName, fileSize, contentType, projectId } = await c.req.json();

  if (!fileName || !fileSize || !contentType) {
    fail('fileName, fileSize e contentType richiesti', 400);
  }
  if (fileSize > MAX_FILE_SIZE) {
    fail(`File troppo grande. Massimo ${MAX_FILE_SIZE / 1024 / 1024}MB`, 400);
  }
  if (!ALLOWED_TYPES.has(contentType)) {
    fail('Tipo file non supportato', 400);
  }

  // Verify project belongs to customer (if provided)
  if (projectId) {
    const [project] = await sql`
      SELECT id FROM client_projects
      WHERE id = ${projectId} AND customer_id = ${customerId} AND visible_to_client = true
      LIMIT 1
    ` as Array<{ id: string }>;
    if (!project) fail('Progetto non trovato', 404);
  }

  const { initMultipartUpload } = await import('../../lib/s4');
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  // Use a UUID instead of Date.now() to avoid both same-ms collisions and
  // predictable bucket scanning if the bucket is ever exposed by mistake.
  const key = `clients/${customerId}/${randomUUID()}-${safeName}`;
  const totalParts = Math.ceil(fileSize / CHUNK_SIZE);

  const uploadId = await initMultipartUpload(key, contentType);

  // Track in DB
  const [upload] = await sql`
    INSERT INTO client_uploads (customer_id, project_id, bucket, key, original_name, content_type, size, status, upload_id)
    VALUES (${customerId}, ${projectId || null}, ${process.env.S4_BUCKET || 'client-uploads'}, ${key}, ${fileName}, ${contentType}, ${fileSize}, 'uploading', ${uploadId})
    RETURNING id
  ` as Array<{ id: string }>;

  return c.json({
    uploadId,
    key,
    totalParts,
    chunkSize: CHUNK_SIZE,
    dbId: upload.id,
  });
});

// ── Get presigned URL for a chunk ────────────────────────
uploadRoutes.post('/url', portalAuth, async (c) => {
  const customerId = c.get('customer_id') as string;
  const { uploadId, key, partNumber } = await c.req.json();

  if (!uploadId || !key || !partNumber) {
    fail('uploadId, key e partNumber richiesti', 400);
  }
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    fail('partNumber non valido (atteso intero 1-10000)', 400);
  }

  // Verify this upload belongs to the authenticated customer
  const [owned] = await sql`
    SELECT id FROM client_uploads
    WHERE upload_id = ${uploadId} AND key = ${key} AND customer_id = ${customerId}
    LIMIT 1
  ` as Array<{ id: string }>;
  if (!owned) fail('Upload non trovato', 404);

  const { getPresignedPartUrl } = await import('../../lib/s4');
  const url = await getPresignedPartUrl(key, uploadId, partNumber, PRESIGNED_EXPIRY);

  return c.json({ url, partNumber, expiresIn: PRESIGNED_EXPIRY });
});

// ── Complete multipart upload ────────────────────────────
uploadRoutes.post('/done', portalAuth, async (c) => {
  const customerId = c.get('customer_id') as string;
  const { uploadId, key, parts } = await c.req.json();

  if (!uploadId || !key || !parts?.length) {
    fail('uploadId, key e parts richiesti', 400);
  }

  // Verify ownership BEFORE completing on S3
  const [upload] = await sql`
    SELECT id, project_id, original_name, size, content_type FROM client_uploads
    WHERE upload_id = ${uploadId} AND key = ${key} AND customer_id = ${customerId}
    LIMIT 1
  ` as Array<Record<string, unknown>>;
  if (!upload) fail('Upload non trovato', 404);

  const { completeMultipartUpload, getObjectHead, deleteObject } = await import('../../lib/s4');
  await completeMultipartUpload(key, uploadId, parts);

  // Magic-byte validation: client-declared content_type is untrusted, verify against actual file bytes
  const declaredType = String(upload.content_type || '');
  let sniffOk = true;
  let sniffSkipped = false;
  try {
    const head = await getObjectHead(key, 32);
    const sniffed = sniffMime(head);
    sniffOk = !!sniffed && mimeMatches(declaredType, sniffed);
  } catch (err) {
    // Transient S3 read error: don't reject the upload but flag it
    sniffSkipped = true;
    console.error('[upload] magic-byte sniff failed for key', key, err);
  }

  if (!sniffOk) {
    await deleteObject(key).catch(() => {});
    await sql`UPDATE client_uploads SET status = 'rejected' WHERE id = ${String(upload.id)}`;
    fail('Contenuto file non corrisponde al tipo dichiarato', 400);
  }

  // Update DB status
  await sql`
    UPDATE client_uploads SET status = 'completed', uploaded_at = NOW()
    WHERE id = ${String(upload.id)}
  `;
  if (sniffSkipped) console.warn('[upload] completed without magic-byte verification:', key);

  const uploadProjectId = upload.project_id ? String(upload.project_id) : null;
  const uploadName = String(upload.original_name || '');
  const uploadSize = Number(upload.size || 0);

  // Create timeline event if linked to project
  if (uploadProjectId) {
    const fileTitle = 'File caricato: ' + uploadName;
    const fileDesc = 'Dimensione: ' + formatBytes(uploadSize);
    await sql`
      INSERT INTO timeline_events (project_id, customer_id, type, title, description, actor_type)
      VALUES (${uploadProjectId}, ${customerId}, 'file_uploaded', ${fileTitle}, ${fileDesc}, 'client')
    `;
  }

  // Send Telegram notification
  try {
    const [customer] = await sql`
      SELECT contact_name, company_name FROM customers WHERE id = ${customerId} LIMIT 1
    ` as Array<{ contact_name: string; company_name: string }>;

    let projectName = '';
    if (uploadProjectId) {
      const [proj] = await sql`SELECT name FROM client_projects WHERE id = ${uploadProjectId} LIMIT 1` as Array<{ name: string }>;
      projectName = proj?.name || '';
    }

    const { notifyTelegram } = await import('../../lib/telegram');
    await notifyTelegram(
      'Nuovo file caricato',
      `Cliente: ${customer?.company_name || customer?.contact_name}\nFile: ${uploadName}\nDimensione: ${formatBytes(uploadSize)}${projectName ? '\nProgetto: ' + projectName : ''}`
    );
  } catch { /* non-blocking */ }

  return c.json({ ok: true, id: upload?.id, key });
});

// ── Abort multipart upload ───────────────────────────────
uploadRoutes.post('/abort', portalAuth, async (c) => {
  const customerId = c.get('customer_id') as string;
  const { uploadId, key } = await c.req.json();

  if (!uploadId || !key) {
    fail('uploadId e key richiesti', 400);
  }

  const { abortMultipartUpload } = await import('../../lib/s4');
  await abortMultipartUpload(key, uploadId);

  await sql`
    UPDATE client_uploads SET status = 'failed'
    WHERE upload_id = ${uploadId} AND customer_id = ${customerId}
  `;

  return c.json({ ok: true });
});

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
