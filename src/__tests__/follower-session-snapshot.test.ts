/**
 * A follower that attaches AFTER the extension must still learn the session.
 *
 * `doctor` reports tier, sign-in, remote approvals and cap headroom from state
 * the server already holds, so it costs no cap unit. A follower has no
 * CapSession of its own, so the leader relays its snapshot on the `status`
 * frame it already sends.
 *
 * Two code paths receive that frame: the connect handshake and the ongoing
 * frame router. The field was added to the router only. The handshake read
 * `extensionConnected` and returned, swallowing the one frame that carries the
 * session, and re-broadcasts only follow an init_session or a connect. For a
 * follower attaching to an already-running leader neither happens again, so
 * every field read `unknown` for the life of the process.
 *
 * That is the same asymmetry the router's own comments warn about elsewhere:
 * a field on one path and not the other shows up as state that is never set,
 * or set once and then reverts.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocket } from 'ws';
import { ExtensionBridge } from '../extension-bridge.js';
import { RemoteBridge } from '../remote-bridge.js';

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

async function until(p: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!p()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A fake extension that announces a session and then stays quiet. */
async function attachExtension(port: number, session: Record<string, unknown>): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'init_session', session_id: 's1', install_id: 'i1', ...session }));
  return ws;
}

describe('a follower learns the session however late it attaches', () => {
  const open: Array<{ close: () => Promise<void> | void }> = [];
  after(async () => { for (const b of open) { try { await b.close(); } catch { /* gone */ } } });

  it('picks it up from the connect-time frame, not only from re-broadcasts', async () => {
    const port = await freePort();
    const leader = new ExtensionBridge(port);
    await leader.start();
    open.push(leader);

    // Extension first, and its init_session lands BEFORE any follower exists.
    // This is the ordering that was permanently broken: the follower's only
    // status frame is the connect-time one.
    const ext = await attachExtension(port, {
      tier: 'power_user', unlimited: true, remote_approvals: true, authenticated: true,
    });
    open.push({ close: () => ext.close() });
    await until(() => leader.getSessionSnapshot().tier === 'power_user');

    const follower = new RemoteBridge(port);
    await follower.start();
    open.push(follower);

    await until(() => follower.getSessionSnapshot().tier !== null);
    const snap = follower.getSessionSnapshot();
    assert.equal(snap.tier, 'power_user');
    assert.equal(snap.authenticated, true);
    assert.equal(snap.remoteApprovals, true);
    assert.equal(snap.capMode, 'unlimited');
  });

  it('relays the leader version, which is the only skew signal the seam has', async () => {
    // The leader/follower relay has no version negotiation: the IDE owns the
    // leader's lifetime and `npx -y` resolves `latest` per spawn, so every
    // rollout mixes builds for hours by design (ARD 4.1). The frames are
    // additive JSON and tolerate the skew — this field is what makes the
    // skew VISIBLE in `doctor` when a future frame change meets an old
    // leader. Same version here since both roles load one package.json, so
    // the assertion is that the field ARRIVES relayed, not defaulted.
    const port = await freePort();
    const leader = new ExtensionBridge(port);
    await leader.start();
    open.push(leader);

    const follower = new RemoteBridge(port);
    await follower.start();
    open.push(follower);

    await until(() => follower.getSessionSnapshot().leaderVersion !== null);
    const relayed = follower.getSessionSnapshot().leaderVersion;
    assert.equal(relayed, leader.getSessionSnapshot().leaderVersion);
    assert.match(String(relayed), /^\d+\.\d+\.\d+/);
  });

  it('warns exactly once when the relayed version is not its own', () => {
    // Source pin rather than a live two-build harness: producing a real
    // mixed-version pair would need two installs of the package. The
    // property that matters is cheap to pin — the comparison exists, it
    // writes to stderr (stdout is the JSON contract), and it latches so a
    // re-broadcast storm cannot spam the terminal.
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6 && !existsSync(join(dir, 'src', 'remote-bridge.ts')); i++) dir = dirname(dir);
    const src = readFileSync(join(dir, 'src', 'remote-bridge.ts'), 'utf-8');
    const body = src.slice(src.indexOf('_applyStatusFrame'), src.indexOf('getSystemStatus'));
    assert.match(body, /leaderVersion/, 'the skew comparison is gone');
    assert.match(body, /!== OWN_VERSION/, 'the comparison no longer checks against our own version');
    assert.match(body, /_warnedLeaderSkew/, 'the warning no longer latches; a status re-broadcast would spam it');
    assert.match(body, /process\.stderr\.write/, 'the warning left stderr');
  });

  it('reports counters for a capped session and nothing for an unlimited one', async () => {
    // Zeros on an unlimited session would read as "no usage left to report"
    // rather than "not applicable", which is a different claim.
    const port = await freePort();
    const leader = new ExtensionBridge(port);
    await leader.start();
    open.push(leader);

    const ext = await attachExtension(port, {
      tier: 'free', daily_cap: 50, weekly_cap: 150,
      current_used_daily: 7, current_used_week: 9,
      remote_approvals: false, authenticated: true,
    });
    open.push({ close: () => ext.close() });
    await until(() => leader.getSessionSnapshot().capMode === 'capped');

    const snap = leader.getSessionSnapshot();
    assert.equal(snap.dailyUsed, 7);
    assert.equal(snap.dailyCap, 50);
    assert.equal(snap.weeklyUsed, 9);
    assert.equal(snap.remoteApprovals, false);
  });

  it('says unknown before anything has told it, rather than inventing false', async () => {
    const port = await freePort();
    const leader = new ExtensionBridge(port);
    await leader.start();
    open.push(leader);

    const snap = leader.getSessionSnapshot();
    assert.equal(snap.tier, null);
    assert.equal(snap.authenticated, null);
    assert.equal(snap.remoteApprovals, null);
  });
});
