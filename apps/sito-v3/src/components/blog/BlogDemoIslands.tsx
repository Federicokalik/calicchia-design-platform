'use client';

import { useEffect } from 'react';

interface BlogDemoIslandsProps {
  /** ID of the blog_post row whose demos[] should back the iframes. */
  postId: string;
}

/**
 * Client island that hydrates AI-generated `<div class="demo-embed"
 * data-demo-index="N">` placeholders into iframes pointing at the public
 * API. Audit C-002 + C-003: the admin AI generator writes the placeholder
 * but no component ever converted it, so users saw an empty <div>.
 *
 * Iframes load /api/public/blog-demos/<postId>/<idx> on the API origin;
 * frame-ancestors CSP set server-side allows the embed from sito-v3.
 */
export function BlogDemoIslands({ postId }: BlogDemoIslandsProps) {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const apiBase = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
    const placeholders = document.querySelectorAll<HTMLElement>(
      'div.demo-embed[data-demo-index]',
    );
    for (const el of placeholders) {
      // Idempotent: skip if already hydrated (StrictMode double-effect).
      if (el.dataset.hydrated === '1') continue;
      const idx = el.dataset.demoIndex;
      if (idx === undefined) continue;
      const iframe = document.createElement('iframe');
      iframe.src = `${apiBase}/api/public/blog-demos/${encodeURIComponent(postId)}/${encodeURIComponent(idx)}`;
      iframe.loading = 'lazy';
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      iframe.style.cssText = 'width:100%; min-height:380px; border:0; border-radius:8px; background:#0a0a0a;';
      iframe.title = `Demo interattiva ${Number(idx) + 1}`;
      el.replaceChildren(iframe);
      el.dataset.hydrated = '1';
    }
  }, [postId]);

  return null;
}
