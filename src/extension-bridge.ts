/**
 * ExtensionBridge — WebSocket server bridging the MCP server and the
 * Customaise Chrome extension.
 *
 * Architecture:
 *   MCP Server (stdio) ←→ ExtensionBridge (WS :4050) ←→ Extension SW (WS client)
 *                                              ↑
 *                                              └── (WS) ← other customaise-mcp
 *                                                        processes running as
 *                                                        followers (for
 *                                                        multi-IDE setups)
 *
 * This file implements the LEADER role. See `remote-bridge.ts` for the
 * follower client and `bridge.ts` for the leader/follower auto-detection
 * factory.
 *
 * The MCP Node process hosts the WebSocket server because MV3 service
 * workers cannot run servers. The extension connects as a WebSocket
 * client. Additional customaise-mcp processes (e.g. one per IDE window)
 * connect as follower clients and proxy their bridge requests through
 * this leader.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type { Bridge, BridgeClientInfo } from './bridge.js';
import {
  type CapSession,
  applyAck,
  applyInitSession,
  buildIntegrityReport,
  createPendingSession,
  decideDispatch,
  ERROR_CODE_AUTH_REQUIRED,
  ERROR_CODE_CAP_EXCEEDED,
  ERROR_CODE_DISPATCH_TIMEOUT,
  ERROR_CODE_EXTENSION_OUTDATED,
  ERROR_CODE_INTEGRITY_VIOLATION,
  incrementLocalLegacyCounter,
  markLegacy,
  rolloverDailyIfNeeded,
  takeNextSeqNum,
} from './cap-state.js';

/**
 * Version stamp of this customaise-mcp package. Read from the shipped
 * package.json at module load. The extension compares this against its
 * own EXPECTED_MCP_VERSION constant to surface update nudges in the
 * sidebar UI.
 */
const MCP_VERSION: string = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', 'package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf-8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/**
 * Minimum extension version that speaks the v2 bridge protocol
 * (init_session / dispatch_tool / dispatch_ack / report_integrity_error).
 * Surfaced in the hello frame so the extension can self-diagnose if
 * it's running an older build than the MCP server expects.
 *
 * Bumped in lockstep with @customaise/mcp major versions where the
 * protocol changes. Currently matches the extension build that landed
 * the v2 bridge protocol (the "Free MCP with caps" milestone).
 */
const MIN_EXTENSION_VERSION = '1.4.0';

/**
 * How long the server waits for an `init_session` frame after the
 * extension's WS connection opens. After this elapses the session is
 * marked legacy (old extension), the server falls back to the v1
 * `{id, type, args}` request protocol for tool dispatch, and the next
 * tool call surfaces a one-time deprecation error to the IDE per
 * ARD §4.14.
 *
 * Configurable so QA can simulate slow extensions; default 30s matches
 * the spec.
 */
const INIT_SESSION_GRACE_MS = (() => {
  const env = Number(process.env.CUSTOMAISE_MCP_INIT_SESSION_GRACE_MS);
  return Number.isFinite(env) && env > 0 ? env : 30_000;
})();

/**
 * Per-tool dispatch_ack timeout. Must cover normal tool latencies (DOM
 * reads, AgentScript invocations, screenshots) but bound enough that a
 * crashed extension doesn't hang the IDE forever. ARD §4.4 default 30s.
 *
 * Tools with legitimately long execution (large captures, network-heavy
 * AgentScripts) can bump via the env var without code changes. Tools
 * that consistently exceed 30s are candidates for a slow-tool API in v2.
 */
