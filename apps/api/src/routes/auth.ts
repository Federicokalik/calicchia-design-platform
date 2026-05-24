import { Hono } from 'hono';
import bcrypt from 'bcrypt';
import { sql } from '../db';
import { signToken } from '../lib/jwt';
import { authMiddleware } from '../middleware/auth';
import { createRateLimit } from '../middleware/rate-limit';
import { adminMessage, isAdminLocale } from '../lib/admin-locale';
import { verifyTurnstileToken } from '../lib/turnstile';
import { getClientIp } from '../lib/client-ip';
import { generateTotpSecret, verifyTotp, otpauthUri } from '../lib/totp';
import { encryptSecret, decryptSecret } from '../lib/crypto';
import { randomBytes } from 'crypto';

export const auth = new Hono();

const loginRateLimit = createRateLimit(5, 15 * 60 * 1000);

// Cookie helpers from shared module
import { setAuthCookie, clearAuthCookie } from '../lib/cookies';

// POST /api/auth/login
auth.post('/login', loginRateLimit, async (c) => {
  const { email, password, turnstile_token, mfa_code } = await c.req.json();

  if (!email || !password) {
    return c.json({ error: adminMessage(c, 'emailPasswordRequired') }, 400);
  }

  // Anti-bot check before any DB lookup / bcrypt work.
  const turnstileOk = await verifyTurnstileToken(turnstile_token || '', {
    remoteIp: getClientIp(c) ?? undefined,
    expectedAction: 'admin_login',
  });
  if (!turnstileOk) {
    return c.json({ error: adminMessage(c, 'turnstileFailed') }, 403);
  }

  const rows = await sql`
    SELECT u.id, u.email, u.password_hash, u.role,
           u.mfa_secret, u.mfa_enabled, u.mfa_backup_codes,
           p.full_name, p.avatar_url, p.ui_locale
    FROM users u
    LEFT JOIN profiles p ON p.id = u.id
    WHERE u.email = ${email.toLowerCase().trim()}
    LIMIT 1
  `;

  const user = rows[0];

  if (!user) {
    return c.json({ error: adminMessage(c, 'invalidCredentials') }, 401);
  }

  const passwordValid = await bcrypt.compare(password, user.password_hash);
  if (!passwordValid) {
    return c.json({ error: adminMessage(c, 'invalidCredentials') }, 401);
  }

  if (user.role !== 'admin') {
    return c.json({ error: adminMessage(c, 'adminOnly') }, 403);
  }

  // MFA gate (SEC-06): when enabled, a valid TOTP or one-time backup code is
  // required. Step 1 (password only) replies { mfa_required: true } and sets
  // no cookie; the client resubmits with `mfa_code`.
  if (user.mfa_enabled) {
    const code = typeof mfa_code === 'string' ? mfa_code.trim() : '';
    if (!code) {
      return c.json({ mfa_required: true });
    }
    let mfaOk = false;
    if (user.mfa_secret && verifyTotp(decryptSecret(user.mfa_secret), code)) {
      mfaOk = true;
    } else {
      // Backup code — single use, consumed on match.
      const codes: string[] = Array.isArray(user.mfa_backup_codes) ? user.mfa_backup_codes : [];
      for (let i = 0; i < codes.length; i++) {
        if (await bcrypt.compare(code, codes[i])) {
          const remaining = codes.filter((_, idx) => idx !== i);
          await sql`UPDATE users SET mfa_backup_codes = ${sql.json(remaining)} WHERE id = ${user.id}`;
          mfaOk = true;
          break;
        }
      }
    }
    if (!mfaOk) {
      return c.json({ error: adminMessage(c, 'invalidCredentials') }, 401);
    }
  }

  const token = await signToken({
    sub: user.id,
    email: user.email,
    role: user.role,
  });

  setAuthCookie(c, token);

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      full_name: user.full_name,
      avatar_url: user.avatar_url,
      ui_locale: user.ui_locale || 'it',
      mfa_enabled: user.mfa_enabled === true,
    },
  });
});

// ─── MFA (TOTP) — SEC-06 ───────────────────────────────────────

