/**
 * Every "we cannot reach the extension" throw site must carry a branchable
 * `data.type`.
 *
 * This exists because it did not. Both bridges threw bare `Error` for the
 * single most common failure there is — Chrome is not running — so
 * `toStructuredError` fell through to `internal_error` and the CLI exited 1
 * instead of the documented 3. `doctor` masked it by computing its own exit
 * code, so the contract looked honoured from the one verb anybody tries
 * first.
 *
 * The guard is structural rather than behavioural: constructing a real
 * disconnected bridge and awaiting a timeout would take seconds per case and
 * would not fail if a *new* throw site were added untyped. Reading the source
 * catches that.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { toStructuredError } from '../tool-envelope.js';
import { EXIT, exitCodeForErrorType } from '../cli/exit-codes.js';

/**
 * Resolve the TypeScript source, not the compiled copy next to this test.
 * Tests run from `test-out/__tests__/`, so walk up to the package root and
 * come back down into `src/` rather than hard-coding a `../..` that breaks
 * the moment the build layout moves.
 */
function findSrcDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'src');
    if (existsSync(join(candidate, 'extension-bridge.ts'))) return candidate;
    dir = dirname(dir);
  }
  throw new Error('Could not locate mcp/src from ' + import.meta.url);
}

const SRC = findSrcDir();

/** Messages that mean "the chain to Chrome is broken", wherever they appear. */
const UNREACHABLE_MESSAGES = [
  'Customaise extension is not connected',
  'Leader bridge is not connected',
  'Leader bridge disconnected before response arrived',
  'Request to extension timed out',
  // A close() used to happen only at process exit, where nobody reads the
  // error. Abdication closes a live leader, so these reach an agent now.
  'Bridge is shutting down',
  'MCP dispatch aborted',
  'MCP dispatch interrupted',
];

describe('bridge unreachable errors are typed', () => {
  for (const file of ['extension-bridge.ts', 'remote-bridge.ts', 'electing-bridge.ts']) {
    it(`${file} throws no bare Error for an unreachable extension`, () => {
      const src = readFileSync(join(SRC, file), 'utf8');
      const lines = src.split('\n');

      lines.forEach((line, i) => {
        if (!UNREACHABLE_MESSAGES.some((m) => line.includes(m))) return;
        // Look back a few lines for the constructor this message belongs to.
        const window = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
        assert.ok(
          !/new Error\(/.test(window),
          `${file}:${i + 1} raises an unreachable-extension error as a bare Error. ` +
            'Use ProtocolError with { type: ... } so the CLI can exit 3, not 1.\n' +
            `  ${line.trim()}`,
        );
      });
    });
  }

  it('the types those sites use all reach EXIT.UNAVAILABLE', () => {
    for (const type of ['extension_not_connected', 'leader_unreachable', 'dispatch_timeout']) {
      assert.equal(exitCodeForErrorType(type), EXIT.UNAVAILABLE, type);
    }
  });

  it('a typed ProtocolError survives toStructuredError as that type', () => {
    const err = Object.assign(new Error('Customaise extension is not connected.'), {
      code: -32030,
      data: { type: 'extension_not_connected' },
    });
    const structured = toStructuredError(err);
    assert.equal(structured.structuredContent.error.type, 'extension_not_connected');
    assert.equal(exitCodeForErrorType(structured.structuredContent.error.type), EXIT.UNAVAILABLE);
  });

  it('an untyped error still degrades to internal_error and exit 1', () => {
    // The fallback must stay put: this is what an unknown fault should do.
    const structured = toStructuredError(new Error('something else broke'));
    assert.equal(structured.structuredContent.error.type, 'internal_error');
    assert.equal(exitCodeForErrorType('internal_error'), EXIT.ERROR);
  });
});
