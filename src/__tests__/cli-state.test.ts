/**
 * Sticky tab resolution.
 *
 * The rule that matters: an explicit `--tab` always beats the sticky value.
 * A remembered target that silently overrode what the user just typed would
 * be a trap.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let state: typeof import('../cli/state.js');

describe('cli state', () => {
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'customaise-state-'));
    process.env.CUSTOMAISE_CONFIG_DIR = dir;
    state = await import('../cli/state.js');
  });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('reads an absent state file as empty rather than throwing', () => {
    assert.deepEqual(state.readState(), {});
  });

  it('falls back to the sticky tab when no flag is given', () => {
    state.writeState({ tabId: 7 });
    assert.equal(state.resolveTab(undefined), 7);
  });

  it('lets an explicit flag win over the sticky tab', () => {
    state.writeState({ tabId: 7 });
    assert.equal(state.resolveTab(11), 11);
  });

  it('returns undefined with no flag and no sticky tab, so the extension picks the active tab', () => {
    state.writeState({});
    assert.equal(state.resolveTab(undefined), undefined);
  });
});
