import { sql } from '../db';

// Credentials can come from env or from DB settings
let dbCredentials: { client_id: string; client_secret: string; mode: string } | null = null;
let dbCredentialsFetchedAt = 0;

async function getCredentials() {
  // Env vars take priority
  if (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET) {
    return {
      client_id: process.env.PAYPAL_CLIENT_ID,
      client_secret: process.env.PAYPAL_CLIENT_SECRET,
      mode: process.env.PAYPAL_MODE || 'sandbox',
    };
  }

  // Cache DB lookup for 60s
  if (dbCredentials && Date.now() - dbCredentialsFetchedAt < 60_000) {
    return dbCredentials;
  }

  const [row] = await sql`
    SELECT value FROM site_settings WHERE key = 'payments.providers' LIMIT 1
  ` as Array<{ value: Record<string, unknown> }>;

  const paypal = (row?.value?.paypal ?? {}) as Record<string, unknown>;
  dbCredentials = {
    client_id: String(paypal.client_id || ''),
    client_secret: String(paypal.client_secret || ''),
    mode: String(paypal.mode || 'sandbox'),
  };
  dbCredentialsFetchedAt = Date.now();
  return dbCredentials;
}

export function isPaypalConfigured(): boolean {
  // Quick check env first, DB check is async so we also return true optimistically
  return !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

export async function isPaypalReady(): Promise<boolean> {
  const creds = await getCredentials();
  return !!(creds.client_id && creds.client_secret);
}

/**
 * Generate a short-lived client token for the JS SDK (PayPal Buttons + Card Fields).
 * Cached in-process for ~50 minutes (PayPal tokens last 3h but we err on the safe side).
 * Required to enable Advanced Credit/Debit Card Payments in the browser SDK.
 */
let cachedClientToken: { token: string; expiresAt: number } | null = null;

export async function generatePaypalClientToken(): Promise<string> {
  if (cachedClientToken && Date.now() < cachedClientToken.expiresAt) {
    return cachedClientToken.token;
  }

  const accessToken = await getAccessToken();
  const baseUrl = await getBaseUrl();

  const res = await fetch(`${baseUrl}/v1/identity/generate-token`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept-Language': 'it_IT',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal generate client_token failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { client_token: string };
  cachedClientToken = {
    token: data.client_token,
    expiresAt: Date.now() + 50 * 60 * 1000, // 50 minutes
  };
  return data.client_token;
}

/**
 * Create a PayPal order WITHOUT redirect URLs — for use with the JS SDK
 * (PayPal Buttons popup / Card Fields inline). The SDK handles approval client-side,
 * the route handler then calls `capturePaypalOrder(orderId)` to finalize.
 *
 * Use `createPaypalOrder` (legacy) when you need a hosted `payer-action` URL.
 */
export async function createPaypalOrderEmbedded(opts: {
  amount: number;
  currency: string;
  description: string;
  reference_id?: string;
}): Promise<{ id: string; status: string }> {
  const token = await getAccessToken();
  const baseUrl = await getBaseUrl();

  const res = await fetch(`${baseUrl}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: opts.reference_id || undefined,
          description: opts.description,
          amount: {
            currency_code: opts.currency.toUpperCase(),
            value: opts.amount.toFixed(2),
          },
        },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal create order (embedded) failed: ${res.status} ${text}`);
  }

  return (await res.json()) as { id: string; status: string };
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  const creds = await getCredentials();
  if (!creds.client_id || !creds.client_secret) {
    throw new Error('PayPal non configurato: mancano client_id e client_secret');
  }

  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }

  const BASE_URL = creds.mode === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

  const credentials = Buffer.from(
    `${creds.client_id}:${creds.client_secret}`,
  ).toString('base64');

  const res = await fetch(`${BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal auth failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return cachedToken.token;
}

async function getBaseUrl(): Promise<string> {
  const creds = await getCredentials();
  return creds.mode === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

export interface PaypalOrderResult {
  id: string;
  status: string;
  checkout_url: string;
}

export async function createPaypalOrder(opts: {
  amount: number;
  currency: string;
  description: string;
  return_url: string;
  cancel_url: string;
  reference_id?: string;
}): Promise<PaypalOrderResult> {
  const token = await getAccessToken();
  const baseUrl = await getBaseUrl();

  const res = await fetch(`${baseUrl}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: opts.reference_id || undefined,
          description: opts.description,
          amount: {
            currency_code: opts.currency.toUpperCase(),
            value: opts.amount.toFixed(2),
          },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
            brand_name: 'Calicchia Design',
            landing_page: 'LOGIN',
            user_action: 'PAY_NOW',
            return_url: opts.return_url,
            cancel_url: opts.cancel_url,
          },
        },
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal create order failed: ${res.status} ${text}`);
  }

  const order = (await res.json()) as {
    id: string;
    status: string;
    links: Array<{ rel: string; href: string }>;
  };

  const approveLink = order.links.find((l) => l.rel === 'payer-action');
  if (!approveLink) {
    throw new Error('PayPal: nessun link di pagamento nella risposta');
  }

  return {
    id: order.id,
    status: order.status,
    checkout_url: approveLink.href,
  };
}

export async function capturePaypalOrder(orderId: string): Promise<{
  id: string;
  status: string;
  payer_email?: string;
  capture_id?: string;
  amount?: number;
  currency?: string;
}> {
  const token = await getAccessToken();

  const res = await fetch(`${await getBaseUrl()}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal capture failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as {
    id: string;
    status: string;
    payer?: { email_address?: string };
    purchase_units?: Array<{
      payments?: {
        captures?: Array<{
          id: string;
          amount?: { value?: string; currency_code?: string };
        }>;
      };
    }>;
  };
  const capture = data.purchase_units?.[0]?.payments?.captures?.[0];

  return {
    id: data.id,
    status: data.status,
    payer_email: data.payer?.email_address,
    capture_id: capture?.id,
    amount: capture?.amount?.value ? Number(capture.amount.value) : undefined,
    currency: capture?.amount?.currency_code,
  };
}

