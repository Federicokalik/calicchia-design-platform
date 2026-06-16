/**
 * Audience sync — projects the CRM systems-of-record (newsletter_subscribers,
 * leads, customers) into the unified `mkt_contacts` marketing layer.
 *
 * Design invariants:
 *  - ONE-WAY: sources are authoritative for CRM; mkt_contacts is a projection.
 *  - CONSENT-MONOTONIC: a sync NEVER weakens a stronger/protective consent state
 *    (unsubscribed/bounced/complained are sticky; confirmed is never downgraded).
 *  - ENRICHMENT-ONLY: existing non-null fields are preserved (COALESCE); the sync
 *    only fills gaps, so manual admin edits are not clobbered.
 *  - IDEMPOTENT: dedup via the partial unique index on email_norm + ON CONFLICT.
 *    Only rows WITH an email are synced (phone-only CRM rows would duplicate on
 *    re-run since there is no phone arbiter — those are added manually instead).
 */

import { sql } from '../../db';
import { logger } from '../logger';

const log = logger.child({ scope: 'audience-sync' });

// Shared consent-merge CASE: keep protective states, allow escalation to
// confirmed, never downgrade. Referenced via string interpolation of a constant
// (no user input) into the ON CONFLICT clause.
const CONSENT_MERGE = sql`
  CASE
    WHEN mkt_contacts.email_consent IN ('unsubscribed','bounced','complained')
      THEN mkt_contacts.email_consent
    WHEN EXCLUDED.email_consent IN ('unsubscribed','bounced','complained')
      THEN EXCLUDED.email_consent
    WHEN EXCLUDED.email_consent = 'confirmed' THEN 'confirmed'
    ELSE mkt_contacts.email_consent
  END`;

/** Sync confirmed/pending/unsubscribed newsletter subscribers → mkt_contacts. */
export async function syncFromSubscribers(): Promise<number> {
  const res = await sql`
    INSERT INTO mkt_contacts
      (email, first_name, subscriber_id, email_consent, email_legal_basis,
       audience_type, consent_source, consent_ip, consent_user_agent, consent_collected_at)
    SELECT ns.email, ns.name, ns.id,
      CASE ns.status
        WHEN 'confirmed' THEN 'confirmed'
        WHEN 'unsubscribed' THEN 'unsubscribed'
        ELSE 'unconfirmed' END,
      'consent', 'warm', COALESCE(ns.source, 'website'),
      ns.consent_ip, ns.consent_user_agent, ns.created_at
    FROM newsletter_subscribers ns
    WHERE ns.email IS NOT NULL
    ON CONFLICT (email_norm) WHERE email IS NOT NULL DO UPDATE SET
      subscriber_id = COALESCE(mkt_contacts.subscriber_id, EXCLUDED.subscriber_id),
      first_name    = COALESCE(mkt_contacts.first_name, EXCLUDED.first_name),
      email_consent = ${CONSENT_MERGE},
      consent_ip    = COALESCE(mkt_contacts.consent_ip, EXCLUDED.consent_ip),
      updated_at    = now()
  `;
  return res.count;
}

/** Sync leads → mkt_contacts (warm, soft opt-in — they engaged with us). */
export async function syncFromLeads(): Promise<number> {
  const res = await sql`
    INSERT INTO mkt_contacts
      (email, first_name, phone, company, lead_id, email_consent,
       email_legal_basis, audience_type, consent_source, tags)
    SELECT l.email, l.name, l.phone, l.company, l.id,
      'unconfirmed', 'soft_optin', 'warm', COALESCE('lead:' || l.source, 'lead'),
      COALESCE(l.tags, '{}')
    FROM leads l
    WHERE l.email IS NOT NULL
    ON CONFLICT (email_norm) WHERE email IS NOT NULL DO UPDATE SET
      lead_id    = COALESCE(mkt_contacts.lead_id, EXCLUDED.lead_id),
      first_name = COALESCE(mkt_contacts.first_name, EXCLUDED.first_name),
      phone      = COALESCE(mkt_contacts.phone, EXCLUDED.phone),
      company    = COALESCE(mkt_contacts.company, EXCLUDED.company),
      updated_at = now()
  `;
  return res.count;
}

