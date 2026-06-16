/**
 * Cron: drains queued email campaigns into actual sends.
 *
 * Per tick: finds campaigns due (status queued/sending, scheduled_at past or
 * null), atomically CLAIMS a throttle-sized batch of their queued messages
 * (UPDATE…WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) — the lock is held for
 * the claim so two overlapping ticks can't grab the same row), renders each
 * recipient's HTML from the precompiled template, and sends via the marketing
 * transport. No auto-retry (mirrors whatsapp-scheduled): a failed row is left
 * 'failed' for the admin to see. WhatsApp campaigns are drained by Phase 3.
 */
import { sql } from '../db';
import {
  renderForMessage, sendMarketingEmail, personalize, type PersonalizationVars,
} from '../lib/email-marketing';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'marketing-send' });
const API_URL = process.env.API_URL || 'http://localhost:3001';

interface CampaignRow {
  id: string; channel: string; subject: string | null;
  compiled_html: string | null; from_identity_id: string | null; throttle_per_min: number;
}

export async function runMarketingSend(): Promise<void> {
  let campaigns: CampaignRow[];
  try {
    campaigns = await sql<CampaignRow[]>`
      SELECT id, channel, subject, compiled_html, from_identity_id, throttle_per_min
      FROM mkt_campaigns
      WHERE status IN ('queued','sending')
        AND channel = 'email'
        AND (scheduled_at IS NULL OR scheduled_at <= now())
      ORDER BY updated_at ASC
      LIMIT 10`;
  } catch (err) {
    log.error({ err }, 'campaign query failed');
    return;
  }

  for (const camp of campaigns) {
    try {
      await drainEmailCampaign(camp);
    } catch (err) {
      log.error({ err, campaignId: camp.id }, 'drain failed');
    }
  }
}

async function drainEmailCampaign(camp: CampaignRow): Promise<void> {
  if (!camp.compiled_html) {
    log.warn({ campaignId: camp.id }, 'no compiled_html — marking failed');
    await sql`UPDATE mkt_campaigns SET status='failed', updated_at=now() WHERE id=${camp.id}`;
    return;
  }

  await sql`UPDATE mkt_campaigns SET status='sending' WHERE id=${camp.id} AND status='queued'`;

  // Resolve sender identity (optional).
  let from: string | undefined;
  let replyTo: string | undefined;
  if (camp.from_identity_id) {
    const [s] = await sql`SELECT from_name, from_email, reply_to FROM mkt_sender_identities WHERE id=${camp.from_identity_id}`;
    if (s?.from_email) { from = `${s.from_name} <${s.from_email}>`; replyTo = s.reply_to ?? undefined; }
  }

  // Atomically claim a batch.
  const batch = await sql<Array<{ id: string; contact_id: string; to_email: string; unsubscribe_token: string }>>`
    UPDATE mkt_messages SET status='sending', attempts=attempts+1
    WHERE id IN (
      SELECT id FROM mkt_messages
      WHERE campaign_id=${camp.id} AND status='queued'
      ORDER BY queued_at
      LIMIT ${camp.throttle_per_min}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, contact_id, to_email, unsubscribe_token`;

  if (!batch.length) {
    // Nothing left to claim → finalize if no queued rows remain.
    const [{ remaining }] = await sql`SELECT count(*)::int AS remaining FROM mkt_messages WHERE campaign_id=${camp.id} AND status IN ('queued','sending')`;
    if (remaining === 0) {
      await sql`UPDATE mkt_campaigns SET status='sent', sent_at=COALESCE(sent_at, now()), updated_at=now() WHERE id=${camp.id} AND status='sending'`;
      log.info({ campaignId: camp.id }, 'campaign sent');
    }
    return;
  }

  // Load personalization vars for the claimed contacts in one round-trip.
  const contactIds = batch.map((b) => b.contact_id).filter(Boolean);
  const varsById = new Map<string, PersonalizationVars>();
  if (contactIds.length) {
    const rows = await sql<Array<{ id: string } & PersonalizationVars>>`
      SELECT id, first_name, last_name, company, role, email
      FROM mkt_contacts WHERE id = ANY(${contactIds})`;
    for (const r of rows) varsById.set(r.id, r);
  }

  log.info({ campaignId: camp.id, batch: batch.length }, 'sending batch');
  let sent = 0;
  for (const msg of batch) {
    const unsubscribeUrl = `${API_URL}/api/mkt-track/u/${msg.unsubscribe_token}`;
    const vars = varsById.get(msg.contact_id);
    try {
      const html = renderForMessage(camp.compiled_html, msg, vars);
      const subject = vars ? personalize(camp.subject || '', vars) : (camp.subject || '');
      const res = await sendMarketingEmail({
        to: msg.to_email,
        subject,
        html,
        from, replyTo, unsubscribeUrl,
      });
      if (res.success) {
        await sql`UPDATE mkt_messages SET status='sent', provider_message_id=${res.messageId ?? null}, sent_at=now() WHERE id=${msg.id}`;
        sent++;
      } else {
        await sql`UPDATE mkt_messages SET status='failed', error=${(res.error ?? 'unknown').slice(0, 500)}, failed_at=now() WHERE id=${msg.id}`;
      }
    } catch (err) {
      await sql`UPDATE mkt_messages SET status='failed', error=${String((err as Error).message ?? 'error').slice(0, 500)}, failed_at=now() WHERE id=${msg.id}`;
    }
  }
  if (sent) await sql`UPDATE mkt_campaigns SET total_sent = total_sent + ${sent}, updated_at=now() WHERE id=${camp.id}`;
}
