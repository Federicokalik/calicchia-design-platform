import { Hono } from 'hono';
import { sql } from '../db';
import { sanitizeBlogHtml } from '../lib/html-sanitize';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'public' });

export const publicRoutes = new Hono();

const API_URL = process.env.API_URL || 'http://localhost:3001';

function resolveImageUrl(key: string | null): string | null {
  if (!key) return null;
  if (key.startsWith('http://') || key.startsWith('https://')) return key;
  return `${API_URL}/media/${key}`;
}

// ─────────────────────────────────────────────────────────────
// Validation helpers
// ─────────────────────────────────────────────────────────────

function validateSlug(slug: string): boolean {
  return /^[a-z0-9-]{1,200}$/.test(slug);
}

function parseLimit(raw: string | undefined, defaultVal: number, max: number): number {
  const n = parseInt(raw ?? String(defaultVal), 10);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : defaultVal;
}

const SUPPORTED_LOCALES = ['it', 'en'] as const;
type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * Valida il param `?locale=` query. Default 'it' se missing/invalid.
 * Pattern: i18n via tabelle `*_translations` con backfill IT come canonical.
 * Se la traduzione richiesta manca, l'endpoint cade su colonna legacy (IT).
 */
function parseLocale(raw: string | undefined): SupportedLocale {
  if (!raw) return 'it';
  return SUPPORTED_LOCALES.includes(raw as SupportedLocale) ? (raw as SupportedLocale) : 'it';
}

// ─────────────────────────────────────────────────────────────
// GET /api/public/blog/posts?limit=N
// ─────────────────────────────────────────────────────────────

publicRoutes.get('/blog/posts', async (c) => {
  const limit = parseLimit(c.req.query('limit'), 10, 100);
  const locale = parseLocale(c.req.query('locale'));

  // i18n: LEFT JOIN su blog_posts_translations con fallback su colonne legacy.
  // Se la row translation per (post, locale, field) manca → COALESCE cade su
  // colonna canonical IT.
  const posts = await sql`
    SELECT
      bp.slug,
      COALESCE(t_title.field_value, bp.title) AS title,
      COALESCE(t_excerpt.field_value, bp.excerpt) AS excerpt,
      bp.cover_image, bp.tags, bp.category, bp.published_at, bp.created_at,
      (t_title.field_value IS NOT NULL OR ${locale} = 'it') AS title_translated
    FROM blog_posts bp
    LEFT JOIN blog_posts_translations t_title
      ON t_title.post_id = bp.id AND t_title.locale = ${locale} AND t_title.field_name = 'title'
    LEFT JOIN blog_posts_translations t_excerpt
      ON t_excerpt.post_id = bp.id AND t_excerpt.locale = ${locale} AND t_excerpt.field_name = 'excerpt'
    WHERE bp.is_published = true
    ORDER BY bp.published_at DESC
    LIMIT ${limit}
  `;

  return c.json({
    locale,
    posts: posts.map((p) => ({
      slug: p.slug,
      title: p.title,
      excerpt: p.excerpt,
      cover_image: resolveImageUrl(p.cover_image as string | null),
      tags: p.tags || [],
      category: p.category,
      published_at: p.published_at,
      created_at: p.created_at,
    })),
  });
});

// ─────────────────────────────────────────────────────────────
// GET /api/public/blog/posts/:slug
// ─────────────────────────────────────────────────────────────

