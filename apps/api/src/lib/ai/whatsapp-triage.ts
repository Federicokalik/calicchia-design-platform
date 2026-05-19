/**
 * AI triage per messaggi WhatsApp in entrata.
 *
 * Si attiva quando il messaggio inbound è stato salvato in whatsapp_messages e la
 * conversazione ha ai_mode != 'off'. Modalità:
 *   - off         → non chiamato dal webhook
 *   - triage      → genera bozza, salva come whatsapp_messages.ai_draft = true,
 *                   notifica admin. Non invia. Admin approva e invia.
 *   - auto_reply  → genera + invia subito. Logga in whatsapp_messages con
 *                   sender_kind='ai'.
 *
 * Provider: OpenAI gpt-4o-mini (riusa createChatCompletion da lib/ai/openai.ts).
 * Costi loggati in ai_usage_logs se la tabella esiste (best-effort).
 */

import { sql } from '../../db';
import { createChatCompletion, isOpenAIConfigured } from './openai';
import { TRIAGE_SYSTEM_PROMPT, buildTriageUserPrompt, type TriageContext } from './prompts/whatsapp';
import { sendWhatsAppText, isWhatsAppConfigured } from '../whatsapp';

const MODEL = process.env.WHATSAPP_AI_MODEL || 'gpt-4o-mini';
const MAX_TOKENS = 400;

interface ConversationRow {
  id: string;
  chat_id: string;
  phone: string;
  contact_name: string | null;
  ai_mode: 'off' | 'triage' | 'auto_reply';
  customer_id: string | null;
  lead_id: string | null;
}

interface MessageRow {
  direction: 'inbound' | 'outbound';
  body: string | null;
  created_at: Date;
}

async function loadContext(conv: ConversationRow, inboundBody: string): Promise<TriageContext> {
  const recent = await sql`
    SELECT direction, body, created_at
    FROM whatsapp_messages
    WHERE conversation_id = ${conv.id} AND body IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 11
  ` as MessageRow[];

  let customerCompany: string | undefined;
  if (conv.customer_id) {
    const rows = await sql`SELECT company_name FROM customers WHERE id = ${conv.customer_id} LIMIT 1` as Array<{ company_name: string | null }>;
    customerCompany = rows[0]?.company_name ?? undefined;
  }

  return {
    contactName: conv.contact_name || undefined,
    customerCompany,
    isLead: !!conv.lead_id && !conv.customer_id,
    recentMessages: recent
      .slice(1) // escludi il nuovo inbound, l'aggiungiamo come prompt finale
      .reverse()
      .map((r) => ({
        direction: r.direction,
        body: r.body || '',
        at: r.created_at.toISOString(),
      })),
    inboundBody,
  };
}

async function generateReply(ctx: TriageContext): Promise<string | null> {
  if (!isOpenAIConfigured()) return null;
  try {
    const text = await createChatCompletion({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0.6,
      messages: [
        { role: 'system', content: TRIAGE_SYSTEM_PROMPT },
        { role: 'user', content: buildTriageUserPrompt(ctx) },
      ],
    });
    const trimmed = (text || '').trim();
    if (!trimmed) return null;
    // Hard cap (lunghezza messaggio WhatsApp ragionevole)
    return trimmed.slice(0, 1200);
  } catch (err) {
    console.error('[whatsapp-triage] generation failed:', err);
    return null;
  }
}

/**
 * Entrypoint chiamato dal webhook handler dopo aver insertato il messaggio
 * inbound. NON throw — eventuali errori AI non devono propagare al webhook
 * GOWA (che si attende 200).
 */
export async function runWhatsAppTriage(
  conversationId: string,
  inboundBody: string
): Promise<void> {
  try {
    const rows = await sql`
      SELECT id, chat_id, phone, contact_name, ai_mode, customer_id, lead_id
      FROM whatsapp_conversations
      WHERE id = ${conversationId}
      LIMIT 1
    ` as ConversationRow[];
    const conv = rows[0];
    if (!conv || conv.ai_mode === 'off') return;
    if (!inboundBody?.trim()) return;

    const ctx = await loadContext(conv, inboundBody);
    const reply = await generateReply(ctx);
    if (!reply) return;

    if (conv.ai_mode === 'auto_reply') {
      if (!isWhatsAppConfigured()) return;
      try {
        const result = await sendWhatsAppText(conv.phone, reply);
        await sql`
          INSERT INTO whatsapp_messages
            (conversation_id, external_id, direction, category, type, body, sender_kind, meta)
          VALUES
            (${conv.id}, ${result.externalId ?? null}, 'outbound', 'operational', 'text', ${reply}, 'ai',
             ${sql.json({ model: MODEL, mode: 'auto_reply' })})
        `;
        await sql`
          UPDATE whatsapp_conversations
          SET last_message_at = now(),
              last_message_preview = ${reply.slice(0, 200)}
          WHERE id = ${conv.id}
        `;
      } catch (err) {
        console.error('[whatsapp-triage] auto_reply send failed:', err);
      }
      return;
    }

    // triage → salva bozza
    await sql`
      INSERT INTO whatsapp_messages
        (conversation_id, direction, category, type, body, sender_kind, ai_draft, meta)
      VALUES
        (${conv.id}, 'outbound', 'operational', 'text', ${reply}, 'ai', TRUE,
         ${sql.json({ model: MODEL, mode: 'triage' })})
    `;
  } catch (err) {
    console.error('[whatsapp-triage] failed:', err);
  }
}