const DISPATCH_ACK_TIMEOUT_MS = (() => {
  const env = Number(process.env.CUSTOMAISE_MCP_DISPATCH_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : 30_000;
})();

/**
 * Extension IDs permitted to connect as the extension client.
 *
 * Threat model: any process (browser tab, native daemon) that can reach
 * ws://localhost:4050 can list and call WebMCP tools. The most likely
 * abuse vector is a malicious webpage opening `new WebSocket('ws://localhost:4050')`
 * and calling `allow`-permissioned tools. We check the WebSocket handshake's
 * `Origin` header against this allowlist.
 *
 * Chrome sends `Origin: chrome-extension://<id>` on handshakes from
 * extension service workers. Regular webpages send their real origin,
 * which doesn't start with `chrome-extension://` — so this rejects them.
 * A malicious native process can still forge the header (Node's `ws`
 * client accepts an `origin` option); origin-check doesn't stop a
 * same-user local attacker. That residual risk is documented.
 */
const DEFAULT_EXTENSION_IDS = [
  'anmpijcpaobaabcdncjjmnhdeibipmko', // production
  'ijjaffggglamocdapoihpkcpealflopp', // staging
];

/**
 * Origin used by RemoteBridge followers when they connect to a leader.
 * Browsers cannot forge Origin, so a webpage can't pose as a follower.
 * A same-user local process could, but that's already in scope of the
 * pre-existing threat model (a local attacker can forge `chrome-extension://`
 * just as easily). Additional defense: we enforce the connecting socket
 * is loopback.
 */
export const FOLLOWER_ORIGIN = 'customaise-mcp-follower://local';

/** Shape of a request sent to the extension */
interface BridgeRequest {
  id: string;
  type: string;
  args: Record<string, unknown>;
}

/** Shape of a response received from the extension */
interface BridgeResponse {
  id: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /**
   * Who asked. 'leader' = this process's own MCP frontend. A WebSocket
   * reference = a follower client that forwarded the request; the
   * response needs to be relayed back over that socket.
   */
  origin: 'leader' | WebSocket;
  /**
   * For forwarded follower requests: the id the follower used. The
   * leader maintains its own fresh server-side id in the pending map
   * to avoid collisions; when we relay frames back we use this
   * original id so the follower's local pending map lines up.
   */
  followerOrigId?: string;
}

/**
 * Frame envelope spoken between a leader and its followers. Distinct
 * from the extension protocol so we can multiplex both kinds of clients
 * on the same WS server.
 *
 * `req-dispatch` is the v2 cap-enforced equivalent of `req`: the leader
 * routes it through its dispatchTool() (cap pre-check, handshake, ack
 * adoption) before forwarding to the extension. Followers don't carry
 * cap state — the leader's CapSession is the single source of truth
 * for the whole MCP-server-cluster.
 */
type FollowerFrame =
  | { role: 'req'; id: string; type: string; args: Record<string, unknown> }
  | { role: 'req-dispatch'; id: string; tool: string; args: Record<string, unknown> }
  | { role: 'client-info'; name: string; version: string };

type LeaderFrame =
  | { role: 'res'; id: string; success: boolean; result?: unknown; error?: string }
  | { role: 'res-pending'; id: string; expectedTimeoutMs: number; reason?: string }
  | { role: 'push'; type: string; data: any }
  | { role: 'status'; extensionConnected: boolean };

/**
 * Frame sent by the leader to the extension right after the extension
 * connects, and again whenever the client-info set changes (leader's
 * own MCP initializes, follower joins/leaves, follower reports its
 * clientInfo). Extension-side parser reads this to render version
 * status + connected-IDE list.
 *
 * `protocolVersion` and `minExtensionVersion` were added with the v2
 * bridge protocol. Extensions speaking v1 ignore them; extensions
 * speaking v2 use them to gate which protocol they send (init_session +
 * dispatch_ack vs the legacy {id,type,args} request).
 */
interface ExtensionHelloFrame {
  role: 'hello';
  mcpVersion: string;
  protocolVersion: 1 | 2;
  minExtensionVersion: string;
  clients: Array<{ name: string; version: string; role: 'leader' | 'follower' }>;
}

/**
 * v2 bridge protocol frames spoken between the extension and the MCP
 * server (LEADER role). Distinct envelope from the legacy
 * `{id, type, args}` request frames so we can run both protocols
 * concurrently during the rollout window (ARD §4.14).
 *
 * Extension → server:
 *  - `init_session`: announces tier + caps right after WS open
 *  - `dispatch_ack`: response to a `dispatch_tool`, carries authoritative counter
 *
 * Server → extension:
 *  - `dispatch_tool`: cap-enforced tool call (replaces the legacy req frame)
 *  - `report_integrity_error`: backwards-counter ack detected
 */
type ExtensionInboundV2 =
  | {
      type: 'init_session';
      session_id: string;
      install_id?: string;
      token_age_seconds?: number;
      tier?: 'free' | 'power_user' | 'trial';
      unlimited?: boolean;
      daily_cap?: number;
      weekly_cap?: number;
      current_used_daily?: number;
      current_used_week?: number;
    }
  | {
      type: 'dispatch_ack';
      session_id: string;
      seq_num: number;
      success: boolean;
      counter?: number;
      result?: unknown;
      error?: string;
      // When the extension refuses with a typed reason
      // (MCP_CAP_EXCEEDED, MCP_AUTH_REQUIRED, etc.), it stamps the
      // JSON-RPC code + structured data so the server can rethrow as
      // a real McpError to the IDE rather than a plain Error string.
      error_code?: number;
      error_data?: unknown;
    }
  | {
      // Interim frame the extension sends when a dispatch is about to
      // block on the HITL consent modal (only the user can resolve it,
      // up to 5 min). Server resets the dispatch_ack timer so the
      // dispatch doesn't time out at the default 30s. Symmetric to v1's
      // `kind: 'pending'` mechanism but keyed by seq_num instead of id.
      type: 'dispatch_tool_pending';
      session_id: string;
      seq_num: number;
      reason?: string;
      expected_timeout_ms?: number;
    };

export class ExtensionBridge implements Bridge {
  readonly role = 'leader' as const;

  private wss: WebSocketServer | null = null;
  private extensionSocket: WebSocket | null = null;
  private followerSockets = new Set<WebSocket>();
  private followerClientInfos = new Map<WebSocket, BridgeClientInfo>();
  private myClientInfo: BridgeClientInfo | null = null;
  private pending = new Map<string, PendingRequest>();
  private port: number;
  private requestTimeoutMs: number;
  private pushHandler: ((type: string, data: any) => void) | null = null;
  private allowedExtensionOrigins: Set<string>;
  private allowInsecure: boolean;

  // ─── v2 bridge protocol state ────────────────────────────────────
  // One CapSession per extension WS connection. Reset on reconnect
  // (start in 'pending', resolved by init_session arrival or grace
  // timer fire). All cap decisions read from / write to this.
  private capSession: CapSession | null = null;
  // Pending dispatch_tool frames, keyed by seq_num. Holds the
  // resolve/reject of the in-flight dispatchTool() promise plus its
  // ack timeout handle.
  //
  // `origin` lets _handleDispatchToolPending relay the v2 timer-extend
  // frame back to the originating follower (when the dispatch came
  // from a multi-IDE setup), symmetric to how v1's `kind: 'pending'`
  // path relays `res-pending` to followers. Without this, follower
  // IDEs would time out at 30s on every HITL-gated tool call even
  // though the leader's timer correctly extended.
  private dispatchPending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    tool: string;
    origin: 'leader' | WebSocket;
    followerOrigId?: string;
  }>();
  // Resolves when init_session arrives OR the grace timer marks the
  // session legacy. dispatchTool() awaits this before deciding which
  // protocol (v2 dispatch_tool vs legacy request) to use.
  private sessionResolved: Promise<void> | null = null;
  private sessionResolvedFn: (() => void) | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(port = 4050, requestTimeoutMs = 30_000) {
    this.port = port;
    this.requestTimeoutMs = requestTimeoutMs;

    // Build the origin allowlist. Defaults cover the Web Store + staging
    // extensions. Users loading an unpacked dev build with a different ID
    // can add it via CUSTOMAISE_MCP_EXTRA_EXTENSION_IDS (comma-separated).
    const extraIds = (process.env.CUSTOMAISE_MCP_EXTRA_EXTENSION_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const allIds = [...DEFAULT_EXTENSION_IDS, ...extraIds];
    this.allowedExtensionOrigins = new Set(allIds.map((id) => `chrome-extension://${id}`));

    // Escape hatch for tests and any non-browser MCP-bridge clients that
    // need to connect without forging a chrome-extension:// origin. Must
    // be set explicitly; logged loudly on startup so nobody enables it
    // by accident in a deployed install.
    this.allowInsecure = process.env.CUSTOMAISE_MCP_ALLOW_INSECURE === '1';
  }

  /**
   * Start the WebSocket server and begin listening for the extension +
   * follower clients.
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({
        port: this.port,
        verifyClient: (info, done) => {
          const origin = info.origin || info.req.headers.origin || '';

          // Universal loopback guard — first line of defence for every
          // connection, extension + follower alike. A LAN attacker can
          // still complete the TCP SYN (the port is open on the
          // network interface) but fails the WS upgrade with 403.
          // Costs nothing for legitimate clients: the Chrome extension
          // always resolves `ws://localhost:4050` to a loopback
          // address, and follower processes connect via localhost by
          // definition. Bypassable only by a same-user local process
          // (documented residual risk).
          const remoteAddr = info.req.socket.remoteAddress || '';
          const isLoopback = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
          if (!isLoopback) {
            this._log(`Rejected non-loopback handshake from remoteAddress="${remoteAddr}" origin="${origin}"`);
            done(false, 403, 'Forbidden: loopback-only');
            return;
          }

          if (this.allowInsecure) {
            done(true);
            return;
          }
          if (this.allowedExtensionOrigins.has(origin)) {
            done(true);
            return;
          }
          if (origin === FOLLOWER_ORIGIN) {
            // Loopback already enforced above; any follower reaching
            // this branch is local by construction.
            done(true);
            return;
          }
          this._log(`Rejected WS handshake from origin="${origin}" (not in allowlist)`);
          done(false, 403, 'Forbidden: origin not allowed');
        },
      }, () => {
        this._log(`WebSocket server listening on ws://localhost:${this.port}`);
        if (this.allowInsecure) {
          this._log('WARNING: CUSTOMAISE_MCP_ALLOW_INSECURE=1 is set. Origin check DISABLED. Any local process can connect.');
        }
        resolve();
      });

      this.wss.on('error', (err) => {
        this._log(`WebSocket server error: ${err.message}`);
        reject(err);
      });

      this.wss.on('connection', (ws, req) => {
        const origin = req.headers.origin || '';
        if (origin === FOLLOWER_ORIGIN) {
          this._handleFollowerConnection(ws);
        } else {
          this._handleExtensionConnection(ws);
        }
      });
    });
  }

  /** A new extension client connected (or replaced an existing one). */
  private _handleExtensionConnection(ws: WebSocket): void {
    this._log('Extension client connected');

    // Only allow one extension at a time. The previous extensionSocket
    // (if any) gets replaced; we also tear down its v2 session state
    // because dispatch_acks for the old session can never arrive now.
    if (this.extensionSocket) {
      this._log('Replacing existing extension connection');
      this.extensionSocket.close(1000, 'Replaced by new connection');
      this._resetCapSession('replaced');
    }

    this.extensionSocket = ws;
    this._broadcastStatusToFollowers(true);
    // Initialise a fresh CapSession in 'pending' mode and arm the
    // grace timer. The session resolves when either an init_session
    // frame arrives (modern extension) or the timer fires (legacy
    // extension → fall back to v1 protocol + Free cap).
    this._beginCapSession();
    // Send hello immediately so the extension UI can populate the MCP
    // version + connected-clients pill with whatever we know so far.
    // Re-sent whenever client-info state changes (below).
    this._sendHelloToExtension();

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this._handleExtensionMessage(message);
      } catch (err) {
        this._log(`Failed to parse message from extension: ${err}`);
      }
    });

    ws.on('close', (code, reason) => {
      this._log(`Extension client disconnected (code=${code}, reason=${reason.toString()})`);
      if (this.extensionSocket === ws) {
        this.extensionSocket = null;
        this._broadcastStatusToFollowers(false);
        this._resetCapSession('extension_closed');
      }
    });

    ws.on('error', (err) => {
      this._log(`Extension client error: ${err.message}`);
    });
  }

  // ─── Cap session lifecycle ───────────────────────────────────────

  /**
   * Open a fresh CapSession in 'pending' mode and arm the
   * init_session grace timer. Resolved in one of two ways:
   *   - extension sends init_session within INIT_SESSION_GRACE_MS
   *     → mode becomes 'capped' or 'unlimited'
   *   - timer fires first → mode becomes 'legacy', deprecation error
   *     fires on the next dispatchTool() call
   */
  private _beginCapSession(): void {
    const sessionId = randomUUID();
    this.capSession = createPendingSession(sessionId);
    this.sessionResolved = new Promise<void>((resolve) => {
      this.sessionResolvedFn = resolve;
    });
    this.graceTimer = setTimeout(() => {
      if (!this.capSession || this.capSession.mode !== 'pending') return;
      this.capSession = markLegacy(this.capSession);
      this._log(
        `init_session not received within ${INIT_SESSION_GRACE_MS}ms — falling back to legacy v1 protocol + Free cap enforcement`,
      );
      this._resolveSession();
    }, INIT_SESSION_GRACE_MS);
  }

  private _resolveSession(): void {
    const fn = this.sessionResolvedFn;
    if (fn) {
      this.sessionResolvedFn = null;
      fn();
    }
  }

  /**
   * Tear down per-session state on extension disconnect / replacement.
   * In-flight dispatchTool() promises reject (extension can't ack now).
   */
  private _resetCapSession(reason: string): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    for (const [, pending] of this.dispatchPending) {
      clearTimeout(pending.timer);
      pending.reject(
        new McpError(
          ERROR_CODE_DISPATCH_TIMEOUT,
          `MCP dispatch aborted: extension disconnected (${reason}). Reconnect MCP from Customaise extension Settings.`,
          { type: 'dispatch_timeout', reason },
        ),
      );
    }
    this.dispatchPending.clear();
    // Resolve any pending session-wait promises so callers don't hang.
    if (this.sessionResolvedFn) this._resolveSession();
    this.capSession = null;
    this.sessionResolved = null;
  }

  /**
   * Follower → leader: relay a cap-enforced dispatchTool() call. The
   * leader runs it through its own dispatchTool (so the same
   * CapSession applies to every IDE connected to this MCP server
   * cluster) and relays the result or McpError back to the follower
   * preserving the JSON-RPC error code.
   */
  private async _handleFollowerDispatchRequest(
    ws: WebSocket,
    message: Extract<FollowerFrame, { role: 'req-dispatch' }>,
  ): Promise<void> {
    const origId = message.id;
    const tool = message.tool;
    const args = (message.args && typeof message.args === 'object' && !Array.isArray(message.args))
      ? message.args as Record<string, unknown>
      : {};
    if (typeof origId !== 'string' || origId.length === 0) {
      this._log('Follower req-dispatch frame missing/invalid id; dropping');
      return;
    }
    if (typeof tool !== 'string' || tool.length === 0) {
      this._sendToFollower(ws, {
        role: 'res', id: origId, success: false,
        error: 'req-dispatch.tool must be a non-empty string',
      });
      return;
    }
    try {
      // Track origin = ws so _handleDispatchToolPending can relay
      // HITL timer-extend frames to this follower (otherwise the
      // follower's own pending timer would fire at 30s while the
      // leader correctly awaits user consent for up to 5 min).
      const result = await this._dispatchToolWithOrigin(tool, args, ws, origId);
      this._sendToFollower(ws, { role: 'res', id: origId, success: true, result });
    } catch (err) {
      // Preserve McpError code + data through the relay so the follower
      // can re-throw a typed McpError to its IDE.
      if (err instanceof McpError) {
        this._sendToFollower(ws, {
          role: 'res', id: origId, success: false,
          error: JSON.stringify({ code: err.code, message: err.message, data: err.data ?? null }),
        });
      } else {
        this._sendToFollower(ws, {
          role: 'res', id: origId, success: false,
          error: (err as Error)?.message || 'dispatchTool failed',
        });
      }
    }
  }

  /** A new follower customaise-mcp process connected. */
  private _handleFollowerConnection(ws: WebSocket): void {
    this._log('Follower client connected');
    this.followerSockets.add(ws);

    // Send initial status so the follower knows whether the extension is live.
    this._sendToFollower(ws, { role: 'status', extensionConnected: this.extensionSocket !== null });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as FollowerFrame;
        this._handleFollowerMessage(ws, message);
      } catch (err) {
        this._log(`Failed to parse message from follower: ${err}`);
      }
    });

    ws.on('close', (code, reason) => {
      this._log(`Follower client disconnected (code=${code}, reason=${reason.toString()})`);
      this.followerSockets.delete(ws);
      const hadClientInfo = this.followerClientInfos.has(ws);
      this.followerClientInfos.delete(ws);
      // Reject any v1 requests still in-flight on behalf of this follower.
      for (const [id, pending] of this.pending) {
        if (pending.origin === ws) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          // No one left to tell about the rejection — just drop.
        }
      }
      // Symmetric cleanup for v2 dispatchPending: same situation, the
      // follower IDE has gone away, so any dispatch in flight on its
      // behalf has nowhere to deliver the result. The extension is
      // still mid-execution (no protocol-level cancel exists), so it
      // will eventually send dispatch_ack — that ack will then no-op
      // via the "no pending entry" branch in _handleDispatchAck.
      //
      // We MUST call dispatch.reject() (unlike the v1 cleanup above
      // which just drops). The v1 entries hold callback functions, so
      // dropping the entry GCs the callbacks. The v2 entries hold
      // Promise resolvers — `_dispatchToolWithOrigin` returns a
      // Promise whose resolve/reject are stored in the entry. If we
      // delete the entry without calling reject, the Promise becomes
      // permanently unsettled, the await chain in
      // `_handleFollowerDispatchRequest` hangs forever, and the whole
      // closure (capturing ws, origId, tool name) leaks. Per
      // disconnected-follower-during-dispatch event, one Promise
      // chain leaks until process exit. Reject releases it.
      for (const [seqNum, dispatch] of this.dispatchPending) {
        if (dispatch.origin === ws) {
          clearTimeout(dispatch.timer);
          this.dispatchPending.delete(seqNum);
          dispatch.reject(new McpError(
            ERROR_CODE_DISPATCH_TIMEOUT,
            `MCP dispatch aborted: originating follower disconnected (tool=${dispatch.tool}).`,
            { type: 'follower_disconnected', tool: dispatch.tool },
          ));
        }
      }
      // If the follower had announced itself, its client entry just
      // vanished from the list — refresh the extension's hello so the
      // UI doesn't show a stale IDE pill.
      if (hadClientInfo) this._sendHelloToExtension();
    });

    ws.on('error', (err) => {
      this._log(`Follower client error: ${err.message}`);
    });
  }

  /**
   * Route an incoming frame from a follower. Currently the only frame
   * type followers send is `req` — a request that should be forwarded
   * to the extension. Responses (including interim `res-pending`) come
   * from the extension and go back through the follower's WS.
   *
   * Security note: we do NOT reuse the follower-supplied id when
   * forwarding to the extension. A malicious/buggy follower could
   * supply an id that collides with the leader's own in-flight request
   * (or another follower's), causing cross-wire response routing.
   * Instead, we generate a fresh server-side id and map it back to
   * the follower+origId on the response path. The follower still sees
   * its own id in the response frame we relay back.
   */
  private _handleFollowerMessage(ws: WebSocket, message: FollowerFrame): void {
    if (!message || typeof message !== 'object') {
      this._log('Follower sent non-object frame');
      return;
    }
    if (message.role === 'client-info') {
      const name = (message as any).name;
      const version = (message as any).version;
      if (typeof name === 'string' && name.length > 0 && typeof version === 'string') {
        const next = { name: name.slice(0, 128), version: version.slice(0, 64) };
        const current = this.followerClientInfos.get(ws);
        // Skip the hello re-broadcast when the follower is just
        // re-announcing unchanged info (e.g., MCP initialize reran on
        // transport reconnect). Avoids a chatty status ripple to the
        // extension's UI fanout.
        if (current && current.name === next.name && current.version === next.version) return;
        this.followerClientInfos.set(ws, next);
        this._sendHelloToExtension();
      }
      return;
    }
    if (message.role === 'req-dispatch') {
      this._handleFollowerDispatchRequest(ws, message as Extract<FollowerFrame, { role: 'req-dispatch' }>);
      return;
    }
    if (message.role !== 'req') {
      this._log(`Follower sent unknown role: ${(message as any).role}`);
      return;
    }
    const origId = (message as any).id;
    const type = (message as any).type;
    const rawArgs = (message as any).args;
    if (typeof origId !== 'string' || origId.length === 0) {
      this._log('Follower req frame missing/invalid id; dropping');
      return;
    }
    if (typeof type !== 'string' || type.length === 0) {
      this._sendToFollower(ws, { role: 'res', id: origId, success: false, error: 'req.type must be a non-empty string' });
      return;
    }
    const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) ? rawArgs as Record<string, unknown> : {};

    if (!this.extensionSocket || this.extensionSocket.readyState !== WebSocket.OPEN) {
      this._sendToFollower(ws, {
        role: 'res', id: origId, success: false,
        error: 'Customaise extension is not connected. Make sure Chrome is running with the Customaise extension loaded.',
      });
      return;
    }

    // Server-side id, decoupled from what the follower provided. The
    // response path translates back.
    const forwardId = randomUUID();

    const timer = setTimeout(() => {
      const pending = this.pending.get(forwardId);
      if (!pending) return;
      this.pending.delete(forwardId);
      this._sendToFollower(ws, {
        role: 'res', id: origId, success: false,
        error: `Request to extension timed out after ${this.requestTimeoutMs}ms (type=${type}, id=${origId})`,
      });
    }, this.requestTimeoutMs);
    this.pending.set(forwardId, {
      origin: ws,
      resolve: (result) => this._sendToFollower(ws, { role: 'res', id: origId, success: true, result }),
      reject: (err) => this._sendToFollower(ws, { role: 'res', id: origId, success: false, error: err.message }),
      timer,
      followerOrigId: origId,
    });
    const request: BridgeRequest = { id: forwardId, type, args };
    this.extensionSocket.send(JSON.stringify(request));
  }

  /**
   * Send a request to the extension and wait for the response.
   * Throws if the extension is not connected or the request times out.
   */
  async request(type: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.extensionSocket || this.extensionSocket.readyState !== WebSocket.OPEN) {
      throw new Error(
        'Customaise extension is not connected. Make sure Chrome is running with the Customaise extension loaded.'
      );
    }

    const id = randomUUID();

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request to extension timed out after ${this.requestTimeoutMs}ms (type=${type}, id=${id})`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { origin: 'leader', resolve, reject, timer });

      const request: BridgeRequest = { id, type, args };
      this.extensionSocket!.send(JSON.stringify(request));
    });
  }

  /**
   * Whether the extension is currently connected.
   */
  get isConnected(): boolean {
    return this.extensionSocket !== null && this.extensionSocket.readyState === WebSocket.OPEN;
  }

  /**
   * Register a handler for push messages from the extension.
   * Push messages have a `type` field but no matching pending request.
   */
  onPush(handler: (type: string, data: any) => void): void {
    this.pushHandler = handler;
  }

  /**
   * Record this leader process's own MCP client identity (the IDE that
   * spawned us), and refresh the hello frame on the extension side so
   * its UI reflects the new entry in the connected-IDEs list.
   *
   * Idempotent — repeated calls with the same name+version are a
   * no-op (no wasted hello frame, no `_broadcastStatus` storm on the
   * extension end). Useful because MCP's initialize can re-fire on
   * some transport reconnect paths.
   */
  setOwnClientInfo(info: BridgeClientInfo): void {
    if (!info || typeof info.name !== 'string' || typeof info.version !== 'string') return;
    const next = { name: info.name.slice(0, 128), version: info.version.slice(0, 64) };
    const current = this.myClientInfo;
    if (current && current.name === next.name && current.version === next.version) return;
    this.myClientInfo = next;
    this._sendHelloToExtension();
  }

  /**
   * Build the authoritative hello frame from current state and send to
   * the extension if it's connected. Idempotent; safe to call any time
   * client-info state changes (leader self-initialize, follower join,
   * follower announce, follower leave).
   */
  private _sendHelloToExtension(): void {
    if (!this.extensionSocket || this.extensionSocket.readyState !== WebSocket.OPEN) return;
    const clients: ExtensionHelloFrame['clients'] = [];
    if (this.myClientInfo) {
      clients.push({ ...this.myClientInfo, role: 'leader' });
    }
    for (const [, info] of this.followerClientInfos) {
      clients.push({ ...info, role: 'follower' });
    }
    const frame: ExtensionHelloFrame = {
      role: 'hello',
      mcpVersion: MCP_VERSION,
      protocolVersion: 2,
      minExtensionVersion: MIN_EXTENSION_VERSION,
      clients,
    };
    try {
      this.extensionSocket.send(JSON.stringify(frame));
    } catch (err) {
      this._log(`Failed to send hello frame: ${(err as Error).message}`);
    }
  }

  /**
   * Close the WebSocket server and all connections.
   */
  async close(): Promise<void> {
    // Reject all pending requests (v1 protocol)
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Bridge is shutting down'));
    }
    this.pending.clear();
    // Reject all in-flight v2 dispatches and tear down session state.
    this._resetCapSession('shutting_down');

    if (this.extensionSocket) {
      this.extensionSocket.close(1000, 'MCP server shutting down');
      this.extensionSocket = null;
    }

    for (const f of this.followerSockets) {
      try { f.close(1001, 'Leader shutting down'); } catch { /* ignore */ }
    }
    this.followerSockets.clear();

    return new Promise((resolve) => {
      if (this.wss) {
        this.wss.close(() => {
          this.wss = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Handle an incoming message from the extension. Recognises:
   *  1. v2 protocol frames — `{ type: 'init_session' | 'dispatch_ack', ... }`
   *     — routed through the cap-session state machine.
   *  2. Final v1 response — `{ id, success, result|error }` — resolves/rejects + clears.
   *  3. Interim "pending" v1 — `{ id, kind: 'pending', expectedTimeoutMs }` — resets
   *     the request's timer to the larger value WITHOUT resolving. Used when the
   *     extension is about to block on a HITL consent modal: we don't want to
   *     surface a 30-s "timed out" error to the AI client while the user is
   *     still deciding.
   *  4. Unprompted push — `{ type, data }` with no matching id — forwarded to
   *     the registered push handler + broadcast to all followers.
   */
  private _handleExtensionMessage(message: BridgeResponse | ExtensionInboundV2 | { id?: string; kind?: string; expectedTimeoutMs?: number; reason?: string; type?: string; data?: any }): void {
    // v2 protocol frames carry `type` but no `id` — they're matched by
    // session_id / seq_num, not the v1 request id map. Branch out
    // before the v1 pending-map lookup so we don't false-match an ack
    // against a stale request id.
    const messageType = (message as any)?.type;
    if (messageType === 'init_session') {
      this._handleInitSession(message as Extract<ExtensionInboundV2, { type: 'init_session' }>);
      return;
    }
    if (messageType === 'dispatch_ack') {
      this._handleDispatchAck(message as Extract<ExtensionInboundV2, { type: 'dispatch_ack' }>);
      return;
    }
    if (messageType === 'dispatch_tool_pending') {
      this._handleDispatchToolPending(message as Extract<ExtensionInboundV2, { type: 'dispatch_tool_pending' }>);
      return;
    }

    // Past the v2 pre-route, message is either a v1 BridgeResponse,
    // a v1 pending frame, or an unprompted push. None of these are
    // ExtensionInboundV2 (we excluded those above) but TS can't infer
    // that from the early returns. Rebind once with a narrower type so
    // the v1 access patterns (`.id`, `.kind`, `.success`) type-check
    // without per-line `as any` casts.
    const v1: { id?: string; kind?: string; expectedTimeoutMs?: number; reason?: string; type?: string; data?: any; success?: boolean; result?: unknown; error?: string } = message as any;
    const pending = v1.id ? this.pending.get(v1.id) : undefined;

    // Interim "pending" frame — extend the deadline, do NOT resolve.
    if (pending && v1.kind === 'pending') {
      const extendMs = Math.max(
        Number(v1.expectedTimeoutMs) || 0,
        this.requestTimeoutMs
      );
      clearTimeout(pending.timer);
      pending.timer = setTimeout(() => {
        const stillPending = this.pending.get(v1.id!);
        if (!stillPending) return;
        this.pending.delete(v1.id!);
        stillPending.reject(new Error(
          `Request to extension timed out after ${extendMs}ms (type=consent-pending, id=${v1.id})`
        ));
      }, extendMs);
      // Also relay the pending frame to the originating follower so it
      // can extend its own client-side timer if it tracks one. Use
      // the follower's original id (not our server-side forwardId),
      // which is what its local pending map is keyed by.
      if (pending.origin !== 'leader' && pending.followerOrigId) {
        this._sendToFollower(pending.origin, {
          role: 'res-pending', id: pending.followerOrigId,
          expectedTimeoutMs: extendMs,
          reason: v1.reason,
        });
      }
      this._log(`Request ${v1.id} extended to ${extendMs}ms (reason: ${v1.reason || 'unspecified'})`);
      return;
    }

    if (!pending) {
      // Push from the extension (no matching pending request).
      if (v1.type) {
        const pushType = v1.type;
        const pushData = v1.data || {};
        if (this.pushHandler) {
          try { this.pushHandler(pushType, pushData); } catch (err) {
            this._log(`pushHandler threw: ${(err as Error).message}`);
          }
        }
        this._broadcastPushToFollowers(pushType, pushData);
      } else {
        this._log(`Received response for unknown request id: ${v1.id}`);
      }
      return;
    }

    this.pending.delete(v1.id!);
    clearTimeout(pending.timer);

    if (v1.success) {
      pending.resolve(v1.result);
    } else {
      pending.reject(new Error(v1.error || 'Extension returned an error'));
    }
  }

  // ─── v2 protocol: init_session + dispatch_ack handlers ──────────

  /**
   * Extension reported its session shape: tier + caps for Free,
   * `unlimited: true` for paid. Adopt into the in-memory CapSession
   * and resolve the pending wait so any queued dispatchTool() calls
   * can proceed.
   *
   * Idempotent — if init_session arrives twice (e.g. extension
   * re-sends after a tier change broadcast), we re-apply the payload
   * and emit no new state. The grace timer is cancelled on first
   * arrival.
   */
  private _handleInitSession(payload: Extract<ExtensionInboundV2, { type: 'init_session' }>): void {
    if (!this.capSession) {
      this._log('init_session received with no active CapSession — extension probably reconnected mid-frame; ignoring');
      return;
    }
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.capSession = applyInitSession(this.capSession, payload);
    this._log(
      `init_session adopted: mode=${this.capSession.mode} tier=${payload.tier ?? 'unspecified'} ` +
      `unlimited=${payload.unlimited === true} dailyUsed=${this.capSession.dailyUsed}/${this.capSession.dailyCap} ` +
      `installId=${this.capSession.installId ?? 'none'}`,
    );
    this._resolveSession();
  }

  /**
   * Extension acked a dispatch_tool. Three things happen:
   *  1. Run the ack through cap-state.applyAck — adopt forward counter
   *     or detect backwards drop.
   *  2. On backwards drop: emit `report_integrity_error` to the
   *     extension AND mark this session 'compromised' so future
   *     dispatchTool() calls refuse without round-tripping.
   *  3. Resolve / reject the pending dispatchTool() promise keyed by
   *     seq_num.
   */
  private _handleDispatchAck(ack: Extract<ExtensionInboundV2, { type: 'dispatch_ack' }>): void {
    const pending = this.dispatchPending.get(ack.seq_num);
    if (!pending) {
      // Late ack (timeout fired first) or duplicate. Don't try to
      // adopt the counter either — the timer-out path returned
      // MCP_DISPATCH_TIMEOUT to the IDE; if the extension actually
      // ran the work, the next ack we DO match will re-sync forward.
      this._log(`dispatch_ack with no pending entry: seq_num=${ack.seq_num} — late or duplicate; ignoring`);
      return;
    }
    this.dispatchPending.delete(ack.seq_num);
    clearTimeout(pending.timer);

    if (this.capSession) {
      const outcome = applyAck(this.capSession, ack, pending.tool);
      this.capSession = outcome.session;
      if (outcome.kind === 'integrity_violation') {
        const report = buildIntegrityReport(this.capSession, outcome.serverCountBefore, outcome.ackCounter, pending.tool);
        try {
          this.extensionSocket?.send(JSON.stringify(report));
        } catch (err) {
          this._log(`Failed to send report_integrity_error: ${(err as Error).message}`);
        }
        pending.reject(
          new McpError(
            ERROR_CODE_INTEGRITY_VIOLATION,
            'MCP integrity check failed: extension counter went backwards. Reconnect MCP from Customaise extension Settings.',
            { type: 'integrity_violation', tool: pending.tool, serverCountBefore: outcome.serverCountBefore, ackCounter: outcome.ackCounter },
          ),
        );
        return;
      }
    }

    if (ack.success) {
      pending.resolve(ack.result);
    } else if (typeof ack.error_code === 'number') {
      // Extension refused with a typed JSON-RPC code (e.g.
      // MCP_AUTH_REQUIRED, MCP_CAP_EXCEEDED). Rethrow as McpError so
      // the SDK surfaces the right error shape to the IDE.
      pending.reject(
        new McpError(
          ack.error_code,
          ack.error || `Tool '${pending.tool}' refused by extension (code=${ack.error_code})`,
          ack.error_data ?? undefined,
        ),
      );
    } else {
      pending.reject(new Error(ack.error || `Tool '${pending.tool}' failed in extension`));
    }
  }

  /**
   * v2 equivalent of the v1 `kind: 'pending'` timer extension. Fired
   * by the extension when a dispatch is about to block on the HITL
   * consent modal (up to 5 min of user dwell time). Without this, the
   * default 30s dispatch timer would fire while the user is still
   * deciding, the IDE would see MCP_DISPATCH_TIMEOUT, and any later
   * approval would arrive at an empty pending entry and get dropped.
   *
   * Also relays the extension to any follower that originated the
   * dispatch, so the follower's outer timer (if any) extends in
   * parallel — symmetric to the v1 `res-pending` follower frame.
   */
  private _handleDispatchToolPending(frame: Extract<ExtensionInboundV2, { type: 'dispatch_tool_pending' }>): void {
    const pending = this.dispatchPending.get(frame.seq_num);
    if (!pending) {
      this._log(`dispatch_tool_pending with no pending entry: seq_num=${frame.seq_num} — already acked or timed out; ignoring`);
      return;
    }
    const requested = Number(frame.expected_timeout_ms);
    const extendMs = Math.max(
      Number.isFinite(requested) && requested > 0 ? requested : 0,
      DISPATCH_ACK_TIMEOUT_MS,
    );
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      if (!this.dispatchPending.has(frame.seq_num)) return;
      this.dispatchPending.delete(frame.seq_num);
      pending.reject(
        new McpError(
          ERROR_CODE_DISPATCH_TIMEOUT,
          `MCP dispatch timed out after ${extendMs}ms (tool=${pending.tool}, awaiting user consent). The user did not approve in time; retry the call.`,
          { type: 'dispatch_timeout', tool: pending.tool, timeoutMs: extendMs, reason: 'awaiting_user_consent' },
        ),
      );
    }, extendMs);
    // Relay to the originating follower (if this dispatch came from
    // one) so the follower's local pending timer extends in lockstep.
    // Without this the follower would time out at its own
    // requestTimeoutMs while the leader correctly awaits user consent.
    if (pending.origin !== 'leader' && pending.followerOrigId) {
      this._sendToFollower(pending.origin, {
        role: 'res-pending',
        id: pending.followerOrigId,
        expectedTimeoutMs: extendMs,
        reason: frame.reason || 'awaiting_user_consent',
      });
    }
    this._log(`Dispatch ${frame.seq_num} (tool=${pending.tool}) extended to ${extendMs}ms (reason: ${frame.reason || 'awaiting_user_consent'})`);
  }

  /**
   * Public dispatchTool — cap-checked tool dispatch, ARD §4.4.
   *
   * Flow:
   *   1. Wait for session resolution (init_session arrival OR grace
   *      timer fire). Bounded by INIT_SESSION_GRACE_MS.
   *   2. Pre-check cap via decideDispatch(). On reject → throw
   *      MCP_CAP_EXCEEDED without round-tripping to the extension.
   *   3. Legacy session: emit one-time MCP_EXTENSION_OUTDATED on first
   *      call, fall back to v1 request, increment local-only counter.
   *   4. Modern session: send dispatch_tool frame, await dispatch_ack,
   *      adopt counter from ack.
   */
  async dispatchTool(toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this._dispatchToolWithOrigin(toolName, args, 'leader', undefined);
  }

  /**
   * Internal dispatch with explicit origin tracking. The public
   * dispatchTool always passes 'leader' (the leader process's own MCP
   * frontend); follower-originated dispatches go through here with
   * `origin = ws, followerOrigId = follower's request id` so the
   * pending entry knows who to relay HITL timer-extend frames back to.
   */
  private async _dispatchToolWithOrigin(
    toolName: string,
    args: Record<string, unknown>,
    origin: 'leader' | WebSocket,
    followerOrigId: string | undefined,
  ): Promise<unknown> {
    if (!this.extensionSocket || this.extensionSocket.readyState !== WebSocket.OPEN) {
      throw new McpError(
        ERROR_CODE_DISPATCH_TIMEOUT,
        'Customaise extension is not connected. Make sure Chrome is running with the Customaise extension loaded.',
        { type: 'extension_not_connected' },
      );
    }

    // Wait for session to resolve (init_session arrival or grace timer
    // fire). On healthy networks this is sub-millisecond.
    if (this.sessionResolved) {
      await this.sessionResolved;
    }

    if (!this.capSession) {
      // Extension disconnected during the wait.
      throw new McpError(
        ERROR_CODE_DISPATCH_TIMEOUT,
        'Customaise extension disconnected during MCP dispatch. Reconnect from Settings.',
        { type: 'extension_disconnected' },
      );
    }

    // Roll daily counter over if UTC midnight crossed since last activity.
    const now = new Date();
    const rollover = rolloverDailyIfNeeded(this.capSession, now);
    this.capSession = rollover.session;
    if (rollover.rolled) {
      this._log(`Daily counter rolled over to ${this.capSession.dailyDateUtc}`);
    }

    // Pre-check cap. Skip-for-paid handled inside decideDispatch
    // (returns allow:true for 'unlimited' mode).
    const decision = decideDispatch(this.capSession, now);
    if (decision.allow === false) {
      // Explicit narrowing helper: TS's discriminated-union narrowing
      // on `if (!decision.allow)` doesn't kick in under tsconfig.test's
      // strict:false setting, so we name the narrow variant directly.
      const denied = decision as Extract<typeof decision, { allow: false }>;
      throw new McpError(denied.code, denied.message, denied.data);
    }

    // Legacy mode: one-time deprecation error, then proceed via v1
    // protocol with server-tracked counter.
    if (this.capSession.mode === 'legacy') {
      if (!this.capSession.deprecationErrorSent) {
        this.capSession = { ...this.capSession, deprecationErrorSent: true };
        throw new McpError(
          ERROR_CODE_EXTENSION_OUTDATED,
          'Customaise extension out of date for the v2 MCP bridge. Update the extension from chrome://extensions for full MCP support; subsequent calls will use limited Free-tier behaviour.',
          { type: 'extension_outdated', minExtensionVersion: MIN_EXTENSION_VERSION },
        );
      }
      // After the one-time deprecation fired, run the call via v1
      // request and apply local cap accounting (no extension counter
      // to sync against).
      let result: unknown;
      try {
        result = await this.request(toolName, args);
      } catch (err) {
        // Failed dispatches don't count (ARD §4.1).
        throw err;
      }
      this.capSession = incrementLocalLegacyCounter(this.capSession);
      return result;
    }

    // Modern mode: v2 dispatch_tool / dispatch_ack with bilateral
    // counter handshake.
    const seq = takeNextSeqNum(this.capSession);
    this.capSession = seq.session;
    const seqNum = seq.seqNum;
    const sessionId = this.capSession.sessionId;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.dispatchPending.has(seqNum)) return;
        this.dispatchPending.delete(seqNum);
        reject(
          new McpError(
            ERROR_CODE_DISPATCH_TIMEOUT,
            `MCP dispatch timed out after ${DISPATCH_ACK_TIMEOUT_MS}ms (tool=${toolName}). The extension may be unresponsive; reload the target tab and retry.`,
            { type: 'dispatch_timeout', tool: toolName, timeoutMs: DISPATCH_ACK_TIMEOUT_MS },
          ),
        );
      }, DISPATCH_ACK_TIMEOUT_MS);

      this.dispatchPending.set(seqNum, { resolve, reject, timer, tool: toolName, origin, followerOrigId });

      const frame = {
        type: 'dispatch_tool' as const,
        session_id: sessionId,
        seq_num: seqNum,
        tool: toolName,
        args,
      };
      try {
        this.extensionSocket!.send(JSON.stringify(frame));
      } catch (err) {
        this.dispatchPending.delete(seqNum);
        clearTimeout(timer);
        reject(
          new McpError(
            ERROR_CODE_DISPATCH_TIMEOUT,
            `Failed to send dispatch_tool to extension: ${(err as Error).message}`,
            { type: 'send_failed', tool: toolName },
          ),
        );
      }
    });
  }

  private _broadcastPushToFollowers(type: string, data: any): void {
    if (this.followerSockets.size === 0) return;
    const frame: LeaderFrame = { role: 'push', type, data };
    for (const f of this.followerSockets) {
      this._sendToFollower(f, frame);
    }
  }

  private _broadcastStatusToFollowers(extensionConnected: boolean): void {
    if (this.followerSockets.size === 0) return;
    const frame: LeaderFrame = { role: 'status', extensionConnected };
    for (const f of this.followerSockets) {
      this._sendToFollower(f, frame);
    }
  }

  private _sendToFollower(ws: WebSocket, frame: LeaderFrame): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(frame)); } catch (err) {
      this._log(`Failed to send frame to follower: ${(err as Error).message}`);
    }
  }

  /**
   * Log to stderr (stdout is reserved for MCP stdio transport).
   */
  private _log(message: string): void {
    process.stderr.write(`[customaise-mcp] ${message}\n`);
  }
}
