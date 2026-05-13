import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { generatePaypalClientToken, isPaypalReady } from '../lib/paypal';

export const paypal = new Hono();

/**
 * GET /api/paypal/client-token
 *
 * Returns a short-lived (~3h) client token used to initialize the PayPal JS SDK
 * with Advanced Credit/Debit Card Payments (Card Fields). Without this token
 * the SDK can still render the yellow PayPal button, but the card form is
 * disabled (isEligible() returns false).
 *
 * Public on purpose: the token by itself doesn't authorize any payment — it's
 * a session capability for the browser SDK, paired server-side with order
 * creation/capture endpoints that DO require auth.
 */
paypal.get('/client-token', async (c) => {
  if (!(await isPaypalReady())) {
    throw new HTTPException(503, { message: 'PayPal non configurato' });
  }
  try {
    const clientToken = await generatePaypalClientToken();
    return c.json({ client_token: clientToken });
  } catch (err) {
    console.error('[paypal/client-token] error:', (err as Error).message);
    throw new HTTPException(502, { message: 'Impossibile generare client token PayPal' });
  }
});
