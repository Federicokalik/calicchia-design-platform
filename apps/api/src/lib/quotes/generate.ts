import { z } from 'zod';
import { randomUUID } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';
import { sql } from '../../db';
import { generateText } from '../agent/llm-router';

const __dirname = dirname(fileURLToPath(import.meta.url));
// KB_DIR (set in production) points at the files delivered by kb-bootstrap.ts;
// otherwise the knowledge bases are read from lib/agent/ on disk.
const AGENT_DIR = process.env.KB_DIR || resolve(__dirname, '../agent');

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

// ---------------------------------------------------------------------------
// LLM output schemas — section shapes mirror the editor's (edit.tsx) exactly,
// so an AI draft opens in the section builder with zero special-casing.
// ---------------------------------------------------------------------------

const QuoteItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().int().positive(),
  unit_price: z.number().nonnegative(),
});

const OffertaSchema = z.object({
  nome: z.string().min(1),
  descrizione: z.string().default(''),
  prezzo: z.number().nonnegative(),
  consigliata: z.boolean().default(false),
  include: z.array(z.string()).default([]),
  esclude: z.array(z.string()).default([]),
});

const LLMSectionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('premessa'),
    data: z.object({
      testo: z.string().default(''),
      statistiche: z.array(z.object({ valore: z.string(), label: z.string() })).default([]),
    }).passthrough(),
  }),
  z.object({
    type: z.literal('offerte'),
    data: z.object({ offerte: z.array(OffertaSchema).min(1) }).passthrough(),
  }),
  z.object({
    type: z.literal('comparativa'),
    data: z.object({
      titolo: z.string().default(''),
      intro: z.string().default(''),
      intestazione_a: z.string().default('Proposta'),
      intestazione_b: z.string().default('Attuale'),
      righe: z.array(z.object({ caratteristica: z.string(), colonna_a: z.string(), colonna_b: z.string() })).default([]),
    }).passthrough(),
  }),
  z.object({
    type: z.literal('problemi'),
    data: z.object({ lista: z.array(z.object({ problema: z.string(), soluzione: z.string() })).default([]) }).passthrough(),
  }),
  z.object({
    type: z.literal('clausole'),
    data: z.object({
      tipo: z.enum(['warning', 'info', 'success']).default('info'),
      titolo: z.string().default(''),
      testo: z.string().default(''),
      lista: z.array(z.string()).default([]),
    }).passthrough(),
  }),
  z.object({
    type: z.literal('materiali'),
    data: z.object({ lista: z.array(z.string()).default([]) }).passthrough(),
  }),
  z.object({
    type: z.literal('tempistiche'),
    data: z.object({
      prima_bozza: z.string().default(''),
      nota: z.string().default(''),
      settimane: z.number().int().min(2).max(16).optional(),
      fasi: z.array(z.object({ label: z.string(), start_pct: z.number(), width_pct: z.number() })).default([]),
    }).passthrough(),
  }),
  z.object({
    type: z.literal('pagamento'),
    data: z.object({
      modalita: z.array(z.object({
        nome: z.string(),
        sconto_percentuale: z.number().default(0),
        rate: z.array(z.object({ percentuale: z.number(), momento: z.string() })).default([]),
      })).default([]),
    }).passthrough(),
  }),
  z.object({
    type: z.literal('contratto'),
    data: z.object({
      auto: z.boolean().default(true),
      servizi: z.array(z.string()).default([]),
      clausole: z.array(z.string()).default([]),
    }).passthrough(),
  }),
]);

const QuoteLLMOutputSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  items: z.array(QuoteItemSchema).optional(),
  sections: z.array(LLMSectionSchema).optional(),
  notes: z.string().optional(),
  premessa: z.string().optional(),
}).refine((v) => (v.items && v.items.length) || (v.sections && v.sections.length), {
  message: 'Either items or sections must be present',
});

type QuoteLLMOutput = z.infer<typeof QuoteLLMOutputSchema>;

export const GenerateQuoteInputSchema = z.object({
  client_id: z.string().uuid().optional(),
  services: z.string().min(1),
  budget: z.string().optional(),
  notes: z.string().optional(),
  internal_metadata: z.record(z.string()).optional(),
});

