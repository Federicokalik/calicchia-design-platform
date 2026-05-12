/**
 * Blog API client — fetch dal backend Hono in `apps/api` (porta 3001).
 *
 * Pattern: tutte le funzioni server-side (Server Components Next 16). Nessun
 * accesso DB diretto da v3 — single source = endpoint REST. Cache via
 * `next.revalidate` per ISR.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const API_BASE = API_URL.replace(/\/$/, '');
const IS_LOCAL_API = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(API_BASE);
const IS_PRODUCTION_BUILD =
  process.env.NEXT_PHASE === 'phase-production-build' ||
  process.env.npm_lifecycle_event === 'build';

export interface BlogPostMeta {
  slug: string;
  title: string;
  excerpt: string | null;
  cover_image: string | null;
  tags: string[];
  category: string | null;
  published_at: string | null;
  created_at: string | null;
}

export interface BlogAuthor {
  full_name: string | null;
  avatar_url: string | null;
  role_title: string | null;
  bio: string | null;
  socials: Record<string, string> | null;
}

export interface BlogPost extends BlogPostMeta {
  content: string;
  reading_time: number | null;
  allow_comments: boolean | null;
  views: number | null;
  prevSlug: string | null;
  nextSlug: string | null;
  prevTitle: string | null;
  nextTitle: string | null;
  prevPublishedAt: string | null;
  nextPublishedAt: string | null;
}

export interface BlogPostResponse {
  post: BlogPost;
  author: BlogAuthor;
}

type SupportedLocale = 'it' | 'en';

function logFetchError(context: string, error: unknown): void {
  if (process.env.NODE_ENV === 'production') return;
  console.error(`[blog-api] ${context} failed:`, error);
}

/** Lista articoli pubblicati. Cache 5 min. Locale default 'it'. */
export async function fetchBlogList(
  limit = 50,
  locale: SupportedLocale = 'it',
): Promise<BlogPostMeta[]> {
  if (IS_LOCAL_API && IS_PRODUCTION_BUILD) return [];

  try {
    const res = await fetch(
      `${API_BASE}/api/public/blog/posts?limit=${limit}&locale=${locale}`,
      { next: { revalidate: 300 } },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { posts: BlogPostMeta[] };
    return data.posts ?? [];
  } catch (err) {
    logFetchError('fetchBlogList', err);
    return [];
  }
}

/** Singolo articolo per slug. Cache 10 min. Null se non trovato. Locale default 'it'. */
export async function fetchBlogArticle(
  slug: string,
  locale: SupportedLocale = 'it',
): Promise<BlogPostResponse | null> {
  if (IS_LOCAL_API && IS_PRODUCTION_BUILD) return null;

  try {
    const res = await fetch(
      `${API_BASE}/api/public/blog/posts/${encodeURIComponent(slug)}?locale=${locale}`,
      { next: { revalidate: 600 } },
    );
    if (!res.ok) return null;
    return (await res.json()) as BlogPostResponse;
  } catch (err) {
    logFetchError('fetchBlogArticle', err);
    return null;
  }
}

/** Costruisce l'URL canonico /blog/[YYYY]/[MM]/[slug] dal post. */
export function buildBlogUrl(post: Pick<BlogPostMeta, 'slug' | 'published_at' | 'created_at'>): string {
  const dateStr = post.published_at ?? post.created_at;
  if (!dateStr) return `/blog/${post.slug}`;
  const d = new Date(dateStr);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `/blog/${yyyy}/${mm}/${post.slug}`;
}

/** Format ISO date → "12 marzo 2026" / "March 12, 2026" depending on locale. */
export function formatBlogDate(iso: string | null, locale: 'it' | 'en' = 'it'): string {
  if (!iso) return '';
  const d = new Date(iso);
  const tag = locale === 'en' ? 'en-US' : 'it-IT';
  return d.toLocaleDateString(tag, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
