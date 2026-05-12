/**
 * Setup Stripe webhook endpoint per /api/stripe/webhook.
 *
 * - Lista webhook esistenti per evitare duplicati
 * - Crea endpoint con gli eventi che il nostro handler consuma
 * - Stampa il `whsec_…` da copiare in `.env` → `STRIPE_WEBHOOK_SECRET`
 *
 * Uso:
 *   STRIPE_WEBHOOK_URL=https://api.calicchia.design/api/stripe/webhook \
 *     pnpm --filter @caldes/api tsx scripts/setup-stripe-webhook.ts
 *
 * Override env: STRIPE_SECRET_KEY se vuoi forzare una chiave specifica.
 *
 * NB: usa la chiave live se sk_live_ è settata → l'endpoint viene creato in LIVE mode.
 * Per sandbox impostare STRIPE_SECRET_KEY=sk_test_ in una sessione separata.
 */
import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Stripe from 'stripe';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../../../.env') });

const SECRET = process.env.STRIPE_SECRET_KEY;
if (!SECRET) {
  console.error('❌ STRIPE_SECRET_KEY non impostata in .env');
  process.exit(1);
}

const WEBHOOK_URL =
  process.env.STRIPE_WEBHOOK_URL ||
  'https://api.calicchia.design/api/stripe/webhook';

// Eventi che il nostro handler in apps/api/src/routes/stripe-webhook.ts consuma
const EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  'checkout.session.completed',
  'checkout.session.expired',
  'customer.created',
  'customer.updated',
  'customer.deleted',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.created',
  'invoice.updated',
  'invoice.finalized',
  'invoice.paid',
  'invoice.payment_failed',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'charge.refunded',
];

const isLive = SECRET.startsWith('sk_live_');
const mode = isLive ? 'LIVE' : 'TEST';

console.log(`🔐 Stripe mode: ${mode}`);
console.log(`🎯 Target URL:  ${WEBHOOK_URL}`);
console.log(`📡 ${EVENTS.length} eventi configurati\n`);

const stripe = new Stripe(SECRET, { apiVersion: '2025-02-24.acacia' });

async function main() {
  // 1. Cerca endpoint esistente sulla stessa URL
  const existing = await stripe.webhookEndpoints.list({ limit: 100 });
  const match = existing.data.find((e) => e.url === WEBHOOK_URL);

  if (match) {
    console.log(`⚠️  Endpoint già esistente: ${match.id}`);
    console.log(`    Status: ${match.status}, Eventi: ${match.enabled_events.length}\n`);

    // Verifica eventi e aggiorna se differenti
    const missing = EVENTS.filter((e) => !match.enabled_events.includes(e));
    if (missing.length > 0) {
      console.log(`🔧 Eventi mancanti, aggiorno: ${missing.join(', ')}`);
      const merged = Array.from(new Set([...match.enabled_events, ...EVENTS])) as Stripe.WebhookEndpointUpdateParams.EnabledEvent[];
      await stripe.webhookEndpoints.update(match.id, { enabled_events: merged });
      console.log('✅ Eventi aggiornati\n');
    } else {
      console.log('✅ Tutti gli eventi previsti sono già configurati\n');
    }

    console.log('ℹ️  Stripe non permette di recuperare il signing secret di un endpoint esistente.');
    console.log('    Per ottenerlo:');
    console.log('    a) Vai sul Dashboard → Developers → Webhooks → seleziona endpoint → "Reveal" sotto Signing secret');
    console.log(`       https://dashboard.stripe.com/${isLive ? '' : 'test/'}webhooks/${match.id}`);
    console.log('    b) Oppure cancella e ricrea (questo script può farlo se elimini manualmente sopra)');
    return;
  }

  // 2. Crea nuovo endpoint
  console.log('🆕 Creo nuovo webhook endpoint...');
  const created = await stripe.webhookEndpoints.create({
    url: WEBHOOK_URL,
    enabled_events: EVENTS,
    description: 'Caldes — payment + subscription events (apps/api/src/routes/stripe-webhook.ts)',
  });

  console.log('\n✅ Webhook creato:');
  console.log(`   ID:       ${created.id}`);
  console.log(`   URL:      ${created.url}`);
  console.log(`   Status:   ${created.status}`);
  console.log(`   Eventi:   ${created.enabled_events.length}`);
  console.log(`\n🔑 SIGNING SECRET (copia in .env → STRIPE_WEBHOOK_SECRET):\n`);
  console.log(`   ${created.secret ?? '(secret non restituito dal SDK)'}\n`);
  console.log(`📋 Dashboard: https://dashboard.stripe.com/${isLive ? '' : 'test/'}webhooks/${created.id}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ Errore:', err.message);
    if (err.raw) console.error('   Raw:', JSON.stringify(err.raw, null, 2));
    process.exit(1);
  });
