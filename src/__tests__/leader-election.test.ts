/**
 * Leadership of the port is re-elected, never assigned once.
 *
 * Two prior versions of this recovery story were wrong in the same way. The
 * first claimed a follower would "promote self to leader" and had no bind
 * anywhere in the file. The second added a reconnect loop and argued that
 * promotion was unnecessary because "if NO leader ever comes back there is
 * nothing to talk to anyway". But the leader that dies is often the ONLY
 * other process (an IDE restarting, a CLI daemon idle-exiting, Claude
 * Desktop reaping the disposable copy it spawned to probe the protocol), and
 * a follower that only dials leaves :4050 empty for the extension too. The
 * process lived on as an orphan and the user saw MCP "randomly disconnect".
 *
 * These cases go through `createBridge`, the door production uses, because
 * the promotion is a property of the `ElectingBridge` it returns and not of
 * either inner class. They are the orderings the ARD asked for and never
 * got: leader dies and nobody replaces it; leader dies and several followers
 * race for the seat; leader dies and a new leader appears at the same time;
 * and a deliberate close, which must not resurrect anything.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection, createServer } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { createBridge, RELAY_PROTOCOL_VERSION, STEP_DOWN_CLOSE_CODE, STEP_DOWN_YIELD_MS, type Bridge } from '../bridge.js';
import { ExtensionBridge, FOLLOWER_ORIGIN } from '../extension-bridge.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ERROR_CODE_RELAY_PROTOCOL_MISMATCH } from '../cap-state.js';

process.env.CUSTOMAISE_MCP_ALLOW_INSECURE = '1';

/** This package's own version, the way the bridges read it. */
const OWN_VERSION: string = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')).version; } catch { dir = dirname(dir); }
  }
  throw new Error('could not locate package.json');
})();

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

/**
 * Whether something answers on the port: a connect, as the extension does.
 * Not a trial bind — the bridge listens on `::`, and macOS lets an explicit
 * `127.0.0.1` bind coexist with that, so a trial bind reports a held port
 * as free.
 */
function portIsHeld(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection(port, '127.0.0.1');
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
}

/** The `data.type` a bridge call rejected with, or null if it resolved. */
async function errorTypeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return (err as { data?: { type?: string } })?.data?.type ?? 'untyped';
  }
}

/**
 * Connect as a fake Chrome extension, listener attached before 'open' so the
 * leader's connection-time hello is never missed.
 */
