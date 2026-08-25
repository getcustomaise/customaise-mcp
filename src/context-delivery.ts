/**
 * How a big payload reaches the caller: a workspace file, or the response.
 *
 * ── The bug this exists for ──────────────────────────────────────────
 *
 * `get_page_context` and `get_console_context` spool their full payload to
 * `.customaise/*.json` and return a summary plus the path. That is the right
 * shape for an IDE agent, which has file tools and a context window worth
 * protecting: a full DOM snapshot is routinely hundreds of KB.
 *
 * It is a dead end for a chat client. Claude Desktop runs this server over
 * stdio, so the WRITE succeeds; the model on the other end simply has no
 * filesystem tool with which to read what was written. The agent receives a
 * path it can never open, and there is no second move. That is not a
 * degraded experience, it is a tool that cannot complete its own job.
 *
 * ── Why there is no client sniffing here ─────────────────────────────
 *
 * The obvious fix is to detect the client and choose for it. There is no
 * signal that survives contact:
 *
 *   `clientInfo.name`   — a string allowlist of IDE names, i.e. a guess that
 *                         is wrong for every client not on the list, in
 *                         whichever direction the list was wrong about.
 *   `roots` capability  — protocol-native, and the closest thing to an
 *                         honest signal, but it says the client declares
 *                         project directories, NOT that the model holds a
 *                         tool for reading them. It also arrives through
 *                         `getClientCapabilities()`, which is populated by
 *                         the 2025-11-25 handshake and undefined on a
 *                         2026-07-28 connection — the same era split that
 *                         forced two branches for `clientInfo` in
 *                         build-server.ts.
 *
 * So nothing here infers. Three inputs, in order, and the last is a
 * constant:
 *
 *   1. the `output` argument on the call
 *   2. `CUSTOMAISE_MCP_OUTPUT` in the server's environment
 *   3. `file`
 *
 * (2) is what the `.mcpb` bundle sets. That bundle exists to be installed
 * into Claude Desktop and nothing else, so it is the one place in the
 * system that knows its own client for certain, and it declares it in
 * `manifest.json` rather than making the server guess at runtime.
 *
 * ── Why file mode still advertises the escape hatch ──────────────────
 *
 * Because (3) is a constant, an unconfigured chat client lands on `file`
 * and hits the original dead end. So every file-mode response carries the
 * retry instruction literally: call again with `output: "inline"`. A wrong
 * default then costs one extra tool call instead of ending the run, and it
 * self-corrects without the user knowing any of this exists.
 */

/** What the caller asked for. `auto` defers to the environment. */
export type DeliveryRequest = 'auto' | 'file' | 'inline';

/** What was actually decided. There is no `auto` at this end. */
export type DeliveryMode = 'file' | 'inline';

export interface DeliveryDecision {
  mode: DeliveryMode;
  /** Which of the three inputs decided it. Reported so a confused caller can see why. */
  source: 'argument' | 'environment' | 'default';
}

/**
 * Shared `describe()` text, parameterised on where file mode actually
 * writes. The context tools spool into `.customaise/`; the screenshot saves
 * to the caller's `filePath` or the system temp directory. One hardcoded
 * sentence claimed `.customaise/` for all three, which was a
 * description/behaviour mismatch of exactly the kind this module exists to
 * end.
 */
export const outputParamDescription = (fileDestination: string): string =>
  `Where the full payload goes. "file" (default) writes it to ${fileDestination} ` +
  'and returns a summary plus the path, which keeps a large payload out of ' +
  'your context window. "inline" writes nothing and returns the whole payload ' +
  'in this response. Use it when you have no filesystem tool to read the file ' +
  'with, such as a chat client. "auto" follows the CUSTOMAISE_MCP_OUTPUT ' +
  'environment variable, falling back to "file".';

const VALID: readonly DeliveryMode[] = ['file', 'inline'];

function readEnvMode(env: NodeJS.ProcessEnv): DeliveryMode | undefined {
  const raw = env.CUSTOMAISE_MCP_OUTPUT;
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  return (VALID as readonly string[]).includes(v) ? (v as DeliveryMode) : undefined;
}

/**
 * Decide where this call's payload goes.
 *
 * An unrecognised env value is ignored rather than thrown on: the variable
 * is set once in a config file the user rarely reopens, and failing every
 * page read because it says "File " with a trailing space would be a worse
 * outcome than quietly using the default.
 */
export function resolveDelivery(
  requested?: DeliveryRequest,
  env: NodeJS.ProcessEnv = process.env,
): DeliveryDecision {
  if (requested === 'file' || requested === 'inline') {
    return { mode: requested, source: 'argument' };
  }
  const fromEnv = readEnvMode(env);
  if (fromEnv) return { mode: fromEnv, source: 'environment' };
  return { mode: 'file', source: 'default' };
}

/** Default ceiling on an inline payload, in bytes of serialized JSON. */
export const DEFAULT_INLINE_MAX_KB = 64;

/**
 * The inline ceiling for this process.
 *
 * A ceiling exists because `inline` is chosen by a caller who cannot read
 * files, which is the same caller least able to survive a 2 MB DOM dump
 * landing in its context. Uncapped inline would trade a dead end for a
 * blown context window.
 */
