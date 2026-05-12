import { Hono } from 'hono';
import { sql } from '../../db';
import { encryptSecret } from '../../lib/mail/crypto';
import { testImapConnection } from '../../lib/mail/imap-client';
import { testSmtpConnection } from '../../lib/mail/smtp-client';
import { extractToken } from '../../middleware/auth';
import { jwtVerify } from 'jose';
import { getJwtSecret } from '../../lib/jwt';

export const mailAccounts = new Hono();

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

// GET /api/mail/accounts — list user's accounts (without secrets)
mailAccounts.get('/', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const accounts = await sql`
    SELECT id, email, display_name, imap_host, imap_port, imap_secure,
           smtp_host, smtp_port, smtp_secure, username, active,
           last_sync_at, last_error, sent_folder, created_at
    FROM email_accounts
    WHERE user_id = ${userId}
    ORDER BY created_at ASC
  `;
  return c.json({ accounts });
});

// POST /api/mail/accounts/test — dry-run test IMAP + SMTP before save
mailAccounts.post('/test', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const body = await c.req.json();
  const { imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password } = body;

  if (!imap_host || !smtp_host || !username || !password) {
    return c.json({ error: 'Parametri IMAP/SMTP/credenziali richiesti' }, 400);
  }

  // Encrypt may throw if MAIL_ENC_KEY is missing — surface a clear error
  let passwordBlob;
  try {
    passwordBlob = encryptSecret(password);
  } catch (err) {
    return c.json({
      error: 'MAIL_ENC_KEY non configurata. Aggiungila al .env e riavvia apps/api.',
      detail: (err as Error).message,
    }, 500);
  }

  try {
    const [imap, smtp] = await Promise.all([
      testImapConnection({
        host: imap_host,
        port: imap_port ?? 993,
        secure: imap_secure ?? true,
        username,
        passwordBlob,
      }),
      testSmtpConnection({
        host: smtp_host,
        port: smtp_port ?? 465,
        secure: smtp_secure ?? true,
        username,
        passwordBlob,
      }),
    ]);

    return c.json({
      imap,
      smtp,
      ok: imap.ok && smtp.ok,
    });
  } catch (err) {
    return c.json({
      error: `Test fallito: ${(err as Error).message}`,
    }, 500);
  }
});

// POST /api/mail/accounts — create account (credentials encrypted)
mailAccounts.post('/', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const body = await c.req.json();
  const {
    email, display_name,
    imap_host, imap_port, imap_secure,
    smtp_host, smtp_port, smtp_secure,
    username, password,
  } = body;

  if (!email || !imap_host || !smtp_host || !username || !password) {
    return c.json({ error: 'email, imap_host, smtp_host, username, password richiesti' }, 400);
  }

  const passwordBlob = encryptSecret(password);

  const [row] = await sql`
    INSERT INTO email_accounts (
      user_id, email, display_name,
      imap_host, imap_port, imap_secure,
      smtp_host, smtp_port, smtp_secure,
      username, password_enc, password_iv, password_tag
    ) VALUES (
      ${userId}, ${email.toLowerCase().trim()}, ${display_name || null},
      ${imap_host}, ${imap_port ?? 993}, ${imap_secure ?? true},
      ${smtp_host}, ${smtp_port ?? 465}, ${smtp_secure ?? true},
      ${username}, ${passwordBlob.cipher}, ${passwordBlob.iv}, ${passwordBlob.tag}
    )
    ON CONFLICT (user_id, email) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      imap_host = EXCLUDED.imap_host,
      imap_port = EXCLUDED.imap_port,
      imap_secure = EXCLUDED.imap_secure,
      smtp_host = EXCLUDED.smtp_host,
      smtp_port = EXCLUDED.smtp_port,
      smtp_secure = EXCLUDED.smtp_secure,
      username = EXCLUDED.username,
      password_enc = EXCLUDED.password_enc,
      password_iv = EXCLUDED.password_iv,
      password_tag = EXCLUDED.password_tag,
      active = true,
      updated_at = now()
    RETURNING id, email, display_name, imap_host, imap_port, imap_secure,
              smtp_host, smtp_port, smtp_secure, username, active, created_at
  `;

  return c.json({ account: row }, 201);
});

// DELETE /api/mail/accounts/:id — remove account + cascade cleans messages
mailAccounts.delete('/:id', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const id = c.req.param('id');
  const res = await sql`
    DELETE FROM email_accounts
    WHERE id = ${id} AND user_id = ${userId}
    RETURNING id
  `;
  if (res.length === 0) return c.json({ error: 'Account non trovato' }, 404);
  return c.json({ success: true });
});
