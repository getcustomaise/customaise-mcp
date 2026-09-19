/**
 * The CLI's exit-code contract.
 *
 * An agent branches on these numbers, so they are an interface, not an
 * implementation detail. The mapping keys on the tool envelope's
 * `error.type` because an error thrown from a tool handler reaches a client
 * with its numeric code stripped; the type string is what survives.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EXIT, exitCodeForErrorType } from '../cli/exit-codes.js';

describe('exitCodeForErrorType', () => {
  it('separates the four failures an agent must handle differently', () => {
    assert.equal(exitCodeForErrorType('auth_required'), EXIT.AUTH);
    assert.equal(exitCodeForErrorType('cap_exceeded'), EXIT.CAP);
    assert.equal(exitCodeForErrorType('extension_not_connected'), EXIT.UNAVAILABLE);
    assert.equal(exitCodeForErrorType('consent_denied'), EXIT.DENIED);
  });

  it('maps the dispatch path\'s own vocabulary, not just the canonical names', () => {
    // cap-state.ts emits `rate_limit`; extension-bridge emits these three.
    assert.equal(exitCodeForErrorType('rate_limit'), EXIT.CAP);
    assert.equal(exitCodeForErrorType('extension_disconnected'), EXIT.UNAVAILABLE);
    assert.equal(exitCodeForErrorType('dispatch_timeout'), EXIT.UNAVAILABLE);
    assert.equal(exitCodeForErrorType('extension_outdated'), EXIT.UNAVAILABLE);
  });

  it('maps the consent outcomes the gate actually produces', () => {
    // These were unreachable until the gate attached a type: both refusal
    // paths threw a bare Error, so every consent outcome arrived as a
    // generic failure and codes 6 and 7 could never fire.
    assert.equal(exitCodeForErrorType('consent_denied'), EXIT.DENIED);
    assert.equal(exitCodeForErrorType('consent_timeout'), EXIT.TIMEOUT);
    assert.equal(exitCodeForErrorType('consent_cancelled'), EXIT.ERROR);
  });

  it('keeps a denial and a timeout distinct', () => {
    // Collapsing these would have an agent retry a decision the user made.
    assert.notEqual(exitCodeForErrorType('consent_denied'), exitCodeForErrorType('consent_timeout'));
  });

  it('keeps permission resolution and registration faults distinct from owner denial', () => {
    for (const type of ['permission_resolution_failed', 'tool_registration_timeout', 'tool_document_changed']) {
      assert.equal(exitCodeForErrorType(type), EXIT.UNAVAILABLE);
      assert.notEqual(exitCodeForErrorType(type), EXIT.DENIED);
    }
  });

  it('never returns 0 for an error type', () => {
    for (const t of ['auth_required','cap_exceeded','extension_not_connected',
                     'consent_denied','consent_timeout','integrity_violation','anything']) {
      assert.notEqual(exitCodeForErrorType(t), EXIT.OK, t);
    }
  });

  it('falls back to a generic failure rather than guessing', () => {
    assert.equal(exitCodeForErrorType('something_new'), EXIT.ERROR);
    assert.equal(exitCodeForErrorType(undefined), EXIT.ERROR);
  });
});
