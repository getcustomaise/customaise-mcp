/**
 * A consent wait reaches the MCP client as progress, and old error codes
 * are accepted on ingress.
 *
 * Progress: the extension's consent modal has a five-minute budget. Most
 * IDEs time a tool call out at sixty seconds. Before this, the bridge
 * extended its OWN timer on every `dispatch_tool_pending` frame and told the
 * client nothing, so a user who took ninety seconds to approve on their
 * phone approved into a void: the client had already reported the call
 * failed, the tool then ran, and the agent re-issued it. The spec's answer
 * is `notifications/progress` on requests that carried a `progressToken`;
 * clients that reset their timeout on progress (the SDK does, Claude Code
 * does) then wait with us. These pin that the frame becomes a notification
 * on both doors and that nothing is sent when the client did not ask.
 *
 * Codes: the 2026-07-28 revision reserved -32020..-32099 for itself, so
 * ours moved to -4002x. An extension built before the move still sends the
 * old numbers, and a leader built before it relays them; both are mapped on
 * ingress so a mixed fleet never shows two numbers for one condition.
 */

import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { installToolEnvelope } from '../tool-envelope.js';
import { currentRequestContext } from '../request-context.js';
import { ExtensionBridge } from '../extension-bridge.js';
import { RemoteBridge } from '../remote-bridge.js';
import {
  ERROR_CODE_CAP_EXCEEDED,
  ERROR_CODE_AUTH_REQUIRED,
  LEGACY_ERROR_CODES,
  normalizeErrorCode,
} from '../cap-state.js';

process.env.CUSTOMAISE_MCP_ALLOW_INSECURE = '1';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

async function until(predicate: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * A fake extension that greets with init_session and, for every dispatch,
 * first says "pending" and then acks. The pending frame is what a real
 * extension sends the moment a call blocks on the consent modal.
 */
function fakeExtension(port: number, ack: Record<string, unknown> = { success: true, result: [] }): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      origin: 'chrome-extension://anmpijcpaobaabcdncjjmnhdeibipmko',
    });
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'init_session', session_id: 's', install_id: 'i',
        tier: 'power_user', unlimited: true,
      }));
      resolve(ws);
    });
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type !== 'dispatch_tool') return;
      ws.send(JSON.stringify({
        type: 'dispatch_tool_pending', session_id: frame.session_id, seq_num: frame.seq_num,
        reason: 'awaiting_user_consent', expected_timeout_ms: 300_000,
      }));
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'dispatch_ack', session_id: frame.session_id, seq_num: frame.seq_num, counter: 1, ...ack }));
      }, 30);
    });
    ws.on('error', reject);
  });
}

describe('tool envelope turns a consent wait into notifications/progress', () => {
  function server() {
    const registered: Array<{ handler: Function }> = [];
    const s = { registerTool: mock.fn((_n: string, _c: unknown, handler: Function) => { registered.push({ handler }); }) };
    installToolEnvelope(s as any);
    return { s, registered };
  }

  it('emits one progress notification per pending frame when the client sent a progressToken', async () => {
    const { s, registered } = server();
    (s as any).registerTool('t', {}, async () => {
      // What the bridge does when the extension says the call is waiting.
      currentRequestContext().onPending?.({ expectedTimeoutMs: 300_000, reason: 'awaiting_user_consent' });
      currentRequestContext().onPending?.({ expectedTimeoutMs: 300_000, reason: 'awaiting_user_consent' });
      return { content: [] };
    });
    const notify = mock.fn(async (_n: unknown) => {});
    await registered[0].handler({}, { mcpReq: { _meta: { progressToken: 'tok-1' }, notify } });

    assert.equal(notify.mock.callCount(), 2);
    const first = notify.mock.calls[0].arguments[0] as any;
    assert.equal(first.method, 'notifications/progress');
    assert.equal(first.params.progressToken, 'tok-1');
    assert.equal(first.params.progress, 1);
    assert.match(first.params.message, /approve/);
    assert.equal((notify.mock.calls[1].arguments[0] as any).params.progress, 2);
  });

  it('sends nothing when the client did not ask for progress', async () => {
    const { s, registered } = server();
    let sawHook: boolean | null = null;
    (s as any).registerTool('t', {}, async () => {
      sawHook = currentRequestContext().onPending !== undefined;
      return { content: [] };
    });
    const notify = mock.fn(async (_n: unknown) => {});
    await registered[0].handler({}, { mcpReq: { _meta: {}, notify } });
    assert.equal(sawHook, false, 'no progressToken, no hook');
    assert.equal(notify.mock.callCount(), 0);
  });

  it('a notify that rejects does not fail the tool call', async () => {
    const { s, registered } = server();
    (s as any).registerTool('t', {}, async () => {
      currentRequestContext().onPending?.({ expectedTimeoutMs: 1000, reason: 'x' });
      return { content: [{ type: 'text', text: 'fine' }] };
    });
    const notify = mock.fn(async (_n: unknown) => { throw new Error('client went away'); });
    const out = await registered[0].handler({}, { mcpReq: { _meta: { progressToken: 7 }, notify } });
    assert.equal(out.content[0].text, 'fine');
  });
});

