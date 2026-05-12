/**
 * Cover Image Generator for Hono
 * Supports DALL-E, Z-Image (kie.ai), and Unsplash
 */

import { uploadFile, generateFileKey } from '../s3';
import { generateVisualImagePrompt, isOpenAIConfigured } from './openai';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const KIE_API_KEY = process.env.KIE_API_KEY;
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;

// DALL-E Models
export const DALLE_MODELS = [
  { id: 'dall-e-3', name: 'DALL-E 3', description: 'Alta qualità, dettagliato' },
  { id: 'dall-e-2', name: 'DALL-E 2', description: 'Più economico' },
] as const;

export type DalleModel = typeof DALLE_MODELS[number]['id'];

// Z-Image Models (kie.ai) — only one model available as of 2026-02
export const ZIMAGE_MODELS = [
  { id: 'z-image', name: 'Z-Image', description: 'Generazione veloce' },
] as const;

export type ZImageModel = typeof ZIMAGE_MODELS[number]['id'];

export type CoverProvider = 'none' | 'dalle' | 'zimage' | 'unsplash';

export interface CoverResult {
  url: string;
  provider: CoverProvider;
  savedToStorage: boolean;
  storageKey?: string;
  metadata: {
    prompt?: string;
    author?: string;
    authorUrl?: string;
    originalUrl?: string;
    width?: number;
    height?: number;
  };
}

export interface CoverGenerationOptions {
  topic: string;
  provider: CoverProvider;
  promptTemplate?: string;
  dalleModel?: DalleModel;
  dalleSize?: '1024x1024' | '1792x1024' | '1024x1792';
  dalleQuality?: 'standard' | 'hd';
  zimageModel?: ZImageModel;
  unsplashQuery?: string;
}

const ZIMAGE_NEGATIVE_PROMPT = 'text, words, letters, numbers, typography, titles, captions, watermarks, logos, writing, fonts, labels, headlines, subtitles, inscriptions, signs, banners';

const DEFAULT_PROMPT = `{topic}

Style: clean editorial photography or high-quality digital illustration, cinematic lighting, wide landscape format 16:9, professional tech/design blog cover, harmonious color palette, no text, no words, no typography`;

const DEFAULT_DALLE_PROMPT = `Create a professional blog cover image. {topic}. Wide landscape format, editorial style, harmonious modern colors. Do not include any text, words, letters, watermarks, or typography of any kind.`;

/**
 * Check which providers are configured
 */
export function getConfiguredProviders() {
  return {
    dalle: !!OPENAI_API_KEY,
    zimage: !!KIE_API_KEY,
    unsplash: !!UNSPLASH_ACCESS_KEY,
  };
}

/**
 * Generate cover image with the specified provider
 */
export async function generateCover(options: CoverGenerationOptions): Promise<CoverResult> {
  const { provider, topic } = options;

  switch (provider) {
    case 'dalle':
      return generateWithDalle(options);
    case 'zimage':
      return generateWithZImage(options);
    case 'unsplash':
      return searchUnsplash(options);
    case 'none':
    default:
      throw new Error('Nessun provider di immagini selezionato');
  }
}

/**
 * Generate image with DALL-E
 */
async function generateWithDalle(options: CoverGenerationOptions): Promise<CoverResult> {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY non configurata');
  }

  const {
    topic,
    promptTemplate,
    dalleModel = 'dall-e-3',
    dalleSize = '1792x1024',
    dalleQuality = 'standard',
  } = options;

  // Convert topic to visual description to prevent DALL-E rendering text
  let visualTopic = topic;
  if (!promptTemplate && isOpenAIConfigured()) {
    try {
      visualTopic = await generateVisualImagePrompt(topic);
    } catch {
      // fallback to raw topic
    }
  }

  const prompt = (promptTemplate || DEFAULT_DALLE_PROMPT).replace('{topic}', visualTopic);

  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: dalleModel,
      prompt,
      n: 1,
      size: dalleSize,
      quality: dalleQuality,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`DALL-E API error: ${error.error?.message || response.status}`);
  }

  const data = await response.json();
  const imageUrl = data.data[0]?.url;

  if (!imageUrl) {
    throw new Error('DALL-E: nessuna immagine generata');
  }

  // Save to S3
  const saved = await saveImageToS3(imageUrl, 'covers/dalle');

  return {
    url: saved?.url || imageUrl,
    provider: 'dalle',
    savedToStorage: !!saved,
    storageKey: saved?.key,
    metadata: {
      prompt,
      originalUrl: imageUrl,
      width: parseInt(dalleSize.split('x')[0]),
      height: parseInt(dalleSize.split('x')[1]),
    },
  };
}

