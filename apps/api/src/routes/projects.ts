import { Hono } from 'hono';
import { sql } from '../db';
import * as openai from '../lib/ai/openai';

type Env = { Variables: { user: { id: string; email?: string } } };

export const projects = new Hono<Env>();

// ========== LIST ==========

projects.get('/', async (c) => {
  const publishedFilter = c.req.query('published');
  const featuredFilter = c.req.query('featured');

  const pubClause = publishedFilter !== undefined
    ? sql`AND is_published = ${publishedFilter === 'true'}`
    : sql``;
  const featClause = featuredFilter !== undefined
    ? sql`AND is_featured = ${featuredFilter === 'true'}`
    : sql``;

  const rows = await sql`
    SELECT * FROM projects
    WHERE 1=1 ${pubClause} ${featClause}
    ORDER BY display_order ASC, created_at DESC
  `;

  return c.json({ projects: rows });
});

// ========== GET ONE ==========

projects.get('/:id', async (c) => {
  const id = c.req.param('id');

  const [project] = await sql`SELECT * FROM projects WHERE id = ${id}`;
  if (!project) return c.json({ error: 'Progetto non trovato' }, 404);

  return c.json({ project });
});

// ========== CREATE ==========

projects.post('/', async (c) => {
  const body = await c.req.json();

  const {
    title,
    slug,
    description,
    brief, // Migration 090 — body unico case study (sostituisce content/challenge/solution)
    cover_image,
    cover_alt, // Migration 092
    live_url,
    repo_url,
    technologies,
    is_published,
    is_featured,
    client,
    services,
    industries,
    feedback,
    gallery,
    // Migration 075 — case study extension
    year,
    tags,
    metrics,
    outcome,
    seo_title,
    seo_description,
  } = body;

  if (!title || !slug) {
    return c.json({ error: 'title e slug sono obbligatori' }, 400);
  }

  // Get next display_order
  const [{ max_order }] = await sql`SELECT COALESCE(MAX(display_order), -1) AS max_order FROM projects`;

  const [project] = await sql`
    INSERT INTO projects ${sql({
      title,
      slug,
      description: description || null,
      brief: brief || null,
      cover_image: cover_image || null,
      cover_alt: cover_alt || null,
      live_url: live_url || null,
      repo_url: repo_url || null,
      technologies: technologies || [],
      is_published: is_published ?? false,
      is_featured: is_featured ?? false,
      client: client || null,
      services: services || null,
      industries: industries || null,
      feedback: feedback || null,
      gallery: gallery || null,
      // Migration 075
      year: year ?? null,
      tags: tags || [],
      metrics: metrics || null,
      outcome: outcome || null,
      seo_title: seo_title || null,
      seo_description: seo_description || null,
      display_order: (max_order as number) + 1,
    })}
    RETURNING *
  `;

  return c.json({ project }, 201);
});

// ========== UPDATE ==========

projects.put('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();

  const [existing] = await sql`SELECT id FROM projects WHERE id = ${id}`;
  if (!existing) return c.json({ error: 'Progetto non trovato' }, 404);

  const {
    title,
    slug,
    description,
    brief, // Migration 090
    cover_image,
    cover_alt, // Migration 092
    live_url,
    repo_url,
    technologies,
    is_published,
    is_featured,
    client,
    services,
    industries,
    feedback,
    gallery,
    display_order,
    // Migration 075 — case study extension
    year,
    tags,
    metrics,
    outcome,
    seo_title,
    seo_description,
  } = body;

  const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (title !== undefined) updateData.title = title;
  if (slug !== undefined) updateData.slug = slug;
  if (description !== undefined) updateData.description = description || null;
  if (brief !== undefined) updateData.brief = brief || null;
  if (cover_image !== undefined) updateData.cover_image = cover_image || null;
  if (cover_alt !== undefined) updateData.cover_alt = cover_alt || null;
  if (live_url !== undefined) updateData.live_url = live_url || null;
  if (repo_url !== undefined) updateData.repo_url = repo_url || null;
  if (technologies !== undefined) updateData.technologies = technologies;
  if (is_published !== undefined) updateData.is_published = is_published;
  if (is_featured !== undefined) updateData.is_featured = is_featured;
  if (client !== undefined) updateData.client = client || null;
  if (services !== undefined) updateData.services = services || null;
  if (industries !== undefined) updateData.industries = industries || null;
  if (feedback !== undefined) updateData.feedback = feedback || null;
  if (gallery !== undefined) updateData.gallery = gallery || null;
  if (display_order !== undefined) updateData.display_order = display_order;
  // Migration 075
  if (year !== undefined) updateData.year = year ?? null;
  if (tags !== undefined) updateData.tags = tags || [];
  if (metrics !== undefined) updateData.metrics = metrics || null;
  if (outcome !== undefined) updateData.outcome = outcome || null;
  if (seo_title !== undefined) updateData.seo_title = seo_title || null;
  if (seo_description !== undefined) updateData.seo_description = seo_description || null;

  const [project] = await sql`
    UPDATE projects SET ${sql(updateData)} WHERE id = ${id} RETURNING *
  `;

  return c.json({ project });
});

