/**
 * Cross-version compatibility matrix, run against REAL server binaries.
 *
 * The 3.2.0 error-code move (-3202x -> -4002x) is a value-level wire change,
 * and a wire change has two directions. Unit tests cover the one we control
 * (new server, old extension). This drives the other with the actually
 * published 3.1.0 binary from npm, plus the leader/follower skew that a
 * mixed fleet produces during a rollout.
 *
 * Not a Jest/node:test suite: it needs two npm-installed versions of the
 * package side by side, which is a shape the test runner cannot express.
 * Run by hand before publishing.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * Defaults to this checkout's `dist/`. Point it at an unpacked `.mcpb`'s
 * `server/index.js` to test the artifact users actually receive, which is a
 * different file tree with its own copy of package.json.
 */
const NEW_SERVER = process.env.CUSTOMAISE_NEW_SERVER || join(HERE, 'dist', 'index.js');
/**
 * The previously published server, installed anywhere you like:
 *
 *   mkdir /tmp/xver && cd /tmp/xver && npm init -y
 *   npm install @customaise/mcp@<previous>
 *   CUSTOMAISE_PREV_SERVER=/tmp/xver/node_modules/@customaise/mcp/dist/index.js \
 *     node mcp/xver-matrix.mjs
 */
const OLD_SERVER = process.env.CUSTOMAISE_PREV_SERVER;
if (!OLD_SERVER) {
  console.error('Set CUSTOMAISE_PREV_SERVER to the previous release\'s dist/index.js. See the comment above.');
  process.exit(2);
}

const EXT_ORIGIN = 'chrome-extension://anmpijcpaobaabcdncjjmnhdeibipmko';
const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A fake Customaise extension. `ack` decides how it answers a dispatch, so a
 * caller can make it behave like an old extension (-32029) or a new one
 * (-40029). Also sends a pending frame first when `pending` is set.
 */
function fakeExtension(port, { ack, pending = false } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: EXT_ORIGIN });
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'init_session', session_id: 'x', install_id: 'i',
        tier: 'power_user', unlimited: true,
      }));
      resolve(ws);
    });
    ws.on('message', (raw) => {
      let f; try { f = JSON.parse(raw.toString()); } catch { return; }
      if (f.type !== 'dispatch_tool') return;
      const send = () => ws.send(JSON.stringify({
        type: 'dispatch_ack', session_id: f.session_id, seq_num: f.seq_num, counter: 1, ...ack,
      }));
      if (pending) {
        ws.send(JSON.stringify({
          type: 'dispatch_tool_pending', session_id: f.session_id, seq_num: f.seq_num,
          reason: 'awaiting_user_consent', expected_timeout_ms: 300000,
        }));
        setTimeout(send, 40);
      } else send();
    });
    ws.on('error', reject);
  });
}

