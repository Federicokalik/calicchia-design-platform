import type { MetadataRoute } from 'next';
import { SITE } from '@/data/site';

/**
 * Web App Manifest — PWA-lite, installable on mobile, branded.
 * Icons sono routes Next.js dinamiche: `app/icon.tsx` (favicon 32×32),
 * `app/apple-icon.tsx` (180×180 se serve in futuro).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${SITE.brand} — ${SITE.legalName}`,
    short_name: SITE.brand,
    description: SITE.description,
    start_url: '/',
    display: 'standalone',
    background_color: '#FAFAF7',
    theme_color: '#FAFAF7',
    orientation: 'portrait-primary',
    icons: [
      {
        src: '/icon',
        sizes: '32x32',
        type: 'image/png',
      },
      {
        src: '/apple-icon',
        sizes: '180x180',
        type: 'image/png',
      },
    ],
    lang: 'it',
    categories: ['business', 'design', 'developer'],
  };
}
