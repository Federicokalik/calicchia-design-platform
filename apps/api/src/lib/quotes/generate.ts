import { z } from 'zod';
import { readFileSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { sql } from '../../db';
import { generateText } from '../agent/llm-router';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(__dirname, '../agent');

const PRICING_PATH = resolve(AGENT_DIR, 'pricing_knowledge_base.md');
const PROFILE_PATH = resolve(AGENT_DIR, 'profile_knowledge_base.md');

type CachedKB = { mtimeMs: number; content: string };
const kbCache = new Map<string, CachedKB>();

function readKB(path: string): string {
  const stat = statSync(path);
  const cached = kbCache.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.content;
  const content = readFileSync(path, 'utf-8');
  kbCache.set(path, { mtimeMs: stat.mtimeMs, content });
  return content;
}

export function loadPricingKB(): string {
  return readKB(PRICING_PATH);
}

export function loadProfileKB(): string {
  return readKB(PROFILE_PATH);
}

const QuoteItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().int().positive(),
  unit_price: z.number().nonnegative(),
});

const QuoteLLMOutputSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  items: z.array(QuoteItemSchema).min(1),
  notes: z.string().optional(),
  premessa: z.string().optional(),
});

export const GenerateQuoteInputSchema = z.object({
  client_id: z.string().uuid().optional(),
  services: z.string().min(1),
  budget: z.string().optional(),
  notes: z.string().optional(),
  internal_metadata: z.record(z.string()).optional(),
});

export type GenerateQuoteInput = z.infer<typeof GenerateQuoteInputSchema>;

export interface QuoteItemFinal {
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
}

export interface QuoteDraft {
  quote_id: string;
  title: string;
  items: QuoteItemFinal[];
  subtotal: number;
  stamp_duty: number;
  total: number;
}

const STAMP_DUTY_THRESHOLD = 77.47;
const STAMP_DUTY_AMOUNT = 2;
const MAX_LLM_RETRIES = 2;

const idempotencyCache = new Map<string, { quote: QuoteDraft; expiresAt: number }>();
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const IDEMPOTENCY_MAX_ENTRIES = 100;

function getCached(key: string | undefined): QuoteDraft | null {
  if (!key) return null;
  const entry = idempotencyCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    idempotencyCache.delete(key);
    return null;
  }
  return entry.quote;
}

function setCached(key: string | undefined, quote: QuoteDraft): void {
  if (!key) return;
  if (idempotencyCache.size >= IDEMPOTENCY_MAX_ENTRIES) {
    const firstKey = idempotencyCache.keys().next().value;
    if (firstKey !== undefined) idempotencyCache.delete(firstKey);
  }
  idempotencyCache.set(key, { quote, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS });
}

async function callLLMForQuote(prompt: string): Promise<z.infer<typeof QuoteLLMOutputSchema>> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_LLM_RETRIES; attempt++) {
    const result = await generateText('task_breakdown', [
      { role: 'system', content: 'Rispondi SOLO con JSON valido conforme allo schema indicato. Nessun testo prima o dopo il JSON.' },
      { role: 'user', content: prompt },
    ], { temperature: 0.3 });
    try {
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('LLM response contains no JSON object');
      const parsed = JSON.parse(jsonMatch[0]);
      return QuoteLLMOutputSchema.parse(parsed);
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`LLM did not return valid JSON after ${MAX_LLM_RETRIES} attempts: ${String(lastError)}`);
}

