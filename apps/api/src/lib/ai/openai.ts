/**
 * OpenAI API client for Hono
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_URL = 'https://api.openai.com/v1';

export interface OpenAIModel {
  id: string;
  name: string;
  created: number;
  owned_by: string;
}

export function isOpenAIConfigured(): boolean {
  return !!OPENAI_API_KEY;
}

/**
 * Fetch available models from OpenAI API
 */
export async function fetchModels(): Promise<OpenAIModel[]> {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY non configurata');
  }

  const response = await fetch(`${OPENAI_API_URL}/models`, {
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status}`);
  }

  const data = await response.json();

  // Filter and format models - only chat models
  const chatModels = (data.data || [])
    .filter((m: any) =>
      m.id.includes('gpt') &&
      !m.id.includes('instruct') &&
      !m.id.includes('vision') &&
      !m.id.includes('audio') &&
      !m.id.includes('realtime') &&
      !m.id.includes('embedding')
    )
    .map((m: any) => ({
      id: m.id,
      name: formatModelName(m.id),
      created: m.created,
      owned_by: m.owned_by,
    }))
    .sort((a: OpenAIModel, b: OpenAIModel) => b.created - a.created);

  return chatModels;
}

function formatModelName(id: string): string {
  const names: Record<string, string> = {
    'gpt-4o': 'GPT-4o',
    'gpt-4o-mini': 'GPT-4o Mini',
    'gpt-4-turbo': 'GPT-4 Turbo',
    'gpt-4-turbo-preview': 'GPT-4 Turbo Preview',
    'gpt-4': 'GPT-4',
    'gpt-3.5-turbo': 'GPT-3.5 Turbo',
  };

  // Check for exact match first
  if (names[id]) return names[id];

  // Check for prefix match
  for (const [prefix, name] of Object.entries(names)) {
    if (id.startsWith(prefix)) return `${name} (${id.replace(prefix + '-', '')})`;
  }

  return id;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: 'json_object' | 'text' };
}

/**
 * Create a chat completion
 */
export async function createChatCompletion(options: ChatCompletionOptions): Promise<string> {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY non configurata');
  }

  const body: Record<string, any> = {
    model: options.model,
    messages: options.messages,
    response_format: options.response_format,
  };

  // Only classic GPT models support custom temperature; gpt-5-*, o1, o3 do not
  const MODELS_WITH_TEMPERATURE = ['gpt-4o', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo'];
  const supportsTemperature = MODELS_WITH_TEMPERATURE.some(m => options.model.startsWith(m));
  if (supportsTemperature && options.temperature !== undefined) {
    body.temperature = options.temperature;
  }

  if (options.max_tokens) {
    body.max_completion_tokens = options.max_tokens;
  }

  const response = await fetch(`${OPENAI_API_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`OpenAI API error: ${response.status} - ${error.error?.message || 'Unknown error'}`);
  }

  const data = await response.json();
  return data.choices[0]?.message?.content || '';
}

/**
 * Generate SEO suggestions for a blog post
 */
export async function generateSEOSuggestions(
  title: string,
  content: string,
  tags: string[],
  model: string = 'gpt-4o-mini'
): Promise<{
  suggestedTags: string[];
  metaDescription: string;
  titleSuggestions: string[];
  improvements: string[];
}> {
  const result = await createChatCompletion({
    model,
    messages: [
      {
        role: 'system',
        content: 'Sei un esperto SEO. Analizza il contenuto e suggerisci miglioramenti per il SEO. Rispondi SOLO con JSON valido.',
      },
      {
        role: 'user',
        content: `Analizza questo articolo e fornisci suggerimenti SEO:
Titolo: ${title}
Tags attuali: ${tags.join(', ')}
Contenuto: ${content.substring(0, 2000)}

Rispondi con questo formato JSON:
{
  "suggestedTags": ["tag1", "tag2", "tag3"],
  "metaDescription": "descrizione 150-160 caratteri",
  "titleSuggestions": ["alternativa 1", "alternativa 2"],
  "improvements": ["suggerimento 1", "suggerimento 2"]
}`,
      },
    ],
    response_format: { type: 'json_object' },
  });

  return JSON.parse(result);
}

/**
 * Convert a blog topic/title into a purely visual image prompt (no text elements)
 * Used to prevent AI image generators from rendering the title as text in the image
 */