/** Connect an MCP client to a server binary over stdio. */
async function connectServer(serverPath, wsPort, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      CUSTOMAISE_WS_PORT: String(wsPort),
      CUSTOMAISE_MCP_ALLOW_INSECURE: '1',
      ...extraEnv,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'xver-matrix', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

/** Pull the structured error a tool call produced, whichever shape it took. */
function errorFrom(res) {
  const sc = res?.structuredContent?.error;
  if (sc) return sc;
  const text = res?.content?.find?.((c) => c.type === 'text')?.text;
  if (text) { try { return JSON.parse(text).error ?? JSON.parse(text); } catch { return { raw: text }; } }
  return null;
}

async function scenario(name, { serverPath, ack, expectType, expectCode }) {
  const wsPort = await freePort();
  let ext, conn;
  try {
    conn = await connectServer(serverPath, wsPort);
    ext = await fakeExtension(wsPort, { ack });
    await sleep(400);
    const res = await conn.client.callTool({ name: 'list_tabs', arguments: {} });
    const err = errorFrom(res);
    const typeOk = err?.type === expectType;
    const codeOk = expectCode === undefined || err?.code === expectCode;
    record(name, typeOk && codeOk,
      `type=${err?.type} code=${err?.code} (want type=${expectType}${expectCode !== undefined ? ` code=${expectCode}` : ''})`);
  } catch (e) {
    record(name, false, 'threw: ' + e.message);
  } finally {
    try { ext?.terminate(); } catch {}
    try { await conn?.client.close(); } catch {}
  }
}

async function main() {
  console.log('\n=== A. Server <-> extension error-code directions ===');

  // The direction unit tests cover, re-proved against the real binary.
  await scenario('3.2.0 server + OLD extension emitting -32029', {
    serverPath: NEW_SERVER,
    ack: { success: false, error: 'Daily cap reached', error_code: -32029, error_data: { type: 'cap_exceeded' } },
    expectType: 'cap_exceeded',
    expectCode: -40029,
  });

  // The direction that only a real old binary can prove: a NEW extension
  // (post-1.3.2) talking to an MCP that predates the move. If the type
  // string does not survive, every CLI exit code downstream is wrong.
  await scenario('3.1.0 server + NEW extension emitting -40029', {
    serverPath: OLD_SERVER,
    ack: { success: false, error: 'Daily cap reached', error_code: -40029, error_data: { type: 'cap_exceeded' } },
    expectType: 'cap_exceeded',
  });

  await scenario('3.2.0 server + NEW extension emitting -40029', {
    serverPath: NEW_SERVER,
    ack: { success: false, error: 'Sign in first', error_code: -40028, error_data: { type: 'auth_required' } },
    expectType: 'auth_required',
    expectCode: -40028,
  });

  console.log('\n=== B. Leader/follower version skew ===');
  for (const [name, leaderPath, followerPath] of [
    ['3.2.0 leader + 3.1.0 follower', NEW_SERVER, OLD_SERVER],
    ['3.1.0 leader + 3.2.0 follower', OLD_SERVER, NEW_SERVER],
  ]) {
    const wsPort = await freePort();
    let leader, follower, ext;
    try {
      leader = await connectServer(leaderPath, wsPort);
      await sleep(600);
      follower = await connectServer(followerPath, wsPort);
      await sleep(600);
      ext = await fakeExtension(wsPort, { ack: { success: true, result: [{ id: 7, url: 'https://example.com' }] }, pending: true });
      await sleep(400);
      // The follower's call is relayed by the leader; a pending frame rides
      // along the way, which is the path 3.2.0 turns into progress.
      const res = await follower.client.callTool({ name: 'list_tabs', arguments: {} });
      const err = errorFrom(res);
      const ok = !err || err.type === undefined;
      record(name, ok, ok ? 'follower dispatch relayed through leader' : `unexpected error type=${err?.type}`);
    } catch (e) {
      record(name, false, 'threw: ' + e.message);
    } finally {
      try { ext?.terminate(); } catch {}
      try { await follower?.client.close(); } catch {}
      try { await leader?.client.close(); } catch {}
      await sleep(200);
    }
  }

  console.log('\n=== C. Progress reaches a real MCP client during a consent wait ===');
  {
    const wsPort = await freePort();
    let ext, conn;
    try {
      conn = await connectServer(NEW_SERVER, wsPort);
      ext = await fakeExtension(wsPort, { ack: { success: true, result: [] }, pending: true });
      await sleep(400);
      const seen = [];
      const res = await conn.client.callTool(
        { name: 'list_tabs', arguments: {} },
        { onprogress: (p) => seen.push(p), resetTimeoutOnProgress: true },
      );
      const err = errorFrom(res);
      record('3.2.0 emits notifications/progress on a pending dispatch',
        seen.length >= 1 && !err?.type,
        `progress frames=${seen.length}${seen[0]?.message ? ` first="${String(seen[0].message).slice(0, 60)}…"` : ''}`);
    } catch (e) {
      record('3.2.0 emits notifications/progress on a pending dispatch', false, 'threw: ' + e.message);
    } finally {
      try { ext?.terminate(); } catch {}
      try { await conn?.client.close(); } catch {}
    }
  }

  console.log('\n=== D. 3.1.0 client-visible behaviour on the same pending path ===');
  {
    const wsPort = await freePort();
    let ext, conn;
    try {
      conn = await connectServer(OLD_SERVER, wsPort);
      ext = await fakeExtension(wsPort, { ack: { success: true, result: [] }, pending: true });
      await sleep(400);
      const seen = [];
      await conn.client.callTool(
        { name: 'list_tabs', arguments: {} },
        { onprogress: (p) => seen.push(p), resetTimeoutOnProgress: true },
      );
      record('3.1.0 sends no progress (the defect 3.2.0 fixes)', seen.length === 0,
        `progress frames=${seen.length} — expected 0 from the old binary`);
    } catch (e) {
      record('3.1.0 sends no progress (the defect 3.2.0 fixes)', false, 'threw: ' + e.message);
    } finally {
      try { ext?.terminate(); } catch {}
      try { await conn?.client.close(); } catch {}
    }
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log('  - ' + f.name + ' — ' + f.detail);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('harness error:', e); process.exit(1); });