/**
 * Generate image with Z-Image (kie.ai)
 */
async function generateWithZImage(options: CoverGenerationOptions): Promise<CoverResult> {
  if (!KIE_API_KEY) {
    throw new Error('KIE_API_KEY non configurata');
  }

  const {
    topic,
    promptTemplate,
    zimageModel = 'z-image',
  } = options;

  // Generate visual prompt from topic using our LLM router (Mistral3)
  let visualTopic = topic;
  try {
    const { generateText } = await import('../agent/llm-router');
    visualTopic = await generateText('chat_fast', [
      { role: 'system', content: 'Generate a SHORT image prompt in English for an AI image generator. Describe a VISUAL SCENE, no text/words/letters. Style: editorial photography, cinematic, modern, 16:9 landscape. Max 2 sentences.' },
      { role: 'user', content: `Blog article about: ${topic}` },
    ], { temperature: 0.7, max_tokens: 100 });
  } catch {
    // fallback: use topic as-is
  }

  const prompt = (promptTemplate || DEFAULT_PROMPT).replace('{topic}', visualTopic);

  // Create generation task (new API: /api/v1/jobs/createTask)
  const createResponse = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${KIE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: zimageModel,
      input: {
        prompt,
        negative_prompt: ZIMAGE_NEGATIVE_PROMPT,
        aspect_ratio: '16:9',
      },
    }),
  });

  const createData = await createResponse.json();

  // kie.ai returns HTTP 200 even for errors; check application-level code
  if (!createResponse.ok || createData.code !== 200) {
    throw new Error(`Z-Image API error: ${createData.msg || createResponse.status}`);
  }

  const taskId = createData.data?.taskId;

  if (!taskId) {
    throw new Error(`Z-Image: nessun task ID ricevuto. Response: ${JSON.stringify(createData)}`);
  }

  // Poll for completion (new API: GET /api/v1/jobs/recordInfo?taskId=...)
  const maxAttempts = 30;
  const pollInterval = 2000;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));

    const statusResponse = await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${taskId}`, {
      headers: {
        'Authorization': `Bearer ${KIE_API_KEY}`,
      },
    });

    if (!statusResponse.ok) continue;

    const statusData = await statusResponse.json();
    const state = statusData.data?.state;

    if (state === 'success') {
      const resultJson = statusData.data?.resultJson;
      let imageUrl: string | undefined;
      try {
        const parsed = typeof resultJson === 'string' ? JSON.parse(resultJson) : resultJson;
        imageUrl = parsed?.resultUrls?.[0];
      } catch {
        imageUrl = undefined;
      }

      if (!imageUrl) {
        throw new Error('Z-Image: immagine generata ma URL non trovato');
      }

      // Save to S3
      const saved = await saveImageToS3(imageUrl, 'covers/zimage');

      return {
        url: saved?.url || imageUrl,
        provider: 'zimage',
        savedToStorage: !!saved,
        storageKey: saved?.key,
        metadata: {
          prompt,
          originalUrl: imageUrl,
        },
      };
    }

    if (state === 'failed') {
      throw new Error(`Z-Image: ${statusData.data?.error || 'generazione fallita'}`);
    }
  }

  throw new Error('Z-Image: timeout generazione immagine');
}

/**
 * Search image on Unsplash
 */
async function searchUnsplash(options: CoverGenerationOptions): Promise<CoverResult> {
  if (!UNSPLASH_ACCESS_KEY) {
    throw new Error('UNSPLASH_ACCESS_KEY non configurata');
  }

  const { topic, unsplashQuery } = options;
  const query = unsplashQuery || topic;

  const response = await fetch(
    `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&orientation=landscape&per_page=1`,
    {
      headers: {
        'Authorization': `Client-ID ${UNSPLASH_ACCESS_KEY}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Unsplash API error: ${response.status}`);
  }

  const data = await response.json();
  const photo = data.results[0];

  if (!photo) {
    throw new Error('Unsplash: nessuna immagine trovata');
  }

  const imageUrl = photo.urls.regular;

  // Save to S3
  const saved = await saveImageToS3(imageUrl, 'covers/unsplash');

  // Track download (required by Unsplash API)
  if (photo.links?.download_location) {
    fetch(photo.links.download_location, {
      headers: { 'Authorization': `Client-ID ${UNSPLASH_ACCESS_KEY}` },
    }).catch(() => {});
  }

  return {
    url: saved?.url || imageUrl,
    provider: 'unsplash',
    savedToStorage: !!saved,
    storageKey: saved?.key,
    metadata: {
      author: photo.user?.name,
      authorUrl: photo.user?.links?.html,
      originalUrl: imageUrl,
      width: photo.width,
      height: photo.height,
    },
  };
}

/**
 * Download and save image to S3
 */
async function saveImageToS3(
  imageUrl: string,
  folder: string
): Promise<{ url: string; key: string } | null> {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      console.error('[Cover] Download failed:', response.status);
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || 'image/png';
    const ext = contentType.includes('png') ? 'png' : 'jpg';
    const key = generateFileKey(`cover.${ext}`, folder);

    // Ensure directory exists
    const { mkdirSync } = await import('fs');
    const { join, dirname } = await import('path');
    mkdirSync(join(process.env.UPLOAD_DIR || './uploads', folder), { recursive: true });

    const result = await uploadFile(buffer, key, contentType);
    console.log('[Cover] Saved:', result.url);
    return { url: result.url, key: result.key };
  } catch (error) {
    console.error('[Cover] Save error:', error instanceof Error ? error.message : error);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Inline Images Generation (Step 3 of the pipeline)
// ─────────────────────────────────────────────────────────────

export interface InlineImageRequest {
  id: string;
  description: string;
  context: string; // Sezione dell'articolo
}

export interface InlineImageResult {
  id: string;
  url: string;
  savedToStorage: boolean;
  storageKey?: string;
  description: string;
  alt: string;
  provider: CoverProvider;
}

export interface GenerateInlineImagesOptions {
  images: InlineImageRequest[];
  provider: CoverProvider;
  dalleModel?: DalleModel;
  zimageModel?: ZImageModel;
  articleTitle: string;
}

const INLINE_IMAGE_PROMPT = `{description}, {context} — editorial illustration style, cinematic lighting, wide landscape format, professional harmonious colors, no text, no words, no typography, no labels`;

/**
 * Generate multiple inline images for an article
 * All images are saved to S3
 */
export async function generateInlineImages(
  options: GenerateInlineImagesOptions
): Promise<InlineImageResult[]> {
  const { images, provider, dalleModel, zimageModel, articleTitle } = options;

  if (provider === 'none' || images.length === 0) {
    return [];
  }

  const results: InlineImageResult[] = [];

  // Genera immagini in sequenza per evitare rate limits
  for (const image of images) {
    try {
      const prompt = INLINE_IMAGE_PROMPT
        .replace('{context}', `${articleTitle} - Sezione: ${image.context}`)
        .replace('{description}', image.description);

      let imageResult: CoverResult;

      switch (provider) {
        case 'dalle':
          imageResult = await generateWithDalleCustom({
            prompt,
            model: dalleModel || 'dall-e-3',
            size: '1792x1024', // Wide for inline
            folder: 'blog/inline',
          });
          break;
        case 'zimage':
          imageResult = await generateWithZImageCustom({
            prompt,
            model: zimageModel || 'z-image',
            folder: 'blog/inline',
          });
          break;
        case 'unsplash':
          imageResult = await searchUnsplashCustom({
            query: image.description,
            folder: 'blog/inline',
          });
          break;
        default:
          continue;
      }

      results.push({
        id: image.id,
        url: imageResult.url,
        savedToStorage: imageResult.savedToStorage,
        storageKey: imageResult.storageKey,
        description: image.description,
        alt: `${articleTitle} - ${image.context}`,
        provider,
      });
    } catch (error) {
      console.error(`Error generating inline image ${image.id}:`, error);
      // Continua con le altre immagini
    }
  }

  return results;
}

/**
 * DALL-E generation with custom options
 */
async function generateWithDalleCustom(options: {
  prompt: string;
  model: DalleModel;
  size: '1024x1024' | '1792x1024' | '1024x1792';
  folder: string;
}): Promise<CoverResult> {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY non configurata');
  }

  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: options.model,
      prompt: options.prompt,
      n: 1,
      size: options.size,
      quality: 'standard',
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`DALL-E API error: ${error.error?.message || response.status}`);
  }

  const data = await response.json();
  const imageUrl = data.data[0]?.url;

  if (!imageUrl) {
    throw new Error('DALL-E: nessuna immagine generata');
  }

  const saved = await saveImageToS3(imageUrl, options.folder);

  return {
    url: saved?.url || imageUrl,
    provider: 'dalle',
    savedToStorage: !!saved,
    storageKey: saved?.key,
    metadata: {
      prompt: options.prompt,
      originalUrl: imageUrl,
    },
  };
}

/**
 * Z-Image generation with custom options
 */
async function generateWithZImageCustom(options: {
  prompt: string;
  model: ZImageModel;
  folder: string;
}): Promise<CoverResult> {
  if (!KIE_API_KEY) {
    throw new Error('KIE_API_KEY non configurata');
  }

  const createResponse = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${KIE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: options.model,
      input: {
        prompt: options.prompt,
        negative_prompt: ZIMAGE_NEGATIVE_PROMPT,
        aspect_ratio: '16:9',
      },
    }),
  });

  const createData = await createResponse.json();

  // kie.ai returns HTTP 200 even for errors; check application-level code
  if (!createResponse.ok || createData.code !== 200) {
    throw new Error(`Z-Image API error: ${createData.msg || createResponse.status}`);
  }

  const taskId = createData.data?.taskId;

  if (!taskId) {
    throw new Error(`Z-Image: nessun task ID ricevuto. Response: ${JSON.stringify(createData)}`);
  }

  // Poll for completion
  const maxAttempts = 30;
  const pollInterval = 2000;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));

    const statusResponse = await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${taskId}`, {
      headers: { 'Authorization': `Bearer ${KIE_API_KEY}` },
    });

    if (!statusResponse.ok) continue;

    const statusData = await statusResponse.json();
    const state = statusData.data?.state;

    if (state === 'success') {
      const resultJson = statusData.data?.resultJson;
      let imageUrl: string | undefined;
      try {
        const parsed = typeof resultJson === 'string' ? JSON.parse(resultJson) : resultJson;
        imageUrl = parsed?.resultUrls?.[0];
      } catch {
        imageUrl = undefined;
      }

      if (!imageUrl) {
        throw new Error('Z-Image: immagine generata ma URL non trovato');
      }

      const saved = await saveImageToS3(imageUrl, options.folder);

      return {
        url: saved?.url || imageUrl,
        provider: 'zimage',
        savedToStorage: !!saved,
        storageKey: saved?.key,
        metadata: {
          prompt: options.prompt,
          originalUrl: imageUrl,
        },
      };
    }

    if (state === 'failed') {
      throw new Error(`Z-Image: ${statusData.data?.error || 'generazione fallita'}`);
    }
  }

  throw new Error('Z-Image: timeout generazione immagine');
}

