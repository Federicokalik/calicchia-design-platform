import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { fetchBlogList } from '@/lib/blog-api';
import { BlogList } from '@/components/blog/BlogList';
import { PageHero } from '@/components/layout/PageHero';
import type { Locale } from '@/lib/i18n';
import { buildI18nAlternates, buildCanonical } from '@/lib/canonical';

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
      title: t('ogTitle'),
      description: t('ogDescription'),
      url: buildCanonical('/blog', locale),
    },
  };
}

export default async function BlogIndexPage() {
  const t = await getTranslations('blog.list');
  const posts = await fetchBlogList(50);

  return (
    <>
      <PageHero
        breadcrumbs={[
          { name: 'Home', url: '/' },
          { name: 'Blog', url: '/blog' },
        ]}
        eyebrow={t('eyebrowWithCount', { count: posts.length })}
        title={t('pageTitle')}
        intro={t('pageLead')}
        trustBadge={false}
      />

      <section className="px-6 md:px-10 lg:px-14 pb-32 max-w-[1600px] mx-auto">
        <BlogList posts={posts} />
      </section>
    </>
  );
}
