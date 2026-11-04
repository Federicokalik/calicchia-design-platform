#!/usr/bin/env node
/**
 * @calicchia/mcp
 *
 * - stdio mode: local Claude Desktop / Claude Code bridge.
 * - http mode: remote Streamable HTTP MCP endpoint for web clients.
 *
 * Both entries serve protocol revision 2026-07-28 and the 2025 era
 * (initialize handshake) from the same server factory.
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { startHttpServer } from './http.js';
import { createProxyServer } from './proxy-server.js';

const mode = process.env.MCP_TRANSPORT || process.env.MCP_MODE || process.argv[2] || 'stdio';

function startStdioServer() {
  const token = process.env.MCP_SERVICE_TOKEN || '';
  if (!token) {
    console.error("[caldes-mcp] MCP_SERVICE_TOKEN mancante: configura il token nell'env del server MCP.");
    process.exit(1);
  }

  // Connection-pinned: one server instance per stdio connection. The
  // persistent channel lets input_required reach 2025-era clients too.
  serveStdio(() => createProxyServer({ defaultToken: token, canRoundTrip: true }));
  console.error(`[caldes-mcp] stdio server avviato, API_URL=${process.env.API_URL || 'http://localhost:3001'}`);
}

if (mode === 'http' || mode === 'streamable-http') {
  await startHttpServer();
} else if (mode === 'stdio') {
  startStdioServer();
} else {
  console.error(`[caldes-mcp] MCP_TRANSPORT non supportato: ${mode}`);
  process.exit(1);
}
