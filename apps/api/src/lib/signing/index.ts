import crypto from 'node:crypto';

export function generateOtpCode(): string {
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
}

export function otpExpiresAt(minutesFromNow = 10): Date {
  return new Date(Date.now() + minutesFromNow * 60_000);
}

export function isOtpValid(
  otpCode: string | null,
  otpExpiresAtValue: string | Date | null,
  providedOtp: string,
): boolean {
  if (!otpCode || !otpExpiresAtValue) return false;
  const expiry = new Date(otpExpiresAtValue).getTime();
  if (Number.isNaN(expiry) || expiry < Date.now()) return false;
  return otpCode === providedOtp.trim();
}

export function pdfHashOfSignaturePayload(payload: {
  title: string;
  content_md: string;
  signer_name: string;
  signer_email: string | null;
  signature_image: string;
  signed_at: string;
}): string {
  const data = JSON.stringify({
    title: payload.title,
    content_md: payload.content_md,
    signer_name: payload.signer_name,
    signer_email: payload.signer_email,
    signature_image_sha: crypto.createHash('sha256').update(payload.signature_image).digest('hex'),
    signed_at: payload.signed_at,
  });
  return crypto.createHash('sha256').update(data).digest('hex');
}

export interface RequestIpUa {
  ip: string | null;
  ua: string | null;
}

export function extractIpUa(headers: {
  get?: (name: string) => string | null | undefined;
  header?: (name: string) => string | undefined;
}): RequestIpUa {
  const get = (name: string) => {
    if (typeof headers.header === 'function') return headers.header(name) ?? null;
    if (typeof headers.get === 'function') return headers.get(name) ?? null;
    return null;
  };
  const forwardedFor = get('x-forwarded-for');
  const ip = get('cf-connecting-ip') || forwardedFor?.split(',')[0].trim() || get('x-real-ip') || null;
  const ua = get('user-agent') || null;
  return { ip, ua };
}
