/**
 * A modern client is identified by its first request, whatever it is.
 *
 * On 2026-07-28 identity rides `_meta` on every request. It was read only
 * inside the tool envelope, so a client that had listed tools and not yet
 * called one had no row in the extension's sidebar. Claude Desktop does
 * exactly that on launch (tools/list, resources/list, then waits for a
 * human), and its row was absent until the first tool call. The daemon
 * opts out: it has a fixed identity and serves many passing CLI clients.
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServerFactory } from '../build-server.js';

const CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';

function fakeBridge() {
  return {
    setOwnClientInfo: mock.fn(),
    onPush: () => {},
    getSystemStatus: () => null,
    getSessionSnapshot: () => ({}),
    dispatchTool: async () => ({}),
    request: async () => ({}),
    close: async () => {},
    start: async () => {},
    role: 'leader' as const,
    isConnected: false,
  };
}

/** The least a transport can be: the SDK installs its handler on it in connect(). */
function fakeTransport() {
  const t: { onmessage?: (m: unknown, e?: unknown) => void; start: () => Promise<void>; send: (m: unknown) => Promise<void>; close: () => Promise<void>; sent: unknown[] } = {
    sent: [],
    start: async () => {},
    send: async (m) => { t.sent.push(m); },
    close: async () => {},
  };
  return t;
}

const listTools = (name: string) => ({
  jsonrpc: '2.0', id: 1, method: 'tools/list',
  params: { _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {},
    [CLIENT_INFO]: { name, version: '0.1.0' },
  } },
});

describe('client identity is read from any request', () => {
  it('a tools/list carrying clientInfo identifies the client', async () => {
    const bridge = fakeBridge();
    const server = createServerFactory({ bridge: bridge as any, fileWatcher: { stop() {} } as any, log: () => {} })();
    const t = fakeTransport();
    await server.connect(t as any);
    t.onmessage!(listTools('claude-ai'));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(bridge.setOwnClientInfo.mock.callCount(), 1);
    assert.deepEqual(bridge.setOwnClientInfo.mock.calls[0].arguments[0], { name: 'claude-ai', version: '0.1.0' });
  });

  it('reports once; later requests do not re-announce', async () => {
    const bridge = fakeBridge();
    const server = createServerFactory({ bridge: bridge as any, fileWatcher: { stop() {} } as any, log: () => {} })();
    const t = fakeTransport();
    await server.connect(t as any);
    t.onmessage!(listTools('cursor'));
    t.onmessage!({ ...listTools('cursor'), id: 2 });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(bridge.setOwnClientInfo.mock.callCount(), 1);
  });

  it('the daemon keeps its own name: reportClientIdentity false is honoured here too', async () => {
    const bridge = fakeBridge();
    const server = createServerFactory({ bridge: bridge as any, fileWatcher: { stop() {} } as any, log: () => {}, reportClientIdentity: false })();
    const t = fakeTransport();
    await server.connect(t as any);
    t.onmessage!(listTools('customaise-cli'));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(bridge.setOwnClientInfo.mock.callCount(), 0);
  });

  it('a request without clientInfo is passed through untouched', async () => {
    const bridge = fakeBridge();
    const server = createServerFactory({ bridge: bridge as any, fileWatcher: { stop() {} } as any, log: () => {} })();
    const t = fakeTransport();
    await server.connect(t as any);
    t.onmessage!({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(bridge.setOwnClientInfo.mock.callCount(), 0);
    assert.ok(t.sent.length >= 1, 'the SDK still answered the request');
  });
});
