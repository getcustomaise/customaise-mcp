/**
 * RemoteBridge — follower-role Bridge implementation.
 *
 * When a second customaise-mcp process starts up and finds port 4050
 * already bound by a sibling (e.g. user has Cursor + Claude Code both
 * configured with the same MCP), this class talks to that sibling over
 * WebSocket and proxies every bridge.request() through it. The MCP
 * server layer (server.ts) doesn't know or care which side of the
 * leader/follower divide it's on — same public interface.
 *
 * Wire protocol matches what ExtensionBridge expects from followers:
 *   follower → leader :  { role: 'req', id, type, args }
 *   leader   → follower: { role: 'res', id, success, result|error }
 *                        { role: 'res-pending', id, expectedTimeoutMs, reason? }
 *                        { role: 'push', type, data }
 *                        { role: 'status', extensionConnected }
 *
 * Failure modes:
 *   - Leader goes away: WS close fires and every in-flight request rejects
 *     with a clear error, then we reconnect to :port with a capped backoff
 *     until a leader answers again.
 *
 *     That reconnect is the whole recovery story, and it exists because it
 *     did not. This comment used to claim that "subsequent request() calls
 *     attempt to promote self to leader", which was never implemented: there
 *     is no bind anywhere in this file, and there was no reconnect either.
 *     A follower whose leader died stayed dead. In practice that meant
 *     restarting your IDE bricked the resident CLI daemon until someone ran
 *     `customaise daemon stop`, with every command returning exit 3.
 *
 *     Reconnecting covers the case that actually happens: one leader
 *     replaces another and the extension reattaches to it. If NO leader ever
 *     comes back there is nothing to talk to anyway, and the daemon's idle
 *     guard eventually exits it; the next CLI invocation spawns a fresh
 *     process that elects properly through `createBridge`. Promotion in
 *     place would mean swapping this object for an ExtensionBridge while 23
 *     tool handlers hold a reference to it, which is a facade this does not
 *     need to buy that last case.
 */

import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProtocolError } from "@modelcontextprotocol/server";
import { ERROR_CODE_DISPATCH_TIMEOUT, ERROR_CODE_RELAY_PROTOCOL_MISMATCH } from './cap-state.js';
import type { Bridge, BridgeClientInfo, BridgeSessionSnapshot, SystemStatusSnapshot, DispatchOptions } from './bridge.js';
import { RELAY_PROTOCOL_VERSION } from './bridge.js';
import { FOLLOWER_ORIGIN } from './extension-bridge.js';

/**
 * This process's own package version, for the leader-skew warning in
 * `_applyStatusFrame`. Read the same way extension-bridge reads MCP_VERSION,
 * and kept local rather than imported so the bridge modules stay
 * dependency-free of build-server.
 */
const OWN_VERSION: string = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

interface PendingFollowerRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type LeaderFrame =
  | { role: 'res'; id: string; success: boolean; result?: unknown; error?: string }
  | { role: 'res-pending'; id: string; expectedTimeoutMs: number; reason?: string }
  | { role: 'push'; type: string; data: any }
  | { role: 'status'; extensionConnected: boolean; session?: BridgeSessionSnapshot };

export class RemoteBridge implements Bridge {
  readonly role = 'follower' as const;

  private ws: WebSocket | null = null;
  private port: number;
  private requestTimeoutMs: number;
  private pending = new Map<string, PendingFollowerRequest>();
  private pushHandler: ((type: string, data: any) => void) | null = null;
  private extensionConnected = false;
  private closed = false;
  private myClientInfo: BridgeClientInfo | null = null;
  private sessionSnapshot: BridgeSessionSnapshot | null = null;
  private _warnedLeaderSkew = false;
  /**
   * Non-null when the process on :4050 speaks a different relay protocol.
   *
   * Set from the status frame (a missing `relayProtocol` means a leader
   * built before the contract existed, which is the same situation), and by
   * an explicit 4001 eviction. Cleared on every fresh handshake, because the
   * mismatched leader dying and a compatible one winning the port is the
   * normal recovery: reconnect keeps running at capped backoff, so this
   * heals itself the moment the older process goes away.
   */
  private protocolMismatch: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;