publicRoutes.get('/blog/posts/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!validateSlug(slug)) return c.json({ error: 'Not Found' }, 404);
  const locale = parseLocale(c.req.query('locale'));

  // i18n: JOIN su translations per i 3 campi traducibili (title, excerpt, content).
  // Se row translation manca → COALESCE su colonna legacy IT.
  const rows = await sql`
    SELECT
      bp.*,
      p.full_name,
      p.avatar_url,
      p.role_title,
      p.bio,
      p.socials,
      COALESCE(t_title.field_value, bp.title) AS i18n_title,
      COALESCE(t_excerpt.field_value, bp.excerpt) AS i18n_excerpt,
      COALESCE(t_content.field_value, bp.content) AS i18n_content
    FROM blog_posts bp
    LEFT JOIN profiles p ON bp.author_id = p.id
    LEFT JOIN blog_posts_translations t_title
      ON t_title.post_id = bp.id AND t_title.locale = ${locale} AND t_title.field_name = 'title'
    LEFT JOIN blog_posts_translations t_excerpt
      ON t_excerpt.post_id = bp.id AND t_excerpt.locale = ${locale} AND t_excerpt.field_name = 'excerpt'
    LEFT JOIN blog_posts_translations t_content
      ON t_content.post_id = bp.id AND t_content.locale = ${locale} AND t_content.field_name = 'content'
    WHERE bp.slug = ${slug} AND bp.is_published = true
  `;

  if (!rows.length) return c.json({ error: 'Not Found' }, 404);
  const post = rows[0];
  // Override con valori i18n risolti (precedenza: translation IT/EN > legacy column)
  post.title = post.i18n_title;
  post.excerpt = post.i18n_excerpt;
  post.content = post.i18n_content;

  // Increment views (fire-and-forget). Column is `views_count` per mig 001 —
  // the previous `views` reference silently failed in the .catch() and the
  // counter never moved (audit C-016).
  sql`UPDATE blog_posts SET views_count = COALESCE(views_count, 0) + 1 WHERE slug = ${slug}`.catch(
    (err: unknown) => log.error({ err }, 'Failed to increment views_count'),
  );

  // Get prev/next navigation
  const allPosts = await sql`
    SELECT slug, title, published_at, created_at
    FROM blog_posts
    WHERE is_published = true
    ORDER BY published_at DESC
  `;

  let prevSlug: string | null = null;
  let nextSlug: string | null = null;
  let prevTitle: string | null = null;
  let nextTitle: string | null = null;
  let prevPublishedAt: string | null = null;
  let nextPublishedAt: string | null = null;

  const idx = allPosts.findIndex((p) => p.slug === slug);
  if (idx > 0) {
    const prev = allPosts[idx - 1];
    nextSlug = prev.slug as string;
    nextTitle = prev.title as string;
    nextPublishedAt = (prev.published_at || prev.created_at) as string;
  }
  if (idx >= 0 && idx < allPosts.length - 1) {
    const next = allPosts[idx + 1];
    prevSlug = next.slug as string;
    prevTitle = next.title as string;
    prevPublishedAt = (next.published_at || next.created_at) as string;
  }

  return c.json({
    locale,
    post: {
      // id surfaced so sito-v3 BlogDemoIslands can build /api/public/blog-demos/<id>/<idx>.
      id: post.id,
      slug: post.slug,
      title: post.title,
      excerpt: post.excerpt,
      cover_image: resolveImageUrl(post.cover_image as string | null),
      tags: post.tags || [],
      category: post.category,
      content: sanitizeBlogHtml(post.content as string | null),
      published_at: post.published_at,
      created_at: post.created_at,
      reading_time: post.reading_time,
      allow_comments: post.allow_comments,
      views: post.views_count,
      prevSlug,
      nextSlug,
      prevTitle,
      nextTitle,
      prevPublishedAt,
      nextPublishedAt,
    },
    author: {
      full_name: post.full_name,
      avatar_url: post.avatar_url,
      role_title: post.role_title,
      bio: post.bio,
      socials: post.socials,
    },
  });
});

// ─────────────────────────────────────────────────────────────
// GET /api/public/projects
// ─────────────────────────────────────────────────────────────

