/**
 * Extension Bridge — Unit Tests
 *
 * Tests the WebSocket server that bridges the MCP server and the
 * Customaise Chrome extension. Uses real WebSocket connections on port 0
 * (OS-assigned ephemeral port) to avoid conflicts.
 *
 * Runner: Node's built-in node:test + tsx for TypeScript
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { ExtensionBridge } from '../extension-bridge.js';

/** Helper: create a bridge on an ephemeral port with a short timeout */
function createBridge(timeoutMs = 500): ExtensionBridge {
  return new ExtensionBridge(0, timeoutMs);
}

/** Helper: get the actual port the bridge is listening on */
function getBridgePort(bridge: ExtensionBridge): number {
  const wss = (bridge as any).wss;
  const addr = wss?.address();
  return typeof addr === 'object' ? addr.port : 0;
}

/** Helper: connect a mock client to the bridge, forging a valid
 * chrome-extension:// Origin so the bridge's verifyClient accepts. Real
 * extensions get this origin for free from Chrome; tests have to spell
 * it out because Node's `ws` client sends no Origin by default. */
function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`, {
      origin: 'chrome-extension://anmpijcpaobaabcdncjjmnhdeibipmko',
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Helper: wait for next message from a WebSocket */
function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once('message', (data) => {
      resolve(JSON.parse(data.toString()));
    });
  });
}

/** Helper: small delay */
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ExtensionBridge', () => {
  let bridge: ExtensionBridge;

  afterEach(async () => {
    if (bridge) {
      await bridge.close();
    }
  });

  // ─── Server Lifecycle ──────────────────────────────────────────

  it('starts and listens on configured port', async () => {
    bridge = createBridge();
    await bridge.start();
    const port = getBridgePort(bridge);
    assert.ok(port > 0, `Expected port > 0, got ${port}`);
  });

  it('isConnected is false before any client connects', async () => {
    bridge = createBridge();
    await bridge.start();
    assert.equal(bridge.isConnected, false);
  });

  // ─── Client Connection ──────────────────────────────────────────

  it('isConnected becomes true when a client connects', async () => {
    bridge = createBridge();
    await bridge.start();
    const client = await connectClient(getBridgePort(bridge));
    await delay(50);
    assert.equal(bridge.isConnected, true);
    client.close();
  });

  it('isConnected becomes false when client disconnects', async () => {
    bridge = createBridge();
    await bridge.start();
    const client = await connectClient(getBridgePort(bridge));
    await delay(50);
    assert.equal(bridge.isConnected, true);
    client.close();
    await delay(100);
    assert.equal(bridge.isConnected, false);
  });

  // ─── Origin allowlist ──────────────────────────────────────────

  it('rejects handshake with no Origin header', async () => {
    bridge = createBridge();
    await bridge.start();
    const port = getBridgePort(bridge);
    // Node's ws client sends no Origin by default — should be refused.
    const ws = new WebSocket(`ws://localhost:${port}`);
    const closed = new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => {/* handshake rejection surfaces as error */});
    });
    const code = await closed;
    assert.ok(code !== 1000, `Expected non-normal close, got ${code}`);
    assert.equal(bridge.isConnected, false);
  });

  it('rejects handshake from a regular webpage origin', async () => {
    bridge = createBridge();
    await bridge.start();
    const port = getBridgePort(bridge);
    const ws = new WebSocket(`ws://localhost:${port}`, {
      origin: 'https://evil.example.com',
    });
    const closed = new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => {/* expected */});
    });
    const code = await closed;
    assert.ok(code !== 1000);
    assert.equal(bridge.isConnected, false);
  });

  it('rejects handshake from an unknown chrome-extension ID', async () => {
    bridge = createBridge();
    await bridge.start();
    const port = getBridgePort(bridge);
    const ws = new WebSocket(`ws://localhost:${port}`, {
      origin: 'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh',
    });
    const closed = new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => {/* expected */});
    });
    const code = await closed;
    assert.ok(code !== 1000);
    assert.equal(bridge.isConnected, false);
  });

  it('accepts handshake from staging extension ID', async () => {
    bridge = createBridge();
    await bridge.start();
    const port = getBridgePort(bridge);
    const ws = new WebSocket(`ws://localhost:${port}`, {
      origin: 'chrome-extension://ijjaffggglamocdapoihpkcpealflopp',
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    assert.equal(bridge.isConnected, true);
    ws.close();
  });

  it('honours CUSTOMAISE_MCP_EXTRA_EXTENSION_IDS env var', async () => {
    const prev = process.env.CUSTOMAISE_MCP_EXTRA_EXTENSION_IDS;
    process.env.CUSTOMAISE_MCP_EXTRA_EXTENSION_IDS = 'devdevdevdevdevdevdevdevdevdevde';
    try {
      bridge = createBridge();
      await bridge.start();
      const port = getBridgePort(bridge);
      const ws = new WebSocket(`ws://localhost:${port}`, {
        origin: 'chrome-extension://devdevdevdevdevdevdevdevdevdevde',
      });
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
      });
      assert.equal(bridge.isConnected, true);
      ws.close();
    } finally {
      if (prev === undefined) delete process.env.CUSTOMAISE_MCP_EXTRA_EXTENSION_IDS;
      else process.env.CUSTOMAISE_MCP_EXTRA_EXTENSION_IDS = prev;
    }
  });

  it('honours CUSTOMAISE_MCP_ALLOW_INSECURE escape hatch', async () => {
    const prev = process.env.CUSTOMAISE_MCP_ALLOW_INSECURE;
    process.env.CUSTOMAISE_MCP_ALLOW_INSECURE = '1';
    try {
      bridge = createBridge();
      await bridge.start();
      const port = getBridgePort(bridge);
      // No Origin header — would normally be rejected.
      const ws = new WebSocket(`ws://localhost:${port}`);
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
      });
      assert.equal(bridge.isConnected, true);
      ws.close();
    } finally {
      if (prev === undefined) delete process.env.CUSTOMAISE_MCP_ALLOW_INSECURE;
      else process.env.CUSTOMAISE_MCP_ALLOW_INSECURE = prev;
    }
  });

  it('replaces existing connection when a new client connects', async () => {
    bridge = createBridge();
    await bridge.start();
    const port = getBridgePort(bridge);

    const client1 = await connectClient(port);
    await delay(50);
    const client2 = await connectClient(port);
    await delay(100);

    assert.equal(bridge.isConnected, true);
    assert.equal(client1.readyState, WebSocket.CLOSED);
    client2.close();
  });

  // ─── Request / Response ──────────────────────────────────────────

  it('request-response round-trip works', async () => {
    bridge = createBridge();
    await bridge.start();
    const client = await connectClient(getBridgePort(bridge));
    await delay(50);

    client.on('message', (data) => {
      const request = JSON.parse(data.toString());
      client.send(JSON.stringify({
        id: request.id,
        success: true,
        result: { scripts: ['script-1', 'script-2'] },
      }));
    });

    const result = await bridge.request('list_scripts', {});
    assert.deepEqual(result, { scripts: ['script-1', 'script-2'] });
    client.close();
  });

  it('sends correct request format to the client', async () => {
    bridge = createBridge();
    await bridge.start();
    const client = await connectClient(getBridgePort(bridge));
    await delay(50);

    const messagePromise = waitForMessage(client);
    client.on('message', (data) => {
      const request = JSON.parse(data.toString());
      client.send(JSON.stringify({ id: request.id, success: true, result: {} }));
    });

    await bridge.request('get_page_context', { tabId: 42 });
    const sentMessage = await messagePromise;

    assert.equal(sentMessage.type, 'get_page_context');
    assert.deepEqual(sentMessage.args, { tabId: 42 });
    assert.equal(typeof sentMessage.id, 'string');
    client.close();
  });

  it('request rejects with error response from extension', async () => {
    bridge = createBridge();
    await bridge.start();
    const client = await connectClient(getBridgePort(bridge));
    await delay(50);

    client.on('message', (data) => {
      const request = JSON.parse(data.toString());
      client.send(JSON.stringify({
        id: request.id,
        success: false,
        error: 'Script not found',
      }));
    });

    await assert.rejects(
      () => bridge.request('delete_script', { scriptId: 'bad-id' }),
      { message: 'Script not found' }
    );
    client.close();
  });

  it('request throws when no client is connected', async () => {
    bridge = createBridge();
    await bridge.start();

    await assert.rejects(
      () => bridge.request('list_scripts', {}),
      { message: /not connected/i }
    );
  });

  // ─── Timeout ──────────────────────────────────────────────────────

  it('request times out if extension does not respond', async () => {
    bridge = createBridge(200);
    await bridge.start();
    const client = await connectClient(getBridgePort(bridge));
    await delay(50);

    // Client intentionally does NOT respond
    await assert.rejects(
      () => bridge.request('list_scripts', {}),
      { message: /timed out/i }
    );
    client.close();
  });

  // ─── Shutdown ──────────────────────────────────────────────────────

  it('close() rejects all pending requests', async () => {
    bridge = createBridge(5000);
    await bridge.start();
    const client = await connectClient(getBridgePort(bridge));
    await delay(50);

    const requestPromise = bridge.request('list_scripts', {});
    requestPromise.catch(() => {}); // suppress unhandled rejection

    await bridge.close();

    await assert.rejects(
      () => requestPromise,
      { message: /shutting down/i }
    );
    client.close();
  });
});
