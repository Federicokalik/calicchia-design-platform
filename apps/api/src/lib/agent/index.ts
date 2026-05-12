/**
 * Second Brain — Agent Core v2
 * Receives message → loads memory → orchestrates LLM + tools → saves memory → responds
 */

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getToolsForLLM, executeTool, tools, type ToolDefinition } from './tools';
import { recallMemory, saveConversation, addFact, addPreference } from './memory';
import { getProviderForTask, callOpenAICompatible } from './llm-router';

// Load pricing knowledge base
let PRICING_KB = '';
try {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  PRICING_KB = readFileSync(resolve(__dirname, 'pricing_knowledge_base.md'), 'utf-8');
} catch { PRICING_KB = ''; }

const PERSONALITY = `Sei il Second Brain di Federico Calicchia, web designer freelance.

IDENTITÀ:
- Sei il suo braccio destro digitale, non un assistente generico
- Conosci tutto del suo business: clienti, progetti, finanze, calendario
- Parli in italiano, tono diretto ma amichevole
- Sei proattivo: se vedi qualcosa che non va, lo segnali
- Sei conciso: vai al punto, niente filler

REGOLE:
- MAI eseguire azioni senza conferma (invio email, WA, creazione entità)
- Proponi: "Vuoi che [azione]?" e aspetta OK
- Quando crei testo (email, preventivi), mostra prima la bozza
- Se non sai qualcosa, dillo. Non inventare dati.
- Usa i tool per leggere dati reali, non basarti su memoria vecchia per dati che cambiano
- Quando impari qualcosa di nuovo su un cliente/progetto, usa remember_fact per salvarlo

FORMATO RISPOSTE:
- MAI usare tabelle Markdown (non si renderizzano su Telegram)
- Usa elenchi puntati con emoji: • nome — dettaglio
- Numeri e dati in grassetto (es. **€3.500**)
- Risposte brevi e telegrafiche, vai al punto
- Esempio corretto: "2 lead nuovi:\n• Marco Rossi (Rossi Srl) — **€3.500**\n• Paolo Neri — **€1.500**"

PRICING & PREVENTIVI:
- Conosci a memoria il listino prezzi, i costi reali, i margini, le politiche commerciali
- Quando generi preventivi, usa SEMPRE i prezzi del listino (non inventare)
- Applica lo sconto 10% per pagamento anticipato (tranne grafica)
- Mostra sempre il prezzo pieno barrato per ancoraggio psicologico
- PREZZI MINIMI AGGIORNATI 2026: One Page da €799, Multipage da €1.199, E-commerce da €3.799, Web App da €4.000
- MAI scendere sotto questi minimi, nemmeno per amici
- Per budget ridotti, proporre uno scope ridotto e sostenibile
- Il Knowledge Base completo sui prezzi è caricato nel tuo contesto${PRICING_KB ? ' (vedi sotto)' : ' (non disponibile)'}`;

// Append pricing KB to personality if available
const FULL_PERSONALITY = PRICING_KB
  ? PERSONALITY + '\n\n--- KNOWLEDGE BASE PREZZI ---\n' + PRICING_KB
  : PERSONALITY;

// Add memory-specific tools
const memoryTools = [
  {
    name: 'remember_fact',
    description: 'Salva un fatto importante nella memoria. Usalo quando apprendi qualcosa su un cliente, progetto o preferenza dell\'utente.',
    parameters: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', description: 'Tipo: customer, lead, project, general, preference', enum: ['customer', 'lead', 'project', 'general', 'preference'] },
        entity_id: { type: 'string', description: 'ID entità correlata (opzionale)' },
        fact: { type: 'string', description: 'Il fatto da ricordare' },
      },
      required: ['entity_type', 'fact'],
    },
    execute: async (args: Record<string, unknown>) => {
      if (args.entity_type === 'preference') {
        await addPreference('general', args.fact as string);
        return JSON.stringify({ saved: true, type: 'preference' });
      }
      await addFact(args.entity_type as string, (args.entity_id as string) || null, args.fact as string, 'agent');
      return JSON.stringify({ saved: true, type: 'fact' });
    },
  },
  {
    name: 'recall_memory',
    description: 'Cerca nella memoria fatti appresi in passato su un argomento specifico.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Cosa cercare nella memoria' },
      },
      required: ['query'],
    },
    execute: async (args: Record<string, unknown>) => {
      const { searchFacts } = await import('./memory');
      const facts = await searchFacts(args.query as string, 8);
      return JSON.stringify({ facts: facts.map((f) => ({ type: f.entity_type, fact: f.fact, date: f.updated_at })) });
    },
  },
];

// Merge all tools
const allTools: ToolDefinition[] = [...tools, ...memoryTools];

function getAllToolsForLLM() {
  return allTools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

async function executeAnyTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = allTools.find((t) => t.name === name);
  if (!tool) return JSON.stringify({ error: `Tool "${name}" non trovato` });
  try { return await tool.execute(args); }
  catch (err) { console.error(`Tool ${name} error:`, err); return JSON.stringify({ error: `Errore tool "${name}"` }); }
}

interface AgentEntityContext {
  kind: string;
  id: string;
  title: string;
  summary?: string;
}

interface AgentOptions {
  message: string;
  context?: string;
  entity?: AgentEntityContext;
  history?: { role: string; content: string }[];
  channel?: 'admin' | 'telegram' | 'cron';
  maxIterations?: number;
}

interface AgentResult {
  reply: string;
  toolsUsed: string[];
}

