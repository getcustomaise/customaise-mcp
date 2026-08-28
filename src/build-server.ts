/**
 * Server factory — the single definition of what a Customaise MCP server is.
 *
 * Both entry points use it and neither owns it: `index.ts` serves it over
 * stdio to an IDE, and `daemon.ts` serves it over a loopback HTTP endpoint
 * to the CLI. One factory means one tool surface, one set of instructions,
 * and no chance of the two doors drifting apart.
 *
 * THE FACTORY MUST NOT ALLOCATE. It is called per connection by
 * `serveStdio`, and per request by `createMcpHandler` (measured at twice per
 * CLI invocation: once for the `server/discover` probe, once for the
 * `tools/call`). The bridge and the file watcher are constructed once by the
 * caller and passed in here; moving either inside would open a WebSocket to
 * the extension on every request and orphan a watcher on every
 * `sync_scripts`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import type { PushTarget } from './server.js';
import { registerTools, registerPromptsAndResources } from './server.js';
import { installToolEnvelope } from './tool-envelope.js';
import type { Bridge } from './bridge.js';
import type { FileWatcher } from './file-watcher.js';

// Single source of truth for the server version: the package.json this
// file was shipped alongside. Compiled output resolves `../package.json`
// relative to itself, which always lands on the package root (npm always
// ships package.json). Prevents the version drift bug where index.ts
// hardcoded `1.0.3` while package.json was 1.2.0.
const PKG_VERSION: string = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, '..', 'package.json');
  return JSON.parse(readFileSync(pkgPath, 'utf-8')).version;
})();

// ─── Server Instructions ─────────────────────────────────────────────────────
// Delivered through `initialize` on 2025-11-25 and through `server/discover`
// on 2026-07-28. Verified reaching the client on both.
// Modelled after the persona narratives in specialist-roster.js:
//   # Role → # Mission → # Foundations → # Workflow → # Tooling → # Output
const SERVER_INSTRUCTIONS = `
# Role
- You are a Script Engineer working with Customaise, a Chrome extension that manages userscripts and WebMCP agents.
- You create, edit, and debug scripts that run securely within the user's browser sandbox.

# If you also have a terminal
The same control surface is available as a CLI, so anything you can do here you
can do from a shell: \`npx -p @customaise/mcp customaise doctor\`. That matters
when you spawn a sub-agent that has a shell but no MCP client of its own, or when you
want the browser, the filesystem and the shell driven by one process. Run
\`customaise init\` in the project to write a primer the next agent can read.

# If you CANNOT read files
\`get_page_context\` and \`get_console_context\` default to writing their full payload
into \`.customaise/\` and returning a summary plus the path, which keeps a large DOM
snapshot out of your context window. That only works if you hold a tool that can open
a local file. If you do not (a chat client with no filesystem tool, for example),
pass \`output: "inline"\` and the whole payload comes back in the response with nothing
written to disk. \`take_screenshot\` takes the same flag: \`output: "inline"\` attaches
the image to the response instead of saving a PNG you cannot open. Do not keep calling
a tool whose file you cannot read; switch to
\`inline\` on the second call. The same applies to the \`.dom.md\` files mentioned below:
if you cannot open them, call \`get_selected_elements\`, which returns the selections
directly.

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
3. If selections exist, use their \`domId\` values with Customaise's robust \`CM_findElement\` targeting API.
4. If no selections exist, ask the user to select elements via the Customaise UI DOM Selector tool, or fall back to standard CSS selectors.
`.trim();

// Registration sets are fixed at build time, so their list results are
// cacheable for as long as the process lives. One hour is comfortably
// inside that and short enough that a client restart picks up a release.
const STATIC_LIST_TTL_MS = 60 * 60 * 1000;

const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';

export interface ServerFactoryDeps {
  bridge: Bridge;
  fileWatcher: FileWatcher;
  /**
   * Whether the first MCP client to identify itself becomes this process's
   * identity in the extension's client list. True for a stdio server, which
   * IS its IDE. False for the daemon, which has a fixed identity of its own
   * and serves many short-lived CLI invocations: without this, the first
   * `customaise` command renamed the resident process to `customaise-cli`
   * for the rest of its life, one line after the daemon had named itself.
   */
  reportClientIdentity?: boolean;
  /** Where to write a one-line note when a client is first identified. */
  log?: (line: string) => void;
  /**
   * The workspace unsolicited pushes should write into, or `undefined` if
   * this process has none.
   *
   * Pushes carry no request, so they cannot read a per-request workspace.
   * A stdio server always has one, its spawning IDE's directory, so it omits
   * this. A daemon has none until a CLI tells it where that caller is
   * standing, and until then it declines workspace-writing pushes rather
   * than scattering `.dom.md` files into whatever directory it happened to
   * be spawned from.
   *
   * Returns a reason instead of a directory whenever the answer is not
   * unambiguous, so the push handler can say why it declined rather than
   * guessing. Omitted entirely on stdio, where there is exactly one client
   * and one workspace and the question does not arise.
   */
  resolvePushTarget?: () => PushTarget;
}

