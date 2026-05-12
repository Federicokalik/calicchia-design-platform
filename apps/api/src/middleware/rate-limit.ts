import { Context, Next } from 'hono';

export function createRateLimit(maxReq: number, windowMs: number) {
  const store = new Map<string, { count: number; resetAt: number }>();

  return async (c: Context, next: Next) => {
    const ip =
      c.req.header('cf-connecting-ip') ||
      c.req.header('x-forwarded-for')?.split(',')[0].trim() ||
      c.req.header('x-real-ip') ||
      'unknown';

    const now = Date.now();
    const entry = store.get(ip);

    if (!entry || now > entry.resetAt) {
      store.set(ip, { count: 1, resetAt: now + windowMs });
    } else if (entry.count >= maxReq) {
      return c.json({ error: 'Troppi tentativi. Riprova tra qualche minuto.' }, 429);
    } else {
      entry.count++;
    }

    await next();
  };
}
