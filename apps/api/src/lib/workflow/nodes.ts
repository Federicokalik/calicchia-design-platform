/**
 * Workflow Node Type Registry
 * Defines all node types with metadata, schema, and execution function.
 */

import { sql } from '../../db';
import { generateText, callOpenAICompatible, getProviderForTask } from '../agent/llm-router';
import { sendEmail } from '../email';
import { sendWhatsAppText, isWhatsAppConfigured } from '../whatsapp';
import { sendTelegramMessage, isTelegramConfigured } from '../telegram';
import { addFact } from '../agent/memory';
import type { AdminLocale } from '../admin-locale';

export interface NodeTypeDefinition {
  type: string;
  label: string;
  category: 'trigger' | 'llm' | 'tool' | 'logic' | 'output';
  color: string;
  icon: string;
  description: string;
  configSchema: Record<string, any>;
  execute: (config: any, input: any) => Promise<any>;
}

// Helper: interpolate {{variable}} in templates
function interpolate(template: string, data: any): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, path) => {
    const val = path.split('.').reduce((obj: any, key: string) => obj?.[key], data);
    return val !== undefined ? String(val) : '';
  });
}

export const NODE_TYPES: Record<string, NodeTypeDefinition> = {
  // === TRIGGERS ===
  trigger_cron: {
    type: 'trigger_cron', label: 'Timer / Cron', category: 'trigger', color: '#22c55e', icon: 'Clock',
    description: 'Esegue il workflow a intervalli regolari',
    configSchema: { interval_hours: 24, time: '09:00' },
    execute: async (config, input) => {
      // If this is the blog workflow, pick a topic from the blog config
      const result: any = { triggered_at: new Date().toISOString(), ...config, ...input };
      try {
        const [blogConfig] = await sql`SELECT value FROM site_settings WHERE key = 'blog_generation_config' LIMIT 1`;
        if (blogConfig?.value?.topics?.length) {
          const topics = blogConfig.value.topics;
          result.topic = topics[Math.floor(Math.random() * topics.length)];
        }
      } catch {}
      return result;
    },
  },
  trigger_event: {
    type: 'trigger_event', label: 'Evento', category: 'trigger', color: '#22c55e', icon: 'Zap',
    description: 'Si attiva quando accade un evento (nuovo lead, firma, ecc.)',
    configSchema: { event_type: 'nuovo_lead' },
    execute: async (config, input) => ({ ...input, event_type: config.event_type }),
  },
  trigger_manual: {
    type: 'trigger_manual', label: 'Manuale', category: 'trigger', color: '#22c55e', icon: 'Play',
    description: 'Esegui manualmente con un click',
    configSchema: {},
    execute: async (config, input) => ({ triggered_at: new Date().toISOString(), manual: true, ...input }),
  },
  trigger_webhook: {
    type: 'trigger_webhook', label: 'Webhook', category: 'trigger', color: '#22c55e', icon: 'Globe',
    description: 'Riceve dati da un URL esterno',
    configSchema: { method: 'POST' },
    execute: async (config, input) => input,
  },
  trigger_telegram: {
    type: 'trigger_telegram', label: 'Comando Telegram', category: 'trigger', color: '#22c55e', icon: 'MessageSquare',
    description: 'Si attiva con un comando Telegram specifico',
    configSchema: { command: '/report' },
    execute: async (config, input) => ({ command: config.command, ...input }),
  },

  // === LLM ===
  llm_chat: {
    type: 'llm_chat', label: 'Chat AI', category: 'llm', color: '#a855f7', icon: 'Sparkles',
    description: 'Chiama un modello LLM con un prompt',
    configSchema: { provider: 'auto', model: '', prompt: '', temperature: 0.7 },
    execute: async (config, input) => {
      const prompt = interpolate(config.prompt || 'Analizza: {{data}}', { ...input, data: JSON.stringify(input) });
      const result = await generateText(config.task || 'chat', [
        { role: 'system', content: 'Sei un assistente AI. Rispondi in italiano, conciso.' },
        { role: 'user', content: prompt },
      ], { temperature: config.temperature || 0.7 });
      return { text: result, prompt_used: prompt };
    },
  },
  llm_summarize: {
    type: 'llm_summarize', label: 'Riassumi', category: 'llm', color: '#a855f7', icon: 'FileText',
    description: 'Genera un riassunto del contenuto in input',
    configSchema: { max_length: 200, style: 'conciso' },
    execute: async (config, input) => {
      const text = typeof input === 'string' ? input : JSON.stringify(input);
      const result = await generateText('chat_fast', [
        { role: 'system', content: `Sei un assistente che genera report ASCIUTTI e TELEGRAFICI. REGOLE TASSATIVE:
- Solo dati e numeri, ZERO descrizioni narrative
- ZERO metafore, ZERO storytelling, ZERO motivazionale
- Formato: elenco puntato con emoji + dato
- Max ${config.max_length || 100} parole
- Se non ci sono dati significativi, scrivi "Nessuna anomalia"
- NON usare frasi come "il mese è stato caratterizzato", "con un sorriso", "buona giornata"
- Esempio corretto: "📋 8 lead nuovi | 💰 €300 revenue | ⚠️ 2 progetti in ritardo"` },
        { role: 'user', content: text },
      ], { temperature: 0.2 });
      return { summary: result };
    },
  },
  llm_classify: {
    type: 'llm_classify', label: 'Classifica', category: 'llm', color: '#a855f7', icon: 'Tag',
    description: 'Classifica l\'input in una delle categorie definite',
    configSchema: { categories: ['positivo', 'negativo', 'neutro'], prompt: '' },
    execute: async (config, input) => {
      const text = typeof input === 'string' ? input : JSON.stringify(input);
      const cats = (config.categories || []).join(', ');
      const result = await generateText('chat_fast', [
        { role: 'system', content: `Classifica il seguente testo in UNA di queste categorie: ${cats}. Rispondi SOLO con il nome della categoria.` },
        { role: 'user', content: text },
      ]);
      return { category: result.trim(), input_text: text };
    },
  },

  // === TOOLS ===
  tool_db_query: {
    type: 'tool_db_query', label: 'Query DB', category: 'tool', color: '#3b82f6', icon: 'Database',
    description: 'Esegue una query SQL sul database',
    configSchema: { query: 'SELECT * FROM leads WHERE status = $1 LIMIT 10', params: ['new'] },
    execute: async (config, input) => {
      let query = interpolate(config.query || '', input);
      query = query.replace(/''/g, "'");

      // GUARDRAIL: Block dangerous SQL
      const dangerous = /\b(DELETE|DROP|TRUNCATE|ALTER|UPDATE\s+users|INSERT\s+INTO\s+users)\b/i;
      if (dangerous.test(query)) {
        return { rows: [], count: 0, error: 'Query bloccata: operazioni DELETE/DROP/ALTER non permesse nei workflow' };
      }

      try {
        const rows = await sql.unsafe(query);
        return { rows, count: rows.length };
      } catch (err) {
        return { rows: [], count: 0, error: err instanceof Error ? err.message : 'Query error' };
      }
    },
  },
  tool_send_email: {
    type: 'tool_send_email', label: 'Invia Email', category: 'tool', color: '#3b82f6', icon: 'Mail',
    description: 'Invia un\'email',
    configSchema: { to: '', subject: '', body: '' },
    execute: async (config, input) => {
      const to = interpolate(config.to, input);
      const subject = interpolate(config.subject, input);
      const body = interpolate(config.body, input);
      await sendEmail({ to, subject, html: body });
      return { sent: true, to, subject };
    },
  },
  tool_send_whatsapp: {
    type: 'tool_send_whatsapp', label: 'Invia WhatsApp', category: 'tool', color: '#3b82f6', icon: 'MessageCircle',
    description: 'Invia un messaggio WhatsApp',
    configSchema: { phone: '', message: '' },
    execute: async (config, input) => {
      if (!isWhatsAppConfigured()) return { sent: false, error: 'WhatsApp non configurato' };
      const phone = interpolate(config.phone, input);
      const message = interpolate(config.message, input);
      await sendWhatsAppText(phone, message);
      return { sent: true, phone };
    },
  },
  tool_send_telegram: {
    type: 'tool_send_telegram', label: 'Notifica Telegram', category: 'tool', color: '#3b82f6', icon: 'Send',
    description: 'Invia un messaggio su Telegram',
    configSchema: { message: '' },
    execute: async (config, input) => {
      if (!isTelegramConfigured()) return { sent: false, error: 'Telegram non configurato' };
      const message = interpolate(config.message, input);
      await sendTelegramMessage(message, undefined, { parse_mode: 'HTML' });
      return { sent: true };
    },
  },
  tool_http_request: {
    type: 'tool_http_request', label: 'HTTP Request', category: 'tool', color: '#3b82f6', icon: 'Globe',
    description: 'Chiama un API esterno',
    configSchema: { url: '', method: 'GET', headers: {}, body: '' },
    execute: async (config, input) => {
      const url = interpolate(config.url, input);
      const res = await fetch(url, {
        method: config.method || 'GET',
        headers: { 'Content-Type': 'application/json', ...config.headers },
        ...(config.body ? { body: interpolate(config.body, input) } : {}),
      });
      const data = await res.json().catch(() => res.text());
      return { status: res.status, data };
    },
  },

  // === LOGIC ===
  logic_condition: {
    type: 'logic_condition', label: 'Condizione', category: 'logic', color: '#eab308', icon: 'GitBranch',
    description: 'Se/altrimenti — divide il flusso in base a una condizione',
    configSchema: { condition: 'input.count > 0', true_label: 'Sì', false_label: 'No' },
    execute: async (config, input) => {
      try {
        const fn = new Function('input', `return Boolean(${config.condition})`);
        const result = fn(input);
        return { _branch: result ? 'true' : 'false', condition_result: result, ...input };
      } catch {
        return { _branch: 'false', condition_result: false, error: 'Condizione non valida' };
      }
    },
  },
  logic_delay: {
    type: 'logic_delay', label: 'Attesa', category: 'logic', color: '#eab308', icon: 'Timer',
    description: 'Pausa prima di continuare',
    configSchema: { seconds: 5 },
    execute: async (config, input) => {
      await new Promise((r) => setTimeout(r, (config.seconds || 5) * 1000));
      return input;
    },
  },
  logic_loop: {
    type: 'logic_loop', label: 'Per ogni', category: 'logic', color: '#eab308', icon: 'Repeat',
    description: 'Itera su un array di elementi',
    configSchema: { array_field: 'rows' },
    execute: async (config, input) => {
      const items = input[config.array_field || 'rows'] || [];
      return { items, count: items.length, _loop: true };
    },
  },

  tool_generate_cover: {
    type: 'tool_generate_cover', label: 'Genera Cover Image', category: 'tool', color: '#3b82f6', icon: 'Image',
    description: 'Genera un\'immagine di copertina con Z-Image basata sul contenuto',
    configSchema: { provider: 'zimage' },
    execute: async (config, input) => {
      // Step 1: Generate visual prompt from article content
      const articleText = input.text || input.summary || JSON.stringify(input).slice(0, 500);

      let visualPrompt: string;
      try {
        visualPrompt = await generateText('chat_fast', [
          { role: 'system', content: 'Genera un prompt in INGLESE per generare un\'immagine di copertina per un blog post. Il prompt deve descrivere una scena visiva, NO testo/scritte. Formato: 1-2 frasi descrittive. Stile: editorial photography, cinematic, modern, 16:9 landscape.' },
          { role: 'user', content: `Articolo: ${articleText.slice(0, 800)}` },
        ], { temperature: 0.7, max_tokens: 150 });
      } catch {
        visualPrompt = `Professional blog cover about technology and web design, editorial photography, cinematic lighting, landscape 16:9`;
      }

      // Step 2: Call Z-Image (or cover generator)
      try {
        const { generateCover } = await import('../ai/cover-generator');
        const result = await generateCover({
          topic: visualPrompt,
          provider: (config.provider as any) || 'zimage',
        });
        return { image_url: result.url, prompt: visualPrompt, provider: result.provider };
      } catch (err) {
        return { image_url: null, prompt: visualPrompt, error: err instanceof Error ? err.message : 'Errore generazione immagine' };
      }
    },
  },

  tool_generate_code_demo: {
    type: 'tool_generate_code_demo', label: 'Genera Code Demo', category: 'tool', color: '#3b82f6', icon: 'Code',
    description: 'Genera una demo HTML/CSS/JS interattiva basata sul contenuto dell\'articolo (usa Kimi-K2.5)',
    configSchema: { description: '' },
    execute: async (config, input) => {
      const description = interpolate(config.description || '{{demo_description}}', input);
      const articleContext = input.text || input.summary || '';

      try {
        const code = await generateText('code_generation', [
          { role: 'system', content: `Sei un esperto frontend developer. Genera una SINGOLA pagina HTML autocontenuta (HTML + CSS inline + JS inline) che funzioni come demo interattiva.

REGOLE TASSATIVE:
- Tutto in UN SOLO file HTML, nessun import esterno (no CDN, no librerie esterne)
- CSS inline dentro <style> nel <head>
- JS inline dentro <script> prima di </body>
- Design moderno: dark theme, bordi arrotondati, animazioni CSS smooth
- DEVE essere responsive e funzionare in un iframe
- Max 300 righe di codice
- Aggiungi commenti nel codice per spiegare le parti chiave
- Se richiesto 3D/WebGL: usa Canvas 2D con effetti che SIMULANO 3D (parallax, prospettiva, ombre)
- Se richiesto animazioni: usa CSS @keyframes + requestAnimationFrame
- Rispondi SOLO con il codice HTML, nessun testo prima o dopo` },
          { role: 'user', content: `Contesto articolo: ${articleContext.slice(0, 500)}\n\nDescrizione demo richiesta: ${description}` },
        ], { temperature: 0.4, max_tokens: 4000 });

        // Extract HTML from potential markdown code blocks
        let html = code.trim();
        const htmlMatch = html.match(/```html?\n([\s\S]*?)```/);
        if (htmlMatch) html = htmlMatch[1].trim();

        return { html, description, success: true };
      } catch (err) {
        return { html: null, description, success: false, error: err instanceof Error ? err.message : 'Errore generazione demo' };
      }
    },
  },

  tool_create_project: {
    type: 'tool_create_project', label: 'Crea Progetto da Preventivo', category: 'tool', color: '#3b82f6', icon: 'FolderPlus',
    description: 'Crea un progetto con task AI-generated dal preventivo',
    configSchema: { quote_id: '' },
    execute: async (config, input) => {
      const quoteId = interpolate(config.quote_id || '{{quote_id}}', input);
      const { executeTool } = await import('../agent/tools');
      const result = await executeTool('create_project_from_quote', { quote_id: quoteId });
      return JSON.parse(result);
    },
  },

  // === OUTPUT ===
  output_log: {
    type: 'output_log', label: 'Log', category: 'output', color: '#6b7280', icon: 'FileText',
    description: 'Registra un messaggio nel log',
    configSchema: { message: '' },
    execute: async (config, input) => {
      const message = interpolate(config.message || '{{data}}', { ...input, data: JSON.stringify(input) });
      console.log(`[Workflow Log] ${message}`);
      return { logged: true, message };
    },
  },
  output_brain_fact: {
    type: 'output_brain_fact', label: 'Salva in Memoria', category: 'output', color: '#6b7280', icon: 'Brain',
    description: 'Salva un fatto nella memoria del Second Brain',
    configSchema: { entity_type: 'general', fact: '' },
    execute: async (config, input) => {
      const raw = interpolate(config.fact || '', input);
      // Truncate to avoid huge facts, clean for DB
      const fact = raw.slice(0, 500);
      try {
        await addFact(config.entity_type || 'general', null, fact, 'workflow');
        return { saved: true, fact };
      } catch (err) {
        return { saved: false, fact, error: err instanceof Error ? err.message : 'Save error' };
      }
    },
  },
};

