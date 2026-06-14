import * as Sentry from '@sentry/nextjs';
import { scrubEvent } from '@/lib/sentry-scrub';

const DSN =
  process.env.BUGSINK_DSN ??
  process.env.NEXT_PUBLIC_BUGSINK_DSN ??
  process.env.PUBLIC_BUGSINK_DSN;

Sentry.init({
  dsn: DSN,
  enabled: Boolean(DSN),
  release: process.env.SENTRY_RELEASE ?? '@calicchia/sito-v3@0.1.0',
  environment: process.env.NODE_ENV,
  integrations: [],
  tracesSampleRate: 0,
  // Non-actionable connection/stream-abort noise. Emitted when a client
  // (browser, social crawler, link-preview bot) drops the connection before a
  // streamed/dynamic response finishes piping — overwhelmingly the OG /
  // twitter-image / api/og routes. There is no code-level fix; they only bury
  // real errors. Matched against the exception message by InboundFilters
  // (a default integration; `integrations: []` adds nothing, it does not
  // disable defaults).
  ignoreErrors: [
    'failed to pipe response',
    'ResponseAborted',
    'aborted',
    'EPIPE',
    'ECONNRESET',
    'The user aborted a request',
    // Deployment-mismatch noise: a stale client (or bot) POSTs a server-action
    // ID that no longer exists after a redeploy. The matrix route has no server
    // actions at all, so this is never code-actionable — it only buries real
    // errors. Matched as a substring by InboundFilters.
    'Failed to find Server Action',
  ],
  // PII scrubber — see apps/sito-v3/src/lib/sentry-scrub.ts. Same hook is
  // wired into the client and edge configs so events leaving any runtime
  // have the same redaction applied (GDPR art. 6(1)(f) safeguard).
  beforeSend: scrubEvent,
});
