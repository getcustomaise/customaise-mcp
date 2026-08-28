/**
 * ElectingBridge — the Bridge that production code actually holds.
 *
 * Leadership of :4050 is not a role a process is born into. It is a lease
 * the process must be prepared to lose and retake, because the process
 * holding the port can vanish at any moment and for reasons that have
 * nothing to do with us: an IDE restarts, a CLI daemon idle-exits, or a host
 * spawns a DISPOSABLE copy of this server purely to probe its protocol
 * revision and reaps it a second later. Claude Desktop does exactly that
 * (`Era probe verdict: modern (sibling answered server/discover)`), and on a
 * cold boot the probe ran slowly enough for a real server to lose the bind
 * race to it.
 *
 * Before this class existed, leadership was decided once inside
 * `createBridge` and never revisited. That left two holes with one root:
 *
 *   1. Lose the bind, dial the winner, and find it already dead: the
 *      process exited with "connection closed before handshake". The host
 *      reported it as a version-negotiation failure, and the session had no
 *      tools until the app was restarted.
 *   2. Lose the bind, dial the winner, be GREETED, and then have it die: the
 *      process lived on as an orphan dialling a dead port at capped backoff,
 *      forever. Nobody re-bound the port, so the extension had no one to
 *      connect to either. The extension gives up after three reconnect
 *      attempts and falls back to a five-minute heartbeat, so the user saw
 *      MCP "randomly disconnect" and had to toggle it by hand.
 *
 * Both are the same bug: neither outcome of the race is terminal on its own.
 * Losing the bind means try to follow, and losing the leader means the port
 * is free again, so try to bind. This class runs that loop at startup and
 * again every time a follower's leader goes away, and swaps the inner bridge
 * underneath the reference the rest of the server holds. The election is
 * EAGER, not lazy-on-next-request: the extension's reconnect budget is short
 * (5s, 10s, 20s, then a five-minute heartbeat), so the port must be retaken
 * within seconds of being dropped or the user pays minutes for it.
 *
 * The bind itself is the arbiter. When a leader dies and several followers
 * re-elect at once, exactly one `listen` succeeds and the rest see
 * EADDRINUSE and rejoin it. No coordination, no ids, no terms.
 */

import { ProtocolError } from '@modelcontextprotocol/server';
import { ERROR_CODE_DISPATCH_TIMEOUT, ERROR_CODE_RELAY_PROTOCOL_MISMATCH } from './cap-state.js';
import type {
  Bridge,
  BridgeClientInfo,
  BridgeSessionSnapshot,
  DispatchOptions,
  SystemStatusSnapshot,
} from './bridge.js';
import { ExtensionBridge } from './extension-bridge.js';
import { RemoteBridge } from './remote-bridge.js';

type Inner = ExtensionBridge | RemoteBridge;

/**
 * Backoff between election attempts. Starts short because the common cause
 * is a reaped sibling whose port is free within milliseconds; caps at five
 * seconds because a port held by a stranger for minutes should cost one
 * cheap probe per few seconds, not a hot loop.
 */
const ELECTION_BACKOFF_BASE_MS = 50;
const ELECTION_BACKOFF_MAX_MS = 5000;

/**
 * At startup an IDE is waiting on `initialize`, so a port that will not
 * settle has to become an error it can show. Six attempts is ~1.5s of
 * backoff: long enough to outlive a reaped sibling, short enough that no
 * client times out waiting. After startup there is no one to report to and
 * the alternative to retrying is an orphan, so recovery never gives up.
 */
const STARTUP_MAX_TRANSIENT_ATTEMPTS = 6;

/**
 * How long a leader that stepped down waits before re-racing the port.
 * Longer than STEP_DOWN_YIELD_MS by design: the newer follower races at
 * once, the other followers after the yield, and the old leader last of all,
 * so it rejoins the process it yielded to rather than beating it to the bind.
 */
const STEP_DOWN_GRACE_MS = 500;

/**
 * Once stepped down for a given version, do not do it again for that version
 * within this window.
 *
 * Stepping down closes the extension's socket, and a newer follower that
 * then fails to bind (a sandbox, a transient error, or simply a process that
 * is not an ElectingBridge) reattaches after we retake the port, sends the
 * same hello, and we would step down again: an endless cycle in which the
 * extension is disconnected more often than not. The same primitive would
 * let a hostile local process do it on purpose. One step-down per version
 * per window bounds both; after the window the fleet is back to today's
 * behaviour, an older leader that still works.
 */