export type GenerateQuoteInput = z.infer<typeof GenerateQuoteInputSchema>;

export const GenerateFromMarkdownInputSchema = z.object({
  markdown: z.string().min(30).max(200_000),
  client_id: z.string().uuid().optional(),
});

export type GenerateFromMarkdownInput = z.infer<typeof GenerateFromMarkdownInputSchema>;

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
  sections_count: number;
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

async function callLLMForQuote(prompt: string): Promise<QuoteLLMOutput> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_LLM_RETRIES; attempt++) {
    // max_tokens: the router default (2000) truncates a sections-rich quote
    // JSON mid-output → parse fails on every retry (seen in prod ai_usage_logs:
    // output_tokens exactly 2000 on each attempt). A full draft needs 3-5k.
    const result = await generateText('task_breakdown', [
      { role: 'system', content: 'Rispondi SOLO con JSON valido conforme allo schema indicato. Nessun testo prima o dopo il JSON.' },
      { role: 'user', content: prompt },
    ], { temperature: 0.3, max_tokens: 8000 });
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

// Compact spec of the section JSON shapes, shared by both prompts.
const SECTIONS_SPEC = `Tipi di sezione disponibili (usa solo quelli pertinenti, nell'ordine in cui devono apparire nel documento):
- {"type":"premessa","data":{"testo":"...", "statistiche":[{"valore":"8","label":"..."}]}}
- {"type":"offerte","data":{"offerte":[{"nome":"...","descrizione":"...","prezzo":790,"consigliata":true,"include":["..."],"esclude":["..."]}]}}
- {"type":"comparativa","data":{"titolo":"...","intro":"...","intestazione_a":"Proposta","intestazione_b":"Attuale","righe":[{"caratteristica":"...","colonna_a":"...","colonna_b":"..."}]}}
- {"type":"problemi","data":{"lista":[{"problema":"...","soluzione":"..."}]}}
- {"type":"clausole","data":{"tipo":"warning|info|success","titolo":"...","testo":"...","lista":["..."]}}
- {"type":"materiali","data":{"lista":["Logo (vettoriale)","..."]}}
- {"type":"tempistiche","data":{"prima_bozza":"~1 settimana","nota":"dal brief","settimane":8,"fasi":[{"label":"Sviluppo","start_pct":12.5,"width_pct":50}]}}
- {"type":"pagamento","data":{"modalita":[{"nome":"Saldo unico","sconto_percentuale":10,"rate":[]},{"nome":"3 rate","sconto_percentuale":0,"rate":[{"percentuale":33,"momento":"alla firma"},{"percentuale":33,"momento":"a metà lavoro"},{"percentuale":34,"momento":"alla consegna"}]}]}}
- {"type":"contratto","data":{"auto":true,"servizi":["..."],"clausole":[]}}`;

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
- NON calcolare totali complessivi: il sistema li ricalcola.
- Non includere nomi propri o dati personali di clienti nelle sezioni generate.
- Struttura il preventivo come array "sections" (vedi sotto): includi almeno una sezione "offerte"; aggiungi premessa/materiali/tempistiche/pagamento quando pertinenti.

═══ SEZIONI ═══
${SECTIONS_SPEC}

═══ FORMATO OUTPUT ═══
Rispondi con un singolo oggetto JSON:
{
  "title": "string",
  "description": "string opzionale (sottotitolo)",
  "sections": [ ... ],
  "notes": "string opzionale (clausole fiscali rilevanti del profilo fornitore)"
}

Solo JSON, nessun testo prima o dopo.`;
}

export interface MarkdownBrief {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseMarkdownBrief(markdown: string): MarkdownBrief {
  try {
    const parsed = matter(markdown);
    return { frontmatter: parsed.data || {}, body: parsed.content || '' };
  } catch {
    // Malformed YAML → treat the whole input as body.
    return { frontmatter: {}, body: markdown };
  }
}

function buildMarkdownPrompt(pricing: string, profile: string, brief: MarkdownBrief): string {
  const fmLines = Object.entries(brief.frontmatter)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join('\n');
  return `Sei l'agente di preventivazione del fornitore descritto sotto. Ti viene fornito un BRIEF IN MARKDOWN che spesso è già un preventivo redatto: il tuo compito è ESTRARRE e strutturare, non inventare.

═══ PROFILO FORNITORE ═══
${profile || '(non disponibile)'}

═══ LISTINO PREZZI (solo come fallback) ═══
${pricing || '(non disponibile — usa esclusivamente le cifre presenti nel brief)'}

═══ BRIEF — METADATI (frontmatter) ═══
${fmLines || '(nessun frontmatter)'}

═══ BRIEF — CONTENUTO ═══
${brief.body}

═══ REGOLE ═══
- ESTRAZIONE, NON INVENZIONE: se il brief contiene già voci, prezzi, sconti, opzioni di pagamento, tempistiche o clausole, riportali FEDELMENTE (stesse cifre, stessi importi). Usa il listino SOLO per voci richieste ma senza prezzo nel brief.
- NON calcolare totali complessivi: il sistema li ricalcola dalle voci.
- Sconti: rappresenta uno sconto come voce dell'array "offerte" con prezzo NEGATIVO è VIETATO — usa invece il prezzo finale scontato nella voce, oppure la modalità di pagamento con "sconto_percentuale".
- Note/commenti interni del brief (es. avvisi "da confermare", commenti HTML <!-- -->) NON vanno nel preventivo per il cliente: riassumili nel campo "internal_notes".
- Decisioni aperte segnalate nel brief (es. dominio nuovo vs esistente) → sezione "clausole" con tipo "warning".
- Mantieni l'ordine del brief nelle sezioni.

═══ SEZIONI ═══
${SECTIONS_SPEC}

═══ FORMATO OUTPUT ═══
Rispondi con un singolo oggetto JSON:
{
  "title": "string (oggetto del preventivo)",
  "description": "string opzionale (sottotitolo)",
  "sections": [ ... ],
  "notes": "string opzionale (note fiscali/validità per il cliente)",
  "premessa": "string opzionale (SOLO appunti interni per l'admin, non per il cliente)"
}

Solo JSON, nessun testo prima o dopo.`;
}

// ---------------------------------------------------------------------------
// Shared draft builder — both entry points funnel through here.
// ---------------------------------------------------------------------------

function uid(): string {
  return randomUUID().slice(0, 8);
}

/**
 * Flatten sections → flat items[] (same mapping as edit.tsx's save handler),
 * compute totals server-side (never trust LLM math) and INSERT the draft.
 *
 * Stamp duty (marca da bollo) is NOT inserted as a line item: the template
 * computes and displays it from quote.settings (soglia/importo), exactly like
 * editor-authored quotes — adding it as an item would double-count it.
 */
async function insertQuoteDraft(
  llmOutput: QuoteLLMOutput,
  opts: { clientId?: string; internalNotes: string },
): Promise<QuoteDraft> {
  // Assign editor ids to sections/offerte/modalita so the draft is directly
  // editable in the section builder.
  const sections = (llmOutput.sections || []).map((s) => {
    const data: Record<string, unknown> = { ...s.data };
    if (s.type === 'offerte' && Array.isArray((data as { offerte?: unknown[] }).offerte)) {
      data.offerte = (data.offerte as Array<Record<string, unknown>>).map((o) => ({ id: uid(), ...o }));
    }
    if (s.type === 'pagamento' && Array.isArray((data as { modalita?: unknown[] }).modalita)) {
      data.modalita = (data.modalita as Array<Record<string, unknown>>).map((m) => ({ id: uid(), ...m }));
    }
    return { id: uid(), type: s.type, data };
  });

  // Items: from offerte sections when present (mirror of edit.tsx:
  // {description: nome, quantity: 1, unit_price: prezzo, total: prezzo}),
  // otherwise from the flat items array.
  let items: QuoteItemFinal[];
  const offerte = sections
    .filter((s) => s.type === 'offerte')
    .flatMap((s) => (s.data as { offerte?: Array<Record<string, unknown>> }).offerte || []);
  if (offerte.length) {
    items = offerte.map((o) => {
      const prezzo = Math.round((Number(o.prezzo) || 0) * 100) / 100;
      return { description: String(o.nome || ''), quantity: 1, unit_price: prezzo, total: prezzo };
    });
  } else {
    items = (llmOutput.items || []).map((i) => ({
      description: i.description,
      quantity: i.quantity,
      unit_price: i.unit_price,
      total: Math.round(i.quantity * i.unit_price * 100) / 100,
    }));
  }

  const subtotal = Math.round(items.reduce((s, i) => s + i.total, 0) * 100) / 100;
  // Regime forfettario: no IVA. Informational only — displayed by the template.
  const stampDuty = subtotal > STAMP_DUTY_THRESHOLD ? STAMP_DUTY_AMOUNT : 0;
  const total = subtotal;

  const materialsChecklist = sections
    .filter((s) => s.type === 'materiali')
    .flatMap((s) => (s.data as { lista?: string[] }).lista || [])
    .filter(Boolean)
    .map((label) => ({ label, received: false }));

  const contratto = sections.find((s) => s.type === 'contratto');
  const autoCreateProject = contratto ? (contratto.data as { auto?: boolean }).auto ?? true : true;

  const rows = await sql`
    INSERT INTO quotes_v2 (
      customer_id, title, description, items,
      subtotal, tax_rate, tax_amount, total,
      notes, internal_notes,
      materials_checklist, auto_create_project, project_template
    ) VALUES (
      ${opts.clientId || null},
      ${llmOutput.title},
      ${llmOutput.description || 'Preventivo e Contratto di Incarico'},
      ${JSON.stringify(items)},
      ${subtotal}, ${0}, ${0}, ${total},
      ${llmOutput.notes || null},
      ${opts.internalNotes},
      ${JSON.stringify(materialsChecklist)},
      ${autoCreateProject},
      ${sections.length ? JSON.stringify({ sections }) : null}
    )
    RETURNING id, title
  `;

  return {
    quote_id: rows[0].id,
    title: rows[0].title,
    items,
    subtotal,
    stamp_duty: stampDuty,
    total,
    sections_count: sections.length,
  };
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

  const internalMeta = validInput.internal_metadata
    ? '\n[metadata] ' + Object.entries(validInput.internal_metadata).map(([k, v]) => `${k}=${v}`).join(', ')
    : '';
  const internalNotes =
    'Generato da AI.' +
    (llmOutput.premessa ? ' Premessa: ' + llmOutput.premessa : '') +
    internalMeta;

  const draft = await insertQuoteDraft(llmOutput, { clientId: validInput.client_id, internalNotes });

  setCached(opts?.idempotencyKey, draft);
  return draft;
}

/**
 * Markdown brief → structured quote draft.
 *
 * Unlike the form-based path, the markdown body/frontmatter DOES reach the
 * model — it's the source document to extract from (the admin explicitly
 * uploads it for this purpose). The draft is inserted as `draft` and never
 * auto-sent; customer linking stays manual (see suggested_customers in the
 * route).
 */
export async function generateQuoteFromMarkdown(
  input: GenerateFromMarkdownInput,
  opts?: { idempotencyKey?: string },
): Promise<{ draft: QuoteDraft; frontmatter: Record<string, unknown> }> {
  const validInput = GenerateFromMarkdownInputSchema.parse(input);

  const cached = getCached(opts?.idempotencyKey);
  if (cached) return { draft: cached, frontmatter: parseMarkdownBrief(validInput.markdown).frontmatter };

  const brief = parseMarkdownBrief(validInput.markdown);
  // Extraction mode: the brief itself is the price source — the KBs are only
  // fallback grounding, so a missing KB file (e.g. /data/kb not yet populated
  // in prod) must not fail the import.
  let pricing = '';
  let profile = '';
  try { pricing = loadPricingKB(); } catch { /* optional in markdown mode */ }
  try { profile = loadProfileKB(); } catch { /* optional in markdown mode */ }

  const prompt = buildMarkdownPrompt(pricing, profile, brief);
  const llmOutput = await callLLMForQuote(prompt);

  const internalNotes =
    'Generato da AI (import Markdown).' +
    (llmOutput.premessa ? ' Note estratte: ' + llmOutput.premessa : '');

  const draft = await insertQuoteDraft(llmOutput, { clientId: validInput.client_id, internalNotes });

  setCached(opts?.idempotencyKey, draft);
  return { draft, frontmatter: brief.frontmatter };
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