// ========== TOGGLE PUBLISH ==========

projects.patch('/:id/publish', async (c) => {
  const id = c.req.param('id');
  const [existing] = await sql`SELECT id, is_published FROM projects WHERE id = ${id}`;
  if (!existing) return c.json({ error: 'Progetto non trovato' }, 404);

  const [project] = await sql`
    UPDATE projects SET is_published = ${!existing.is_published}, updated_at = NOW()
    WHERE id = ${id} RETURNING *
  `;

  return c.json({ project });
});

// ========== REORDER ==========

projects.patch('/reorder', async (c) => {
  const { items } = await c.req.json<{ items: Array<{ id: string; display_order: number }> }>();
  if (!Array.isArray(items)) return c.json({ error: 'items array richiesto' }, 400);

  await Promise.all(
    items.map(({ id, display_order }) =>
      sql`UPDATE projects SET display_order = ${display_order} WHERE id = ${id}`
    )
  );

  return c.json({ success: true });
});

// ========== DELETE ==========

projects.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const [existing] = await sql`SELECT id FROM projects WHERE id = ${id}`;
  if (!existing) return c.json({ error: 'Progetto non trovato' }, 404);

  await sql`DELETE FROM projects WHERE id = ${id}`;

  return c.json({ success: true });
});

// ========== TRANSLATIONS (i18n F3) ==========

const TRANSLATABLE_PROJECT_FIELDS = [
  'title',
  'description',
  'brief', // Migration 090 — sostituisce `content` come campo traducibile del body
  'outcome',
  'seo_title',
  'seo_description',
] as const;
type TranslatableProjectField = (typeof TRANSLATABLE_PROJECT_FIELDS)[number];

const SUPPORTED_LOCALES = ['it', 'en'] as const;
type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

function isSupportedLocale(v: string): v is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(v);
}
function isTranslatableField(v: string): v is TranslatableProjectField {
  return (TRANSLATABLE_PROJECT_FIELDS as readonly string[]).includes(v);
}

/** GET /api/projects/:id/translations — admin: list translations grouped by locale. */
projects.get('/:id/translations', async (c) => {
  const id = c.req.param('id');
  const [exists] = await sql`SELECT id FROM projects WHERE id = ${id}`;
  if (!exists) return c.json({ error: 'Progetto non trovato' }, 404);

  const rows = await sql`
    SELECT locale, field_name, field_value, updated_at
    FROM projects_translations
    WHERE project_id = ${id}
    ORDER BY locale, field_name
  `;

  // Group: { it: { title, description, ... }, en: { title, ... } }
  const grouped: Record<string, Record<string, string>> = {};
  for (const r of rows) {
    const loc = String(r.locale);
    if (!grouped[loc]) grouped[loc] = {};
    grouped[loc][String(r.field_name)] = String(r.field_value);
  }

  return c.json({ project_id: id, translations: grouped });
});

/**
 * PATCH /api/projects/:id/translations/:locale
 * Body: { title?, description?, content?, outcome?, seo_title?, seo_description? }
 * Upsert delle traduzioni per il locale specifico. Solo i campi presenti nel
 * body vengono aggiornati; gli altri restano invariati. Per cancellare una
 * traduzione, passa `null` o stringa vuota.
 */
projects.patch('/:id/translations/:locale', async (c) => {
  const id = c.req.param('id');
  const locale = c.req.param('locale');

  if (!isSupportedLocale(locale)) {
    return c.json({ error: 'Locale non supportato (it|en)' }, 400);
  }

  const [exists] = await sql`SELECT id FROM projects WHERE id = ${id}`;
  if (!exists) return c.json({ error: 'Progetto non trovato' }, 404);

  const body = await c.req.json<Partial<Record<TranslatableProjectField, string | null>>>();
  const upserted: string[] = [];
  const deleted: string[] = [];

  for (const [field, value] of Object.entries(body)) {
    if (!isTranslatableField(field)) continue;

    if (value === null || value === '') {
      // Delete translation row (cade su fallback IT canonical)
      await sql`
        DELETE FROM projects_translations
        WHERE project_id = ${id} AND locale = ${locale} AND field_name = ${field}
      `;
      deleted.push(field);
    } else {
      await sql`
        INSERT INTO projects_translations (project_id, locale, field_name, field_value)
        VALUES (${id}, ${locale}, ${field}, ${value})
        ON CONFLICT (project_id, locale, field_name)
        DO UPDATE SET field_value = EXCLUDED.field_value, updated_at = NOW()
      `;
      upserted.push(field);
    }
  }

  return c.json({ project_id: id, locale, upserted, deleted });
});

