/**
 * PayPal webhook signature verification.
 *
 * PayPal does NOT sign with an HMAC like Stripe — instead the receiver must
 * POST the relevant headers + webhook id + event back to PayPal which returns
 * { verification_status: 'SUCCESS' | 'FAILURE' }.
 *
 * Reference:
 *   POST /v1/notifications/verify-webhook-signature
 *   https://developer.paypal.com/docs/api/webhooks/v1/#verify-webhook-signature
 *
 * The `event` parameter is the parsed webhook payload (NOT the raw body).
 */

import { sql } from '../db';

interface PaypalCreds {
  client_id: string;
  client_secret: string;
  mode: string; // 'sandbox' | 'live'
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getCreds(): Promise<PaypalCreds> {
  if (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET) {
    return {
      client_id: process.env.PAYPAL_CLIENT_ID,
      client_secret: process.env.PAYPAL_CLIENT_SECRET,
      mode: process.env.PAYPAL_MODE || 'sandbox',
    };
  }
  const [row] = await sql`
    SELECT value FROM site_settings WHERE key = 'payments.providers' LIMIT 1
  ` as Array<{ value: Record<string, unknown> }>;
  const paypal = (row?.value?.paypal ?? {}) as Record<string, unknown>;
  return {
    client_id: String(paypal.client_id || ''),
    client_secret: String(paypal.client_secret || ''),
    mode: String(paypal.mode || 'sandbox'),
  };
}

function baseUrl(mode: string): string {
  return mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

async function getAccessToken(): Promise<string> {
  const creds = await getCreds();
  if (!creds.client_id || !creds.client_secret) {
    throw new Error('PayPal credentials not configured');
  }
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;

  const basic = Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString('base64');
  const res = await fetch(`${baseUrl(creds.mode)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal oauth failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return cachedToken.token;
}

export interface PaypalVerificationHeaders {
  auth_algo: string | null;
  cert_url: string | null;
  transmission_id: string | null;
  transmission_sig: string | null;
  transmission_time: string | null;
}

/**
 * Extract the 5 signature headers PayPal includes on every webhook delivery.
 * Hono's `c.req.header(...)` is case-insensitive.
 */
export function extractPaypalSignatureHeaders(getHeader: (name: string) => string | undefined): PaypalVerificationHeaders {
  return {
    auth_algo: getHeader('paypal-auth-algo') ?? null,
    cert_url: getHeader('paypal-cert-url') ?? null,
    transmission_id: getHeader('paypal-transmission-id') ?? null,
    transmission_sig: getHeader('paypal-transmission-sig') ?? null,
    transmission_time: getHeader('paypal-transmission-time') ?? null,
  };
}

/**
 * Verify a webhook event with PayPal's API.
 *
 * Returns true if the event is authentic AND matches our configured webhook id.
 * Returns false on any failure (network, signature, missing config). Caller
 * decides whether to 200/400.
 */
export async function verifyPaypalSignature(
  headers: PaypalVerificationHeaders,
  webhookEvent: unknown,
): Promise<boolean> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) {
    console.warn('[paypal-webhook] PAYPAL_WEBHOOK_ID not set — refusing to verify');
    return false;
  }
  if (!headers.auth_algo || !headers.cert_url || !headers.transmission_id ||
      !headers.transmission_sig || !headers.transmission_time) {
    return false;
  }

  try {
    const token = await getAccessToken();
    const creds = await getCreds();
    const res = await fetch(`${baseUrl(creds.mode)}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        auth_algo: headers.auth_algo,
        cert_url: headers.cert_url,
        transmission_id: headers.transmission_id,
        transmission_sig: headers.transmission_sig,
        transmission_time: headers.transmission_time,
        webhook_id: webhookId,
        webhook_event: webhookEvent,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error('[paypal-webhook] verify failed HTTP', res.status, text);
      return false;
    }
    const data = (await res.json()) as { verification_status?: string };
    return data.verification_status === 'SUCCESS';
  } catch (err) {
    console.error('[paypal-webhook] verify threw:', (err as Error).message);
    return false;
  }
}