describe('the bridge relays dispatch_tool_pending to the caller on both doors', () => {
  const open: Array<{ close: () => unknown }> = [];
  afterEach(async () => { for (const o of open.splice(0)) { try { await o.close(); } catch { /* gone */ } } });

  it('leader: onPending fires with the extended budget', async () => {
    const port = await freePort();
    const leader = new ExtensionBridge(port, 5000);
    await leader.start();
    open.push(leader);
    const ext = await fakeExtension(port);
    open.push({ close: () => ext.terminate() });
    await until(() => leader.getSessionSnapshot().capMode === 'unlimited');

    const seen: Array<{ expectedTimeoutMs: number; reason: string }> = [];
    await leader.dispatchTool('list_tabs', {}, { onPending: (i) => seen.push(i) });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].reason, 'awaiting_user_consent');
    assert.ok(seen[0].expectedTimeoutMs >= 300_000, 'the budget the extension asked for');
  });

  it('follower: the res-pending relay reaches onPending too', async () => {
    const port = await freePort();
    const leader = new ExtensionBridge(port, 5000);
    await leader.start();
    open.push(leader);
    const ext = await fakeExtension(port);
    open.push({ close: () => ext.terminate() });
    await until(() => leader.getSessionSnapshot().capMode === 'unlimited');

    const follower = new RemoteBridge(port, 5000);
    await follower.start();
    open.push(follower);

    const seen: Array<{ expectedTimeoutMs: number; reason: string }> = [];
    await follower.dispatchTool('list_tabs', {}, { onPending: (i) => seen.push(i) });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].reason, 'awaiting_user_consent');
  });
});

describe('pre-3.2.0 error codes are accepted and mapped on ingress', () => {
  it('every legacy code maps to a code outside the JSON-RPC reserved range', () => {
    for (const [legacy, current] of Object.entries(LEGACY_ERROR_CODES)) {
      assert.ok(Number(legacy) >= -32099 && Number(legacy) <= -32000, `${legacy} was in the band`);
      assert.ok(current < -32768 || current > -32000, `${current} must be outside -32768..-32000`);
    }
    assert.equal(normalizeErrorCode(-32029), ERROR_CODE_CAP_EXCEEDED);
    assert.equal(normalizeErrorCode(ERROR_CODE_CAP_EXCEEDED), ERROR_CODE_CAP_EXCEEDED, 'current codes pass through');
    assert.equal(normalizeErrorCode(-1), -1, 'unknown codes pass through');
  });

  it('an old extension refusing with -32028 surfaces as the current auth code', async () => {
    const open: Array<{ close: () => unknown }> = [];
    try {
      const port = await freePort();
      const leader = new ExtensionBridge(port, 5000);
      await leader.start();
      open.push(leader);
      const ext = await fakeExtension(port, {
        success: false, error: 'Sign in first', error_code: -32028, error_data: { type: 'auth_required' },
      });
      open.push({ close: () => ext.terminate() });
      await until(() => leader.getSessionSnapshot().capMode === 'unlimited');

      await assert.rejects(
        () => leader.dispatchTool('list_tabs', {}),
        (err: any) => {
          assert.equal(err.code, ERROR_CODE_AUTH_REQUIRED);
          assert.equal(err.data?.type, 'auth_required');
          return true;
        },
      );
    } finally {
      for (const o of open) { try { await o.close(); } catch { /* gone */ } }
    }
  });
});
