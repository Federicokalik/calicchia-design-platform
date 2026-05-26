/**
 * Sentry `beforeSend` PII scrubber.
 *
 * Strips personally identifiable information from events BEFORE they leave the
 * client/server and reach the Bugsink instance. Documented in the cookie
 * policy as the technical safeguard that lets us run error tracking on
 * legitimate-interest basis (GDPR art. 6(1)(f)) without explicit consent.
 *
 * Scope:
 *  - Drops `event.user.ip_address`; redacts `user.email`, `user.username`.
 *  - Strips querystring from `event.request.url` (may contain magic-link tokens).
 *  - Key-based redaction on `request.headers / cookies / data`, `extra`, `tags`,
 *    `breadcrumbs[].data` (any field whose key matches the PII regex).
 *  - Value-based redaction on every string we ship (event.message, exception
 *    messages, breadcrumb messages, free-text values inside records): emails,
 *    Italian phone numbers, IPv4/IPv6, IBAN, IT fiscal code, bearer tokens.
 *
 * Keep this lib runtime-agnostic (no Node-only or DOM-only APIs) so it can be
 * imported from `instrumentation-client.ts`, `sentry.server.config.ts`, and
 * `sentry.edge.config.ts` alike.
 */

import type { ErrorEvent, EventHint } from '@sentry/nextjs';

const PII_KEY_PATTERN =
  /(email|e[-_]?mail|phone|tel|mobile|name|nome|password|passwd|token|secret|authorization|cookie|set-cookie|api[-_]?key|codice[-_]?fiscale|fiscal[-_]?code|vat|piva|iban)/i;

const REDACTED = '[redacted]';

// Free-text PII patterns applied to any user-visible string before transmission.
// Order matters: longer / more specific patterns first so substring overlaps
// (e.g. an IPv4 inside an IBAN-shaped string) get the right label.
const TEXT_PATTERNS: ReadonlyArray<RegExp> = [
  /\b[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}\b/gi, // email
  /\bBearer\s+[A-Za-z0-9._~+/\-]+=*/gi, // Authorization: Bearer ...
  /\bIT\d{2}[A-Z0-9]{11,30}\b/gi, // IBAN IT (length range covers IT22 + 23 chars)
  /\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/gi, // Codice fiscale IT
  /\b(?:\+?39[\s.\-]?)?3\d{2}[\s.\-]?\d{6,8}\b/g, // Mobile IT (+39 3xx ...)
  /\b(?:\+?39[\s.\-]?)?0\d{1,3}[\s.\-]?\d{5,8}\b/g, // Landline IT (0xx ...)
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, // IPv4
  /\b(?:[A-F0-9]{1,4}:){2,7}[A-F0-9]{1,4}\b/gi, // IPv6 (rough)
];

function withoutQueryString(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

function scrubText(value: string): string {
  let out = value;
  for (const pattern of TEXT_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value && typeof value === 'object') {
    return scrubRecord(value as Record<string, unknown>);
  }
  return value;
}

function scrubRecord<T extends Record<string, unknown>>(record: T | undefined): T | undefined {
  if (!record) return record;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (PII_KEY_PATTERN.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = scrubValue(value);
  }
  return out as T;
}

export function scrubEvent(event: ErrorEvent, _hint?: EventHint): ErrorEvent | null {
  // Drop all dev-machine events before they reach Bugsink. Local dev tunnels
  // a real DSN so the SDK does fire, but events like EPIPE on Windows terminal
  // close (Bugsink 3b0645d8) only pollute the production dashboard. Production
  // and edge keep flowing through.
  if (event.environment === 'development') return null;

  // Anonymise URL: drop querystrings entirely (may contain tokens or email in
  // some flows like magic-link verification).
  if (event.request?.url) {
    event.request.url = withoutQueryString(event.request.url);
  }

  // Drop client IP completely. Bugsink doesn't need it; Sentry default would
  // store the source IP via `user.ip_address`.
  if (event.user) {
    delete event.user.ip_address;
    if (event.user.email) event.user.email = REDACTED;
    if (event.user.username) event.user.username = REDACTED;
  }

  // Walk request headers / cookies / data and redact any PII-shaped key plus
  // any PII-shaped value (regex on emails / phones / tokens / IPs / IBANs).
  if (event.request) {
    event.request.headers = scrubRecord(event.request.headers as Record<string, string> | undefined);
    event.request.cookies = scrubRecord(event.request.cookies as Record<string, string> | undefined);
    if (typeof event.request.data === 'object' && event.request.data !== null) {
      event.request.data = scrubRecord(event.request.data as Record<string, unknown>);
    } else if (typeof event.request.data === 'string') {
      event.request.data = scrubText(event.request.data);
    }
  }

  if (event.extra) event.extra = scrubRecord(event.extra);
  if (event.tags) {
    for (const tagKey of Object.keys(event.tags)) {
      if (PII_KEY_PATTERN.test(tagKey)) {
        event.tags[tagKey] = REDACTED;
        continue;
      }
      const v = event.tags[tagKey];
      if (typeof v === 'string') event.tags[tagKey] = scrubText(v);
    }
  }

  // Free-text surfaces: top-level message, log entry, exception values, and
  // breadcrumb messages all carry user-visible strings that can leak PII via
  // thrown Error messages ("connection to mario.rossi@example.com failed") or
  // logged form input. Apply the text patterns there too.
  if (event.message) event.message = scrubText(event.message);
  if (event.logentry?.message) event.logentry.message = scrubText(event.logentry.message);

  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (ex.value) ex.value = scrubText(ex.value);
    }
  }

  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.map((bc) => ({
      ...bc,
      message: bc.message ? scrubText(bc.message) : bc.message,
      data: bc.data ? scrubRecord(bc.data as Record<string, unknown>) : bc.data,
    }));
  }

  return event;
}