/** Sync customers → mkt_contacts (existing business relationship). */
export async function syncFromCustomers(): Promise<number> {
  const res = await sql`
    INSERT INTO mkt_contacts
      (email, first_name, phone, company, customer_id, email_consent,
       email_legal_basis, audience_type, consent_source)
    SELECT c.email, c.contact_name, c.phone, c.company_name, c.id,
      'unconfirmed', 'soft_optin', 'warm', 'customer'
    FROM customers c
    WHERE c.email IS NOT NULL
    ON CONFLICT (email_norm) WHERE email IS NOT NULL DO UPDATE SET
      customer_id = COALESCE(mkt_contacts.customer_id, EXCLUDED.customer_id),
      first_name  = COALESCE(mkt_contacts.first_name, EXCLUDED.first_name),
      phone       = COALESCE(mkt_contacts.phone, EXCLUDED.phone),
      company     = COALESCE(mkt_contacts.company, EXCLUDED.company),
      updated_at  = now()
  `;
  return res.count;
}

/**
 * Mirror the WhatsApp marketing opt-in/out from communication_preferences into
 * mkt_contacts.wa_consent, matched by the linked customer_id / lead_id (the
 * reliable keys). Contacts with no CRM link stay wa_consent='none' → not
 * broadcastable (correct: no explicit opt-in). The authoritative per-send check
 * still runs via canSendWhatsApp() at drain time.
 */
export async function syncWaConsent(): Promise<number> {
  const byCustomer = await sql`
    UPDATE mkt_contacts mc
    SET wa_consent = CASE WHEN cp.whatsapp_marketing THEN 'opted_in' ELSE 'opted_out' END,
        updated_at = now()
    FROM communication_preferences cp
    WHERE cp.customer_id IS NOT NULL AND cp.customer_id = mc.customer_id
      AND mc.wa_consent IS DISTINCT FROM (CASE WHEN cp.whatsapp_marketing THEN 'opted_in' ELSE 'opted_out' END)`;
  const byLead = await sql`
    UPDATE mkt_contacts mc
    SET wa_consent = CASE WHEN cp.whatsapp_marketing THEN 'opted_in' ELSE 'opted_out' END,
        updated_at = now()
    FROM communication_preferences cp
    WHERE cp.lead_id IS NOT NULL AND cp.lead_id = mc.lead_id
      AND mc.wa_consent IS DISTINCT FROM (CASE WHEN cp.whatsapp_marketing THEN 'opted_in' ELSE 'opted_out' END)`;
  return byCustomer.count + byLead.count;
}

/** Full audience sync — run by the cron. Each source is isolated so one failing
 *  source doesn't abort the others. */
export async function syncAudience(): Promise<void> {
  for (const [name, fn] of [
    ['subscribers', syncFromSubscribers],
    ['leads', syncFromLeads],
    ['customers', syncFromCustomers],
    ['wa-consent', syncWaConsent],
  ] as const) {
    try {
      const n = await fn();
      log.info({ source: name, affected: n }, 'audience sync');
    } catch (err) {
      log.error({ err, source: name }, 'audience sync failed');
    }
  }
}

/**
 * Inline hook: called when a newsletter subscriber confirms double opt-in, so the
 * marketing projection reflects the new consent immediately (not at the next
 * daily cron). Escalates the matching mkt_contact to confirmed.
 */
export async function syncSubscriberConfirmed(subscriberId: string): Promise<void> {
  try {
    await sql`
      INSERT INTO mkt_contacts
        (email, first_name, subscriber_id, email_consent, email_legal_basis,
         audience_type, consent_source, consent_ip, consent_collected_at)
      SELECT ns.email, ns.name, ns.id, 'confirmed', 'consent', 'warm',
        COALESCE(ns.source, 'website'), ns.confirmed_ip, ns.confirmed_at
      FROM newsletter_subscribers ns
      WHERE ns.id = ${subscriberId} AND ns.email IS NOT NULL
      ON CONFLICT (email_norm) WHERE email IS NOT NULL DO UPDATE SET
        subscriber_id = COALESCE(mkt_contacts.subscriber_id, EXCLUDED.subscriber_id),
        email_consent = ${CONSENT_MERGE},
        consent_ip    = COALESCE(mkt_contacts.consent_ip, EXCLUDED.consent_ip),
        updated_at    = now()
    `;
  } catch (err) {
    log.warn({ err, subscriberId }, 'inline subscriber-confirmed sync failed');
  }
}
