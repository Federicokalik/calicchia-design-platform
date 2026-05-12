import * as Sentry from '@sentry/nextjs';

const DSN = process.env.NEXT_PUBLIC_BUGSINK_DSN;
const RELEASE = process.env.NEXT_PUBLIC_APP_RELEASE ?? '@caldes/sito-v3@0.1.0';

function withoutQueryString(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

Sentry.init({
  dsn: DSN,
  enabled: Boolean(DSN),
  release: RELEASE,
  environment: process.env.NODE_ENV,
  integrations: [],
  tracesSampleRate: 0,
  beforeSend(event) {
    if (event.request?.url) {
      event.request.url = withoutQueryString(event.request.url);
    }

    return event;
  },
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
