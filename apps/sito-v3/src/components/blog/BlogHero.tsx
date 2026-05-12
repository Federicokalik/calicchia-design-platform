import { getTranslations } from 'next-intl/server';
import { formatBlogDate } from '@/lib/blog-api';

interface BlogHeroProps {
  title: string;
  excerpt: string | null;
  category: string | null;
  publishedAt: string | null;
  readingTime: number | null;
  coverImage: string | null;
  authorName: string | null;
}

export async function BlogHero({
  title,
  excerpt,
  category,
  publishedAt,
  readingTime,
  coverImage,
  authorName,
}: BlogHeroProps) {
  const t = await getTranslations('blog.detail');
  const formattedDate = formatBlogDate(publishedAt);

  return (
    <section
      className="relative px-6 md:px-10 lg:px-14 pt-36 md:pt-44 pb-16 md:pb-24 max-w-[1600px] mx-auto"
    >
      <div className="flex items-baseline justify-between gap-6 mb-8">
        {category && (
          <p
            className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.25em]"
            style={{ color: 'var(--color-accent-deep)' }}
          >
            {category}
          </p>
        )}
        <span
          className="text-xs uppercase tracking-[0.18em]"
          style={{ color: 'var(--color-ink-subtle)' }}
        >
          {formattedDate ? t('publishedAt', { date: formattedDate }) : ''}
          {readingTime ? ` · ${t('readingTime', { count: readingTime })}` : ''}
          {authorName ? ` · ${authorName}` : ''}
        </span>
      </div>

      <h1
        className="font-[family-name:var(--font-display)] mb-12 max-w-[20ch]"
        style={{
          fontSize: 'var(--text-display-xl)',
          fontWeight: 500,
          letterSpacing: '-0.035em',
          lineHeight: 0.92,
        }}
      >
        {title}
      </h1>

      {excerpt && (
        <p
          className="text-xl md:text-2xl leading-relaxed max-w-[55ch] mb-16"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          {excerpt}
        </p>
      )}

      <div
        className="aspect-[16/9] overflow-hidden"
        style={{
          background: coverImage
            ? `url(${coverImage}) center/cover no-repeat`
            : 'linear-gradient(135deg, var(--color-bg-elev), var(--color-line))',
        }}
      >
        {!coverImage && (
          <div className="w-full h-full flex items-center justify-center">
            <span
              className="font-[family-name:var(--font-display)] text-[12rem]"
              style={{
                color: 'var(--color-ink-subtle)',
                letterSpacing: '-0.04em',
                fontWeight: 500,
              }}
            >
              {title.charAt(0)}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