export async function generateVisualImagePrompt(
  topic: string,
  model: string = 'gpt-4o-mini'
): Promise<string> {
  const result = await createChatCompletion({
    model,
    messages: [
      {
        role: 'system',
        content: `You are a visual art director creating prompts for AI image generators.
Convert the given blog topic into a PURELY VISUAL scene description for a cover image.

Rules:
- Describe only visual elements: objects, scenes, colors, lighting, composition, mood
- NEVER mention text, words, titles, or anything that would be written/rendered as text
- NEVER use the article title directly — translate it into visual metaphors
- Focus on: environments, objects, abstract shapes, people (without faces/labels), technology visualizations
- Style: cinematic, editorial photography style, wide landscape format
- Keep it under 80 words
- Write in English`,
      },
      {
        role: 'user',
        content: `Blog topic: "${topic}"\n\nGenerate a visual scene description for the cover image (NO text elements):`,
      },
    ],
  });

  return result.trim();
}

/**
 * Generate tags for a blog post
 */
export async function generateTags(
  title: string,
  content: string,
  model: string = 'gpt-4o-mini'
): Promise<string[]> {
  const result = await createChatCompletion({
    model,
    messages: [
      {
        role: 'system',
        content: 'Genera 3-5 tag SEO-friendly per questo articolo. Rispondi SOLO con un array JSON di stringhe.',
      },
      {
        role: 'user',
        content: `Titolo: ${title}\nContenuto: ${content.substring(0, 1500)}`,
      },
    ],
  });

  try {
    return JSON.parse(result);
  } catch {
    return [];
  }
}

/**
 * Generate a category for a blog post
 */
export async function generateCategory(
  title: string,
  content: string,
  model: string = 'gpt-4o-mini'
): Promise<string> {
  const result = await createChatCompletion({
    model,
    messages: [
      {
        role: 'system',
        content: 'Genera UNA sola categoria principale per questo articolo. La categoria deve essere breve (1-3 parole), in italiano, e adatta a un blog di sviluppo web e tecnologia. Rispondi SOLO con la categoria, senza punteggiatura o spiegazioni.',
      },
      {
        role: 'user',
        content: `Titolo: ${title}\nContenuto: ${content.substring(0, 1500)}`,
      },
    ],
  });

  return result.trim();
}

// ─────────────────────────────────────────────────────────────
// Article Writing from Research (Step 2 of the pipeline)
// ─────────────────────────────────────────────────────────────

export interface ResearchData {
  topic: string;
  summary: string;
  keyPoints: string[];
  sections: Array<{
    title: string;
    content: string;
    facts: string[];
  }>;
  sources: string[];
  suggestedImages: string[];
}

export interface ArticleWritingOptions {
  research: ResearchData;
  model?: string;
  writingStyle?: 'professional' | 'casual' | 'technical' | 'creative';
  tone?: 'informative' | 'educational' | 'conversational' | 'persuasive';
  targetWordCount?: number;
  language?: string;
  includeImagePlaceholders?: boolean;
  maxInlineImages?: number;
}

export interface WrittenArticle {
  title: string;
  slug: string;
  content: string;
  excerpt: string;
  wordCount: number;
  readingTimeMinutes: number;
  imagePlaceholders: Array<{
    id: string;
    position: number; // Posizione nel testo (indice carattere)
    description: string;
    context: string; // Sezione in cui inserire
  }>;
  tags: string[];
}

/**
 * Write a blog article from research data
 */
