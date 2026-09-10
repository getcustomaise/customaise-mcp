/**
 * Sticky tab resolution.
 *
 * The rule that matters: an explicit `--tab` always beats the sticky value.
 * A remembered target that silently overrode what the user just typed would
 * be a trap.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
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

  it('isolates sticky tabs between working directories', () => {
    const cwd = process.cwd();
    const a = join(dir, 'bot-a');
    const b = join(dir, 'bot-b');
    mkdirSync(a); mkdirSync(b);
    try {
      process.chdir(a);
      state.writeState({ tabId: 71 });
      process.chdir(b);
      assert.equal(state.resolveTab(undefined), undefined);
      state.writeState({ tabId: 82 });
      process.chdir(a);
      assert.equal(state.resolveTab(undefined), 71);
    } finally { process.chdir(cwd); }
  });

  it('isolates explicitly named Bots sharing a working directory', () => {
    const previous = process.env.CUSTOMAISE_CLI_SCOPE;
    try {
      process.env.CUSTOMAISE_CLI_SCOPE = 'bot-a';
      state.writeState({ tabId: 71 });
      process.env.CUSTOMAISE_CLI_SCOPE = 'bot-b';
      assert.equal(state.resolveTab(undefined), undefined);
      state.writeState({ tabId: 82 });
      process.env.CUSTOMAISE_CLI_SCOPE = 'bot-a';
      assert.equal(state.resolveTab(undefined), 71);
    } finally {
      if (previous === undefined) delete process.env.CUSTOMAISE_CLI_SCOPE;
      else process.env.CUSTOMAISE_CLI_SCOPE = previous;
    }
  });

  it('ignores malformed or invalid persisted tab IDs', () => {
    // Mutate every state fixture so this is independent of the file naming.
    const visit = (folder: string, value: unknown) => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const file = join(folder, entry.name);
        if (entry.isDirectory()) visit(file, value);
        else if (entry.name.endsWith('.json')) writeFileSync(file, JSON.stringify(value));
      }
    };
    for (const bad of [null, [], { tabId: -1 }, { tabId: 1.5 }, { tabId: '7' }]) {
      state.writeState({ tabId: 7 });
      visit(dir, bad);
      assert.deepEqual(state.readState(), {});
    }
  });
});
