/**
 * LLM-based email classifier. Used as an on-demand bulk operation
 * to clean up emails that the heuristic/rules couldn't confidently categorize.
 *
 * Batched to keep token costs bounded (10 emails per call).
 */
import { getProviderForTask, callOpenAICompatible } from '../agent/llm-router';
import type { MailCategory } from './classifier';

const VALID: Set<MailCategory> = new Set(['importanti', 'normali', 'aggiornamenti', 'marketing', 'spam']);

const SYSTEM_PROMPT = `Sei un classificatore email. Classifichi ogni email in UNA sola categoria:

- importanti: email personali da persone reali che richiedono risposta/azione (clienti, collaboratori, fornitori diretti). Priorità alta.
- aggiornamenti: notifiche automatiche di servizi (GitHub, Stripe, PayPal, spedizioni, ticket di support, conferme ordine, fatture elettroniche)
- marketing: newsletter, promozioni, email bulk con List-Unsubscribe, offerte commerciali non richieste
- spam: junk palese, phishing, truffe
- normali: email personali ma non urgenti, conferme di iscrizione, email di secondo piano

REGOLE RIGIDE:
- Rispondi SOLO con JSON valido, nessun testo extra, nessun code-fence.
- Formato: un array di oggetti con { "id": "uuid_originale", "category": "una_delle_5" }
- Non aggiungere campi extra, non modificare le id, non inventare email.`;

interface EmailInput {
  id: string;
  from_addr: string | null;
  from_name: string | null;
  subject: string | null;
  snippet: string | null;
  has_list_unsubscribe?: boolean;
}

export interface AiClassifyResult {
  id: string;
  category: MailCategory;
}

function parseJsonResponse(content: string): AiClassifyResult[] {
  // Try direct parse first
  let text = content.trim();
  // Strip markdown code fences if present
  if (text.startsWith('```')) {
    text = text.replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is { id: string; category: MailCategory } =>
        x && typeof x.id === 'string' && typeof x.category === 'string' && VALID.has(x.category as MailCategory),
      )
      .map((x) => ({ id: x.id, category: x.category }));
  } catch {
    return [];
  }
}

async function classifyBatch(emails: EmailInput[]): Promise<AiClassifyResult[]> {
  const provider = getProviderForTask('chat_fast');
  if (!provider.apiKey()) {
    throw new Error('Nessun provider LLM configurato');
  }

  const userBlock = JSON.stringify(
    emails.map((e) => ({
      id: e.id,
      from: e.from_name ? `${e.from_name} <${e.from_addr}>` : e.from_addr,
      subject: e.subject,
      preview: (e.snippet || '').slice(0, 200),
      has_unsubscribe: !!e.has_list_unsubscribe,
    })),
    null,
    2,
  );

  const res = await callOpenAICompatible(
    provider,
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Classifica queste ${emails.length} email:\n\n${userBlock}` },
    ],
    { temperature: 0.1, max_tokens: 1500, _task: 'tool_calling', _channel: 'admin' },
  );

  const content = res?.choices?.[0]?.message?.content;
  if (!content) return [];
  return parseJsonResponse(content);
}

const BATCH_SIZE = 10;

export async function classifyEmailsWithAi(emails: EmailInput[]): Promise<{
  results: AiClassifyResult[];
  failed: number;
}> {
  const results: AiClassifyResult[] = [];
  let failed = 0;

  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    const batch = emails.slice(i, i + BATCH_SIZE);
    try {
      const out = await classifyBatch(batch);
      results.push(...out);
      failed += batch.length - out.length;
    } catch (err) {
      console.error('[ai-classifier] batch failed:', (err as Error).message);
      failed += batch.length;
    }
  }

  return { results, failed };
}
