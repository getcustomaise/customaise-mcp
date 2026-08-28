/**
 * A leader that vanishes mid-handshake must not kill the process.
 *
 * The failing sequence, observed in Claude Desktop's own log on a cold boot:
 *
 *   40.690  spawn #1 — a DISPOSABLE sibling, spawned only to probe the
 *           protocol revision. It binds :4050 as leader.
 *   41.728  "Era probe verdict: modern (sibling answered server/discover)".
 *           The host reaps it. :4050 is free again.
 *   41.907  spawn #2 — a real server. It lost the bind race to the sibling
 *           milliseconds earlier and is now dialling a leader that is gone.
 *   41.954  process.exit(1). The host reports "the connection closed during
 *           the server/discover probe" and the session has no tools until
 *           the app is restarted.
 *
 * Both halves are transient — the sibling's death is what FREES the port —
 * so `createBridge` re-races rather than treating either as terminal. The
 * two cases below are the two orderings that window produces: the leader
 * dying after we connect (ELEADERGONE) and before we connect (ECONNREFUSED).
 *
 * A squatter that holds the port and never greets us is NOT transient, and
 * the third case pins that it still fails fast instead of burning the retry
 * budget five seconds at a time.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { WebSocketServer } from 'ws';
import { createBridge } from '../bridge.js';

process.env.CUSTOMAISE_MCP_ALLOW_INSECURE = '1';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => resolve(p));
    });
  });
}

describe('createBridge — reaped-sibling leader race', () => {
  /**
   * Everything each case opens, torn down forcibly rather than politely.
   *
   * The peers here are deliberately rude — they accept a connection and
   * vanish, or accept and say nothing — so a graceful close waits on an
   * answer that is never coming. Closing them by hand keeps the runner from
   * inheriting a socket that outlives the assertion it was built for.
   */
  const openServers: Array<WebSocketServer | Server> = [];

  afterEach(async () => {
    for (const srv of openServers.splice(0)) {
      if (srv instanceof WebSocketServer) {
        for (const c of srv.clients) c.terminate();
      }
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('re-races the port when the leader dies after accepting us', async () => {
    const port = await freePort();
    const sibling = new WebSocketServer({ port });
    openServers.push(sibling);
    await new Promise((r) => sibling.on('listening', r));

    // Accept the follower, then die without ever sending a status frame —
    // exactly what a reaped era-probe sibling does.
    sibling.on('connection', (ws) => {
      ws.close();
      sibling.close();
    });

    const bridge = await createBridge(port, 1000);
    try {
      // The port was freed, so the retry should have won it outright.
      assert.equal(bridge.role, 'leader');
    } finally {
      await bridge.close();
    }
  });

  it('re-races the port when the leader is gone before we dial', async () => {
    const port = await freePort();

    // A plain TCP listener occupies the port so the bind fails with
    // EADDRINUSE, then closes before the follower's WS upgrade completes.
    const squatterGone: Server = createServer();
    openServers.push(squatterGone);
    await new Promise<void>((r) => squatterGone.listen(port, '127.0.0.1', r));
    squatterGone.on('connection', (sock) => {
      sock.destroy();
      squatterGone.close();
    });

    const bridge = await createBridge(port, 1000);
    try {
      assert.equal(bridge.role, 'leader');
    } finally {
      await bridge.close();
    }
  });

  it('does not retry a peer that holds the port and never greets us', async () => {
    const port = await freePort();
    // Answers the WS upgrade, then says nothing. Retrying cannot help: it
    // will still be there, and each attempt costs a full handshake timeout.
    const squatter = new WebSocketServer({ port });
    openServers.push(squatter);
    await new Promise((r) => squatter.on('listening', r));

    const started = Date.now();
    await assert.rejects(
      () => createBridge(port, 1000),
      (err: any) => {
        assert.equal(err.code, 'ENOTLEADER');
        return true;
      },
    );
    // One handshake timeout (5s), not six.
    assert.ok(Date.now() - started < 12_000, 'gave up after a single handshake timeout');
  });
});
