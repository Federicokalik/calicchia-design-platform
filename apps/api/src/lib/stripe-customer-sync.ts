/**
 * Sincronizzazione Stripe → gestionale dei clienti (webhook customer.created
 * e customer.updated).
 *
 * Bug 3 (vat_number cancellato): il webhook faceva
 *   ON CONFLICT (stripe_customer_id) DO UPDATE SET billing_address = EXCLUDED.billing_address,
 *   contact_name = EXCLUDED.contact_name, ...
 * con i soli dati Stripe. Poiché POST/PUT /api/customers chiamano
 * stripe.customers.create/update, ogni salvataggio dal gestionale tornava
 * indietro come webhook e sovrascriveva il record locale: spariva tutto ciò
 * che Stripe non conosce (vat_number, fiscal_code, sdi_code, pec) e
 * contact_name diventava il "name" Stripe, cioè la ragione sociale.
 *
 * Regole attuali (il gestionale è il master dell'anagrafica):
 *  - cliente non ancora presente: lo crea, tranne se l'ha creato il gestionale
 *    (metadata.caldes_origin = 'admin'): lo inserisce la POST stessa, e il
 *    webhook che arriva prima dell'INSERT creerebbe un duplicato;
 *  - customer.created su un cliente già presente: riempie solo i campi vuoti;
 *  - customer.updated: applica solo i campi che Stripe dichiara cambiati in
 *    `previous_attributes` (email, telefono, indirizzo, per esempio aggiornati
 *    dal cliente nel Billing Portal). L'indirizzo si fonde chiave per chiave:
 *    le chiavi che Stripe non gestisce restano. Nome e ragione sociale non
 *    tornano mai da Stripe (lì c'è un solo "name").
 */
import type Stripe from 'stripe';
import { jsonb, sql } from '../db';
import { logger } from './logger';

const log = logger.child({ scope: 'stripe-customer-sync' });

/** Metadata scritti su Stripe dai clienti creati dal gestionale. */
export const CALDES_ORIGIN_METADATA = { caldes_origin: 'admin' } as const;

export type StripeCustomerSyncResult = 'inserted' | 'updated' | 'unchanged' | 'skipped';

type Address = Record<string, string>;

/** Indirizzo Stripe nelle chiavi di customers.billing_address, senza valori vuoti. */
export function stripeAddressToBilling(address: Stripe.Address | null | undefined): Address {
  if (!address) return {};
  const mapped: Record<string, string | null | undefined> = {
    street: address.line1,
    city: address.city,
    postal_code: address.postal_code,
    province: address.state,
    country: address.country,
  };
  const out: Address = {};
  for (const [key, value] of Object.entries(mapped)) {
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }
  return out;
}

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

interface LocalCustomer {
  id: string;
  email: string | null;
  phone: string | null;
  billing_address: Record<string, unknown> | null;
}

export async function syncCustomerFromStripe(
  eventType: 'customer.created' | 'customer.updated',
  customer: Stripe.Customer,
  previousAttributes?: Record<string, unknown> | null,
): Promise<StripeCustomerSyncResult> {
  const stripeAddress = stripeAddressToBilling(customer.address);
  const email = isBlank(customer.email) ? null : customer.email!.trim();
  const phone = isBlank(customer.phone) ? null : customer.phone!.trim();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tx di postgres-js
  return sql.begin(async (tx: any) => {
    const [local] = (await tx`
      SELECT id, email, phone, billing_address
      FROM customers
      WHERE stripe_customer_id = ${customer.id}
      FOR UPDATE
    `) as LocalCustomer[];

    if (!local) {
      if (customer.metadata?.caldes_origin === CALDES_ORIGIN_METADATA.caldes_origin) return 'skipped';
      const inserted = await tx`
        INSERT INTO customers ${tx({
          stripe_customer_id: customer.id,
          email,
          contact_name: customer.name?.trim() || email || 'Cliente Stripe',
          company_name: customer.metadata?.company_name?.trim() || customer.name?.trim() || null,
          phone,
          billing_address: jsonb(stripeAddress),
        })}
        ON CONFLICT (stripe_customer_id) DO NOTHING
        RETURNING id
      `;
      return inserted.length ? 'inserted' : 'unchanged';
    }

    const localAddress = (local.billing_address && typeof local.billing_address === 'object' ? local.billing_address : {}) as Record<string, unknown>;
    const updates: Record<string, unknown> = {};

    if (eventType === 'customer.created') {
      if (isBlank(local.email) && email) updates.email = email;
      if (isBlank(local.phone) && phone) updates.phone = phone;
      const filled = { ...stripeAddress, ...localAddress };
      if (Object.keys(filled).length !== Object.keys(localAddress).length) updates.billing_address = jsonb(filled);
    } else {
      const changed = previousAttributes ?? {};
      if ('email' in changed && email && email.toLowerCase() !== (local.email ?? '').toLowerCase()) updates.email = email;
      if ('phone' in changed && phone && phone !== local.phone) updates.phone = phone;
      if ('address' in changed && Object.keys(stripeAddress).length) {
        const merged = { ...localAddress, ...stripeAddress };
        if (JSON.stringify(merged) !== JSON.stringify(localAddress)) updates.billing_address = jsonb(merged);
      }
    }

    if (updates.email) {
      // Indice unico su lower(email): un'email Stripe già usata da un altro
      // cliente farebbe fallire il webhook a ogni retry. Si salta solo l'email.
      const [taken] = await tx`
        SELECT id FROM customers WHERE lower(email) = lower(${updates.email as string}) AND id <> ${local.id} LIMIT 1
      `;
      if (taken) {
        log.warn({ customerId: local.id, stripeCustomerId: customer.id }, 'email Stripe già usata da un altro cliente: non sincronizzata');
        delete updates.email;
      }
    }

    if (!Object.keys(updates).length) return 'unchanged';
    await tx`UPDATE customers SET ${tx(updates)}, updated_at = now() WHERE id = ${local.id}`;
    return 'updated';
  });
}
