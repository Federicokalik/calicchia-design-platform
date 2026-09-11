/**
 * Cron — trascrizione note vocali del dispositivo ePaper.
 *
 * Ogni 30s prende una cattura con status='pending', la trascrive con Gemini e
 * crea la nota in `notes` (source='device', tags=['vocale', <tag>]) con il
 * titolo ricavato dalle prime parole. Un claim con SELECT ... FOR UPDATE
 * SKIP LOCKED protegge da doppio run (restart, due istanze). Errori →
 * status='failed' + error; il device legge l'esito da GET /device/notes/:id.
 */
import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { sql } from '../db';
import { logger } from '../lib/logger';
import { transcribeWav } from '../lib/device/transcribe';

const log = logger.child({ scope: 'cron-device-notes' });

const PRIVATE_DIR = process.env.PRIVATE_UPLOAD_DIR || './private-uploads';
const BATCH = 5;

export async function runDeviceNotesTranscription(): Promise<void> {
  // Claim: FOR UPDATE SKIP LOCKED + secondo WHERE su status='pending' garantisce
  // che nessun altro runner possa prendere la stessa riga fra SELECT e UPDATE.
  const claimed = await sql<Array<{ id: string; audio_path: string; tag: string }>>`
    UPDATE device_notes SET status = 'transcribing'
    WHERE id IN (
      SELECT id FROM device_notes
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT ${BATCH}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, audio_path, tag
  `;
  if (claimed.length === 0) return;

  for (const row of claimed) {
    try {
      const filePath = resolve(join(PRIVATE_DIR, row.audio_path));
      const audio = await readFile(filePath);
      const transcript = await transcribeWav(audio);

      if (transcript.trim() === '[vuoto]') {
        await sql`
          UPDATE device_notes
          SET status = 'done', transcript = '', processed_at = NOW()
          WHERE id = ${row.id}::uuid
        `;
        log.info({ device_note: row.id }, 'trascrizione vuota (silenzio)');
        continue;
      }

      // Titolo: prime parole della trascrizione (max 60 caratteri, tagliato a parola).
      const flat = transcript.trim();
      let title = flat.slice(0, 60);
      if (flat.length > 60) title = title.slice(0, title.lastIndexOf(' ')) + '…';

      const [note] = await sql<Array<{ id: string }>>`
        INSERT INTO notes (title, raw_markdown, source, tags)
        VALUES (${title}, ${flat}, 'device', ${['vocale', row.tag]})
        RETURNING id
      `;
      await sql`
        UPDATE device_notes
        SET status = 'done', transcript = ${flat}, note_id = ${note.id}::uuid,
            processed_at = NOW()
        WHERE id = ${row.id}::uuid
      `;
      log.info({ device_note: row.id, note: note.id, tag: row.tag }, 'nota vocale trascritta');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await sql`
        UPDATE device_notes
        SET status = 'failed', error = ${message}, processed_at = NOW()
        WHERE id = ${row.id}::uuid
      `;
      log.error({ err, device_note: row.id }, 'trascrizione fallita');
    }
  }
}
