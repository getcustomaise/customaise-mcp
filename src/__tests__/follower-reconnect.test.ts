/**
 * A follower whose leader dies must reattach to the one that replaces it.
 *
 * It did not. The module docstring claimed `request()` would "attempt to
 * promote self to leader", but no bind, listen or reconnect existed anywhere
 * in the file: a follower whose leader went away stayed dead for the life of
 * the process. Restarting an IDE therefore bricked the resident CLI daemon,
 * every command returning exit 3, until someone ran `customaise daemon stop`.
 * Found by restarting an IDE during real testing, not by reading the code,
 * because the comment described the behaviour anyone reviewing it wanted.
 *
 * The discriminator is the error type, which is exact here:
 *   detached  -> `leader_unreachable`     (no socket to the leader)
 *   attached  -> `extension_not_connected` (leader reached, no Chrome behind it)
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { ExtensionBridge } from '../extension-bridge.js';
import { RemoteBridge } from '../remote-bridge.js';

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

/** The `data.type` a bridge call rejected with, or null if it resolved. */
async function errorTypeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return (err as { data?: { type?: string } })?.data?.type ?? 'untyped';
  }
}

async function until(predicate: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('a follower survives its leader being replaced', () => {
  const open: Array<{ close: () => Promise<void> }> = [];
  after(async () => { for (const b of open) { try { await b.close(); } catch { /* best effort */ } } });

  it('reattaches to the new leader on the same port', async () => {
    const port = await freePort();

    const leaderA = new ExtensionBridge(port);
    await leaderA.start();
    open.push(leaderA);

    const follower = new RemoteBridge(port);
    await follower.start();
    open.push(follower);

    // Attached, but no Chrome behind the leader.
    assert.equal(
      await errorTypeOf(() => follower.request('list_tabs')),
      'extension_not_connected',
      'a healthy follower reports the extension missing, not the leader',
    );

    // The leader goes away, as it does when an IDE restarts.
    await leaderA.close();
    await until(async () =>
      (await errorTypeOf(() => follower.request('list_tabs'))) === 'leader_unreachable');

    // Another process takes the port, as the restarted IDE does.
    const leaderB = new ExtensionBridge(port);
    await leaderB.start();
    open.push(leaderB);

    // The whole point: recovery with no restart and no intervention.
    await until(async () =>
      (await errorTypeOf(() => follower.request('list_tabs'))) === 'extension_not_connected');
  });

  it('stops trying once deliberately closed', async () => {
    const port = await freePort();
    const leader = new ExtensionBridge(port);
    await leader.start();

    const follower = new RemoteBridge(port);
    await follower.start();

    await follower.close();
    await leader.close();

    // A closed follower must not resurrect itself. Give the backoff several
    // windows to misbehave in before believing it.
    await new Promise((r) => setTimeout(r, 1200));
    const type = await errorTypeOf(() => follower.request('list_tabs'));
    assert.ok(type !== 'extension_not_connected', 'a closed follower must not reconnect');
  });
});
