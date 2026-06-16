import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { fetchBlogList, buildBlogUrl } from '@/lib/blog-api';
import { BlogList } from '@/components/blog/BlogList';
import { PageHero } from '@/components/layout/PageHero';
import { StructuredData } from '@/components/seo/StructuredData';
import { collectionPageSchema, breadcrumbSchema } from '@/data/structured-data';
import type { Locale } from '@/lib/i18n';
import { buildI18nAlternates, buildCanonical, buildOgLocale } from '@/lib/canonical';
import { buildOgImage, buildTwitterCard } from '@/lib/og-image';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('blog.list.metadata');
  const locale = (await getLocale()) as Locale;

  return {
    title: {
      absolute: t('title'),
    },
    description: t('description'),
    alternates: buildI18nAlternates('/blog', locale),
    // TODO: rimuovi quando >=3 articoli reali pubblicati (controllo via fetchBlogList)
    robots: { index: false, follow: true },
    openGraph: {
      type: 'website',
      title: t('ogTitle'),
      description: t('ogDescription'),
      url: buildCanonical('/blog', locale),
      images: buildOgImage(t('ogTitle'), locale),
      ...buildOgLocale(locale),
    },
    twitter: buildTwitterCard(t('ogTitle'), t('ogDescription'), locale),
  };
}

export default async function BlogIndexPage() {
  const t = await getTranslations('blog.list');
  const locale = (await getLocale()) as Locale;
  const posts = await fetchBlogList(50, locale);

  return (
    <>
      <StructuredData
        json={[
          collectionPageSchema({
            name: t('pageTitle'),
            description: t('pageLead'),
            url: buildCanonical('/blog', locale),
            items: posts.map((p) => ({
              name: p.title,
              url: buildBlogUrl({
                slug: p.slug,
                published_at: p.published_at ?? null,
                created_at: p.created_at ?? null,
              }),
            })),
            locale,
          }),
          breadcrumbSchema([
            { name: 'Home', url: '/' },
            { name: 'Blog', url: '/blog' },
          ]),
        ]}
      />
      <PageHero
        breadcrumbs={[
          { name: 'Home', url: '/' },
          { name: 'Blog', url: '/blog' },
        ]}
        eyebrow={t('eyebrowWithCount', { count: posts.length })}
        title={t('pageTitle')}
        intro={t('pageLead')}
      />

      <section className="px-6 md:px-10 lg:px-14 pb-32 max-w-[1600px] mx-auto">
        <BlogList posts={posts} />
      </section>
    </>
  );
}
