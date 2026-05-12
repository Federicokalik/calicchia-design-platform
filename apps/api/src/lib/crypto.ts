import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ENCRYPTED_SECRET_RE = /^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]+$/i;

function getWebhookEncryptionKey(): Buffer {
  const raw = process.env.WEBHOOK_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('WEBHOOK_ENCRYPTION_KEY env var is required for webhook secret encryption');
  }
  if (!/^[0-9a-f]{64}$/i.test(raw)) {
    throw new Error('WEBHOOK_ENCRYPTION_KEY must be 32 bytes encoded as 64 hex characters');
  }
  return Buffer.from(raw, 'hex');
}

export function isEncryptedSecret(value: string | null | undefined): boolean {
  return typeof value === 'string' && ENCRYPTED_SECRET_RE.test(value);
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', getWebhookEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decryptSecret(payload: string): string {
  const [ivHex, tagHex, ciphertextHex] = payload.split(':');
  if (!ivHex || !tagHex || !ciphertextHex) {
    throw new Error('Invalid encrypted secret payload');
  }

  const decipher = createDecipheriv('aes-256-gcm', getWebhookEncryptionKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

export function decryptMaybeSecret(value: string): string {
  return isEncryptedSecret(value) ? decryptSecret(value) : value;
}
