'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import {
  EditorialChapterIndex,
  type EditorialChapterEntry,
} from '@/components/layout/EditorialChapterIndex';

interface BlogTOCProps {
  /** CSS selector dell'article container con il contenuto rendered. */
  targetSelector?: string;
  /** Numero minimo di h2 per mostrare il TOC. Default 3. */
  minHeadings?: number;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * BlogTOC — Indice articolo che scopre h2 nel DOM al mount,
 * assegna id se mancanti, costruisce chapter list e delega
 * la UI a `EditorialChapterIndex` (riuso pattern P0-08).
 *
 * Mostra TOC solo se l'articolo ha almeno `minHeadings` h2.
 */
export function BlogTOC({
  targetSelector = '[data-blog-article]',
  minHeadings = 3,
}: BlogTOCProps) {
  const t = useTranslations('blog.detail.tableOfContents');
  const [chapters, setChapters] = useState<EditorialChapterEntry[]>([]);

  useEffect(() => {
    const container = document.querySelector(targetSelector);
    if (!container) return;

    const headings = Array.from(container.querySelectorAll('h2'));
    if (headings.length < minHeadings) return;

    const seen = new Set<string>();
    const next: EditorialChapterEntry[] = headings.map((h, i) => {
      const text = h.textContent?.trim() ?? t('chapterFallback', { count: i + 1 });
      let id = h.id || slugify(text);
      if (!id) id = `cap-${i + 1}`;
      // De-duplicate
      let candidate = id;
      let n = 2;
      while (seen.has(candidate)) {
        candidate = `${id}-${n}`;
        n += 1;
      }
      seen.add(candidate);
      if (!h.id) h.id = candidate;
      // scroll-margin per offset header
      (h as HTMLElement).style.scrollMarginTop = '8rem';
      return {
        id: candidate,
        number: String(i + 1).padStart(2, '0'),
        label: text,
      };
    });

    setChapters(next);
  }, [targetSelector, minHeadings, t]);

  if (chapters.length === 0) return null;

  return <EditorialChapterIndex chapters={chapters} ariaLabel={t('ariaLabel')} />;
}
