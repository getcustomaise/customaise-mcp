/**
 * `customaise scripts install broken.agent.js` used to exit 0.
 *
 * The sanitization pipeline refusing a script is not a protocol error, so the
 * dispatch succeeds and the verdict rides in the payload as
 * `{ success: false, diagnostics }`. The CLI branched only on `isError`, so
 * the likeliest failure in normal agent use reported success, and an agent
 * chaining `install && call` would drive a script that was never installed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isRejection, rejectionMessage } from '../cli/rejection.js';
import { EXIT } from '../cli/exit-codes.js';

describe('isRejection', () => {
  it('trips on an explicit success:false', () => {
    assert.equal(isRejection({ success: false, diagnostics: [] }), true);
  });

  it('leaves every other payload alone', () => {
    // Read tools carry no `success` field; treating absence as failure would
    // fail every list command.
    assert.equal(isRejection({ tabs: [] }), false);
    assert.equal(isRejection({ success: true, scriptId: 'x' }), false);
    assert.equal(isRejection([{ success: false }]), false, 'an array is data, not a verdict');
    assert.equal(isRejection(null), false);
    assert.equal(isRejection('string result'), false);
    assert.equal(isRejection({ success: 'false' }), false, 'only a literal false counts');
    assert.equal(isRejection({ success: 0 }), false);
  });
});

describe('rejectionMessage', () => {
  it('lifts a single diagnostic verbatim', () => {
    const msg = rejectionMessage({ success: false, diagnostics: [{ message: 'Unexpected token }' }] });
    assert.equal(msg, 'Unexpected token }');
  });

  it('counts and joins several', () => {
    const msg = rejectionMessage({
      success: false,
      diagnostics: [{ message: 'no @name' }, { message: 'no @match' }],
    });
    assert.equal(msg, '2 problems: no @name; no @match');
  });

  it('handles the single-object shape the pipeline actually sends', () => {
    // Verbatim from a live rejection. The first version of this helper only
    // handled arrays and printed the generic fallback for this, the shape
    // every real syntax error arrives in.
    const msg = rejectionMessage({
      success: false,
      diagnostics: {
        code: 'SYNTAX_ERROR',
        message: 'Executable code failed canonical parse before persistence.',
        retryable: true,
        hint: 'Check the script for syntax errors. The sanitization pipeline uses Acorn for AST parsing.',
      },
    });
    assert.equal(
      msg,
      'Executable code failed canonical parse before persistence. ' +
        'Check the script for syntax errors. The sanitization pipeline uses Acorn for AST parsing.',
    );
  });

  it('appends the hint only when there is one', () => {
    assert.equal(rejectionMessage({ success: false, diagnostics: { message: 'nope' } }), 'nope');
  });

  it('accepts bare strings as diagnostics', () => {
    assert.equal(rejectionMessage({ success: false, diagnostics: ['bad'] }), 'bad');
  });

  it('falls back through error, message, reason', () => {
    assert.equal(rejectionMessage({ success: false, error: 'nope' }), 'nope');
    assert.equal(rejectionMessage({ success: false, message: 'nope' }), 'nope');
    assert.equal(rejectionMessage({ success: false, reason: 'nope' }), 'nope');
  });

  it('never returns an empty string', () => {
    assert.equal(rejectionMessage({ success: false }), 'Customaise rejected the request.');
    assert.equal(rejectionMessage({ success: false, diagnostics: [{}] }), 'Customaise rejected the request.');
  });
});

describe('the call verb opts out of the rejection check', () => {
  it('passes passthrough=true, because that payload belongs to the page', () => {
    // `call_webmcp_tool` hands back whatever the page's own tool returned.
    // A page tool answering `{ success: false }` is reporting its own domain
    // result. Reinterpreting that as a CLI failure would exit 8 on a
    // perfectly healthy call.
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6 && !existsSync(join(dir, 'src', 'cli', 'index.ts')); i++) dir = dirname(dir);
    const src = readFileSync(join(dir, 'src', 'cli', 'index.ts'), 'utf8');

    // Keyed on the tool name, not the wrapper: the call site moved from the
    // bare `callTool` to `callToolWithConsentBudget` when finding 46 landed,
    // and a matcher pinned to the helper's name breaks on the next rename
    // while the property it guards is untouched.
    const line = src.split('\n').find((l) => l.includes("('call_webmcp_tool'") && l.includes('present('));
    assert.ok(line, 'could not find the call_webmcp_tool call site');
    assert.match(
      line!,
      /\)\s*,\s*true\s*\)/,
      'call_webmcp_tool must be presented with passthrough=true',
    );
  });

  it('reserves 8 for a rejection, distinct from a generic fault', () => {
    assert.equal(EXIT.REJECTED, 8);
    assert.notEqual(EXIT.REJECTED, EXIT.ERROR);
  });
});
