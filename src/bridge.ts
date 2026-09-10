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
 * the same extension. `createBridge` below hands back an `ElectingBridge`,
 * which decides who's leader and who's a follower and re-decides it every
 * time that changes; the caller (index.ts / daemon.ts) doesn't care.
 */

import { ElectingBridge } from './electing-bridge.js';
import type { PendingDispatchInfo } from './request-context.js';

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

/** Per-dispatch options. */
export interface DispatchOptions {
  /**
   * Abort the dispatch across leader/follower hops. The extension closes
   * pending consent and cancels save preparation. Already-submitted storage
   * writes cannot be recalled; inspect the durable save receipt afterwards.
   */
  signal?: AbortSignal;
  /** See `RequestContext.onPending`; an explicit one wins over the context's. */
  onPending?: (info: PendingDispatchInfo) => void;
}

/**
 * What `doctor` reports, read locally rather than fetched.
 *
 * Every tool call spends a cap unit, so a diagnostic that dispatched would
 * consume the headroom it exists to report on. All of this rides in on
 * `init_session` and is held by the leader, so reading it is free.
 *
 * `null` means "the extension has not told us", which is a different answer
 * from `false` and is reported as unknown rather than as a confident no.
 */
/**
 * The leader/follower relay's OWN protocol version.
 *
 * Deliberately an integer, and deliberately not the package version. The
 * package version bumps every release, and a 3.0.0 follower on a 3.0.1
 * leader with identical frame shapes MUST interop silently — that mixed
 * fleet is a designed consequence of unpinned `npx -y` (ARD 4.1). What must
 * never happen silently is mismatched frame SHAPES. So this number moves
 * only when a frame changes incompatibly, and both ends fail closed on a
 * mismatch: the leader rejects requests from a follower whose hello
 * disagrees, keeping its socket idle so older clients do not repeatedly
 * reconnect after eviction; a
 * follower refuses to dispatch through a leader whose status frame
 * disagrees or predates the field. The OLDER side does the rejecting in
 * each direction, which is the only side that can — the newer one cannot
 * know rules that had not been written yet.
 *
 * This is the same posture the codebase's other two seams already had:
 * extension-to-server negotiates via hello.protocolVersion, and the CLI
 * restarts a daemon whose package version differs. This seam shipped
 * without a contract; added before 3.0.0 published, while the field is
 * still free to introduce because no fleet exists.
 */
export const RELAY_PROTOCOL_VERSION = 2; // Adds owned follower dispatch cancellation.

/**
 * WebSocket close code a leader uses when it steps down for a newer
 * follower, and how long the OTHER followers hold back before re-racing.
 *
 * Without the hold-back, abdication is a coin toss: every follower re-elects
 * the instant the leader closes, and an older one wins the bind as often as
 * the newer one does. Each wrong toss costs a full extension reconnect. The
 * reason string names the version being yielded to; a follower that IS that
 * version races at once, every other one waits this long first. A follower
 * built before this code sees an unknown close code and races immediately,
 * which is the old behaviour and still converges, just less often first time.
 */
export const STEP_DOWN_CLOSE_CODE = 4002;
export const STEP_DOWN_YIELD_MS = 300;

export interface BridgeSessionSnapshot {
  extensionConnected: boolean;
  /** Master-gate state, relayed so a follower reads it without asking either. */
  systemStatus: SystemStatusSnapshot | null;
  tier: string | null;
  authenticated: boolean | null;
  remoteApprovals: boolean | null;
  capMode: string | null;
  dailyUsed: number | null;
  dailyCap: number | null;
  weeklyUsed: number | null;
  weeklyCap: number | null;
  /**
   * The package version of the process actually holding :4050.
   *
   * On a leader this is trivially its own version. On a follower it is the
   * RELAYED value, and that is the point: the leader/follower relay has no
   * version negotiation, an IDE-spawned leader lives as long as the IDE, and
   * `npx -y` resolves `latest` per spawn — so during any rollout the fleet
   * is mixed by design (ARD 4.1 predicts "mixed for hours"). The frames are
   * additive JSON and tolerate skew today; this field is what makes the skew
   * VISIBLE, in `doctor` and `get_bridge_status`, when a future frame change
   * meets an old leader and something inexplicable starts happening.
   */
  leaderVersion: string | null;
}

/** The extension's master-gate state, as it rides in on acks and init_session. */
export interface SystemStatusSnapshot {
  userScriptsDisabled: boolean;
  userScriptsApiAvailable: boolean;
  configureWorldApiAvailable: boolean;
  available: boolean;
}

export interface Bridge {
  /**
   * Become ready. For the leader: bind the WS port; rejects with EADDRINUSE
   * if :port is already held. For a follower: connect to the leader. For the
   * `ElectingBridge` production holds: run the election, which turns the
   * first two outcomes into each other until one sticks.
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
   * counter handshake (ARD §4.4). Throws `ProtocolError` with one of:
   *  - -32028 MCP_AUTH_REQUIRED
   *  - -32029 MCP_CAP_EXCEEDED
   *  - -32030 MCP_DISPATCH_TIMEOUT
   *  - -32031 MCP_EXTENSION_OUTDATED
   *  - -32032 MCP_INTEGRITY_VIOLATION
   *
   * Otherwise returns the tool's result, same shape as `request()`
   * would have returned.
   */
  dispatchTool(
    toolName: string,
    args?: Record<string, unknown>,
    opts?: DispatchOptions,
  ): Promise<unknown>;

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

  /**
   * Whether an extension is currently attached.
   *
   * Distinct from `role`, and the distinction matters: holding `:4050` says
   * nothing about whether Chrome is running. A daemon deciding whether it is
   * safe to idle-exit needs this one, not that one.
   */
  readonly isConnected: boolean;

  /**
   * Session facts for `doctor`, without touching the extension.
   *
   * A follower has no CapSession of its own; the leader relays this on the
   * `status` frame it already sends, so both roles answer the same question.
   */
  getSessionSnapshot(): BridgeSessionSnapshot;

  /**
   * Latest master-gate state, or null if the extension has not reported one.
   *
   * Read rather than asked for. Asking meant `dispatchTool('get_system_status')`,
   * which spends a cap unit, on five tools that call it every time.
   */
  getSystemStatus(): SystemStatusSnapshot | null;
}

/**
 * Construct the bridge production code holds.
 *
 * This is the only way to construct a bridge from outside the module — the
 * class constructors are available for tests, but production code should
 * always go through here so the port-contention logic stays centralised.
 * Leadership is decided by `ElectingBridge`, which races the port at
 * startup and again whenever a follower's leader goes away; see that file
 * for why neither loss is terminal.
 */
export async function createBridge(
  port: number = 4050,
  requestTimeoutMs: number = 30_000,
): Promise<Bridge> {
  const bridge = new ElectingBridge(port, requestTimeoutMs);
  await bridge.start();
  return bridge;
}
