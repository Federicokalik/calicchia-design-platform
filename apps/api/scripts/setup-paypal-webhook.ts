/**
 * Setup PayPal webhook endpoint per /api/paypal-webhook.
 *
 * Speculare a setup-stripe-webhook.ts.
 *
 * - Lista webhook esistenti per evitare duplicati
 * - Crea webhook con eventi consumati da apps/api/src/routes/paypal-webhook.ts
 * - Stampa il webhook ID da copiare in `.env` → `PAYPAL_WEBHOOK_ID`
 *
 * Uso (sandbox):
 *   PAYPAL_CLIENT_ID=AY1n... PAYPAL_CLIENT_SECRET=EM4q... \
 *   PAYPAL_MODE=sandbox \
 *   PAYPAL_WEBHOOK_URL=https://api.calicchia.design/api/paypal-webhook \
 *     pnpm --filter @caldes/api tsx scripts/setup-paypal-webhook.ts
 *
 * Uso (live):
 *   PAYPAL_MODE=live + credenziali live → endpoint live.
 *
 * NB: PayPal a differenza di Stripe NON stampa il signing secret. La verifica firma
 * usa `webhook_id` + 5 header in ogni delivery → vedi `lib/paypal-webhook.ts`.
 * Quindi qui ci serve solo l'ID del webhook.
 */
import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../../../.env') });

const CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const MODE = process.env.PAYPAL_MODE || 'sandbox';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ PAYPAL_CLIENT_ID o PAYPAL_CLIENT_SECRET non impostati in .env');
  console.error('   Creali su https://developer.paypal.com → Apps & Credentials');
  process.exit(1);
}

const WEBHOOK_URL =
  process.env.PAYPAL_WEBHOOK_URL ||
  'https://api.calicchia.design/api/paypal-webhook';

const BASE_URL = MODE === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

// Eventi consumati da apps/api/src/routes/paypal-webhook.ts
const EVENT_TYPES = [
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REFUNDED',
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.SUSPENDED',
  'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
];

console.log(`🔐 PayPal mode: ${MODE.toUpperCase()}`);
console.log(`🎯 Target URL:  ${WEBHOOK_URL}`);
console.log(`📡 ${EVENT_TYPES.length} eventi configurati\n`);

async function getAccessToken(): Promise<string> {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OAuth failed: ${res.status} ${txt}`);
  }
  const data = await res.json() as { access_token: string };
  return data.access_token;
}

async function listWebhooks(token: string): Promise<Array<{ id: string; url: string; event_types: Array<{ name: string }> }>> {
  const res = await fetch(`${BASE_URL}/v1/notifications/webhooks`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`List webhooks failed: ${res.status} ${txt}`);
  }
  const data = await res.json() as { webhooks?: Array<{ id: string; url: string; event_types: Array<{ name: string }> }> };
  return data.webhooks ?? [];
}

async function createWebhook(token: string): Promise<{ id: string; url: string; event_types: Array<{ name: string }> }> {
  const res = await fetch(`${BASE_URL}/v1/notifications/webhooks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: WEBHOOK_URL,
      event_types: EVENT_TYPES.map((name) => ({ name })),
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Create webhook failed: ${res.status} ${txt}`);
  }
  return res.json() as Promise<{ id: string; url: string; event_types: Array<{ name: string }> }>;
}

async function updateWebhook(token: string, id: string, newEventTypes: string[]): Promise<void> {
  const res = await fetch(`${BASE_URL}/v1/notifications/webhooks/${id}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([
      {
        op: 'replace',
        path: '/event_types',
        value: newEventTypes.map((name) => ({ name })),
      },
    ]),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Update webhook failed: ${res.status} ${txt}`);
  }
}

async function main() {
  console.log('🔓 Autenticazione...');
  const token = await getAccessToken();
  console.log('✅ Token ottenuto\n');

  console.log('📋 Webhook esistenti:');
  const existing = await listWebhooks(token);
  if (existing.length === 0) {
    console.log('   (nessuno)\n');
  } else {
    existing.forEach((w) => console.log(`   - ${w.id} → ${w.url} (${w.event_types.length} eventi)`));
    console.log();
  }

  const match = existing.find((w) => w.url === WEBHOOK_URL);

  if (match) {
    console.log(`⚠️  Endpoint già esistente: ${match.id}`);
    const existingNames = new Set(match.event_types.map((e) => e.name));
    const missing = EVENT_TYPES.filter((e) => !existingNames.has(e));
    if (missing.length > 0) {
      console.log(`🔧 Eventi mancanti, aggiorno: ${missing.join(', ')}`);
      const merged = Array.from(new Set([...match.event_types.map((e) => e.name), ...EVENT_TYPES]));
      await updateWebhook(token, match.id, merged);
      console.log('✅ Eventi aggiornati\n');
    } else {
      console.log('✅ Tutti gli eventi previsti sono già configurati\n');
    }

    console.log(`🔑 WEBHOOK ID (copia in .env → PAYPAL_WEBHOOK_ID):\n`);
    console.log(`   ${match.id}\n`);
    return;
  }

  console.log('🆕 Creo nuovo webhook...');
  const created = await createWebhook(token);

  console.log('\n✅ Webhook creato:');
  console.log(`   ID:     ${created.id}`);
  console.log(`   URL:    ${created.url}`);
  console.log(`   Eventi: ${created.event_types.length}`);
  console.log(`\n🔑 WEBHOOK ID (copia in .env → PAYPAL_WEBHOOK_ID):\n`);
  console.log(`   ${created.id}\n`);
  console.log(`📋 Dashboard: https://developer.paypal.com/dashboard/applications/${MODE}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ Errore:', err.message);
    process.exit(1);
  });
