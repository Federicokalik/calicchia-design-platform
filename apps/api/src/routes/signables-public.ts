import { Hono, type Context } from 'hono';
import { sql, sqlv } from '../db';
import {
  extractIpUa,
  generateOtpCode,
  isOtpValid,
  otpExpiresAt,
  pdfHashOfSignaturePayload,
} from '../lib/signing';
import { sendEmail } from '../lib/email';
import { sendSms } from '../lib/sms';

export const signablesPublic = new Hono();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type PublicSignableDocument = {
  id: string;
  type: string;
  title: string;
  content_md: string;
  signer_name: string | null;
  signer_email: string | null;
  signer_phone: string | null;
  signature_method: 'email_otp' | 'sms_otp';
  status: string;
  signed_at: string | null;
  signature_image: string | null;
  expires_at: string | null;
};

type SignableDocument = PublicSignableDocument & {
  otp_code: string | null;
  otp_expires_at: string | Date | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function readJsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function maskTarget(target: string): string {
  if (target.includes('@')) return target.replace(/(.{2})(.*)(@.*)/, '$1***$3');
  return target.replace(/(\+?\d{2})(.*)(\d{2})$/, '$1***$3');
}

function isUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

async function writeAuditLog(args: {
  signableId: string;
  action: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}) {
  await sql`
    INSERT INTO signable_audit_log (signable_id, action, ip_address, user_agent, metadata)
    VALUES (
      ${args.signableId},
      ${args.action},
      ${args.ipAddress ?? null},
      ${args.userAgent ?? null},
      ${args.metadata ? sqlv(args.metadata) : null}
    )
  `;
}

signablesPublic.get('/:token', async (c) => {
  const { token } = c.req.param();
  if (!isUuid(token)) return c.json({ error: 'Token non valido' }, 400);
  const [doc] = await sql`
    SELECT id, type, title, content_md, signer_name, signer_email, signer_phone,
           signature_method, status, signed_at, signature_image, expires_at
    FROM signable_documents
    WHERE sign_token = ${token}
    LIMIT 1
  ` as PublicSignableDocument[];
  if (!doc) return c.json({ error: 'Documento non trovato' }, 404);
  if (doc.expires_at && new Date(doc.expires_at) < new Date()) {
    await sql`
      UPDATE signable_documents
      SET status = 'expired'
      WHERE id = ${doc.id} AND status IN ('draft', 'sent', 'viewed')
    `;
    return c.json({ error: 'Documento scaduto' }, 410);
  }

  if (doc.status === 'sent') {
    await sql`
      UPDATE signable_documents
      SET viewed_at = now(), status = 'viewed'
      WHERE id = ${doc.id} AND status = 'sent'
    `;
    const { ip, ua } = extractIpUa({ header: (name) => c.req.header(name) });
    await writeAuditLog({
      signableId: doc.id,
      action: 'viewed',
      ipAddress: ip,
      userAgent: ua,
    });
    doc.status = 'viewed';
  }

  return c.json({ document: doc });
});

signablesPublic.post('/:token/request-otp', async (c) => {
  const { token } = c.req.param();
  if (!isUuid(token)) return c.json({ error: 'Token non valido' }, 400);
  const [doc] = await sql`
    SELECT *
    FROM signable_documents
    WHERE sign_token = ${token}
    LIMIT 1
  ` as SignableDocument[];
  if (!doc || doc.status === 'signed') return c.json({ error: 'Non disponibile' }, 400);
  if (doc.expires_at && new Date(doc.expires_at) < new Date()) return c.json({ error: 'Documento scaduto' }, 410);

  const otp = generateOtpCode();
  const expiresAt = otpExpiresAt(10).toISOString();

  await sql`
    UPDATE signable_documents
    SET otp_code = ${otp}, otp_expires_at = ${expiresAt}
    WHERE id = ${doc.id}
  `;

  const target = doc.signature_method === 'sms_otp' ? doc.signer_phone : doc.signer_email;
  if (!target) return c.json({ error: 'Canale OTP non configurato' }, 400);

  let sent = false;
  if (doc.signature_method === 'email_otp') {
    const email = await sendEmail({
      to: target,
      subject: 'Codice firma documento',
      html: `<p>Il tuo codice: <strong>${otp}</strong> (valido 10 minuti)</p>`,
      text: `Il tuo codice firma documento: ${otp}. Valido 10 minuti.`,
      transport: 'critical',
    });
    sent = email.success;
  } else {
    const sms = await sendSms({
      to: target,
      body: `Codice firma documento "${doc.title}": ${otp}. Valido 10 min.`,
    });
    sent = sms.success;
  }

  if (!sent) return c.json({ error: 'Invio OTP fallito' }, 502);

  const { ip, ua } = extractIpUa({ header: (name) => c.req.header(name) });
  await writeAuditLog({
    signableId: doc.id,
    action: 'otp_sent',
    ipAddress: ip,
    userAgent: ua,
    metadata: { method: doc.signature_method, target: maskTarget(target) },
  });

  return c.json({ sent: true, channel: doc.signature_method });
});

signablesPublic.post('/:token/sign', async (c) => {
  const { token } = c.req.param();
  if (!isUuid(token)) return c.json({ error: 'Token non valido' }, 400);
  const body = await readJsonBody(c);
  if (!body) return c.json({ error: 'Payload non valido' }, 400);

  const otp = stringValue(body.otp);
  const signatureImage = stringValue(body.signature_image);
  const signerName = stringValue(body.signer_name);
  if (!otp || !signatureImage || !signerName) return c.json({ error: 'OTP, firma e nome firmatario richiesti' }, 400);

  const [doc] = await sql`
    SELECT *
    FROM signable_documents
    WHERE sign_token = ${token}
    LIMIT 1
  ` as SignableDocument[];
  if (!doc) return c.json({ error: 'Documento non trovato' }, 404);
  if (doc.status === 'signed') return c.json({ error: "Gia' firmato" }, 400);
  if (doc.expires_at && new Date(doc.expires_at) < new Date()) return c.json({ error: 'Documento scaduto' }, 410);
  if (!isOtpValid(doc.otp_code, doc.otp_expires_at, otp)) {
    return c.json({ error: 'OTP non valido o scaduto' }, 400);
  }

  const { ip, ua } = extractIpUa({ header: (name) => c.req.header(name) });
  const signedAt = new Date().toISOString();
  const pdfHash = pdfHashOfSignaturePayload({
    title: doc.title,
    content_md: doc.content_md,
    signer_name: signerName,
    signer_email: doc.signer_email,
    signature_image: signatureImage,
    signed_at: signedAt,
  });

  await sql`
    UPDATE signable_documents
    SET
      status = 'signed',
      signed_at = ${signedAt},
      signature_image = ${signatureImage},
      signer_ip = ${ip},
      signer_user_agent = ${ua},
      pdf_hash_sha256 = ${pdfHash},
      signer_name = ${signerName},
      otp_code = NULL,
      otp_expires_at = NULL
    WHERE id = ${doc.id}
  `;

  await writeAuditLog({
    signableId: doc.id,
    action: 'signature_submitted',
    ipAddress: ip,
    userAgent: ua,
    metadata: { signer_name: signerName, pdf_hash: pdfHash },
  });

  return c.json({ success: true, signed_at: signedAt });
});
