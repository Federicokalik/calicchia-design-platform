import { Context, Next } from 'hono';
import { jwtVerify } from 'jose';
import { getJwtSecret, signToken, ABSOLUTE_SESSION_MS } from '../lib/jwt';
import { setAuthCookie } from '../lib/cookies';
import { adminMessage } from '../lib/admin-locale';

export function extractToken(c: Context): string | null {
  // Cookie (priority — browser requests)
  const cookieHeader = c.req.header('cookie') || '';
  const match = cookieHeader.match(/auth_token=([^;]+)/);
  if (match) return match[1];

  // Bearer header (API clients / e2e tests)
  const auth = c.req.header('Authorization');
  if (auth?.startsWith('Bearer ')) return auth.replace('Bearer ', '');

  return null;
}

export async function authMiddleware(c: Context, next: Next) {
  const token = extractToken(c);

  if (!token) {
    return c.json({ error: adminMessage(c, 'authRequired') }, 401);
  }

  try {
    const { payload } = await jwtVerify(token, getJwtSecret());

    if (!payload.sub || !payload.role) {
      return c.json({ error: adminMessage(c, 'invalidToken') }, 401);
    }

    if (payload.role !== 'admin') {
      return c.json({ error: adminMessage(c, 'adminOnly') }, 403);
    }

    // Session timeout: reject if last_activity > 30 minutes ago
    const lastActivity = payload.last_activity as number | undefined;
    if (lastActivity && Date.now() - lastActivity > 30 * 60 * 1000) {
      return c.json({ error: adminMessage(c, 'invalidOrExpiredToken') }, 401);
    }

    // Absolute session cap: a session cannot be kept alive past ABSOLUTE_SESSION_MS
    // from the original login, even with continuous activity (limits the window
    // of a stolen auth cookie — finding SEC-05).
    const authAt = payload.auth_at as number | undefined;
    if (authAt && Date.now() - authAt > ABSOLUTE_SESSION_MS) {
      return c.json({ error: adminMessage(c, 'invalidOrExpiredToken') }, 401);
    }

    c.set('user', {
      id: payload.sub as string,
      email: payload.email as string,
      role: payload.role as string,
    });

    // Refresh token with updated last_activity (non-blocking, best-effort).
    // auth_at is carried over so the absolute cap above keeps anchoring to login.
    signToken({
      sub: payload.sub as string,
      email: payload.email as string,
      role: payload.role as string,
      auth_at: authAt,
    }).then((newToken) => setAuthCookie(c, newToken)).catch(() => {});
  } catch {
    return c.json({ error: adminMessage(c, 'invalidOrExpiredToken') }, 401);
  }

  await next();
}
