# syntax=docker/dockerfile:1
# Production image — @calicchia/worker (headful capture worker, Fase 3).
# Build context = repo root (same as apps/api + apps/admin — the deps stage
# copies every workspace package.json so pnpm can resolve the workspace).
#
# Based on node:22-bookworm-slim (NOT alpine) because we need Chromium + xvfb
# + x11vnc + noVNC (websockify) + CJK/emoji fonts to render login-protected
# sites faithfully. Adds ~400MB vs the alpine API image — that's the whole
# reason this is a separate worker (see apps/worker/README.md).
#
# Runtime: tsx (esbuild) in production, like apps/api — tsc emits
# extensionless ESM imports that Node can't resolve (tsconfig moduleResolution:
# bundler, see apps/api/Dockerfile finding DP-12).

FROM node:22-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /app

# --- deps: full pnpm workspace install (only package.json + lockfile) ----
# The root .npmrc + root package.json `onlyBuiltDependencies` allowlist blocks
# puppeteer's postinstall (Chromium download) — we use the system chromium
# installed in the runtime stage instead, like apps/api.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json ./apps/api/
COPY apps/admin/package.json ./apps/admin/
COPY apps/sito-v3/package.json ./apps/sito-v3/
COPY apps/mcp/package.json ./apps/mcp/
COPY apps/worker/package.json ./apps/worker/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile

# --- runtime -------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    DISPLAY=:99 \
    UPLOAD_DIR=/data/uploads \
    CAPTURE_PROFILES_DIR=/data/profiles

# Chromium (headful rendering), xvfb (display), x11vnc + novnc + websockify
# (noVNC bridge so the admin sees & drives the browser remotely), fonts for
# faithful rendering of IT/EU/CJK/emoji sites.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      xvfb \
      x11vnc \
      novnc \
      websockify \
      fonts-liberation \
      fonts-noto-color-emoji \
      fonts-noto-cjk \
      procps \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data/uploads /data/profiles

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY apps/worker/package.json apps/worker/tsconfig.json ./apps/worker/
COPY apps/worker/src ./apps/worker/src

WORKDIR /app/apps/worker

# Xvfb in background (single shared :99 display), then the polling worker.
# The worker spawns x11vnc + websockify per-session as needed.
# No HEALTHCHECK: the worker exposes no port of its own while idle (websockify
# only listens during an open session), so `restart: always` in compose is the
# liveness signal.
CMD ["sh", "-c", "Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp & sleep 1 && pnpm exec tsx src/index.ts"]