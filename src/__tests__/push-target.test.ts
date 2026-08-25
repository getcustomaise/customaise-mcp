/**
 * The daemon must never guess which workspace an unsolicited push belongs to.
 *
 * Two terminals in two projects, and a selection push had no way to say which
 * one it was for. The daemon wrote to whichever CLI ran last, which is right
 * most of the time and silently wrong the rest. Silently wrong is the failure
 * mode worth designing out: nobody notices a `.dom.md` in the wrong project
 * until they go looking for one that is not there.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePushTarget, WORKSPACE_ACTIVE_MS } from '../push-target.js';

const NOW = 1_800_000_000_000;

describe('resolvePushTarget', () => {
  it('writes when exactly one workspace is active', () => {
    const active = new Map([['/home/kert/projA', NOW - 1000]]);
    assert.deepEqual(resolvePushTarget(active, NOW), { dir: '/home/kert/projA' });
  });

  it('declines, with a reason, before any CLI has spoken', () => {
    const target = resolvePushTarget(new Map(), NOW);
    assert.equal(target.dir, null);
    assert.match((target as { reason: string }).reason, /no CLI has declared a workspace/);
  });

  it('declines rather than picking one of several', () => {
    const active = new Map([
      ['/home/kert/projA', NOW - 1000],
      ['/home/kert/projB', NOW - 2000],
    ]);
    const target = resolvePushTarget(active, NOW);
    assert.equal(target.dir, null, 'must not guess');
    const { reason } = target as { reason: string };
    assert.match(reason, /2 workspaces are active/);
    assert.match(reason, /projA/);
    assert.match(reason, /projB/, 'names both, so the user can see the collision');
    assert.match(reason, /context selection -o \./, 'names the unambiguous command');
  });

  it('stops counting a workspace once it goes quiet, so old projects do not poison it', () => {
    // Without pruning, a daemon up for days across five projects would be
    // permanently ambiguous and would never auto-write again.
    const active = new Map([
      ['/home/kert/thisMorning', NOW - WORKSPACE_ACTIVE_MS - 1],
      ['/home/kert/rightNow', NOW - 1000],
    ]);
    assert.deepEqual(resolvePushTarget(active, NOW), { dir: '/home/kert/rightNow' });
  });

  it('prunes in place, so the caller does not accumulate dead entries', () => {
    const active = new Map([['/gone', NOW - WORKSPACE_ACTIVE_MS - 1]]);
    resolvePushTarget(active, NOW);
    assert.equal(active.size, 0);
  });

  it('treats the window edge as still active', () => {
    const active = new Map([['/edge', NOW - WORKSPACE_ACTIVE_MS]]);
    assert.deepEqual(resolvePushTarget(active, NOW), { dir: '/edge' });
  });
});
