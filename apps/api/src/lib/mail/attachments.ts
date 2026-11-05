/**
 * Allegati delle email in uscita (POST /api/mail/send, bozze, tool MCP
 * send_email e draft_email).
 *
 * Tre modi di indicare un allegato, esattamente uno per elemento:
 *  - `content`: base64 inline (con `filename`), utile per file piccoli. Da un
 *    LLM costa molti token: oltre qualche decina di KB conviene un riferimento;
 *  - `media_id`: la `key` di un file della libreria /api/media
 *    (es. "uploads/1730000000000-ab12cd-proforma.pdf");
 *  - `url`: URL interno, cioè "/media/<key>" (anche assoluto sull'origine
 *    dell'API) oppure un URL firmato "/api/files/<categoria>/<nome>?exp&sig"
 *    (preventivi, ricevute, allegati delle bozze). Nessun fetch verso l'esterno:
 *    ogni altro URL è rifiutato (niente SSRF).
 *
 * Controlli: base64 valido, nome file senza percorsi né caratteri di
 * controllo, tipo MIME consentito e coerente con estensione e contenuto
 * (magic bytes), al massimo 10 MB per file, 20 MB in totale e 10 allegati.
 * Ogni errore è un 400 sul campo (`attachments.<i>.<campo>`).
 */
import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import { z } from 'zod';
import { mediaFileSize, readMediaFile } from '../s3';
import { parseSignedFileUrl, readPrivateFile } from '../private-files';
import { RequestValidationError, type ValidationDetail } from '../validation';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
const MAX_FILENAME_LENGTH = 180;

interface MimeRule {
  exts: string[];
  /** Verifica del contenuto: magic bytes per i binari, assenza di NUL per i testi. */
  matches: (buf: Buffer) => boolean;
}

const startsWith = (buf: Buffer, bytes: number[]) => bytes.every((b, i) => buf[i] === b);
const isZip = (buf: Buffer) => startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buf, [0x50, 0x4b, 0x05, 0x06]);
const isText = (buf: Buffer) => !buf.includes(0);

/** Tipi consentiti. SVG, HTML ed eseguibili esclusi di proposito. */
export const ALLOWED_ATTACHMENT_TYPES: Readonly<Record<string, MimeRule>> = {
  'application/pdf': { exts: ['.pdf'], matches: (b) => b.subarray(0, 1024).includes(Buffer.from('%PDF-')) },
  'image/png': { exts: ['.png'], matches: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  'image/jpeg': { exts: ['.jpg', '.jpeg'], matches: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  'image/webp': { exts: ['.webp'], matches: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  'application/zip': { exts: ['.zip'], matches: isZip },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { exts: ['.docx'], matches: isZip },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { exts: ['.xlsx'], matches: isZip },
  'text/plain': { exts: ['.txt'], matches: isText },
  'text/csv': { exts: ['.csv'], matches: isText },
};

const MIME_ALIASES: Readonly<Record<string, string>> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'application/x-zip-compressed': 'application/zip',
  'application/x-zip': 'application/zip',
  'application/csv': 'text/csv',
  'text/comma-separated-values': 'text/csv',
  'application/x-pdf': 'application/pdf',
};

const MIME_BY_EXT: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ALLOWED_ATTACHMENT_TYPES).flatMap(([mime, rule]) => rule.exts.map((ext) => [ext, mime])),
);

const ALLOWED_LIST = 'pdf, png, jpg, webp, zip, docx, xlsx, txt, csv';

/** Allegato in ingresso (JSON). Esattamente uno fra content, media_id e url. */
export const attachmentInputSchema = z
  .object({
    filename: z.string().optional(),
    contentType: z.string().optional(),
    encoding: z.literal('base64', { errorMap: () => ({ message: 'solo "base64" è supportato' }) }).optional(),
    content: z.string().optional(),
    media_id: z.string().optional(),
    url: z.string().optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    const sources = (['content', 'media_id', 'url'] as const).filter((k) => a[k] !== undefined);
    if (sources.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: sources.length ? [sources[1]] : [],
        message: sources.length
          ? `indica uno solo fra content, media_id e url (trovati: ${sources.join(', ')})`
          : 'indica esattamente uno fra content (base64), media_id e url',
      });
    }
    if (a.content !== undefined && !a.filename) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filename'], message: 'obbligatorio con content (base64)' });
    }
  });

export type AttachmentInput = z.infer<typeof attachmentInputSchema>;

/** Suggerimenti per i nomi di campo sbagliati più frequenti negli allegati. */
export const ATTACHMENT_FIELD_HINTS: Readonly<Record<string, string>> = {
  content_type: 'contentType',
  mime_type: 'contentType',
  mimeType: 'contentType',
  type: 'contentType',
  name: 'filename',
  file_name: 'filename',
  data: 'content',
  base64: 'content',
  mediaId: 'media_id',
  key: 'media_id',
  href: 'url',
  path: 'media_id o url',
};

/** File già in memoria (campo file di una richiesta multipart). */
export interface InlineFileInput {
  filename: string;
  contentType?: string;
  buffer: Buffer;
}

