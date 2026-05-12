import Link from 'next/link';
import { ArrowRight } from '@phosphor-icons/react/dist/ssr';
import { getTranslations } from 'next-intl/server';
import { fetchBlogList } from '@/lib/blog-api';
import { BlogCard } from '@/components/blog/BlogCard';
import { Section } from '@/components/ui/Section';

interface BlogLatestProps {
  index?: string;
  /** Override the eyebrow text (otherwise translated default is used). */
  eyebrow?: string;
  /** Override the section title (otherwise translated default is used). */
  title?: string;
  /** How many latest posts to show — default 3. */
  limit?: number;
}

/**
 * Server component: fetcha gli ultimi N articoli dal backend e li renderizza
 * come tre card affiancate. Riusabile in homepage e in /perche-scegliere-me.
 * Se la lista è vuota (es. backend offline), torna null per non lasciare
 * sezioni vuote in pagina.
 */
export async function BlogLatest({
  index = '10',
  eyebrow,
  title,
  limit = 3,
}: BlogLatestProps) {
  const posts = await fetchBlogList(limit);
  if (!posts.length) return null;

  const t = await getTranslations('home.blogLatest');
  const eyebrowText = eyebrow ?? t('eyebrowDefault');
  const titleText = title ?? t('titleDefault');
  const viewAllText = t('viewAll');

  return (
    <Section spacing="default" bordered="top">
      <div className="flex items-baseline justify-between gap-6 mb-12 md:mb-20">
        <p
          className="font-mono text-[length:var(--text-eyebrow)] uppercase tracking-[0.25em]"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          {index} — {eyebrowText}
        </p>
        <Link
          href="/blog"
          className="text-xs uppercase tracking-[0.18em] border-b transition-[gap] inline-flex items-center gap-2 hover:gap-3 pb-0.5"
          style={{ borderColor: 'var(--color-ink)', color: 'var(--color-ink)' }}
        >
          {viewAllText} <ArrowRight size={16} weight="regular" aria-hidden />
        </Link>
      </div>

      <h2
        className="font-[family-name:var(--font-display)] mb-16 md:mb-24 max-w-[14ch]"
        style={{
          fontSize: 'clamp(2.5rem, 4.5vw, 4rem)',
          fontWeight: 500,
          letterSpacing: '-0.03em',
          lineHeight: 0.95,
        }}
      >
        {titleText}
      </h2>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-x-8 gap-y-12">
        {posts.map((p) => (
          <BlogCard key={p.slug} post={p} />
        ))}
      </div>
    </Section>
  );
}