const STEP_DOWN_COOLDOWN_MS = 60_000;

/**
 * Follower failures that mean "the port is free again" at startup.
 *
 * ENOTLEADER is deliberately absent from this set: at startup, a peer that
 * holds the port and does not speak our handshake will still be there on
 * the next attempt, so retrying only spends another five seconds to reach
 * the same answer. During recovery it IS retried, because a stranger that
 * took the port after our leader died may well leave again, and giving up
 * would recreate the orphan this class exists to prevent.
 */
const TRANSIENT_FOLLOWER_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ELEADERGONE']);

const EMPTY_SNAPSHOT: BridgeSessionSnapshot = {
  extensionConnected: false,
  systemStatus: null,
  tier: null,
  authenticated: null,
  remoteApprovals: null,
  capMode: null,
  dailyUsed: null,
  dailyCap: null,
  weeklyUsed: null,
  weeklyCap: null,
  leaderVersion: null,
};


function log(line: string): void {
  process.stderr.write(`[customaise-mcp] ${line}\n`);
}

export class ElectingBridge implements Bridge {
  private inner: Inner | null = null;
  /** Non-null while an election is running; every dispatch waits on it. */
  private electing: Promise<Inner> | null = null;
  private closed = false;

  // Re-applied to every inner bridge this object adopts. The server
  // registers these once, against this object, and must not have to know
  // that the thing underneath was replaced.
  private pushHandler: ((type: string, data: any) => void) | null = null;
  private clientInfo: BridgeClientInfo | null = null;
  /**
   * Set when the seat was lost to an eviction over the relay contract, and
   * cleared the moment any election succeeds. While set, dispatches fail at
   * once with the leader's own explanation instead of waiting out an
   * election that will only be evicted again: the older process must be
   * restarted, and no amount of retrying changes that.
   */
  private mismatchReason: string | null = null;
  /** Resolves the backoff sleep early, so `close()` never waits on a timer. */
  private wake: (() => void) | null = null;
  /**
   * The last version stepped down for, when, and whether it actually took
   * the port. Only a hand-over that FAILED (we retook the port ourselves)
   * arms the cooldown: that is the storm case. One that succeeded and is
   * simply being repeated later, because the newer process restarted and
   * we won the bind in between, must be honoured again or the newer process
   * ends up a follower of an older leader with nothing to re-trigger it.
   */
  private lastStepDown: { version: string; at: number; handedOver: boolean } | null = null;

  constructor(
    private readonly port: number,
    private readonly requestTimeoutMs: number,
  ) {}

  /**
   * The role of whatever currently holds our seat. Before `start()` and
   * during a re-election this is the LAST known role, which is honest: a
   * process mid-election holds nothing, and reporting `leader` for it would
   * send a reader of `get_bridge_status` to check Chrome when the problem is
   * the port.
   */
  get role(): 'leader' | 'follower' {
    return this.inner?.role ?? 'follower';
  }

  get isConnected(): boolean {
    return this.inner?.isConnected ?? false;
  }

  async start(): Promise<void> {
    this.adopt(await this.runElection('startup'));
  }

  async request(type: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return (await this.ready()).request(type, args);
  }

  async dispatchTool(
    toolName: string,
    args: Record<string, unknown> = {},
    opts: DispatchOptions = {},
  ): Promise<unknown> {
    return (await this.ready()).dispatchTool(toolName, args, opts);
  }

  onPush(handler: (type: string, data: any) => void): void {
    this.pushHandler = handler;
    this.inner?.onPush(handler);
  }

  setOwnClientInfo(info: BridgeClientInfo): void {
    this.clientInfo = info;
    this.inner?.setOwnClientInfo(info);
  }

  getSessionSnapshot(): BridgeSessionSnapshot {
    return this.inner?.getSessionSnapshot() ?? EMPTY_SNAPSHOT;
  }

  getSystemStatus(): SystemStatusSnapshot | null {
    return this.inner?.getSystemStatus() ?? null;
  }

