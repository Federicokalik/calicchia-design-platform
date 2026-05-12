# @caldes/mcp

MCP server che espone i tool del gestionale (`apps/api/src/lib/agent/tools.ts`) a Claude Desktop / Claude Code via stdio.

## Come funziona

1. Claude Desktop spawna `node apps/mcp/dist/index.js` come processo stdio.
2. Alla `tools/list` request, il server chiama `GET /api/mcp/tools` su `apps/api` (autenticazione via `Authorization: Bearer $MCP_SERVICE_TOKEN`) e restituisce la lista.
3. Alla `tools/call` request, inoltra `POST /api/mcp/execute` e restituisce il risultato come contenuto testuale.

## Setup

1. Genera un token random: `openssl rand -hex 32` (o `[System.Guid]::NewGuid().ToString('N')` su PowerShell).
2. Aggiungi a `.env` (root monorepo): `MCP_SERVICE_TOKEN=<token>`.
3. Riavvia `apps/api`.
4. Build: `pnpm --filter @caldes/mcp build`.
5. Configura Claude Desktop (vedi `docs/mcp-setup.md`).

## Dev

```bash
pnpm --filter @caldes/mcp dev
```

Gira in stdio mode — utile solo per test con un client MCP locale.
