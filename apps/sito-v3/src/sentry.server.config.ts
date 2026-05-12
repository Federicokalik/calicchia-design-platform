import * as Sentry from '@sentry/nextjs';

const DSN =
  process.env.BUGSINK_DSN ??
  process.env.NEXT_PUBLIC_BUGSINK_DSN ??
  process.env.PUBLIC_BUGSINK_DSN;

Sentry.init({
  dsn: DSN,
  enabled: Boolean(DSN),
  release: process.env.SENTRY_RELEASE ?? '@caldes/sito-v3@0.1.0',
  environment: process.env.NODE_ENV,
  integrations: [],
  tracesSampleRate: 0,
});
