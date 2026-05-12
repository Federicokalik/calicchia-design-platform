/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_BUGSINK_DSN?: string;
  readonly PUBLIC_BUGSINK_DSN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
