/**
 * Tool annotations must describe what the handler actually does.
 *
 * Nine of nineteen tools shipped with only `readOnlyHint` and
 * `openWorldHint` set, and four of those declared `readOnlyHint: true` while
 * their handlers called `mkdirSync` and `writeFileSync` into the user's
 * workspace. `sync_scripts` was the worst of them: annotated read-only,
 * writes a whole directory of files and overwrites any local edit it lands
 * on.
 *
 * The annotations are the only thing a client has to decide whether a tool
 * needs confirming before it runs, so "read-only" on a tool that overwrites
 * files is not a documentation slip, it is a missing consent prompt. An
 * external scanner found this before we did.
 *
 * Static, for the same reason as cli-schema-conformance: no daemon, no
 * Chrome, no sign-in, so it runs everywhere.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function findSrcDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'src');
    if (existsSync(join(candidate, 'server.ts'))) return candidate;
    dir = dirname(dir);
  }
  throw new Error('Could not locate mcp/src from ' + import.meta.url);
}

const SRC = findSrcDir();
const REQUIRED_HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

/** Calls that touch the filesystem. A `readOnlyHint: true` handler may contain none of them. */
const WRITE_CALLS = /\b(mkdirSync|writeFileSync|appendFileSync|rmSync|unlinkSync|renameSync|copyFileSync|createWriteStream)\s*\(/;

interface Tool {
  name: string;
  hints: Record<string, boolean>;
  /** Source from the annotations block to the next registration: the handler. */
  body: string;
  /** The whole registration, schema included. */
  chunk: string;
  description: string;
}

function parseTools(): Tool[] {
  const src = readFileSync(join(SRC, 'server.ts'), 'utf8');
  const starts: Array<{ name: string; index: number }> = [];
  for (const m of src.matchAll(/server\.registerTool\('([a-z_0-9]+)'/g)) {
    starts.push({ name: m[1], index: m.index! });
  }

  return starts.map((s, i) => {
    // Where this registration stops. The next one, or — for the last tool —
    // the section divider that follows it.
    //
    // Running the last tool's body to the end of `registerTools` swallowed
    // the DOM-selection push handler, and this test then reported
    // `get_selected_elements` as a workspace spooler on the strength of code
    // it does not contain. Dividers only ever sit BETWEEN registrations, so
    // stopping at one can never cut a tool body short.
    const after = (needle: string): number => {
      const at = src.indexOf(needle, s.index + 1);
      return at === -1 ? Number.MAX_SAFE_INTEGER : at;
    };
    const end = Math.min(
      i + 1 < starts.length ? starts[i + 1].index : Number.MAX_SAFE_INTEGER,
      after('\n  // ───'),
      after('\n}'),
      src.length,
    );
    const chunk = src.slice(s.index, end);
    const ann = /annotations:\s*\{[^}]*\}/.exec(chunk);
    const hints: Record<string, boolean> = {};
    if (ann) {
      for (const [, k, v] of ann[0].matchAll(/(\w+Hint):\s*(true|false)/g)) hints[k] = v === 'true';
    }
    const desc = /description:\s*(['"`])([\s\S]*?)\1\s*,\s*inputSchema/.exec(chunk);
    return {
      name: s.name,
      hints,
      body: ann ? chunk.slice(ann.index! + ann[0].length) : chunk,
      chunk,
      description: desc ? desc[2] : '',
    };
  });
}

const TOOLS = parseTools();

describe('tool annotations', () => {
  it('finds every registered tool', () => {
    // A parser that silently matched nothing would make every assertion
    // below vacuously pass, which is the failure mode of a static test.
    assert.ok(TOOLS.length >= 19, `parsed only ${TOOLS.length} tools`);
    assert.ok(TOOLS.some((t) => t.name === 'get_page_context'));
  });

  it('declares all four hints as explicit booleans on every tool', () => {
    // Not stylistic. OpenAI's MCP directory rejects a tool where any of the
    // four is missing or non-boolean, so a partial set is a submission
    // failure as well as an under-described tool.
    const bad = TOOLS.filter((t) => REQUIRED_HINTS.some((h) => typeof t.hints[h] !== 'boolean'));
    assert.deepEqual(
      bad.map((t) => `${t.name} missing ${REQUIRED_HINTS.filter((h) => typeof t.hints[h] !== 'boolean').join('/')}`),
      [],
    );
  });

  it('never claims readOnlyHint on a handler that writes to disk', () => {
    const liars = TOOLS
      .filter((t) => t.hints.readOnlyHint === true && WRITE_CALLS.test(t.body))
      .map((t) => `${t.name} (${WRITE_CALLS.exec(t.body)![1]})`);
    assert.deepEqual(liars, [], 'annotated read-only but writes files');
  });

  it('never claims readOnlyHint alongside destructiveHint', () => {
    const contradictory = TOOLS.filter((t) => t.hints.readOnlyHint === true && t.hints.destructiveHint === true);
    assert.deepEqual(contradictory.map((t) => t.name), []);
  });

  it('says so in the description when the handler writes files', () => {
    // The other half of the same finding: a tool named `get_*` that quietly
    // writes is a surprise regardless of what its annotations say, because
    // the model reads the sentence long before any client reads the hints.
    const undisclosed = TOOLS
      .filter((t) => WRITE_CALLS.test(t.body))
      .filter((t) => !/WRITES|writes|saved to|save|export/i.test(t.description))
      .map((t) => t.name);
    assert.deepEqual(undisclosed, [], 'writes files without saying so in its description');
  });

  it('offers the inline escape hatch on every tool that spools to the workspace', () => {
    // The chat-mode dead end: a client with no filesystem tool is handed a
    // path it can never open. Any tool that writes into `.customaise/` must
    // carry the `output` parameter that lets that caller recover.
    const spoolers = TOOLS.filter((t) => /getWorkspaceDir\(\)/.test(t.body));
    assert.ok(spoolers.length >= 2, `expected the context spoolers, found ${spoolers.length}`);
    for (const t of spoolers) {
      assert.match(t.description, /output: "inline"/, `${t.name} does not document the inline escape hatch`);
      assert.match(t.body, /resolveDelivery\(/, `${t.name} does not honour the output parameter`);
    }
  });

  it('documents the output parameter wherever the handler honours it', () => {
    // The reverse direction, which catches the tool that grew the flag but
    // never mentioned it. `take_screenshot` writes to the temp directory
    // rather than the workspace, so the check above does not reach it, and a
    // silent flag is a flag no agent will ever pass.
    const honours = TOOLS.filter((t) => /resolveDelivery\(/.test(t.body));
    assert.ok(honours.length >= 3, `expected page, console and screenshot, found ${honours.length}`);
    for (const t of honours) {
      assert.match(t.description, /output: "inline"/, `${t.name} honours output but never documents it`);
      // Against the whole registration, not the handler: the enum lives in
      // `inputSchema`, which sits before the annotations block the body
      // starts after.
      assert.match(t.chunk, /output: z\.enum\(\['auto', 'file', 'inline'\]\)/, `${t.name} does not declare the output enum`);
    }
  });
});
