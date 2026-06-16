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
    AND NOT EXISTS (SELECT 1 FROM mkt_suppression s WHERE s.email_norm = mc.email_norm)`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function whatsappEligibility(): any {
  return sql`
    AND mc.phone IS NOT NULL
    AND mc.wa_consent = 'opted_in'`;
}
