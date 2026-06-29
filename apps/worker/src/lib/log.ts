/**
 * Worker logger — mirrors apps/api/src/lib/logger.ts so the worker emits the
 * same structured ndjson (production) / pino-pretty (dev) as the API.
 */
import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  base: { app: 'worker' },
  redact: {
    paths: [
      'password',
      '*.password',
      'token',
      '*.token',
      'secret',
      '*.secret',
      'authorization',
      '*.authorization',
      'cookie',
      '*.cookie',
    ],
    censor: '[redacted]',
  },
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