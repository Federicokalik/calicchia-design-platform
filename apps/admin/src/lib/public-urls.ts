/**
 * Public-facing URLs (sito-v3 + portal). Audit D-008: every consumer used to
 * fall back to http://localhost:3000 when the env var was missing — in a
 * production build that meant copying "localhost" links straight into client
 * emails. Centralized here so:
 *   - dev still falls back to localhost (so `pnpm dev` works without a .env)
 *   - prod build logs a loud console.error if either var is missing, instead
 *     of silently emitting a broken link.
 *
 * Set VITE_SITE_URL and VITE_PORTAL_URL at build time
 * (vite.config.ts envDir points at the monorepo root .env).
 */

function readPublicUrl(envValue: string | undefined, envName: string, devFallback: string): string {
  if (envValue && envValue.length > 0) return envValue.replace(/\/$/, '');
  if (import.meta.env.DEV) return devFallback;
  // PROD: missing → log and return the dev fallback so the UI still renders,
  // but flag it loudly. A future hard-fail at build time would be better.
  console.error(
    `[public-urls] ${envName} is not set in this production build. ` +
      `Generated links will point at ${devFallback} — fix .env before deploying client-facing UI.`,
  );
  return devFallback;
}

export const SITE_URL = readPublicUrl(
  import.meta.env.VITE_SITE_URL as string | undefined,
  'VITE_SITE_URL',
  'http://localhost:3000',
);

export const PORTAL_URL = readPublicUrl(
  import.meta.env.VITE_PORTAL_URL as string | undefined,
  'VITE_PORTAL_URL',
  'http://localhost:3000',
);
