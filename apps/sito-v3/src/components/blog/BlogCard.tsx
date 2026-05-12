'use client';

import Link from 'next/link';
import { useLocale } from 'next-intl';
import { buildBlogUrl, formatBlogDate, type BlogPostMeta } from '@/lib/blog-api';
import type { Locale } from '@/lib/i18n';

interface BlogCardProps {
  post: BlogPostMeta;
  /** True for the first card (larger format). */
  featured?: boolean;
}

export function BlogCard({ post, featured = false }: BlogCardProps) {
  const href = buildBlogUrl(post);
  const locale = useLocale() as Locale;

  return (
    <Link href={href} className="swiss-hover-card group flex flex-col">
      <div
        className={`swiss-hover-card-image ${featured ? 'aspect-[16/9]' : 'aspect-[4/3]'} mb-6 overflow-hidden flex items-center justify-center`}
        style={{
          background: post.cover_image
            ? `url(${post.cover_image}) center/cover no-repeat`
            : 'linear-gradient(135deg, var(--color-bg-elev), var(--color-line))',
        }}
      >
        {!post.cover_image && (
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
