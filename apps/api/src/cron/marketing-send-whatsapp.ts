/**
 * Cron: drains queued WhatsApp broadcast campaigns.
 *
 * Reuses the mkt_campaigns/mkt_messages model (channel='whatsapp'). Far more
 * conservative than email: a per-tick batch cap, a global daily cap, jitter
 * between sends, and an authoritative per-recipient canSendWhatsApp() re-check
 * — GOWA is unofficial and aggressive sending risks a number ban. Broadcasts
 * are NOT recorded as whatsapp_conversations (replies create those naturally);
 * delivery state lives in mkt_messages.
 */
import { sql } from '../db';
import { sendWhatsAppText } from '../lib/whatsapp';
import { canSendWhatsApp } from '../lib/whatsapp-policy';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'marketing-send-wa' });

const DAILY_CAP = Number(process.env.WA_BROADCAST_DAILY_CAP || 200);
const PER_TICK_CAP = 25; // hard ceiling per tick regardless of campaign throttle

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CampaignRow { id: string; wa_body: string | null; throttle_per_min: number; }

export async function runMarketingSendWhatsApp(): Promise<void> {
  let campaigns: CampaignRow[];
  try {
    campaigns = await sql<CampaignRow[]>`
      SELECT id, wa_body, throttle_per_min
      FROM mkt_campaigns
      WHERE status IN ('queued','sending') AND channel = 'whatsapp'
        AND (scheduled_at IS NULL OR scheduled_at <= now())
      ORDER BY updated_at ASC LIMIT 5`;
  } catch (err) {
    log.error({ err }, 'wa campaign query failed');
    return;
  }
  if (!campaigns.length) return;

  // Global daily budget shared across all WA campaigns.
  const [{ sent_today }] = await sql`
    SELECT count(*)::int AS sent_today FROM mkt_messages
    WHERE channel = 'whatsapp' AND status = 'sent' AND sent_at >= date_trunc('day', now())`;
  let budget = Math.max(0, DAILY_CAP - sent_today);
  if (budget === 0) { log.info('wa daily cap reached — skipping'); return; }

  for (const camp of campaigns) {
    if (budget <= 0) break;
    try {
      budget -= await drainWhatsAppCampaign(camp, budget);
    } catch (err) {
      log.error({ err, campaignId: camp.id }, 'wa drain failed');
    }
  }
}

async function drainWhatsAppCampaign(camp: CampaignRow, budget: number): Promise<number> {
  if (!camp.wa_body) {
    await sql`UPDATE mkt_campaigns SET status='failed', updated_at=now() WHERE id=${camp.id}`;
    return 0;
  }
  await sql`UPDATE mkt_campaigns SET status='sending' WHERE id=${camp.id} AND status='queued'`;

  const limit = Math.min(camp.throttle_per_min, PER_TICK_CAP, budget);
  const claimed = await sql<Array<{ id: string }>>`
    UPDATE mkt_messages SET status='sending', attempts=attempts+1
    WHERE id IN (
      SELECT id FROM mkt_messages
      WHERE campaign_id=${camp.id} AND status='queued'
      ORDER BY queued_at LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id`;

  if (!claimed.length) {
    const [{ remaining }] = await sql`SELECT count(*)::int AS remaining FROM mkt_messages WHERE campaign_id=${camp.id} AND status IN ('queued','sending')`;
    if (remaining === 0) {
      await sql`UPDATE mkt_campaigns SET status='sent', sent_at=COALESCE(sent_at, now()), updated_at=now() WHERE id=${camp.id} AND status='sending'`;
    }
    return 0;
  }

  // Fetch recipient context (phone + CRM link) for the authoritative policy check.
  const ids = claimed.map((r) => r.id);
  const rows = await sql<Array<{ id: string; to_phone: string | null; customer_id: string | null; lead_id: string | null }>>`
    SELECT mm.id, mm.to_phone, mc.customer_id, mc.lead_id
    FROM mkt_messages mm JOIN mkt_contacts mc ON mc.id = mm.contact_id
    WHERE mm.id = ANY(${ids}::uuid[])`;

  let sent = 0;
  for (const r of rows) {
    if (!r.to_phone) {
      await sql`UPDATE mkt_messages SET status='skipped', skip_reason='invalid' WHERE id=${r.id}`;
      continue;
    }
    const policy = await canSendWhatsApp(r.to_phone, 'marketing', { customerId: r.customer_id, leadId: r.lead_id });
    if (!policy.allowed) {
      await sql`UPDATE mkt_messages SET status='skipped', skip_reason='no_consent' WHERE id=${r.id}`;
      continue;
    }
    try {
      const res = await sendWhatsAppText(r.to_phone, camp.wa_body);
      await sql`UPDATE mkt_messages SET status='sent', provider_message_id=${res.externalId ?? null}, sent_at=now() WHERE id=${r.id}`;
      sent++;
      await sleep(300 + Math.floor(Math.random() * 900)); // jitter — anti-ban
    } catch (err) {
      await sql`UPDATE mkt_messages SET status='failed', error=${String((err as Error).message ?? 'error').slice(0, 500)}, failed_at=now() WHERE id=${r.id}`;
    }
  }
  if (sent) await sql`UPDATE mkt_campaigns SET total_sent = total_sent + ${sent}, updated_at=now() WHERE id=${camp.id}`;
  log.info({ campaignId: camp.id, sent }, 'wa batch sent');
  return sent;
}
