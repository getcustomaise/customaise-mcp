/**
 * No tool handler may reach the extension via `bridge.request()`.
 *
 * `request()` is the bare v1 envelope. It does not run cap enforcement, it
 * does not carry the bilateral counter handshake, and the extension's
 * `dispatch_tool` gate (sign-in check, cap pre-check, integrity lock) never
 * sees it. `dispatchTool()` is the only path that passes all three.
 *
 * Every consumer converges here: an IDE on stdio, the CLI through the
 * daemon's loopback door, and the file watcher's auto-export all end up in
 * the same handlers in `server.ts`. So one `request()` call in one handler
 * is a quota bypass, a tamper-detection hole and a signed-out escape hatch
 * simultaneously, for every door at once.
 *
 * That rule was documented in a comment in `bridge.ts`. A comment is not a
 * gate. This is the gate.
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

/**
 * Files whose handlers serve MCP callers. `extension-bridge.ts` and
 * `remote-bridge.ts` are excluded on purpose: they *implement* both methods,
 * and the legacy fallback inside `dispatchTool` is allowed to call
 * `request()` when it detects a pre-2.0 extension.
 */
const CALLER_FILES = ['server.ts', 'build-server.ts', 'file-watcher.ts', 'daemon.ts'];

/** `bridge.request(`, `this.bridge.request(`, `deps.bridge.request(` ... */
const BYPASS = /\bbridge\s*\.\s*request\s*\(/;

/** Strip line comments and jsdoc continuation lines before matching. */
function stripComments(line: string): string {
  return line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
}

describe('cap enforcement has no bypass', () => {
  for (const file of CALLER_FILES) {
    it(`${file} dispatches tools only through dispatchTool()`, () => {
      const src = readFileSync(join(SRC, file), 'utf8');

      src.split('\n').forEach((line, i) => {
        assert.ok(
          !BYPASS.test(stripComments(line)),
          `${file}:${i + 1} calls bridge.request() from a tool-serving path. ` +
            'That skips cap enforcement, the counter handshake and the ' +
            "extension's sign-in gate. Use dispatchTool().\\n  " + line.trim(),
        );
      });
    });
  }

  it('server.ts actually dispatches, so the check above is not vacuous', () => {
    const src = readFileSync(join(SRC, 'server.ts'), 'utf8');
    const dispatches = (src.match(/bridge\.dispatchTool\(/g) ?? []).length;
    assert.ok(dispatches > 15, `expected server.ts to dispatch many tools, saw ${dispatches}`);
  });
});
