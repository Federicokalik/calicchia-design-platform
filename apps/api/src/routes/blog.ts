import { Hono } from 'hono';
import { marked } from 'marked';
import { sql } from '../db';
import * as openai from '../lib/ai/openai';
import * as perplexity from '../lib/ai/perplexity';
import * as coverGenerator from '../lib/ai/cover-generator';
import { generateText } from '../lib/agent/llm-router';
import { getAdminLocale } from '../lib/admin-locale';

// Convert markdown content to HTML for Lexical editor
function mdToHtml(content: string): string {
  if (!content) return '';
  // If already HTML, return as-is
  if (content.trim().startsWith('<')) return content;
  try {
    return marked.parse(content, { async: false }) as string;
  } catch {
    return content;
  }
}

export const blog = new Hono();

function appendSourcesMd(content: string, sources: string[]): string {
  if (!sources || sources.length === 0) return content;
  const items = sources
    .map(s => {
      const isUrl = /^https?:\/\//i.test(s.trim());
      return isUrl ? `- [${s.trim()}](${s.trim()})` : `- ${s}`;
    })
    .join('\n');
  return content + `\n\n## Fonti\n\n${items}\n`;
}

/**
 * Process <!-- DEMO: description --> placeholders in article content.
 * Generates interactive HTML demos with Kimi-K2.5 and replaces placeholders
 * with iframe embeds pointing to /api/blog/demos/:postId/:index
 */
async function processCodeDemos(content: string, articleContext: string): Promise<{ content: string; demos: string[] }> {
  const demoRegex = /<!--\s*DEMO:\s*(.+?)\s*-->/g;
  const matches = [...content.matchAll(demoRegex)];
  if (matches.length === 0) return { content, demos: [] };

  const demos: string[] = [];
  let processedContent = content;

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const description = match[1].trim();

    try {
      console.log(`[Blog Gen] Generating demo ${i + 1}/${matches.length}: "${description}"`);
      const html = await generateText('code_generation', [
        { role: 'system', content: `Sei un esperto frontend developer. Genera una SINGOLA pagina HTML autocontenuta (HTML + CSS inline + JS inline) che funzioni come demo interattiva.

REGOLE TASSATIVE:
- Tutto in UN SOLO file HTML, nessun import esterno (no CDN, no librerie esterne)
- CSS inline dentro <style> nel <head>
- JS inline dentro <script> prima di </body>
- Design moderno: dark theme (#0a0a0a bg, #fff text), bordi arrotondati, animazioni CSS smooth
- DEVE essere responsive e funzionare in un iframe
- Max 250 righe di codice
- Se richiesto 3D/WebGL: usa Canvas 2D con effetti che SIMULANO 3D (parallax, prospettiva, ombre)
- Se richiesto animazioni: usa CSS @keyframes + requestAnimationFrame
- Rispondi SOLO con il codice HTML puro, senza markdown code blocks, senza testo prima o dopo` },
        { role: 'user', content: `Contesto articolo: ${articleContext.slice(0, 400)}\n\nDescrizione demo: ${description}` },
      ], { temperature: 0.4, max_tokens: 4000 });

      let cleanHtml = html.trim();
      const htmlMatch = cleanHtml.match(/```html?\n([\s\S]*?)```/);
      if (htmlMatch) cleanHtml = htmlMatch[1].trim();

      demos.push(cleanHtml);
    } catch (err) {
      console.error(`[Blog Gen] Demo generation failed for "${description}":`, err);
      demos.push(`<html><body style="background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui"><p>Demo non disponibile</p></body></html>`);
    }
  }

  // Replace placeholders with iframe embeds (will use post ID after save)
  let idx = 0;
  processedContent = processedContent.replace(demoRegex, () => {
    const demoIdx = idx++;
    return `\n<div class="demo-embed" data-demo-index="${demoIdx}"></div>\n`;
  });

  return { content: processedContent, demos };
}

// ─────────────────────────────────────────────────────────────
// Blog Posts CRUD (used by admin)
// ─────────────────────────────────────────────────────────────

