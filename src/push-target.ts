/**
 * Where an unsolicited push should be written, or why it cannot be.
 *
 * A push carries no workspace of its own. On stdio that is fine: one client,
 * one workspace, no question to answer. The daemon serves many CLIs, each
 * standing in a different directory, and the push arrives with nothing tying
 * it to any of them.
 *
 * The daemon used to keep a single `lastWorkspace` and write there. That is
 * right most of the time and silently wrong the rest, and a `.dom.md` written
 * into the wrong project is the kind of wrong answer nobody notices until
 * much later. So the rule is: write only when the answer is unambiguous, and
 * when it is not, decline with a reason and name the command that is.
 */

import type { PushTarget } from './server.js';

/**
 * How long a workspace counts as active after its last command.
 *
 * Long enough that pausing to click around the browser does not expire it,
 * short enough that a project you left this morning is not still making
 * this afternoon's selections ambiguous.
 */
export const WORKSPACE_ACTIVE_MS = 15 * 60 * 1000;

/**
 * Decide a push's destination from the workspaces seen recently.
 *
 * Prunes `active` in place: entries older than the window stop counting, so a
 * daemon that has been up for days across five projects is not permanently
 * ambiguous. That pruning is the reason this takes the map rather than a
 * snapshot of it.
 */
export function resolvePushTarget(
  active: Map<string, number>,
  now: number = Date.now(),
  windowMs: number = WORKSPACE_ACTIVE_MS,
): PushTarget {
  const cutoff = now - windowMs;
  for (const [dir, seen] of active) {
    if (seen < cutoff) active.delete(dir);
  }

  const dirs = [...active.keys()];
  if (dirs.length === 1) return { dir: dirs[0] };
  if (dirs.length === 0) {
    return { dir: null, reason: 'no CLI has declared a workspace yet' };
  }
  return {
    dir: null,
    reason: `${dirs.length} workspaces are active (${dirs.join(', ')}), so the target is `
      + 'ambiguous. Run "customaise context selection -o ." in the one you want.',
  };
}
