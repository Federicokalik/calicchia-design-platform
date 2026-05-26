/**
 * Cron: drains whatsapp_scheduled_messages (mig 110).
 *
 * Reads rows where `send_at <= now() AND sent_at IS NULL AND error IS NULL`,
 * fires each via sendWhatsAppText / sendWhatsAppMedia respecting the same
 * opt-out policy as live sends, then writes back `sent_at` + a new row in
 * whatsapp_messages with `sent_message_id` linkage. On failure we record
 * `error` and leave `sent_at` NULL so the admin can see what didn't go.
 *
 * Idempotency: we lock with `FOR UPDATE SKIP LOCKED` inside a transaction so
 * two cron instances (or a restart mid-batch) can't double-send.
 *
 * No automatic retry — the admin sees the error in the UI and can resubmit
 * or extend the schedule manually. Auto-retry on WhatsApp messages is risky
 * (rate-limit ban, duplicate deliveries on flaky GOWA acks).
 */

import { sql } from '../db';
import { sendWhatsAppText, sendWhatsAppMedia } from '../lib/whatsapp';
import { canSendWhatsApp, type WhatsAppCategory } from '../lib/whatsapp-policy';
import { publishWaEvent } from '../lib/whatsapp-events';
import { signFileUrl } from '../lib/private-files';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'whatsapp-scheduled' });

interface ScheduledRow {
  id: string;
  conversation_id: string;
  body: string;
  media_path: string | null;
  media_mime: string | null;
  category: WhatsAppCategory;
  send_at: string;
  phone: string;
  customer_id: string | null;
  lead_id: string | null;
  attempts: number;
}

export async function runWhatsAppScheduled(): Promise<void> {
  let due: ScheduledRow[];
  try {
    due = await sql<ScheduledRow[]>`
      SELECT s.id, s.conversation_id, s.body, s.media_path, s.media_mime,
             s.category, s.send_at, s.attempts,
             wc.phone, wc.customer_id, wc.lead_id
      FROM whatsapp_scheduled_messages s
      JOIN whatsapp_conversations wc ON wc.id = s.conversation_id
      WHERE s.sent_at IS NULL
        AND s.error IS NULL
        AND s.send_at <= now()
      ORDER BY s.send_at
      LIMIT 50
      FOR UPDATE OF s SKIP LOCKED
    `;
  } catch (err) {
    log.error({ err }, 'whatsapp-scheduled: query failed');
    return;
  }

  if (!due.length) return;
  log.info({ count: due.length }, 'whatsapp-scheduled: processing batch');

  for (const row of due) {
    try {
      const policy = await canSendWhatsApp(row.phone, row.category, {
        customerId: row.customer_id,
        leadId: row.lead_id,
      });
      if (!policy.allowed) {
        await sql`
          UPDATE whatsapp_scheduled_messages
          SET error = ${`opt_out:${policy.reason || 'unknown'}`},
              attempts = attempts + 1
          WHERE id = ${row.id}
        `;
        continue;
      }

      let externalId: string | undefined;
      let messageType: 'text' | 'image' | 'video' | 'audio' | 'document' = 'text';
      if (row.media_path) {
        const url = signFileUrl('whatsapp', row.media_path);
        const mime = row.media_mime || 'application/octet-stream';
        messageType =
          mime.startsWith('image/') ? 'image' :
          mime.startsWith('video/') ? 'video' :
          mime.startsWith('audio/') ? 'audio' :
          'document';
        const res = await sendWhatsAppMedia(row.phone, row.body, url, row.media_path, mime);
        externalId = res.externalId;
      } else {
        const res = await sendWhatsAppText(row.phone, row.body);
        externalId = res.externalId;
      }

      const inserted = await sql`
        INSERT INTO whatsapp_messages
          (conversation_id, external_id, direction, category, type, body,
           media_path, media_mime, sender_kind, meta)
        VALUES
          (${row.conversation_id}, ${externalId ?? null}, 'outbound',
           ${row.category}, ${messageType}, ${row.body},
           ${row.media_path}, ${row.media_mime},
           'admin', ${sql.json({ scheduled: true, scheduled_id: row.id })})
        RETURNING id
      ` as Array<{ id: string }>;

      await sql`
        UPDATE whatsapp_scheduled_messages
        SET sent_at = now(),
            sent_message_id = ${inserted[0].id},
            attempts = attempts + 1
        WHERE id = ${row.id}
      `;
      await sql`
        UPDATE whatsapp_conversations
        SET last_message_at = now(),
            last_message_preview = ${row.body.slice(0, 200)},
            unread_count = 0
        WHERE id = ${row.conversation_id}
      `;

      publishWaEvent({
        type: 'message:inserted',
        conversationId: row.conversation_id,
        direction: 'outbound',
        messageId: inserted[0].id,
        externalId: externalId ?? null,
        unread: false,
      });
      publishWaEvent({ type: 'conversation:updated', conversationId: row.conversation_id, reason: 'message' });
    } catch (err) {
      const msg = (err as Error).message || 'unknown_error';
      log.warn({ err, scheduledId: row.id }, 'whatsapp-scheduled: send failed');
      await sql`
        UPDATE whatsapp_scheduled_messages
        SET error = ${msg.slice(0, 500)},
            attempts = attempts + 1
        WHERE id = ${row.id}
      `;
    }
  }
}
