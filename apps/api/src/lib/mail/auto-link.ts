/**
 * Match incoming email addresses to CRM entities (customers, leads, collaborators)
 * and create email_links rows automatically.
 */
import { sql } from '../../db';

interface AddressRef {
  address: string;
}

export async function autoLinkMessage(
  messageId: string,
  fromAddr: string | null,
  toAddrs: AddressRef[],
  ccAddrs: AddressRef[],
): Promise<number> {
  const candidates = new Set<string>();
  if (fromAddr) candidates.add(fromAddr.toLowerCase());
  for (const a of toAddrs) if (a.address) candidates.add(a.address.toLowerCase());
  for (const a of ccAddrs) if (a.address) candidates.add(a.address.toLowerCase());
  if (candidates.size === 0) return 0;

  const emails = Array.from(candidates);
  let linksCreated = 0;

  // Clienti
  const customers = await sql`
    SELECT id FROM customers WHERE LOWER(email) = ANY(${emails})
  `;
  for (const row of customers) {
    await sql`
      INSERT INTO email_links (message_id, entity_type, entity_id, auto)
      VALUES (${messageId}, 'cliente', ${row.id}, true)
      ON CONFLICT (message_id, entity_type, entity_id) DO NOTHING
    `;
    linksCreated++;
  }

  // Lead
  const leads = await sql`
    SELECT id FROM leads WHERE LOWER(email) = ANY(${emails})
  `;
  for (const row of leads) {
    await sql`
      INSERT INTO email_links (message_id, entity_type, entity_id, auto)
      VALUES (${messageId}, 'lead', ${row.id}, true)
      ON CONFLICT (message_id, entity_type, entity_id) DO NOTHING
    `;
    linksCreated++;
  }

  // Collaboratori (best-effort — table has email in most variants)
  try {
    const collabs = await sql`
      SELECT id FROM collaborators WHERE LOWER(email) = ANY(${emails})
    `;
    for (const row of collabs) {
      await sql`
        INSERT INTO email_links (message_id, entity_type, entity_id, auto)
        VALUES (${messageId}, 'collaboratore', ${row.id}, true)
        ON CONFLICT (message_id, entity_type, entity_id) DO NOTHING
      `;
      linksCreated++;
    }
  } catch {
    // collaborators may not have an email column on some schemas — skip silently
  }

  return linksCreated;
}
