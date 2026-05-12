import { SignJWT } from 'jose';

export function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET env var is required');
  return new TextEncoder().encode(secret);
}

const JWT_EXPIRES_IN = '7d';

export async function signToken(payload: { sub: string; email: string; role: string; last_activity?: number }) {
  return new SignJWT({ ...payload, last_activity: Date.now() })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(JWT_EXPIRES_IN)
    .sign(getJwtSecret());
}
