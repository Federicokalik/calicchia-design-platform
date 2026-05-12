/**
 * Import bulk dei prodotti Stripe esistenti in `services` table.
 *
 * Per ogni `product` attivo:
 *   - Trova il default_price o il primo price attivo
 *   - Crea/aggiorna una riga `services` con stripe_product_id + stripe_price_id
 *   - Detecta categoria dal nome (hosting/domain/maintenance/development/other)
 *   - Detecta billing_interval da price.recurring.interval (month/year/one_time)
 *
 * Idempotente: ri-eseguibile, non duplica (UPSERT su stripe_product_id).
 *
 * Uso:
 *   pnpm --filter @caldes/api tsx scripts/import-stripe-products.ts
 *
 * Flag:
 *   --dry-run  → mostra cosa farebbe senza scrivere su DB
 *   --include-inactive → importa anche prodotti is_active=false
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
const includeInactive = process.argv.includes('--include-inactive');

const stripe = new Stripe(SECRET, { apiVersion: '2025-02-24.acacia' });
const sql = postgres(DB);

type Category = 'hosting' | 'domain' | 'maintenance' | 'development' | 'other';

function detectCategory(name: string, description: string | null): Category {
  const text = `${name} ${description ?? ''}`.toLowerCase();
  if (/(host(ing)?|server|spazio)/.test(text)) return 'hosting';
  if (/(dominio|domain)/.test(text)) return 'domain';
  if (/(manutenzion|maintenance|support|assistenza)/.test(text)) return 'maintenance';
  if (/(sito|web design|sviluppo|develop|landing|wordpress|next)/.test(text)) return 'development';
  return 'other';
}

function intervalToBilling(price: Stripe.Price | null): 'month' | 'year' | 'one_time' {
  if (!price?.recurring) return 'one_time';
  return price.recurring.interval === 'year' ? 'year' : 'month';
}

async function pickPrice(productId: string, defaultPriceId: string | Stripe.Price | null): Promise<Stripe.Price | null> {
  if (defaultPriceId) {
    const id = typeof defaultPriceId === 'string' ? defaultPriceId : defaultPriceId.id;
    try {
      const p = await stripe.prices.retrieve(id);
      if (p.active) return p;
    } catch {
      // Fall through to listing
    }
  }
  const list = await stripe.prices.list({ product: productId, active: true, limit: 100 });
  // Preferisci price ricorrente se esiste, altrimenti il più recente
  return list.data.sort((a, b) => {
    if (!!b.recurring !== !!a.recurring) return b.recurring ? 1 : -1;
    return b.created - a.created;
  })[0] ?? null;
}

async function main() {
  console.log(`🔍 Listing Stripe products${includeInactive ? ' (including inactive)' : ' (active only)'}...`);
  const products = await stripe.products.list({
    limit: 100,
    active: includeInactive ? undefined : true,
  });
  console.log(`   Found ${products.data.length} product(s)\n`);

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const product of products.data) {
    const price = await pickPrice(product.id, product.default_price);
    if (!price || price.unit_amount == null) {
      console.log(`   ⊘ ${product.name} — no usable price, skipping`);
      skipped++;
      continue;
    }

    const priceValue = (price.unit_amount ?? 0) / 100;
    const billingInterval = intervalToBilling(price);
    const category = detectCategory(product.name, product.description ?? null);
    const currency = (price.currency ?? 'eur').toUpperCase();

    const action = dryRun ? '[DRY] ' : '';
    console.log(`   ${action}${product.name}`);
    console.log(`      product=${product.id} price=${price.id}`);
    console.log(`      ${priceValue.toFixed(2)} ${currency} · ${billingInterval} · ${category} · active=${product.active}`);

    if (dryRun) continue;

    const existing = await sql`
      SELECT id FROM services WHERE stripe_product_id = ${product.id} LIMIT 1
    ` as Array<{ id: string }>;

    if (existing.length > 0) {
      await sql`
        UPDATE services SET ${sql({
          name: product.name,
          description: product.description ?? null,
          price: priceValue,
          currency,
          billing_interval: billingInterval,
          category,
          is_active: product.active,
          stripe_price_id: price.id,
        })}
        WHERE id = ${existing[0].id}
      `;
      updated++;
    } else {
      await sql`
        INSERT INTO services ${sql({
          name: product.name,
          description: product.description ?? null,
          price: priceValue,
          currency,
          billing_interval: billingInterval,
          category,
          is_active: product.active,
          stripe_product_id: product.id,
          stripe_price_id: price.id,
        })}
      `;
      created++;
    }
  }

  console.log(`\n✅ Done: ${created} created, ${updated} updated, ${skipped} skipped`);
  if (dryRun) console.log('   (DRY RUN — nothing written to DB)');
  await sql.end();
}

main().catch((err) => {
  console.error('\n❌ Errore:', err.message);
  process.exit(1);
});
