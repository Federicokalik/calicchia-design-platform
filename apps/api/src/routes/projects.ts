import { Hono } from 'hono';
import { sql } from '../db';

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
    content,
    excerpt,
    cover_image,
    live_url,
    repo_url,
    technologies,
    is_published,
    is_featured,
    client,
    services,
    industries,
    challenge,
    challenge_images,
    solution,
    solution_image,
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
      content: content || null,
      excerpt: excerpt || null,
      cover_image: cover_image || null,
      live_url: live_url || null,
      repo_url: repo_url || null,
      technologies: technologies || [],
      is_published: is_published ?? false,
      is_featured: is_featured ?? false,
      client: client || null,
      services: services || null,
      industries: industries || null,
      challenge: challenge || null,
      challenge_images: challenge_images || null,
      solution: solution || null,
      solution_image: solution_image || null,
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
    content,
    excerpt,
    cover_image,
    live_url,
    repo_url,
    technologies,
    is_published,
    is_featured,
    client,
    services,
    industries,
    challenge,
    challenge_images,
    solution,
    solution_image,
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
  if (content !== undefined) updateData.content = content || null;
  if (excerpt !== undefined) updateData.excerpt = excerpt || null;
  if (cover_image !== undefined) updateData.cover_image = cover_image || null;
  if (live_url !== undefined) updateData.live_url = live_url || null;
  if (repo_url !== undefined) updateData.repo_url = repo_url || null;
  if (technologies !== undefined) updateData.technologies = technologies;
  if (is_published !== undefined) updateData.is_published = is_published;
  if (is_featured !== undefined) updateData.is_featured = is_featured;
  if (client !== undefined) updateData.client = client || null;
  if (services !== undefined) updateData.services = services || null;
  if (industries !== undefined) updateData.industries = industries || null;
  if (challenge !== undefined) updateData.challenge = challenge || null;
  if (challenge_images !== undefined) updateData.challenge_images = challenge_images || null;
  if (solution !== undefined) updateData.solution = solution || null;
  if (solution_image !== undefined) updateData.solution_image = solution_image || null;
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
  'content',
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
