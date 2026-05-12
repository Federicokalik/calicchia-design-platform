/**
 * Multi-provider LLM Router
 * Priority: Infomaniak (EU/GDPR) → OpenAI → Anthropic → Perplexity
 */

import { sql } from '../../db';

export type LLMTask = 'chat' | 'chat_fast' | 'tool_calling' | 'blog_research' | 'blog_writing' | 'email_copy' | 'task_breakdown' | 'code_generation' | 'invoice_ocr';

// Pricing per million tokens (EUR)
const PRICING: Record<string, { input: number; output: number }> = {
  'infomaniak-qwen': { input: 0.70, output: 2.00 },
  'infomaniak-mistral': { input: 0.10, output: 0.30 },
  'infomaniak-llama': { input: 1.00, output: 3.00 },
  'infomaniak-apertus': { input: 0.70, output: 2.50 },
  'infomaniak-gpt-oss': { input: 0.30, output: 0.90 },
  'openai-fast': { input: 0.15, output: 0.60 },
  'openai-smart': { input: 2.50, output: 10.00 },
  'anthropic': { input: 3.00, output: 15.00 },
  'perplexity': { input: 1.00, output: 5.00 },
  'gemini-flash': { input: 0.075, output: 0.30 },
  'gemini-pro': { input: 1.25, output: 5.00 },
  'infomaniak-kimi': { input: 0.60, output: 2.40 },
};

