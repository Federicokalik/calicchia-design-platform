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
  // PII scrubber — see apps/sito-v3/src/lib/sentry-scrub.ts. Same hook is
  // wired into the client and edge configs so events leaving any runtime
  // have the same redaction applied (GDPR art. 6(1)(f) safeguard).
  beforeSend: scrubEvent,
});
