/**
 * AES-256-GCM encryption for email account credentials.
 *
 * Master key: hex-encoded 32 bytes in env MAIL_ENC_KEY.
 * Generate with: pnpm exec tsx scripts/generate-mail-enc-key.ts
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // 96 bits — GCM standard

function getKey(): Buffer {
  const hex = process.env.MAIL_ENC_KEY;
  if (!hex) {
    throw new Error('MAIL_ENC_KEY not set. Run scripts/generate-mail-enc-key.ts and add to .env');
  }
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) {
    throw new Error(`MAIL_ENC_KEY must be 32 bytes (64 hex chars), got ${buf.length} bytes`);
  }
  return buf;
}

export interface EncryptedBlob {
  cipher: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export function encryptSecret(plaintext: string): EncryptedBlob {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { cipher: enc, iv, tag };
}

export function decryptSecret(blob: EncryptedBlob): string {
  const key = getKey();
  const decipher = createDecipheriv(ALGO, key, blob.iv);
  decipher.setAuthTag(blob.tag);
  const dec = Buffer.concat([decipher.update(blob.cipher), decipher.final()]);
  return dec.toString('utf8');
}

/** Assertion useful at boot: fail fast if key is misconfigured. */
export function assertMailKeyAvailable(): { ok: true } | { ok: false; reason: string } {
  try {
    getKey();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}
