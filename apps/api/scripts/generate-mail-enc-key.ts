/**
 * Generate a new MAIL_ENC_KEY for encrypting email credentials.
 *
 * Usage: pnpm --filter @caldes/api exec tsx scripts/generate-mail-enc-key.ts
 *
 * Output: 64-char hex string (32 bytes). Paste into your .env as:
 *   MAIL_ENC_KEY=<the hex string>
 *
 * CRITICAL: if you lose this key, all encrypted email credentials in the DB
 * become unreadable. Back it up offline (password manager, secure note).
 */
import { randomBytes } from 'crypto';

const key = randomBytes(32).toString('hex');
console.log('\nMAIL_ENC_KEY=' + key + '\n');
console.log('Copy the line above into your .env file.');
console.log('BACK IT UP OFFLINE. If lost, encrypted email credentials become unrecoverable.\n');
