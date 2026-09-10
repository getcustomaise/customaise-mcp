/**
 * Sticky CLI state.
 *
 * A CLI process is ephemeral and has no notion of "the current tab", so
 * without this every command that touches a page needs `--tab N`. The
 * daemon could hold it, but it should not: the target is a property of the
 * person at the terminal, not of the resident process, and two terminals
 * pointing at two tabs is a reasonable thing to want. State is scoped to
 * cwd; CUSTOMAISE_CLI_SCOPE separates callers sharing the same cwd. Legacy
 * global cli-state.json is deliberately not imported into every workspace.
 *
 * Deliberately small. It stores what the user chose and nothing derived.
 */

import { mkdirSync, writeFileSync, readFileSync, renameSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tokenPath } from '../daemon.js';
import { createHash } from 'node:crypto';

function statePath(): string {
  // The daemon/config directory is shared. A remembered target belongs to
  // this workspace and, optionally, a named Bot working in that workspace.
  const scope = JSON.stringify([realpathSync(process.cwd()), process.env.CUSTOMAISE_CLI_SCOPE || '']);
  const key = createHash('sha256').update(scope).digest('hex');
  return join(dirname(tokenPath()), 'cli-state', key + '.json');
}

export interface CliState {
  /** Sticky tab, set by `customaise use --tab N`. */
  tabId?: number;
}

export function readState(): CliState {
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf-8'));
    return raw && Number.isSafeInteger(raw.tabId) && raw.tabId >= 0 ? { tabId: raw.tabId } : {};
  }
  catch { return {}; }
}

export function writeState(next: CliState): void {
  const p = statePath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
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
