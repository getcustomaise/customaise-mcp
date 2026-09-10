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
import { homedir } from 'node:os';
import { withRequestContext } from '../request-context.js';
import { getWorkspaceDir } from '../server.js';

const originalEnv = process.env.CUSTOMAISE_WORKSPACE;

describe('workspace resolution', () => {
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CUSTOMAISE_WORKSPACE;
    else process.env.CUSTOMAISE_WORKSPACE = originalEnv;
  });

  it('prefers the explicit caller workspace over the environment', () => {
    process.env.CUSTOMAISE_WORKSPACE = '/from/env';
    withRequestContext({ workspaceDir: '/from/cli' }, () => {
      assert.equal(getWorkspaceDir(), '/from/cli');
    });
  });

  it('preserves the stdio environment override', () => {
    process.env.CUSTOMAISE_WORKSPACE = '/from/env';
    assert.equal(getWorkspaceDir(), '/from/env');
  });

  it('falls back to cwd for stdio', () => {
    delete process.env.CUSTOMAISE_WORKSPACE;
    assert.equal(getWorkspaceDir(), process.cwd() === '/' ? homedir() : process.cwd());
  });

  it('honors an explicitly declared root without silently writing elsewhere', () => {
    process.env.CUSTOMAISE_WORKSPACE = '/from/env';
    withRequestContext({ workspaceDir: '/' }, () => assert.equal(getWorkspaceDir(), '/'));
  });

  it('does not carry one request workspace into the next', () => {
    process.env.CUSTOMAISE_WORKSPACE = '/from/env';
    withRequestContext({ workspaceDir: '/a' }, () => assert.equal(getWorkspaceDir(), '/a'));
    assert.equal(getWorkspaceDir(), '/from/env');
  });
});