function connectExtension(port: number): Promise<WebSocket & { received: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`, {
      origin: 'chrome-extension://anmpijcpaobaabcdncjjmnhdeibipmko',
    }) as WebSocket & { received: any[] };
    ws.received = [];
    ws.on('message', (data) => {
      try { ws.received.push(JSON.parse(data.toString())); } catch { /* ignore */ }
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function until(predicate: () => Promise<boolean> | boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('leadership is re-elected when the leader goes away', () => {
  const open: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    for (const b of open.splice(0)) { try { await b.close(); } catch { /* gone */ } }
  });

  it('a follower promotes itself when nobody else takes the port', async () => {
    const port = await freePort();
    const leader = new ExtensionBridge(port);
    await leader.start();

    const follower = await createBridge(port, 1000);
    open.push(follower);
    assert.equal(follower.role, 'follower');
    assert.equal(
      await errorTypeOf(() => follower.request('list_tabs')),
      'extension_not_connected',
      'a healthy follower reports the extension missing, not the leader',
    );

    // The leader goes away and nothing replaces it: the IDE restart, the
    // daemon idle-exit, the reaped probe sibling.
    await leader.close();

    await until(() => follower.role === 'leader');
    // Holding the seat, not merely claiming it: the extension has a door.
    assert.equal(await portIsHeld(port), true, 'the promoted follower must be listening');
    assert.equal(
      await errorTypeOf(() => follower.request('list_tabs')),
      'extension_not_connected',
      'the promoted process answers as a leader with no Chrome behind it',
    );
  });

  it('several followers losing one leader converge on exactly one leader', async () => {
    const port = await freePort();
    const leader = new ExtensionBridge(port);
    await leader.start();

    const a = await createBridge(port, 1000);
    const b = await createBridge(port, 1000);
    open.push(a, b);
    assert.deepEqual([a.role, b.role], ['follower', 'follower']);

    await leader.close();

    // The bind is the arbiter: one wins, the other rejoins it. Which is
    // which is not the invariant; that there is one of each is.
    await until(() => [a.role, b.role].sort().join() === 'follower,leader');
    const follower = a.role === 'follower' ? a : b;
    await until(async () =>
      (await errorTypeOf(() => follower.request('list_tabs'))) === 'extension_not_connected');
  });

  it('a leader that appears during the election is joined, not fought', async () => {
    const port = await freePort();
    const leaderA = new ExtensionBridge(port);
    await leaderA.start();

    const follower = await createBridge(port, 1000);
    open.push(follower);

    // The restarted IDE takes the port back as the follower is re-electing.
    // Either can win the bind; the seat must end up held exactly once.
    await leaderA.close();
    const leaderB = new ExtensionBridge(port);
    let leaderBHoldsPort = true;
    try {
      await leaderB.start();
      open.push(leaderB);
    } catch (err: any) {
      assert.equal(err?.code, 'EADDRINUSE');
      leaderBHoldsPort = false;
    }

    if (leaderBHoldsPort) {
      await until(() => follower.role === 'follower');
      await until(async () =>
        (await errorTypeOf(() => follower.request('list_tabs'))) === 'extension_not_connected');
    } else {
      await until(() => follower.role === 'leader');
    }
    assert.equal(await portIsHeld(port), true);
  });

  it('the push handler and client identity survive a promotion', async () => {
    const port = await freePort();
    const leader = new ExtensionBridge(port);
    await leader.start();

    const follower = await createBridge(port, 1000);
    open.push(follower);
    // Registered ONCE, against the bridge the server holds, before anything
    // underneath it changes. server.ts and build-server.ts do exactly this.
    const received: Array<{ type: string; data: any }> = [];
    follower.onPush((type, data) => received.push({ type, data }));
    follower.setOwnClientInfo({ name: 'test-ide', version: '1.0.0' });

    await leader.close();
    await until(() => follower.role === 'leader');

    // The extension reconnects to whoever holds the port, as it does in
    // production after its five-second retry.
    const ext = await connectExtension(port);
    open.push({ close: async () => { ext.terminate(); } });

    // The promoted leader introduces this process by the identity registered
    // before promotion, and routes the extension's pushes to the handler
    // registered before promotion.
    await until(() => ext.received.some((f) => JSON.stringify(f).includes('test-ide')));
    ext.send(JSON.stringify({ type: 'dom_selections_changed', data: { count: 3 } }));
    await until(() => received.length === 1);
    assert.equal(received[0].type, 'dom_selections_changed');
  });

  it('an eviction over the relay contract fails dispatches at once, with the reason', async () => {
    // The leader greets a follower BEFORE validating its hello, so an
    // eviction lands as a lost leader after `start()` has already resolved.
    // The election then loses the bind (the evicting leader is alive) and is
    // evicted again, forever. A dispatch must not wait out that loop and
    // report something generic; the leader wrote the sentence that says what
    // to restart, and the previous reconnect loop surfaced it. So must this.
    const port = await freePort();
    const evictor = new WebSocketServer({ port });
    await new Promise((r) => evictor.on('listening', r));
    open.push({ close: () => new Promise<void>((r) => { for (const c of evictor.clients) c.terminate(); evictor.close(() => r()); }) });
    let connections = 0;
    evictor.on('connection', (ws) => {
      connections++;
      ws.send(JSON.stringify({ role: 'status', relayProtocol: 1, extensionConnected: false }));
      ws.on('message', () => ws.close(4001, 'relay_protocol_mismatch: leader speaks 999, follower speaks 1. Restart the older of the two.'));
    });

    const follower = await createBridge(port, 1000);
    open.push(follower);

    await until(async () => {
      try { await follower.request('list_tabs'); return false; } catch (err: any) {
        return err?.data?.type === 'relay_protocol_mismatch';
      }
    });
    const started = Date.now();
    await assert.rejects(
      () => follower.request('list_tabs'),
      (err: any) => {
        assert.equal(err?.code, ERROR_CODE_RELAY_PROTOCOL_MISMATCH);
        assert.match(err?.message, /Restart the older/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 500, 'must fail at once, not wait out the election');
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(connections, 1, 'successful status handshake followed by eviction must not reset reconnect backoff');

    // The mismatched leader dying and a compatible one winning the port is
    // the normal recovery, and it must clear the verdict.
    await open.shift()!.close();
    await until(async () =>
      (await errorTypeOf(() => follower.request('list_tabs'))) === 'extension_not_connected', 7000);
    assert.equal(follower.role, 'leader');
  });

  it('a deliberately closed bridge does not resurrect itself', async () => {
    const port = await freePort();
    const leader = new ExtensionBridge(port);
    await leader.start();

    const follower = await createBridge(port, 1000);
    await follower.close();
    await leader.close();

    // Give the election backoff several windows to misbehave in.
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(follower.role, 'follower', 'a closed follower must not promote');
    assert.equal(await portIsHeld(port), false, 'a closed follower must not bind');
  });

  it('a leader steps down for a strictly newer follower, and retakes the port if nobody does', async () => {
    const port = await freePort();
    const bridge = await createBridge(port, 1000);
    open.push(bridge);
    assert.equal(bridge.role, 'leader');

    // A follower from the future. It never binds, which pins the other half
    // of the contract: stepping down must not leave the seat empty.
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: FOLLOWER_ORIGIN });
    const closed = new Promise<{ code: number; reason: string }>((r) =>
      ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
    ws.on('open', () => { ws.send(JSON.stringify({ role: 'follower-hello', relayProtocol: RELAY_PROTOCOL_VERSION, version: '99.0.0' })); ws.send(JSON.stringify({ role: 'client-info', name: 'newer-ide', version: '1.0.0' })); });

    const c = await closed;
    assert.equal(c.code, STEP_DOWN_CLOSE_CODE, 'followers are told this is a step-down, not a shutdown');
    assert.match(c.reason, /stepping_down for 99\.0\.0/);

    // The port is genuinely released, then retaken after the grace.
    await until(async () => !(await portIsHeld(port)), 3_000);
    await until(async () => portIsHeld(port));
    assert.equal(bridge.role, 'leader');
    assert.equal(
      await errorTypeOf(() => bridge.request('list_tabs')),
      'extension_not_connected',
      'back in the seat and answering',
    );
  });

  it('an older or equal follower does not make the leader step down', async () => {
    const port = await freePort();
    const bridge = await createBridge(port, 1000);
    open.push(bridge);

    for (const version of ['0.0.1', OWN_VERSION, OWN_VERSION + '-rc.1']) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: FOLLOWER_ORIGIN });
      await new Promise<void>((r) => ws.on('open', () => r()));
      ws.send(JSON.stringify({ role: 'follower-hello', relayProtocol: RELAY_PROTOCOL_VERSION, version }));
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(ws.readyState, WebSocket.OPEN, `follower ${version} must not be evicted`);
      assert.equal(await portIsHeld(port), true, `the leader must keep the port for ${version}`);
      ws.terminate();
    }
  });

  it('a follower told to yield lets the announced version bind first', async () => {
    // Two runs of the same shape. The leader steps down naming a version:
    // once a stranger (we must hold back), once ourselves (we race at once).
    // The difference in how fast we take the port is the yield.
    async function stepDownAndMeasure(announced: string): Promise<number> {
      const port = await freePort();
      const leader = new WebSocketServer({ port });
      await new Promise((r) => leader.on('listening', r));
      let closedAt = 0;
      leader.on('connection', (ws) => {
        ws.send(JSON.stringify({ role: 'status', relayProtocol: RELAY_PROTOCOL_VERSION, extensionConnected: false }));
        setTimeout(() => {
          closedAt = Date.now();
          ws.close(STEP_DOWN_CLOSE_CODE, `stepping_down for ${announced}: a newer customaise-mcp is taking the port`);
          leader.close();
        }, 100);
      });
      const follower = await createBridge(port, 1000);
      open.push(follower);
      await until(async () => closedAt > 0 && (await portIsHeld(port)) && follower.role === 'leader');
      return Date.now() - closedAt;
    }

    const yielded = await stepDownAndMeasure('99.0.0');
    const raced = await stepDownAndMeasure(OWN_VERSION);
    assert.ok(yielded >= STEP_DOWN_YIELD_MS - 50, `expected to hold back ~${STEP_DOWN_YIELD_MS}ms, took ${yielded}ms`);
    // Relative, not absolute: how fast the OS frees a port is the same in
    // both runs, so the yield is the difference between them.
    assert.ok(yielded - raced >= STEP_DOWN_YIELD_MS / 2,
      `yielding (${yielded}ms) should be clearly slower than racing (${raced}ms)`);
  });

  it('a newer package on a different relay protocol is yielded to, not evicted', async () => {
    // The relay-mismatch eviction says "restart the older of the two". When
    // the older one is this leader, and it is a daemon that never exits,
    // that advice is a dead end. So a newer package wins the port first and
    // does any evicting from there, where "the older" is a process that
    // can actually go.
    const port = await freePort();
    const bridge = await createBridge(port, 1000);
    open.push(bridge);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: FOLLOWER_ORIGIN });
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    ws.on('open', () => { ws.send(JSON.stringify({ role: 'follower-hello', relayProtocol: 999, version: '99.0.0' })); ws.send(JSON.stringify({ role: 'client-info', name: 'newer-ide', version: '1.0.0' })); });
    assert.equal(await closed, STEP_DOWN_CLOSE_CODE, 'stepped down (4002), not evicted (4001)');
    await until(async () => portIsHeld(port));
  });

  it('a call in flight during a step-down is told to retry, not to reconnect MCP', async () => {
    // close() used to run only at process exit, where nobody reads the
    // error. A step-down closes a live leader with an agent mid-call, and
    // the old message sent that agent to Settings to reconnect a bridge
    // that will be back in under a second.
    const port = await freePort();
    const bridge = await createBridge(port, 5000);
    open.push(bridge);
    const ext = await connectExtension(port);
    open.push({ close: async () => { ext.terminate(); } });
    ext.send(JSON.stringify({ type: 'init_session', session_id: 's', install_id: 'i', tier: 'power_user', unlimited: true }));
    await until(() => bridge.getSessionSnapshot().capMode === 'unlimited');

    // Never acked: it is still in flight when the newer follower arrives.
    const inFlight = bridge.dispatchTool('list_tabs', {});
    inFlight.catch(() => {});
    await until(() => ext.received.some((f) => f.type === 'dispatch_tool'));

    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: FOLLOWER_ORIGIN });
    ws.on('open', () => { ws.send(JSON.stringify({ role: 'follower-hello', relayProtocol: RELAY_PROTOCOL_VERSION, version: '99.0.0' })); ws.send(JSON.stringify({ role: 'client-info', name: 'newer-ide', version: '1.0.0' })); });
    open.push({ close: async () => { ws.terminate(); } });

    await assert.rejects(inFlight, (err: any) => {
      assert.equal(err?.data?.type, 'dispatch_timeout', 'typed, so the CLI exits 3 and an agent retries');
      assert.equal(err?.data?.reason, 'stepping_down');
      assert.match(err?.message, /retry/i);
      assert.doesNotMatch(err?.message, /Settings/, 'must not send the user to reconnect a bridge that is coming straight back');
      return true;
    });

    // And the extension was told to close the modal that call was waiting
    // on, before the socket went, while it still held the consent entry.
    // The rejection above fires inside close(), before the frame has
    // crossed the socket, so wait for it rather than look for it.
    await until(() => ext.received.some((f) => f.type === 'cancel_dispatch'), 2_000)
      .catch(() => { /* asserted below with a message */ });
    const dispatch = ext.received.find((f) => f.type === 'dispatch_tool');
    const cancel = ext.received.find((f) => f.type === 'cancel_dispatch');
    assert.ok(cancel, 'no cancel_dispatch: the consent modal would stay open for five minutes');
    assert.equal(cancel.seq_num, dispatch.seq_num);
    assert.equal(cancel.session_id, dispatch.session_id);
    assert.ok(ext.received.indexOf(cancel) > ext.received.indexOf(dispatch));
  });

  it('a version string too long for a close reason still reaches the follower as a step-down', async () => {
    // ws throws RangeError for a close reason over 123 bytes. The throw was
    // swallowed, so that follower's socket was never closed: it never got
    // its 4002, never re-elected, and sat wedged on a leader whose listener
    // had already gone. Any local process could send this hello. The
    // version is now sliced at ingress and the reason capped, and close()
    // terminates whatever a graceful close could not reach.
    const port = await freePort();
    const bridge = await createBridge(port, 1000);
    open.push(bridge);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: FOLLOWER_ORIGIN });
    const closed = new Promise<{ code: number; reason: string }>((r) =>
      ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
    ws.on('open', () => {
      ws.send(JSON.stringify({
        role: 'follower-hello', relayProtocol: RELAY_PROTOCOL_VERSION, version: '99.0.0' + 'x'.repeat(300),
      }));
      ws.send(JSON.stringify({ role: 'client-info', name: 'newer-ide', version: '1.0.0' }));
    });
    open.push({ close: async () => { ws.terminate(); } });

    const c = await Promise.race([
      closed,
      new Promise<null>((r) => setTimeout(() => r(null), 3_000)),
    ]);
    assert.ok(c, 'the follower was never closed: it would stay wedged on a dead leader');
    assert.equal(c!.code, STEP_DOWN_CLOSE_CODE);
    assert.ok(Buffer.byteLength(c!.reason) <= 123, 'reason within the protocol cap');
    await until(async () => portIsHeld(port), 5_000);
  });

  it('a hand-over that succeeded can be repeated at once; only a failed one is rate-limited', async () => {
    // Round one: the newer process takes the port, we rejoin behind it.
    // Then it goes away (its IDE restarted), we win the bind, and it comes
    // back with the same hello. The cooldown exists for a newer process
    // that COULD NOT bind; this one could, and must be yielded to again.
    const port = await freePort();
    const bridge = await createBridge(port, 1000);
    open.push(bridge);

    const hello = (): Promise<WebSocket> => new Promise((r) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: FOLLOWER_ORIGIN });
      ws.on('open', () => { ws.send(JSON.stringify({ role: 'follower-hello', relayProtocol: RELAY_PROTOCOL_VERSION, version: '99.0.0' })); ws.send(JSON.stringify({ role: 'client-info', name: 'newer-ide', version: '1.0.0' })); r(ws); });
    });

    // Round one: as soon as we release the port, "the newer process" binds it.
    const first = await hello();
    await new Promise<void>((r) => first.on('close', () => r()));
    await until(async () => !(await portIsHeld(port)), 3_000);
    const newer = new WebSocketServer({ port });
    await new Promise((r) => newer.on('listening', r));
    newer.on('connection', (ws) => ws.send(JSON.stringify({ role: 'status', relayProtocol: RELAY_PROTOCOL_VERSION, extensionConnected: false })));
    await until(() => bridge.role === 'follower');

    // The newer process goes away; we win the bind again.
    for (const c of newer.clients) c.terminate();
    await new Promise<void>((r) => newer.close(() => r()));
    await until(() => bridge.role === 'leader');
    await until(async () => portIsHeld(port));

    // It comes back with the same hello, well inside the cooldown window.
    const second = await hello();
    const closed = await Promise.race([
      new Promise<number>((r) => second.on('close', (code) => r(code))),
      new Promise<null>((r) => setTimeout(() => r(null), 2_000)),
    ]);
    assert.equal(closed, STEP_DOWN_CLOSE_CODE, 'a successful hand-over must be honoured again, not rate-limited');
    await until(async () => portIsHeld(port), 5_000);
  });

  it('a follower that never identifies itself cannot move the port', async () => {
    // Claude Desktop's disposable probe copy of this server connects, says
    // hello, and is reaped without ever sending client-info. Yielding to it
    // handed the port over twice per Desktop update. The same rule means a
    // socket that only ever says hello, from any local process, cannot
    // trigger a step-down at all.
    const port = await freePort();
    const bridge = await createBridge(port, 1000);
    open.push(bridge);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: FOLLOWER_ORIGIN });
    await new Promise<void>((r) => ws.on('open', () => r()));
    ws.send(JSON.stringify({ role: 'follower-hello', relayProtocol: RELAY_PROTOCOL_VERSION, version: '99.0.0' }));
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(ws.readyState, WebSocket.OPEN, 'hello alone must not be answered with a step-down');
    assert.equal(await portIsHeld(port), true);
    assert.equal(bridge.role, 'leader');
    ws.terminate();
  });

  it('does not step down twice for the same version within the cooldown', async () => {
    // The newer follower could not bind (here: it never tries). Without a
    // cooldown the leader would step down every time it reattaches, and
    // the extension would spend more time disconnected than not.
    const port = await freePort();
    const bridge = await createBridge(port, 1000);
    open.push(bridge);

    const hello = (): Promise<WebSocket> => new Promise((r) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: FOLLOWER_ORIGIN });
      ws.on('open', () => { ws.send(JSON.stringify({ role: 'follower-hello', relayProtocol: RELAY_PROTOCOL_VERSION, version: '99.0.0' })); ws.send(JSON.stringify({ role: 'client-info', name: 'newer-ide', version: '1.0.0' })); r(ws); });
    });

    const first = await hello();
    await new Promise<void>((r) => first.on('close', () => r()));
    await until(async () => portIsHeld(port));

    const second = await hello();
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(second.readyState, WebSocket.OPEN, 'the second hello must not trigger another step-down');
    assert.equal(await portIsHeld(port), true);
    second.terminate();
  });
});
