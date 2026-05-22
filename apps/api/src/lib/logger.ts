/**
 * Structured logger (BK-14).
 *
 * Single pino instance for the whole api process. In production it writes
 * newline-delimited JSON to stdout — one object per line, ready for any log
 * collector. In development it pipes through pino-pretty for readable output.
 *
 * Usage — bind a `scope` once per module and reuse it:
 *
 *   import { logger } from '../lib/logger';
 *   const log = logger.child({ scope: 'dunning' });
 *
 *   log.info({ count }, 'candidates found');
 *   log.error({ err }, 'reminder mail failed');
 *
 * pino call shape: `log.<level>(mergeObject?, message, ...interpolation)`.
 * Put structured fields in the merge object; pass errors as `{ err }` so the
 * std serializer expands name/message/stack.
 */
import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  base: { app: 'api' },
  // Redact credentials anywhere in a logged object. Covers both top-level keys
  // and one level of nesting (the common `{ headers: { authorization } }` case).
  redact: {
    paths: [
      'password',
      '*.password',
      'token',
      '*.token',
      'accessToken',
      '*.accessToken',
      'refreshToken',
      '*.refreshToken',
      'secret',
      '*.secret',
      'apiKey',
      '*.apiKey',
      'authorization',
      '*.authorization',
      'cookie',
      '*.cookie',
      'jwt',
      '*.jwt',
    ],
    censor: '[redacted]',
  },
  // pino's stdSerializers.err is applied automatically to the `err` key.
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname,app',
            messageFormat: '{scope} | {msg}',
          },
        },
      }
    : {}),
});

/** Child logger bound to a module scope. Equivalent to `logger.child({ scope })`. */
export function createLogger(scope: string) {
  return logger.child({ scope });
}