export interface ResolvedAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  size: number;
  sha256: string;
  source: 'inline' | 'media' | 'private';
}

/** Metadati pubblici di un allegato (risposte API). */
export function describeAttachment(a: ResolvedAttachment): { filename: string; content_type: string; size: number } {
  return { filename: a.filename, content_type: a.contentType, size: a.size };
}

class AttachmentFieldError extends Error {
  constructor(readonly field: string | null, message: string) {
    super(message);
  }
}

function fail(field: string | null, message: string): never {
  throw new AttachmentFieldError(field, message);
}

/** Nome file sicuro: niente percorsi, caratteri di controllo, nomi nascosti o vuoti. */
export function sanitizeFilename(raw: string, field = 'filename'): string {
  const name = raw.normalize('NFC').trim();
  if (!name) fail(field, 'non può essere vuoto');
  if (/[/\\]/.test(name)) fail(field, 'non può contenere percorsi ("/" o "\\")');
  // eslint-disable-next-line no-control-regex -- è proprio ciò che va escluso
  if (/[\u0000-\u001f\u007f]/.test(name)) fail(field, 'contiene caratteri di controllo');
  if (name === '.' || name === '..' || name.startsWith('.')) fail(field, 'nome non valido (inizia con un punto)');
  if (name.length > MAX_FILENAME_LENGTH) {
    const ext = extname(name);
    return name.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
  }
  return name;
}

function normalizeMime(raw: string): string {
  const mime = raw.split(';')[0].trim().toLowerCase();
  return MIME_ALIASES[mime] ?? mime;
}

/** Decodifica base64 standard (spazi e a capo ammessi, data URL ammesso) rifiutando input non validi. */
function decodeBase64(raw: string): { buffer: Buffer; dataUrlMime?: string } {
  let value = raw;
  let dataUrlMime: string | undefined;
  const dataUrl = /^data:([^;,]+)?(?:;[^,]*)?;base64,/i.exec(value);
  if (dataUrl) {
    dataUrlMime = dataUrl[1];
    value = value.slice(dataUrl[0].length);
  }
  value = value.replace(/\s+/g, '');
  if (!value) fail('content', 'contenuto vuoto');
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    fail('content', 'non è base64 valido (alfabeto standard A-Z a-z 0-9 + / con padding =)');
  }
  // Controllo della dimensione prima di allocare il buffer.
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const bytes = (value.length / 4) * 3 - padding;
  if (bytes > MAX_ATTACHMENT_BYTES) fail('content', `allegato troppo grande: ${formatMb(bytes)}, massimo 10 MB per file`);
  return { buffer: Buffer.from(value, 'base64'), dataUrlMime };
}

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Chiave della libreria media: percorso relativo, senza traversal. */
function validateMediaKey(raw: string, field: string): string {
  const key = raw.trim().replace(/^\/+/, '');
  if (!key) fail(field, 'non può essere vuoto');
  if (/\\/.test(key) || key.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) {
    fail(field, 'percorso non valido');
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(key)) fail(field, 'contiene caratteri non ammessi');
  return key;
}

async function readMedia(key: string, field: string): Promise<Buffer> {
  const size = await mediaFileSize(key);
  if (size === null) fail(field, `file "${key}" non trovato nella libreria media`);
  if (size > MAX_ATTACHMENT_BYTES) fail(field, `allegato troppo grande: ${formatMb(size)}, massimo 10 MB per file`);
  return readMediaFile(key);
}

/** "uploads/1730000000000-ab12cd-proforma.pdf" → "proforma.pdf" (nome generato da generateFileKey). */
function filenameFromKey(key: string): string {
  return basename(key).replace(/^\d{10,}-[a-z0-9]{4,8}-/, '');
}

function apiOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const raw of [process.env.API_URL, process.env.PUBLIC_API_URL, 'http://localhost:3001']) {
    if (!raw) continue;
    try {
      origins.add(new URL(raw).origin);
    } catch {
      /* ignora valori non validi */
    }
  }
  return origins;
}

/** Risolve un URL interno: /media/<key> oppure /api/files/<cat>/<nome> firmato. Mai fetch. */
async function readInternalUrl(raw: string): Promise<{ buffer: Buffer; name: string; source: 'media' | 'private' }> {
  let url: URL;
  try {
    url = new URL(raw, 'http://relative.invalid');
  } catch {
    fail('url', 'URL non valido');
  }
  const relative = url.origin === 'http://relative.invalid' && raw.startsWith('/');
  if (!relative && !apiOrigins().has(url.origin)) {
    fail('url', 'sono ammessi solo URL interni del gestionale (/media/... o /api/files/... firmati): nessun download da siti esterni');
  }
  if (url.pathname.startsWith('/media/')) {
    const key = validateMediaKey(decodeURIComponent(url.pathname.slice('/media/'.length)), 'url');
    return { buffer: await readMedia(key, 'url'), name: filenameFromKey(key), source: 'media' };
  }
  if (url.pathname.startsWith('/api/files/')) {
    const ref = parseSignedFileUrl(url);
    if (!ref) fail('url', 'URL firmato non valido o scaduto');
    try {
      const buffer = await readPrivateFile(ref.category, ref.name);
      if (buffer.length > MAX_ATTACHMENT_BYTES) fail('url', `allegato troppo grande: ${formatMb(buffer.length)}, massimo 10 MB per file`);
      return { buffer, name: ref.name, source: 'private' };
    } catch (err) {
      if (err instanceof AttachmentFieldError) throw err;
      fail('url', 'file non trovato');
    }
  }
  fail('url', 'sono ammessi solo /media/<file> della libreria media o URL firmati /api/files/...');
}

