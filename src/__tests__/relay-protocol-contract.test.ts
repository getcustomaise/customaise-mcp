/**
 * The leader/follower relay contract, exercised from both sides.
 *
 * This seam shipped designed without version negotiation while the
 * codebase's other two seams both had one (extension-to-server hello,
 * CLI-to-daemon equality-and-restart). The fix went in before 3.0.0
 * published, which is the only moment it was free: no fleet exists yet, so
 * requiring the hello breaks nobody.
 *
 * The contract, from RELAY_PROTOCOL_VERSION's JSDoc: the OLDER side rejects
 * in each direction, because only it can — the newer side cannot know rules
 * that had not been written when the older one shipped. Concretely:
 *
 *   - a leader evicts (close 4001) a follower whose hello disagrees
 *   - a follower refuses to dispatch through a leader whose status frame
 *     disagrees or lacks the field entirely, with a typed error that names
 *     both versions and which process to restart
 *   - a compatible leader winning the port heals the follower without a
 *     restart, because reconnect keeps running and the state clears on a
 *     matching handshake
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { ExtensionBridge, FOLLOWER_ORIGIN } from '../extension-bridge.js';
import { RemoteBridge } from '../remote-bridge.js';
import { RELAY_PROTOCOL_VERSION } from '../bridge.js';
import { ERROR_CODE_RELAY_PROTOCOL_MISMATCH } from '../cap-state.js';

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

async function until(predicate: () => boolean, label: string, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for: ' + label);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const open: Array<{ close: () => unknown }> = [];
after(() => { for (const o of open) { try { o.close(); } catch { /* teardown */ } } });

describe('relay protocol contract', () => {
  it('a follower refuses to dispatch through a pre-contract leader', async () => {
    // The one frame an old leader still sends is a status frame with no
    // `relayProtocol`. Everything after it has undefined semantics, so the
    // follower must fail closed with an error that says what to restart —
    // not wait out a timeout and report something generic.
    const port = await freePort();
    const oldLeader = new WebSocketServer({ port, host: '127.0.0.1' });
    open.push(oldLeader);
    oldLeader.on('connection', (ws) => {
      ws.send(JSON.stringify({ role: 'status', extensionConnected: true }));
    });

    const follower = new RemoteBridge(port);
    await follower.start();
    open.push(follower);

    await assert.rejects(
      () => follower.request('list_tabs', {}),
      (err: any) => {
        assert.equal(err?.data?.type, 'relay_protocol_mismatch');
        assert.equal(err?.code, ERROR_CODE_RELAY_PROTOCOL_MISMATCH);
        assert.match(err?.message, /Restart the older/);
        return true;
      },
    );
  });

  it('a leader evicts a follower from a different contract, naming both versions', async () => {
    const port = await freePort();
    const leader = new ExtensionBridge(port);
    await leader.start();
    open.push(leader);

    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: FOLLOWER_ORIGIN });
    let closeCode = 0;
    let closeReason = '';
    const closed = new Promise<void>((resolve) => {
      ws.on('close', (code, reason) => { closeCode = code; closeReason = reason.toString(); resolve(); });
    });
    ws.on('open', () => {
      // An OLDER package on a different contract. A newer one is yielded to
      // rather than evicted (leader-election.test.ts), because the newer
      // process can always evict us and its message points at a process that
      // can actually be restarted; ours would point at an immortal daemon.
      ws.send(JSON.stringify({ role: 'follower-hello', relayProtocol: 999, version: '0.0.1' }));
    });
    // Bounded, so a leader that NOTICES the mismatch but no longer evicts
    // fails this test in three seconds instead of hanging the whole suite —
    // which is exactly what the first mutant of this gate did.
    const evicted = await Promise.race([
      closed.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
    ]);
    try { ws.close(); } catch { /* may already be closed */ }
    assert.equal(evicted, true, 'leader accepted a follower from a different relay contract');

    assert.equal(closeCode, 4001);
    assert.match(closeReason, /relay_protocol_mismatch/);
    assert.match(closeReason, new RegExp(`leader speaks ${RELAY_PROTOCOL_VERSION}`));
    assert.match(closeReason, /follower speaks 999/);
  });

  it('a matching handshake heals the mismatch without a restart', async () => {
    // The mismatched leader dying and a compatible one winning the port is
    // the designed recovery. The follower keeps reconnecting on its capped
    // backoff, so the state must clear the moment a matching status frame
    // arrives — a latched mismatch would demand a restart the design
    // promises nobody needs.
    const port = await freePort();
    const fake = new WebSocketServer({ port, host: '127.0.0.1' });
    fake.on('connection', (ws) => {
      // First act like an old leader…
      ws.send(JSON.stringify({ role: 'status', extensionConnected: true }));
      // …then like an upgraded one on the same socket. Real recovery is a
      // process swap, but the state transition under test is identical.
      setTimeout(() => {
        ws.send(JSON.stringify({
          role: 'status', relayProtocol: RELAY_PROTOCOL_VERSION, extensionConnected: true,
          session: {
            extensionConnected: true, systemStatus: null, tier: 'free', authenticated: true,
            remoteApprovals: false, capMode: 'per_tool', dailyUsed: 0, dailyCap: 50,
            weeklyUsed: 0, weeklyCap: 150, leaderVersion: '9.9.9',
          },
        }));
      }, 60);
      // Answer the proof-of-life request so the healed path completes.
      ws.on('message', (data) => {
        const f = JSON.parse(data.toString());
        if (f.role === 'req') {
          ws.send(JSON.stringify({ role: 'res', id: f.id, success: true, result: { healed: true } }));
        }
      });
    });
    open.push(fake);

    const follower = new RemoteBridge(port);
    await follower.start();
    open.push(follower);

    await assert.rejects(() => follower.request('ping', {}),
      (err: any) => err?.data?.type === 'relay_protocol_mismatch');

    await until(() => follower.getSessionSnapshot().tier === 'free', 'the healing frame');
    const result = await follower.request('ping', {}) as { healed: boolean };
    assert.equal(result.healed, true);
  });

  it('a same-build pair interops, which is what the integer protects', async () => {
    // The gate must never trip on the SUPPORTED skew: package versions may
    // differ across a rollout while frame shapes do not, and that fleet is
    // a designed consequence of unpinned npx (ARD 4.1). Both roles here load
    // one package.json, so this pins the same-protocol path stays open.
    const port = await freePort();
    const leader = new ExtensionBridge(port);
    await leader.start();
    open.push(leader);

    const follower = new RemoteBridge(port);
    await follower.start();
    open.push(follower);

    await until(() => follower.getSessionSnapshot().leaderVersion !== null, 'handshake');
    await assert.rejects(() => follower.request('list_tabs', {}),
      (err: any) => {
        // extension_not_connected, NOT a protocol mismatch: the contract
        // passed and the failure is the ordinary no-Chrome one.
        assert.equal(err?.data?.type, 'extension_not_connected');
        return true;
      });
  });
});
