import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createPendingSession, applyInitSession } from '../cap-state.js';

it('status retains a valid profile permission snapshot, clearing stale state on older or malformed frames', () => {
  const access = { mode: 'full_access' as const, revision: 'grant-1', scope: 'browser_profile' as const, locked: false };
  const session = applyInitSession(createPendingSession('s1'), { agent_permissions: access });
  assert.deepEqual(session.agentPermissions, { ...access, scriptDecisions: false });
  assert.equal(applyInitSession(session, {}).agentPermissions, null);
  assert.equal(applyInitSession(session, { agent_permissions: { ...access, mode: 'other' } as any }).agentPermissions, null);
});

it('reports whether agents may manage Script Decisions, and an extension before 1.4.0 as not', () => {
  const access = { mode: 'full_access' as const, revision: 'grant-1', scope: 'browser_profile' as const, locked: false };
  const granted = applyInitSession(createPendingSession('s1'), { agent_permissions: { ...access, scriptDecisions: true } });
  assert.equal(granted.agentPermissions?.scriptDecisions, true);
  // A later frame without the grant takes it away rather than keeping the old answer.
  assert.equal(applyInitSession(granted, { agent_permissions: { ...access, scriptDecisions: false } }).agentPermissions?.scriptDecisions, false);
  // An extension before 1.4.0 sends no field: the snapshot stays valid and says no.
  const older = applyInitSession(granted, { agent_permissions: access });
  assert.equal(older.agentPermissions?.mode, 'full_access');
  assert.equal(older.agentPermissions?.scriptDecisions, false);
  // A malformed value is never read as a grant, and never voids the rest.
  const malformed = applyInitSession(granted, { agent_permissions: { ...access, scriptDecisions: 'true' } as any });
  assert.deepEqual(malformed.agentPermissions, { ...access, scriptDecisions: false });
});