  async close(): Promise<void> {
    this.closed = true;
    // An election in flight checks `closed` after every await and closes
    // whatever it just opened, so nothing here needs to chase it beyond
    // cutting its backoff short.
    this.wake?.();
    const inner = this.inner;
    this.inner = null;
    if (inner) await inner.close();
  }

  // ─── Election ──────────────────────────────────────────────────────────

  /**
   * The inner bridge to dispatch on, once there is one.
   *
   * A dispatch that lands during a re-election waits for it rather than
   * failing, because the common re-election is over in well under a second
   * and an agent's tool call should not fail for having been unlucky by
   * 100ms. The wait is bounded by the request timeout so a port that never
   * settles still surfaces as the typed error the CLI maps to exit 3.
   */
  private async ready(): Promise<Inner> {
    if (this.closed) throw new Error('Bridge is closed');
    if (this.mismatchReason) {
      throw new ProtocolError(
        ERROR_CODE_RELAY_PROTOCOL_MISMATCH,
        this.mismatchReason,
        { type: 'relay_protocol_mismatch' },
      );
    }
    if (this.electing) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new ProtocolError(
            ERROR_CODE_DISPATCH_TIMEOUT,
            'Leader bridge is not connected. The customaise-mcp leader process may have exited.',
            { type: 'leader_unreachable' },
          ));
        }, this.requestTimeoutMs);
      });
      try {
        return await Promise.race([this.electing, timeout]);
      } finally {
        clearTimeout(timer);
      }
    }
    if (!this.inner) throw new Error('Bridge not started');
    return this.inner;
  }

  private adopt(inner: Inner): void {
    this.inner = inner;
    this.mismatchReason = null;
    if (this.pushHandler) inner.onPush(this.pushHandler);
    if (this.clientInfo) inner.setOwnClientInfo(this.clientInfo);
    if (inner instanceof RemoteBridge) {
      inner.onLeaderLost(() => this.recover(inner));
    } else {
      inner.onNewerFollower((version) => this.abdicate(inner, version));
    }
  }

  /**
   * A newer package joined as a follower: hand it the port.
   *
   * The only way a process can move leadership is to release the bind and
   * let the election run again, so that is what this does: close the
   * listener with a close code that names the newer version (followers
   * that are not it hold back), wait longer than they do, and re-elect.
   * The expected outcome is that this process rejoins as a follower of the
   * version it yielded to. If nothing binds in the meantime, the election
   * simply takes the port back, so stepping down can never leave the seat
   * empty for longer than the grace.
   */
  private abdicate(leader: ExtensionBridge, newer: string): void {
    if (this.closed || this.inner !== leader || this.electing) return;
    const last = this.lastStepDown;
    if (last && last.version === newer && !last.handedOver && Date.now() - last.at < STEP_DOWN_COOLDOWN_MS) {
      log(`Already stepped down for ${newer} recently and it did not take the port — staying leader for now`);
      return;
    }
    const record = { version: newer, at: Date.now(), handedOver: false };
    this.lastStepDown = record;
    log(`A newer customaise-mcp (${newer}) joined as a follower — stepping down so it can lead`);
    leader.stepDown(newer);
    this.electing = leader.close()
      .then(() => this.backoff(STEP_DOWN_GRACE_MS))
      .then(() => this.runElection('recover'))
      .then((next) => {
        // Rejoining as a follower means someone took the port; binding it
        // ourselves means nobody did.
        record.handedOver = next instanceof RemoteBridge;
        this.adopt(next);
        return next;
      })
      .finally(() => {
        this.electing = null;
      });
    this.electing.catch(() => {});
  }

  /**
   * A follower's leader went away. Re-run the election and swap.
   *
   * Guarded against the stale case: a follower we have already replaced
   * may still fire its close event, and that must not start a second
   * election over the top of a seat we hold.
   */
  private recover(lost: RemoteBridge): void {
    if (this.closed || this.inner !== lost || this.electing) return;
    this.mismatchReason = lost.evictionReason;
    log(
      this.mismatchReason
        ? `Evicted by the leader on :${this.port} — re-electing until a compatible one holds it`
        : `Leader on :${this.port} went away — re-electing`,
    );
    void lost.close();
    // A step-down names the process that should bind first; everyone else
    // holds back so it does. Zero when it is us, or when the leader just died.
    const yieldMs = lost.reelectionDelayMs;
    if (yieldMs) log(`Holding back ${yieldMs}ms so the newer process can take :${this.port} first`);
    this.electing = (yieldMs ? this.backoff(yieldMs) : Promise.resolve())
      .then(() => this.runElection('recover'))
      .then((next) => {
        this.adopt(next);
        return next;
      })
      .finally(() => {
        this.electing = null;
      });
    // The only rejection is `close()` mid-election, which already means
    // nobody is listening for the outcome.
    this.electing.catch(() => {});
  }

  private async runElection(phase: 'startup' | 'recover'): Promise<Inner> {
    let transientAttempts = 0;
    for (let attempt = 0; ; attempt++) {
      if (this.closed) throw new Error('Bridge is closed');

      const local = new ExtensionBridge(this.port, this.requestTimeoutMs);
      try {
        await local.start();
        if (this.closed) {
          await local.close();
          throw new Error('Bridge is closed');
        }
        log(
          `Bridge role=leader, listening on :${this.port}` +
            (phase === 'recover' ? ' (promoted)' : ''),
        );
        return local;
      } catch (err: any) {
        if (err?.code !== 'EADDRINUSE') {
          // At startup an unexpected bind error is the IDE's to show. In
          // recovery there is nobody to show it to, and giving up would
          // recreate the orphan this class exists to prevent, so it is
          // logged and retried like any other transient.
          if (phase === 'startup') throw err;
          log(`Could not bind :${this.port} (${err?.code ?? err?.message}) — retrying`);
          await this.backoff(Math.min(ELECTION_BACKOFF_BASE_MS * 2 ** attempt, ELECTION_BACKOFF_MAX_MS));
          continue;
        }
        // Port is held by another process. Become a follower: connect to it
        // over WebSocket and proxy all bridge traffic through it.
        //
        // Important: do NOT call local.close() here. When bind failed, the
        // WSS never entered the listening state; close()'s callback
        // behaviour on a never-listened server is library-defined and could
        // hang or throw. The instance is unused and will be GC'd.
      }

      log(`:${this.port} in use — starting as follower`);
      const remote = new RemoteBridge(this.port, this.requestTimeoutMs);
      try {
        await remote.start();
        if (this.closed) {
          await remote.close();
          throw new Error('Bridge is closed');
        }
        log(
          `Bridge role=follower, connected to leader on :${this.port}` +
            (phase === 'recover' ? ' (rejoined)' : ''),
        );
        return remote;
      } catch (followerErr: any) {
        // The failed candidate terminates its socket; a peer that never
        // greeted us may never answer a close frame either.
        await remote.close();
        if (this.closed) throw followerErr;

        if (phase === 'startup') {
          const transient = TRANSIENT_FOLLOWER_CODES.has(followerErr?.code);
          if (!transient) throw followerErr;
          if (++transientAttempts > STARTUP_MAX_TRANSIENT_ATTEMPTS) {
            // The IDE shows this message verbatim. "connection closed before
            // handshake" describes the last attempt; the user needs to know
            // there were six, and what that means.
            throw Object.assign(
              new Error(
                `Could not settle who holds :${this.port} after ${STARTUP_MAX_TRANSIENT_ATTEMPTS} attempts: ` +
                  `something kept taking the port and disappearing (last: ${followerErr.message}). ` +
                  'Another customaise-mcp process may be crash-looping; check other IDEs and `customaise daemon status`.',
              ),
              { code: followerErr.code },
            );
          }
        }

        const delay = Math.min(ELECTION_BACKOFF_BASE_MS * 2 ** attempt, ELECTION_BACKOFF_MAX_MS);
        log(
          `Could not follow the process on :${this.port} ` +
            `(${followerErr?.code ?? followerErr?.message}) — re-racing the port in ${delay}ms`,
        );
        await this.backoff(delay);
      }
    }
  }

  /**
   * A ref'd timer, deliberately. The first version unref'd it so a closing
   * process was not held open by a retry, and the test suite caught what
   * that does at startup: `createBridge` is awaited before `serveStdio`
   * attaches stdin, so nothing else holds the event loop, and Node drained
   * it mid-backoff and exited without a word. `close()` wakes the sleep
   * instead, which is what the unref was for.
   */
  private backoff(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.wake = null; resolve(); }, ms);
      this.wake = () => { clearTimeout(timer); this.wake = null; resolve(); };
    });
  }
}
