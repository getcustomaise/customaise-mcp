/**
 * cap-counter — Unit tests for the pure counter / session helpers in
 * cap-state.ts. Covers ARD §4.12's "cap-counter" suite:
 *   - Fresh counter on first use
 *   - Daily reset at UTC midnight
 *   - Old (>7d) entries pruned (handled extension-side; server keeps
 *     a single-day mirror, so we test the rolloverDailyIfNeeded
 *     equivalent here)
 *   - takeNextSeqNum monotonicity
 *
 * Runner: Node's built-in node:test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPendingSession,
  rolloverDailyIfNeeded,
  takeNextSeqNum,
  utcDateString,
  nextUtcMidnight,
  DAILY_CAP,
  WEEKLY_CAP,
} from '../cap-state.js';

describe('cap-state — counter helpers', () => {
  describe('createPendingSession', () => {
    it('returns a pending session with default caps + zero counters', () => {
      const session = createPendingSession('s1');
      assert.equal(session.sessionId, 's1');
      assert.equal(session.mode, 'pending');
      assert.equal(session.dailyUsed, 0);
      assert.equal(session.weeklyUsed, 0);
      assert.equal(session.dailyCap, DAILY_CAP);
      assert.equal(session.weeklyCap, WEEKLY_CAP);
      assert.equal(session.nextSeqNum, 1);
      assert.equal(session.deprecationErrorSent, false);
      assert.equal(session.installId, null);
    });

    it('records today as the dailyDateUtc', () => {
      const before = utcDateString(new Date());
      const session = createPendingSession('s2');
      const after = utcDateString(new Date());
      // dailyDateUtc must be one of the two dates straddling now
      // (handles the rare case the test runs across UTC midnight).
      assert.ok(
        session.dailyDateUtc === before || session.dailyDateUtc === after,
        `expected ${session.dailyDateUtc} ∈ {${before}, ${after}}`,
      );
    });
  });

  describe('rolloverDailyIfNeeded', () => {
    it('no-op when UTC date unchanged', () => {
      const session = createPendingSession('s');
      const result = rolloverDailyIfNeeded(session, new Date());
      assert.equal(result.rolled, false);
      assert.equal(result.session, session, 'should be referential equality on no-op');
    });

    it('resets dailyUsed to 0 when UTC date has changed', () => {
      const session = { ...createPendingSession('s'), dailyUsed: 37, weeklyUsed: 100, dailyDateUtc: '2026-04-30' };
      const tomorrow = new Date('2026-05-01T00:00:01.000Z');
      const result = rolloverDailyIfNeeded(session, tomorrow);
      assert.equal(result.rolled, true);
      assert.equal(result.session.dailyUsed, 0);
      assert.equal(result.session.dailyDateUtc, '2026-05-01');
      assert.equal(result.session.weeklyUsed, 100, 'weekly counter intentionally NOT reset by daily rollover');
    });

    it('rolls over multiple days at once', () => {
      const session = { ...createPendingSession('s'), dailyUsed: 50, dailyDateUtc: '2026-04-25' };
      const muchLater = new Date('2026-05-10T12:00:00.000Z');
      const result = rolloverDailyIfNeeded(session, muchLater);
      assert.equal(result.rolled, true);
      assert.equal(result.session.dailyDateUtc, '2026-05-10');
      assert.equal(result.session.dailyUsed, 0);
    });
  });

  describe('takeNextSeqNum', () => {
    it('returns sequential seq_nums and increments the session counter', () => {
      let session = createPendingSession('s');
      const a = takeNextSeqNum(session);
      assert.equal(a.seqNum, 1);
      session = a.session;
      const b = takeNextSeqNum(session);
      assert.equal(b.seqNum, 2);
      session = b.session;
      const c = takeNextSeqNum(session);
      assert.equal(c.seqNum, 3);
      assert.equal(c.session.nextSeqNum, 4);
    });
  });

  describe('utcDateString', () => {
    it('formats as YYYY-MM-DD in UTC regardless of local TZ', () => {
      const date = new Date('2026-05-02T23:30:00.000Z');
      assert.equal(utcDateString(date), '2026-05-02');
    });

    it('zero-pads single-digit month and day', () => {
      const date = new Date('2026-01-05T12:00:00.000Z');
      assert.equal(utcDateString(date), '2026-01-05');
    });
  });

  describe('nextUtcMidnight', () => {
    it('returns the upcoming UTC midnight', () => {
      const now = new Date('2026-05-02T14:30:00.000Z');
      const next = nextUtcMidnight(now);
      assert.equal(next.toISOString(), '2026-05-03T00:00:00.000Z');
    });

    it('crosses month boundary correctly', () => {
      const now = new Date('2026-05-31T20:00:00.000Z');
      const next = nextUtcMidnight(now);
      assert.equal(next.toISOString(), '2026-06-01T00:00:00.000Z');
    });

    it('crosses year boundary correctly', () => {
      const now = new Date('2026-12-31T23:59:00.000Z');
      const next = nextUtcMidnight(now);
      assert.equal(next.toISOString(), '2027-01-01T00:00:00.000Z');
    });
  });
});