export async function getPaypalOrder(orderId: string): Promise<{
  id: string;
  status: string;
}> {
  const token = await getAccessToken();

  const res = await fetch(`${await getBaseUrl()}/v2/checkout/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal get order failed: ${res.status} ${text}`);
  }

  return (await res.json()) as { id: string; status: string };
}

export async function createPaypalProduct(opts: {
  name: string;
  description?: string | null;
}): Promise<{ id: string; name: string }> {
  const token = await getAccessToken();
  const baseUrl = await getBaseUrl();

  const res = await fetch(`${baseUrl}/v1/catalogs/products`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      name: opts.name,
      description: opts.description ?? opts.name,
      type: 'SERVICE',
      category: 'SOFTWARE',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal create product failed: ${res.status} ${text}`);
  }

  return (await res.json()) as { id: string; name: string };
}

export async function createPaypalPlan(opts: {
  product_id: string;
  name: string;
  amount: number;
  currency: string;
  interval: 'MONTH' | 'YEAR';
}): Promise<{ id: string; status: string }> {
  const token = await getAccessToken();
  const baseUrl = await getBaseUrl();

  const res = await fetch(`${baseUrl}/v1/billing/plans`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      product_id: opts.product_id,
      name: opts.name,
      status: 'CREATED',
      billing_cycles: [
        {
          frequency: {
            interval_unit: opts.interval,
            interval_count: 1,
          },
          tenure_type: 'REGULAR',
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: {
            fixed_price: {
              value: opts.amount.toFixed(2),
              currency_code: opts.currency.toUpperCase(),
            },
          },
        },
      ],
      payment_preferences: {
        auto_bill_outstanding: true,
        setup_fee_failure_action: 'CONTINUE',
        payment_failure_threshold: 3,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal create plan failed: ${res.status} ${text}`);
  }

  const plan = (await res.json()) as { id: string; status: string };

  const activate = await fetch(`${baseUrl}/v1/billing/plans/${plan.id}/activate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!activate.ok && activate.status !== 204) {
    const text = await activate.text();
    throw new Error(`PayPal activate plan failed: ${activate.status} ${text}`);
  }

  return { ...plan, status: 'ACTIVE' };
}

export async function createPaypalSubscription(opts: {
  plan_id: string;
  return_url: string;
  cancel_url: string;
  custom_id?: string;
}): Promise<{ id: string; status: string; approve_url: string }> {
  const token = await getAccessToken();
  const baseUrl = await getBaseUrl();

  const res = await fetch(`${baseUrl}/v1/billing/subscriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      plan_id: opts.plan_id,
      custom_id: opts.custom_id,
      application_context: {
        brand_name: 'Calicchia Design',
        user_action: 'SUBSCRIBE_NOW',
        return_url: opts.return_url,
        cancel_url: opts.cancel_url,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal create subscription failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as {
    id: string;
    status: string;
    links?: Array<{ rel: string; href: string }>;
  };
  const approve = data.links?.find((link) => link.rel === 'approve' || link.rel === 'payer-action');
  if (!approve) throw new Error('PayPal subscription: approve_url mancante');

  return { id: data.id, status: data.status, approve_url: approve.href };
}

export async function cancelPaypalSubscription(id: string, reason = 'Canceled by admin'): Promise<void> {
  const token = await getAccessToken();
  const baseUrl = await getBaseUrl();

  const res = await fetch(`${baseUrl}/v1/billing/subscriptions/${id}/cancel`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ reason }),
  });

  if (!res.ok && res.status !== 204) {
    const text = await res.text();
    throw new Error(`PayPal cancel subscription failed: ${res.status} ${text}`);
  }
}

export async function refundPaypalCapture(
  captureId: string,
  amount?: number,
  currency?: string,
): Promise<{ id: string; status: string; amount?: { value?: string; currency_code?: string } }> {
  const token = await getAccessToken();
  const baseUrl = await getBaseUrl();

  const res = await fetch(`${baseUrl}/v2/payments/captures/${captureId}/refund`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: amount !== undefined
      ? JSON.stringify({
          amount: {
            value: amount.toFixed(2),
            currency_code: (currency ?? 'EUR').toUpperCase(),
          },
        })
      : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal refund capture failed: ${res.status} ${text}`);
  }

  return (await res.json()) as {
    id: string;
    status: string;
    amount?: { value?: string; currency_code?: string };
  };
}