export function inlineBudgetBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CUSTOMAISE_MCP_INLINE_MAX_KB);
  const kb = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INLINE_MAX_KB;
  return Math.floor(kb * 1024);
}

/** Default ceiling on an inline IMAGE, in KB of base64. */
export const DEFAULT_INLINE_IMAGE_MAX_KB = 1536;

/**
 * The inline-image ceiling for this process.
 *
 * Separate from the JSON budget and much larger, because the two are
 * different trades. A shortened DOM snapshot is still useful; half an image
 * is not an image, so this budget cannot degrade gracefully and instead
 * decides whether the capture is sent at all. 1.5 MB of base64 is roughly a
 * 1.1 MB PNG, which covers any viewport capture and stops a tall full-page
 * one from arriving as several megabytes of text.
 */
export function inlineImageBudgetBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CUSTOMAISE_MCP_INLINE_IMAGE_MAX_KB);
  const kb = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INLINE_IMAGE_MAX_KB;
  return Math.floor(kb * 1024);
}

/**
 * Split a data URL into its mime type and payload.
 *
 * The handler used to strip a hardcoded `data:image/png;base64,` prefix,
 * which silently produced a corrupt attachment on any other mime type. The
 * image content block has to carry the real one.
 */
export function parseDataUrl(dataUrl: string): { mimeType: string; base64: string } {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl ?? '');
  if (!m) return { mimeType: 'image/png', base64: (dataUrl ?? '').replace(/^data:[^,]*,/, '') };
  return { mimeType: m[1], base64: m[2] };
}

export interface Omission {
  /** Dotted/bracketed path to the array that was shortened. */
  path: string;
  kept: number;
  omitted: number;
}

export interface PruneResult<T> {
  value: T;
  omissions: Omission[];
  withinBudget: boolean;
  bytes: number;
}

const sizeOf = (v: unknown): number => {
  try {
    return Buffer.byteLength(JSON.stringify(v) ?? 'null', 'utf-8');
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
};

interface ArrayNode {
  path: string;
  parent: Record<string, unknown> | unknown[];
  key: string | number;
  original: number;
}

function collectArrays(root: unknown): ArrayNode[] {
  const found: ArrayNode[] = [];
  const seen = new Set<unknown>();

  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    const entries: Array<[string | number, unknown]> = Array.isArray(node)
      ? node.map((v, i) => [i, v] as [number, unknown])
      : Object.entries(node as Record<string, unknown>);

    for (const [key, child] of entries) {
      const childPath = typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key;
      if (Array.isArray(child)) {
        found.push({ path: childPath, parent: node as Record<string, unknown>, key, original: child.length });
      }
      walk(child, childPath);
    }
  };

  walk(root, '');
  return found;
}

/**
 * Shrink `value` until its serialized form fits `budgetBytes`.
 *
 * Shortens arrays rather than truncating the JSON string, because a caller
 * that receives half a JSON document receives nothing it can parse. Halving
 * the largest array repeatedly converges in a handful of passes and leaves
 * the SHAPE intact, so an agent still sees every key, every nesting level,
 * and a representative sample of every collection — enough to know what it
 * is looking at and to decide whether it needs the file after all.
 *
 * Nothing is mutated: the input is deep-copied first.
 */