async function logUsage(providerName: string, model: string, task: string, channel: string, inputTokens: number, outputTokens: number, durationMs: number, success: boolean, error?: string) {
  const pricing = Object.entries(PRICING).find(([k]) => providerName.toLowerCase().includes(k.replace('infomaniak-', '').replace('openai-', '').replace('gemini-', '')));
  const rate = pricing?.[1] || { input: 1, output: 3 };
  const cost = (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;

  try {
    await sql`INSERT INTO ai_usage_logs (provider, model, task_type, channel, input_tokens, output_tokens, total_tokens, cost_eur, duration_ms, success, error)
      VALUES (${providerName}, ${model}, ${task}, ${channel}, ${inputTokens}, ${outputTokens}, ${inputTokens + outputTokens}, ${cost}, ${durationMs}, ${success}, ${error || null})`;
  } catch (e) { console.error('[AI Usage] Log error:', e); }
}

interface ProviderConfig {
  name: string;
  provider: 'infomaniak' | 'openai' | 'anthropic' | 'perplexity';
  model: string;
  apiKey: () => string;
  baseUrl: () => string;
}

const PROVIDERS: Record<string, ProviderConfig> = {
  // === INFOMANIAK (primary — EU, GDPR, sovereign) ===
  'infomaniak-qwen': {
    name: 'Infomaniak Qwen3-VL-235B',
    provider: 'infomaniak',
    model: 'qwen3',
    apiKey: () => process.env.INFOMANIAK_AI_TOKEN || '',
    baseUrl: () => `https://api.infomaniak.com/2/ai/${process.env.INFOMANIAK_AI_PRODUCT_ID || ''}/openai/v1`,
  },
  'infomaniak-mistral': {
    name: 'Infomaniak Mistral-Small-3.2',
    provider: 'infomaniak',
    model: 'mistral3',
    apiKey: () => process.env.INFOMANIAK_AI_TOKEN || '',
    baseUrl: () => `https://api.infomaniak.com/2/ai/${process.env.INFOMANIAK_AI_PRODUCT_ID || ''}/openai/v1`,
  },
  'infomaniak-llama': {
    name: 'Infomaniak Llama 3.3',
    provider: 'infomaniak',
    model: 'llama3',
    apiKey: () => process.env.INFOMANIAK_AI_TOKEN || '',
    baseUrl: () => `https://api.infomaniak.com/2/ai/${process.env.INFOMANIAK_AI_PRODUCT_ID || ''}/openai/v1`,
  },
  'infomaniak-apertus': {
    name: 'Infomaniak Apertus-70B',
    provider: 'infomaniak',
    model: 'swiss-ai/Apertus-70B-Instruct-2509',
    apiKey: () => process.env.INFOMANIAK_AI_TOKEN || '',
    baseUrl: () => `https://api.infomaniak.com/2/ai/${process.env.INFOMANIAK_AI_PRODUCT_ID || ''}/openai/v1`,
  },

  // === OPENAI (fallback) ===
  'openai-fast': {
    name: 'OpenAI gpt-4o-mini',
    provider: 'openai',
    model: 'gpt-4o-mini',
    apiKey: () => process.env.OPENAI_API_KEY || '',
    baseUrl: () => 'https://api.openai.com/v1',
  },
  'openai-smart': {
    name: 'OpenAI gpt-4o',
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: () => process.env.OPENAI_API_KEY || '',
    baseUrl: () => 'https://api.openai.com/v1',
  },

  // === ANTHROPIC (copy quality) ===
  anthropic: {
    name: 'Anthropic Claude Sonnet',
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    apiKey: () => process.env.ANTHROPIC_API_KEY || '',
    baseUrl: () => 'https://api.anthropic.com/v1',
  },

  'infomaniak-gpt-oss': {
    name: 'Infomaniak GPT-OSS-120B',
    provider: 'infomaniak',
    model: 'openai/gpt-oss-120b',
    apiKey: () => process.env.INFOMANIAK_AI_TOKEN || '',
    baseUrl: () => `https://api.infomaniak.com/2/ai/${process.env.INFOMANIAK_AI_PRODUCT_ID || ''}/openai/v1`,
  },
  'infomaniak-kimi': {
    name: 'Infomaniak Kimi-K2.5',
    provider: 'infomaniak',
    model: 'moonshotai/Kimi-K2.5',
    apiKey: () => process.env.INFOMANIAK_AI_TOKEN || '',
    baseUrl: () => `https://api.infomaniak.com/2/ai/${process.env.INFOMANIAK_AI_PRODUCT_ID || ''}/openai/v1`,
  },

  // === PERPLEXITY (web search) ===
  perplexity: {
    name: 'Perplexity Sonar Pro',
    provider: 'perplexity',
    model: 'sonar-pro',
    apiKey: () => process.env.PERPLEXITY_API_KEY || '',
    baseUrl: () => 'https://api.perplexity.ai',
  },

  // === GOOGLE GEMINI (fallback) ===
  'gemini-flash': {
    name: 'Google Gemini 2.0 Flash',
    provider: 'openai' as const, // Gemini has OpenAI-compatible endpoint
    model: 'gemini-2.0-flash',
    apiKey: () => process.env.GOOGLE_AI_API_KEY || '',
    baseUrl: () => 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  'gemini-pro': {
    name: 'Google Gemini Pro',
    provider: 'openai' as const,
    model: 'gemini-1.5-pro',
    apiKey: () => process.env.GOOGLE_AI_API_KEY || '',
    baseUrl: () => 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
};

// Task → provider priority (first available wins)
// Modelli attivi:
// - mistral3: chat veloce, risposte rapide
// - openai/gpt-oss-120b: testi lunghi, analisi approfondite, tool calling
// - perplexity: ricerca web
// - openai gpt-4o: fallback tool calling se gpt-oss non supporta
const TASK_ROUTING: Record<LLMTask, string[]> = {
  chat:           ['infomaniak-mistral', 'infomaniak-gpt-oss', 'openai-fast'],
  chat_fast:      ['infomaniak-mistral', 'openai-fast'],
  tool_calling:   ['infomaniak-gpt-oss', 'openai-smart', 'openai-fast'],
  blog_research:  ['perplexity', 'infomaniak-gpt-oss'],
  blog_writing:   ['infomaniak-gpt-oss', 'openai-smart'],
  email_copy:     ['infomaniak-gpt-oss', 'openai-smart'],
  task_breakdown: ['infomaniak-gpt-oss', 'openai-smart'],
  code_generation: ['infomaniak-kimi', 'infomaniak-gpt-oss', 'openai-smart'],
  invoice_ocr:     ['openai-smart', 'infomaniak-qwen'],  // Vision models: GPT-4o → Qwen3-VL
};

function isAvailable(config: ProviderConfig): boolean {
  if (!config.apiKey()) return false;
  if (config.provider === 'infomaniak' && !process.env.INFOMANIAK_AI_PRODUCT_ID) return false;
  return true;
}

/**
 * Get the best available provider for a task
 */
export function getProviderForTask(task: LLMTask): ProviderConfig {
  const candidates = TASK_ROUTING[task] || TASK_ROUTING.chat;
  for (const name of candidates) {
    const provider = PROVIDERS[name];
    if (provider && isAvailable(provider)) return provider;
  }
  // Ultimate fallback
  return PROVIDERS['openai-fast'];
}

/**
 * Call OpenAI-compatible API (works for OpenAI, Perplexity, AND Infomaniak)
 */
export async function callOpenAICompatible(
  config: ProviderConfig,
  messages: Array<{ role: string; content: string }>,
  options?: { tools?: any[]; temperature?: number; max_tokens?: number; _task?: string; _channel?: string }
): Promise<any> {
  const startTime = Date.now();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.apiKey()}`,
  };

  const res = await fetch(`${config.baseUrl()}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      messages,
      ...(options?.tools ? { tools: options.tools, tool_choice: 'auto' } : {}),
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.max_tokens ?? 2000,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    const duration = Date.now() - startTime;
    logUsage(config.name, config.model, options?._task || 'unknown', options?._channel || 'unknown', 0, 0, duration, false, err.slice(0, 200));
    throw new Error(`${config.name} error (${res.status}): ${err}`);
  }

  const data = await res.json();
  const duration = Date.now() - startTime;
  const usage = data.usage || {};
  logUsage(config.name, config.model, options?._task || 'unknown', options?._channel || 'unknown',
    usage.prompt_tokens || 0, usage.completion_tokens || 0, duration, true);
  return data;
}

/**
 * Call Anthropic API (different format)
 */
export async function callAnthropic(
  messages: Array<{ role: string; content: string }>,
  options?: { system?: string; temperature?: number; max_tokens?: number }
): Promise<string> {
  const config = PROVIDERS.anthropic;
  if (!isAvailable(config)) throw new Error('ANTHROPIC_API_KEY not configured');

  const anthropicMessages = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  const systemMsg = messages.find((m) => m.role === 'system')?.content || options?.system || '';

  const res = await fetch(`${config.baseUrl()}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey(),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      system: systemMsg,
      messages: anthropicMessages,
      max_tokens: options?.max_tokens ?? 2000,
      temperature: options?.temperature ?? 0.7,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic error (${res.status}): ${err}`);
  }

  const data = await res.json();
  return data.content?.[0]?.text || '';
}

/**
 * Simple text generation — picks best provider for task
 */
export async function generateText(
  task: LLMTask,
  messages: Array<{ role: string; content: string }>,
  options?: { temperature?: number; max_tokens?: number }
): Promise<string> {
  const config = getProviderForTask(task);

  if (config.provider === 'anthropic') {
    return callAnthropic(messages, options);
  }

  const data = await callOpenAICompatible(config, messages, options);
  return data.choices?.[0]?.message?.content || '';
}

/**
 * Get current routing info (for debugging/settings)
 */
export function getRoutingInfo(): Record<string, { provider: string; model: string; available: boolean }> {
  const info: Record<string, any> = {};
  for (const [task, candidates] of Object.entries(TASK_ROUTING)) {
    const selected = candidates.find((name) => {
      const p = PROVIDERS[name];
      return p && isAvailable(p);
    });
    const config = selected ? PROVIDERS[selected] : null;
    info[task] = {
      provider: config?.name || 'Nessuno disponibile',
      model: config?.model || '—',
      available: !!config,
    };
  }
  return info;
}
