export const HEADER_DENYLIST = new Set([
  'authorization',
  'cookie',
  'x-api-key',
  'stripe-signature',
  'paypal-transmission-sig',
  'x-webhook-secret',
  'x-hub-signature',
  'x-hub-signature-256',
]);

export const PAYLOAD_PII_FIELDS = new Set([
  'email',
  'phone',
  'name',
  'first_name',
  'last_name',
  'billing_address',
  'shipping_address',
  'tax_id',
  'vat_id',
  'fiscal_code',
  'iban',
]);

export function sanitizeHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => !HEADER_DENYLIST.has(key.toLowerCase())),
  );
}

export function maskPII<T>(payload: T): T {
  if (Array.isArray(payload)) {
    return payload.map((item) => maskPII(item)) as T;
  }

  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    masked[key] = PAYLOAD_PII_FIELDS.has(key.toLowerCase()) ? '[redacted]' : maskPII(value);
  }
  return masked as T;
}
