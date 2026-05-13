/**
 * SMS sender - adapter Twilio. Provider swap: sostituire questo file.
 * Env richieste: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER.
 * Se non configurate, sendSms ritorna { success: false, error: 'SMS not configured' }
 * senza throw - il chiamante puo' fallback a email.
 */

export interface SmsOptions {
  to: string;
  body: string;
}

export interface SmsResult {
  success: boolean;
  provider_sid?: string;
  error?: string;
}

function hasTwilio(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID
    && process.env.TWILIO_AUTH_TOKEN
    && process.env.TWILIO_FROM_NUMBER,
  );
}

export function isSmsConfigured(): boolean {
  return hasTwilio();
}

function normalizePhone(phone: string): string {
  const trimmed = phone.replace(/[\s\-()]/g, '');
  if (trimmed.startsWith('+')) return trimmed;
  if (trimmed.startsWith('00')) return `+${trimmed.slice(2)}`;
  if (/^\d{9,10}$/.test(trimmed)) return `+39${trimmed}`;
  return trimmed;
}

export async function sendSms(options: SmsOptions): Promise<SmsResult> {
  if (!hasTwilio()) {
    console.warn('[sms] Twilio non configurato - skip send a', options.to);
    return { success: false, error: 'SMS not configured' };
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID!;
  const authToken = process.env.TWILIO_AUTH_TOKEN!;
  const from = process.env.TWILIO_FROM_NUMBER!;
  const to = normalizePhone(options.to);

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  const params = new URLSearchParams({ To: to, From: from, Body: options.body });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data = await res.json() as { sid?: string; message?: string };
    if (!res.ok) {
      console.error('[sms] Twilio error', res.status, data);
      return { success: false, error: data.message || `Twilio HTTP ${res.status}` };
    }
    return { success: true, provider_sid: data.sid };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[sms] send failure', message);
    return { success: false, error: message || 'Unknown SMS error' };
  }
}