export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  const { message, context, entity, history = [], channel = 'admin', maxIterations = 5 } = options;
  const toolsUsed: string[] = [];

  const provider = getProviderForTask('tool_calling');
  if (!provider.apiKey()) {
    return {
      reply: `[AI non configurata — nessun provider LLM disponibile]\n\nConfigura INFOMANIAK_AI_TOKEN + INFOMANIAK_AI_PRODUCT_ID oppure OPENAI_API_KEY nel .env`,
      toolsUsed: [],
    };
  }

  // Load memory
  const memory = await recallMemory(context, message);

  const memoryBlock = [
    memory.preferences.length ? `\nLE MIE REGOLE/PREFERENZE:\n${memory.preferences.join('\n')}` : '',
    memory.facts.length ? `\nFATTI CHE RICORDO:\n${memory.facts.join('\n')}` : '',
    memory.recentConversations.length ? `\nCONVERSAZIONI RECENTI:\n${memory.recentConversations.join('\n')}` : '',
  ].filter(Boolean).join('\n');

  const entityBlock = entity
    ? `\n\nENTITÀ CORRENTE (l'utente sta guardando questo):\n- Tipo: ${entity.kind}\n- ID: ${entity.id}\n- Titolo: ${entity.title}${entity.summary ? `\n- Dettagli: ${entity.summary}` : ''}\nQuando l'utente fa domande generiche come "questo progetto", "questo cliente", riferisciti a questa entità. Usa i tool per leggere dati aggiornati se serve.`
    : '';

  const systemPrompt = `${FULL_PERSONALITY}\n\nCanale: ${channel}${context ? `\nSezione: ${context}` : ''}${entityBlock}${memoryBlock}`;

  const messages: any[] = [
    { role: 'system', content: systemPrompt },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: message },
  ];

  // Tool-calling loop
  for (let i = 0; i < maxIterations; i++) {
    let data: any;
    try {
      data = await callOpenAICompatible(provider, messages, {
        tools: getAllToolsForLLM(),
        temperature: 0.5,
        _task: 'tool_calling',
        _channel: channel,
        max_tokens: 2000,
      });
    } catch (err) {
      console.error(`[Brain] ${provider.name} error:`, err);
      return { reply: 'Errore comunicazione AI. Riprova.', toolsUsed };
    }

    const choice = data.choices?.[0];
    if (!choice) return { reply: 'Nessuna risposta.', toolsUsed };

    if (choice.finish_reason === 'tool_calls' || choice.message?.tool_calls?.length) {
      messages.push(choice.message);

      for (const tc of choice.message.tool_calls) {
        const toolName = tc.function.name;
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}

        // GUARDRAIL: Check if tool requires confirmation
        const toolDef = allTools.find((t) => t.name === toolName);
        if (toolDef?.requiresConfirmation && channel !== 'cron') {
          // Check if user message contains explicit confirmation
          const lastUserMsg = message.toLowerCase();
          const isConfirmed = /\b(sì|si|ok|conferma|confermo|procedi|vai|fallo|invia|manda|crea)\b/.test(lastUserMsg);

          if (!isConfirmed) {
            // Block execution, ask for confirmation
            console.log(`[Brain] BLOCKED: ${toolName} requires confirmation`);
            const argsPreview = JSON.stringify(args).slice(0, 200);
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify({ blocked: true, reason: 'Azione bloccata — richiede conferma utente', tool: toolName, args_preview: argsPreview }),
            });
            toolsUsed.push(`${toolName}:BLOCKED`);
            continue;
          }
        }

        // GUARDRAIL: Rate limit
        const { checkRateLimit } = await import('./tools');
        if (!checkRateLimit(channel)) {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: 'Rate limit raggiunto (max 20 azioni/min). Riprova tra poco.' }) });
          continue;
        }

        // GUARDRAIL: Budget cap
        const { checkBudgetCap } = await import('./tools');
        if (toolName.startsWith('llm_') || toolName === 'generate_quote' || toolName === 'create_project_from_quote') {
          const withinBudget = await checkBudgetCap();
          if (!withinBudget) {
            messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: 'Budget AI mensile raggiunto. Aumenta il cap nelle impostazioni.' }) });
            continue;
          }
        }

        const argKeys = Object.keys(args).join(',') || '∅';
        const argHash = createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 8);
        console.log(`[Brain] Tool: ${toolName} keys=[${argKeys}] hash=${argHash}`);
        toolsUsed.push(toolName);
        const result = await executeAnyTool(toolName, args);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
      continue;
    }

    const reply = choice.message?.content || 'Nessuna risposta.';

    // Save conversation asynchronously (don't block response)
    const fullHistory = [...history, { role: 'user', content: message }, { role: 'assistant', content: reply }];
    saveConversation(channel, fullHistory, context).catch((err) => console.error('[Brain] Save error:', err));

    return { reply, toolsUsed };
  }

  // If we hit the limit, try one last call without tools to force a text response
  try {
    const lastData = await callOpenAICompatible(provider, [
      ...messages,
      { role: 'user', content: 'Rispondi in base alle informazioni raccolte finora. Non chiamare altri tool.' },
    ], { temperature: 0.5, max_tokens: 1000, _task: 'chat', _channel: channel });
    const lastReply = lastData.choices?.[0]?.message?.content;
    if (lastReply) return { reply: lastReply, toolsUsed };
  } catch {}
  return { reply: 'Non sono riuscito a completare la richiesta. Prova con una domanda più specifica.', toolsUsed };
}
