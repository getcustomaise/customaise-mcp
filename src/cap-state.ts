/**
 * Cap state — pure logic for tracking the MCP server's per-session
 * counter and deciding when to allow / refuse a tool dispatch.
 *
 * Architecture (per ARD §4.4):
 *  - Extension owns the persistent counter (chrome.storage.local)
 *  - MCP server holds an in-memory mirror, adopted from the extension's
 *    init_session frame and updated on every dispatch_ack
 *  - Cap pre-check happens BEFORE the dispatch round-trip — Free user
 *    over-cap dispatches never reach the extension at all
 *
 * No imports, no side effects. Easy to unit test.
 */

export const DAILY_CAP = 50;
export const WEEKLY_CAP = 150;

/**
 * JSON-RPC server-error codes (in the implementation-defined
 * -32000..-32099 range so MCP clients treat them as transient and
 * actionable, NOT as fatal/cacheable like -32603). Locked by ARD §8.
 */
export const ERROR_CODE_AUTH_REQUIRED = -32028;
export const ERROR_CODE_CAP_EXCEEDED = -32029;
export const ERROR_CODE_DISPATCH_TIMEOUT = -32030;
export const ERROR_CODE_EXTENSION_OUTDATED = -32031;
export const ERROR_CODE_INTEGRITY_VIOLATION = -32032;

/**
 * Semantic states for a session. The server-side cap behaviour branches
 * on these.
 */
export type SessionMode =
  | 'pending'        // bridge connected, awaiting init_session within grace period
  | 'unlimited'      // init_session arrived with unlimited:true (Power User / Trial)
  | 'capped'         // init_session arrived with cap fields (Free)
  | 'legacy'         // grace period expired without init_session (old extension)
  | 'compromised';   // backwards-counter ack detected; refuse further dispatches until reconnect

/**
 * Live state held in-memory by ExtensionBridge for each connected
 * extension session. Reset on every bridge reconnect.
 */
export interface CapSession {
  /** Session GUID — for legacy sessions, server-generated; otherwise from extension's init_session. */
  sessionId: string;
  /** Extension's install_id (random GUID), for telemetry attribution. Null for legacy sessions. */
  installId: string | null;
  mode: SessionMode;
  /** Per-day count tracked by the server. For unlimited/compromised, unused. */
  dailyUsed: number;
  /** Rolling 7-day count tracked by the server. */
  weeklyUsed: number;
  /** Cap values from extension. For unlimited, unused. */
  dailyCap: number;
  weeklyCap: number;
  /** UTC date string YYYY-MM-DD that dailyUsed corresponds to. UTC midnight rollover resets dailyUsed to 0. */
  dailyDateUtc: string;
  /** Monotonic seq_num for outgoing dispatch_tool frames. Increments on every dispatch attempt. */
  nextSeqNum: number;
  /** Has the server already sent the one-time "extension out of date" deprecation error to the IDE? */
  deprecationErrorSent: boolean;
}

/** Pure constructor for a fresh session in 'pending' state. */
export function createPendingSession(sessionId: string): CapSession {
  return {
    sessionId,
    installId: null,
    mode: 'pending',
    dailyUsed: 0,
    weeklyUsed: 0,
    dailyCap: DAILY_CAP,
    weeklyCap: WEEKLY_CAP,
    dailyDateUtc: utcDateString(new Date()),
    nextSeqNum: 1,
    deprecationErrorSent: false,
  };
}

/**
 * Apply an `init_session` payload from the extension. Switches the
 * session out of 'pending' into 'unlimited' or 'capped' depending on
 * the payload shape.
 *
 * Forgiving on missing fields: if extension reports tier='free' without
 * cap fields, we use the defaults. If extension reports unlimited:true,
 * we ignore any cap fields it may also have included.
 */
