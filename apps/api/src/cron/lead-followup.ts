import { sql } from '../db';
import { notifyTelegram } from '../lib/telegram';
import { isWhatsAppConfigured, sendWhatsAppText, formatPhone } from '../lib/whatsapp';
import { canSendWhatsApp } from '../lib/whatsapp-policy';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'lead-followup' });

/**
 * Check leads without activity for 3+ days and notify the admin via Telegram.
 *
 * Estensione (decision 2026-05-19): se WHATSAPP_LEAD_AUTO_FOLLOWUP=true, oltre
 * alla notifica admin proviamo a inviare un follow-up WA al lead stesso. Gate:
 *   - lead.phone presente
 *   - communication_preferences.whatsapp_operational = true (default true,
 *     ma rispetta eventuali opt-out)
 *   - mai più di 1 follow-up WA ogni 7 giorni per lo stesso lead
 *     (tracciato in leads.notes "wa-followup:<isoDate>")
 *
 * Mantiene Telegram come canale primario di notifica per il titolare.
 */
export async function runLeadFollowup() {
  const staleLeads = await sql`
    SELECT id, name, email, phone, company, status, estimated_value, created_at, updated_at, notes
    FROM leads
    WHERE status IN ('new', 'contacted', 'proposal', 'negotiation')
      AND updated_at < NOW() - INTERVAL '3 days'
    ORDER BY estimated_value DESC NULLS LAST
  ` as Array<{
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    company: string | null;
    status: string;
    estimated_value: string | null;
    created_at: Date;
    updated_at: Date;
    notes: string | null;
  }>;

  if (staleLeads.length === 0) return;

  const lines = staleLeads.map((l) => {
    const days = Math.floor((Date.now() - new Date(l.updated_at).getTime()) / (1000 * 60 * 60 * 24));
    const value = l.estimated_value ? ` — €${parseFloat(l.estimated_value).toLocaleString('it-IT')}` : '';
    return `• ${l.name}${value} (${l.status}, ${days}gg fa)`;
  }).join('\n');

  await notifyTelegram(
    `📋 ${staleLeads.length} lead senza follow-up`,
    `Lead inattivi da 3+ giorni:\n${lines}`
  );

  // Optional outbound WA follow-up al lead stesso, dietro feature flag.
  if (process.env.WHATSAPP_LEAD_AUTO_FOLLOWUP !== 'true') return;
  if (!isWhatsAppConfigured()) return;

  for (const lead of staleLeads) {
    if (!lead.phone) continue;
    const phone = formatPhone(lead.phone);
    if (!phone) continue;

    // Cooldown: niente WA se notes contiene wa-followup degli ultimi 7gg.
    if (lead.notes) {
      const match = lead.notes.match(/wa-followup:(\d{4}-\d{2}-\d{2}T[^\s]+)/);
      if (match) {
        const last = new Date(match[1]).getTime();
        if (Number.isFinite(last) && Date.now() - last < 7 * 24 * 60 * 60 * 1000) continue;
      }
    }

    const policy = await canSendWhatsApp(phone, 'operational', { leadId: lead.id });
    if (!policy.allowed) continue;

    const text = `Ciao ${lead.name.split(' ')[0]}, sono Federico di Calicchia Design. Avevamo iniziato a parlare e volevo capire se ti va di proseguire o se preferisci che ti risenta più avanti. Per non ricevere più questi messaggi rispondi "STOP".`;
    try {
      await sendWhatsAppText(phone, text);
      const stamp = new Date().toISOString();
      await sql`
        UPDATE leads
        SET notes = CONCAT(COALESCE(notes, ''), ' wa-followup:', ${stamp}),
            updated_at = now()
        WHERE id = ${lead.id}
      `;
    } catch (err) {
      log.error({ err }, `WA send to ${phone} failed`);
    }
  }
}