/**
 * Build the factory. Call once per process; call the result per connection.
 */
export function createServerFactory(deps: ServerFactoryDeps): () => McpServer {
  const { bridge, fileWatcher } = deps;
  const log = deps.log ?? ((line: string) => process.stderr.write(line));

  /**
   * Report the connected client so the extension sidebar can name the IDE.
   * Two sources, mutually exclusive by era:
   *
   *   2025-11-25 → `getClientVersion()` on the low-level server, populated
   *                by the `initialize` handshake. `ctx.mcpReq.envelope` is
   *                null there.
   *   2026-07-28 → no handshake runs, `getClientVersion()` returns
   *                undefined, and identity rides `_meta` on every request.
   *
   * Neither works in both, so both branches exist. Shipping only the modern
   * one would blank the sidebar for every client that has not moved.
   */
  let clientInfoReported = deps.reportClientIdentity === false;
  const reportClientInfo = (info: unknown): void => {
    if (clientInfoReported) return;
    const candidate = info as { name?: unknown; version?: unknown } | null;
    if (!candidate || typeof candidate.name !== 'string') return;
    clientInfoReported = true;
    try {
      const version = typeof candidate.version === 'string' ? candidate.version : 'unknown';
      log(`[customaise-mcp] Connected client: ${candidate.name} ${version}\n`);
      bridge.setOwnClientInfo({ name: candidate.name, version });
    } catch (err: any) {
      log(`[customaise-mcp] Could not report clientInfo: ${err?.message || err}\n`);
    }
  };

  return function buildServer(): McpServer {
    const server = new McpServer(
      { name: 'customaise', version: PKG_VERSION },
      {
        instructions: SERVER_INSTRUCTIONS,
        // Only advertise capabilities we actually register. Advertising
        // `prompts: {}` caused clients to list an empty `prompts/list` and
        // expose a misleading "no prompts" UI.
        capabilities: { tools: {}, resources: {} },
        // Cache hints are per-endpoint, and getting them wrong is a
        // correctness bug rather than a performance one. The registration
        // sets never change at runtime, so they cache for an hour. But
        // `resources/read` is deliberately absent: it covers
        // `customaise://scripts`, the user's live script list, and a stale
        // copy means an agent writing against a library that no longer
        // exists. It keeps the SDK default of `ttlMs: 0`; the three static
        // handbooks opt in individually in server.ts. `cacheScope` defaults
        // to 'private' throughout, which is what two of these resources
        // carrying the user's own code require.
        cacheHints: {
          'tools/list': { ttlMs: STATIC_LIST_TTL_MS },
          'resources/list': { ttlMs: STATIC_LIST_TTL_MS },
          'resources/templates/list': { ttlMs: STATIC_LIST_TTL_MS },
          'server/discover': { ttlMs: STATIC_LIST_TTL_MS }
        }
      }
    );

    // One seam for both cross-cutting concerns: machine-readable errors and
    // modern-era client identity. Must run before registerTools.
    //
    // Consequence worth knowing about the identity half: on a 2026-07-28
    // connection the extension names the IDE on its first tool call rather
    // than at connect. Observing the transport would close that gap, but
    // `serveStdio` owns the transport and installs its own `onmessage`
    // after construction, so intercepting means fighting it for ownership.
    // The envelope also runs each handler inside the request context, so the
    // dispatch layer can read this call's abort signal and close a consent
    // modal the caller has walked away from.
    installToolEnvelope(server, { onClientInfo: reportClientInfo });

    // Identity from EVERY inbound request, not just tool calls.
    //
    // On 2026-07-28 there is no handshake; the client's name rides `_meta`
    // on each request. The envelope above reads it, but only for tools/call,
    // so a modern client that had listed tools and not yet called one was
    // invisible in the extension's sidebar: Claude Desktop, freshly started,
    // sends tools/list and resources/list and then waits for a human, and
    // its row was simply absent. Both doors hand the server a transport
    // through connect(), and the SDK installs its message handler on it
    // there, so this is the one place every request passes on both eras.
    const origConnect = server.connect.bind(server);
    (server as { connect: (t: unknown) => Promise<void> }).connect = async (transport: unknown) => {
      await origConnect(transport as Parameters<typeof origConnect>[0]);
      const t = transport as { onmessage?: (message: unknown, extra?: unknown) => void };
      const inner = t.onmessage;
      t.onmessage = (message: unknown, extra?: unknown) => {
        try {
          const info = (message as { params?: { _meta?: Record<string, unknown> } })?.params?._meta?.[CLIENT_INFO_META_KEY];
          if (info) reportClientInfo(info);
        } catch { /* a label, never a reason to drop a request */ }
        return inner?.(message, extra);
      };
    };

    // Register in NAME order, not source order.
    //
    // `tools/list` is cached for an hour (see cacheHints above). If the order
    // shifted between builds, a client's cached copy would differ from a fresh
    // one for no reason at all, and any consumer diffing the list would see
    // churn that means nothing. Source order is whatever happened to be
    // convenient when each tool was written; name order is stable by
    // construction.
    //
    // Collected and flushed rather than sorted after the fact, because the
    // SDK keeps `_registeredTools` private. The envelope is already installed,
    // so what is collected here is the wrapped handler, not the raw one.
    const pending: unknown[][] = [];
    const collector = new Proxy(server, {
      get(target, prop, receiver) {
        if (prop === 'registerTool') {
          return (...args: unknown[]) => { pending.push(args); };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    registerTools(collector as unknown as McpServer, bridge, fileWatcher, deps.resolvePushTarget);
    pending.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    for (const args of pending) {
      (server.registerTool as (...a: unknown[]) => unknown)(...args);
    }

    registerPromptsAndResources(server, bridge);

    // Legacy-era clientInfo. `oninitialized` never fires on a 2026-pinned
    // connection, which is exactly why the envelope branch exists.
    const underlyingServer = (server as any).server;
    if (underlyingServer && typeof underlyingServer === 'object') {
      const prev = underlyingServer.oninitialized;
      underlyingServer.oninitialized = () => {
        try { if (typeof prev === 'function') prev(); } catch { /* ignore */ }
        try {
          if (typeof underlyingServer.getClientVersion === 'function') {
            reportClientInfo(underlyingServer.getClientVersion());
          }
        } catch (err: any) {
          log(`[customaise-mcp] Could not read clientInfo: ${err?.message || err}\n`);
        }
      };
    }

    return server;
  };
}

export { PKG_VERSION, SERVER_INSTRUCTIONS };
