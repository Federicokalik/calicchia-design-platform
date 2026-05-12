const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY || '';
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function isTurnstileConfigured(): boolean {
  return TURNSTILE_SECRET.length > 0;
}

export async function verifyTurnstileToken(token: string, remoteIp?: string): Promise<boolean> {
  if (!isTurnstileConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[SECURITY] TURNSTILE_SECRET_KEY not configured in production — blocking request');
      return false;
    }
    return true; // skip in development
  }

  if (!token) return false;

  const body: Record<string, string> = {
    secret: TURNSTILE_SECRET,
    response: token,
  };
  if (remoteIp) body.remoteip = remoteIp;

  try {
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    const json = await res.json() as { success: boolean };
    return json.success === true;
  } catch (err) {
    console.error('Turnstile verification error:', err);
    return false;
  }
}
