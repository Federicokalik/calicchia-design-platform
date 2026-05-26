/**
 * System prompts per il triage WhatsApp dell'IA del gestionale.
 *
 * Lingua: italiano (UI language). Persona: brand Calicchia Design (Federico,
 * studio di design/sviluppo). Tono: professionale ma colloquiale, "tu",
 * messaggi brevi (max 2 paragrafi), niente emoji invadenti.
 *
 * Override admin: il system prompt globale è editabile da Impostazioni →
 * WhatsApp (chiave `whatsapp.ai_system_prompt`). Per-conversazione, l'admin
 * può aggiungere `ai_instructions` (es. "scrive in dialetto, rispondi
 * formale") che vengono accodate al system prompt come addendum, senza
 * sostituire le REGOLE INVALICABILI.
 */

import { sql } from '../../../db';

export interface TriageContext {
  contactName?: string;
  customerCompany?: string;
  isLead?: boolean;
  recentMessages: Array<{
    direction: 'inbound' | 'outbound';
    body: string;
    at: string;
  }>;
  inboundBody: string;
  /** Per-conversation tuning saved on whatsapp_conversations.ai_instructions. */
  perConversationInstructions?: string | null;
}

export const TRIAGE_SYSTEM_PROMPT_DEFAULT = `Sei l'assistente WhatsApp di Calicchia Design, studio italiano di design e sviluppo web (titolare: Federico Calicchia).

REGOLE INVALICABILI:
- Lingua: SEMPRE italiano, dai del "tu" al cliente.
- Tono: professionale ma cordiale, conciso. Massimo 2 paragrafi brevi.
- NON inventare fatti, prezzi, scadenze o stato di progetti che non conosci.
- Se la richiesta è ambigua o richiede info che non hai (preventivi, tempistiche, fatture), rispondi che girerai la richiesta a Federico e che ti risentirà presto. NON promettere mai tempi specifici.
- Non chiedere mai dati sensibili (carte, password, PIN).
- Se il cliente scrive "STOP" o variazioni, NON rispondere — il sistema gestirà l'opt-out automaticamente.
- Niente disclaimer legali nel messaggio, niente "Cordiali saluti" formali.
- Se proprio non sai cosa rispondere, scrivi: "Ciao, ho ricevuto il tuo messaggio. Lo giro a Federico, ti risponde lui appena può."

CONTESTO disponibile: nome del contatto, eventuale azienda, ultimi messaggi della conversazione. Usali per personalizzare il saluto solo se il nome è certo.

OUTPUT: solo il testo del messaggio WhatsApp da inviare, senza prefissi tipo "Risposta:" o virgolette.`;

/** Backwards-compat alias for callers that imported the const directly. */
export const TRIAGE_SYSTEM_PROMPT = TRIAGE_SYSTEM_PROMPT_DEFAULT;

/**
 * Read the active system prompt from site_settings. Returns the default if
 * the setting is empty or unreachable. Fail-open same as the disclaimer
 * getter — better to fall back to the audited default than abort triage.
 */
export async function getTriageSystemPrompt(): Promise<string> {
  try {
    const rows = (await sql`
      SELECT value FROM site_settings WHERE key = 'whatsapp' LIMIT 1
    `) as Array<{ value: { ai_system_prompt?: unknown } | null }>;
    const raw = rows[0]?.value?.ai_system_prompt;
    if (typeof raw === 'string' && raw.trim().length > 0) return raw;
  } catch {
    /* fall through */
  }
  return TRIAGE_SYSTEM_PROMPT_DEFAULT;
}

export function buildTriageUserPrompt(ctx: TriageContext): string {
  const lines: string[] = [];
  if (ctx.contactName) lines.push(`Contatto: ${ctx.contactName}${ctx.customerCompany ? ` (${ctx.customerCompany})` : ''}`);
  if (ctx.isLead) lines.push('Tipo: lead (non ancora cliente attivo)');
  if (ctx.perConversationInstructions && ctx.perConversationInstructions.trim()) {
    lines.push(`\nIstruzioni specifiche per questo contatto (impostate dall'admin):\n${ctx.perConversationInstructions.trim()}`);
  }
  if (ctx.recentMessages.length) {
    lines.push('\nUltimi messaggi della conversazione (dal più vecchio al più recente):');
    for (const m of ctx.recentMessages.slice(-10)) {
      const who = m.direction === 'inbound' ? 'CLIENTE' : 'NOI';
      lines.push(`[${who}] ${m.body.slice(0, 400)}`);
    }
  }
  lines.push('\nNUOVO MESSAGGIO IN ENTRATA DAL CLIENTE:');
  lines.push(ctx.inboundBody);
  lines.push('\nScrivi il testo della risposta WhatsApp (solo il testo, niente altro):');
  return lines.join('\n');
}
