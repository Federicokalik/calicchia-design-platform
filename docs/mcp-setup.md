# MCP Gestionale - Setup Claude Desktop / Claude Code

Questo documento spiega come collegare Claude Desktop o Claude Code al gestionale tramite il server MCP `@calicchia/mcp`.

## Cosa fa

Espone tutti i tool registrati in `apps/api/src/lib/agent/tools.ts` (lettura + scrittura su progetti, clienti, mail, appuntamenti `cal_bookings`, note, idee, ecc.) come tool MCP. Da Claude puoi dire:

- *"Mostrami i clienti con 'ACME' nel nome"* -> `get_customers`
- *"Prendimi un appuntamento con Mario Rossi venerdì alle 15"* -> `create_cal_booking`
- *"Imposta lo stato del cliente 42 a 'vip'"* -> `update_customer`
- *"Crea un'idea: testare il nuovo MCP"* -> `create_idea` (nota con tag `idea`)
- *"Che email ho scambiato con Rossi negli ultimi 30 giorni?"* -> `search_emails`

## Pre-requisiti

- `apps/api` deve essere in esecuzione (porta 3001).
- Il server MCP (`apps/mcp/dist/index.js`) deve essere buildato: `pnpm --filter @calicchia/mcp build`.

## Step 1 - Token

Il token MCP non si genera più da terminale e non si salva più in `.env` lato server.

1. Vai su `/impostazioni/mcp-tokens` nell'admin.
2. Crea un nuovo token con `label`, `scope` (`read`, `write`, `admin`) ed eventuale scadenza.
3. Copia subito il valore del token mostrato in risposta: è visibile una sola volta.
4. Usa quel valore come `MCP_SERVICE_TOKEN` nell'ambiente del client (Claude Desktop o Claude Code).

## Step-up OTP via Telegram

Quando Claude prova a eseguire un tool ad alto rischio (`send_email` o `send_whatsapp`):

1. Ricevi un OTP su Telegram.
2. Comunica il codice a Claude.
3. Claude chiama il tool `mcp_unlock` con l'OTP.
4. Lo sblocco resta valido 5 minuti per il token corrente.
5. Claude ripete l'azione iniziale.

## Step 2a - Claude Code (in questa repo)

Il file `.mcp.json` nella root è già configurato. Al primo avvio in questa directory, Claude Code chiederà il permesso di attivare il server `caldes`. Accettalo.

Il token viene letto dall'env del processo (`$MCP_SERVICE_TOKEN`). Su Windows PowerShell:

```powershell
$env:MCP_SERVICE_TOKEN = "<token-creato-da-/impostazioni/mcp-tokens>"
claude-code
```

Oppure usa uno strumento tipo `direnv` / `dotenv-cli` per caricare variabili automaticamente.

## Step 2b - Claude Desktop

Modifica il file `claude_desktop_config.json`:

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

Aggiungi:

```json
{
  "mcpServers": {
    "caldes": {
      "command": "node",
      "args": [
        "C:\\Users\\calicchiadesign\\Desktop\\Sito & Gestionale\\apps\\mcp\\dist\\index.js"
      ],
      "env": {
        "API_URL": "http://localhost:3001",
        "MCP_SERVICE_TOKEN": "<token-creato-da-/impostazioni/mcp-tokens>"
      }
    }
  }
}
```

Riavvia Claude Desktop. In basso comparirà l'icona "🔌" con il server `caldes` connesso e i tool disponibili.

## HTTPS in produzione

Per Claude Desktop / Claude Code locale basta esporre `apps/api`.
Per Claude.ai / ChatGPT.com serve invece il gateway remoto `apps/mcp` in
modalita Streamable HTTP.

Endpoint previsto:

```text
https://mcp.calicchia.design/mcp
```

Il servizio `mcp` ascolta su `3002` e inoltra tutte le chiamate a `apps/api`
tramite `API_URL`. Non accede direttamente al database.

Autenticazione v1:

- preferito: `Authorization: Bearer <token-creato-da-/impostazioni/mcp-tokens>`
- fallback: `X-MCP-Service-Token`
- fallback per client senza header statici: query string `?token=...`

Fallback GPT Actions:

- schema OpenAPI: `https://mcp.calicchia.design/openapi.json`
- endpoint azioni: `https://mcp.calicchia.design/api/mcp/execute`
- stesso token MCP in Bearer auth

Esempio minimo con Caddy per esporre `apps/api` e `apps/mcp` in HTTPS:

```caddy
api.tuodominio.com {
  reverse_proxy localhost:3001
}

mcp.tuodominio.com {
  reverse_proxy localhost:3002
}
```

## Verifica

Quando apri una conversazione:

1. **Lista tool**: Claude dovrebbe elencare i tool `caldes` disponibili.
2. **Chiamata read**: *"Elencami gli appuntamenti dei prossimi 7 giorni"* -> Claude chiama `list_cal_bookings`.
3. **Chiamata high-risk**: *"Invia una mail a ..."* -> Claude riceve `needs_otp`, poi usa `mcp_unlock` e riprova.

## Sicurezza

- `MCP_SERVICE_TOKEN` resta una credenziale sensibile lato client.
- Non committarlo: `.env` è in `.gitignore`.
- Claude Desktop mostra un prompt di approvazione per ogni tool call.

## Troubleshooting

**"0 tool nel badge 🔌"** -> API non raggiungibile su `API_URL` oppure token assente/errato nel client.

**"Errore 401 Non autorizzato"** -> token errato, revocato o scaduto.

**"needs_otp=true"** -> usa `mcp_unlock` con il codice Telegram, poi ripeti il tool high-risk.
