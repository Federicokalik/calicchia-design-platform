/**
 * Verifica delle credenziali SMTP di una casella. L'invio vero (MIME con
 * allegati, copia in Inviati) è in lib/mail/outbound.ts.
 */
import nodemailer from 'nodemailer';
import type { EncryptedBlob } from './crypto';
import { decryptSecret } from './crypto';

export interface SmtpCredentials {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  passwordBlob: EncryptedBlob;
}

export async function testSmtpConnection(creds: SmtpCredentials): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const password = decryptSecret(creds.passwordBlob);
    const transporter = nodemailer.createTransport({
      host: creds.host,
      port: creds.port,
      secure: creds.secure,
      auth: { user: creds.username, pass: password },
    });
    await transporter.verify();
    transporter.close();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
