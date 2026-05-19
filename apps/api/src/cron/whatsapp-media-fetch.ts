/**
 * Cron — scarica media dei messaggi WhatsApp inbound.
 *
 * Quando un webhook GOWA arriva per un messaggio non-text, salviamo subito la
 * riga in whatsapp_messages con meta.media_pending = true. Questo job poi
 * scarica il binario via GOWA /message/<id>/download e lo salva in
 * UPLOAD_DIR/whatsapp/. Esposto come /media/whatsapp/<uuid>.<ext>.
 *
 * Strategia: max 20 per giro, ogni 30s. Fallimenti loggati, riproveremo nel
 * prossimo tick.
 */

import { sql } from '../db';
import { downloadMedia } from '../lib/whatsapp';

const BATCH_SIZE = 20;

interface PendingRow {
  id: string;
  external_id: string | null;
  type: string;
  meta: any;
}

export async function runWhatsAppMediaFetch(): Promise<void> {
  const rows = await sql`
    SELECT id, external_id, type, meta
    FROM whatsapp_messages
    WHERE media_path IS NULL
      AND external_id IS NOT NULL
      AND type IN ('image','document','audio','video','sticker')
      AND COALESCE((meta->>'media_failed_attempts')::int, 0) < 3
      AND created_at > now() - interval '7 days'
    ORDER BY created_at DESC
    LIMIT ${BATCH_SIZE}
  ` as PendingRow[];

  if (!rows.length) return;

  for (const row of rows) {
    if (!row.external_id) continue;
    try {
      const result = await downloadMedia(row.external_id);
      await sql`
        UPDATE whatsapp_messages
        SET media_path = ${result.path},
            media_mime = ${result.mime},
            media_size = ${result.size},
            meta = meta - 'media_pending'
        WHERE id = ${row.id}
      `;
    } catch (err) {
      const attempts = Number(row.meta?.media_failed_attempts || 0) + 1;
      await sql`
        UPDATE whatsapp_messages
        SET meta = meta || ${sql.json({
          media_failed_attempts: attempts,
          media_last_error: (err as Error).message?.slice(0, 200),
        })}
        WHERE id = ${row.id}
      `;
    }
  }
}
