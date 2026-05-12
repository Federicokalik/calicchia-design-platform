/**
 * Standardized API response helpers
 *
 * Usage in routes:
 *   import { fail } from '../lib/responses';
 *   if (!email) fail('Email richiesta', 400);
 *
 * HTTPException is caught by the global error handler in app.ts
 */

import { HTTPException } from 'hono/http-exception';

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503;

/**
 * Throw an HTTPException with a JSON error message.
 * Caught by app.onError() and returned as { error: message }.
 */
export function fail(message: string, status: ErrorStatus = 400): never {
  throw new HTTPException(status, { message });
}