export async function writeArticle(options: ArticleWritingOptions): Promise<WrittenArticle> {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY non configurata');
  }

  const {
    research,
    model = 'gpt-4o',
    writingStyle = 'professional',
    tone = 'informative',
    targetWordCount = 1500,
    language = 'italiano',
    includeImagePlaceholders = true,
    maxInlineImages = 3,
  } = options;

  const styleGuides: Record<string, string> = {
    professional: 'Scrivi in modo professionale e autorevole, con linguaggio chiaro e preciso.',
    casual: 'Scrivi in modo amichevole e accessibile, come se parlassi con un amico.',
    technical: 'Scrivi in modo tecnico e dettagliato, adatto a un pubblico esperto.',
    creative: 'Scrivi in modo creativo e coinvolgente, con metafore e storytelling.',
  };

  const toneGuides: Record<string, string> = {
    informative: 'Mantieni un tono informativo, fornendo dati e fatti.',
    educational: 'Mantieni un tono educativo, spiegando concetti in modo didattico.',
    conversational: 'Mantieni un tono conversazionale, coinvolgendo il lettore.',
    persuasive: 'Mantieni un tono persuasivo, guidando il lettore verso una conclusione.',
  };

  // Prepara il contesto della ricerca
  const researchContext = `
RICERCA SUL TEMA: ${research.topic}

RIASSUNTO:
${research.summary}

PUNTI CHIAVE:
${research.keyPoints.map((p, i) => `${i + 1}. ${p}`).join('\n')}

SEZIONI RICERCATE:
${research.sections.map(s => `
### ${s.title}
${s.content}
Fatti verificati: ${s.facts.join('; ')}
`).join('\n')}

FONTI:
${research.sources.join('\n')}
`;

  const imageInstructions = includeImagePlaceholders
    ? `
IMMAGINI:
- Inserisci ${maxInlineImages} placeholder per immagini nel formato: [IMAGE:descrizione dettagliata per generare l'immagine]
- Posiziona i placeholder in punti strategici dell'articolo
- Le descrizioni devono essere specifiche e visive
- Suggerimenti dalla ricerca: ${research.suggestedImages.slice(0, maxInlineImages).join(', ')}`
    : '';

  const systemPrompt = `Sei un content writer esperto. Scrivi articoli di alta qualità basandoti sulla ricerca fornita.
${styleGuides[writingStyle]}
${toneGuides[tone]}
Lingua: ${language}
Lunghezza target: ${targetWordCount} parole

REGOLE:
- Usa SOLO informazioni dalla ricerca fornita
- Cita le fonti quando appropriato
- Formatta in Markdown
- Crea un titolo accattivante (inizia con # )
- Usa ## per le sezioni principali
- Includi un'introduzione coinvolgente e una conclusione efficace
- L'obiettivo finale è convertire i lettori in potenziali clienti: includi CTA sottili verso i servizi web/design
${imageInstructions}

DEMO INTERATTIVE (opzionale):
- Se l'articolo tratta concetti tecnici visualizzabili (animazioni CSS, effetti 3D, layout, UI pattern, interazioni JS), inserisci fino a 2 placeholder demo nel formato: <!-- DEMO: descrizione precisa dell'effetto da mostrare -->
- La demo verrà generata come pagina HTML interattiva e mostrata in un iframe
- Usa questi placeholder SOLO quando una demo visiva aggiunge valore concreto all'articolo
- Non usarli per concetti puramente teorici o non visualizzabili`;

  const userPrompt = `Scrivi un articolo completo basandoti su questa ricerca:

${researchContext}

Genera un articolo completo, ben strutturato e coinvolgente.`;

  const content = await createChatCompletion({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
    max_tokens: 4000,
  });

  // Estrai titolo
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : research.topic;

  // Genera slug
  const slug = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Rimuovi accenti
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 80);

  // Rimuovi titolo dal contenuto
  const contentWithoutTitle = content.replace(/^#\s+.+\n+/, '');

  // Estrai placeholder immagini
  const imagePlaceholders: WrittenArticle['imagePlaceholders'] = [];
  const imageRegex = /\[IMAGE:([^\]]+)\]/g;
  let match;
  let imageIndex = 0;

  while ((match = imageRegex.exec(contentWithoutTitle)) !== null) {
    // Trova la sezione corrente
    const textBefore = contentWithoutTitle.substring(0, match.index);
    const sectionMatch = textBefore.match(/##\s+([^\n]+)/g);
    const currentSection = sectionMatch ? sectionMatch[sectionMatch.length - 1].replace('## ', '') : 'Introduzione';

    imagePlaceholders.push({
      id: `img-${imageIndex++}`,
      position: match.index,
      description: match[1].trim(),
      context: currentSection,
    });
  }

  // Genera excerpt
  const cleanContent = contentWithoutTitle.replace(/\[IMAGE:[^\]]+\]/g, '');
  const excerpt = cleanContent
    .substring(0, 200)
    .replace(/[#*_\[\]]/g, '')
    .trim() + '...';

  // Calcola statistiche
  const wordCount = cleanContent.split(/\s+/).length;
  const readingTimeMinutes = Math.ceil(wordCount / 200);

  // Genera tags automaticamente
  let tags: string[] = [];
  try {
    tags = await generateTags(title, cleanContent.substring(0, 1500), 'gpt-4o-mini');
  } catch {
    tags = [];
  }

  return {
    title,
    slug,
    content: contentWithoutTitle,
    excerpt,
    wordCount,
    readingTimeMinutes,
    imagePlaceholders,
    tags,
  };
}
