import * as Sentry from '@sentry/react';

interface BugsinkConfig {
  dsn: string;
  enabled?: boolean;
  release?: string;
}

function withoutQueryString(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

class Bugsink {
  private initialized = false;
  private handlersInstalled = false;

  init(config: BugsinkConfig) {
    if (this.initialized) return;

    const enabled = config.enabled ?? Boolean(config.dsn);
    this.initialized = true;

    Sentry.init({
      dsn: config.dsn,
      enabled: enabled && Boolean(config.dsn),
      release: config.release ?? 'admin@1.0.0',
      environment: import.meta.env.MODE,
      integrations: [],
      tracesSampleRate: 0,
      beforeSend(event) {
        if (event.request?.url) {
          event.request.url = withoutQueryString(event.request.url);
        }

        return event;
      },
    });

    this.setupGlobalHandlers();
  }

  private setupGlobalHandlers() {
    if (this.handlersInstalled || typeof window === 'undefined') return;
    this.handlersInstalled = true;

    window.addEventListener('error', (event) => {
      if (event.error instanceof Error) {
        Sentry.captureException(event.error);
        return;
      }

      if (event.message) {
        Sentry.captureMessage(event.message, {
          level: 'error',
          tags: { app: 'admin', source: 'window.error' },
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

  captureError(error: Error, context?: Record<string, unknown>) {
    Sentry.captureException(error, {
      tags: { app: 'admin' },
      extra: context,
    });
  }

  setUser(user: { id?: string; email?: string } | null) {
    Sentry.setUser(user ? { id: user.id, email: user.email } : null);
  }

  captureMessage(message: string, level: 'info' | 'warning' | 'error' = 'info') {
    Sentry.captureMessage(message, {
      level,
      tags: { app: 'admin' },
    });
  }
}

export const bugsink = new Bugsink();
