#!/usr/bin/env node

/**
 * Customaise MCP Server — stdio entry point.
 *
 * Connects AI coding agents (Cursor, Claude Code, Codex, Windsurf, Kiro,
 * Antigravity) to the Customaise Chrome extension.
 *
 * Transport:
 *   AI Agent ←(stdio)→ MCP Server ←(WebSocket)→ Chrome Extension
 *
 * Protocol:
 *   `serveStdio` negotiates the revision per connection. A client that has
 *   not moved gets 2025-11-25, the same revision this server spoke before
 *   the v2 migration; a 2026-capable client gets 2026-07-28. One binary,
 *   both eras, no flag day.
 *
 * The other door is `daemon.ts`, which serves the same factory over a
 * loopback endpoint for the CLI.
 *
 * Usage:
 *   node dist/index.js
 *
 * Environment:
 *   CUSTOMAISE_WS_PORT  — WebSocket server port (default: 4050; the staging
 *                         extension build dials 4150 so the two can run side
 *                         by side)
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createBridge } from './bridge.js';
import { FileWatcher } from './file-watcher.js';
import { createServerFactory, PKG_VERSION } from './build-server.js';
import { startDaemon } from './daemon.js';

const WS_PORT = Number(process.env.CUSTOMAISE_WS_PORT || process.env.VIBEMONKEY_WS_PORT) || 4050;

const HELP = `customaise-mcp ${PKG_VERSION} — MCP server for the Customaise Chrome extension

  customaise-mcp             serve MCP over stdio (what an IDE spawns)
  customaise-mcp daemon      run resident, serving the CLI over loopback
  customaise-mcp --version   print the version
  customaise-mcp --help      this text

Environment:
  CUSTOMAISE_WS_PORT    WebSocket port to the extension (default 4050).
                        The staging extension build dials 4150, so run
                        CUSTOMAISE_WS_PORT=4150 to drive that one instead.
  CUSTOMAISE_HTTP_PORT  loopback MCP port in daemon mode (default 4051)`;

/**
 * Argument handling comes first and exits without touching the bridge.
 *
 * The published install instructions have told every IDE flow to verify with
 * `npx -y @customaise/mcp --version`. With no argument handling that command
 * started a stdio server and hung the terminal with no output: the one step
 * meant to say "it worked" was the step that looked broken.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(PKG_VERSION + '\n');
    return;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP + '\n');
    return;
  }
  if (argv[0] === 'daemon') {
    await startDaemon({ watch: argv.includes('--watch') });
    return;
  }

  // Constructed once; the factory closes over them. See build-server.ts for
  // why this ordering is load-bearing rather than stylistic.
  const bridge = await createBridge(WS_PORT);
  const fileWatcher = new FileWatcher(bridge);

  const handle = serveStdio(createServerFactory({ bridge, fileWatcher }));

  process.stderr.write('[customaise-mcp] MCP server running (stdio + WebSocket)\n');

  const shutdown = async () => {
    process.stderr.write('[customaise-mcp] Shutting down...\n');
    fileWatcher.stop();
    await bridge.close();
    await handle.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`[customaise-mcp] Fatal error: ${err.message}\n`);
  process.exit(1);
});