// POST /api/auth/mfa/setup — start enrollment: generate a secret (not yet active).
auth.post('/mfa/setup', authMiddleware, async (c) => {
  const userId = (c as any).get('user')?.id as string | undefined;
  if (!userId) return c.json({ error: adminMessage(c, 'authRequired') }, 401);

  const [row] = await sql`SELECT email, mfa_enabled FROM users WHERE id = ${userId}`;
  if (!row) return c.json({ error: adminMessage(c, 'userNotFound') }, 404);
  if (row.mfa_enabled) return c.json({ error: 'MFA già attiva' }, 400);

  const secret = generateTotpSecret();
  await sql`UPDATE users SET mfa_secret = ${encryptSecret(secret)} WHERE id = ${userId}`;
  return c.json({
    secret,
    otpauth_uri: otpauthUri(secret, String(row.email), 'Caldes Admin'),
  });
});

// POST /api/auth/mfa/enable — verify the first code, activate MFA, return backup codes.
auth.post('/mfa/enable', authMiddleware, async (c) => {
  const userId = (c as any).get('user')?.id as string | undefined;
  if (!userId) return c.json({ error: adminMessage(c, 'authRequired') }, 401);

  const { code } = await c.req.json<{ code?: string }>();
  const [row] = await sql`SELECT mfa_secret, mfa_enabled FROM users WHERE id = ${userId}`;
  if (!row) return c.json({ error: adminMessage(c, 'userNotFound') }, 404);
  if (row.mfa_enabled) return c.json({ error: 'MFA già attiva' }, 400);
  if (!row.mfa_secret) return c.json({ error: 'Avvia prima il setup MFA' }, 400);
  if (!verifyTotp(decryptSecret(row.mfa_secret as string), String(code ?? ''))) {
    return c.json({ error: 'Codice non valido' }, 400);
  }

  // One-time backup codes — shown once, stored only as bcrypt hashes.
  const backupCodes = Array.from({ length: 10 }, () => randomBytes(5).toString('hex'));
  const hashed = await Promise.all(backupCodes.map((bc) => bcrypt.hash(bc, 12)));
  await sql`
    UPDATE users SET mfa_enabled = true, mfa_backup_codes = ${sql.json(hashed)}
    WHERE id = ${userId}
  `;
  return c.json({ enabled: true, backup_codes: backupCodes });
});

// POST /api/auth/mfa/disable — turn MFA off (requires a current TOTP code).
auth.post('/mfa/disable', authMiddleware, async (c) => {
  const userId = (c as any).get('user')?.id as string | undefined;
  if (!userId) return c.json({ error: adminMessage(c, 'authRequired') }, 401);

  const { code } = await c.req.json<{ code?: string }>();
  const [row] = await sql`SELECT mfa_secret, mfa_enabled FROM users WHERE id = ${userId}`;
  if (!row?.mfa_enabled) return c.json({ error: 'MFA non attiva' }, 400);
  if (!row.mfa_secret || !verifyTotp(decryptSecret(row.mfa_secret as string), String(code ?? ''))) {
    return c.json({ error: 'Codice non valido' }, 400);
  }

  await sql`
    UPDATE users SET mfa_enabled = false, mfa_secret = NULL, mfa_backup_codes = '[]'::jsonb
    WHERE id = ${userId}
  `;
  return c.json({ disabled: true });
});

// GET /api/auth/me — uses shared authMiddleware so future cookie/refresh logic
// (e.g., last-activity bump) automatically applies here too.
auth.get('/me', authMiddleware, async (c) => {
  const u = (c as any).get('user') as { id?: string } | undefined;
  const userId = u?.id;
  if (!userId) return c.json({ error: adminMessage(c, 'authRequired') }, 401);

  const rows = await sql`
    SELECT u.id, u.email, u.role, u.mfa_enabled, p.full_name, p.avatar_url, p.ui_locale
    FROM users u
    LEFT JOIN profiles p ON p.id = u.id
    WHERE u.id = ${userId}
    LIMIT 1
  `;

  const user = rows[0];
  if (!user) return c.json({ error: adminMessage(c, 'userNotFound') }, 404);
  user.ui_locale = user.ui_locale || 'it';
  return c.json({ user });
});

