# syntax=docker/dockerfile:1
# Production image - @calicchia/mcp (Streamable HTTP MCP gateway on Node 22).

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/mcp/package.json ./apps/mcp/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY apps/mcp/tsconfig.json ./apps/mcp/
COPY apps/mcp/src ./apps/mcp/src
RUN pnpm --filter @calicchia/mcp build

FROM base AS runtime
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    PORT=3002 \
    API_URL=http://api:3001 \
    MCP_PUBLIC_URL=https://mcp.calicchia.design \
    MCP_ALLOWED_HOSTS=mcp.calicchia.design
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/mcp/node_modules ./apps/mcp/node_modules
COPY --from=build /app/apps/mcp/package.json ./apps/mcp/package.json
COPY --from=build /app/apps/mcp/dist ./apps/mcp/dist
WORKDIR /app/apps/mcp
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://localhost:3002/health || exit 1
CMD ["node", "dist/index.js", "http"]
