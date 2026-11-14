/**
 * Destinatari delle comunicazioni amministrative verso un cliente (fatture,
 * rinnovi di domini, solleciti di pagamento, conferme di pagamento).
 *
 * Regola unica per tutti gli invii automatici: `customers.billing_emails` se
 * popolato, altrimenti `customers.email`. Le comunicazioni non
 * amministrative (accesso al portale, preventivi, messaggi diretti) restano
 * su `customers.email`.
 */

import { z } from 'zod';

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

/** Indirizzi segnaposto scritti dall'anonimizzazione GDPR: mai destinatari. */
const ERASED_RE = /^erased-.*@deleted\.invalid$/i;

export const MAX_BILLING_EMAILS = 10;

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isDeliverableEmail(value: string): boolean {
  return EMAIL_RE.test(value) && !ERASED_RE.test(value);
}

export interface RecipientSource {
  email: string | null | undefined;
  billing_emails: readonly string[] | null | undefined;
}

/**
 * Elenco ordinato, minuscolo e senza duplicati dei destinatari
 * amministrativi. Vuoto se il cliente non ha indirizzi utilizzabili.
 */
export function billingRecipients(source: RecipientSource): string[] {
  const pick = (list: readonly (string | null | undefined)[]) => {
    const seen = new Set<string>();
    for (const raw of list) {
      if (typeof raw !== 'string') continue;
      const email = normalizeEmail(raw);
      if (isDeliverableEmail(email)) seen.add(email);
    }
    return [...seen];
  };
  const billing = pick(source.billing_emails ?? []);
  return billing.length ? billing : pick([source.email]);
}

/**
 * Schema di `billing_emails` in ingresso (API e tool MCP): email valide,
 * minuscolo, senza duplicati, al massimo MAX_BILLING_EMAILS. `[]` svuota
 * l'elenco (si torna a customers.email).
 */
export const billingEmailsSchema = z
  .array(z.string().trim().toLowerCase().email())
  .max(MAX_BILLING_EMAILS)
  .transform((list) => [...new Set(list)]);