// PATCH /api/auth/me/locale — persist logged-in admin UI language.
auth.patch('/me/locale', authMiddleware, async (c) => {
  const u = (c as any).get('user') as { id?: string } | undefined;
  const userId = u?.id;
  if (!userId) return c.json({ error: adminMessage(c, 'authRequired') }, 401);

  const { locale } = await c.req.json<{ locale?: string }>();
  if (!isAdminLocale(locale)) {
    return c.json({ error: adminMessage(c, 'unsupportedLocale') }, 400);
  }

  const [profile] = await sql`
    UPDATE profiles
    SET ui_locale = ${locale}, updated_at = NOW()
    WHERE id = ${userId}
    RETURNING ui_locale
  `;

  return c.json({ locale: profile?.ui_locale || locale });
});

// POST /api/auth/logout
auth.post('/logout', (c) => {
  clearAuthCookie(c);
  return c.json({ success: true });
});

// POST /api/auth/keep-alive — refresh session (authMiddleware refreshes the cookie)
auth.post('/keep-alive', authMiddleware, (c) => c.json({ ok: true }));

// GET /api/auth/profile — get logged-in user's profile.
// Uses authMiddleware (role check + 30-min session timeout) instead of a manual
// jwtVerify, so it is consistent with every other protected route (SEC-12).
auth.get('/profile', authMiddleware, async (c) => {
  const user = (c as any).get('user') as { id: string };
  const rows = await sql`
    SELECT p.role_title, p.bio, p.socials
    FROM profiles p
    WHERE p.id = ${user.id}
    LIMIT 1
  `;
  return c.json({ profile: rows[0] || null });
});

// PUT /api/auth/profile — update logged-in user's profile.
// Only role_title/bio/socials are accepted (explicit allowlist, no mass-assign).
auth.put('/profile', authMiddleware, async (c) => {
  const user = (c as any).get('user') as { id: string };
  const { role_title, bio, socials } = await c.req.json();

  await sql`
    UPDATE profiles SET ${sql({
      role_title: role_title || null,
      bio: bio || null,
      socials: socials?.length > 0 ? socials : null,
    })}
    WHERE id = ${user.id}
  `;

  return c.json({ success: true });
});

// GET /api/auth/setup-status — check if first-time setup is needed
auth.get('/setup-status', async (c) => {
  const rows = await sql`SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin'`;
  const hasAdmin = (rows[0]?.count ?? 0) > 0;
  return c.json({ needs_setup: !hasAdmin });
});

// POST /api/auth/setup — create first admin (only works if no admins exist).
// BK-14: rate-limited like /login to blunt brute-force against the setup window.
auth.post('/setup', loginRateLimit, async (c) => {
  const { email, password, full_name } = await c.req.json();

  if (!email || !password) {
    return c.json({ error: adminMessage(c, 'emailPasswordRequired') }, 400);
  }

  if (password.length < 8) {
    return c.json({ error: 'La password deve avere almeno 8 caratteri' }, 400);
  }

  const password_hash = await bcrypt.hash(password, 12);
  const id = crypto.randomUUID();
  const emailNorm = email.toLowerCase().trim();

  // Atomic guard: insert only if no admin exists yet (prevents TOCTOU race)
  const inserted = await sql`
    INSERT INTO users (id, email, password_hash, full_name, role)
    SELECT ${id}, ${emailNorm}, ${password_hash}, ${full_name || null}, 'admin'
    WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')
    RETURNING id
  `;

  if (!inserted.length) {
    return c.json({ error: 'Setup già completato. Usa il login.' }, 403);
  }

  await sql`
    INSERT INTO profiles (id, email, full_name, role)
    VALUES (${id}, ${emailNorm}, ${full_name || null}, 'admin')
    ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, full_name = EXCLUDED.full_name, role = EXCLUDED.role
  `;

  const token = await signToken({ sub: id, email: emailNorm, role: 'admin' });
  setAuthCookie(c, token);

  return c.json({
    user: { id, email: emailNorm, role: 'admin', full_name: full_name || null, ui_locale: 'it' },
  }, 201);
});
