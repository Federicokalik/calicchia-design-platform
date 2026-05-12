/**
 * Bugsink Error Tracking for API (server-side)
 * Lightweight error tracking compatible with Sentry/Bugsink API
 */

interface ErrorPayload {
  event_id: string;
  timestamp: string;
  platform: string;
  sdk: { name: string; version: string };
  exception: {
    values: Array<{
      type: string;
      value: string;
      stacktrace?: { frames: Array<{ function?: string; filename?: string; lineno?: number; colno?: number }> };
    }>;
  };
  server_name?: string;
  extra?: Record<string, unknown>;
  tags?: Record<string, string>;
}

let endpoint: string | null = null;
let publicKey: string | null = null;
let enabled = false;

export function initBugsink() {
  const dsn = process.env.BUGSINK_DSN;
  if (!dsn) return;

  // Parse DSN: https://publicKey@host/projectId
  const match = dsn.match(/^(https?:\/\/)([^@]+)@([^\/]+)(.*)$/);
  if (!match) {
    console.warn('[Bugsink] Invalid DSN format');
    return;
  }

  const [, protocol, key, host, path] = match;
  endpoint = `${protocol}${host}${path}/envelope/`;
  publicKey = key;
  enabled = true;
}

function parseStack(stack: string): Array<{ function?: string; filename?: string; lineno?: number; colno?: number }> {
  return stack
    .split('\n')
    .slice(1)
    .map((line) => {
      const match = line.match(/at\s+(.+?)\s+\((.+):(\d+):(\d+)\)/);
      if (match) {
        return {
          function: match[1],
          filename: match[2],
          lineno: parseInt(match[3], 10),
          colno: parseInt(match[4], 10),
        };
      }
      return { function: line.trim() };
    })
    .reverse();
}

export function captureException(error: Error, context?: Record<string, unknown>) {
  if (!enabled || !endpoint || !publicKey) {
    return;
  }

  const payload: ErrorPayload = {
    event_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    platform: 'node',
    sdk: { name: 'bugsink-api', version: '1.0.0' },
    server_name: 'caldes-api',
    exception: {
      values: [
        {
          type: error.name || 'Error',
          value: error.message || String(error),
          stacktrace: error.stack ? { frames: parseStack(error.stack) } : undefined,
        },
      ],
    },
    extra: context || {},
    tags: { app: 'api', environment: process.env.NODE_ENV || 'development' },
  };

  fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bugsink-Auth': `Bugsink sentry_key=${publicKey}`,
    },
    body: JSON.stringify(payload),
  }).catch((fetchError) => {
    console.error('[Bugsink] Failed to send error:', fetchError);
  });
}
