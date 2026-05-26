import type { Context } from 'hono';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { sql } from '../db';
import { getClientIp } from './client-ip';

export const ADMIN_REFRESH_COOKIE_NAME = 'admin_refresh';
export const ADMIN_REFRESH_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const ADMIN_REFRESH_TTL_MS = ADMIN_REFRESH_MAX_AGE_SECONDS * 1000;

export type AdminSessionUser = {
  id: string;
  email: string;
  role: string;
};

export type AdminRefreshResult =
  | { ok: true; token: string; user: AdminSessionUser }
  | { ok: false; reason: 'missing' | 'invalid' | 'expired' | 'revoked' | 'reused' };

function hashRefreshSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function safeEqualHash(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function makeRefreshToken(sessionId: string, secret: string): string {
  return `${sessionId}.${secret}`;
}

function parseRefreshToken(token: string | null | undefined): { sessionId: string; secret: string } | null {
  if (!token) return null;
  const [sessionId, secret, extra] = token.split('.');
  if (!sessionId || !secret || extra) return null;
  return { sessionId, secret };
}

function newRefreshSecret(): string {
  return randomBytes(32).toString('base64url');
}

export async function createAdminSession(c: Context, userId: string): Promise<string> {
  const sessionId = randomUUID();
  const secret = newRefreshSecret();
  const expiresAt = new Date(Date.now() + ADMIN_REFRESH_TTL_MS);

  await sql`
    INSERT INTO admin_sessions (id, user_id, refresh_token_hash, user_agent, ip, expires_at)
    VALUES (
      ${sessionId},
      ${userId},
      ${hashRefreshSecret(secret)},
      ${c.req.header('user-agent') ?? null},
      ${getClientIp(c)},
      ${expiresAt.toISOString()}
    )
  `;

  return makeRefreshToken(sessionId, secret);
}

export async function rotateAdminSession(token: string | null | undefined): Promise<AdminRefreshResult> {
  const parsed = parseRefreshToken(token);
  if (!parsed) return { ok: false, reason: token ? 'invalid' : 'missing' };

  const [session] = await sql`
    SELECT
      s.id,
      s.refresh_token_hash,
      s.expires_at,
      s.revoked_at,
      u.id AS user_id,
      u.email,
      u.role
    FROM admin_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ${parsed.sessionId}
    LIMIT 1
  ` as Array<{
    id: string;
    refresh_token_hash: string;
    expires_at: string;
    revoked_at: string | null;
    user_id: string;
    email: string;
    role: string;
  }>;

  if (!session) return { ok: false, reason: 'invalid' };
  if (session.revoked_at) return { ok: false, reason: 'revoked' };
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    await sql`UPDATE admin_sessions SET revoked_at = NOW() WHERE id = ${session.id} AND revoked_at IS NULL`;
    return { ok: false, reason: 'expired' };
  }

  const presentedHash = hashRefreshSecret(parsed.secret);
  if (!safeEqualHash(presentedHash, session.refresh_token_hash)) {
    await sql`UPDATE admin_sessions SET revoked_at = NOW() WHERE id = ${session.id} AND revoked_at IS NULL`;
    return { ok: false, reason: 'reused' };
  }

  if (session.role !== 'admin') {
    await sql`UPDATE admin_sessions SET revoked_at = NOW() WHERE id = ${session.id} AND revoked_at IS NULL`;
    return { ok: false, reason: 'invalid' };
  }

  const nextSecret = newRefreshSecret();
  await sql`
    UPDATE admin_sessions
    SET refresh_token_hash = ${hashRefreshSecret(nextSecret)}, last_used_at = NOW()
    WHERE id = ${session.id}
  `;

  return {
    ok: true,
    token: makeRefreshToken(session.id, nextSecret),
    user: {
      id: session.user_id,
      email: session.email,
      role: session.role,
    },
  };
}

export async function revokeAdminSession(token: string | null | undefined): Promise<void> {
  const parsed = parseRefreshToken(token);
  if (!parsed) return;

  await sql`
    UPDATE admin_sessions
    SET revoked_at = NOW()
    WHERE id = ${parsed.sessionId}
      AND refresh_token_hash = ${hashRefreshSecret(parsed.secret)}
      AND revoked_at IS NULL
  `;
}
