/**
 * Tool envelope tests.
 *
 * The behaviour under test exists because an error thrown from a
 * `tools/call` handler reaches the client as `{ isError: true, content: [text] }`
 * with the code and data discarded. These assertions pin the machine-readable
 * half that replaces it.
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { currentRequestContext } from '../request-context.js';
import { toStructuredError, installToolEnvelope, withInboxNotice, INBOX_NOTICE_KEY, ERROR_TYPES } from '../tool-envelope.js';
import {
  ERROR_CODE_AUTH_REQUIRED,
  ERROR_CODE_CAP_EXCEEDED,
  ERROR_CODE_INTEGRITY_VIOLATION,
} from '../cap-state.js';

describe('toStructuredError', () => {
  it('includes save recovery IDs in text for clients that only show content', () => {
    const r = toStructuredError({ message: 'Timed out', data: {
      scriptId: 's1', operationId: 'op', outcome: 'unknown', recovery: 'Query save status'
    } });
    assert.match(r.content[0].text, /"scriptId":"s1"/);
    assert.match(r.content[0].text, /"operationId":"op"/);
    assert.match(r.content[0].text, /"outcome":"unknown"/);
  });
  it('prefers the dispatch path\'s own data.type over the code map', () => {
    const r = toStructuredError({ code: -32030, message: 'gone', data: { type: 'extension_not_connected' } });
    assert.equal(r.structuredContent.error.type, 'extension_not_connected');
    assert.equal(r.structuredContent.error.code, -32030);
  });

  it('falls back to the code map when no data.type is present', () => {
    assert.equal(toStructuredError({ code: ERROR_CODE_CAP_EXCEEDED, message: 'x' })
      .structuredContent.error.type, ERROR_TYPES.CAP_EXCEEDED);
    assert.equal(toStructuredError({ code: ERROR_CODE_AUTH_REQUIRED, message: 'x' })
      .structuredContent.error.type, ERROR_TYPES.AUTH_REQUIRED);
    assert.equal(toStructuredError({ code: ERROR_CODE_INTEGRITY_VIOLATION, message: 'x' })
      .structuredContent.error.type, ERROR_TYPES.INTEGRITY_VIOLATION);
  });

  it('classifies an unrecognised throw as internal rather than losing it', () => {
    const r = toStructuredError(new Error('boom'));
    assert.equal(r.structuredContent.error.type, ERROR_TYPES.INTERNAL);
    assert.equal(r.content[0].text, 'boom');
  });

  it('carries the dispatch data through so a caller can act on it', () => {
    const r = toStructuredError({
      code: ERROR_CODE_CAP_EXCEEDED, message: 'capped',
      data: { type: 'rate_limit', scope: 'daily', used: 50, limit: 50, resetsAt: 'T' },
    });
    assert.equal(r.structuredContent.error.scope, 'daily');
    assert.equal(r.structuredContent.error.used, 50);
    assert.equal(r.structuredContent.error.resetsAt, 'T');
  });

  it('always emits content as well as structuredContent', () => {
    // Two readers: a CLI parses the structured half, the model reads the text.
    const r = toStructuredError({ code: -32029, message: 'Free tier daily cap reached.' });
    assert.equal(r.isError, true);
    assert.equal(r.content[0].type, 'text');
    assert.equal(r.content[0].text, 'Free tier daily cap reached.');
  });

  it('never produces an empty message', () => {
    assert.equal(toStructuredError({}).content[0].text, 'Tool call failed.');
  });
});

describe('installToolEnvelope', () => {
  function fakeServer() {
    const registered: Array<{ name: string; handler: Function }> = [];
    return {
      registerTool: mock.fn((name: string, _c: unknown, handler: Function) => { registered.push({ name, handler }); }),
      _registered: registered,
    };
  }

  it('shapes a throwing handler instead of letting it propagate', async () => {
    const s = fakeServer();
    installToolEnvelope(s as any);
    (s as any).registerTool('boom', {}, async () => { throw { code: -32029, message: 'capped', data: { type: 'rate_limit' } }; });
    const out: any = await s._registered[0].handler({}, {});
    assert.equal(out.isError, true);
    assert.equal(out.structuredContent.error.type, 'rate_limit');
  });

  it('passes a successful result through untouched', async () => {
    const s = fakeServer();
    installToolEnvelope(s as any);
    const ok = { content: [{ type: 'text', text: 'fine' }] };
    (s as any).registerTool('ok', {}, async () => ok);
    assert.deepEqual(await s._registered[0].handler({}, {}), ok);
  });

  it('reports modern-era clientInfo from the request envelope', async () => {
    const s = fakeServer();
    const seen: unknown[] = [];
    installToolEnvelope(s as any, { onClientInfo: (i) => seen.push(i) });
    (s as any).registerTool('t', {}, async () => ({ content: [] }));
    await s._registered[0].handler({}, {
      mcpReq: { envelope: { 'io.modelcontextprotocol/clientInfo': { name: 'Cursor', version: '0.42.0' } } },
    });
    assert.deepEqual(seen[0], { name: 'Cursor', version: '0.42.0' });
  });

  it('does not fail a tool call when the identity hook throws', async () => {
    const s = fakeServer();
    installToolEnvelope(s as any, { onClientInfo: () => { throw new Error('label broke'); } });
    (s as any).registerTool('t', {}, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const out: any = await s._registered[0].handler({}, {});
    assert.equal(out.content[0].text, 'ok');
  });

  it('describes save progress as a save stage rather than a consent prompt', async () => {
    const s = fakeServer(); const frames: any[] = [];
    installToolEnvelope(s as any);
    (s as any).registerTool('save', {}, async () => {
      currentRequestContext().onPending?.({ reason: 'script_save:monaco_document_setup (op1)', expectedTimeoutMs: 70000 });
      return { content: [] };
    });
    await s._registered[0].handler({}, { mcpReq: { _meta: { progressToken: 'token' }, notify: (frame: any) => frames.push(frame) } });
    assert.match(frames[0].params.message, /monaco_document_setup/);
    assert.doesNotMatch(frames[0].params.message, /user to approve/);
  });
});

describe('the inbox notice', () => {
  const result = () => ({ structuredContent: { result: [1, 2] }, content: [{ type: 'text', text: '[1,2]' }] });

  it('says in both halves that hand-overs are waiting, and leaves the tool\'s own JSON first', () => {
    const noted = withInboxNotice(result(), () => 2) as any;
    assert.deepEqual(noted.structuredContent.result, [1, 2]);
    assert.equal(noted.structuredContent[INBOX_NOTICE_KEY].waiting, 2);
    assert.equal(noted.content[0].text, '[1,2]');
    assert.match(noted.content[1].text, /2 hand-overs from a script's remote are waiting for an agent/);
    // Every agent on the browser reads it: it says whose it is to take, and how to look without taking.
    assert.match(noted.content[1].text, /If you gave the user a remote's link, take yours/);
    assert.match(noted.content[1].text, /list_handovers \(customaise inbox\) shows what is waiting and takes nothing/);
    assert.match(noted.content[1].text, /If none is from a remote you sent, leave it/);
    assert.match(noted.content[1].text, /wait_for_handover/);
  });

  it('adds nothing when the inbox is empty, the count is unknown, or reading it throws', () => {
    assert.deepEqual(withInboxNotice(result(), () => 0), result());
    assert.deepEqual(withInboxNotice(result(), undefined), result());
    assert.deepEqual(withInboxNotice(result(), () => { throw new Error('gone'); }), result());
  });

  it('leaves a failure as it is', () => {
    const failed = toStructuredError(new Error('boom'));
    assert.deepEqual(withInboxNotice(failed, () => 3), failed);
  });

  it('rides on every tool but the one that lists the inbox', async () => {
    const handlers: Record<string, Function> = {};
    const server = { registerTool: (name: string, _config: unknown, handler: Function) => { handlers[name] = handler; } };
    installToolEnvelope(server, { inboxWaiting: () => 1 });
    server.registerTool('list_tabs', {}, async () => result());
    server.registerTool('list_handovers', {}, async () => result());
    assert.equal((await handlers.list_tabs({}, {})).content.length, 2);
    assert.equal((await handlers.list_handovers({}, {})).content.length, 1);
  });
});
