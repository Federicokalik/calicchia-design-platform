/**
 * Markdown mirror unico per il sito (`/<path>.md`).
 *
 * Routing: i rewrites in `next.config.ts` mappano ogni `/<path>.md` (e `/.md`
 * per la home) a `/md/<path>`. Questo handler ricostruisce locale + path
 * IT-canonical, decide la "sorgente" (CMS via API o sintetico-da-metadata) e
 * restituisce `text/markdown; charset=utf-8`.
 *
 * NB cartella `md/` senza underscore: in Next.js App Router le cartelle che
 * iniziano con `_` sono "private folders" e NON vengono routate — un handler
 * in `app/_md/` non sarebbe mai raggiungibile (404 silenzioso anche col
 * rewrite). Errore individuato in produzione, fix nel commit di rinomina.
 *
 * Header X-Robots-Tag: noindex — il mirror è per LLM, non deve competere con
 * la pagina HTML nei risultati di ricerca Google. Cache pubblica 5min edge.
 *
 * Per CMS-driven (blog, projects): genera un markdown con front-matter +
 * titolo + excerpt + canonical. Niente conversione HTML→Markdown lossy: il
 * content body sta nella pagina HTML, qui esponiamo metadata + link.
 *
 * Per pagine statiche (home, contatti, servizi, perché, pillar, glossari):
 * markdown sintetico con title, description, canonical, link interni.
 */
import { NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchBlogArticle, buildBlogUrl } from '@/lib/blog-api';
import { fetchProjectBySlug } from '@/lib/projects-api';
import { SITE } from '@/data/site';
import {
  LOCALES,
  type Locale,
  DEFAULT_LOCALE,
  PATH_SEGMENTS_EN_TO_IT,
} from '@/lib/i18n';
import { buildCanonical } from '@/lib/canonical';
import { STATIC_PAGES } from '@/content/static-md-pages';

interface Params {
  slug?: string[];
}

const HEADERS = {
  'Content-Type': 'text/markdown; charset=utf-8',
  'X-Robots-Tag': 'noindex',
  'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
} as const;

function notFoundMd(reason: string): NextResponse {
  return new NextResponse(
    `# 404 — ${reason}\n\nThe requested Markdown mirror was not found.\nIndex of pages: ${SITE.url}/llms.txt\n`,
    { status: 404, headers: HEADERS },
  );
}

/** Parses `/_md/<path>` slug array into { locale, itCanonicalPath, segments }. */
function parseSlug(slug: string[] | undefined): {
  locale: Locale;
  itPath: string;
  segments: string[];
} {
  const arr = slug ?? [];
  let locale: Locale = DEFAULT_LOCALE;
  let parts = arr;
  if (arr.length > 0 && (LOCALES as readonly string[]).includes(arr[0])) {
    locale = arr[0] as Locale;
    parts = arr.slice(1);
  }
  // Denormalize EN segments to IT canonical (works→lavori, services→servizi, etc.)
  if (parts.length > 0 && parts[0] in PATH_SEGMENTS_EN_TO_IT) {
    parts = [PATH_SEGMENTS_EN_TO_IT[parts[0]], ...parts.slice(1)];
  }
  const itPath = parts.length === 0 ? '/' : '/' + parts.join('/');
  return { locale, itPath, segments: parts };
}

function frontMatter(fields: Record<string, string | undefined>): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (v) lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

// ─── Page dispatchers ──────────────────────────────────────────────────

async function renderBlogPost(
  anno: string,
  mese: string,
  slug: string,
  locale: Locale,
): Promise<NextResponse> {
  const data = await fetchBlogArticle(slug, locale);
  if (!data) return notFoundMd('blog post not found');
  const { post, author } = data;
  const canonical = `${SITE.url}${buildBlogUrl(post)}`;
  const md = [
    frontMatter({
      title: post.title,
      description: post.excerpt ?? undefined,
      locale,
      canonical,
      published: post.published_at ?? undefined,
      modified: post.published_at ?? undefined,
      category: post.category ?? undefined,
      author: author?.full_name ?? 'Federico Calicchia',
    }),
    `# ${post.title}`,
    '',
    post.excerpt ? `> ${post.excerpt}\n` : '',
    post.cover_image ? `![Cover](${post.cover_image})\n` : '',
    '## Read the full article',
    `The complete article is available at the canonical URL: <${canonical}>`,
    '',
    'For an aggregated index of every page in Markdown, see <' + SITE.url + '/llms.txt>.',
    '',
  ].filter(Boolean).join('\n');
  // Suppress unused param warnings for anno/mese
  void anno;
  void mese;
  return new NextResponse(md, { headers: HEADERS });
}

