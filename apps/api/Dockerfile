# syntax=docker/dockerfile:1
# Production image — @caldes/api (Hono on Node 22). Build context = repo root.
#
# NB: l'API gira in produzione via `tsx` (come lo script `dev`), NON via
# `node dist/index.js`. Motivo: `tsc` emette import ESM SENZA estensione `.js`
# (tsconfig moduleResolution: bundler), quindi `dist/` non è eseguibile da Node
# puro (ERR_MODULE_NOT_FOUND). `tsx` (esbuild) risolve gli import estensionless.
# Vedi docs/go-live-audit/REPORT-06-deploy.md (finding DP-12).

FROM node:22-alpine AS base
# pnpm pinnato: senza packageManager nel package.json, corepack userebbe una
# versione arbitraria che cambia il comportamento su ERR_PNPM_IGNORED_BUILDS.
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /app

# --- deps: install del workspace pnpm (bcrypt nativo richiede toolchain) ---
FROM base AS deps
RUN apk add --no-cache python3 make g++
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/admin/package.json ./apps/admin/
COPY apps/sito-v3/package.json ./apps/sito-v3/
COPY apps/mcp/package.json ./apps/mcp/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile

# --- runtime ---
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3001 \
    UPLOAD_DIR=/data/uploads \
    KB_DIR=/data/kb \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
# wget per l'healthcheck; chromium per Puppeteer (PDF preventivi/ricevute).
# /data/kb: dir scrivibile dove kb-bootstrap.ts scarica i knowledge base da S4
# (gitignored, non presenti nel build context).
RUN apk add --no-cache wget chromium nss freetype harfbuzz ca-certificates ttf-freefont \
    && mkdir -p /data/uploads /data/kb
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY apps/api/package.json apps/api/tsconfig.json ./apps/api/
COPY apps/api/src ./apps/api/src
WORKDIR /app/apps/api
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD wget -q --spider http://localhost:3001/api/health || exit 1
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
