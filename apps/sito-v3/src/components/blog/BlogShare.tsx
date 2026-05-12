'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';

interface BlogShareProps {
  title: string;
  url: string;
}

export function BlogShare({ title, url }: BlogShareProps) {
  const t = useTranslations('blog.detail');
  const [copied, setCopied] = useState(false);
  const tw = `https://twitter.com/intent/tweet?text=${encodeURIComponent(title)}&url=${encodeURIComponent(url)}`;
  const li = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <aside
      className="px-6 md:px-10 lg:px-14 py-16 max-w-[800px] mx-auto"
      style={{ borderTop: '1px solid var(--color-line)' }}
    >
      <p
        className="font-mono text-xs uppercase tracking-[0.25em] mb-6"
        style={{ color: 'var(--color-ink-subtle)' }}
      >
        {t('share')}
      </p>
      <div className="flex flex-wrap gap-3">
        <Button
          variant="ghost"
          size="sm"
          href={tw}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('sharePlatforms.twitterX')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          href={li}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('sharePlatforms.linkedIn')}
        </Button>
        <Button variant="ghost" size="sm" type="button" onClick={onCopy}>
          {copied ? t('linkCopied') : t('copyLink')}
        </Button>
      </div>
    </aside>
  );
}
