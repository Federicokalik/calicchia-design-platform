'use client';

import Image from 'next/image';
import { useLocale } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { buildBlogUrl, formatBlogDate, type BlogPostMeta } from '@/lib/blog-api';
import type { Locale } from '@/lib/i18n';

interface BlogCardProps {
  post: BlogPostMeta;
  /** True for the first card (larger format). */
  featured?: boolean;
  /** Dimensioni intrinseche della cover (da getImageSize nel server component). */
  coverWidth?: number;
  coverHeight?: number;
}

export function BlogCard({ post, featured = false, coverWidth, coverHeight }: BlogCardProps) {
  const href = buildBlogUrl(post);
  const locale = useLocale() as Locale;

  return (
    <Link href={href} className="swiss-hover-card group flex flex-col">
      {post.cover_image && coverWidth && coverHeight ? (
        <Image
          src={post.cover_image}
          alt={post.title}
          width={coverWidth}
          height={coverHeight}
          quality={90}
          sizes={`${coverWidth}px`}
          className="swiss-hover-card-image w-full h-auto mb-6"
        />
      ) : (
        <div
          className={`swiss-hover-card-image relative ${featured ? 'aspect-[16/9]' : 'aspect-[4/3]'} mb-6 overflow-hidden flex items-center justify-center`}
          style={{
            background: post.cover_image
              ? 'var(--color-line)'
              : 'linear-gradient(135deg, var(--color-bg-elev), var(--color-line))',
          }}
        >
          {post.cover_image ? (
            <Image
              src={post.cover_image}
              alt={post.title}
              fill
              quality={90}
              sizes={featured ? '(min-width: 1024px) 80vw, 100vw' : '(min-width: 1024px) 45vw, 100vw'}
              style={{ objectFit: 'cover' }}
            />
          ) : (
            <span
              className="font-[family-name:var(--font-display)] text-9xl"
              style={{
                color: 'var(--color-ink-subtle)',
                letterSpacing: '-0.04em',
                fontWeight: 500,
              }}
            >
              {post.title.charAt(0)}
            </span>
          )}
        </div>
      )}
      <div className="flex items-baseline justify-between gap-3 mb-2">
        {post.category && (
          <span
            className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.2em]"
            style={{ color: 'var(--color-accent-deep)' }}
          >
            {post.category}
          </span>
        )}
        <span
          className="font-mono text-xs"
          style={{ color: 'var(--color-ink-subtle)' }}
        >
          {formatBlogDate(post.published_at ?? post.created_at, locale)}
        </span>
      </div>
      <h2
        className={`font-[family-name:var(--font-display)] mb-3 ${featured ? 'text-4xl md:text-5xl' : 'text-2xl md:text-3xl'}`}
        style={{ fontWeight: 500, letterSpacing: '-0.025em', lineHeight: 1.05 }}
      >
        {post.title}
      </h2>
      {post.excerpt && (
        <p
          className="text-base leading-relaxed max-w-[55ch]"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          {post.excerpt}
        </p>
      )}
      {post.tags.length > 0 && (
        <div
          className="flex flex-wrap gap-3 mt-4 text-xs uppercase tracking-[0.15em]"
          style={{ color: 'var(--color-ink-subtle)' }}
        >
          {post.tags.slice(0, 3).map((t) => (
            <span key={t}>#{t}</span>
          ))}
        </div>
      )}
    </Link>
  );
}
