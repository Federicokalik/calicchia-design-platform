/**
 * Send-eligibility — the GDPR hard-filter applied at enqueue time.
 *
 * Email: a contact is sendable only if it is active, reachable, NOT opted-out /
 * suppressed, and the consent basis permits marketing:
 *   - explicit consent requires double-opt-in confirmation (email_consent='confirmed'), OR
 *   - legitimate_interest_b2b (cold B2B), OR
 *   - soft_optin (existing relationship: leads/customers).
 * A 'consent'-basis contact that hasn't confirmed is NOT sent (protects against
 * emailing unconfirmed sign-ups).
 *
 * WhatsApp: reachable by phone AND explicit marketing opt-in (wa_consent). The
 * authoritative per-send re-check still happens via canSendWhatsApp() at drain.
 */
import { sql } from '../../db';

// postgres-js composed fragments don't carry a clean public TS type; `any` keeps
// embedding (`${emailEligibility()}`) friction-free, matching the codebase style.
/** Fragment usable as `... WHERE mc.status='active' ${emailEligibility()}` (alias mc). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function emailEligibility(): any {
  return sql`
    AND mc.email IS NOT NULL
    AND mc.email_consent NOT IN ('unsubscribed','bounced','complained')
    AND (mc.email_consent = 'confirmed'
         OR mc.email_legal_basis IN ('legitimate_interest_b2b','soft_optin'))
    AND NOT EXISTS (SELECT 1 FROM mkt_suppression s WHERE s.email_norm = mc.email_norm)
    -- Opposizione espressa nelle preferenze (portale/admin): "email marketing"
    -- disattivato vince sul soft opt-in di clienti e lead. Le righe create in
    -- automatico e mai modificate (updated_via NULL) non sono una scelta.
    AND NOT EXISTS (
      SELECT 1 FROM communication_preferences cp
      WHERE cp.email_marketing = false AND cp.updated_via IS NOT NULL
        AND ((mc.customer_id IS NOT NULL AND cp.customer_id = mc.customer_id)
          OR (mc.lead_id IS NOT NULL AND cp.lead_id = mc.lead_id)
          OR (cp.email IS NOT NULL AND lower(btrim(cp.email)) = mc.email_norm)))`;
}

/**
 * true se il contatto può ricevere email marketing adesso. Stessa regola delle
 * campagne (emailEligibility): le automazioni prima controllavano solo
 * unsubscribed/bounced/complained e scrivevano anche a iscritti double
 * opt-in non ancora confermati.
 */
export async function isEmailEligible(contactId: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM mkt_contacts mc
    WHERE mc.id = ${contactId} AND mc.status = 'active' ${emailEligibility()}
    LIMIT 1`;
  return rows.length > 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function whatsappEligibility(): any {
  return sql`
    AND mc.phone IS NOT NULL
    AND mc.wa_consent = 'opted_in'`;
}
