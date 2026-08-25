/**
 * Payload-level rejection: Customaise was reached and Customaise said no.
 *
 * This is separate from the tool-envelope error path. A script the
 * sanitization pipeline refuses comes back as a SUCCESSFUL dispatch carrying
 * `{ success: false, diagnostics }`, because at the protocol layer nothing
 * went wrong and there is no `isError` to read. The CLI exited 0 on it, which
 * meant `customaise scripts install broken.js && customaise call its_tool`
 * would run the second half against a script that was never installed.
 *
 * Lives in its own module rather than in `index.ts` because `index.ts` calls
 * `main()` at load, so importing it from a test would try to reach a daemon
 * and exit the process.
 */

/**
 * An explicit `success: false` on a payload we built ourselves.
 *
 * Deliberately strict: only a literal `false` counts, so a payload with no
 * `success` field at all (every read tool) is untouched.
 */
export function isRejection(data: unknown): data is Record<string, unknown> {
  return !!data
    && typeof data === 'object'
    && !Array.isArray(data)
    && (data as Record<string, unknown>).success === false;
}

/** One diagnostic rendered as a sentence, with its hint when it carries one. */
function describe(d: unknown): string | undefined {
  if (typeof d === 'string') return d || undefined;
  if (!d || typeof d !== 'object') return undefined;
  const { message, hint } = d as { message?: unknown; hint?: unknown };
  if (typeof message !== 'string' || !message) return undefined;
  // The hint is the actionable half ("check for syntax errors ..."), so an
  // agent rewriting the script wants it in the one line it is guaranteed to
  // read. The full object is still on stdout for anything that wants more.
  return typeof hint === 'string' && hint ? message + ' ' + hint : message;
}

/**
 * The best human sentence available in a rejection payload.
 *
 * `diagnostics` arrives as a single object from the sanitization pipeline
 * (`{ code, message, retryable, hint }`) but as an array from paths that
 * collect several. Both shapes are real, so both are handled; assuming the
 * array shape is what made the first live rejection print the generic
 * fallback instead of "failed canonical parse".
 */
export function rejectionMessage(data: Record<string, unknown>): string {
  const diagnostics = data.diagnostics;

  if (Array.isArray(diagnostics)) {
    const lines = diagnostics.map(describe).filter((m): m is string => !!m);
    if (lines.length === 1) return lines[0];
    if (lines.length > 1) return lines.length + ' problems: ' + lines.join('; ');
  } else {
    const one = describe(diagnostics);
    if (one) return one;
  }

  for (const key of ['error', 'message', 'reason']) {
    const v = data[key];
    if (typeof v === 'string' && v) return v;
  }
  return 'Customaise rejected the request.';
}
