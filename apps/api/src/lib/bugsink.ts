/**
 * Bugsink Error Tracking for API (server-side)
 * Lightweight error tracking compatible with Sentry/Bugsink API
 */

import { logger } from './logger';

const log = logger.child({ scope: 'bugsink' });

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
let dsnString: string | null = null;
let enabled = false;

export function initBugsink() {
  const dsn = process.env.BUGSINK_DSN;
  if (!dsn) return;

  // Parse DSN: https://<publicKey>@<host>/<projectId>
  const match = dsn.match(/^(https?:\/\/)([^@]+)@([^/]+)\/(.+)$/);
  if (!match) {
    log.warn('invalid DSN format');
    return;
  }

  const [, protocol, key, host, projectId] = match;
  // Sentry/Bugsink ingest URL REQUIRES the `/api/<projectId>/envelope/` shape.
  // The previous build produced `<host>/<projectId>/envelope/` (no `/api/`) and
  // posted a bare event JSON instead of an envelope, so nothing was ever
  // ingested — backend errors were silently lost (see calendar 500 incident).
  endpoint = `${protocol}${host}/api/${projectId}/envelope/`;
  publicKey = key;
  dsnString = dsn;
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

  // Sentry event_id is a 32-char hex without dashes.
  const eventId = crypto.randomUUID().replace(/-/g, '');
  const sentAt = new Date().toISOString();

  const event: ErrorPayload = {
    event_id: eventId,
    timestamp: sentAt,
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

  // Sentry/Bugsink envelope = NDJSON: envelope header, item header, item payload.
  // JSON.stringify never emits raw newlines, so each item stays on one line and
  // the `length` field can be omitted (payload runs to the next newline).
  const envelope =
    JSON.stringify({ event_id: eventId, sent_at: sentAt, dsn: dsnString }) + '\n' +
    JSON.stringify({ type: 'event', content_type: 'application/json' }) + '\n' +
    JSON.stringify(event) + '\n';

  fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-sentry-envelope',
      'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${publicKey}, sentry_client=caldes-api/1.0.0`,
    },
    body: envelope,
  }).catch((fetchError) => {
    log.error({ err: fetchError }, 'failed to send error');
  });
}
