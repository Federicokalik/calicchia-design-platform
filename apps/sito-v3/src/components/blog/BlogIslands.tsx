'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Locale } from '@/lib/i18n';
import { BLOG_ISLANDS } from './islands/registry';

interface Target {
  el: HTMLElement;
  key: string;
}

/**
 * Mounts registered React components into `div.blog-island[data-island]`
 * placeholders of the server-rendered article body (charts, quizzes). The
 * body is plain sanitized HTML, so interactive parts live here instead.
 * Renders nothing until mounted; placeholders with unknown keys stay empty.
 */
export function BlogIslands({ locale }: { locale: Locale }) {
  const [targets, setTargets] = useState<Target[]>([]);

  useEffect(() => {
    const els = document.querySelectorAll<HTMLElement>(
      '[data-blog-article] div.blog-island[data-island]',
    );
    const found: Target[] = [];
    for (const el of els) {
      const key = el.dataset.island;
      if (key && BLOG_ISLANDS[key]) found.push({ el, key });
    }
    setTargets(found);
  }, []);

  return (
    <>
      {targets.map(({ el, key }, i) => {
        const Island = BLOG_ISLANDS[key];
        return createPortal(<Island locale={locale} />, el, `${key}-${i}`);
      })}
    </>
  );
}
