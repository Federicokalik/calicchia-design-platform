/**
 * Chiusura di una campagna (email o WhatsApp) quando non restano messaggi in
 * coda. Prima veniva marcata sempre 'sent' con sent_at, anche se tutti gli
 * invii erano falliti (es. provider non configurato): l'admin la vedeva
 * "Inviata" con 0 consegne e non poteva ritentare.
 */
import { sql } from '../../db';

export async function finalizeCampaign(campaignId: string): Promise<'sent' | 'failed' | null> {
  const [row] = await sql<Array<{ status: 'sent' | 'failed' }>>`
    UPDATE mkt_campaigns c SET
      status = CASE WHEN s.sent > 0 OR s.failed = 0 THEN 'sent' ELSE 'failed' END,
      sent_at = CASE WHEN s.sent > 0 THEN COALESCE(c.sent_at, now()) ELSE c.sent_at END,
      updated_at = now()
    FROM (
      SELECT count(*) FILTER (WHERE status = 'sent')::int AS sent,
             count(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM mkt_messages WHERE campaign_id = ${campaignId}
    ) s
    WHERE c.id = ${campaignId} AND c.status = 'sending'
    RETURNING c.status`;
  return row?.status ?? null;
}
