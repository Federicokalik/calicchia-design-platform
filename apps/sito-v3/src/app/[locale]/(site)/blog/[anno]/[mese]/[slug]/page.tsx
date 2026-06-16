import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { Link } from '@/i18n/navigation';
import { fetchBlogArticle, buildBlogUrl, fetchBlogList } from '@/lib/blog-api';
import { BlogHero } from '@/components/blog/BlogHero';
import { BlogBody } from '@/components/blog/BlogBody';
import { BlogDemoIslands } from '@/components/blog/BlogDemoIslands';
import { BlogTOC } from '@/components/blog/BlogTOC';
import { BlogShare } from '@/components/blog/BlogShare';
import { BlogComments } from '@/components/blog/BlogComments';
import { StructuredData } from '@/components/seo/StructuredData';
import { articleSchema, breadcrumbSchema } from '@/data/structured-data';
import { SITE } from '@/data/site';
import { LOCALES, type Locale } from '@/lib/i18n';
import { buildI18nAlternates, buildCanonical, buildOgLocale } from '@/lib/canonical';
import { buildOgImage, buildTwitterCard } from '@/lib/og-image';

interface Params {
  locale: string;
  anno: string;
  mese: string;
  slug: string;
}

/**
 * Pre-generate static params per tutti i blog post pubblicati × tutti i locale.
 * `dynamicParams: true` permette nuovi post senza rebuild.
 * Revalidate 1h: post nuovi appaiono nel giro di un'ora senza intervento.
 */
export const dynamicParams = true;
export const revalidate = 3600;

export async function generateStaticParams(): Promise<Params[]> {
  // IT canonical list; blog posts share slugs across locales (admin
  // TranslationsPanelEN attaches EN content to the same row, no separate slug).
  const posts = await fetchBlogList(200, 'it');
  const params: Params[] = [];
  for (const post of posts) {
    const dateStr = post.published_at ?? post.created_at;
    if (!dateStr) continue;
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) continue;
    const anno = String(date.getFullYear());
    const mese = String(date.getMonth() + 1).padStart(2, '0');
    for (const locale of LOCALES) {
      params.push({ locale, anno, mese, slug: post.slug });
    }
  }
  return params;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug, locale: localeParam } = await params;
  const locale = (localeParam ?? 'it') as Locale;
  const data = await fetchBlogArticle(slug, locale);
  if (!data) return { title: 'Articolo non trovato' };
  const { post } = data;
  const blogPath = buildBlogUrl(post);
  return {
    title: post.title,
    description: post.excerpt ?? undefined,
    alternates: buildI18nAlternates(blogPath, locale),
    openGraph: {
      type: 'article',
      title: post.title,
      description: post.excerpt ?? undefined,
      url: buildCanonical(blogPath, locale),
      images: buildOgImage(post.title, locale),
      publishedTime: post.published_at ?? undefined,
      ...buildOgLocale(locale),
    },
    twitter: buildTwitterCard(post.title, post.excerpt ?? undefined, locale),
  };
}

export default async function BlogArticlePage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { slug, locale: localeParam } = await params;
  const locale = (localeParam ?? 'it') as Locale;
  const data = await fetchBlogArticle(slug, locale);
  if (!data) notFound();

  const { post, author } = data;
  const blogPath = buildBlogUrl(post);
  const fullUrl = `${SITE.url}${blogPath}`;

  // Server-side h2 count: TOC mountato solo se ≥3 sezioni
  const h2Count = (post.content ?? '').match(/<h2(\s|>)/gi)?.length ?? 0;
  const showTOC = h2Count >= 3;

  return (
    <article>
      <StructuredData
        json={[
          articleSchema({
            title: post.title,
            description: post.excerpt ?? `Articolo di ${author?.full_name ?? 'Federico Calicchia'}`,
            url: blogPath,
            image: post.cover_image ?? undefined,
            datePublished: post.published_at ?? post.created_at ?? undefined,
            dateModified: post.published_at ?? undefined,
            section: post.category ?? undefined,
            locale,
          }),
          breadcrumbSchema([
            { name: 'Home', url: '/' },
            { name: 'Blog', url: '/blog' },
            { name: post.title, url: blogPath },
          ]),
        ]}
      />

      <BlogHero
        title={post.title}
        excerpt={post.excerpt}
        category={post.category}
        publishedAt={post.published_at}
        readingTime={post.reading_time}
        coverImage={post.cover_image}
        authorName={author?.full_name ?? null}
      />

      {showTOC ? (
        <div className="px-6 md:px-10 lg:px-14 py-16 md:py-24 max-w-[1400px] mx-auto grid grid-cols-1 md:grid-cols-12 gap-x-8 md:gap-x-12">
          {/* TOC sticky ripristinata (2026-06-16): su long-form l'indice sempre
              visibile è un guadagno di leggibilità netto; self-start evita lo
              stretch del grid item che annullerebbe lo sticky. */}
          <aside className="md:col-span-3 md:col-start-1 md:sticky md:top-32 md:self-start">
            <BlogTOC />
          </aside>
          <div className="md:col-span-8 md:col-start-5">
            <BlogBody content={post.content ?? ''} withTOC />
          </div>
        </div>
      ) : (
        <BlogBody content={post.content ?? ''} />
      )}

      {/* Hydrate AI demo placeholders (audit C-003). Renders nothing — runs
          on the client after mount and rewrites .demo-embed divs to iframes. */}
      {post.id ? <BlogDemoIslands postId={post.id} /> : null}

      <BlogShare title={post.title} url={fullUrl} />

      <BlogComments />

      {(post.prevSlug || post.nextSlug) && (
        <nav
          className="px-6 md:px-10 lg:px-14 py-16 max-w-[1600px] mx-auto grid grid-cols-1 md:grid-cols-2 gap-8"
          style={{ borderTop: '1px solid var(--color-line)' }}
        >
          {post.prevSlug && (
            <Link
              href={buildBlogUrl({
                slug: post.prevSlug,
                published_at: post.prevPublishedAt,
                created_at: post.prevPublishedAt,
              })}
              className="group flex flex-col gap-2"
            >
              <span
                className="font-mono text-xs uppercase tracking-[0.2em]"
                style={{ color: 'var(--color-ink-subtle)' }}
              >
                ← Articolo precedente
              </span>
              <span
                className="font-[family-name:var(--font-display)] text-2xl group-hover:opacity-70 transition-opacity"
                style={{ fontWeight: 500, letterSpacing: '-0.02em' }}
              >
                {post.prevTitle}
              </span>
            </Link>
          )}
          {post.nextSlug && (
            <Link
              href={buildBlogUrl({
                slug: post.nextSlug,
                published_at: post.nextPublishedAt,
                created_at: post.nextPublishedAt,
              })}
              className="group flex flex-col gap-2 md:text-right md:items-end"
            >
              <span
                className="font-mono text-xs uppercase tracking-[0.2em]"
                style={{ color: 'var(--color-ink-subtle)' }}
              >
                Articolo successivo →
              </span>
              <span
                className="font-[family-name:var(--font-display)] text-2xl group-hover:opacity-70 transition-opacity"
                style={{ fontWeight: 500, letterSpacing: '-0.02em' }}
              >
                {post.nextTitle}
              </span>
            </Link>
          )}
        </nav>
      )}
    </article>
  );
}
