# syntax=docker/dockerfile:1
# Production image — @caldes/admin (React + Vite SPA, served by nginx).
# Build context = repo root.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/admin/package.json ./apps/admin/
COPY apps/sito-v3/package.json ./apps/sito-v3/
COPY apps/mcp/package.json ./apps/mcp/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile

FROM deps AS builder
ARG PUBLIC_BUGSINK_DSN
ARG VITE_BUGSINK_DSN
ARG VITE_API_URL
ENV PUBLIC_BUGSINK_DSN=$PUBLIC_BUGSINK_DSN \
    VITE_BUGSINK_DSN=$VITE_BUGSINK_DSN \
    VITE_API_URL=$VITE_API_URL \
    NODE_ENV=production
COPY apps/admin ./apps/admin
COPY packages/shared ./packages/shared
RUN pnpm --filter @caldes/admin build

FROM nginx:alpine AS runtime
COPY apps/admin/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/admin/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q --spider http://localhost/ || exit 1
CMD ["nginx", "-g", "daemon off;"]
