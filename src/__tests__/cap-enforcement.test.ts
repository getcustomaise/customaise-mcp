/**
 * cap-enforcement — Unit tests for decideDispatch covering ARD §4.12's
 * "cap-enforcement" suite:
 *   - Free user under cap → tool dispatches
 *   - Free user at daily cap → MCP_CAP_EXCEEDED (scope: 'daily')
 *   - Free user at weekly cap → MCP_CAP_EXCEEDED (scope: 'weekly')
 *   - Power User / Trial (unlimited) → cap check skipped
 *   - Compromised session → refused with INTEGRITY_VIOLATION
 *   - Pending session → allowed (caller waits for resolution)
 *
 * The "failed tool calls don't increment counter" / "all successful
 * tool calls count" / "protocol-level traffic doesn't count" parts of
 * the §4.12 spec are integration concerns covered by the
 * extension-bridge handshake suite (test the handler routing, not the
 * pure decision function).
 *
 * Runner: Node's built-in node:test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyInitSession,
  createPendingSession,
  decideDispatch,
  markCompromised,
  markLegacy,
  ERROR_CODE_CAP_EXCEEDED,
  ERROR_CODE_INTEGRITY_VIOLATION,
} from '../cap-state.js';

describe('cap-state — decideDispatch', () => {
  const NOW = new Date('2026-05-02T14:30:00.000Z');

  describe('Free tier (capped)', () => {
    it('allows dispatch when under daily and weekly caps', () => {
      let session = createPendingSession('s');
      session = applyInitSession(session, {
        tier: 'free',
        daily_cap: 50,
        weekly_cap: 150,
        current_used_daily: 30,
        current_used_week: 87,
      });
      const decision = decideDispatch(session, NOW);
      assert.equal(decision.allow, true);
    });

    it('rejects with MCP_CAP_EXCEEDED scope=daily at the daily cap', () => {
      let session = createPendingSession('s');
      session = applyInitSession(session, {
        tier: 'free',
        daily_cap: 50,
        current_used_daily: 50,
        current_used_week: 50,
      });
      const decision = decideDispatch(session, NOW);
      assert.equal(decision.allow, false);
      if (decision.allow) return; // narrow types
      assert.equal(decision.code, ERROR_CODE_CAP_EXCEEDED);
      assert.equal(decision.scope, 'daily');
      assert.match(decision.message, /Daily MCP cap reached: 50\/50/);
      assert.match(decision.message, /Resets in/);
      assert.match(decision.message, /https:\/\/customaise\.com\/pricing/);
      assert.equal((decision.data as any).type, 'rate_limit');
      assert.equal((decision.data as any).scope, 'daily');
      assert.equal((decision.data as any).used, 50);
      assert.equal((decision.data as any).limit, 50);
    });

    it('rejects with MCP_CAP_EXCEEDED scope=weekly at the weekly cap (daily under)', () => {
      let session = createPendingSession('s');
      session = applyInitSession(session, {
        tier: 'free',
        daily_cap: 50,
        weekly_cap: 150,
        current_used_daily: 10,
        current_used_week: 150,
      });
      const decision = decideDispatch(session, NOW);
      assert.equal(decision.allow, false);
      if (decision.allow) return;
      assert.equal(decision.code, ERROR_CODE_CAP_EXCEEDED);
      assert.equal(decision.scope, 'weekly');
      assert.match(decision.message, /Weekly MCP cap reached: 150\/150/);
    });

    it('rejects with daily scope when both daily AND weekly are at cap (daily wins as primary)', () => {
      let session = createPendingSession('s');
      session = applyInitSession(session, {
        tier: 'free',
        daily_cap: 50,
        weekly_cap: 150,
        current_used_daily: 50,
        current_used_week: 150,
      });
      const decision = decideDispatch(session, NOW);
      assert.equal(decision.allow, false);
      if (decision.allow) return;
      assert.equal(decision.scope, 'daily', 'daily check fires first');
    });
  });

  describe('Skip-for-paid (ARD §4.7)', () => {
    it('Power User init_session → unlimited mode → always allows', () => {
      let session = createPendingSession('s');
      session = applyInitSession(session, { tier: 'power_user', unlimited: true });
      assert.equal(session.mode, 'unlimited');
      const decision = decideDispatch(session, NOW);
      assert.equal(decision.allow, true);
    });

    it('Trial init_session → unlimited mode → always allows', () => {
      let session = createPendingSession('s');
      session = applyInitSession(session, { tier: 'trial', unlimited: true });
      assert.equal(session.mode, 'unlimited');
      const decision = decideDispatch(session, NOW);
      assert.equal(decision.allow, true);
    });

    it('unlimited bypass holds even when counters appear at cap (defensive)', () => {
      let session = createPendingSession('s');
      session = applyInitSession(session, { tier: 'power_user', unlimited: true });
      // Even if some bug populated dailyUsed past the cap, unlimited
      // mode shortcuts the check before that path.
      const dirty = { ...session, dailyUsed: 999, weeklyUsed: 9999 };
      const decision = decideDispatch(dirty, NOW);
      assert.equal(decision.allow, true);
    });

    it('Implicit unlimited: tier=power_user without explicit unlimited:true', () => {
      let session = createPendingSession('s');
      session = applyInitSession(session, { tier: 'power_user' });
      assert.equal(session.mode, 'unlimited');
      const decision = decideDispatch(session, NOW);
      assert.equal(decision.allow, true);
    });
  });

  describe('Pending session', () => {
    it('allows dispatch (caller is expected to wait for init_session resolution before calling)', () => {
      const session = createPendingSession('s');
      assert.equal(session.mode, 'pending');
      const decision = decideDispatch(session, NOW);
      assert.equal(decision.allow, true);
    });
  });

  describe('Legacy session', () => {
    it('enforces Free cap on legacy mode (old extension fallback)', () => {
      let session = createPendingSession('s');
      session = markLegacy(session);
      // Legacy session has dailyUsed=0 by default → first call allowed
      const decisionA = decideDispatch(session, NOW);
      assert.equal(decisionA.allow, true);
      // Simulate counter at cap
      const dirty = { ...session, dailyUsed: 50 };
      const decisionB = decideDispatch(dirty, NOW);
      assert.equal(decisionB.allow, false);
      if (decisionB.allow) return;
      assert.equal(decisionB.scope, 'daily');
    });
  });

  describe('Compromised session', () => {
    it('refuses with INTEGRITY_VIOLATION until reconnect', () => {
      let session = createPendingSession('s');
      session = applyInitSession(session, { tier: 'free', current_used_daily: 5, current_used_week: 5 });
      session = markCompromised(session);
      const decision = decideDispatch(session, NOW);
      assert.equal(decision.allow, false);
      if (decision.allow) return;
      assert.equal(decision.code, ERROR_CODE_INTEGRITY_VIOLATION);
      assert.equal(decision.scope, 'session');
      assert.match(decision.message, /integrity check failed/i);
      assert.match(decision.message, /Reconnect MCP/);
    });

    it('refuses even when counters are still under cap (security signal trumps quota)', () => {
      let session = createPendingSession('s');
      session = applyInitSession(session, { tier: 'free' });
      // Tampering detected; counters still report 0/50 but we've decided
      // to refuse this whole session.
      session = markCompromised(session);
      const decision = decideDispatch(session, NOW);
      assert.equal(decision.allow, false);
    });
  });

  describe('Cap-exceeded error data field shape (ARD §4.8)', () => {
    it('includes resetsAt as ISO 8601 UTC', () => {
      let session = createPendingSession('s');
      session = applyInitSession(session, {
        tier: 'free',
        daily_cap: 50,
        current_used_daily: 50,
      });
      const decision = decideDispatch(session, NOW);
      assert.equal(decision.allow, false);
      if (decision.allow) return;
      const resetsAt = (decision.data as any).resetsAt;
      assert.equal(typeof resetsAt, 'string');
      assert.match(resetsAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      // Should land on a UTC midnight (00:00:00.000Z)
      assert.match(resetsAt, /T00:00:00\.000Z$/);
    });

    it('includes upgradeUrl pointing to /pricing', () => {
      let session = createPendingSession('s');
      session = applyInitSession(session, { tier: 'free', daily_cap: 50, current_used_daily: 50 });
      const decision = decideDispatch(session, NOW);
      assert.equal(decision.allow, false);
      if (decision.allow) return;
      assert.equal((decision.data as any).upgradeUrl, 'https://customaise.com/pricing');
    });
  });
});
