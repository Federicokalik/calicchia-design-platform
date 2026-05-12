import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';
import { readFileSync } from 'node:fs';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

function readRootEnvValue(name: string): string | undefined {
  try {
    const rootEnv = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
    const line = rootEnv
      .split(/\r?\n/)
      .find((entry) => entry.trim().startsWith(`${name}=`));
    if (!line) return undefined;
    return line
      .slice(line.indexOf('=') + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
  } catch {
    return undefined;
  }
}

const googleMapsKey =
  process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ??
  process.env.PUBLIC_GOOGLE_MAPS_KEY ??
  readRootEnvValue('NEXT_PUBLIC_GOOGLE_MAPS_KEY') ??
  readRootEnvValue('PUBLIC_GOOGLE_MAPS_KEY') ??
  '';

const bugsinkDsn =
  process.env.NEXT_PUBLIC_BUGSINK_DSN ??
  process.env.PUBLIC_BUGSINK_DSN ??
  process.env.BUGSINK_DSN ??
  readRootEnvValue('NEXT_PUBLIC_BUGSINK_DSN') ??
  readRootEnvValue('PUBLIC_BUGSINK_DSN') ??
  readRootEnvValue('BUGSINK_DSN') ??
  '';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_GOOGLE_MAPS_KEY: googleMapsKey,
    NEXT_PUBLIC_BUGSINK_DSN: bugsinkDsn,
  },
  experimental: {
    optimizePackageImports: ['@phosphor-icons/react', 'gsap'],
    // Native View Transitions API: abilita cross-document fade automatico
    // su ogni route + morph cover lavori via `viewTransitionName`.
    viewTransition: true,
  },
  images: {
    formats: ['image/avif', 'image/webp'],
    // Dev: disabilita optimization. Next 16 blocca upstream verso IP privati
    // come SSRF protection — `localhost:3001/media/*` (apps/api in dev) viene
    // rejectato. In produzione il backend gira su dominio pubblico, quindi
    // l'optimizer funziona normalmente con `remotePatterns'.
    unoptimized: process.env.NODE_ENV === 'development',
    remotePatterns: [
      { protocol: 'http', hostname: 'localhost', port: '3001', pathname: '/media/**' },
      { protocol: 'https', hostname: 'picsum.photos', pathname: '/seed/**' },
      { protocol: 'https', hostname: 'fastly.picsum.photos', pathname: '/**' },
    ],
  },
  async redirects() {
    // Path matrice sono single-segment (es. /branding-per-dentista-a-roma) →
    // `:slug` (no wildcard) basta. Wildcards `:rest*` richiedono prefix/suffix
    // su segmenti separati da `/`, quindi NON funzionano qui.
    return [
      // Servizi rimossi dalla matrice (refactor 2026-05): branding, comunicazione,
      // comunicazione-offline, automazioni-ai, web-app. Branding resta come pagina
      // standalone (/servizi/branding); gli altri sono assorbiti.
      // Branding rimosso 2026-05-08 (fuori positioning Web Designer & Developer).
      // Redirect /servizi/branding → /servizi e matrix variant → /servizi.
      { source: '/servizi/branding', destination: '/servizi', permanent: true },
      { source: '/branding-per-:slug', destination: '/servizi', permanent: true },
      { source: '/comunicazione-per-:slug', destination: '/servizi', permanent: true },
      { source: '/comunicazione-offline-per-:slug', destination: '/servizi', permanent: true },
      { source: '/automazioni-ai-per-:slug', destination: '/servizi/sviluppo-web', permanent: true },
      // web-app rinominato in sviluppo-web (matrix + servizi)
      { source: '/web-app-per-:slug', destination: '/sviluppo-web-per-:slug', permanent: true },
      { source: '/servizi/web-app', destination: '/servizi/sviluppo-web', permanent: true },
      // Locale-prefixed variants (Next i18n / [locale] segment)
      { source: '/:locale(it|en)/servizi/branding', destination: '/:locale/servizi', permanent: true },
      { source: '/:locale(it|en)/branding-per-:slug', destination: '/:locale/servizi', permanent: true },
      { source: '/:locale(it|en)/comunicazione-per-:slug', destination: '/:locale/servizi', permanent: true },
      { source: '/:locale(it|en)/comunicazione-offline-per-:slug', destination: '/:locale/servizi', permanent: true },
      { source: '/:locale(it|en)/automazioni-ai-per-:slug', destination: '/:locale/servizi/sviluppo-web', permanent: true },
      { source: '/:locale(it|en)/web-app-per-:slug', destination: '/:locale/sviluppo-web-per-:slug', permanent: true },
      { source: '/:locale(it|en)/servizi/web-app', destination: '/:locale/servizi/sviluppo-web', permanent: true },
    ];
  },
};

export default withSentryConfig(withNextIntl(config), {
  silent: true,
  telemetry: false,
  sourcemaps: {
    disable: true,
  },
  bundleSizeOptimizations: {
    excludeDebugStatements: true,
    excludeTracing: true,
  },
});
