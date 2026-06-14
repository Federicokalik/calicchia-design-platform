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

// CSP (SEC-08). sito-v3 has no nonce middleware (middleware.ts is deliberately
// absent — see src/i18n/routing.ts), so script/style fall back to
// 'unsafe-inline' for Next's hydration scripts and GSAP's inline style
// attributes. The policy still hardens the meaningful axes: object-src 'none',
// base-uri 'self', frame-ancestors 'none', and no http:/data: script sources.
// localhost + ws entries keep dev (API on :3001, HMR socket) working; they are
// harmless in production.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' blob: data: https: http://localhost:3001",
  "font-src 'self' data: https:",
  "connect-src 'self' https: http://localhost:3001 ws://localhost:*",
  "frame-src 'self' https:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Self-contained build output for Docker: produces .next/standalone with a
  // minimal server.js + traced node_modules. Required by apps/sito-v3/Dockerfile.
  output: 'standalone',
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
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
  async rewrites() {
    return [
      // Markdown mirror per LLM: ogni URL `/<path>.md` viene servito dal route
      // handler `app/md/[[...slug]]/route.ts` che restituisce text/markdown.
      // Coerente con l'hint nel commento HTML iniettato dal RootLayout e con
      // l'indice in /llms.txt.
      // - `/.md`             → `/md`             (homepage IT)
      // - `/en.md`           → `/md/en`          (homepage EN)
      // - `/lavori.md`       → `/md/lavori`
      // - `/servizi/seo.md`  → `/md/servizi/seo`
      // - `/blog/2026/05/post.md` → `/md/blog/2026/05/post`
      // NB: cartella `md/` (no underscore prefix). In Next.js App Router le
      // cartelle che iniziano con `_` sono "private folders" e NON vengono
      // routate — `_md/` qui sarebbe 404 indipendentemente dal rewrite.
      // Pattern: path-to-regexp `:path*.md` cattura 0+ segment con suffix `.md`.
      { source: '/.md', destination: '/md' },
      { source: '/:path*.md', destination: '/md/:path*' },
    ];
  },
};

// Upload source maps to Bugsink only when a build-time auth token is present
// (CI / Docker builder stage). Local + dev builds without the token are
// unchanged: generation/upload stays disabled so they never fail on a missing
// token. Bugsink is Sentry-compatible and resolves frames via debug IDs that
// the bundler plugin injects, so release names don't need to match.
const enableSourcemapUpload = Boolean(process.env.SENTRY_AUTH_TOKEN);

export default withSentryConfig(withNextIntl(config), {
  silent: true,
  telemetry: false,
  // Self-hosted Bugsink has no orgs; project = the Bugsink project slug.
  sentryUrl: 'https://bug.calicchia.design/',
  org: 'bugsinkhasnoorgs',
  project: 'portfolio',
  authToken: process.env.SENTRY_AUTH_TOKEN,
  sourcemaps: {
    disable: !enableSourcemapUpload,
    // Hidden maps: deleted from the build output after upload, so they are
    // never served publicly — only Bugsink holds them for de-minification.
    deleteSourcemapsAfterUpload: true,
  },
  bundleSizeOptimizations: {
    excludeDebugStatements: true,
    excludeTracing: true,
  },
});
