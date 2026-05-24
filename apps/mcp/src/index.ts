#!/usr/bin/env node
/**
 * @calicchia/mcp
 *
 * - stdio mode: local Claude Desktop / Claude Code bridge.
 * - http mode: remote Streamable HTTP MCP endpoint for web clients.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startHttpServer } from './http.js';
import { createProxyServer } from './proxy-server.js';

const mode = process.env.MCP_TRANSPORT || process.env.MCP_MODE || process.argv[2] || 'stdio';

async function startStdioServer() {
  const token = process.env.MCP_SERVICE_TOKEN || '';
  if (!token) {
    console.error("[caldes-mcp] MCP_SERVICE_TOKEN mancante: configura il token nell'env del server MCP.");
    process.exit(1);
  }

  const server = createProxyServer({ defaultToken: token });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[caldes-mcp] stdio server avviato, API_URL=${process.env.API_URL || 'http://localhost:3001'}`);
}

if (mode === 'http' || mode === 'streamable-http') {
  await startHttpServer();
} else if (mode === 'stdio') {
  await startStdioServer();
} else {
  console.error(`[caldes-mcp] MCP_TRANSPORT non supportato: ${mode}`);
  process.exit(1);
}
