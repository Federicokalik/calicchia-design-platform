# @calicchia/mcp

MCP gateway del gestionale. Espone i tool di `apps/api/src/lib/agent/tools.ts`
senza accedere direttamente al database.

## Modalita

### stdio locale

Per Claude Desktop / Claude Code:

```bash
pnpm --filter @calicchia/mcp build
MCP_SERVICE_TOKEN="mcp_..." API_URL="http://localhost:3001" pnpm --filter @calicchia/mcp start
```

`MCP_SERVICE_TOKEN` e' un token creato da admin in
`/impostazioni/mcp-tokens`.

### Streamable HTTP remoto

Per connector remoti:

```bash
pnpm --filter @calicchia/mcp dev:http
```

Endpoint locali:

- `GET http://localhost:3002/health`
- `POST http://localhost:3002/mcp`
- `GET http://localhost:3002/mcp` per SSE stream di sessione
- `DELETE http://localhost:3002/mcp` per chiusura sessione
- `GET http://localhost:3002/openapi.json` fallback GPT Actions
- `GET/POST http://localhost:3002/api/mcp/*` fallback OpenAPI verso `apps/api`

Autenticazione v1:

- header preferito: `Authorization: Bearer mcp_...`
- fallback operativo: `X-MCP-Service-Token: mcp_...`
- fallback per client che non supportano header statici: `?token=mcp_...`

Il gateway inoltra il token ad `apps/api`, che valida revoca, scadenza, scope,
rate limit, OTP e audit.

## Produzione

Immagine: `ghcr.io/federicokalik/calicchia-mcp`.

Env principali:

```env
MCP_TRANSPORT=http
PORT=3002
API_URL=http://api:3001
MCP_PUBLIC_URL=https://mcp.calicchia.design
MCP_ALLOWED_HOSTS=mcp.calicchia.design
```

Reverse proxy pubblico: `https://mcp.calicchia.design` -> servizio/porta `3002`.

## Prompt MCP

Il server espone anche prompt riusabili:

- `daily_brief`
- `client_context`
- `pipeline_review`
