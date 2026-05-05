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
 *   - Leader goes away: WS close fires. All in-flight requests reject
 *     with a clear error. Subsequent request() calls attempt to
 *     promote self to leader (try to bind :port). If promotion fails
 *     (another follower raced and won), we reconnect as follower.
 */

import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type { Bridge, BridgeClientInfo } from './bridge.js';
import { FOLLOWER_ORIGIN } from './extension-bridge.js';

interface PendingFollowerRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type LeaderFrame =
  | { role: 'res'; id: string; success: boolean; result?: unknown; error?: string }
  | { role: 'res-pending'; id: string; expectedTimeoutMs: number; reason?: string }
  | { role: 'push'; type: string; data: any }
  | { role: 'status'; extensionConnected: boolean };

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
          this.extensionConnected = frame.extensionConnected;
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
      }
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
          pending.reject(new Error(frame.error || 'Leader relayed an error from the extension'));
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
          stillPending.reject(new Error(
            `Request to extension timed out after ${extendMs}ms (type=consent-pending, id=${frame.id})`,
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
        this.extensionConnected = frame.extensionConnected;
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
      throw new Error('Leader bridge is not connected. The customaise-mcp leader process may have exited.');
    }
    if (!this.extensionConnected) {
      throw new Error(
        'Customaise extension is not connected to the leader bridge. Make sure Chrome is running with the Customaise extension loaded.',
      );
    }

    const id = randomUUID();

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request to extension timed out after ${this.requestTimeoutMs}ms (type=${type}, id=${id})`));
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
   * connection, not per IDE) and relays the result back. McpError
   * codes survive the relay via JSON-encoded error strings the
   * leader writes for us to rehydrate here.
   */
  async dispatchTool(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) {
      throw new Error('Bridge is closed');
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Leader bridge is not connected. The customaise-mcp leader process may have exited.');
    }
    if (!this.extensionConnected) {
      throw new Error(
        'Customaise extension is not connected to the leader bridge. Make sure Chrome is running with the Customaise extension loaded.',
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
        // Wrap reject so we can rehydrate McpError from the leader's
        // JSON-encoded error string.
        reject: (err) => {
          const rehydrated = this._maybeRehydrateMcpError(err);
          reject(rehydrated);
        },
        timer,
      });

      const frame = { role: 'req-dispatch' as const, id, tool, args };
      this.ws!.send(JSON.stringify(frame));
    });
  }

  /**
   * The leader serialises McpError as `JSON.stringify({code, message, data})`
   * in the relayed `error` field; rehydrate to a real McpError so the
   * follower's MCP SDK surfaces the right JSON-RPC code to its IDE.
   * Plain Errors (network drops, etc.) pass through unchanged.
   */
  private _maybeRehydrateMcpError(err: Error): Error {
    const msg = err?.message;
    if (typeof msg !== 'string' || !msg.startsWith('{')) return err;
    try {
      const parsed = JSON.parse(msg);
      if (parsed && typeof parsed.code === 'number' && typeof parsed.message === 'string') {
        return new McpError(parsed.code, parsed.message, parsed.data ?? undefined);
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

  async close(): Promise<void> {
    this.closed = true;
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

  /** Exposed for logs and tests — matches ExtensionBridge.isConnected shape. */
  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.extensionConnected;
  }

  private _log(message: string): void {
    process.stderr.write(`[customaise-mcp] ${message}\n`);
  }
}
