/**
 * `structuredContent` shaping.
 *
 * The field was object-typed before 2026-07-28 and is any JSON value after
 * it, and the SDK papers over that by wrapping a non-object as `{ result }`
 * on a legacy connection and passing it through bare on a modern one.
 * Measured on the wire: the same array arrives as `{"result":[...]}` or
 * `[...]` purely depending on what the client negotiated.
 *
 * A caller should not have to reason about protocol negotiation to know the
 * shape of its own data, so we wrap non-objects ourselves and the wire shape
 * is identical on both eras.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asStructuredContent } from '../server.js';

describe('asStructuredContent', () => {
  it('passes a plain object through untouched', () => {
    const o = { tabs: [1, 2], ok: true };
    assert.equal(asStructuredContent(o), o);
  });

  it('wraps an array, which is the case the eras disagreed about', () => {
    assert.deepEqual(asStructuredContent([{ id: 7 }]), { result: [{ id: 7 }] });
  });

  it('wraps primitives and null rather than emitting a non-object', () => {
    assert.deepEqual(asStructuredContent('hi'), { result: 'hi' });
    assert.deepEqual(asStructuredContent(42), { result: 42 });
    assert.deepEqual(asStructuredContent(null), { result: null });
    assert.deepEqual(asStructuredContent(undefined), { result: undefined });
  });

  it('always returns something a legacy client will accept', () => {
    for (const v of [[], {}, 0, '', false, null, [1], { a: 1 }]) {
      const out = asStructuredContent(v);
      assert.equal(typeof out, 'object');
      assert.ok(out !== null && !Array.isArray(out));
    }
  });

  it('wraps a result that is itself result-keyed, so one unwrap is lossless', () => {
    // The caller unwraps a lone `result` key. Without this branch a genuine
    // `{ result: x }` would be unwrapped to `x` and the caller would silently
    // lose a level. No handler returns that shape today; the round trip
    // should be lossless for every input, not for every input we have.
    const o = { result: [1] };
    const wrapped = asStructuredContent(o);
    assert.deepEqual(wrapped, { result: { result: [1] } });
    assert.deepEqual((wrapped as any).result, o);
  });

  it('round-trips every shape through a single unwrap', () => {
    const unwrap = (v: Record<string, unknown>) => {
      const keys = Object.keys(v);
      return keys.length === 1 && keys[0] === 'result' ? v.result : v;
    };
    for (const original of [[1, 2], { a: 1 }, { result: 'x' }, 'str', 7, null, []]) {
      assert.deepEqual(unwrap(asStructuredContent(original)), original);
    }
  });
});
