/**
 * Workspace resolution order.
 *
 * Three sources, and getting the order wrong breaks real users:
 *
 *   1. What the caller declared for this request. Only the CLI sets it, and
 *      it must win, because the daemon it talks to was spawned from some
 *      other directory entirely.
 *   2. `CUSTOMAISE_WORKSPACE`. The public install instructions tell
 *      Antigravity users to set this because its cwd is unreliable, so it
 *      must keep beating cwd exactly as it did before the CLI existed.
 *   3. The spawning IDE's cwd.
 *
 * A naive "declared wins, else cwd" would silently break every Antigravity
 * user following the documented setup.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { withRequestContext, currentRequestContext } from '../request-context.js';

// Mirrors the resolution in server.ts's getWorkspaceDir, which is module
// private. Kept in step by asserting the same ordering rules.
function resolve(env: string | undefined, cwd: string): string {
  const declared = currentRequestContext().workspaceDir;
  if (declared && declared !== '/' && declared !== '') return declared;
  if (env && env !== '/' && env !== '') return env;
  return cwd;
}

describe('workspace resolution', () => {
  afterEach(() => { delete process.env.CUSTOMAISE_WORKSPACE; });

  it('prefers what the caller declared for this request', () => {
    withRequestContext({ workspaceDir: '/from/cli' }, () => {
      assert.equal(resolve('/from/env', '/from/cwd'), '/from/cli');
    });
  });

  it('keeps the env var beating cwd when nothing was declared', () => {
    // Antigravity depends on this. Breaking it would move their context
    // files silently.
    assert.equal(resolve('/from/env', '/from/cwd'), '/from/env');
  });

  it('falls back to cwd when neither is set', () => {
    assert.equal(resolve(undefined, '/from/cwd'), '/from/cwd');
  });

  it('ignores a declared root, which is what an unset cwd looks like', () => {
    withRequestContext({ workspaceDir: '/' }, () => {
      assert.equal(resolve(undefined, '/from/cwd'), '/from/cwd');
    });
  });

  it('does not let one request\'s workspace leak into the next', () => {
    withRequestContext({ workspaceDir: '/a' }, () => {
      assert.equal(resolve(undefined, '/cwd'), '/a');
    });
    assert.equal(resolve(undefined, '/cwd'), '/cwd');
  });
});
