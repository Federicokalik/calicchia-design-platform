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
  // Same connection/stream-abort noise as the Node runtime (see
  // sentry.server.config.ts): client disconnects mid-stream are not actionable.
  ignoreErrors: [
    'failed to pipe response',
    'ResponseAborted',
    'aborted',
    'EPIPE',
    'ECONNRESET',
    'The user aborted a request',
  ],
  // PII scrubber — shared hook across client/server/edge runtimes. See
  // apps/sito-v3/src/lib/sentry-scrub.ts for the redaction logic.
  beforeSend: scrubEvent,
});
