# syntax=docker/dockerfile:1
# Production image — @calicchia/sito-v3 (Next.js 16, standalone output).
# Build context = repo root. NEXT_PUBLIC_* must be passed as build args:
# Next inlines them at build time.

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
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY
ARG NEXT_PUBLIC_GOOGLE_MAPS_KEY
ARG NEXT_PUBLIC_BUGSINK_DSN
ARG NEXT_PUBLIC_GA_MEASUREMENT_ID
ARG PUBLIC_SITE_URL
ARG GOOGLE_SITE_VERIFICATION
# NB: PORTAL_API_URL NON viene passato in build di proposito. sitemap.ts fa
# fetch verso l'API per progetti/blog; in build l'API non è raggiungibile e il
# fetch va in timeout (60s ×3) facendo fallire `next build`. Senza la var,
# apiBase() resta su localhost e shouldSkipLocalApiFetch() salta il fetch:
# la sitemap viene generata con le sole route statiche. Le URL dinamiche
# (progetti, blog) richiedono un rebuild con API raggiungibile, oppure il fix
# di sitemap.ts per renderlo runtime/resiliente (vedi audit ST-07 / CX-S2-04).
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY \
    NEXT_PUBLIC_GOOGLE_MAPS_KEY=$NEXT_PUBLIC_GOOGLE_MAPS_KEY \
    NEXT_PUBLIC_BUGSINK_DSN=$NEXT_PUBLIC_BUGSINK_DSN \
    NEXT_PUBLIC_GA_MEASUREMENT_ID=$NEXT_PUBLIC_GA_MEASUREMENT_ID \
    PUBLIC_SITE_URL=$PUBLIC_SITE_URL \
    GOOGLE_SITE_VERIFICATION=$GOOGLE_SITE_VERIFICATION \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production
COPY apps/sito-v3 ./apps/sito-v3
COPY packages/shared ./packages/shared
RUN pnpm --filter @calicchia/sito-v3 build

FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN apk add --no-cache wget
# Next.js standalone output preserves the monorepo path layout.
COPY --from=builder /app/apps/sito-v3/.next/standalone ./
COPY --from=builder /app/apps/sito-v3/.next/static ./apps/sito-v3/.next/static
COPY --from=builder /app/apps/sito-v3/public ./apps/sito-v3/public
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q --spider http://localhost:3000/ || exit 1
CMD ["node", "apps/sito-v3/server.js"]