publicRoutes.get('/projects', async (c) => {
  // Optional ?service=<slug> filter — admin enters free text like
  // "Web Design, E-commerce, SEO". Audit C-017: the old ILIKE substring match
  // over-matched ("seo" ⊂ "seo-onpage", "seokit") and under-matched ("webdesign"
  // without hyphen). Tokenize on `,`, slug-normalize each token (lowercase +
  // space→hyphen + strip noise), and require an EXACT match against ANY token.
  // Schema-clean fix (a project_services junction table) is deferred — this
  // stopgap removes the false-positive/negative noise without a migration.
  // Optional ?limit=N (default 50, max 50).
  // Optional ?locale=it|en — i18n via projects_translations.
  const serviceFilter = c.req.query('service');
  const limit = parseLimit(c.req.query('limit'), 50, 50);
  const locale = parseLocale(c.req.query('locale'));

  const validatedServiceSlug =
    serviceFilter && /^[a-z0-9-]{1,60}$/.test(serviceFilter) ? serviceFilter : null;
  // Postgres: split the normalised services column on `,`, trim each token,
  // and check the slug against the resulting array. ANY(...) handles the
  // exact-token semantics.
  const serviceClause = validatedServiceSlug
    ? sql`AND ${validatedServiceSlug} = ANY(
            SELECT trim(BOTH '-' FROM regexp_replace(
              LOWER(REPLACE(token, ' ', '-')), '[^a-z0-9-]', '', 'g'
            ))
            FROM unnest(string_to_array(COALESCE(p.services, ''), ',')) AS token
          )`
    : sql``;

  const projects = await sql`
    SELECT
      p.slug,
      COALESCE(t_title.field_value, p.title) AS title,
      COALESCE(t_description.field_value, p.description) AS description,
      p.cover_image, p.cover_alt, p.technologies, p.tags, p.year, p.client, p.industries
    FROM projects p
    LEFT JOIN projects_translations t_title
      ON t_title.project_id = p.id AND t_title.locale = ${locale} AND t_title.field_name = 'title'
    LEFT JOIN projects_translations t_description
      ON t_description.project_id = p.id AND t_description.locale = ${locale} AND t_description.field_name = 'description'
    WHERE p.is_published = true ${serviceClause}
    ORDER BY p.display_order ASC
    LIMIT ${limit}
  `;

  return c.json({
    locale,
    projects: projects.map((p) => ({
      slug: p.slug,
      title: p.title,
      description: p.description,
      cover_image: resolveImageUrl(p.cover_image as string | null),
      cover_alt: p.cover_alt as string | null,
      tags: (p.tags && (p.tags as string[]).length > 0)
        ? (p.tags as string[])
        : (p.technologies || []),
      year: p.year,
      client: p.client,
      industries: p.industries,
    })),
  });
});

// ─────────────────────────────────────────────────────────────
// GET /api/public/projects/:slug
// ─────────────────────────────────────────────────────────────

publicRoutes.get('/projects/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!validateSlug(slug)) return c.json({ error: 'Not Found' }, 404);
  const locale = parseLocale(c.req.query('locale'));

  // i18n: JOIN su translations per i 6 campi traducibili
  // (title, description, brief, outcome, seo_title, seo_description).
  // Migration 090: `content`/`challenge`/`solution` consolidati in `brief`.
  const rows = await sql`
    SELECT
      p.*,
      COALESCE(t_title.field_value, p.title) AS i18n_title,
      COALESCE(t_description.field_value, p.description) AS i18n_description,
      COALESCE(t_brief.field_value, p.brief) AS i18n_brief,
      COALESCE(t_outcome.field_value, p.outcome) AS i18n_outcome,
      COALESCE(t_seo_title.field_value, p.seo_title) AS i18n_seo_title,
      COALESCE(t_seo_desc.field_value, p.seo_description) AS i18n_seo_description
    FROM projects p
    LEFT JOIN projects_translations t_title
      ON t_title.project_id = p.id AND t_title.locale = ${locale} AND t_title.field_name = 'title'
    LEFT JOIN projects_translations t_description
      ON t_description.project_id = p.id AND t_description.locale = ${locale} AND t_description.field_name = 'description'
    LEFT JOIN projects_translations t_brief
      ON t_brief.project_id = p.id AND t_brief.locale = ${locale} AND t_brief.field_name = 'brief'
    LEFT JOIN projects_translations t_outcome
      ON t_outcome.project_id = p.id AND t_outcome.locale = ${locale} AND t_outcome.field_name = 'outcome'
    LEFT JOIN projects_translations t_seo_title
      ON t_seo_title.project_id = p.id AND t_seo_title.locale = ${locale} AND t_seo_title.field_name = 'seo_title'
    LEFT JOIN projects_translations t_seo_desc
      ON t_seo_desc.project_id = p.id AND t_seo_desc.locale = ${locale} AND t_seo_desc.field_name = 'seo_description'
    WHERE p.slug = ${slug} AND p.is_published = true
  `;

  if (!rows.length) return c.json({ error: 'Not Found' }, 404);
  const project = rows[0];
  // Override con i18n risolti (translation > legacy IT column)
  project.title = project.i18n_title;
  project.description = project.i18n_description;
  project.brief = project.i18n_brief;
  project.outcome = project.i18n_outcome;
  project.seo_title = project.i18n_seo_title;
  project.seo_description = project.i18n_seo_description;

  // Get all published projects for prev/next (circular)
  const allProjects = await sql`
    SELECT slug, title FROM projects WHERE is_published = true ORDER BY display_order ASC
  `;

  let prevSlug: string | null = null;
  let nextSlug: string | null = null;
  let prevTitle: string | null = null;
  let nextTitle: string | null = null;

  if (allProjects.length > 1) {
    const idx = allProjects.findIndex((p) => p.slug === slug);
    if (idx !== -1) {
      const prevIdx = idx === 0 ? allProjects.length - 1 : idx - 1;
      const nextIdx = idx === allProjects.length - 1 ? 0 : idx + 1;
      prevSlug = allProjects[prevIdx].slug as string;
      prevTitle = allProjects[prevIdx].title as string;
      nextSlug = allProjects[nextIdx].slug as string;
      nextTitle = allProjects[nextIdx].title as string;
    }
  }

  return c.json({
    locale,
    project: {
      slug: project.slug,
      title: project.title,
      description: project.description,
      brief: project.brief, // Migration 090 — single source per body case study
      client: project.client,
      services: project.services,
      industries: project.industries,
      cover_image: resolveImageUrl(project.cover_image as string | null),
      cover_alt: (project.cover_alt as string | null) ?? null,
      gallery: Array.isArray(project.gallery) ? project.gallery : [],
      technologies: project.technologies || [],
      feedback: project.feedback,
      // Migration 075 — case study extension
      year: project.year,
      tags: project.tags || [],
      metrics: Array.isArray(project.metrics) ? project.metrics : [],
      outcome: project.outcome,
      seo_title: project.seo_title,
      seo_description: project.seo_description,
      live_url: project.live_url,
      published_at: project.published_at,
      created_at: project.created_at,
    },
    prev: prevSlug ? { slug: prevSlug, title: prevTitle } : null,
    next: nextSlug ? { slug: nextSlug, title: nextTitle } : null,
  });
});

