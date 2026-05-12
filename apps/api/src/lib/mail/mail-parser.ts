/**
 * Parse raw RFC822 → structured fields + sanitized HTML.
 */
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import sanitizeHtml from 'sanitize-html';

export interface ParsedMessage {
  messageId: string | null;
  inReplyTo: string | null;
  threadId: string | null;
  fromAddr: string | null;
  fromName: string | null;
  toAddrs: Array<{ address: string; name: string }>;
  ccAddrs: Array<{ address: string; name: string }>;
  subject: string | null;
  receivedAt: Date | null;
  text: string | null;
  html: string | null;
  snippet: string;
  attachments: Array<{
    filename: string;
    contentType: string;
    size: number;
    content: Buffer;
  }>;
  /** Extracted header signals used by the classifier. */
  classifierSignals: {
    listUnsubscribe: boolean;
    precedence: string | null;
    autoSubmitted: string | null;
    priority: string | null;
  };
}

function normalizeAddresses(addr: AddressObject | AddressObject[] | undefined): Array<{ address: string; name: string }> {
  if (!addr) return [];
  const list = Array.isArray(addr) ? addr : [addr];
  const out: Array<{ address: string; name: string }> = [];
  for (const a of list) {
    for (const v of a.value) {
      if (v.address) out.push({ address: v.address.toLowerCase(), name: v.name || '' });
    }
  }
  return out;
}

function extractSnippet(text: string | null, html: string | null): string {
  const raw = text || (html ? html.replace(/<[^>]+>/g, ' ') : '');
  return raw.replace(/\s+/g, ' ').trim().slice(0, 200);
}

const SAFE_HTML_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'a', 'b', 'i', 'em', 'strong', 'p', 'br', 'div', 'span', 'ul', 'ol', 'li', 'blockquote',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'code', 'hr',
    'table', 'thead', 'tbody', 'tr', 'td', 'th',
    'img', 'figure', 'figcaption',
  ],
  allowedAttributes: {
    a: ['href', 'name', 'target', 'rel', 'title'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    '*': ['style'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel', 'cid', 'data'],
  allowedSchemesAppliedToAttributes: ['href', 'src', 'cite'],
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' },
    }),
  },
};

export function sanitizeMailHtml(html: string): string {
  return sanitizeHtml(html, SAFE_HTML_OPTIONS);
}

function readHeader(headers: Map<string, unknown>, key: string): string | null {
  const v = headers.get(key);
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => String(x)).join(' ');
  return String(v);
}

export async function parseRawMail(raw: Buffer | string): Promise<ParsedMessage> {
  const parsed: ParsedMail = await simpleParser(raw);

  const from = parsed.from?.value?.[0];
  const toAddrs = normalizeAddresses(parsed.to);
  const ccAddrs = normalizeAddresses(parsed.cc);

  const html = parsed.html ? sanitizeMailHtml(parsed.html) : null;
  const text = parsed.text || null;

  const inReplyTo = Array.isArray(parsed.inReplyTo) ? parsed.inReplyTo[0] : parsed.inReplyTo || null;
  const references = parsed.references
    ? Array.isArray(parsed.references) ? parsed.references : [parsed.references]
    : [];
  const threadId = references[0] || inReplyTo || parsed.messageId || null;

  const headers = parsed.headers as Map<string, unknown>;
  const classifierSignals = {
    listUnsubscribe: headers.has('list-unsubscribe'),
    precedence: readHeader(headers, 'precedence'),
    autoSubmitted: readHeader(headers, 'auto-submitted'),
    priority:
      readHeader(headers, 'x-priority') ||
      readHeader(headers, 'priority') ||
      readHeader(headers, 'importance'),
  };

  return {
    messageId: parsed.messageId || null,
    inReplyTo,
    threadId,
    fromAddr: from?.address?.toLowerCase() || null,
    fromName: from?.name || null,
    toAddrs,
    ccAddrs,
    subject: parsed.subject || null,
    receivedAt: parsed.date || null,
    text,
    html,
    snippet: extractSnippet(text, html),
    attachments: (parsed.attachments || []).map((a) => ({
      filename: a.filename || 'attachment',
      contentType: a.contentType || 'application/octet-stream',
      size: a.size || 0,
      content: a.content,
    })),
    classifierSignals,
  };
}
