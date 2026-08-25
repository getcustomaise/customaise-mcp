/**
 * MCP Integration Tests — Full WebSocket Chain
 *
 * Wires up a real ExtensionBridge with a real ws WebSocket client,
 * simulating the extension side. Tests the full request/response protocol
 * including concurrent requests, mid-flight disconnects, and error handling.
 *
 * Runner: Node's built-in node:test + tsx for TypeScript
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { ExtensionBridge } from '../extension-bridge.js';

/** Helper: get the actual port the bridge is listening on */
function getBridgePort(bridge: ExtensionBridge): number {
  const wss = (bridge as any).wss;
  const addr = wss?.address();
  return typeof addr === 'object' ? addr.port : 0;
}

/** Helper: connect a mock extension client. Forges the Chrome-assigned
 * Origin so the bridge's verifyClient accepts; real extensions get this
 * origin for free, test Node clients don't. */
function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`, {
      origin: 'chrome-extension://anmpijcpaobaabcdncjjmnhdeibipmko',
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Helper: small delay */
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Create a mock extension handler that auto-responds to bridge requests.
 */
function installAutoResponder(
  client: WebSocket,
  handler: (request: { id: string; type: string; args: Record<string, unknown> }) => {
    success: boolean;
    result?: unknown;
    error?: string;
  }
) {
  client.on('message', (data) => {
    const request = JSON.parse(data.toString());
    const response = handler(request);
    client.send(JSON.stringify({ id: request.id, ...response }));
  });
}

describe('MCP Integration — Full WebSocket Chain', () => {
  let bridge: ExtensionBridge;
  let client: WebSocket;

  afterEach(async () => {
    if (client && client.readyState === WebSocket.OPEN) {
      client.close();
    }
    if (bridge) {
      await bridge.close();
    }
  });

  // ─── Full Request/Response Chain ───────────────────────────────

  it('full chain: bridge → client → bridge resolves', async () => {
    bridge = new ExtensionBridge(0, 5000);
    await bridge.start();
    client = await connectClient(getBridgePort(bridge));
    await delay(50);

    installAutoResponder(client, (req) => {
      if (req.type === 'list_scripts') {
        return {
          success: true,
          result: {
            scripts: [
              { id: 'abc', name: 'My Script', enabled: true },
              { id: 'def', name: 'Other Script', enabled: false },
            ],
          },
        };
      }
      return { success: false, error: `Unknown tool: ${req.type}` };
    });

    const result = await bridge.request('list_scripts', {}) as any;
    assert.equal(result.scripts.length, 2);
    assert.equal(result.scripts[0].id, 'abc');
    assert.equal(result.scripts[0].name, 'My Script');
    assert.equal(result.scripts[0].enabled, true);
    assert.equal(result.scripts[1].id, 'def');
    assert.equal(result.scripts[1].enabled, false);
  });

  it('args are forwarded correctly through the chain', async () => {
    bridge = new ExtensionBridge(0, 5000);
    await bridge.start();
    client = await connectClient(getBridgePort(bridge));
    await delay(50);

    let receivedArgs: Record<string, unknown> = {};
    installAutoResponder(client, (req) => {
      receivedArgs = req.args;
      return { success: true, result: { source: '// code' } };
    });

    await bridge.request('import_script', { scriptId: 'test-123' });
    assert.deepEqual(receivedArgs, { scriptId: 'test-123' });
  });

  // ─── Concurrent Requests ──────────────────────────────────────

  it('multiple concurrent requests resolve independently', async () => {
    bridge = new ExtensionBridge(0, 5000);
    await bridge.start();
    client = await connectClient(getBridgePort(bridge));
    await delay(50);

    installAutoResponder(client, (req) => ({
      success: true,
      result: { type: req.type, args: req.args },
    }));

    const [r1, r2, r3] = await Promise.all([
      bridge.request('list_scripts', {}),
      bridge.request('import_script', { scriptId: 'abc' }),
      bridge.request('list_tabs', {}),
    ]) as any[];

    assert.equal(r1.type, 'list_scripts');
    assert.equal(r2.type, 'import_script');
    assert.deepEqual(r2.args, { scriptId: 'abc' });
    assert.equal(r3.type, 'list_tabs');
  });

  // ─── Error Handling ────────────────────────────────────────────

  it('error response from extension is surfaced as rejected promise', async () => {
    bridge = new ExtensionBridge(0, 5000);
    await bridge.start();
    client = await connectClient(getBridgePort(bridge));
    await delay(50);

    installAutoResponder(client, () => ({
      success: false,
      error: 'NOT_POWER_USER: Feature requires Power User tier',
    }));

    await assert.rejects(
      () => bridge.request('list_scripts', {}),
      { message: /NOT_POWER_USER/ }
    );
  });

  it('client disconnect mid-request causes request rejection', async () => {
    bridge = new ExtensionBridge(0, 1000);
    await bridge.start();
    client = await connectClient(getBridgePort(bridge));
    await delay(50);

    client.on('message', () => {
      client.close();
    });

    // Should reject via timeout after disconnect
    await assert.rejects(
      () => bridge.request('list_scripts', {})
    );
  });

  // ─── Protocol Fidelity ─────────────────────────────────────────

  it('request IDs are unique UUIDs', async () => {
    bridge = new ExtensionBridge(0, 5000);
    await bridge.start();
    client = await connectClient(getBridgePort(bridge));
    await delay(50);

    const receivedIds: string[] = [];
    client.on('message', (data) => {
      const request = JSON.parse(data.toString());
      receivedIds.push(request.id);
      client.send(JSON.stringify({ id: request.id, success: true, result: {} }));
    });

    await bridge.request('list_scripts', {});
    await bridge.request('list_tabs', {});
    await bridge.request('delete_script', { scriptId: 'x' });

    assert.equal(receivedIds.length, 3);
    assert.equal(new Set(receivedIds).size, 3, 'All IDs should be unique');

    for (const id of receivedIds) {
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it('response for unknown request ID is silently ignored', async () => {
    bridge = new ExtensionBridge(0, 5000);
    await bridge.start();
    client = await connectClient(getBridgePort(bridge));
    await delay(50);

    // Send a rogue response with a fake ID — should not crash
    client.send(JSON.stringify({
      id: '00000000-0000-0000-0000-000000000000',
      success: true,
      result: { rogue: true },
    }));

    await delay(100);
    assert.equal(bridge.isConnected, true);
  });
});