/** Tipo MIME finale, coerente con estensione e contenuto. Aggiunge l'estensione se manca. */
function finalizeType(filename: string, declared: string | undefined, buffer: Buffer): { filename: string; contentType: string } {
  const ext = extname(filename).toLowerCase();
  let mime = declared ? normalizeMime(declared) : undefined;
  // application/octet-stream (browser, multipart) non dice nulla: decide l'estensione.
  if (mime === 'application/octet-stream') mime = undefined;
  if (mime && !ALLOWED_ATTACHMENT_TYPES[mime]) {
    fail('contentType', `tipo "${mime}" non consentito: ammessi ${ALLOWED_LIST}`);
  }
  if (!mime) {
    mime = MIME_BY_EXT[ext];
    if (!mime) fail('filename', `tipo di file "${ext || 'senza estensione'}" non consentito: ammessi ${ALLOWED_LIST}`);
  }
  const rule = ALLOWED_ATTACHMENT_TYPES[mime];
  let name = filename;
  if (!ext) name = `${filename}${rule.exts[0]}`;
  else if (!rule.exts.includes(ext)) {
    fail('filename', `estensione "${ext}" incoerente con il tipo ${mime} (atteso ${rule.exts.join(' o ')})`);
  }
  if (!rule.matches(buffer)) fail('content', `il contenuto non corrisponde al tipo ${mime}`);
  return { filename: name, contentType: mime };
}

async function resolveOne(input: AttachmentInput | InlineFileInput): Promise<ResolvedAttachment> {
  let buffer: Buffer;
  let suggestedName: string | undefined;
  let declaredType = input.contentType;
  let source: ResolvedAttachment['source'] = 'inline';

  if ('buffer' in input) {
    buffer = input.buffer;
    suggestedName = input.filename;
    if (buffer.length > MAX_ATTACHMENT_BYTES) fail('content', `allegato troppo grande: ${formatMb(buffer.length)}, massimo 10 MB per file`);
  } else if (input.content !== undefined) {
    const decoded = decodeBase64(input.content);
    buffer = decoded.buffer;
    declaredType ??= decoded.dataUrlMime;
  } else if (input.media_id !== undefined) {
    const key = validateMediaKey(input.media_id, 'media_id');
    buffer = await readMedia(key, 'media_id');
    suggestedName = filenameFromKey(key);
    source = 'media';
  } else {
    const internal = await readInternalUrl(input.url!);
    buffer = internal.buffer;
    suggestedName = internal.name;
    source = internal.source;
  }

  if (!buffer.length) fail('content', 'file vuoto');
  const rawName = ('buffer' in input ? undefined : input.filename) ?? suggestedName;
  if (!rawName) fail('filename', 'obbligatorio');
  const filename = sanitizeFilename(rawName);
  const typed = finalizeType(filename, declaredType, buffer);
  return {
    filename: typed.filename,
    contentType: typed.contentType,
    content: buffer,
    size: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    source,
  };
}

/**
 * Risolve e valida gli allegati. Gli errori diventano un 400 con il percorso
 * del campo (`<pathPrefix>.<i>.<campo>`, es. attachments.0.media_id).
 */
export async function resolveAttachments(
  inputs: ReadonlyArray<AttachmentInput | InlineFileInput>,
  pathPrefix: Array<string | number> = ['attachments'],
): Promise<ResolvedAttachment[]> {
  if (inputs.length > MAX_ATTACHMENTS) {
    throw new RequestValidationError([{ path: pathPrefix, message: `al massimo ${MAX_ATTACHMENTS} allegati` }]);
  }
  const resolved: ResolvedAttachment[] = [];
  const details: ValidationDetail[] = [];
  for (const [i, input] of inputs.entries()) {
    try {
      resolved.push(await resolveOne(input));
    } catch (err) {
      if (!(err instanceof AttachmentFieldError)) throw err;
      details.push({ path: [...pathPrefix, i, ...(err.field ? [err.field] : [])], message: err.message });
    }
  }
  if (details.length) throw new RequestValidationError(details, 'Allegati non validi');
  const total = resolved.reduce((n, a) => n + a.size, 0);
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new RequestValidationError(
      [{ path: pathPrefix, message: `allegati troppo grandi in totale: ${formatMb(total)}, massimo 20 MB` }],
      'Allegati non validi',
    );
  }
  return resolved;
}
