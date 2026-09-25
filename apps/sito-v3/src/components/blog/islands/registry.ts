import dynamic from 'next/dynamic';
import type { ComponentType } from 'react';
import type { Locale } from '@/lib/i18n';

export type IslandComponent = ComponentType<{ locale: Locale }>;

/**
 * Registry of React islands a blog post can embed with
 * `<div class="blog-island" data-island="<key>"></div>` in its markdown.
 * Each entry is code-split: a post only downloads the islands it uses.
 * Unknown keys are ignored by BlogIslands (placeholder stays empty).
 */
export const BLOG_ISLANDS: Record<string, IslandComponent> = {
  'wp2026-share': dynamic(() => import('./wp2026/charts').then((m) => m.ShareLine)),
  'wp2026-ecommerce': dynamic(() => import('./wp2026/charts').then((m) => m.EcommerceBars)),
  'wp2026-core-hours': dynamic(() => import('./wp2026/charts').then((m) => m.CoreHoursBars)),
  'wp2026-vuln-waffle': dynamic(() => import('./wp2026/charts').then((m) => m.VulnWaffle)),
  'wp2026-cwv': dynamic(() => import('./wp2026/charts').then((m) => m.CwvBars)),
  'wp2026-stack-picker': dynamic(() => import('./wp2026/StackPicker')),
};
