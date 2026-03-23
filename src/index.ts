#!/usr/bin/env node

/**
 * Customaise MCP Server — Entry Point
 *
 * Connects AI coding agents (Cursor, Antigravity, Claude Code) to the
 * Customaise Chrome extension via the Model Context Protocol.
 *
 * Transport:
 *   AI Agent ←(stdio)→ MCP Server ←(WebSocket)→ Chrome Extension
 *
 * Usage:
 *   node dist/index.js
 *
 * Environment:
 *   CUSTOMAISE_WS_PORT  — WebSocket server port (default: 4050)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools, registerPromptsAndResources } from './server.js';
import { ExtensionBridge } from './extension-bridge.js';
import { FileWatcher } from './file-watcher.js';

const WS_PORT = Number(process.env.CUSTOMAISE_WS_PORT || process.env.VIBEMONKEY_WS_PORT) || 4050;

async function main(): Promise<void> {
  // 1. Start the WebSocket server for the extension to connect to
  const bridge = new ExtensionBridge(WS_PORT);
  await bridge.start();

  // 2. Create the MCP server
  const server = new McpServer(
    {
      name: 'customaise',
      version: '1.0.0'
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
        resources: {}
      }
    }
  );

  // 3. Create file watcher for sync_scripts auto-export
  const fileWatcher = new FileWatcher(bridge);

  // 4. Register tools, prompts, and resources
  registerTools(server, bridge, fileWatcher);
  registerPromptsAndResources(server, bridge);

  // 4. Connect via stdio transport (AI agent communicates over stdin/stdout)
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write('[customaise-mcp] MCP server running (stdio + WebSocket)\n');

  // Graceful shutdown
  const shutdown = async () => {
    process.stderr.write('[customaise-mcp] Shutting down...\n');
    fileWatcher.stop();
    await bridge.close();
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`[customaise-mcp] Fatal error: ${err.message}\n`);
  process.exit(1);
});
