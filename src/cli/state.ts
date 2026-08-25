/**
 * Sticky CLI state.
 *
 * A CLI process is ephemeral and has no notion of "the current tab", so
 * without this every command that touches a page needs `--tab N`. The
 * daemon could hold it, but it should not: the target is a property of the
 * person at the terminal, not of the resident process, and two terminals
 * pointing at two tabs is a reasonable thing to want.
 *
 * Deliberately small. It stores what the user chose and nothing derived.
 */

import { mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tokenPath } from '../daemon.js';

function statePath(): string {
  return join(dirname(tokenPath()), 'cli-state.json');
}

export interface CliState {
  /** Sticky tab, set by `customaise use --tab N`. */
  tabId?: number;
}

export function readState(): CliState {
  try { return JSON.parse(readFileSync(statePath(), 'utf-8')) as CliState; }
  catch { return {}; }
}

export function writeState(next: CliState): void {
  const p = statePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
}

/**
 * Resolve the tab for a command: explicit flag, then sticky, then undefined
 * so the extension falls back to the active tab. Explicit always wins; a
 * sticky target that silently overrode `--tab` would be a trap.
 */
export function resolveTab(explicit: number | undefined): number | undefined {
  if (explicit !== undefined) return explicit;
  return readState().tabId;
}