blog.get('/posts', async (c) => {
  const search = c.req.query('search');
  const isPublished = c.req.query('is_published');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const offset = parseInt(c.req.query('offset') || '0');

  const searchFilter = search
    ? sql`AND (title ILIKE ${'%' + search + '%'} OR content ILIKE ${'%' + search + '%'})`
    : sql``;
  const publishedFilter = isPublished !== undefined
    ? sql`AND is_published = ${isPublished === 'true'}`
    : sql``;

  const posts = await sql`
    SELECT *, COUNT(*) OVER() AS _total_count
    FROM blog_posts
    WHERE 1=1 ${searchFilter} ${publishedFilter}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const count = posts[0]?._total_count ? parseInt(posts[0]._total_count as string) : 0;
  return c.json({ posts: posts.map((p) => ({ ...p, _total_count: undefined })), count });
});

blog.get('/posts/:id', async (c) => {
  const [post] = await sql`SELECT * FROM blog_posts WHERE id = ${c.req.param('id')}`;
  if (!post) return c.json({ error: 'Post non trovato' }, 404);
  return c.json({ post });
});

blog.post('/posts', async (c) => {
  const body = await c.req.json();
  const [post] = await sql`INSERT INTO blog_posts ${sql(body)} RETURNING *`;
  return c.json({ post }, 201);
});

blog.put('/posts/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const [post] = await sql`UPDATE blog_posts SET ${sql(body)} WHERE id = ${id} RETURNING *`;
  return c.json({ post });
});

blog.delete('/posts/:id', async (c) => {
  await sql`DELETE FROM blog_posts WHERE id = ${c.req.param('id')}`;
  return c.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// TRANSLATIONS (i18n F3 — admin endpoints)
// ─────────────────────────────────────────────────────────────

const TRANSLATABLE_BLOG_FIELDS = ['title', 'excerpt', 'content'] as const;
type TranslatableBlogField = (typeof TRANSLATABLE_BLOG_FIELDS)[number];

const SUPPORTED_LOCALES_BLOG = ['it', 'en'] as const;
type SupportedLocaleBlog = (typeof SUPPORTED_LOCALES_BLOG)[number];

function isSupportedLocaleBlog(v: string): v is SupportedLocaleBlog {
  return (SUPPORTED_LOCALES_BLOG as readonly string[]).includes(v);
}
function isTranslatableBlogField(v: string): v is TranslatableBlogField {
  return (TRANSLATABLE_BLOG_FIELDS as readonly string[]).includes(v);
}

/** GET /api/blog/posts/:id/translations — admin: list translations grouped by locale. */
blog.get('/posts/:id/translations', async (c) => {
  const id = c.req.param('id');
  const [exists] = await sql`SELECT id FROM blog_posts WHERE id = ${id}`;
  if (!exists) return c.json({ error: 'Post non trovato' }, 404);

  const rows = await sql`
    SELECT locale, field_name, field_value, updated_at
    FROM blog_posts_translations
    WHERE post_id = ${id}
    ORDER BY locale, field_name
  `;

  const grouped: Record<string, Record<string, string>> = {};
  for (const r of rows) {
    const loc = String(r.locale);
    if (!grouped[loc]) grouped[loc] = {};
    grouped[loc][String(r.field_name)] = String(r.field_value);
  }

  return c.json({ post_id: id, translations: grouped });
});

/**
 * PATCH /api/blog/posts/:id/translations/:locale
 * Body: { title?, excerpt?, content? }
 * Upsert delle traduzioni per il locale specifico. null/empty cancella.
 */
blog.patch('/posts/:id/translations/:locale', async (c) => {
  const id = c.req.param('id');
  const locale = c.req.param('locale');

  if (!isSupportedLocaleBlog(locale)) {
    return c.json({ error: 'Locale non supportato (it|en)' }, 400);
  }

  const [exists] = await sql`SELECT id FROM blog_posts WHERE id = ${id}`;
  if (!exists) return c.json({ error: 'Post non trovato' }, 404);

  const body = await c.req.json<Partial<Record<TranslatableBlogField, string | null>>>();
  const upserted: string[] = [];
  const deleted: string[] = [];

  for (const [field, value] of Object.entries(body)) {
    if (!isTranslatableBlogField(field)) continue;

    if (value === null || value === '') {
      await sql`
        DELETE FROM blog_posts_translations
        WHERE post_id = ${id} AND locale = ${locale} AND field_name = ${field}
      `;
      deleted.push(field);
    } else {
      await sql`
        INSERT INTO blog_posts_translations (post_id, locale, field_name, field_value)
        VALUES (${id}, ${locale}, ${field}, ${value})
        ON CONFLICT (post_id, locale, field_name)
        DO UPDATE SET field_value = EXCLUDED.field_value, updated_at = NOW()
      `;
      upserted.push(field);
    }
  }

  return c.json({ post_id: id, locale, upserted, deleted });
});

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

blog.get('/config', async (c) => {
  const [config] = await sql`SELECT * FROM blog_generation_config LIMIT 1`;

  const apiStatus = {
    perplexity: {
      configured: perplexity.isPerplexityConfigured(),
      working: perplexity.isPerplexityConfigured(),
    },
    openai: {
      configured: openai.isOpenAIConfigured(),
      working: openai.isOpenAIConfigured(),
    },
  };

  return c.json({
    config: config || {
      is_enabled: false,
      perplexity_model: 'sonar-pro',
      openai_model: 'gpt-4o',
      cover_provider: 'none',
      dalle_model: 'dall-e-3',
      zimage_model: 'z-image',
      writing_style: 'professional',
      tone: 'informative',
      language: 'it',
      target_word_count: 1500,
      auto_publish: false,
      include_inline_images: true,
      max_inline_images: 3,
      research_depth: 'detailed',
      topics: [],
      default_tags: [],
      total_generated: 0,
      total_published: 0,
      total_failed: 0,
      schedule_enabled: false,
      schedule_frequency: 'weekly',
      schedule_time: '09:00',
      schedule_timezone: 'Europe/Rome',
      schedule_days: [1, 3, 5],
      schedule_auto_publish: false,
      schedule_publish_delay_hours: 0,
      schedule_last_run: null,
      schedule_next_run: null,
    },
    apiStatus,
  });
});

blog.put('/config', async (c) => {
  const body = await c.req.json();
  const [existing] = await sql`SELECT id FROM blog_generation_config LIMIT 1`;

  let result;
  if (existing) {
    [result] = await sql`UPDATE blog_generation_config SET ${sql(body)} WHERE id = ${existing.id} RETURNING *`;
  } else {
    [result] = await sql`INSERT INTO blog_generation_config ${sql(body)} RETURNING *`;
  }

  return c.json({ config: result });
});

blog.get('/config/models', async (c) => {
  const isEn = getAdminLocale(c) === 'en';
  const result: {
    perplexity: Array<{ id: string; name: string; description?: string }>;
    openai: Array<{ id: string; name: string }>;
    coverProviders: Array<{ id: string; name: string }>;
    dalle: Array<{ id: string; name: string; description?: string }>;
    zimage: Array<{ id: string; name: string; description?: string }>;
    writingStyles: Array<{ id: string; name: string }>;
    tones: Array<{ id: string; name: string }>;
    languages: Array<{ id: string; name: string }>;
  } = {
    perplexity: [],
    openai: [],
    coverProviders: [],
    dalle: [],
    zimage: [],
    writingStyles: [],
    tones: [],
    languages: [],
  };

  if (perplexity.isPerplexityConfigured()) {
    result.perplexity = perplexity.PERPLEXITY_MODELS.map(m => ({ id: m.id, name: m.name, description: m.description }));
  }

  if (openai.isOpenAIConfigured()) {
    try {
      const openaiModels = await openai.fetchModels();
      result.openai = openaiModels.map(m => ({ id: m.id, name: m.name }));
    } catch {
      result.openai = [
        { id: 'gpt-4o', name: 'GPT-4o' },
        { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
        { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
      ];
    }
  }

  const configured = coverGenerator.getConfiguredProviders();
  result.coverProviders = [{ id: 'none', name: isEn ? 'No image' : 'Nessuna immagine' }];
  if (configured.dalle) result.coverProviders.push({ id: 'dalle', name: 'DALL-E (OpenAI)' });
  if (configured.zimage) result.coverProviders.push({ id: 'zimage', name: 'Z-Image (kie.ai)' });
  if (configured.unsplash) result.coverProviders.push({ id: 'unsplash', name: 'Unsplash (stock)' });

  result.dalle = coverGenerator.DALLE_MODELS.map(m => ({ id: m.id, name: m.name, description: m.description }));
  result.zimage = coverGenerator.ZIMAGE_MODELS.map(m => ({ id: m.id, name: m.name, description: m.description }));
  result.writingStyles = [
    { id: 'professional', name: isEn ? 'Professional' : 'Professionale' },
    { id: 'casual', name: 'Casual' },
    { id: 'technical', name: isEn ? 'Technical' : 'Tecnico' },
    { id: 'creative', name: isEn ? 'Creative' : 'Creativo' },
  ];
  result.tones = [
    { id: 'informative', name: isEn ? 'Informative' : 'Informativo' },
    { id: 'educational', name: isEn ? 'Educational' : 'Educativo' },
    { id: 'conversational', name: isEn ? 'Conversational' : 'Conversazionale' },
    { id: 'persuasive', name: isEn ? 'Persuasive' : 'Persuasivo' },
  ];
  result.languages = [
    { id: 'it', name: isEn ? 'Italian' : 'Italiano' },
    { id: 'en', name: 'English' },
    { id: 'es', name: 'Español' },
    { id: 'de', name: 'Deutsch' },
    { id: 'fr', name: 'Français' },
  ];

  return c.json(result);
});

// ─────────────────────────────────────────────────────────────
// Generation Logs
// ─────────────────────────────────────────────────────────────

blog.get('/logs', async (c) => {
  const limit = parseInt(c.req.query('limit') || '20');
  const logs = await sql`
    SELECT l.*, jsonb_build_object('title', p.title, 'slug', p.slug, 'is_published', p.is_published) AS blog_posts
    FROM blog_generation_logs l
    LEFT JOIN blog_posts p ON p.id = l.blog_post_id
    ORDER BY l.created_at DESC
    LIMIT ${limit}
  `;
  return c.json({ logs });
});

blog.get('/logs/:id', async (c) => {
  const rows = await sql`
    SELECT l.*, jsonb_build_object('title', p.title, 'slug', p.slug, 'is_published', p.is_published) AS blog_posts
    FROM blog_generation_logs l
    LEFT JOIN blog_posts p ON p.id = l.blog_post_id
    WHERE l.id = ${c.req.param('id')}
  `;
  if (!rows.length) return c.json({ error: 'Log non trovato' }, 404);
  return c.json({ log: rows[0] });
});

// ─────────────────────────────────────────────────────────────
// Article Generation
// ─────────────────────────────────────────────────────────────

interface GenerateRequest {
  topic: string;
  skipSave?: boolean;
  keywords?: string[];
  perplexity_model?: string;
  openai_model?: string;
  cover_provider?: coverGenerator.CoverProvider;
  dalle_model?: string;
  zimage_model?: string;
  writing_style?: string;
  tone?: string;
  language?: string;
  target_word_count?: number;
  auto_publish?: boolean;
  include_inline_images?: boolean;
  max_inline_images?: number;
  research_depth?: 'basic' | 'detailed' | 'comprehensive';
}

blog.post('/generate', async (c) => {
  const body = await c.req.json<GenerateRequest>();
  let { topic, skipSave = false, keywords = [] } = body;

  const [config] = await sql`SELECT * FROM blog_generation_config LIMIT 1`;

  // If no topic, pick one from configured list
  if (!topic?.trim()) {
    const topics = config?.topics || [];
    if (topics.length > 0) {
      topic = topics[Math.floor(Math.random() * topics.length)];
    } else {
      return c.json({ error: 'Nessun topic specificato e nessun topic nella lista configurata' }, 400);
    }
  }

  const settings = {
    perplexity_model: body.perplexity_model || config?.perplexity_model || 'sonar-pro',
    openai_model: body.openai_model || config?.openai_model || 'gpt-4o',
    cover_provider: (body.cover_provider || config?.cover_provider || 'none') as coverGenerator.CoverProvider,
    dalle_model: body.dalle_model || config?.dalle_model || 'dall-e-3',
    zimage_model: body.zimage_model || config?.zimage_model || 'z-image',
    writing_style: body.writing_style || config?.writing_style || 'professional',
    tone: body.tone || config?.tone || 'informative',
    language: body.language || config?.language || 'it',
    target_word_count: body.target_word_count || config?.target_word_count || 1500,
    auto_publish: body.auto_publish ?? config?.auto_publish ?? false,
    include_inline_images: body.include_inline_images ?? config?.include_inline_images ?? true,
    max_inline_images: body.max_inline_images ?? config?.max_inline_images ?? 3,
    research_depth: body.research_depth || config?.research_depth || 'detailed',
  };

  const languageMap: Record<string, string> = { it: 'italiano', en: 'english', es: 'español', de: 'deutsch', fr: 'français' };
  const startTime = Date.now();

  const [log] = await sql`
    INSERT INTO blog_generation_logs ${sql({
      topic_used: topic,
      status: 'researching',
      triggered_by: 'manual',
      config_snapshot: settings,
      started_at: new Date().toISOString(),
      research_model_used: settings.perplexity_model,
    })} RETURNING *
  `;
  const logId = log.id;

  try {
    await sql`UPDATE blog_generation_logs SET status = 'researching' WHERE id = ${logId}`;

    console.log(`[Blog Gen] Step 1: Researching "${topic}" with Perplexity...`);
    const research = await perplexity.research({
      topic,
      model: settings.perplexity_model as perplexity.PerplexityModel,
      language: languageMap[settings.language] || 'italiano',
      depth: settings.research_depth as 'basic' | 'detailed' | 'comprehensive',
    });

    await sql`UPDATE blog_generation_logs SET ${sql({ status: 'generating', generation_model_used: settings.openai_model })} WHERE id = ${logId}`;

    console.log(`[Blog Gen] Step 2: Writing article with OpenAI ${settings.openai_model}...`);
    const article = await openai.writeArticle({
      research,
      model: settings.openai_model,
      writingStyle: settings.writing_style as 'professional' | 'casual' | 'technical' | 'creative',
      tone: settings.tone as 'informative' | 'educational' | 'conversational' | 'persuasive',
      targetWordCount: settings.target_word_count,
      language: languageMap[settings.language] || 'italiano',
      includeImagePlaceholders: settings.include_inline_images && settings.cover_provider !== 'none',
      maxInlineImages: settings.max_inline_images,
    });

    await sql`UPDATE blog_generation_logs SET ${sql({
      generated_title: article.title,
      generated_slug: article.slug,
      generated_word_count: article.wordCount,
      generation_completed_at: new Date().toISOString(),
    })} WHERE id = ${logId}`;

    let coverImage: coverGenerator.CoverResult | null = null;
    if (settings.cover_provider && settings.cover_provider !== 'none') {
      try {
        await sql`UPDATE blog_generation_logs SET ${sql({ status: 'generating_cover', cover_provider_used: settings.cover_provider })} WHERE id = ${logId}`;
        coverImage = await coverGenerator.generateCover({
          topic: article.title,
          provider: settings.cover_provider,
          dalleModel: settings.dalle_model as coverGenerator.DalleModel,
          zimageModel: settings.zimage_model as coverGenerator.ZImageModel,
        });
        await sql`UPDATE blog_generation_logs SET cover_url = ${coverImage.url} WHERE id = ${logId}`;
      } catch (err) {
        console.error('[Blog Gen] Cover generation FAILED:', err instanceof Error ? err.message : err);
        // Update log with error but continue without cover
        await sql`UPDATE blog_generation_logs SET cover_url = ${'ERROR: ' + (err instanceof Error ? err.message : 'unknown')} WHERE id = ${logId}`;
      }
    }

    let finalContent = article.content;
    let inlineImages: coverGenerator.InlineImageResult[] = [];

    if (settings.include_inline_images && settings.cover_provider !== 'none' && article.imagePlaceholders.length > 0) {
      try {
        await sql`UPDATE blog_generation_logs SET status = 'generating_images' WHERE id = ${logId}`;
        inlineImages = await coverGenerator.generateInlineImages({
          images: article.imagePlaceholders,
          provider: settings.cover_provider,
          dalleModel: settings.dalle_model as coverGenerator.DalleModel,
          zimageModel: settings.zimage_model as coverGenerator.ZImageModel,
          articleTitle: article.title,
        });
        finalContent = coverGenerator.replaceImagePlaceholders(article.content, inlineImages);
      } catch (err) {
        console.error('[Blog Gen] Inline images error:', err);
        finalContent = article.content.replace(/\[IMAGE:[^\]]+\]/g, '');
      }
    } else {
      finalContent = article.content.replace(/\[IMAGE:[^\]]+\]/g, '');
    }

    if (!finalContent || finalContent.trim().length < 100) {
      throw new Error(`Il modello OpenAI (${settings.openai_model}) ha restituito contenuto vuoto o insufficiente.`);
    }

    finalContent = appendSourcesMd(finalContent, research.sources);

    // Process code demo placeholders (<!-- DEMO: description -->)
    let demos: string[] = [];
    const hasDemos = /<!--\s*DEMO:/i.test(finalContent);
    if (hasDemos) {
      try {
        await sql`UPDATE blog_generation_logs SET status = 'generating_demos' WHERE id = ${logId}`;
        console.log('[Blog Gen] Step 4: Generating code demos with Kimi-K2.5...');
        const demoResult = await processCodeDemos(finalContent, article.title + ' — ' + article.excerpt);
        finalContent = demoResult.content;
        demos = demoResult.demos;
        console.log(`[Blog Gen] Generated ${demos.length} code demos`);
      } catch (err) {
        console.error('[Blog Gen] Demo generation error:', err);
        // Remove placeholders if demo generation fails
        finalContent = finalContent.replace(/<!--\s*DEMO:\s*.+?\s*-->/g, '');
      }
    }

    const tags = [...new Set([...keywords, ...(config?.default_tags || []), ...article.tags])];
    const duration = Date.now() - startTime;

    if (skipSave) {
      await sql`UPDATE blog_generation_logs SET ${sql({ status: 'completed', completed_at: new Date().toISOString(), duration_ms: duration })} WHERE id = ${logId}`;
      return c.json({
        success: true,
        preview: true,
        article: { title: article.title, slug: article.slug, content: finalContent, excerpt: article.excerpt, wordCount: article.wordCount, readingTimeMinutes: article.readingTimeMinutes, tags, coverImage: coverImage?.url, inlineImages: inlineImages.map(img => ({ url: img.url, alt: img.alt })) },
        research: { keyPoints: research.keyPoints, sources: research.sources },
        log_id: logId,
      });
    }

    const postData: Record<string, unknown> = {
      title: article.title,
      slug: article.slug,
      content: finalContent,
      excerpt: article.excerpt,
      tags,
      status: settings.auto_publish ? 'published' : 'draft',
      is_published: settings.auto_publish,
      published_at: settings.auto_publish ? new Date().toISOString() : null,
      reading_time: article.readingTimeMinutes,
      demos: JSON.stringify(demos),
    };

    if (coverImage?.savedToStorage && coverImage.storageKey) {
      postData.cover_image = coverImage.storageKey;
    } else if (coverImage?.url) {
      postData.cover_image = coverImage.url;
    }

    const [post] = await sql`INSERT INTO blog_posts ${sql(postData)} RETURNING *`;

    await sql`UPDATE blog_generation_logs SET ${sql({ status: 'completed', blog_post_id: post.id, completed_at: new Date().toISOString(), duration_ms: duration })} WHERE id = ${logId}`;

    if (config?.id) {
      await sql`UPDATE blog_generation_config SET ${sql({
        total_generated: (config.total_generated || 0) + 1,
        total_published: (config.total_published || 0) + (settings.auto_publish ? 1 : 0),
        last_run_at: new Date().toISOString(),
      })} WHERE id = ${config.id}`;
    }

    return c.json({ success: true, post, article: { title: article.title, slug: article.slug, excerpt: article.excerpt, wordCount: article.wordCount, tags }, coverImage, inlineImages: inlineImages.length, research: { keyPoints: research.keyPoints.length, sources: research.sources.length }, log_id: logId, duration_ms: duration });
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : JSON.stringify(error) || 'Errore sconosciuto';
    console.error('[Blog Gen] Error:', errorMessage);

    await sql`UPDATE blog_generation_logs SET ${sql({ status: 'failed', error_message: errorMessage, completed_at: new Date().toISOString(), duration_ms: duration })} WHERE id = ${logId}`;

    if (config?.id) {
      await sql`UPDATE blog_generation_config SET total_failed = ${(config.total_failed || 0) + 1} WHERE id = ${config.id}`;
    }

    throw error;
  }
});

blog.post('/generate/random', async (c) => {
  const [config] = await sql`SELECT * FROM blog_generation_config LIMIT 1`;

  if (!config) return c.json({ error: 'Configurazione non trovata' }, 400);

  const topics = config.topics || [];
  if (topics.length === 0) return c.json({ error: 'Nessun topic configurato.' }, 400);

  const topic = topics[Math.floor(Math.random() * topics.length)];
  const languageMap: Record<string, string> = { it: 'italiano', en: 'english', es: 'español', de: 'deutsch', fr: 'français' };
  const startTime = Date.now();

  const [log] = await sql`
    INSERT INTO blog_generation_logs ${sql({
      topic_used: topic,
      status: 'researching',
      triggered_by: 'manual',
      config_snapshot: config,
      started_at: new Date().toISOString(),
      research_model_used: config.perplexity_model,
    })} RETURNING *
  `;

  try {
    const research = await perplexity.research({
      topic,
      model: config.perplexity_model as perplexity.PerplexityModel,
      language: languageMap[config.language] || 'italiano',
      depth: config.research_depth || 'detailed',
    });

    await sql`UPDATE blog_generation_logs SET ${sql({ status: 'generating', generation_model_used: config.openai_model })} WHERE id = ${log.id}`;

    const article = await openai.writeArticle({
      research,
      model: config.openai_model,
      writingStyle: config.writing_style,
      tone: config.tone,
      targetWordCount: config.target_word_count,
      language: languageMap[config.language] || 'italiano',
      includeImagePlaceholders: config.include_inline_images && config.cover_provider !== 'none',
      maxInlineImages: config.max_inline_images || 3,
    });

    await sql`UPDATE blog_generation_logs SET ${sql({ generated_title: article.title, generated_slug: article.slug, generated_word_count: article.wordCount, generation_completed_at: new Date().toISOString() })} WHERE id = ${log.id}`;

    let coverImage: coverGenerator.CoverResult | null = null;
    if (config.cover_provider && config.cover_provider !== 'none') {
      try {
        await sql`UPDATE blog_generation_logs SET ${sql({ status: 'generating_cover', cover_provider_used: config.cover_provider })} WHERE id = ${log.id}`;
        coverImage = await coverGenerator.generateCover({ topic: article.title, provider: config.cover_provider, dalleModel: config.dalle_model, zimageModel: config.zimage_model });
        await sql`UPDATE blog_generation_logs SET cover_url = ${coverImage.url} WHERE id = ${log.id}`;
      } catch (err) {
        console.error('[Generate Random] Cover error:', err);
      }
    }

    let finalContent = article.content;
    let inlineImages: coverGenerator.InlineImageResult[] = [];

    if (config.include_inline_images && config.cover_provider !== 'none' && article.imagePlaceholders.length > 0) {
      try {
        await sql`UPDATE blog_generation_logs SET status = 'generating_images' WHERE id = ${log.id}`;
        inlineImages = await coverGenerator.generateInlineImages({ images: article.imagePlaceholders, provider: config.cover_provider, dalleModel: config.dalle_model, zimageModel: config.zimage_model, articleTitle: article.title });
        finalContent = coverGenerator.replaceImagePlaceholders(article.content, inlineImages);
      } catch (err) {
        console.error('[Generate Random] Inline images error:', err);
        finalContent = article.content.replace(/\[IMAGE:[^\]]+\]/g, '');
      }
    } else {
      finalContent = article.content.replace(/\[IMAGE:[^\]]+\]/g, '');
    }

    if (finalContent) finalContent = appendSourcesMd(finalContent, research.sources);
    const tags = [...new Set([...(config.default_tags || []), ...article.tags])];

    const postData: Record<string, unknown> = {
      title: article.title,
      slug: article.slug,
      content: finalContent,
      excerpt: article.excerpt,
      tags,
      status: config.auto_publish ? 'published' : 'draft',
      is_published: config.auto_publish,
      published_at: config.auto_publish ? new Date().toISOString() : null,
      reading_time: article.readingTimeMinutes,
    };

    if (coverImage?.savedToStorage && coverImage.storageKey) {
      postData.cover_image = coverImage.storageKey;
    } else if (coverImage?.url) {
      postData.cover_image = coverImage.url;
    }

    const [post] = await sql`INSERT INTO blog_posts ${sql(postData)} RETURNING *`;
    const duration = Date.now() - startTime;

    await sql`UPDATE blog_generation_logs SET ${sql({ status: 'completed', blog_post_id: post.id, completed_at: new Date().toISOString(), duration_ms: duration })} WHERE id = ${log.id}`;
    await sql`UPDATE blog_generation_config SET ${sql({ total_generated: (config.total_generated || 0) + 1, total_published: (config.total_published || 0) + (config.auto_publish ? 1 : 0), last_run_at: new Date().toISOString() })} WHERE id = ${config.id}`;

    return c.json({ success: true, post, topic_used: topic, duration_ms: duration });
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : JSON.stringify(error) || 'Errore sconosciuto';
    await sql`UPDATE blog_generation_logs SET ${sql({ status: 'failed', error_message: errorMessage, completed_at: new Date().toISOString(), duration_ms: duration })} WHERE id = ${log.id}`;
    await sql`UPDATE blog_generation_config SET total_failed = ${(config.total_failed || 0) + 1} WHERE id = ${config.id}`;
    throw error;
  }
});

blog.post('/:id/seo', async (c) => {
  const postId = c.req.param('id');
  const body = await c.req.json<{ model?: string }>();

  const [post] = await sql`SELECT title, content, tags FROM blog_posts WHERE id = ${postId}`;
  if (!post) return c.json({ error: 'Post non trovato' }, 404);
  if (!openai.isOpenAIConfigured()) return c.json({ error: 'OpenAI non configurato' }, 400);

  const suggestions = await openai.generateSEOSuggestions(post.title as string, post.content as string, (post.tags as string[]) || [], body.model || 'gpt-4o-mini');
  return c.json({ suggestions });
});

blog.post('/:id/regenerate-cover', async (c) => {
  const postId = c.req.param('id');
  const body = await c.req.json<{ provider: coverGenerator.CoverProvider; model?: string; customPrompt?: string }>();

  const [post] = await sql`SELECT title FROM blog_posts WHERE id = ${postId}`;
  if (!post) return c.json({ error: 'Post non trovato' }, 404);

  const coverImage = await coverGenerator.generateCover({
    topic: post.title as string,
    provider: body.provider,
    promptTemplate: body.customPrompt,
    dalleModel: body.model as coverGenerator.DalleModel,
    zimageModel: body.model as coverGenerator.ZImageModel,
  });

  const coverImageValue = coverImage.savedToStorage && coverImage.storageKey ? coverImage.storageKey : coverImage.url;
  await sql`UPDATE blog_posts SET cover_image = ${coverImageValue} WHERE id = ${postId}`;

  return c.json({ coverImage });
});

blog.post('/:id/generate-tags', async (c) => {
  const postId = c.req.param('id');
  const body = await c.req.json<{ model?: string }>();

  const [post] = await sql`SELECT title, content, tags FROM blog_posts WHERE id = ${postId}`;
  if (!post) return c.json({ error: 'Post non trovato' }, 404);
  if (!openai.isOpenAIConfigured()) return c.json({ error: 'OpenAI non configurato' }, 400);

  const newTags = await openai.generateTags(post.title as string, post.content as string, body.model || 'gpt-4o-mini');
  const mergedTags = [...new Set([...((post.tags as string[]) || []), ...newTags])];

  await sql`UPDATE blog_posts SET tags = ${mergedTags} WHERE id = ${postId}`;
  return c.json({ tags: mergedTags, newTags });
});

blog.post('/:id/generate-category', async (c) => {
  const postId = c.req.param('id');
  const body = await c.req.json<{ model?: string }>();

  const [post] = await sql`SELECT title, content FROM blog_posts WHERE id = ${postId}`;
  if (!post) return c.json({ error: 'Post non trovato' }, 404);
  if (!openai.isOpenAIConfigured()) return c.json({ error: 'OpenAI non configurato' }, 400);

  const category = await openai.generateCategory(post.title as string, post.content as string, body.model || 'gpt-4o-mini');
  await sql`UPDATE blog_posts SET category = ${category} WHERE id = ${postId}`;
  return c.json({ category });
});

// ─────────────────────────────────────────────────────────────
// Scheduled Generation
// ─────────────────────────────────────────────────────────────

blog.post('/scheduled/generate', async (c) => {
  const cronSecret = c.req.header('x-cron-secret') || c.req.query('secret');
  if (!process.env.CRON_SECRET || !cronSecret || cronSecret !== process.env.CRON_SECRET) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const [config] = await sql`SELECT * FROM blog_generation_config LIMIT 1`;
  if (!config) return c.json({ error: 'Config not found', skipped: true });
  if (!config.schedule_enabled) return c.json({ message: 'Scheduling disabled', skipped: true });

  const now = new Date();
  if (!checkSchedule(config, now)) {
    return c.json({ message: 'Not time to generate yet', skipped: true, next_run: config.schedule_next_run });
  }

  const topics = config.topics || [];
  if (topics.length === 0) return c.json({ error: 'No topics configured', skipped: true });

  const topic = (topics as string[])[Math.floor(Math.random() * topics.length)];
  const languageMap: Record<string, string> = { it: 'italiano', en: 'english', es: 'español', de: 'deutsch', fr: 'français' };
  const startTime = Date.now();

  const [log] = await sql`
    INSERT INTO blog_generation_logs ${sql({
      topic_used: topic,
      status: 'researching',
      triggered_by: 'scheduled',
      config_snapshot: config,
      started_at: new Date().toISOString(),
      research_model_used: config.perplexity_model,
    })} RETURNING *
  `;

  try {
    const research = await perplexity.research({
      topic,
      model: config.perplexity_model as perplexity.PerplexityModel,
      language: languageMap[config.language as string] || 'italiano',
      depth: ((config.research_depth as string) || 'detailed') as 'basic' | 'detailed' | 'comprehensive',
    });

    await sql`UPDATE blog_generation_logs SET ${sql({ status: 'generating', generation_model_used: config.openai_model })} WHERE id = ${log.id}`;

    const article = await openai.writeArticle({
      research,
      model: config.openai_model as string,
      writingStyle: config.writing_style as 'professional' | 'casual' | 'technical' | 'creative',
      tone: config.tone as 'informative' | 'educational' | 'conversational' | 'persuasive',
      targetWordCount: config.target_word_count as number,
      language: languageMap[config.language as string] || 'italiano',
      includeImagePlaceholders: (config.include_inline_images as boolean) && config.cover_provider !== 'none',
      maxInlineImages: (config.max_inline_images as number) || 3,
    });

    await sql`UPDATE blog_generation_logs SET ${sql({ generated_title: article.title, generated_slug: article.slug, generated_word_count: article.wordCount, generation_completed_at: new Date().toISOString() })} WHERE id = ${log.id}`;

    let coverImage: coverGenerator.CoverResult | null = null;
    if (config.cover_provider && config.cover_provider !== 'none') {
      try {
        await sql`UPDATE blog_generation_logs SET ${sql({ status: 'generating_cover', cover_provider_used: config.cover_provider })} WHERE id = ${log.id}`;
        coverImage = await coverGenerator.generateCover({ topic: article.title, provider: config.cover_provider as coverGenerator.CoverProvider, dalleModel: config.dalle_model as coverGenerator.DalleModel, zimageModel: config.zimage_model as coverGenerator.ZImageModel });
        await sql`UPDATE blog_generation_logs SET cover_url = ${coverImage.url} WHERE id = ${log.id}`;
      } catch (err) {
        console.error('[Scheduled] Cover error:', err);
      }
    }

    let finalContent = article.content;
    let inlineImages: coverGenerator.InlineImageResult[] = [];

    if (config.include_inline_images && config.cover_provider !== 'none' && article.imagePlaceholders.length > 0) {
      try {
        await sql`UPDATE blog_generation_logs SET status = 'generating_images' WHERE id = ${log.id}`;
        inlineImages = await coverGenerator.generateInlineImages({ images: article.imagePlaceholders, provider: config.cover_provider as coverGenerator.CoverProvider, dalleModel: config.dalle_model as coverGenerator.DalleModel, zimageModel: config.zimage_model as coverGenerator.ZImageModel, articleTitle: article.title });
        finalContent = coverGenerator.replaceImagePlaceholders(article.content, inlineImages);
      } catch (err) {
        console.error('[Scheduled] Inline images error:', err);
        finalContent = article.content.replace(/\[IMAGE:[^\]]+\]/g, '');
      }
    } else {
      finalContent = article.content.replace(/\[IMAGE:[^\]]+\]/g, '');
    }

    if (finalContent) finalContent = appendSourcesMd(finalContent, research.sources);
    const tags = [...new Set([...((config.default_tags as string[]) || []), ...article.tags])];
    const shouldPublish = config.schedule_auto_publish && config.schedule_publish_delay_hours === 0;

    const postData: Record<string, unknown> = {
      title: article.title,
      slug: article.slug,
      content: finalContent,
      excerpt: article.excerpt,
      tags,
      status: shouldPublish ? 'published' : 'draft',
      is_published: shouldPublish,
      published_at: shouldPublish ? now.toISOString() : null,
      reading_time: article.readingTimeMinutes,
    };

    if (coverImage?.savedToStorage && coverImage.storageKey) {
      postData.cover_image = coverImage.storageKey;
    } else if (coverImage?.url) {
      postData.cover_image = coverImage.url;
    }

    const [post] = await sql`INSERT INTO blog_posts ${sql(postData)} RETURNING *`;
    const duration = Date.now() - startTime;
    const nextRun = calculateNextRun(config, now);

    await sql`UPDATE blog_generation_logs SET ${sql({ status: 'completed', blog_post_id: post.id, completed_at: now.toISOString(), duration_ms: duration })} WHERE id = ${log.id}`;
    await sql`UPDATE blog_generation_config SET ${sql({ total_generated: (config.total_generated as number || 0) + 1, total_published: (config.total_published as number || 0) + (shouldPublish ? 1 : 0), last_run_at: now.toISOString(), schedule_last_run: now.toISOString(), schedule_next_run: nextRun.toISOString() })} WHERE id = ${config.id}`;

    return c.json({ success: true, post_id: post.id, title: article.title, duration_ms: duration, next_run: nextRun.toISOString() });
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : JSON.stringify(error) || 'Errore sconosciuto';
    await sql`UPDATE blog_generation_logs SET ${sql({ status: 'failed', error_message: errorMessage, completed_at: now.toISOString(), duration_ms: duration })} WHERE id = ${log.id}`;
    await sql`UPDATE blog_generation_config SET total_failed = ${(config.total_failed as number || 0) + 1} WHERE id = ${config.id}`;
    throw error;
  }
});

blog.post('/scheduled/publish', async (c) => {
  const cronSecret = c.req.header('x-cron-secret') || c.req.query('secret');
  if (!process.env.CRON_SECRET || !cronSecret || cronSecret !== process.env.CRON_SECRET) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const now = new Date();
  const posts = await sql`
    SELECT id, title, metadata FROM blog_posts
    WHERE is_published = false AND metadata->>'scheduled_publish_at' IS NOT NULL
  `;

  const published: string[] = [];
  for (const post of posts) {
    const scheduledAt = (post.metadata as Record<string, string>)?.scheduled_publish_at;
    if (scheduledAt && new Date(scheduledAt) <= now) {
      await sql`UPDATE blog_posts SET is_published = true, status = 'published', published_at = ${now.toISOString()} WHERE id = ${post.id}`;
      published.push(post.title as string);
    }
  }

  return c.json({ success: true, published_count: published.length, published_titles: published });
});

blog.get('/schedule', async (c) => {
  const [config] = await sql`
    SELECT schedule_enabled, schedule_frequency, schedule_time, schedule_timezone,
      schedule_days, schedule_auto_publish, schedule_publish_delay_hours,
      schedule_last_run, schedule_next_run, topics
    FROM blog_generation_config LIMIT 1
  `;

  if (!config) return c.json({ schedule: null });

  return c.json({
    schedule: {
      enabled: config.schedule_enabled,
      frequency: config.schedule_frequency,
      time: config.schedule_time,
      timezone: config.schedule_timezone,
      days: config.schedule_days,
      auto_publish: config.schedule_auto_publish,
      publish_delay_hours: config.schedule_publish_delay_hours,
      last_run: config.schedule_last_run,
      next_run: config.schedule_next_run,
      topics_count: ((config.topics as string[]) || []).length,
    },
  });
});

// ─────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────

function checkSchedule(config: Record<string, unknown>, now: Date): boolean {
  if (!config.schedule_enabled) return false;
  if (!config.schedule_next_run) return true;
  return now >= new Date(config.schedule_next_run as string);
}

function calculateNextRun(config: Record<string, unknown>, fromDate: Date): Date {
  const [hours, minutes] = ((config.schedule_time as string) || '09:00').split(':').map(Number);
  const next = new Date(fromDate);
  next.setHours(hours, minutes, 0, 0);
  if (next <= fromDate) next.setDate(next.getDate() + 1);

  const frequency = (config.schedule_frequency as string) || 'weekly';
  const days = (config.schedule_days as number[]) || [1, 3, 5];

  switch (frequency) {
    case 'every_2_days': next.setDate(next.getDate() + 1); break;
    case 'every_3_days': next.setDate(next.getDate() + 2); break;
    case 'weekly': while (!days.includes(next.getDay())) next.setDate(next.getDate() + 1); break;
    case 'biweekly': next.setDate(next.getDate() + 14); break;
    case 'monthly': next.setMonth(next.getMonth() + 1); next.setDate(1); break;
  }

  return next;
}

// ─────────────────────────────────────────────────────────────
// Serve interactive code demos (iframe src)
// ─────────────────────────────────────────────────────────────

blog.get('/demos/:postId/:index', async (c) => {
  const postId = c.req.param('postId');
  const index = parseInt(c.req.param('index'));

  const [post] = await sql`SELECT demos FROM blog_posts WHERE id = ${postId}`;
  if (!post) return c.text('Post non trovato', 404);

  const demos: string[] = typeof post.demos === 'string' ? JSON.parse(post.demos) : (post.demos || []);
  if (index < 0 || index >= demos.length) return c.text('Demo non trovata', 404);

  return c.html(demos[index]);
});
