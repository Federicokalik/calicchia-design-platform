import { SignJWT } from 'jose';

export function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET env var is required');
  return new TextEncoder().encode(secret);
}

// Token lifetime. Also the absolute session cap: authMiddleware refreshes the
// token on every request (sliding 30-min inactivity window), so without an
// absolute anchor a session would never end. `auth_at` below provides it.
const JWT_EXPIRES_IN = '12h';

/** Absolute session lifetime — a session cannot outlive this even with activity. */
export const ABSOLUTE_SESSION_MS = 12 * 60 * 60 * 1000;

export async function signToken(payload: {
  sub: string;
  email: string;
  role: string;
  last_activity?: number;
  /** Original authentication time; preserved across token re-signs. */
  auth_at?: number;
}) {
  return new SignJWT({
    sub: payload.sub,
    email: payload.email,
    role: payload.role,
    last_activity: Date.now(),
    auth_at: payload.auth_at ?? Date.now(),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(JWT_EXPIRES_IN)
    .sign(getJwtSecret());
}
