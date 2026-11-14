# @calicchia/mcp

MCP gateway del gestionale (SDK `@modelcontextprotocol/server` v2). Serve il
protocollo **2026-07-28** (stateless, senza `initialize` né `Mcp-Session-Id`,
`server/discover`, `input_required`) e, dallo stesso endpoint, i client 2025
(handshake `initialize`, serviti in modo stateless). Non accede al database:
inoltra tutto ad `apps/api`.

Espone:

- i tool curati di `apps/api/src/lib/agent/tools.ts` (con `title` e `annotations`);
- `api_catalog` + `api_request`: accesso a **tutte le route admin** del gestionale,
  con gli stessi permessi della UI (vedi sotto);
- `mcp_unlock` (solo scope admin) e i prompt riusabili.

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
- `POST http://localhost:3002/mcp` (stateless: ogni richiesta è servita da un'istanza nuova)
- `GET http://localhost:3002/openapi.json` fallback GPT Actions
- `GET/POST http://localhost:3002/api/mcp/*` fallback OpenAPI verso `apps/api`

Autenticazione v1:

- header preferito: `Authorization: Bearer mcp_...`
- fallback operativo: `X-MCP-Service-Token: mcp_...`
- fallback per client che non supportano header statici: `?token=mcp_...`

Il gateway inoltra il token ad `apps/api`, che valida revoca, scadenza, scope,
rate limit, OTP e audit.

## Parità con la UI: `api_catalog` / `api_request`

`api_request({ method, path, query?, body?, multipart? })` esegue in-process una
route admin di `apps/api` con l'identità dell'admin (`MCP_ACTING_USER_EMAIL`,
default il primo admin). Policy in `apps/api/src/lib/mcp/api-policy.ts`:

| Scope token | Consentito |
|---|---|
| `read` | solo `GET` |
| `write` | `GET`, `POST`, `PUT`, `PATCH` non ad alto rischio |
| `admin` | tutto; alto rischio con OTP Telegram (step-up 5 min) |

Alto rischio: ogni `DELETE` e le azioni verso l'esterno (invii email/WhatsApp/campagne,
preventivi e firme, pubblicazioni, pagamenti e sync Stripe/PayPal, import, impostazioni,
esecuzione workflow). Mai raggiungibili: token MCP, auth, backup, CalDAV/device token, chiavi API.
Ogni chiamata è in `audit_logs` (`table_name = 'mcp_call'`, tool `api_request:<METHOD> <path>`).

OTP: sui client 2026-07-28 che dichiarano `elicitation` (e su stdio) il codice viene
chiesto direttamente durante la chiamata (`input_required`); altrimenti il tool risponde
`needs_otp` e il modello usa `mcp_unlock`.

## Smoke

```bash
MCP_SMOKE_TOKEN=mcp_read... MCP_SMOKE_ADMIN_TOKEN=mcp_admin... pnpm --filter @calicchia/mcp smoke
```

Controlla era 2026 e 2025, `tools/list`, `api_catalog`, `api_request` e il flusso OTP.

## Produzione

Immagine: `ghcr.io/federicokalik/calicchia-mcp`.

Env principali:

```env
MCP_TRANSPORT=http
PORT=3002
API_URL=http://api:3001
MCP_PUBLIC_URL=https://mcp.calicchia.design
MCP_ALLOWED_HOSTS=mcp.calicchia.design
# opzionale: HMAC (>=32 byte) del requestState OTP; vuota = chiave effimera di processo
MCP_REQUEST_STATE_SECRET=
```

Reverse proxy pubblico: `https://mcp.calicchia.design` -> servizio/porta `3002`.

## Prompt MCP

Il server espone anche prompt riusabili:

- `daily_brief`
- `client_context`
- `pipeline_review`
- `invoice_followup`
- `content_publish`
- `campaign_review`
