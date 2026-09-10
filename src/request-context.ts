/**
 * Per-request context, carried without threading a parameter through
 * eighteen tool handlers.
 *
 * Carries the caller's workspace, abort signal and approval-progress callback.
 * The dispatch layer uses the signal so an abandoned call can close the
 * consent modal it was waiting on, several frames deeper in the bridge.
 *
 * `AsyncLocalStorage` rather than a field on the bridge, because the bridge
 * is shared: `createMcpHandler` builds a fresh server per request against one
 * long-lived bridge, so a mutable "current signal" would be read by whichever
 * request happened to look last. Async context is per-call by construction.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface PendingDispatchInfo {
  /** How long the bridge will now wait before giving up, from this moment. */
  expectedTimeoutMs: number;
  reason: string;
}

export interface RequestContext {
  signal?: AbortSignal;
  /**
   * Called each time the extension reports that a dispatch is waiting on the
   * user (a consent modal, a remote approval). The tool envelope turns it
   * into `notifications/progress` when the client asked for progress, which
   * is the only thing that keeps a 60-second client timeout from killing a
   * five-minute approval. Absent when the client sent no `progressToken`.
   */
  onPending?: (info: PendingDispatchInfo) => void;
  /**
   * Where this caller is standing.
   *
   * A stdio server is spawned by its IDE and inherits that project's
   * directory, so `process.cwd()` has always been right for it. A daemon is
   * spawned once from wherever the first CLI invocation happened to be and
   * then outlives it, so its cwd is meaningless and often invisible to the
   * user. HTTP callers must declare it per request; stdio retains the
   * environment/cwd fallback.
   */
  workspaceDir?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` with `ctx` MERGED over whatever is already in scope.
 *
 * Merging rather than replacing, because more than one layer contributes.
 * The daemon attaches the caller's workspace when the request arrives; the
 * tool envelope attaches the abort signal when the handler runs. An earlier
 * version replaced the store, so the envelope's `{ signal }` silently erased
 * the workspace and every context file landed in the daemon's own directory
 * instead of the caller's. Both layers now add without stepping on the other.
 *
 * `undefined` values do not overwrite a value already in scope.
 */
export function withRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  const current = storage.getStore() ?? {};
  const merged: RequestContext = { ...current };
  for (const [k, v] of Object.entries(ctx)) {
    if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
  }
  return storage.run(merged, fn);
}

/** The current request's context, or an empty one outside a request. */
export function currentRequestContext(): RequestContext {
  return storage.getStore() ?? {};
}
