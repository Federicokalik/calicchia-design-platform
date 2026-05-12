/**
 * HMAC-signed tokens per cancel/reschedule self-service via email link.
 *
 * Format: base64url({uid:string, exp:number}).base64url(hmacSha256)
 * TTL default 90 giorni dal momento dell'emissione (allineato a max_advance_days).
 */

import { createHmac, timingSafeEqual } from 'crypto';
import type { BookingTokenPayload } from './types';

const SECRET = process.env.BOOKING_TOKEN_SECRET || process.env.JWT_SECRET || '';

if (!SECRET) {
  console.warn('[booking/token] BOOKING_TOKEN_SECRET non configurato — token non verranno generati');
}

const DEFAULT_TTL_SECONDS = 90 * 24 * 60 * 60;

function b64urlEncode(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, 'base64');
}

export function isTokenSecretConfigured(): boolean {
  return !!SECRET;
}

export function signBookingToken(uid: string, ttlSeconds: number = DEFAULT_TTL_SECONDS): string {
  if (!SECRET) throw new Error('BOOKING_TOKEN_SECRET non configurato');
  const payload: BookingTokenPayload = {
    uid,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const payloadStr = JSON.stringify(payload);
  const payloadB64 = b64urlEncode(payloadStr);
  const sig = createHmac('sha256', SECRET).update(payloadB64).digest();
  return `${payloadB64}.${b64urlEncode(sig)}`;
}

export function verifyBookingToken(token: string, expectedUid?: string): BookingTokenPayload | null {
  if (!SECRET || !token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;

  let expectedSig: Buffer;
  try {
    expectedSig = createHmac('sha256', SECRET).update(payloadB64).digest();
  } catch {
    return null;
  }

  let providedSig: Buffer;
  try {
    providedSig = b64urlDecode(sigB64);
  } catch {
    return null;
  }

  if (providedSig.length !== expectedSig.length) return null;
  if (!timingSafeEqual(providedSig, expectedSig)) return null;

  let payload: BookingTokenPayload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8')) as BookingTokenPayload;
  } catch {
    return null;
  }

  if (!payload || typeof payload.uid !== 'string' || typeof payload.exp !== 'number') return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (expectedUid && payload.uid !== expectedUid) return null;

  return payload;
}
