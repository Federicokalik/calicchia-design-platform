/**
 * System prompts per il triage WhatsApp dell'IA del gestionale.
 *
 * Lingua: italiano (UI language). Persona: brand Calicchia Design (Federico,
 * studio di design/sviluppo). Tono: professionale ma colloquiale, "tu",
 * messaggi brevi (max 2 paragrafi), niente emoji invadenti.
 */

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
}

export const TRIAGE_SYSTEM_PROMPT = `Sei l'assistente WhatsApp di Calicchia Design, studio italiano di design e sviluppo web (titolare: Federico Calicchia).

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

export function buildTriageUserPrompt(ctx: TriageContext): string {
  const lines: string[] = [];
  if (ctx.contactName) lines.push(`Contatto: ${ctx.contactName}${ctx.customerCompany ? ` (${ctx.customerCompany})` : ''}`);
  if (ctx.isLead) lines.push('Tipo: lead (non ancora cliente attivo)');
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
