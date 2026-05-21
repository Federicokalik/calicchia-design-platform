/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_BUGSINK_DSN?: string;
  readonly PUBLIC_BUGSINK_DSN?: string;
  // Shared with sito-v3 — Cloudflare Turnstile site key (anti-bot on login).
  readonly NEXT_PUBLIC_TURNSTILE_SITE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