export function applyInitSession(
  session: CapSession,
  payload: {
    session_id?: string;
    install_id?: string;
    tier?: string;
    unlimited?: boolean;
    daily_cap?: number;
    weekly_cap?: number;
    current_used_daily?: number;
    current_used_week?: number;
  },
): CapSession {
  const next: CapSession = { ...session };
  if (typeof payload.session_id === 'string' && payload.session_id.length > 0) {
    next.sessionId = payload.session_id;
  }
  if (typeof payload.install_id === 'string' && payload.install_id.length > 0) {
    next.installId = payload.install_id;
  }
  if (payload.unlimited === true || payload.tier === 'power_user' || payload.tier === 'trial') {
    next.mode = 'unlimited';
    return next;
  }
  next.mode = 'capped';
  if (Number.isFinite(payload.daily_cap) && (payload.daily_cap as number) >= 0) {
    next.dailyCap = payload.daily_cap as number;
  }
  if (Number.isFinite(payload.weekly_cap) && (payload.weekly_cap as number) >= 0) {
    next.weeklyCap = payload.weekly_cap as number;
  }
  if (Number.isFinite(payload.current_used_daily) && (payload.current_used_daily as number) >= 0) {
    next.dailyUsed = Math.floor(payload.current_used_daily as number);
  }
  if (Number.isFinite(payload.current_used_week) && (payload.current_used_week as number) >= 0) {
    next.weeklyUsed = Math.floor(payload.current_used_week as number);
  }
  return next;
}

/** Mark a session as legacy (extension never sent init_session within grace). */
export function markLegacy(session: CapSession): CapSession {
  return { ...session, mode: 'legacy' };
}

/** Mark a session compromised (backwards-counter ack). Refuses further dispatches. */
export function markCompromised(session: CapSession): CapSession {
  return { ...session, mode: 'compromised' };
}

/**
 * Roll the daily counter over if the UTC date has changed since
 * `session.dailyDateUtc`. Returns the (possibly updated) session and
 * a flag indicating whether the rollover happened.
 *
 * Note: weekly counter is intentionally NOT reset here — the rolling
 * 7-day window is enforced by the extension (which keeps a 7-element
 * history); the server adopts whatever weeklyUsed the extension reports
 * on the next ack and trusts that.
 */
export function rolloverDailyIfNeeded(session: CapSession, now: Date): { session: CapSession; rolled: boolean } {
  const todayUtc = utcDateString(now);
  if (todayUtc === session.dailyDateUtc) {
    return { session, rolled: false };
  }
  return {
    session: { ...session, dailyDateUtc: todayUtc, dailyUsed: 0 },
    rolled: true,
  };
}

/**
 * Decision: can this session dispatch a tool right now?
 *
 *  - 'unlimited' → always allowed
 *  - 'compromised' → never allowed (until reconnect)
 *  - 'legacy' → allowed if under cap (server-tracked counter)
 *  - 'capped' → allowed if under cap
 *  - 'pending' → caller waits for init_session resolution; not decided here
 */
export type CapDecision =
  | { allow: true }
  | {
      allow: false;
      code: typeof ERROR_CODE_CAP_EXCEEDED | typeof ERROR_CODE_INTEGRITY_VIOLATION;
      scope: 'daily' | 'weekly' | 'session';
      message: string;
      data: Record<string, unknown>;
    };

export function decideDispatch(session: CapSession, now: Date): CapDecision {
  if (session.mode === 'unlimited') {
    return { allow: true };
  }
  if (session.mode === 'compromised') {
    return {
      allow: false,
      code: ERROR_CODE_INTEGRITY_VIOLATION,
      scope: 'session',
      message: 'MCP integrity check failed for this session. Reconnect MCP from the Customaise extension Settings to recover.',
      data: { type: 'integrity_violation', scope: 'session' },
    };
  }
  if (session.mode === 'pending') {
    return { allow: true };
  }
  // capped or legacy — both honour the in-memory counter
  if (session.dailyUsed >= session.dailyCap) {
    return {
      allow: false,
      code: ERROR_CODE_CAP_EXCEEDED,
      scope: 'daily',
      message: capExceededMessage('daily', session.dailyUsed, session.dailyCap, nextUtcMidnight(now)),
      data: capExceededData('daily', session.dailyUsed, session.dailyCap, nextUtcMidnight(now)),
    };
  }
  if (session.weeklyUsed >= session.weeklyCap) {
    const resetsAt = nextUtcMidnight(now); // weekly window slides; next reset opportunity is at least one daily tick
    return {
      allow: false,
      code: ERROR_CODE_CAP_EXCEEDED,
      scope: 'weekly',
      message: capExceededMessage('weekly', session.weeklyUsed, session.weeklyCap, resetsAt),
      data: capExceededData('weekly', session.weeklyUsed, session.weeklyCap, resetsAt),
    };
  }
  return { allow: true };
}

