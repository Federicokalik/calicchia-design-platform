/**
 * Va importato PER PRIMO dai test che passano dal webhook Stripe: imposta il
 * secret di firma prima che src/app.ts (e quindi routes/stripe-webhook.ts)
 * venga valutato. La chiave API resta assente: i test la impostano con
 * withEnv solo attorno alle chiamate al webhook, così nessuna route prova a
 * contattare api.stripe.com.
 */
import '../helpers/env';

export const TEST_STRIPE_WEBHOOK_SECRET = 'whsec_test_only_0123456789abcdef';
export const TEST_STRIPE_SECRET_KEY = 'sk_test_only_not_a_real_key';

process.env.STRIPE_WEBHOOK_SECRET = TEST_STRIPE_WEBHOOK_SECRET;
