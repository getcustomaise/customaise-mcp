/**
 * Bridge — the abstraction between the MCP server and the Customaise
 * Chrome extension. Two implementations:
 *
 *   - ExtensionBridge (leader):  runs the WebSocket server on port 4050,
 *                                accepts the extension as client, also
 *                                accepts other customaise-mcp processes
 *                                as followers.
 *   - RemoteBridge   (follower): connects to an existing ExtensionBridge
 *                                on port 4050 over WebSocket, proxies
 *                                all requests through it.
 *
 * Motivation: before this abstraction, every customaise-mcp process tried
 * to bind :4050 and any second instance died with EADDRINUSE, surfacing
 * as `MCP error -32000: Connection closed` in the losing IDE. That made
 * it impossible to run two agents (e.g. Cursor + Claude Code) against
 * the same extension. The factory below auto-detects who's leader and
 * who's a follower; the caller (index.ts / server.ts) doesn't care.
 */

import { ExtensionBridge } from './extension-bridge.js';
import { RemoteBridge } from './remote-bridge.js';

/**
 * Identifies which IDE spawned a customaise-mcp process. Captured from
 * MCP's initialize handshake (`params.clientInfo`) so the extension
 * UI can surface "you're connected to Cursor + Claude Code" to the
 * user. Pure metadata — not used for security decisions.
 */
export interface BridgeClientInfo {
  name: string;
  version: string;
}

export interface Bridge {
  /**
   * Become ready. For the leader: bind the WS port. For a follower:
   * connect to the leader. Rejects with EADDRINUSE if the leader path
   * failed because :port is already held by another process.
   */
  start(): Promise<void>;

  /**
   * @deprecated Internal use only — DO NOT call from `server.ts` tool
   * handlers or anywhere a tool dispatch is happening. Use
   * `dispatchTool()` instead so cap enforcement (ARD §4.4) and the
   * bilateral counter handshake apply.
   *
   * This method is the v1 protocol's bare `{id, type, args}` request
   * envelope. It still exists for: (a) the legacy fallback path in
   * `dispatchTool` when talking to a pre-2.0.0 extension, (b) bridge
   * unit tests that exercise low-level WS plumbing, (c) followers
   * proxying internal traffic to the leader.
   *
   * If you find yourself reaching for `request()` from a tool
   * handler, you are introducing a cap bypass. Stop. Call
   * `dispatchTool(toolName, args)` instead.
   */
  request(type: string, args?: Record<string, unknown>): Promise<unknown>;

  /**
   * Dispatch a tool call, applying cap enforcement and the bilateral
   * counter handshake (ARD §4.4). Throws `McpError` with one of:
   *  - -32028 MCP_AUTH_REQUIRED
   *  - -32029 MCP_CAP_EXCEEDED
   *  - -32030 MCP_DISPATCH_TIMEOUT
   *  - -32031 MCP_EXTENSION_OUTDATED
   *  - -32032 MCP_INTEGRITY_VIOLATION
   *
   * Otherwise returns the tool's result, same shape as `request()`
   * would have returned.
   */
  dispatchTool(toolName: string, args?: Record<string, unknown>): Promise<unknown>;

  /**
   * Register a handler for unsolicited pushes from the extension.
   * Leader invokes locally; follower receives them forwarded from the
   * leader over the peer channel.
   */
  onPush(handler: (type: string, data: any) => void): void;

  /**
   * Report this process's MCP client identity (from MCP SDK's
   * initialize handshake). Call once on oninitialized. The leader
   * aggregates its own + all connected followers' client info and
   * sends it to the extension via a `hello` frame so the extension
   * UI can show "connected IDEs".
   */
  setOwnClientInfo(info: BridgeClientInfo): void;

  /**
   * Shut down. Leader closes the WS server + evicts followers.
   * Follower closes its client connection.
   */
  close(): Promise<void>;

  /**
   * Which role the bridge is running in. Exposed for logs and tests.
   */
  readonly role: 'leader' | 'follower';
}

/**
 * Try to start as leader; fall back to follower on EADDRINUSE.
 *
 * This is the only way to construct a bridge from outside the module —
 * the class constructors are available for tests, but production code
 * should always go through here so the port-contention logic stays
 * centralised.
 */
export async function createBridge(
  port: number = 4050,
  requestTimeoutMs: number = 30_000,
): Promise<Bridge> {
  const local = new ExtensionBridge(port, requestTimeoutMs);
  try {
    await local.start();
    process.stderr.write(`[customaise-mcp] Bridge role=leader, listening on :${port}\n`);
    return local;
  } catch (err: any) {
    if (err?.code !== 'EADDRINUSE') {
      throw err;
    }
    // Port is already held by another customaise-mcp process. Become a
    // follower: connect to that process over WebSocket and proxy all
    // bridge traffic through it. The leader multiplexes responses and
    // pushes back to every follower.
    //
    // Important: do NOT call local.close() here. When bind failed, the
    // WSS never entered the listening state; close()'s callback
    // behaviour on a never-listened server is library-defined and
    // could hang or throw. The ExtensionBridge instance is unused and
    // will be GC'd.
    process.stderr.write(`[customaise-mcp] :${port} in use — starting as follower\n`);
    const remote = new RemoteBridge(port, requestTimeoutMs);
    await remote.start();
    process.stderr.write(`[customaise-mcp] Bridge role=follower, connected to leader on :${port}\n`);
    return remote;
  }
}