/**
 * Apply the counter from a `dispatch_ack` frame. The extension is the
 * persistent truth (per ARD §4.2), so the server adopts whatever
 * counter the extension reports — UNLESS it went backwards, which is
 * the actual tampering signal.
 *
 * Returns either:
 *  - `{ kind: 'adopt' }`: counter advanced or stayed equal; quietly adopt
 *  - `{ kind: 'integrity_violation' }`: counter went down; mark compromised + emit report
 */
export type AckOutcome =
  | { kind: 'adopt'; session: CapSession }
  | { kind: 'integrity_violation'; session: CapSession; serverCountBefore: number; ackCounter: number };

export function applyAck(
  session: CapSession,
  ack: { counter?: number; success?: boolean },
  tool: string,
): AckOutcome {
  const ackCounter = Number(ack?.counter);
  // For failed dispatches the counter doesn't move on the extension side
  // either — adopt as-is, no integrity check.
  if (ack?.success === false) {
    return { kind: 'adopt', session };
  }
  if (!Number.isFinite(ackCounter) || ackCounter < 0) {
    // Malformed ack — don't change counter, don't fire integrity. Loud log
    // is the bridge's job; here we just preserve state.
    return { kind: 'adopt', session };
  }
  // Backwards drop from the previously adopted value = tampering signal.
  // Forward jumps (ack ahead by >1) are NORMAL on flaky networks where
  // the previous ack was lost; per §4.4 step 9 we adopt forward-ahead
  // values silently.
  if (ackCounter < session.dailyUsed) {
    return {
      kind: 'integrity_violation',
      session: markCompromised(session),
      serverCountBefore: session.dailyUsed,
      ackCounter,
    };
  }
  return {
    kind: 'adopt',
    session: { ...session, dailyUsed: Math.floor(ackCounter) },
  };
}

/**
 * Local increment for legacy sessions where the extension can't ack.
 * The server's in-memory counter is the only counter; on server restart
 * it resets (acknowledged in ARD §7 risks).
 */
export function incrementLocalLegacyCounter(session: CapSession): CapSession {
  return {
    ...session,
    dailyUsed: session.dailyUsed + 1,
    weeklyUsed: session.weeklyUsed + 1,
  };
}

/** Allocate the next outgoing seq_num and return updated session. */
export function takeNextSeqNum(session: CapSession): { session: CapSession; seqNum: number } {
  const seqNum = session.nextSeqNum;
  return { session: { ...session, nextSeqNum: seqNum + 1 }, seqNum };
}

// ─── Helpers ────────────────────────────────────────────────────

export function utcDateString(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function nextUtcMidnight(now: Date): Date {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0); // setUTCHours(24, ...) rolls to next day at 00:00:00.000 UTC
  return next;
}

function capExceededMessage(scope: 'daily' | 'weekly', used: number, limit: number, resetsAt: Date): string {
  const remainingMs = Math.max(0, resetsAt.getTime() - Date.now());
  const hours = Math.floor(remainingMs / 3_600_000);
  const minutes = Math.floor((remainingMs % 3_600_000) / 60_000);
  const window = scope === 'daily' ? 'Daily' : 'Weekly';
  return `${window} MCP cap reached: ${used}/${limit} calls. Resets in ${hours}h ${minutes}m. Upgrade to Power User for unlimited: https://customaise.com/pricing`;
}

function capExceededData(scope: 'daily' | 'weekly', used: number, limit: number, resetsAt: Date): Record<string, unknown> {
  return {
    type: 'rate_limit',
    scope,
    used,
    limit,
    resetsAt: resetsAt.toISOString(),
    resetsInSeconds: Math.max(0, Math.floor((resetsAt.getTime() - Date.now()) / 1000)),
    upgradeUrl: 'https://customaise.com/pricing',
  };
}

/**
 * Build the `report_integrity_error` frame the server sends to the
 * extension when a backwards-counter ack is detected. Pure data; the
 * bridge serialises and sends.
 */
export function buildIntegrityReport(
  session: CapSession,
  serverCountBefore: number,
  ackCounter: number,
  tool: string,
): {
  type: 'report_integrity_error';
  session_id: string;
  scope: 'backwards_counter';
  server_count_before: number;
  ack_counter: number;
  tool: string;
} {
  return {
    type: 'report_integrity_error',
    session_id: session.sessionId,
    scope: 'backwards_counter',
    server_count_before: serverCountBefore,
    ack_counter: ackCounter,
    tool,
  };
}