// ─────────────────────────────────────────────────────────────
// GET /api/public/blog/rss?limit=50
// ─────────────────────────────────────────────────────────────

publicRoutes.get('/blog/rss', async (c) => {
  const limit = parseLimit(c.req.query('limit'), 50, 100);

  const posts = await sql`
    SELECT id, title, slug, excerpt, content, cover_image, published_at, created_at, tags
    FROM blog_posts
    WHERE is_published = true
    ORDER BY published_at DESC
    LIMIT ${limit}
  `;

  return c.json({
    posts: posts.map((p) => ({
      id: p.id,
      title: p.title,
      slug: p.slug,
      excerpt: p.excerpt,
      content: p.content,
      cover_image: resolveImageUrl(p.cover_image as string | null),
      published_at: p.published_at,
      created_at: p.created_at,
      tags: p.tags || [],
    })),
  });
});

// ─────────────────────────────────────────────────────────────
// Public blog demo iframe src (audit C-002): the legacy mount was inside
// /api/blog/* which is in protectedPaths → every iframe loaded by an anonymous
// visitor 401'd. Surfaced here under the public namespace; the iframe attr is
// generated client-side in sito-v3 BlogDemoIslands. UUID postId guard +
// generic 404 on miss to avoid enumerating which post ids exist.
// ─────────────────────────────────────────────────────────────
publicRoutes.get('/blog-demos/:postId/:index', async (c) => {
  const postId = c.req.param('postId');
  const indexParam = c.req.param('index');
  if (!/^[a-f0-9-]{36}$/i.test(postId)) return c.text('Not Found', 404);
  const index = Number.parseInt(indexParam, 10);
  if (!Number.isInteger(index) || index < 0 || index > 50) return c.text('Not Found', 404);

  const [post] = (await sql`
    SELECT demos FROM blog_posts WHERE id = ${postId} AND is_published = true
  `) as Array<{ demos: string | string[] | null }>;
  if (!post) return c.text('Not Found', 404);

  const demos: string[] = typeof post.demos === 'string'
    ? JSON.parse(post.demos || '[]')
    : (post.demos || []);
  if (index >= demos.length) return c.text('Not Found', 404);

  // Sandbox the iframe content — demos are admin-authored HTML+inline JS but
  // the response is served on the API origin and embedded as third-party iframe
  // from sito-v3, so X-Frame-Options/CSP must not block it. Frame-ancestors set
  // to the canonical public origins.
  const siteOrigin = process.env.SITE_URL ?? 'https://calicchia.design';
  c.header('X-Frame-Options', 'ALLOW-FROM ' + siteOrigin); // legacy IE/Safari
  c.header(
    'Content-Security-Policy',
    `frame-ancestors 'self' ${siteOrigin} http://localhost:3000`,
  );
  return c.html(demos[index]);
});
