import { Hono, type Context } from 'hono';
import { jwtVerify } from 'jose';
import { sql } from '../../db';
import { extractToken } from '../../middleware/auth';
import { getJwtSecret } from '../../lib/jwt';
import { ATTACHMENT_FIELD_HINTS, resolveAttachments } from '../../lib/mail/attachments';
import { createDraftSchema, DRAFT_FIELD_HINTS } from '../../lib/mail/message-schema';
import { draftColumns, createDraft, deleteDraft, presentDraft, resolveReplyTarget, type DraftRow } from '../../lib/mail/drafts';
import { loadOutboundAccount } from '../../lib/mail/outbound';
import { fieldError, parseOr400 } from '../../lib/validation';

export const mailDrafts = new Hono();

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

// GET /api/mail/drafts?pending=1 — list pending drafts for user
mailDrafts.get('/', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const pendingOnly = c.req.query('pending') === '1';
  const filter = pendingOnly ? sql`AND sent_at IS NULL` : sql``;

  const drafts = await sql<DraftRow[]>`
    SELECT ${draftColumns()}
    FROM email_drafts
    WHERE user_id = ${userId}
    ${filter}
    ORDER BY created_at DESC
    LIMIT 50
  `;
  return c.json({ drafts: drafts.map(presentDraft) });
});

// POST /api/mail/drafts — crea una bozza, anche con allegati (stesso schema di /api/mail/send).
// Body: { account_id?, to?, cc?, subject?, text?, reply_to_email_id?, attachments? }
mailDrafts.post('/', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const raw = await c.req.json().catch(() => {
    throw fieldError([], 'JSON non valido');
  });
  const body = parseOr400(createDraftSchema, raw, { ...ATTACHMENT_FIELD_HINTS, ...DRAFT_FIELD_HINTS });
  const attachments = await resolveAttachments(body.attachments ?? []);

  const account = await loadOutboundAccount(userId, body.account_id);
  if (!account) return c.json({ error: body.account_id ? 'Account non trovato' : 'Nessuna casella email configurata' }, 404);

  const reply = await resolveReplyTarget(userId, body.reply_to_email_id);
  const draft = await createDraft({
    userId,
    accountId: account.id,
    to: body.to ?? [],
    cc: body.cc ?? [],
    subject: body.subject ?? null,
    body: body.text ?? null,
    ...reply,
    source: reply.replyToMessageId ? 'reply' : 'manual',
    attachments,
  });
  return c.json({ draft: presentDraft(draft) }, 201);
});

// GET /api/mail/drafts/:id — single draft
mailDrafts.get('/:id', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const id = c.req.param('id');
  const [draft] = await sql<DraftRow[]>`
    SELECT ${draftColumns()}
    FROM email_drafts
    WHERE id = ${id} AND user_id = ${userId}
    LIMIT 1
  `;
  if (!draft) return c.json({ error: 'Bozza non trovata' }, 404);
  return c.json({ draft: presentDraft(draft) });
});

// DELETE /api/mail/drafts/:id — rimuove anche i file allegati
mailDrafts.delete('/:id', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const deleted = await deleteDraft(userId, c.req.param('id'));
  if (!deleted) return c.json({ error: 'Bozza non trovata' }, 404);
  return c.json({ success: true });
});

// POST /api/mail/drafts/:id/mark-sent — flag a draft as sent (after SMTP send)
mailDrafts.post('/:id/mark-sent', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const id = c.req.param('id');
  await sql`
    UPDATE email_drafts SET sent_at = now()
    WHERE id = ${id} AND user_id = ${userId}
  `;
  return c.json({ success: true });
});
