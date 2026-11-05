import { Hono, type Context } from 'hono';
import { jwtVerify } from 'jose';
import { extractToken } from '../../middleware/auth';
import { getJwtSecret } from '../../lib/jwt';
import {
  ATTACHMENT_FIELD_HINTS,
  describeAttachment,
  resolveAttachments,
  type InlineFileInput,
} from '../../lib/mail/attachments';
import { MESSAGE_FIELD_HINTS, sendMailSchema } from '../../lib/mail/message-schema';
import { MailDeliveryError, loadOutboundAccount, sendFromAccount, type SentCopyResult } from '../../lib/mail/outbound';
import { fieldError, parseOr400 } from '../../lib/validation';

export const mailSend = new Hono();

async function getUserId(c: Context): Promise<string | null> {
  const token = extractToken(c);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    return payload.sub as string;
  } catch {
    return null;
  }
}

const SEND_HINTS = { ...ATTACHMENT_FIELD_HINTS, ...MESSAGE_FIELD_HINTS };

/** Campi multipart che possono ripetersi (un valore per indirizzo / riferimento). */
const MULTI_VALUE_FIELDS = new Set(['to', 'cc', 'bcc', 'references']);

class UnsupportedMediaType extends Error {}

/**
 * Body JSON oppure multipart/form-data:
 *  - campi testuali con gli stessi nomi del JSON (to/cc/bcc/references
 *    ripetibili o separati da virgola);
 *  - `attachments`: file (uno per voce) e/o riferimenti JSON
 *    ({"media_id": ...} / {"url": ...}, oggetto o array).
 * Ogni altro content-type → 415.
 */
async function readSendBody(c: Context): Promise<{ body: Record<string, unknown>; files: InlineFileInput[] }> {
  const type = (c.req.header('content-type') || '').split(';')[0].trim().toLowerCase();

  if (type === 'application/json' || type.endsWith('+json')) {
    const body = await c.req.json().catch(() => {
      throw fieldError([], 'JSON non valido');
    });
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw fieldError([], 'il body deve essere un oggetto JSON');
    return { body: body as Record<string, unknown>, files: [] };
  }

  if (type === 'multipart/form-data') {
    const form = await c.req.formData().catch(() => {
      throw fieldError([], 'multipart/form-data non valido');
    });
    const body: Record<string, unknown> = {};
    const files: InlineFileInput[] = [];
    const refs: unknown[] = [];
    for (const [rawKey, value] of form.entries()) {
      const key = rawKey.replace(/\[\]$/, '');
      if (key === 'attachments') {
        if (typeof value === 'string') {
          let parsed: unknown;
          try {
            parsed = JSON.parse(value);
          } catch {
            throw fieldError(['attachments'], 'i valori testuali di attachments devono essere riferimenti JSON, es. {"media_id": "..."}');
          }
          refs.push(...(Array.isArray(parsed) ? parsed : [parsed]));
        } else {
          files.push({ filename: value.name, contentType: value.type || undefined, buffer: Buffer.from(await value.arrayBuffer()) });
        }
        continue;
      }
      if (typeof value !== 'string') {
        // File in un campo diverso da attachments: lo segnala lo schema strict.
        body[key] = '[file]';
        continue;
      }
      if (MULTI_VALUE_FIELDS.has(key)) {
        const prev = body[key];
        body[key] = prev === undefined ? value : [...(Array.isArray(prev) ? prev : [prev]), value];
      } else if (key in body) {
        throw fieldError([key], 'campo ripetuto');
      } else {
        body[key] = value;
      }
    }
    if (refs.length) body.attachments = refs;
    return { body, files };
  }

  throw new UnsupportedMediaType(type || '(assente)');
}

function presentSentCopy(copy: SentCopyResult): Record<string, unknown> {
  return { ...copy };
}

// POST /api/mail/send — invio SMTP dalla casella collegata, con allegati e copia in Inviati.
// JSON: { account_id, to, cc?, bcc?, subject, text?|html?, in_reply_to?, references?, reply_to?,
//         attachments?: [{ filename, content (base64), contentType? } | { media_id, filename? } | { url, filename? }] }
mailSend.post('/', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  let raw: Awaited<ReturnType<typeof readSendBody>>;
  try {
    raw = await readSendBody(c);
  } catch (err) {
    if (err instanceof UnsupportedMediaType) {
      return c.json({ error: `Content-Type non supportato (${err.message}): usa application/json oppure multipart/form-data` }, 415);
    }
    throw err;
  }

  const body = parseOr400(sendMailSchema, raw.body, SEND_HINTS);
  const attachments = await resolveAttachments([...(body.attachments ?? []), ...raw.files]);

  const account = await loadOutboundAccount(userId, body.account_id);
  if (!account) return c.json({ error: 'Account non trovato' }, 404);

  try {
    const result = await sendFromAccount(account, {
      to: body.to,
      cc: body.cc,
      bcc: body.bcc,
      subject: body.subject,
      text: body.text,
      html: body.html,
      inReplyTo: body.in_reply_to ?? undefined,
      references: body.references ?? undefined,
      replyTo: body.reply_to,
      attachments,
    });
    return c.json({
      success: true,
      message_id: result.messageId,
      accepted: result.accepted,
      rejected: result.rejected,
      attachments: attachments.map(describeAttachment),
      sent_copy: presentSentCopy(result.sentCopy),
    });
  } catch (err) {
    if (err instanceof MailDeliveryError) return c.json({ error: `Invio fallito: ${err.message}` }, 502);
    throw err;
  }
});
