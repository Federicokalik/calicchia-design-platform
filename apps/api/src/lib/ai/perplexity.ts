/**
 * Perplexity API client for Hono
 * Used for content generation with online search capabilities
 */

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';

export const PERPLEXITY_MODELS = [
  { id: 'sonar', name: 'Sonar', description: 'Veloce ed economico, ideale per Q&A' },
  { id: 'sonar-pro', name: 'Sonar Pro', description: 'Multi-step research, risposte dettagliate' },
] as const;

export type PerplexityModel = typeof PERPLEXITY_MODELS[number]['id'];

export function isPerplexityConfigured(): boolean {
  return !!PERPLEXITY_API_KEY;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface PerplexityCompletionOptions {
  model: PerplexityModel;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
}

/**
 * Create a completion with Perplexity
 */
export async function createCompletion(options: PerplexityCompletionOptions): Promise<string> {
  if (!PERPLEXITY_API_KEY) {
    throw new Error('PERPLEXITY_API_KEY non configurata');
  }

  const response = await fetch(PERPLEXITY_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.max_tokens,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`Perplexity API error: ${response.status} - ${error.error?.message || 'Unknown error'}`);
  }

  const data = await response.json();
  return data.choices[0]?.message?.content || '';
}

// ─────────────────────────────────────────────────────────────
// Research Function (Step 1 of the pipeline)
// ─────────────────────────────────────────────────────────────

export interface ResearchOptions {
  topic: string;
  model?: PerplexityModel;
  language?: string;
  depth?: 'basic' | 'detailed' | 'comprehensive';
}

export interface ResearchResult {
  topic: string;
  summary: string;
  keyPoints: string[];
  sections: Array<{
    title: string;
    content: string;
    facts: string[];
  }>;
  sources: string[];
  suggestedImages: string[]; // Descrizioni per immagini da generare
  relatedTopics: string[];
  rawContent: string;
}

/**
 * Research a topic with Perplexity (online search)
 * Returns structured research data for article writing
 */
export async function research(options: ResearchOptions): Promise<ResearchResult> {
  const {
    topic,
    model = 'sonar-pro', // sonar-pro è migliore per ricerca approfondita
    language = 'italiano',
    depth = 'detailed',
  } = options;

  const depthInstructions = {
    basic: '3-4 punti chiave, ricerca veloce',
    detailed: '6-8 punti chiave con dettagli, fonti verificate',
    comprehensive: '10+ punti chiave, analisi approfondita, multiple prospettive',
  };

  const systemPrompt = `Sei un ricercatore esperto. Conduci ricerche approfondite su qualsiasi argomento.
Rispondi SEMPRE in ${language}.
Rispondi SOLO con JSON valido, senza markdown o altro testo.`;

  const userPrompt = `Ricerca approfondita sul tema: "${topic}"

Livello di dettaglio: ${depthInstructions[depth]}

Rispondi con questo ESATTO formato JSON:
{
  "summary": "Riassunto in 2-3 frasi dell'argomento",
  "keyPoints": ["punto 1", "punto 2", "punto 3"],
  "sections": [
    {
      "title": "Titolo sezione",
      "content": "Contenuto dettagliato della sezione",
      "facts": ["fatto verificato 1", "fatto verificato 2"]
    }
  ],
  "sources": ["fonte 1", "fonte 2"],
  "suggestedImages": ["descrizione immagine 1 per illustrare X", "descrizione immagine 2"],
  "relatedTopics": ["argomento correlato 1", "argomento correlato 2"]
}`;

  const rawContent = await createCompletion({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.3, // Più bassa per ricerca factual
  });

  try {
    // Pulisci la risposta da eventuali markdown code blocks
    const cleanJson = rawContent
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    const parsed = JSON.parse(cleanJson);

    return {
      topic,
      summary: parsed.summary || '',
      keyPoints: parsed.keyPoints || [],
      sections: parsed.sections || [],
      sources: parsed.sources || [],
      suggestedImages: parsed.suggestedImages || [],
      relatedTopics: parsed.relatedTopics || [],
      rawContent,
    };
  } catch (error) {
    console.error('Error parsing research JSON:', error);
    // Fallback: ritorna contenuto raw strutturato
    return {
      topic,
      summary: rawContent.substring(0, 300),
      keyPoints: [],
      sections: [{ title: topic, content: rawContent, facts: [] }],
      sources: [],
      suggestedImages: [`Immagine illustrativa per ${topic}`],
      relatedTopics: [],
      rawContent,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Legacy: Article Generation (all-in-one, kept for compatibility)
// ─────────────────────────────────────────────────────────────

export interface ArticleGenerationOptions {
  topic: string;
  model?: PerplexityModel;
  writingStyle?: string;
  tone?: string;
  targetWordCount?: number;
  language?: string;
}

export interface GeneratedArticle {
  title: string;
  slug: string;
  content: string;
  excerpt: string;
  wordCount: number;
  readingTimeMinutes: number;
}

/**
 * @deprecated Use research() + openai.writeArticle() instead
 * Generate a blog article with Perplexity (legacy all-in-one)
 */
export async function generateArticle(options: ArticleGenerationOptions): Promise<GeneratedArticle> {
  const {
    topic,
    model = 'sonar',
    writingStyle = 'professional',
    tone = 'informative',
    targetWordCount = 1500,
    language = 'italiano',
  } = options;

  const systemPrompt = `Sei un esperto content writer. Scrivi articoli informativi e coinvolgenti in ${language}.
Stile: ${writingStyle}
Tono: ${tone}
Lunghezza target: ${targetWordCount} parole`;

  const content = await createCompletion({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Scrivi un articolo completo sul tema: "${topic}".
Includi:
- Un titolo accattivante (inizia con # )
- Un'introduzione
- Sezioni con sottotitoli (usa ## per i titoli delle sezioni)
- Conclusione

Formatta in Markdown.`,
      },
    ],
  });

  // Extract title from content
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1] : topic;

  // Generate slug
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 80);

  // Generate excerpt
  const contentWithoutTitle = content.replace(/^#.+\n+/, '');
  const excerpt = contentWithoutTitle
    .substring(0, 200)
    .replace(/[#*_]/g, '')
    .trim() + '...';

  // Calculate reading time
  const wordCount = content.split(/\s+/).length;
  const readingTimeMinutes = Math.ceil(wordCount / 200);

  return {
    title,
    slug,
    content: contentWithoutTitle,
    excerpt,
    wordCount,
    readingTimeMinutes,
  };
}
