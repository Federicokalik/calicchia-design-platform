import * as Sentry from '@sentry/nextjs';
import { scrubEvent } from '@/lib/sentry-scrub';

const DSN = process.env.NEXT_PUBLIC_BUGSINK_DSN;
const RELEASE = process.env.NEXT_PUBLIC_APP_RELEASE ?? '@calicchia/sito-v3@0.1.0';

Sentry.init({
  dsn: DSN,
  enabled: Boolean(DSN),
  release: RELEASE,
  environment: process.env.NODE_ENV,
  integrations: [],
  tracesSampleRate: 0,
  // Drop errors that originate in browser extensions / injected third-party
  // scripts rather than our code. We saw a burst of `Cannot read properties of
  // null (reading '_ensureSize')` and `... (reading 'document')` from a single
  // mobile UA across unrelated routes — none of these symbols exist in our
  // bundle (our only iframe access, ProjectPreviewEmbed/SitePreviewFrame, is
  // optional-chained). Matched by InboundFilters (a default integration;
  // `integrations: []` adds nothing, it does not disable defaults).
  ignoreErrors: [
    "Cannot read properties of null (reading '_ensureSize')",
    "null is not an object (evaluating",
    'contentWindow is null',
    "can't access property \"document\"",
    'ResizeObserver loop limit exceeded',
    'ResizeObserver loop completed with undelivered notifications',
  ],
  denyUrls: [
    /^chrome-extension:\/\//i,
    /^moz-extension:\/\//i,
    /^safari-(web-)?extension:\/\//i,
    /^chrome:\/\//i,
    /extensions\//i,
  ],
  // PII scrubber: removes email, phone, tokens, IP, etc. from every event
  // before it leaves the browser. Documented in cookie-policy as the safeguard
  // that lets us run error tracking on legitimate-interest basis (GDPR
  // art. 6(1)(f)) without explicit consent.
  beforeSend: scrubEvent,
});

if (typeof window !== 'undefined') {
  const win = window as Window & { __bugsinkSitoV3HandlersInstalled?: boolean };

  if (!win.__bugsinkSitoV3HandlersInstalled) {
    win.__bugsinkSitoV3HandlersInstalled = true;

    window.addEventListener('error', (event) => {
      if (event.error instanceof Error) {
        Sentry.captureException(event.error);
        return;
      }

      if (event.message) {
        Sentry.captureMessage(event.message, {
          level: 'error',
          tags: { app: 'sito-v3', source: 'window.error' },
          extra: {
            filename: event.filename,
            lineno: event.lineno,
            colno: event.colno,
          },
        });
      }
    });

    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
    });
  }
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

export function reportEvent(name: string, extra: Record<string, unknown> = {}): void {
  Sentry.captureMessage(name, {
    level: 'info',
    tags: {
      app: 'sito-v3',
      event: name,
    },
    extra,
  });
}