async function renderProject(slug: string, locale: Locale): Promise<NextResponse> {
  const data = await fetchProjectBySlug(slug, locale);
  if (!data) return notFoundMd('project not found');
  const { project } = data;
  const canonical = `${SITE.url}/lavori/${project.slug}`;
  const md = [
    frontMatter({
      title: project.title,
      description: project.seo_description ?? project.description ?? undefined,
      locale,
      canonical,
      published: project.published_at ?? undefined,
      client: project.client ?? undefined,
      year: project.year ? String(project.year) : undefined,
    }),
    `# ${project.title}`,
    '',
    project.description ? `> ${project.description}\n` : '',
    project.cover_image ? `![Cover](${project.cover_image})\n` : '',
    project.client ? `**Client:** ${project.client}` : '',
    project.year ? `**Year:** ${project.year}` : '',
    project.services ? `**Services:** ${project.services}` : '',
    project.technologies?.length ? `**Stack:** ${project.technologies.join(', ')}` : '',
    project.live_url ? `**Live:** <${project.live_url}>` : '',
    '',
    '## Full case study',
    `The complete case study is at <${canonical}>.`,
    '',
    'For an aggregated index of every page in Markdown, see <' + SITE.url + '/llms.txt>.',
    '',
  ].filter(Boolean).join('\n');
  return new NextResponse(md, { headers: HEADERS });
}

/**
 * Lookup di un file `.md` reale in `src/content/_md/`. Restituisce il body
 * raw (senza front-matter — viene wrappato dall'handler). Tenta:
 *   1. `<basename>.<locale>.md` (es. `home.it.md`, `lavori.en.md`)
 *   2. `<basename>.it.md` (fallback IT se EN manca)
 *   3. null → caller usa il fallback const STATIC_PAGES
 *
 * Path detection robusta dev/prod:
 *   - dev (`next dev` da apps/sito-v3): cwd = apps/sito-v3 → src/content/_md
 *   - prod standalone Docker: cwd = /app → apps/sito-v3/src/content/_md
 * Provo entrambi i prefix per non doverli sincronizzare manualmente con il
 * Dockerfile. Il Dockerfile copia comunque `src/content` esplicitamente.
 */
async function readMdFile(itPath: string, locale: Locale): Promise<string | null> {
  const basename = itPath === '/' ? 'home' : itPath.slice(1).replace(/\//g, '__');
  const baseDirs = [
    join(process.cwd(), 'src', 'content', '_md'),
    join(process.cwd(), 'apps', 'sito-v3', 'src', 'content', '_md'),
  ];
  for (const dir of baseDirs) {
    for (const loc of [locale, DEFAULT_LOCALE] as const) {
      try {
        const path = join(dir, `${basename}.${loc}.md`);
        return await readFile(path, 'utf8');
      } catch {
        // try next combination
      }
    }
  }
  return null;
}

async function renderStaticPage(
  itPath: string,
  locale: Locale,
): Promise<NextResponse> {
  const meta = STATIC_PAGES[itPath];
  if (!meta) return notFoundMd(`no markdown source for ${itPath}`);
  const canonical = buildCanonical(itPath, locale);

  // 1. Prova a leggere il file .md reale (più ricco, mantenuto a mano).
  const fileBody = await readMdFile(itPath, locale);
  if (fileBody !== null) {
    const md = [
      frontMatter({
        title: meta.title,
        description: meta.description,
        locale,
        canonical,
      }),
      fileBody.trimEnd(),
      '',
      '---',
      `Site index: <${SITE.url}/llms.txt>`,
      '',
    ].join('\n');
    return new NextResponse(md, { headers: HEADERS });
  }

  // 2. Fallback: rendering sintetico dal const STATIC_PAGES.
  const md = [
    frontMatter({
      title: meta.title,
      description: meta.description,
      locale,
      canonical,
    }),
    `# ${meta.title}`,
    '',
    `> ${meta.description}`,
    '',
    meta.body ?? `Full content at <${canonical}>.`,
    '',
    '## Related',
    ...meta.related.map((r) => `- [${r.name}](${SITE.url}${r.path}.md)`),
    '',
    '---',
    `Site index: <${SITE.url}/llms.txt>`,
    '',
  ].join('\n');
  return new NextResponse(md, { headers: HEADERS });
}

// ─── Route handler ─────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<Params> },
): Promise<Response> {
  const { slug } = await params;
  const { locale, itPath, segments } = parseSlug(slug);

  // Dispatch CMS-driven detail pages first (they take precedence over statics).
  // Blog post detail: /blog/<anno>/<mese>/<slug>
  if (segments[0] === 'blog' && segments.length === 4) {
    const [, anno, mese, postSlug] = segments;
    return renderBlogPost(anno, mese, postSlug, locale);
  }
  // Project detail: /lavori/<slug>
  if (segments[0] === 'lavori' && segments.length === 2) {
    return renderProject(segments[1], locale);
  }
  // Service detail and other CMS-style dynamic pages: fall back to static for now.

  return renderStaticPage(itPath, locale);
}
