/**
 * Tool envelope — the single seam every tool handler passes through.
 *
 * Two cross-cutting concerns live here so that `server.ts` stays a
 * description of what each tool does:
 *
 *   1. Machine-readable errors.
 *   2. Client identity on 2026-07-28 connections.
 *   3. Abort propagation, so an abandoned call closes its consent modal.
 *
 * ── Where abort propagation reaches ──────────────────────────────────
 *
 * Both doors. Measured on each:
 *
 *   loopback HTTP (the CLI)  — the client's abort closes the request stream,
 *                              the daemon turns that into an
 *                              `AbortController` on the `Request`, and
 *                              `ctx.mcpReq.signal` fires.
 *   stdio (an IDE)           — the client sends `notifications/cancelled`,
 *                              which the stdio transport delivers on to the
 *                              Protocol layer, which aborts the controller it
 *                              holds for that request id. Same signal, same
 *                              handler, same consent-modal teardown.
 *
 * This comment previously asserted that stdio does NOT abort. That was
 * wrong, and wrong in the direction that stops someone relying on a
 * mechanism that works. The probe behind it passed the abort signal to
 * `callTool` incorrectly (v2 takes `callTool(params, options)`, two
 * arguments), so the client never emitted the notification and the server
 * was correctly reporting that nothing had asked it to stop. Re-probed with
 * the signal in the right place: `ABORT_FIRED=true`.
 *
 * ── Why errors need shaping ──────────────────────────────────────────
 *
 * An error thrown from a `tools/call` handler does NOT reach the client as
 * a protocol error. The SDK catches it and flattens it into
 * `{ isError: true, content: [{ type: 'text', text: message }] }` — the
 * code is discarded and so is the `data`. Measured on both protocol eras.
 *
 * That leaves a caller nothing to branch on except the message string.
 * Sixteen of the eighteen handlers let a `dispatchTool` rejection
 * propagate, so in practice "you are out of quota", "the extension is
 * closed" and "sign in first" all arrive as indistinguishable prose. An
 * IDE agent cannot tell them apart today; a CLI mapping failures to exit
 * codes could not be written at all.
 *
 * `structuredContent` survives intact in both eras, so that is where the
 * machine half goes. `content` still carries the sentence, because the two
 * fields serve two readers: a CLI parses the first, the model on the other
 * end of an IDE session reads the second.
 *
 * ── Why the codes are not the discriminator ──────────────────────────
 *
 * `error.type` is a stable string; the numeric code is carried alongside
 * for continuity with `cap-state.ts` but nothing should branch on it. The
 * 2026-07-28 revision reserved `-32020`..`-32099` for the specification,
 * and these five predate that, so the numbers may yet move. The strings
 * will not.
 */

import {
  ERROR_CODE_AUTH_REQUIRED,
  ERROR_CODE_CAP_EXCEEDED,
  ERROR_CODE_DISPATCH_TIMEOUT,
  ERROR_CODE_EXTENSION_OUTDATED,
  ERROR_CODE_INTEGRITY_VIOLATION,
} from './cap-state.js';
import { withRequestContext } from './request-context.js';

/** Stable discriminators. Callers branch on these, never on the number. */
export const ERROR_TYPES = {
  AUTH_REQUIRED: 'auth_required',
  CAP_EXCEEDED: 'cap_exceeded',
  EXTENSION_UNREACHABLE: 'extension_unreachable',
  EXTENSION_OUTDATED: 'extension_outdated',
  INTEGRITY_VIOLATION: 'integrity_violation',
  INTERNAL: 'internal_error',
} as const;

const CODE_TO_TYPE: Record<number, string> = {
  [ERROR_CODE_AUTH_REQUIRED]: ERROR_TYPES.AUTH_REQUIRED,
  [ERROR_CODE_CAP_EXCEEDED]: ERROR_TYPES.CAP_EXCEEDED,
  [ERROR_CODE_DISPATCH_TIMEOUT]: ERROR_TYPES.EXTENSION_UNREACHABLE,
  [ERROR_CODE_EXTENSION_OUTDATED]: ERROR_TYPES.EXTENSION_OUTDATED,
  [ERROR_CODE_INTEGRITY_VIOLATION]: ERROR_TYPES.INTEGRITY_VIOLATION,
};

export interface StructuredToolError {
  isError: true;
  structuredContent: { error: Record<string, unknown> & { type: string } };
  content: Array<{ type: 'text'; text: string }>;
}

/**
 * Turn anything a handler threw into a result a caller can branch on.
 *
 * The dispatch path already attaches a `data.type` on most failures
 * (`extension_not_connected`, `dispatch_timeout`, `rate_limit`, …). That
 * is more specific than the code, so it wins; the code map is the
 * fallback for errors raised without one.
 */
export function toStructuredError(err: unknown): StructuredToolError {
  const e = err as { code?: unknown; message?: unknown; data?: unknown } | null;
  const code = typeof e?.code === 'number' ? e.code : undefined;
  const data = (e?.data && typeof e.data === 'object') ? e.data as Record<string, unknown> : {};
  const message = typeof e?.message === 'string' && e.message ? e.message : 'Tool call failed.';

  const type =
    (typeof data.type === 'string' && data.type) ||
    (code !== undefined ? CODE_TO_TYPE[code] : undefined) ||
    ERROR_TYPES.INTERNAL;

  return {
    isError: true,
    structuredContent: { error: { ...data, type, ...(code !== undefined ? { code } : {}), message } },
    content: [{ type: 'text', text: message }],
  };
}

/**
 * Wrap `server.registerTool` so every handler registered afterwards gets
 * the envelope. Call BEFORE `registerTools`.
 *
 * `onClientInfo` receives the `io.modelcontextprotocol/clientInfo` envelope
 * entry the first time a request carries one. It is only populated on
 * 2026-07-28 connections; the 2025-era equivalent arrives through the
 * `initialize` handshake and is wired separately by the caller.
 */
export function installToolEnvelope(
  server: { registerTool: (...args: any[]) => unknown },
  opts: {
    onClientInfo?: (info: unknown) => void;
  } = {},
): void {
  const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';
  const registerTool = server.registerTool.bind(server);

  server.registerTool = (name: string, config: unknown, handler: Function) =>
    registerTool(name, config, async (args: unknown, ctx: any) => {
      if (opts.onClientInfo) {
        try { opts.onClientInfo(ctx?.mcpReq?.envelope?.[CLIENT_INFO_META_KEY]); } catch { /* never break a tool call for a label */ }
      }
      // Run inside the request context so the dispatch layer can see this
      // call's abort signal without every handler having to pass it down.
      try {
        return await withRequestContext({ signal: ctx?.mcpReq?.signal }, () => handler(args, ctx));
      } catch (err) {
        return toStructuredError(err);
      }
    });
}
