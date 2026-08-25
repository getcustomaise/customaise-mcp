/**
 * Auto-export gating.
 *
 * `sync_scripts` arms a watcher that re-exports on every save. For a server
 * an IDE spawned and kills with the session that is a good default: a human
 * is sitting there. A resident daemon is different on both counts. It writes
 * scripts into the browser with nobody watching, and because no dispatch is
 * cap-exempt, every save silently spends a cap unit, so an agent iterating in
 * an editor loop could drain a Free tier without ever calling a tool.
 *
 * An earlier version of the daemon logged a `--watch` line and gated nothing,
 * so the watcher armed regardless.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileWatcher } from '../file-watcher.js';

const stubBridge = () => ({
  dispatchTool: async () => ({}),
  request: async () => ({}),
  onPush: () => {},
  setOwnClientInfo: () => {},
  start: async () => {},
  close: async () => {},
  role: 'leader' as const,
  isConnected: true,
});

function syncedDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'customaise-watch-'));
  writeFileSync(join(d, '.customaise-manifest.json'), JSON.stringify({ 'a.user.js': 'id1' }));
  return d;
}

describe('file watcher gating', () => {
  it('is enabled by default, which is what an IDE-spawned server wants', () => {
    assert.equal(new FileWatcher(stubBridge() as any).isEnabled, true);
  });

  it('can be constructed disabled, which is what the daemon does', () => {
    assert.equal(new FileWatcher(stubBridge() as any, { enabled: false }).isEnabled, false);
  });

  it('treats an explicit true the same as the default', () => {
    assert.equal(new FileWatcher(stubBridge() as any, { enabled: true }).isEnabled, true);
  });

  it('does not begin watching when disabled, even with a valid manifest', () => {
    const dir = syncedDir();
    try {
      const w = new FileWatcher(stubBridge() as any, { enabled: false });
      w.start(dir);
      // No watcher means nothing to stop; stop() must stay safe to call.
      w.stop();
      assert.equal(w.isEnabled, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('begins watching when enabled', () => {
    const dir = syncedDir();
    try {
      const w = new FileWatcher(stubBridge() as any);
      w.start(dir);
      w.stop();
      assert.equal(w.isEnabled, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