const NODE_TYPE_I18N: Record<string, Partial<Record<AdminLocale, { label: string; description: string }>>> = {
  trigger_cron: { en: { label: 'Timer / Cron', description: 'Runs the workflow on a regular schedule' } },
  trigger_event: { en: { label: 'Event', description: 'Starts when an event happens (new lead, signature, etc.)' } },
  trigger_manual: { en: { label: 'Manual', description: 'Run manually with one click' } },
  trigger_webhook: { en: { label: 'Webhook', description: 'Receives data from an external URL' } },
  trigger_telegram: { en: { label: 'Telegram Command', description: 'Starts from a specific Telegram command' } },
  llm_chat: { en: { label: 'AI Chat', description: 'Calls an LLM with a prompt' } },
  llm_summarize: { en: { label: 'Summarize', description: 'Generates a summary from input content' } },
  llm_classify: { en: { label: 'Classify', description: 'Classifies input into configured categories' } },
  tool_db_query: { en: { label: 'DB Query', description: 'Runs a SQL query on the database' } },
  tool_send_email: { en: { label: 'Send Email', description: 'Sends an email' } },
  tool_send_whatsapp: { en: { label: 'Send WhatsApp', description: 'Sends a WhatsApp message' } },
  tool_send_telegram: { en: { label: 'Telegram Notification', description: 'Sends a Telegram message' } },
  tool_http_request: { en: { label: 'HTTP Request', description: 'Calls an external API' } },
  logic_condition: { en: { label: 'Condition', description: 'If/else split based on a condition' } },
  logic_delay: { en: { label: 'Delay', description: 'Pauses before continuing' } },
  logic_loop: { en: { label: 'For each', description: 'Iterates over an array of items' } },
  tool_generate_cover: { en: { label: 'Generate Cover Image', description: 'Generates a cover image from content with Z-Image' } },
  tool_generate_code_demo: { en: { label: 'Generate Code Demo', description: 'Generates an interactive HTML/CSS/JS demo from article content' } },
  tool_create_project: { en: { label: 'Create Project from Quote', description: 'Creates a project with AI-generated tasks from a quote' } },
  output_log: { en: { label: 'Log', description: 'Writes a message to the log' } },
  output_brain_fact: { en: { label: 'Save to Memory', description: 'Saves a fact in Second Brain memory' } },
};

export function getNodeTypes(locale: AdminLocale = 'it') {
  return Object.values(NODE_TYPES).map((n) => ({
    type: n.type,
    label: NODE_TYPE_I18N[n.type]?.[locale]?.label || n.label,
    category: n.category,
    color: n.color,
    icon: n.icon,
    description: NODE_TYPE_I18N[n.type]?.[locale]?.description || n.description,
    configSchema: n.configSchema,
  }));
}