/**
 * Unsplash search with custom folder
 */
async function searchUnsplashCustom(options: {
  query: string;
  folder: string;
}): Promise<CoverResult> {
  if (!UNSPLASH_ACCESS_KEY) {
    throw new Error('UNSPLASH_ACCESS_KEY non configurata');
  }

  const response = await fetch(
    `https://api.unsplash.com/search/photos?query=${encodeURIComponent(options.query)}&orientation=landscape&per_page=1`,
    { headers: { 'Authorization': `Client-ID ${UNSPLASH_ACCESS_KEY}` } }
  );

  if (!response.ok) {
    throw new Error(`Unsplash API error: ${response.status}`);
  }

  const data = await response.json();
  const photo = data.results[0];

  if (!photo) {
    throw new Error('Unsplash: nessuna immagine trovata');
  }

  const imageUrl = photo.urls.regular;
  const saved = await saveImageToS3(imageUrl, options.folder);

  // Track download
  if (photo.links?.download_location) {
    fetch(photo.links.download_location, {
      headers: { 'Authorization': `Client-ID ${UNSPLASH_ACCESS_KEY}` },
    }).catch(() => {});
  }

  return {
    url: saved?.url || imageUrl,
    provider: 'unsplash',
    savedToStorage: !!saved,
    storageKey: saved?.key,
    metadata: {
      author: photo.user?.name,
      authorUrl: photo.user?.links?.html,
      originalUrl: imageUrl,
    },
  };
}

/**
 * Replace image placeholders in article content with actual URLs
 */
export function replaceImagePlaceholders(
  content: string,
  images: InlineImageResult[]
): string {
  let result = content;

  for (const image of images) {
    // Trova il placeholder corrispondente
    const placeholderRegex = new RegExp(`\\[IMAGE:${escapeRegex(image.description)}\\]`, 'g');

    // Sostituisci con markdown image
    const markdownImage = `\n\n![${image.alt}](${image.url})\n\n`;
    result = result.replace(placeholderRegex, markdownImage);
  }

  // Rimuovi eventuali placeholder non sostituiti
  result = result.replace(/\[IMAGE:[^\]]+\]/g, '');

  return result;
}

function escapeRegex(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
