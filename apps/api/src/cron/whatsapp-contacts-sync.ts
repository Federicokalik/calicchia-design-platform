/**
 * Cron — sincronizza il nome dei contatti dalla rubrica WhatsApp (GOWA).
 *
 * Il webhook ci da' solo il pushname (`from_name`: il nome che si e' dato il
 * contatto). Il nome SALVATO IN RUBRICA si ottiene invece da GOWA
 * /user/my/contacts. Questo job costruisce la mappa numero→nome e aggiorna
 * whatsapp_conversations.contact_name (solo chat 1:1), facendo prevalere il
 * nome rubrica sul pushname.
 *
 * La priorita' di VISUALIZZAZIONE resta gestita lato admin da displayNameOf:
 * nome CRM (cliente/lead) > contact_name (rubrica) > numero.
 */

import { sql } from '../db';
import { fetchGowaContacts, isWhatsAppConfigured } from '../lib/whatsapp';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'whatsapp-contacts-sync' });

export async function runWhatsAppContactsSync(): Promise<{ updated: number }> {
  if (!isWhatsAppConfigured()) return { updated: 0 };

  const contacts = await fetchGowaContacts();
  if (!contacts.length) return { updated: 0 };

  // De-dup per numero (l'ultimo vince) e scarta voci senza nome.
  const byPhone = new Map<string, string>();
  for (const c of contacts) {
    if (c.phone && c.name) byPhone.set(c.phone, c.name);
  }
  if (!byPhone.size) return { updated: 0 };

  // UPDATE ... FROM unnest(arrays): un solo round-trip, niente N query.
  // postgres.js bind-a gli array JS come array Postgres.
  const phones = Array.from(byPhone.keys());
  const names = Array.from(byPhone.values());
  let updated = 0;
  try {
    const result = await sql`
      UPDATE whatsapp_conversations wc
      SET contact_name = v.name, updated_at = now()
      FROM unnest(${phones}::text[], ${names}::text[]) AS v(phone, name)
      WHERE wc.phone = v.phone
        AND wc.kind = 'chat'
        AND COALESCE(wc.contact_name, '') <> v.name
    `;
    updated = result.count ?? 0;
  } catch (err) {
    log.error({ err }, 'contacts sync update failed');
    throw err;
  }

  log.info({ contacts: byPhone.size, updated }, 'contacts sync done');
  return { updated };
}
