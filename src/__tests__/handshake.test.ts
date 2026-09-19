/**
 * handshake — Unit tests for the v2 bridge protocol's pure helpers
 * (init_session adoption, dispatch_ack handling). Covers ARD §4.12's
 * "handshake" suite:
 *   - init_session with unlimited:true → server skips counter machinery
 *   - init_session with cap fields → server stores in memory
 *   - Forward-ahead ack → adopt new value, no error fired
 *   - Backwards ack → INTEGRITY_VIOLATION, session marked compromised
 *   - Bridge reconnect path → fresh init_session adopted (handled by
 *     extension-bridge tests; here we cover the pure adoption logic)
 *
 * Runner: Node's built-in node:test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAck,
  decideDispatch,
  ERROR_CODE_ENTITLEMENT_UNAVAILABLE,
  applyInitSession,
  buildIntegrityReport,
  createPendingSession,
} from '../cap-state.js';

describe('cap-state — handshake', () => {
  describe('applyInitSession', () => {
    it('unknown verification never becomes a Free cap and recovers on a verified plan', () => {
      let session = applyInitSession(createPendingSession('s'), { session_id: 's', tier: 'unknown' });
      assert.equal(session.mode, 'verifying');
      const decision = decideDispatch(session, new Date());
      assert.equal(decision.allow, false);
      if (!decision.allow) assert.equal(decision.code, ERROR_CODE_ENTITLEMENT_UNAVAILABLE);
      session = applyInitSession(session, { tier: 'power_user', unlimited: true });
      assert.equal(decideDispatch(session, new Date()).allow, true);
      session = applyInitSession(session, { tier: 'free', daily_cap: 1, current_used_daily: 1 });
      assert.equal(decideDispatch(session, new Date()).allow, false);
    });

    it('Power User payload (unlimited:true) → mode=unlimited, cap fields ignored', () => {
      let session = createPendingSession('s');
      session = applyInitSession(session, {
        session_id: 'session-abc',
        install_id: 'install-xyz',
        tier: 'power_user',
        unlimited: true,
        // Even if extension accidentally includes cap fields, we ignore them.
        daily_cap: 50,
        current_used_daily: 999,
      });
      assert.equal(session.mode, 'unlimited');
      assert.equal(session.sessionId, 'session-abc');
      assert.equal(session.installId, 'install-xyz');
      assert.equal(session.dailyUsed, 0, 'unlimited mode does not adopt counters');
    });

    it('Free payload with cap fields → mode=capped, counter adopted', () => {
      let session = createPendingSession('s');
      session = applyInitSession(session, {
        session_id: 'session-def',
        install_id: 'install-uvw',
        tier: 'free',
        daily_cap: 50,
        weekly_cap: 150,
        current_used_daily: 30,
        current_used_week: 87,
      });
      assert.equal(session.mode, 'capped');
      assert.equal(session.dailyCap, 50);
      assert.equal(session.weeklyCap, 150);
      assert.equal(session.dailyUsed, 30);
      assert.equal(session.weeklyUsed, 87);
    });

    it('Trial tier without explicit unlimited:true → mode=unlimited', () => {
      let session = createPendingSession('s');
      session = applyInitSession(session, { tier: 'trial' });
      assert.equal(session.mode, 'unlimited');
    });

    it('forgiving on missing cap fields — uses defaults', () => {
      let session = createPendingSession('s');
      session = applyInitSession(session, { tier: 'free' });
      assert.equal(session.mode, 'capped');
      assert.equal(session.dailyCap, 50, 'default daily cap');
      assert.equal(session.weeklyCap, 150, 'default weekly cap');
      assert.equal(session.dailyUsed, 0);
      assert.equal(session.weeklyUsed, 0);
    });

    it('rejects nonsensical cap values (negative, NaN, strings) silently', () => {
      let session = createPendingSession('s');
      session = applyInitSession(session, {
        tier: 'free',
        daily_cap: -10 as any,
        weekly_cap: NaN as any,
        current_used_daily: 'oops' as any,
        current_used_week: undefined as any,
      });
      // Negative values rejected (>= 0 guard); defaults preserved.
      assert.equal(session.dailyUsed, 0);
      assert.equal(session.weeklyUsed, 0);
      // Note: daily_cap < 0 IS rejected via the >=0 guard so default holds.
      assert.equal(session.dailyCap, 50);
      // weekly_cap=NaN falls through Number.isFinite check — default holds.
      assert.equal(session.weeklyCap, 150);
    });

    it('floors fractional counter values (defensive against bad payloads)', () => {
      let session = createPendingSession('s');
      session = applyInitSession(session, {
        tier: 'free',
        current_used_daily: 30.7,
        current_used_week: 87.99,
      });
      assert.equal(session.dailyUsed, 30);
      assert.equal(session.weeklyUsed, 87);
    });
  });

  describe('applyAck', () => {
    function makeCappedSession(dailyUsed: number) {
      let s = createPendingSession('s');
      s = applyInitSession(s, {
        tier: 'free',
        daily_cap: 50,
        current_used_daily: dailyUsed,
      });
      return s;
    }

    it('forward-ahead ack adopts the new counter (network-race recovery)', () => {
      const session = makeCappedSession(30);
      // Server's last-known is 30; extension reports it incremented to 32
      // (the previous ack was lost, then this call's ack catches up).
      const outcome = applyAck(session, { counter: 32, success: true }, 'list_scripts');
      assert.equal(outcome.kind, 'adopt');
      if (outcome.kind !== 'adopt') return;
      assert.equal(outcome.session.dailyUsed, 32);
      assert.equal(outcome.session.mode, 'capped', 'mode unchanged on forward-ahead');
    });

    it('equal ack adopts the same counter (no-op)', () => {
      const session = makeCappedSession(30);
      const outcome = applyAck(session, { counter: 30, success: true }, 'list_scripts');
      assert.equal(outcome.kind, 'adopt');
      if (outcome.kind !== 'adopt') return;
      assert.equal(outcome.session.dailyUsed, 30);
    });

    it('+1 ack (the normal happy path) adopts', () => {
      const session = makeCappedSession(30);
      const outcome = applyAck(session, { counter: 31, success: true }, 'list_scripts');
      assert.equal(outcome.kind, 'adopt');
      if (outcome.kind !== 'adopt') return;
      assert.equal(outcome.session.dailyUsed, 31);
    });

    it('backwards ack → integrity_violation + session marked compromised', () => {
      const session = makeCappedSession(30);
      // Tampering: chrome.storage.local was edited to count=12 → next
      // call's ack reports 12 (which is < server's 30).
      const outcome = applyAck(session, { counter: 12, success: true }, 'list_scripts');
      assert.equal(outcome.kind, 'integrity_violation');
      if (outcome.kind !== 'integrity_violation') return;
      assert.equal(outcome.session.mode, 'compromised');
      assert.equal(outcome.serverCountBefore, 30);
      assert.equal(outcome.ackCounter, 12);
      // Server's counter does NOT advance backwards; subsequent
      // dispatch attempts will be refused via decideDispatch's
      // 'compromised' branch.
    });

    it('failed dispatch (ack.success=false) does NOT change counter, no integrity check', () => {
      const session = makeCappedSession(30);
      // Failed call: counter stays at 30, no integrity flag even
      // though counter "didn't advance".
      const outcome = applyAck(session, { counter: 30, success: false }, 'export_script');
      assert.equal(outcome.kind, 'adopt');
      if (outcome.kind !== 'adopt') return;
      assert.equal(outcome.session.dailyUsed, 30);
      assert.equal(outcome.session.mode, 'capped');
    });

    it('failed dispatch with stale counter does NOT trigger integrity violation', () => {
      // Edge: a failed dispatch_ack arrives with a stale lower counter
      // (e.g., from a queued retry). Since success=false, we skip the
      // integrity check entirely — failures don't move counters.
      const session = makeCappedSession(30);
      const outcome = applyAck(session, { counter: 5, success: false }, 'export_script');
      assert.equal(outcome.kind, 'adopt');
    });

    it('malformed ack (non-numeric counter) → adopt no-op, no integrity violation', () => {
      const session = makeCappedSession(30);
      const outcome = applyAck(session, { counter: 'oops' as any, success: true }, 'list_scripts');
      assert.equal(outcome.kind, 'adopt');
      if (outcome.kind !== 'adopt') return;
      assert.equal(outcome.session.dailyUsed, 30, 'counter unchanged on malformed ack');
    });

    it('NaN counter → adopt no-op', () => {
      const session = makeCappedSession(30);
      const outcome = applyAck(session, { counter: NaN, success: true }, 'list_scripts');
      assert.equal(outcome.kind, 'adopt');
      if (outcome.kind !== 'adopt') return;
      assert.equal(outcome.session.dailyUsed, 30);
    });

    it('floors fractional ack counters (defensive)', () => {
      const session = makeCappedSession(30);
      const outcome = applyAck(session, { counter: 31.7, success: true }, 'list_scripts');
      assert.equal(outcome.kind, 'adopt');
      if (outcome.kind !== 'adopt') return;
      assert.equal(outcome.session.dailyUsed, 31);
    });
  });

  describe('buildIntegrityReport', () => {
    it('produces the ARD §4.4 frame shape', () => {
      let session = createPendingSession('test-session-id');
      session = applyInitSession(session, { tier: 'free', current_used_daily: 30 });
      const frame = buildIntegrityReport(session, 30, 12, 'export_script');
      assert.equal(frame.type, 'report_integrity_error');
      assert.equal(frame.session_id, 'test-session-id');
      assert.equal(frame.scope, 'backwards_counter');
      assert.equal(frame.server_count_before, 30);
      assert.equal(frame.ack_counter, 12);
      assert.equal(frame.tool, 'export_script');
    });
  });
});