// ─────────────────────────────────────────────────────────────
// AI logs helper (Migration 093 — project_ai_logs)
// Fire-and-forget: never block the response on logging.
// ─────────────────────────────────────────────────────────────
const DEFAULT_MODEL = 'gpt-4o-mini';

async function logAiCall(entry: {
  project_id: string;
  kind: 'translate' | 'seo';
  model: string;
  status: 'ok' | 'error';
  error_message?: string | null;
  duration_ms: number;
  input_chars: number;
  output_chars: number;
}): Promise<void> {
  try {
    await sql`
      INSERT INTO project_ai_logs ${sql({
        project_id: entry.project_id,
        kind: entry.kind,
        model: entry.model,
        status: entry.status,
        error_message: entry.error_message ?? null,
        duration_ms: entry.duration_ms,
        input_chars: entry.input_chars,
        output_chars: entry.output_chars,
      })}
    `;
  } catch (err) {
    // Audit log failure must never break the user-facing flow.
    console.error('[project_ai_logs] insert failed:', err);
  }
}

// ========== AI: translate IT → EN ==========
//
// POST /api/projects/:id/ai/translate
//   Body: { model?: string }
//   Returns: { en: { title?, description?, brief?, outcome?, seo_title?, seo_description? } }
//
// Pulls IT canonical from the projects row (not from projects_translations
// for IT — IT lives in the base columns by convention).
projects.post('/:id/ai/translate', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ model?: string }>().catch(() => ({} as { model?: string }));

  const [project] = await sql`
    SELECT title, description, brief, outcome, seo_title, seo_description
    FROM projects WHERE id = ${id}
  `;
  if (!project) return c.json({ error: 'Progetto non trovato' }, 404);
  if (!openai.isOpenAIConfigured()) {
    return c.json({ error: 'OpenAI non configurato (OPENAI_API_KEY mancante)' }, 400);
  }

  const model = body.model ?? DEFAULT_MODEL;
  const itFields = {
    title: (project.title as string | null) ?? undefined,
    description: (project.description as string | null) ?? undefined,
    brief: (project.brief as string | null) ?? undefined,
    outcome: (project.outcome as string | null) ?? undefined,
    seo_title: (project.seo_title as string | null) ?? undefined,
    seo_description: (project.seo_description as string | null) ?? undefined,
  };
  const inputChars = Object.values(itFields)
    .filter((v): v is string => typeof v === 'string')
    .reduce((sum, v) => sum + v.length, 0);

  const startedAt = Date.now();
  try {
    const en = await openai.translateProjectFieldsToEN(itFields, model);
    const outputChars = Object.values(en)
      .filter((v): v is string => typeof v === 'string')
      .reduce((sum, v) => sum + v.length, 0);
    await logAiCall({
      project_id: id,
      kind: 'translate',
      model,
      status: 'ok',
      duration_ms: Date.now() - startedAt,
      input_chars: inputChars,
      output_chars: outputChars,
    });
    return c.json({ en });
  } catch (err) {
    await logAiCall({
      project_id: id,
      kind: 'translate',
      model,
      status: 'error',
      error_message: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - startedAt,
      input_chars: inputChars,
      output_chars: 0,
    });
    throw err;
  }
});

// ========== AI: SEO suggestions ==========
//
// POST /api/projects/:id/ai/seo
//   Body: { model?: string }
//   Returns: { seo_title: string, seo_description: string }
projects.post('/:id/ai/seo', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ model?: string }>().catch(() => ({} as { model?: string }));

  const [project] = await sql`
    SELECT title, description, brief, client, services
    FROM projects WHERE id = ${id}
  `;
  if (!project) return c.json({ error: 'Progetto non trovato' }, 404);
  if (!openai.isOpenAIConfigured()) {
    return c.json({ error: 'OpenAI non configurato (OPENAI_API_KEY mancante)' }, 400);
  }

  const model = body.model ?? DEFAULT_MODEL;
  const args = {
    title: project.title as string,
    description: (project.description as string | null) ?? undefined,
    brief: (project.brief as string | null) ?? undefined,
    client: (project.client as string | null) ?? undefined,
    services: (project.services as string | null) ?? undefined,
  };
  const inputChars = Object.values(args)
    .filter((v): v is string => typeof v === 'string')
    .reduce((sum, v) => sum + v.length, 0);

  const startedAt = Date.now();
  try {
    const suggestions = await openai.generateProjectSEOSuggestions(args, model);
    await logAiCall({
      project_id: id,
      kind: 'seo',
      model,
      status: 'ok',
      duration_ms: Date.now() - startedAt,
      input_chars: inputChars,
      output_chars: suggestions.seo_title.length + suggestions.seo_description.length,
    });
    return c.json(suggestions);
  } catch (err) {
    await logAiCall({
      project_id: id,
      kind: 'seo',
      model,
      status: 'error',
      error_message: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - startedAt,
      input_chars: inputChars,
      output_chars: 0,
    });
    throw err;
  }
});
