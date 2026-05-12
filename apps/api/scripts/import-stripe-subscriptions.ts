/**
 * Import bulk degli abbonamenti Stripe esistenti in `subscriptions` table.
 *
 * Per ogni subscription Stripe (active, past_due, trialing, canceled opt-in):
 *   - Upsert customer dal stripe_customer_id (UNIQUE) — auto-collega o crea placeholder
 *     con email/nome dal Stripe customer
 *   - Upsert subscription con stripe_subscription_id UNIQUE
 *   - Tutti i campi denormalizzati (amount, currency, interval, dates, status)
 *
 * Idempotente: ri-eseguibile, aggiorna in place.
 *
 * Uso:
 *   pnpm --filter @caldes/api tsx scripts/import-stripe-subscriptions.ts
 *
 * Flag:
 *   --dry-run           → mostra senza scrivere
 *   --include-canceled  → importa anche subscriptions canceled (default: skip)
 */
import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Stripe from 'stripe';
import postgres from 'postgres';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../../../.env') });

const SECRET = process.env.STRIPE_SECRET_KEY;
const DB = process.env.DATABASE_URL;
if (!SECRET) { console.error('❌ STRIPE_SECRET_KEY mancante'); process.exit(1); }
if (!DB) { console.error('❌ DATABASE_URL mancante'); process.exit(1); }

const dryRun = process.argv.includes('--dry-run');
const includeCanceled = process.argv.includes('--include-canceled');

const stripe = new Stripe(SECRET, { apiVersion: '2025-02-24.acacia' });
const sql = postgres(DB);

interface UpsertCustomerInput {
  stripe_customer_id: string;
  email: string;
  contact_name: string;
  company_name: string;
}

async function upsertCustomer(input: UpsertCustomerInput): Promise<string> {
  const [existing] = await sql`
    SELECT id FROM customers WHERE stripe_customer_id = ${input.stripe_customer_id} LIMIT 1
  ` as Array<{ id: string }>;
  if (existing) {
    // Best-effort sync but don't overwrite manual edits if email/name already set
    await sql`
      UPDATE customers
      SET email = COALESCE(NULLIF(email, ''), ${input.email}),
          contact_name = COALESCE(NULLIF(contact_name, ''), ${input.contact_name}),
          company_name = COALESCE(NULLIF(company_name, ''), ${input.company_name}),
          updated_at = NOW()
      WHERE id = ${existing.id}
    `;
    return existing.id;
  }
  const [c] = await sql`
    INSERT INTO customers ${sql({
      stripe_customer_id: input.stripe_customer_id,
      email: input.email,
      contact_name: input.contact_name,
      company_name: input.company_name,
      status: 'active',
    })}
    RETURNING id
  ` as Array<{ id: string }>;
  return c.id;
}

async function main() {
  const statusFilter = includeCanceled ? 'all' : 'all'; // Stripe SDK accepts 'all'; we filter after
  console.log(`🔍 Listing Stripe subscriptions${includeCanceled ? '' : ' (skipping canceled)'}...`);

  let cursor: string | undefined;
  let total = 0;
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const seenCustomers = new Set<string>();

  while (true) {
    const page = await stripe.subscriptions.list({
      limit: 100,
      status: statusFilter as Stripe.SubscriptionListParams.Status,
      starting_after: cursor,
      expand: ['data.customer'],
    });

    for (const sub of page.data) {
      total++;

      if (!includeCanceled && (sub.status === 'canceled' || sub.status === 'incomplete_expired')) {
        skipped++;
        continue;
      }

      const stripeCustomer = sub.customer as Stripe.Customer | Stripe.DeletedCustomer;
      if ('deleted' in stripeCustomer && stripeCustomer.deleted) {
        console.log(`   ⊘ ${sub.id} — customer deleted on Stripe, skipping`);
        skipped++;
        continue;
      }
      const customer = stripeCustomer as Stripe.Customer;

      const item = sub.items.data[0];
      const price = item?.price;
      const productIdOrObj = price?.product;
      let productName = 'Abbonamento';
      if (typeof productIdOrObj === 'string') {
        try {
          const p = await stripe.products.retrieve(productIdOrObj);
          productName = p.name;
        } catch {
          // fallback
        }
      } else if (productIdOrObj && 'name' in productIdOrObj) {
        productName = productIdOrObj.name;
      }

      const amount = price?.unit_amount != null ? price.unit_amount / 100 : 0;
      const currency = (price?.currency ?? 'eur').toUpperCase();
      const interval = price?.recurring?.interval ?? 'month';

      const action = dryRun ? '[DRY] ' : '';
      console.log(`   ${action}${productName} (${sub.id})`);
      console.log(`      customer=${customer.id} ${customer.email ?? '(no email)'}`);
      console.log(`      ${amount.toFixed(2)} ${currency} / ${interval} · status=${sub.status}`);

      if (dryRun) {
        seenCustomers.add(customer.id);
        continue;
      }

      const customerUuid = await upsertCustomer({
        stripe_customer_id: customer.id,
        email: customer.email ?? '',
        contact_name: customer.name ?? '',
        company_name: (customer.metadata?.company_name as string) ?? customer.name ?? '',
      });
      seenCustomers.add(customer.id);

      const startDate = sub.start_date ? new Date(sub.start_date * 1000).toISOString().slice(0, 10) : null;
      const currentStart = sub.current_period_start ? new Date(sub.current_period_start * 1000).toISOString().slice(0, 10) : null;
      const currentEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString().slice(0, 10) : null;
      const canceledAt = sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null;

      const subData = {
        provider: 'stripe',
        stripe_subscription_id: sub.id,
        customer_id: customerUuid,
        stripe_price_id: price?.id ?? null,
        name: productName,
        amount,
        currency,
        billing_interval: interval,
        status: sub.status,
        start_date: startDate,
        current_period_start: currentStart,
        current_period_end: currentEnd,
        next_billing_date: currentEnd,
        canceled_at: canceledAt,
        auto_renew: !sub.cancel_at_period_end,
      };

      const [existingSub] = await sql`
        SELECT id FROM subscriptions WHERE stripe_subscription_id = ${sub.id} LIMIT 1
      ` as Array<{ id: string }>;

      if (existingSub) {
        await sql`UPDATE subscriptions SET ${sql(subData)} WHERE id = ${existingSub.id}`;
        updated++;
      } else {
        await sql`INSERT INTO subscriptions ${sql(subData)}`;
        created++;
      }
    }

    if (!page.has_more) break;
    cursor = page.data[page.data.length - 1]?.id;
    if (!cursor) break;
  }

  console.log(`\n✅ Done: ${total} found, ${created} created, ${updated} updated, ${skipped} skipped`);
  console.log(`   ${seenCustomers.size} unique customers touched`);
  if (dryRun) console.log('   (DRY RUN — nothing written to DB)');
  await sql.end();
}

main().catch((err) => {
  console.error('\n❌ Errore:', err.message);
  process.exit(1);
});
