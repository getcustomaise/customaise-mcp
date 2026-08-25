/**
 * Request context.
 *
 * The reason this is `AsyncLocalStorage` and not a field on the bridge: the
 * bridge is shared across every request, so a mutable "current signal" is
 * read by whichever call looked last. These tests pin the isolation that
 * makes the abort-propagation correct under concurrency.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withRequestContext, currentRequestContext } from '../request-context.js';

describe('request context', () => {
  it('is empty outside a request rather than throwing', () => {
    assert.deepEqual(currentRequestContext(), {});
  });

  it('exposes the signal to code called several frames deeper', () => {
    const ac = new AbortController();
    const deep = () => currentRequestContext().signal;
    const mid = () => deep();
    withRequestContext({ signal: ac.signal }, () => {
      assert.equal(mid(), ac.signal);
    });
  });

  it('keeps concurrent requests apart', async () => {
    const a = new AbortController();
    const b = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const task = (signal: AbortSignal, delay: number) =>
      withRequestContext({ signal }, async () => {
        await new Promise((r) => setTimeout(r, delay));
        seen.push(currentRequestContext().signal);
      });
    // Interleaved on purpose: a shared mutable field would leak one into the
    // other and both would see whichever ran last.
    await Promise.all([task(a.signal, 20), task(b.signal, 5)]);
    assert.ok(seen.includes(a.signal));
    assert.ok(seen.includes(b.signal));
    assert.notEqual(seen[0], seen[1]);
  });

  it('merges instead of replacing, because two layers contribute', async () => {
    // The daemon attaches the caller's workspace when the request arrives;
    // the envelope attaches the abort signal when the handler runs. An
    // earlier version replaced the store, so the envelope's `{ signal }`
    // erased the workspace and every context file landed in the daemon's own
    // directory instead of the caller's. Verified end to end at the time.
    const ac = new AbortController();
    withRequestContext({ workspaceDir: '/caller' }, () => {
      withRequestContext({ signal: ac.signal }, () => {
        assert.equal(currentRequestContext().workspaceDir, '/caller');
        assert.equal(currentRequestContext().signal, ac.signal);
      });
    });
  });

  it('does not let an undefined overwrite a value already in scope', () => {
    withRequestContext({ workspaceDir: '/caller' }, () => {
      withRequestContext({ signal: undefined }, () => {
        assert.equal(currentRequestContext().workspaceDir, '/caller');
      });
    });
  });

  it('lets an inner layer override the same key deliberately', () => {
    withRequestContext({ workspaceDir: '/outer' }, () => {
      withRequestContext({ workspaceDir: '/inner' }, () => {
        assert.equal(currentRequestContext().workspaceDir, '/inner');
      });
      assert.equal(currentRequestContext().workspaceDir, '/outer');
    });
  });

  it('does not leak out of the request that set it', async () => {
    const ac = new AbortController();
    await withRequestContext({ signal: ac.signal }, async () => {});
    assert.equal(currentRequestContext().signal, undefined);
  });
});
