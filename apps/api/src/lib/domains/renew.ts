/**
 * Rinnovo di un dominio: unica logica per POST /api/domains/:id/renew
 * (manuale) e per il pagamento di una proforma di rinnovo.
 *
 * - La nuova scadenza si calcola in SQL dalla scadenza precedente
 *   (expiration_date + n anni), come fanno i registrar anche nel periodo di
 *   grazia dopo la scadenza. Prima era calcolata in JS con Date e
 *   toISOString(): il risultato dipendeva dal fuso del processo.
 * - Azzera alert_sent_at e last_alert_milestone: senza questo il cron
 *   domain-alerts (dedup per milestone 30/14/7/1) non avvisava più per la
 *   scadenza successiva, perché la milestone rimasta (es. 1) è minore di tutte.
 * - Registra il rinnovo in domain_renewals, con la fattura se c'è.
 */
import { sql } from '../../db';

export class DomainRenewError extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) {
    super(message);
    this.name = 'DomainRenewError';
  }
}

export interface RenewDomainInput {
  years: number;
  /** Costo del rinnovo in euro (default: domains.renewal_cost). */
  cost?: number | null;
  invoiceId?: string | null;
  notes?: string | null;
}

export interface RenewDomainResult {
  domain: Record<string, unknown>;
  renewal: { id: string; expiration_before: string; expiration_after: string; cost: string | null };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- sql o tx di postgres-js
type Sql = any;

/** Va chiamata dentro una transazione quando fa parte di un'operazione più ampia. */
export async function renewDomain(tx: Sql, domainId: string, input: RenewDomainInput): Promise<RenewDomainResult> {
  if (!Number.isInteger(input.years) || input.years < 1 || input.years > 10) {
    throw new DomainRenewError('years: deve essere un intero fra 1 e 10');
  }
  const [current] = await tx`
    SELECT id, expiration_date::text AS expiration_date, renewal_cost
    FROM domains WHERE id = ${domainId} FOR UPDATE
  `;
  if (!current) throw new DomainRenewError('Dominio non trovato', 404);

  const [domain] = await tx`
    UPDATE domains SET
      expiration_date = (expiration_date + make_interval(years => ${input.years}::int))::date,
      last_renewal_date = CURRENT_DATE,
      status = 'active',
      alert_sent_at = NULL,
      last_alert_milestone = NULL
    WHERE id = ${domainId}
    RETURNING *, expiration_date::text AS expiration_date_text
  `;
  const [renewal] = await tx`
    INSERT INTO domain_renewals (domain_id, renewal_date, expiration_before, expiration_after, cost, invoice_id, notes)
    VALUES (${domainId}, CURRENT_DATE, ${current.expiration_date}::date, ${domain.expiration_date_text}::date,
            ${input.cost ?? current.renewal_cost ?? null}, ${input.invoiceId ?? null}, ${input.notes ?? null})
    RETURNING id, expiration_before::text AS expiration_before, expiration_after::text AS expiration_after, cost
  `;
  const { expiration_date_text: _t, ...rest } = domain;
  return { domain: rest, renewal };
}

/** Rinnovo autonomo (transazione propria). */
export async function renewDomainNow(domainId: string, input: RenewDomainInput): Promise<RenewDomainResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tx di postgres-js
  return sql.begin((tx: any) => renewDomain(tx, domainId, input));
}
