import { Hono } from 'hono';
import { sql } from '../../db';
import { sendMail } from '../../lib/mail/smtp-client';
import { extractToken } from '../../middleware/auth';
import { jwtVerify } from 'jose';
import { getJwtSecret } from '../../lib/jwt';

export const mailSend = new Hono();

async function getUserId(c: any): Promise<string | null> {
  const token = extractToken(c);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    return payload.sub as string;
  } catch {
    return null;
  }
}

// POST /api/mail/send — send email via SMTP
// Body: { account_id, to, cc?, bcc?, subject, text?, html?, in_reply_to?, references? }
mailSend.post('/', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const body = await c.req.json();
  const { account_id, to, cc, bcc, subject, text, html, in_reply_to, references } = body;

  if (!account_id || !to || !subject || (!text && !html)) {
    return c.json({ error: 'account_id, to, subject, text|html richiesti' }, 400);
  }

  const [acc] = await sql<Array<{
    id: string; email: string; display_name: string | null;
    smtp_host: string; smtp_port: number; smtp_secure: boolean;
    username: string; password_enc: Buffer; password_iv: Buffer; password_tag: Buffer;
  }>>`
    SELECT id, email, display_name, smtp_host, smtp_port, smtp_secure,
           username, password_enc, password_iv, password_tag
    FROM email_accounts
    WHERE id = ${account_id} AND user_id = ${userId} AND active = true
    LIMIT 1
  `;
  if (!acc) return c.json({ error: 'Account non trovato' }, 404);

  const from = acc.display_name ? `"${acc.display_name}" <${acc.email}>` : acc.email;

  try {
    const result = await sendMail(
      {
        host: acc.smtp_host,
        port: acc.smtp_port,
        secure: acc.smtp_secure,
        username: acc.username,
        passwordBlob: { cipher: acc.password_enc, iv: acc.password_iv, tag: acc.password_tag },
      },
      {
        from,
        to: Array.isArray(to) ? to : [to],
        cc: cc || undefined,
        bcc: bcc || undefined,
        subject,
        text: text || undefined,
        html: html || undefined,
        inReplyTo: in_reply_to || undefined,
        references: references || undefined,
      },
    );
    return c.json({ success: true, message_id: result.messageId });
  } catch (err) {
    return c.json({ error: `Invio fallito: ${(err as Error).message}` }, 500);
  }
});
