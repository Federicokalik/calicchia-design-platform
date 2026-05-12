import { getTranslations } from 'next-intl/server';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { Heading } from '@/components/ui/Heading';
import { Section } from '@/components/ui/Section';
import { markdownToHtml } from '@/lib/markdown';

interface CaseLongformProps {
  /** Markdown source dal campo `content` admin (Rich Text TipTap → markdown). */
  markdown: string | null | undefined;
  /** Section number (default "06") */
  index?: string;
  /** Titolo della sezione (default "Approfondimento") */
  title?: string;
}

/**
 * Long-form editorial markdown rendering. Pentagram-style: prose generosa
 * 7-col asymmetric, hairline divider, mono eyebrow numerato. Server-only
 * render via mini-renderer interno (lib/markdown.ts) — niente dipendenza
 * esterna, niente prose di Tailwind Typography (replicato in globals.css
 * con classi `.case-longform`).
 *
 * Subset markdown supportato: heading h1-h3, paragrafi, bold/italic,
 * inline code + code block, link, bullet/ordered list, blockquote, hr.
 * Admin Rich Text TipTap → markdown sostiene tutto questo subset.
 */
export async function CaseLongform({
  markdown,
  index = '06',
  title,
}: CaseLongformProps) {
  const t = await getTranslations('lavori.detail');
  const sectionTitle = title ?? t('longformTitle');

  if (!markdown || !markdown.trim()) return null;

  const html = markdownToHtml(markdown);

  return (
    <Section spacing="default" bordered="top">
      <div className="grid grid-cols-12 gap-6 md:gap-10 mb-12 md:mb-16">
        <div className="col-span-12 md:col-span-7">
          <Eyebrow as="p" mono className="mb-6">
            {index} — {sectionTitle}
          </Eyebrow>
          <Heading
            as="h2"
            size="display-md"
            className="mb-2"
            style={{ maxWidth: '20ch' }}
          >
            {t('longformHeading')}
          </Heading>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6 md:gap-10">
        <div
          className="col-span-12 md:col-span-7 case-longform"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </Section>
  );
}
