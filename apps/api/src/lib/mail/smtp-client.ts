/**
 * Nodemailer SMTP wrapper.
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

export interface SendOptions {
  from: string;
  to: string | string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  replyTo?: string;
}

export async function sendMail(creds: SmtpCredentials, opts: SendOptions): Promise<{ messageId: string }> {
  const password = decryptSecret(creds.passwordBlob);
  const transporter = nodemailer.createTransport({
    host: creds.host,
    port: creds.port,
    secure: creds.secure,
    auth: { user: creds.username, pass: password },
  });

  try {
    const info = await transporter.sendMail({
      from: opts.from,
      to: opts.to,
      cc: opts.cc,
      bcc: opts.bcc,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
      inReplyTo: opts.inReplyTo,
      references: opts.references,
      replyTo: opts.replyTo,
    });
    return { messageId: info.messageId };
  } finally {
    transporter.close();
  }
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
