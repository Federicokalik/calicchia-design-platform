import { ArrowRight } from '@phosphor-icons/react/dist/ssr';
import { getTranslations } from 'next-intl/server';
import { BlogCard } from './BlogCard';
import type { BlogPostMeta } from '@/lib/blog-api';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { Heading } from '@/components/ui/Heading';
import { Button } from '@/components/ui/Button';

interface BlogListProps {
  posts: BlogPostMeta[];
}

/**
 * Grid 2-col con stagger spaziale (alterna offset md:mt-32 sui dispari)
 * — stesso pattern della listing /lavori.
 */
export async function BlogList({ posts }: BlogListProps) {
  const t = await getTranslations('blog.list.emptyState');

  if (!posts.length) {
    return (
      <div className="grid grid-cols-12 gap-6 md:gap-8 max-w-[1200px]">
        <div className="col-span-12 md:col-span-8 flex flex-col gap-6 md:gap-8">
          <Eyebrow>{t('eyebrow')}</Eyebrow>
          <Heading as="h2" size="display-md" style={{ maxWidth: '20ch' }}>
            {t('title')}
          </Heading>
          <p
            className="text-lg md:text-xl leading-relaxed"
            style={{ color: 'var(--color-text-secondary)', maxWidth: '52ch' }}
          >
            {t('lead')}
          </p>
          <div className="flex flex-wrap items-center gap-4 mt-2">
            <Button href="/contatti" variant="solid" size="md">
              {t('ctaPrimary')} <ArrowRight size={16} weight="regular" aria-hidden />
            </Button>
            <Button href="/web-design-freelance" variant="underline" size="md">
              {t('ctaSecondary')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Featured = il più recente.
  const [first, ...rest] = posts;

  return (
    <>
      {first && (
        <div className="mb-20 md:mb-32">
          <BlogCard post={first} featured />
        </div>
      )}
      {rest.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-16">
          {rest.map((p, i) => (
            <div key={p.slug} className={i % 2 === 1 ? 'md:mt-32' : ''}>
              <BlogCard post={p} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
