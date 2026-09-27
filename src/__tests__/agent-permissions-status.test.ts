import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createPendingSession, applyInitSession } from '../cap-state.js';

it('status retains a valid profile permission snapshot, clearing stale state on older or malformed frames', () => {
  const access = { mode: 'full_access' as const, revision: 'grant-1', scope: 'browser_profile' as const, locked: false };
  const session = applyInitSession(createPendingSession('s1'), { agent_permissions: access });
  assert.deepEqual(session.agentPermissions, access);
  assert.equal(applyInitSession(session, {}).agentPermissions, null);
  assert.equal(applyInitSession(session, { agent_permissions: { ...access, mode: 'other' } as any }).agentPermissions, null);
});