  /**
   * Backoff for reattaching to a leader. Capped rather than unbounded: one
   * WebSocket attempt every few seconds costs nothing, and an IDE that comes
   * back four minutes later should be picked up without the daemon having
   * given up on it.
   */
  private readonly RECONNECT_BASE_MS = 250;
  private readonly RECONNECT_MAX_MS = 5000;

  /**
   * Timeout (ms) for the initial status frame after WS open. If the
   * leader doesn't send one within this window, we assume we connected
   * to something that isn't a customaise-mcp leader and fail start().
   */
  private readonly HANDSHAKE_TIMEOUT_MS = 5000;

  constructor(port = 4050, requestTimeoutMs = 30_000) {
    this.port = port;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  /**
   * Connect to the leader and wait for the initial status handshake.
   *
   * Two conditions must be met before start() resolves:
   *   1. WebSocket 'open' fires — the TCP/WS handshake succeeded.
   *   2. Leader sends `{ role: 'status', extensionConnected }` within
   *      HANDSHAKE_TIMEOUT_MS — confirms the peer is a real
   *      customaise-mcp leader AND gives us accurate initial state
   *      before any request() call can run.
   *
   * Without (2), a caller that immediately did bridge.request() after
   * start() could race the status frame and see extensionConnected=false
   * even when the extension is live — we'd reject the request with the
   * wrong error.
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this._connect(resolve, reject);
    });
  }

  private _connect(resolve: () => void, reject: (err: Error) => void): void {
    const ws = new WebSocket(`ws://localhost:${this.port}`, {
      origin: FOLLOWER_ORIGIN,
    });
    this.ws = ws;

    let settled = false;
    let handshakeComplete = false;
    const handshakeTimer = setTimeout(() => {
      if (settled || handshakeComplete) return;
      settled = true;
      try { ws.close(1002, 'Handshake timeout'); } catch { /* ignore */ }
      reject(new Error(
        `No leader handshake received within ${this.HANDSHAKE_TIMEOUT_MS}ms on :${this.port}. ` +
        `Another process may be holding the port but is not a customaise-mcp leader.`,
      ));
    }, this.HANDSHAKE_TIMEOUT_MS);

    ws.on('open', () => {
      this._log(`Connected to leader on :${this.port} (awaiting status handshake)`);
      // Identify ourselves before anything else. The leader enforces the
      // relay contract on this frame and evicts a mismatch with a close
      // reason we surface verbatim; see RELAY_PROTOCOL_VERSION in bridge.ts.
      try {
        ws.send(JSON.stringify({ role: 'follower-hello', relayProtocol: RELAY_PROTOCOL_VERSION, version: OWN_VERSION }));
      } catch { /* close handler owns the failure path */ }
      // Don't resolve here — wait for the status frame.
    });

    ws.on('message', (data) => {
      try {
        const frame = JSON.parse(data.toString()) as LeaderFrame;
        // The first status frame doubles as the leader-identity
        // handshake: no customaise-mcp peer would send one, so its
        // arrival confirms we're talking to a real leader.
        if (!handshakeComplete && frame.role === 'status') {
          handshakeComplete = true;
          clearTimeout(handshakeTimer);
          // Through the SAME handler the later frames use. Reading only
          // `extensionConnected` here is what made `doctor` report every
          // session field as unknown forever: the connect-time frame is the
          // one that carries them, and re-broadcasts only follow an
          // init_session or a connect, neither of which happens again for a
          // follower that attached after the extension was already up.
          this._applyStatusFrame(frame);
          // If MCP already called setOwnClientInfo before the WS was
          // open, flush the deferred send now that we have a pipe.
          this._forwardClientInfoIfReady();
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }
        this._handleLeaderFrame(frame);
      } catch (err) {
        this._log(`Failed to parse leader frame: ${err}`);
      }
    });

    ws.on('close', (code, reason) => {
      this._log(`Leader closed connection (code=${code}, reason=${reason.toString()})`);
      // An explicit eviction: the leader read our hello and refused it. Keep
      // the reason so every dispatch until a compatible leader appears fails
      // with the actual explanation instead of a generic reconnect error.
      if (code === 4001) {
        this.protocolMismatch = reason.toString() ||
          ('The leader on :' + this.port + ' evicted this process over a relay protocol mismatch. Restart the older of the two.');
      }
      clearTimeout(handshakeTimer);
      this.ws = null;
      this.extensionConnected = false;
      // Reject any in-flight requests — the leader won't deliver
      // responses for them now.
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Leader bridge disconnected before response arrived. Retry the request.'));
      }
      this.pending.clear();
      if (!settled) {
        settled = true;
        reject(new Error(`Could not connect to leader on :${this.port} — connection closed before handshake`));
        return;
      }
      // We were a working follower and the leader went away. Reattach:
      // usually another process has already taken the port.
      this._scheduleReconnect();
    });

    ws.on('error', (err) => {
      this._log(`Leader WS error: ${err.message}`);
      clearTimeout(handshakeTimer);
      if (!settled) { settled = true; reject(err); }
    });
  }

  private _handleLeaderFrame(frame: LeaderFrame): void {
    switch (frame.role) {
      case 'res': {
        const pending = this.pending.get(frame.id);
        if (!pending) {
          this._log(`Received response for unknown request id: ${frame.id}`);
          return;
        }
        this.pending.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.success) {
          pending.resolve(frame.result);
        } else {
          pending.reject(this._maybeRehydrateProtocolError(
            new Error(frame.error || 'Leader relayed an error from the extension'),
          ));
        }
        break;
      }
      case 'res-pending': {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        const extendMs = Math.max(frame.expectedTimeoutMs || 0, this.requestTimeoutMs);
        clearTimeout(pending.timer);
        pending.timer = setTimeout(() => {
          const stillPending = this.pending.get(frame.id);
          if (!stillPending) return;
          this.pending.delete(frame.id);
          // See the leader's matching branch: our timer firing is a
          // dispatch timeout, not evidence of what the user chose.
          stillPending.reject(new ProtocolError(
            ERROR_CODE_DISPATCH_TIMEOUT,
            `Request to extension timed out after ${extendMs}ms (type=consent-pending, id=${frame.id})`,
            { type: 'dispatch_timeout' },
          ));
        }, extendMs);
        this._log(`Request ${frame.id} extended to ${extendMs}ms (reason: ${frame.reason || 'unspecified'})`);
        break;
      }
      case 'push': {
        if (this.pushHandler) {
          try { this.pushHandler(frame.type, frame.data); } catch (err) {
            this._log(`pushHandler threw: ${(err as Error).message}`);
          }
        }
        break;
      }
      case 'status': {
        this._applyStatusFrame(frame);
        break;
      }
      default: {
        this._log(`Unknown leader frame role: ${(frame as any).role}`);
      }
    }
  }

  async request(type: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) {
      throw new Error('Bridge is closed');
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new ProtocolError(
        ERROR_CODE_DISPATCH_TIMEOUT,
        'Leader bridge is not connected. The customaise-mcp leader process may have exited.',
        { type: 'leader_unreachable' },
      );
    }
    // Before the extension check, because through a mismatched leader even
    // `extensionConnected` came from a frame whose shape we cannot trust.
    if (this.protocolMismatch) {
      throw new ProtocolError(
        ERROR_CODE_RELAY_PROTOCOL_MISMATCH,
        this.protocolMismatch,
        { type: 'relay_protocol_mismatch' },
      );
    }
    if (!this.extensionConnected) {
      throw new ProtocolError(
        ERROR_CODE_DISPATCH_TIMEOUT,
        'Customaise extension is not connected to the leader bridge. Check that Chrome is running with the extension loaded, that MCP is enabled in Customaise Settings, and that you are signed in: signing out disables the bridge deliberately.',
        { type: 'extension_not_connected' },
      );
    }

    const id = randomUUID();

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProtocolError(
          ERROR_CODE_DISPATCH_TIMEOUT,
          `Request to extension timed out after ${this.requestTimeoutMs}ms (type=${type}, id=${id})`,
          { type: 'dispatch_timeout' },
        ));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      const frame = { role: 'req' as const, id, type, args };
      this.ws!.send(JSON.stringify(frame));
    });
  }

  /**
   * Cap-enforced tool dispatch (ARD §4.4) for follower processes.
   * Sends a `req-dispatch` frame to the leader; the leader runs cap
   * enforcement against its single CapSession (one per extension
   * connection, not per IDE) and relays the result back. ProtocolError
   * codes survive the relay via JSON-encoded error strings the
   * leader writes for us to rehydrate here.
   */
  async dispatchTool(
    tool: string,
    args: Record<string, unknown> = {},
    _opts: DispatchOptions = {},
  ): Promise<unknown> {
    // Cancellation is not forwarded across the follower channel yet: the
    // leader owns the dispatch and the peer protocol has no cancel frame.
    // A follower that aborts still stops waiting; the modal closes on its
    // own five-minute budget. Named rather than silent so the gap is
    // visible when the peer protocol next changes.
    if (this.closed) {
      throw new Error('Bridge is closed');
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new ProtocolError(
        ERROR_CODE_DISPATCH_TIMEOUT,
        'Leader bridge is not connected. The customaise-mcp leader process may have exited.',
        { type: 'leader_unreachable' },
      );
    }
    // Before the extension check, because through a mismatched leader even
    // `extensionConnected` came from a frame whose shape we cannot trust.
    if (this.protocolMismatch) {
      throw new ProtocolError(
        ERROR_CODE_RELAY_PROTOCOL_MISMATCH,
        this.protocolMismatch,
        { type: 'relay_protocol_mismatch' },
      );
    }
    if (!this.extensionConnected) {
      throw new ProtocolError(
        ERROR_CODE_DISPATCH_TIMEOUT,
        'Customaise extension is not connected to the leader bridge. Check that Chrome is running with the extension loaded, that MCP is enabled in Customaise Settings, and that you are signed in: signing out disables the bridge deliberately.',
        { type: 'extension_not_connected' },
      );
    }

    const id = randomUUID();

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Dispatch to extension timed out after ${this.requestTimeoutMs}ms (tool=${tool}, id=${id})`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve,
        // Wrap reject so we can rehydrate ProtocolError from the leader's
        // JSON-encoded error string.
        reject: (err) => {
          const rehydrated = this._maybeRehydrateProtocolError(err);
          reject(rehydrated);
        },
        timer,
      });

      const frame = { role: 'req-dispatch' as const, id, tool, args };
      this.ws!.send(JSON.stringify(frame));
    });
  }

  /**
   * The leader serialises ProtocolError as `JSON.stringify({code, message, data})`
   * in the relayed `error` field; rehydrate to a real ProtocolError so the
   * follower's MCP SDK surfaces the right JSON-RPC code to its IDE.
   * Plain Errors (network drops, etc.) pass through unchanged.
   */
  private _maybeRehydrateProtocolError(err: Error): Error {
    const msg = err?.message;
    if (typeof msg !== 'string' || !msg.startsWith('{')) return err;
    try {
      const parsed = JSON.parse(msg);
      if (!parsed || typeof parsed.message !== 'string') return err;
      if (typeof parsed.code === 'number') {
        return new ProtocolError(parsed.code, parsed.message, parsed.data ?? undefined);
      }
      // Codeless but typed: the extension's refusals carry `data.type` and no
      // number, on purpose. Rebuild a plain Error with the data attached so
      // the type survives the relay and the CLI can still branch on it.
      if (parsed.data !== undefined && parsed.data !== null) {
        const rebuilt: Error & { data?: unknown } = new Error(parsed.message);
        rebuilt.data = parsed.data;
        return rebuilt;
      }
    } catch { /* not JSON, fall through */ }
    return err;
  }

  onPush(handler: (type: string, data: any) => void): void {
    this.pushHandler = handler;
  }

  /**
   * Stash the follower process's own MCP client identity and forward
   * it to the leader so the leader can include us in the extension's
   * hello frame. Safe to call before or after start() — if WS isn't
   * open yet, we defer the send until it is.
   *
   * Idempotent — if the incoming name+version exactly matches the
   * last stored value, skip the forward (no point waking the leader
   * on MCP-initialize replays with unchanged clientInfo).
   */
  setOwnClientInfo(info: BridgeClientInfo): void {
    if (!info || typeof info.name !== 'string' || typeof info.version !== 'string') return;
    const next = { name: info.name.slice(0, 128), version: info.version.slice(0, 64) };
    const current = this.myClientInfo;
    if (current && current.name === next.name && current.version === next.version) return;
    this.myClientInfo = next;
    this._forwardClientInfoIfReady();
  }

  private _forwardClientInfoIfReady(): void {
    if (!this.myClientInfo) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({
        role: 'client-info',
        name: this.myClientInfo.name,
        version: this.myClientInfo.version,
      }));
    } catch (err) {
      this._log(`Failed to forward client-info: ${(err as Error).message}`);
    }
  }

  /**
   * Reattach to whatever holds :port now, with a capped backoff.
   *
   * Never runs after a deliberate `close()`, and never stacks: a pending
   * timer is left alone rather than replaced, so a burst of close events
   * cannot turn into a burst of connection attempts.
   */
  private _scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;

    const delay = Math.min(
      this.RECONNECT_BASE_MS * 2 ** this.reconnectAttempts,
      this.RECONNECT_MAX_MS,
    );
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this._connect(
        () => {
          this.reconnectAttempts = 0;
          this._log(`Reattached to leader on :${this.port}`);
          // The status frame that resolves this also re-sends our client
          // info, so the extension's connected-IDE list repopulates without
          // anything here having to remember to do it.
        },
        (err) => {
          this._log(`Reattach failed: ${err.message}`);
          this._scheduleReconnect();
        },
      );
    }, delay);
    // Do not hold the process open purely to retry a connection.
    this.reconnectTimer.unref?.();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Bridge is shutting down'));
    }
    this.pending.clear();
    if (this.ws) {
      try { this.ws.close(1000, 'Follower shutting down'); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  /**
   * Adopt a leader status frame. One definition, because two paths receive
   * these: the connect handshake and the ongoing frame router. A field added
   * to only one of them is the asymmetry that shows up as state which is
   * either never set or set once and then reverts.
   */
  private _applyStatusFrame(frame: { relayProtocol?: number; extensionConnected: boolean; session?: BridgeSessionSnapshot }): void {
    // The relay contract, checked from the only frame an old leader would
    // still send. Absent means the leader predates the contract: same
    // situation as a mismatch, and it must fail closed for the same reason —
    // every frame after this one would have undefined semantics. Cleared on
    // match so a compatible leader winning the port heals us without a
    // restart.
    if (frame.relayProtocol !== RELAY_PROTOCOL_VERSION) {
      this.protocolMismatch =
        'The process holding :' + this.port + ' speaks relay protocol ' +
        (frame.relayProtocol ?? 'pre-1 (older than the contract)') +
        ' but this one speaks ' + RELAY_PROTOCOL_VERSION +
        '. Restart the older of the two (usually the IDE-spawned server, or `customaise daemon stop`).';
      this._log(this.protocolMismatch);
    } else {
      this.protocolMismatch = null;
    }
    this.extensionConnected = frame.extensionConnected;
    // A follower has no CapSession of its own; the leader relays its snapshot
    // so `doctor` answers the same question from either role.
    if (frame.session) this.sessionSnapshot = frame.session;
    // Version skew between this process and the one holding :4050. Nothing
    // negotiates this seam: the IDE owns the leader's lifetime and `npx -y`
    // resolves `latest` per spawn, so every rollout mixes builds for hours by
    // design. The relay frames are additive JSON, so skew works today — this
    // warning is what turns "works by luck" into "visible when the luck runs
    // out". Once, not per frame: status frames re-arrive on every change.
    const lv = frame.session?.leaderVersion;
    if (lv && lv !== OWN_VERSION && !this._warnedLeaderSkew) {
      this._warnedLeaderSkew = true;
      process.stderr.write(
        '[customaise-mcp] leader on :4050 is ' + lv + ' but this process is ' + OWN_VERSION +
        '. Mixed versions relay fine today, but if something is inexplicably wrong, restart the older one.\n',
      );
    }
  }

  getSystemStatus(): SystemStatusSnapshot | null {
    return this.sessionSnapshot?.systemStatus ?? null;
  }

  getSessionSnapshot(): BridgeSessionSnapshot {
    return this.sessionSnapshot ?? {
      extensionConnected: this.extensionConnected,
      systemStatus: null,
      tier: null,
      authenticated: null,
      remoteApprovals: null,
      capMode: null,
      dailyUsed: null,
      dailyCap: null,
      weeklyUsed: null,
      leaderVersion: null,
      weeklyCap: null,
    };
  }

  /** Exposed for logs and tests — matches ExtensionBridge.isConnected shape. */
  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.extensionConnected;
  }

  private _log(message: string): void {
    process.stderr.write(`[customaise-mcp] ${message}\n`);
  }
}
