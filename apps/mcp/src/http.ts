import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createProxyServer } from './proxy-server.js';

const DEFAULT_PORT = 3002;
const API_URL = (process.env.API_URL || 'http://localhost:3001').replace(/\/$/, '');

type AuthedRequest = IncomingMessage & { auth?: AuthInfo };

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}


function setCors(res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  // 2026-07-28: standard request headers (SEP-2243) + Mcp-Protocol-Version.
  // Mcp-Session-Id stays allowed so 2025-era clients that still send it are
  // not blocked by preflight (stateless serving simply ignores it).
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization,Content-Type,Accept,Mcp-Protocol-Version,Mcp-Method,Mcp-Name,Mcp-Session-Id,X-MCP-Service-Token'
  );
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Protocol-Version');
}

function allowedHosts(): Set<string> {
  return new Set(
    (process.env.MCP_ALLOWED_HOSTS || 'localhost,127.0.0.1,::1')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
  );
}

function isHostAllowed(req: IncomingMessage): boolean {
  const allowed = allowedHosts();
  if (allowed.size === 0) return true;
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  return allowed.has(host);
}

function extractToken(req: IncomingMessage, url: URL): string {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();

  const headerToken = req.headers['x-mcp-service-token'];
  if (typeof headerToken === 'string') return headerToken.trim();

  return url.searchParams.get('token') || url.searchParams.get('mcp_token') || '';
}

function attachAuth(req: AuthedRequest, token: string) {
  req.auth = {
    token,
    clientId: 'mcp-token',
    scopes: token.startsWith('mcp_') ? ['mcp'] : [],
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return undefined;
  return JSON.parse(raw);
}

function openApiDocument(publicUrl: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Caldes Gestionale MCP Actions',
      version: '1.0.0',
      description: 'Fallback OpenAPI per GPT Actions. Le operazioni sono inoltrate ad apps/api via token MCP.',
    },
    servers: [{ url: publicUrl.replace(/\/$/, '') }],
    components: {
      securitySchemes: {
        mcpBearer: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'mcp_<token>',
        },
      },
    },
    security: [{ mcpBearer: [] }],
    paths: {
      '/api/mcp/tools': {
        get: {
          operationId: 'listMcpTools',
          summary: 'Lista i tool MCP disponibili per il token corrente',
          responses: {
            '200': { description: 'Lista tool filtrata per scope' },
          },
        },
      },
      '/api/mcp/execute': {
        post: {
          operationId: 'executeMcpTool',
          summary: 'Esegue un tool MCP del gestionale',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: { type: 'string', description: 'Nome tool MCP' },
                    args: {
                      type: 'object',
                      additionalProperties: true,
                      description: 'Argomenti del tool',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Risultato tool MCP' },
            '401': { description: 'Token mancante, non valido o OTP richiesta' },
            '403': { description: 'Scope insufficiente' },
            '429': { description: 'Rate limit' },
          },
        },
      },
    },
  };
}

async function forwardApiRequest(req: AuthedRequest, res: ServerResponse, path: '/api/mcp/tools' | '/api/mcp/execute') {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${req.auth!.token}`,
  };
  let body: string | undefined;

  if (req.method === 'POST') {
    const parsed = await readJsonBody(req);
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(parsed ?? {});
  }

  const upstream = await fetch(`${API_URL}${path}`, {
    method: req.method,
    headers,
    body,
  });
  const textBody = await upstream.text();
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'application/json',
  });
  res.end(textBody);
}

export async function startHttpServer() {
  const port = Number.parseInt(process.env.PORT || process.env.MCP_PORT || String(DEFAULT_PORT), 10);
  // Stateless per-request serving: 2026-07-28 traffic (no initialize, no
  // Mcp-Session-Id) plus 2025-era traffic through the stateless legacy leg.
  // createMcpHandler validates neither Host nor Origin: the host allowlist
  // below runs in front of it.
  const mcpHandler = createMcpHandler(
    ({ era }) => createProxyServer({ canRoundTrip: era === 'modern' }),
    { legacy: 'stateless' }
  );
  const nodeHandler = toNodeHandler(mcpHandler, {
    onerror: (err) => console.error('[caldes-mcp] MCP handler error:', err),
  });

  const server = createServer(async (req: AuthedRequest, res) => {
    setCors(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const publicUrl = process.env.MCP_PUBLIC_URL || `http://localhost:${port}`;
    const url = new URL(req.url || '/', publicUrl);

    if (url.pathname === '/health') {
      json(res, 200, {
        status: 'ok',
        service: 'caldes-mcp',
        transport: 'streamable-http',
        endpoint: '/mcp',
      });
      return;
    }

    if (url.pathname === '/openapi.json') {
      json(res, 200, openApiDocument(publicUrl));
      return;
    }

    if (url.pathname !== '/mcp' && url.pathname !== '/api/mcp/tools' && url.pathname !== '/api/mcp/execute') {
      json(res, 404, { code: 'not_found', error: 'Not Found' });
      return;
    }

    if (!isHostAllowed(req)) {
      json(res, 403, { code: 'host_denied', error: 'Host non autorizzato' });
      return;
    }

    const token = extractToken(req, url);
    if (!token || !token.startsWith('mcp_')) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="caldes-mcp"');
      json(res, 401, { code: 'invalid_token', error: 'Token MCP richiesto' });
      return;
    }
    attachAuth(req, token);

    try {
      if (url.pathname === '/api/mcp/tools') {
        if (req.method !== 'GET') {
          json(res, 405, { code: 'method_not_allowed', error: 'Metodo non supportato' });
          return;
        }
        await forwardApiRequest(req, res, '/api/mcp/tools');
        return;
      }

      if (url.pathname === '/api/mcp/execute') {
        if (req.method !== 'POST') {
          json(res, 405, { code: 'method_not_allowed', error: 'Metodo non supportato' });
          return;
        }
        await forwardApiRequest(req, res, '/api/mcp/execute');
        return;
      }

      // /mcp — every method (POST requests, GET/DELETE answered by the SDK)
      // goes to the per-request handler; req.auth is forwarded as authInfo.
      await nodeHandler(req, res);
      return;
    } catch (err) {
      console.error('[caldes-mcp] HTTP transport error:', err);
      if (!res.headersSent) {
        json(res, 500, { code: 'internal_error', error: 'Internal Server Error' });
      } else {
        res.end();
      }
    }
  });

  server.listen(port, () => {
    console.error(`[caldes-mcp] HTTP server avviato, port=${port}, API_URL=${process.env.API_URL || 'http://localhost:3001'}`);
  });

  async function shutdown(signal: string) {
    console.error(`[caldes-mcp] ${signal} ricevuto, chiusura...`);
    await Promise.resolve(mcpHandler.close()).catch((err: unknown) => {
      console.error('[caldes-mcp] errore chiusura handler MCP:', err);
    });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
