/**
 * Cron: projects CRM sources (subscribers/leads/customers) into mkt_contacts.
 * Daily, low-frequency — the important newsletter-confirm escalation happens
 * inline via syncSubscriberConfirmed(). Idempotent (see audience-sync.ts).
 */
import { syncAudience } from '../lib/marketing/audience-sync';

export async function runMarketingAudienceSync(): Promise<void> {
  await syncAudience();
}