export function pruneToBudget<T>(value: T, budgetBytes: number): PruneResult<T> {
  const initial = sizeOf(value);
  if (initial <= budgetBytes) {
    return { value, omissions: [], withinBudget: true, bytes: initial };
  }

  let clone: T;
  try {
    clone = JSON.parse(JSON.stringify(value)) as T;
  } catch {
    // Not serializable, so nothing downstream could have sent it anyway.
    return { value, omissions: [], withinBudget: false, bytes: initial };
  }

  // Original lengths by path, recorded the first time a path is trimmed so
  // the omission can state what the full collection held.
  const originals = new Map<string, number>();
  const trimmedPaths = new Set<string>();
  let bytes = sizeOf(clone);

  // ── Cost model ───────────────────────────────────────────────────────
  //
  // The obvious loop — halve the biggest array, re-serialize the clone,
  // check the budget — is O(payload) PER PASS, and the pass count is what
  // an adversary controls. One dominant array converges in a dozen passes;
  // five hundred SIBLING arrays (a snapshot keyed by section, logs grouped
  // per source) force one pass each per halving round. Measured before
  // this rewrite: 500 siblings at 1 MB took 1.3s, and 2000 at 4 MB took
  // 27s of synchronous CPU — which, on the daemon door, stalls every
  // connected client. get_page_context's payload shape follows the page
  // being visited, so that pass count was attacker-influenced.
  //
  // So the inner loop books changes against a byte ESTIMATE: halving an
  // array subtracts the measured size of the slice it dropped (which
  // includes everything nested inside, so detached descendants are
  // accounted for exactly once). Only when the estimate says "done" does
  // an outer round pay for one real serialization. The estimate is off by
  // only bracket-vs-separator bytes per trim, and BOTH error directions
  // are safe: understated savings trim a few elements more than strictly
  // needed, overstated savings end the round early and the real check
  // sends it around again.
  // Node sizes are cached and only the trimmed node's cache changes, and
  // nodes detached by an ancestor trim are marked dead by path prefix so
  // the loop never selects an array the serialization can no longer see.
  interface LiveNode extends ArrayNode {
    cachedSize: number;
    dead: boolean;
  }
  let nodes: LiveNode[] = collectArrays(clone).map((n) => ({
    ...n,
    cachedSize: sizeOf((n.parent as Record<string | number, unknown>)[n.key]),
    dead: false,
  }));

  while (bytes > budgetBytes) {
    let estimate = bytes;
    let trimmedThisRound = false;

    while (estimate > budgetBytes) {
      let biggest: LiveNode | undefined;
      for (const n of nodes) {
        if (n.dead) continue;
        const arr = (n.parent as Record<string | number, unknown>)[n.key] as unknown[];
        if (!Array.isArray(arr) || arr.length === 0) continue;
        if (!biggest || n.cachedSize > biggest.cachedSize) biggest = n;
      }
      if (!biggest) break;

      const arr = (biggest.parent as Record<string | number, unknown>)[biggest.key] as unknown[];
      const keep = Math.floor(arr.length / 2);
      const removedBytes = sizeOf(arr.slice(keep));
      if (!originals.has(biggest.path)) originals.set(biggest.path, arr.length);
      (biggest.parent as Record<string | number, unknown>)[biggest.key] = arr.slice(0, keep);
      trimmedPaths.add(biggest.path);
      trimmedThisRound = true;

      estimate = Math.max(0, estimate - removedBytes);
      biggest.cachedSize = Math.max(2, biggest.cachedSize - removedBytes);

      // Mark descendants of the dropped elements dead: their bytes were
      // inside removedBytes, and selecting one later would trim something
      // the serialization no longer contains.
      const prefix = biggest.path + '[';
      for (const n of nodes) {
        if (n.dead || n === biggest || !n.path.startsWith(prefix)) continue;
        const idx = Number.parseInt(n.path.slice(prefix.length), 10);
        if (Number.isFinite(idx) && idx >= keep) n.dead = true;
      }
    }

    // One real serialization per round, not per trim. If nothing could be
    // trimmed this round there is nothing left to shrink either.
    bytes = sizeOf(clone);
    if (!trimmedThisRound) break;
  }

  // Report only what the final tree still holds. A path trimmed early and
  // then detached by an ancestor trim is not an omission the caller can act
  // on; its loss is already accounted for by the ancestor's own entry.
  const finalArrays = new Map(collectArrays(clone).map((n) => [n.path, n] as const));
  const omissions: Omission[] = [];
  for (const path of trimmedPaths) {
    const node = finalArrays.get(path);
    if (!node) continue;
    const arr = (node.parent as Record<string | number, unknown>)[node.key] as unknown[];
    const kept = Array.isArray(arr) ? arr.length : 0;
    omissions.push({ path, kept, omitted: (originals.get(path) ?? kept) - kept });
  }
  omissions.sort((a, b) => b.omitted - a.omitted);

  return { value: clone, omissions, withinBudget: bytes <= budgetBytes, bytes };
}

/** `KB` string for a byte count, matching the existing `fileSizeKB` fields. */
export const asKB = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;

/**
 * The retry instruction on every file-mode response.
 *
 * Addressed to the model, in the second person, and naming the exact
 * argument to send. An agent that cannot read the file has to be able to
 * act on this sentence alone.
 */
export function fileModeHint(toolName: string, payloadNoun: string, readHint: string): string {
  return (
    `${payloadNoun} saved to the file above. ${readHint} ` +
    `If you have NO way to read local files (a chat client with no filesystem tool, for example), ` +
    `call ${toolName} again with output: "inline" and the full payload comes back in the response instead.`
  );
}

/** The counterpart note on an inline response, so a truncated read is never silent. */
export function inlineHint(toolName: string, omissions: Omission[], withinBudget = true): string {
  if (omissions.length === 0) {
    // Over budget with nothing trimmed means the payload had no lists to
    // shorten (one giant string, say). It is COMPLETE, so `truncated` must
    // stay false — for one revision this case was flagged truncated and an
    // agent holding the whole payload was told parts of it were missing.
    return withinBudget
      ? `Full payload returned inline; nothing was written to disk. For a large page, output: "file" keeps this out of your context window when you can read files.`
      : `Full payload returned inline; it exceeds the inline budget but has no lists to shorten, so nothing was dropped. Prefer output: "file" for payloads this size when you can read files.`;
  }
  const worst = omissions.slice(0, 3).map((o) => `${o.path} (${o.kept} of ${o.kept + o.omitted})`).join(', ');
  return (
    `Returned inline and SHORTENED to fit the inline budget: ${worst}. ` +
    `Every key and nesting level is intact; only list items were dropped. ` +
    `Raise CUSTOMAISE_MCP_INLINE_MAX_KB, narrow the request, or call ${toolName} with output: "file" ` +
    `and read the complete payload from disk if you have filesystem access.`
  );
}
