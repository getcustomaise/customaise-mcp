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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools, registerPromptsAndResources } from './server.js';
import { createBridge } from './bridge.js';
import { FileWatcher } from './file-watcher.js';

// Single source of truth for the server version: the package.json this
// file was shipped alongside. Compiled `dist/index.js` resolves
// `../package.json` relative to itself, which always lands on the
// package root (npm always ships package.json). Prevents the version
// drift bug where index.ts hardcoded `1.0.3` while package.json was 1.2.0.
const PKG_VERSION: string = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, '..', 'package.json');
  return JSON.parse(readFileSync(pkgPath, 'utf-8')).version;
})();

// ─── Server Instructions ─────────────────────────────────────────────────────
// Sent to AI agents during the MCP initialize handshake.
// Modelled after the persona narratives in specialist-roster.js:
//   # Role → # Mission → # Foundations → # Workflow → # Tooling → # Output
const SERVER_INSTRUCTIONS = `
# Role
- You are a Script Engineer working with Customaise, a Chrome extension that manages userscripts and WebMCP agents.
- You create, edit, and debug scripts that run securely within the user's browser sandbox.

# Script Types
Customaise supports two distinct paradigms. Your structural formatting depends entirely on what the user is asking for.
**CRITICAL:** You must read the specific conventions handbook before building either type.
1. **UserScripts** (Traditional DOM manipulation): Read \`customaise://userscript-conventions\`
2. **AgentScripts** (WebMCP tool injection): Read \`customaise://agentscript-conventions\`

# General Workflow
1. **Understand:** Use \`get_page_context\` to inspect the target page's DOM, visible elements, and \`dom_*\` IDs.
2. **Write:** Create the script in the workspace directory (e.g., \`./customaise-scripts/\`). Never use \`/tmp\`.
3. **Install:** Use \`export_script\` to push the script into Customaise. It validates through a strict sanitization pipeline.
4. **Test:** Use \`reload_tab\` to re-inject the updated script on the target page.
5. **Verify:** Use \`get_console_context\` to check for runtime errors, or use \`list_webmcp_tools\` to confirm agent availability.
6. **Iterate:** If the pipeline returns validation errors or the console shows runtime errors, fix the file locally and re-export.

# Shared / Subscribed Scripts
- Some scripts in \`list_scripts\` have \`isShared: true\`. These are **read-only subscriptions** via Customaise Cloud.
- You **cannot** import, edit, or overwrite these via MCP.
- If the user wants to augment a shared script, instruct them to open the Customaise UI and click "Unlock & Fork" to create an editable clone.

# User Selections & Context
When a user asks you to interact with specific page elements:
1. **Check for manual selections:** Use \`get_selected_elements\`. The user may have explicitly clicked elements to target.
2. **Check the workspace:** Look for \`.dom.md\` files in \`.customaise/dom-context/\` (auto-pushed when users select elements visually).
3. If selections exist, use their \`domId\` values with Customaise's robust \`VM_findElement\` targeting API.
4. If no selections exist, ask the user to select elements via the Customaise UI DOM Selector tool, or fall back to standard CSS selectors.
`.trim();

const WS_PORT = Number(process.env.CUSTOMAISE_WS_PORT || process.env.VIBEMONKEY_WS_PORT) || 4050;

async function main(): Promise<void> {
  // 1. Create the bridge. Leader role if port is free; follower role if
  //    another customaise-mcp process already owns :WS_PORT. Either way
  //    the rest of the setup is identical — server.ts and file-watcher
  //    use the same Bridge interface.
  const bridge = await createBridge(WS_PORT);

  // 2. Create the MCP server
  const server = new McpServer(
    {
      name: 'customaise',
      version: PKG_VERSION
    },
    {
      instructions: SERVER_INSTRUCTIONS,
      // Only advertise capabilities we actually register. The server
      // exposes tools and resources; no prompts are registered today.
      // Advertising `prompts: {}` caused clients to list an empty
      // `prompts/list` and expose a misleading "no prompts" UI.
      capabilities: {
        tools: {},
        resources: {}
      }
    }
  );

  // 3. Create file watcher for sync_scripts auto-export
  const fileWatcher = new FileWatcher(bridge);

  // 4. Register tools, prompts, and resources
  registerTools(server, bridge, fileWatcher);
  registerPromptsAndResources(server, bridge);

  // 5. Connect via stdio transport (AI agent communicates over stdin/stdout)
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 6. Once the IDE completes MCP initialize, capture its clientInfo
  //    (name + version) and register it with the bridge so the
  //    extension UI can surface "connected IDE: Cursor 0.42.0" in the
  //    sidebar. For followers, this info is forwarded to the leader
  //    over the peer channel; for the leader, it feeds directly into
  //    the hello frame sent to the extension.
  const underlyingServer = (server as any).server;
  if (underlyingServer && typeof underlyingServer === 'object') {
    const prev = underlyingServer.oninitialized;
    underlyingServer.oninitialized = () => {
      try {
        if (typeof prev === 'function') prev();
      } catch { /* ignore */ }
      try {
        const clientInfo = typeof underlyingServer.getClientVersion === 'function'
          ? underlyingServer.getClientVersion()
          : null;
        if (clientInfo && typeof clientInfo.name === 'string') {
          bridge.setOwnClientInfo({
            name: clientInfo.name,
            version: typeof clientInfo.version === 'string' ? clientInfo.version : 'unknown',
          });
        }
      } catch (err: any) {
        process.stderr.write(`[customaise-mcp] Could not read clientInfo: ${err?.message || err}\n`);
      }
    };
  }

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
