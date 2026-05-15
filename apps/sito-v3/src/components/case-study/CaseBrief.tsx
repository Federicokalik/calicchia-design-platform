import { getTranslations } from 'next-intl/server';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { Heading } from '@/components/ui/Heading';
import { Section } from '@/components/ui/Section';
import { markdownToHtml } from '@/lib/markdown';

interface CaseBriefProps {
  /** Markdown unico (migration 090) — sostituisce Contesto + Sfida +
   *  Approccio + Longform che vivevano in 3-4 sezioni separate. */
  markdown: string | null | undefined;
  /** Section number prefix (default "01"). */
  index?: string;
}

/**
 * Sezione editorial unica per il body del case study. Layout 4+7
 * asimmetrico Bierut (rail SX eyebrow + heading, body 7-col).
 *
 * Render markdown server-side via mini-renderer interno
 * (`lib/markdown.ts`) — stesso subset usato da CaseLongform pre-redesign
 * (heading h1-h3, paragrafi, bold/italic, link, liste, blockquote, code).
 * Stili condivisi con .case-longform in globals.css.
 */
export async function CaseBrief({ markdown, index = '01' }: CaseBriefProps) {
  const t = await getTranslations('lavori.detail');

  if (!markdown || !markdown.trim()) return null;

  const html = markdownToHtml(markdown);

  return (
    <Section spacing="default" bordered="top">
      <div className="grid grid-cols-12 gap-6 md:gap-10 mb-10 md:mb-14">
        <div className="col-span-12 md:col-span-4">
          <Eyebrow as="p" mono>
            {index} — {t('brief')}
          </Eyebrow>
        </div>
        <div className="col-span-12 md:col-span-7 md:col-start-6">
          <Heading
            as="h2"
            size="display-md"
            style={{ maxWidth: '18ch' }}
          >
            {t('briefHeading')}
          </Heading>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6 md:gap-10">
        <div
          className="col-span-12 md:col-span-7 md:col-start-6 case-longform"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </Section>
  );
}
