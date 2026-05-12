import { sql } from '../db';

// Credentials can come from env or from DB settings
let dbCredentials: { api_key: string; mode: string } | null = null;
let dbCredentialsFetchedAt = 0;

async function getCredentials() {
  // Env vars take priority
  if (process.env.REVOLUT_API_KEY) {
    return {
      api_key: process.env.REVOLUT_API_KEY,
      mode: process.env.REVOLUT_MODE || 'sandbox',
    };
  }

  // Cache DB lookup for 60s
  if (dbCredentials && Date.now() - dbCredentialsFetchedAt < 60_000) {
    return dbCredentials;
  }

  const [row] = await sql`
    SELECT value FROM site_settings WHERE key = 'payments.providers' LIMIT 1
  ` as Array<{ value: Record<string, unknown> }>;

  const revolut = (row?.value?.revolut ?? {}) as Record<string, unknown>;
  dbCredentials = {
    api_key: String(revolut.api_key || ''),
    mode: String(revolut.mode || 'sandbox'),
  };
  dbCredentialsFetchedAt = Date.now();
  return dbCredentials;
}

function getBaseUrl(mode: string): string {
  return mode === 'live'
    ? 'https://merchant.revolut.com/api'
    : 'https://sandbox-merchant.revolut.com/api';
}

export function isRevolutConfigured(): boolean {
  return !!process.env.REVOLUT_API_KEY;
}

export async function isRevolutReady(): Promise<boolean> {
  const creds = await getCredentials();
  return !!creds.api_key;
}

export interface RevolutOrderResult {
  id: string;
  state: string;
  checkout_url: string;
}

export async function createRevolutOrder(opts: {
  amount: number;
  currency: string;
  description: string;
  merchant_order_ext_ref?: string;
  customer_email?: string;
}): Promise<RevolutOrderResult> {
  const creds = await getCredentials();
  if (!creds.api_key) {
    throw new Error('Revolut API key non configurata');
  }

  const amountMinor = Math.round(opts.amount * 100);
  const baseUrl = getBaseUrl(creds.mode);

  const res = await fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${creds.api_key}`,
      'Content-Type': 'application/json',
      'Revolut-Api-Version': '2024-09-01',
    },
    body: JSON.stringify({
      amount: amountMinor,
      currency: opts.currency.toUpperCase(),
      description: opts.description,
      merchant_order_ext_ref: opts.merchant_order_ext_ref || undefined,
      customer_email: opts.customer_email || undefined,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Revolut create order failed: ${res.status} ${text}`);
  }

  const order = (await res.json()) as {
    id: string;
    state: string;
    checkout_url: string;
  };

  return {
    id: order.id,
    state: order.state,
    checkout_url: order.checkout_url,
  };
}

export async function getRevolutOrder(orderId: string): Promise<{
  id: string;
  state: string;
  checkout_url: string;
}> {
  const creds = await getCredentials();
  if (!creds.api_key) {
    throw new Error('Revolut API key non configurata');
  }

  const baseUrl = getBaseUrl(creds.mode);
  const res = await fetch(`${baseUrl}/orders/${orderId}`, {
    headers: {
      Authorization: `Bearer ${creds.api_key}`,
      'Revolut-Api-Version': '2024-09-01',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Revolut get order failed: ${res.status} ${text}`);
  }

  return (await res.json()) as { id: string; state: string; checkout_url: string };
}

export async function cancelRevolutOrder(orderId: string): Promise<void> {
  const creds = await getCredentials();
  if (!creds.api_key) {
    throw new Error('Revolut API key non configurata');
  }

  const baseUrl = getBaseUrl(creds.mode);
  const res = await fetch(`${baseUrl}/orders/${orderId}/cancel`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${creds.api_key}`,
      'Revolut-Api-Version': '2024-09-01',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Revolut cancel order failed: ${res.status} ${text}`);
  }
}