function buildPrompt(pricing: string, profile: string, input: GenerateQuoteInput): string {
  return `Sei l'agente di preventivazione del fornitore descritto sotto. Genera un preventivo usando i prezzi ESATTI dal listino.

═══ PROFILO FORNITORE ═══
${profile}

═══ LISTINO PREZZI ═══
${pricing}

═══ RICHIESTA ═══
Servizi richiesti: ${input.services}
Budget indicativo: ${input.budget || 'non specificato'}
Note: ${input.notes || 'nessuna'}

═══ REGOLE ═══
- Usa SEMPRE i prezzi del listino sopra, mai inventarli.
- Per ogni voce indica: description, quantity (intero positivo), unit_price (numero, in EUR).
- NON calcolare il campo "total" per voce né complessivo: il sistema lo ricalcola.
- Non includere nomi propri o dati personali di clienti nelle voci o nelle note generate.
- Premessa (opzionale): 2-3 righe sui servizi richiesti, generica, niente PII.
- Notes (opzionale): clausole fiscali rilevanti del profilo fornitore (regime, marca da bollo).

═══ FORMATO OUTPUT ═══
Rispondi con un singolo oggetto JSON conforme a questo schema:
{
  "title": "string",
  "description": "string opzionale",
  "items": [{"description":"...","quantity":1,"unit_price":749}, ...],
  "notes": "string opzionale",
  "premessa": "string opzionale"
}

Solo JSON, nessun testo prima o dopo.`;
}

export async function generateQuoteDraft(
  input: GenerateQuoteInput,
  opts?: { idempotencyKey?: string },
): Promise<QuoteDraft> {
  const validInput = GenerateQuoteInputSchema.parse(input);

  const cached = getCached(opts?.idempotencyKey);
  if (cached) return cached;

  const pricing = loadPricingKB();
  const profile = loadProfileKB();

  const prompt = buildPrompt(pricing, profile, validInput);
  const llmOutput = await callLLMForQuote(prompt);

  const baseItems: QuoteItemFinal[] = llmOutput.items.map((i) => ({
    description: i.description,
    quantity: i.quantity,
    unit_price: i.unit_price,
    total: Math.round(i.quantity * i.unit_price * 100) / 100,
  }));
  const subtotalBeforeStamp = Math.round(baseItems.reduce((s, i) => s + i.total, 0) * 100) / 100;

  // Regime forfettario: no IVA. Marca da bollo €2 if subtotal > €77,47.
  // If the supplier's tax regime changes, update here.
  const stampDuty = subtotalBeforeStamp > STAMP_DUTY_THRESHOLD ? STAMP_DUTY_AMOUNT : 0;
  const items: QuoteItemFinal[] = stampDuty > 0
    ? [
        ...baseItems,
        {
          description: 'Marca da bollo (regime forfettario)',
          quantity: 1,
          unit_price: stampDuty,
          total: stampDuty,
        },
      ]
    : baseItems;
  const subtotal = Math.round((subtotalBeforeStamp + stampDuty) * 100) / 100;
  const total = subtotal;

  const internalMeta = validInput.internal_metadata
    ? '\n[metadata] ' + Object.entries(validInput.internal_metadata).map(([k, v]) => `${k}=${v}`).join(', ')
    : '';
  const internalNotes =
    'Generato da AI.' +
    (llmOutput.premessa ? ' Premessa: ' + llmOutput.premessa : '') +
    internalMeta;

  const rows = await sql`
    INSERT INTO quotes_v2 (
      customer_id, title, description, items,
      subtotal, tax_rate, tax_amount, total,
      notes, internal_notes
    ) VALUES (
      ${validInput.client_id || null},
      ${llmOutput.title},
      ${llmOutput.description || 'Preventivo e Contratto di Incarico'},
      ${JSON.stringify(items)},
      ${subtotal}, ${0}, ${0}, ${total},
      ${llmOutput.notes || null},
      ${internalNotes}
    )
    RETURNING id, title
  `;

  const draft: QuoteDraft = {
    quote_id: rows[0].id,
    title: rows[0].title,
    items,
    subtotal: subtotalBeforeStamp,
    stamp_duty: stampDuty,
    total,
  };

  setCached(opts?.idempotencyKey, draft);
  return draft;
}

export function assertKBsValid(): void {
  const pricing = loadPricingKB();
  if (!/listino/i.test(pricing)) {
    throw new Error(`Pricing KB at ${PRICING_PATH} does not contain a listino section.`);
  }
  const profile = loadProfileKB();
  if (!/dati fornitore/i.test(profile)) {
    throw new Error(`Profile KB at ${PROFILE_PATH} does not contain a "Dati Fornitore" section.`);
  }
}
