import { Hono } from 'hono';
import { jwtVerify } from 'jose';
import bcrypt from 'bcrypt';
import { sql } from '../db';
import { getJwtSecret, signToken } from '../lib/jwt';
import { authMiddleware, extractToken } from '../middleware/auth';
import { createRateLimit } from '../middleware/rate-limit';
import { adminMessage, isAdminLocale } from '../lib/admin-locale';

export const auth = new Hono();

const loginRateLimit = createRateLimit(5, 15 * 60 * 1000);

// Cookie helpers from shared module
import { setAuthCookie, clearAuthCookie } from '../lib/cookies';

// POST /api/auth/login
auth.post('/login', loginRateLimit, async (c) => {
  const { email, password } = await c.req.json();

  if (!email || !password) {
    return c.json({ error: adminMessage(c, 'emailPasswordRequired') }, 400);
  }

  const rows = await sql`
    SELECT u.id, u.email, u.password_hash, u.role,
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
    },
  });
});

// GET /api/auth/me — uses shared authMiddleware so future cookie/refresh logic
// (e.g., last-activity bump) automatically applies here too.
auth.get('/me', authMiddleware, async (c) => {
  const u = (c as any).get('user') as { id?: string } | undefined;
  const userId = u?.id;
  if (!userId) return c.json({ error: adminMessage(c, 'authRequired') }, 401);

  const rows = await sql`
    SELECT u.id, u.email, u.role, p.full_name, p.avatar_url, p.ui_locale
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

// GET /api/auth/profile — get logged-in user's profile
auth.get('/profile', async (c) => {
  const token = extractToken(c);
  if (!token) {
    return c.json({ error: adminMessage(c, 'authRequired') }, 401);
  }

  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    const rows = await sql`
      SELECT p.role_title, p.bio, p.socials
      FROM profiles p
      WHERE p.id = ${payload.sub as string}
      LIMIT 1
    `;
    return c.json({ profile: rows[0] || null });
  } catch {
    return c.json({ error: adminMessage(c, 'invalidToken') }, 401);
  }
});

// PUT /api/auth/profile — update logged-in user's profile
auth.put('/profile', async (c) => {
  const token = extractToken(c);
  if (!token) {
    return c.json({ error: adminMessage(c, 'authRequired') }, 401);
  }

  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    const { role_title, bio, socials } = await c.req.json();

    await sql`
      UPDATE profiles SET ${sql({
        role_title: role_title || null,
        bio: bio || null,
        socials: socials?.length > 0 ? socials : null,
      })}
      WHERE id = ${payload.sub as string}
    `;

    return c.json({ success: true });
  } catch {
    return c.json({ error: adminMessage(c, 'invalidToken') }, 401);
  }
});

// GET /api/auth/setup-status — check if first-time setup is needed
auth.get('/setup-status', async (c) => {
  const rows = await sql`SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin'`;
  const hasAdmin = (rows[0]?.count ?? 0) > 0;
  return c.json({ needs_setup: !hasAdmin });
});

// POST /api/auth/setup — create first admin (only works if no admins exist)
auth.post('/setup', async (c) => {
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
