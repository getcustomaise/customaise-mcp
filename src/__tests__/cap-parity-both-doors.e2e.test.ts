/**
 * A call costs exactly one cap unit whichever door it comes through.
 *
 * There are two: stdio, which an IDE spawns, and the daemon's loopback HTTP,
 * which the CLI uses. Both are built from the same `createServerFactory` and
 * both dispatch through the same bridge to the same extension, which owns the
 * authoritative counter. That is the design. Nothing tested it.
 *
 * The failure this guards against is not "the CLI is free". It is the reverse
 * and worse: a door that counts twice, or a door whose count the other cannot
 * see, because the counter is bilateral. The server adopts the extension's
 * value on every ack and treats a BACKWARDS value as tampering, so two doors
 * disagreeing about the count is how a user gets their session locked for
 * doing nothing wrong.
 *
 * So the fake extension here keeps a real counter and returns it exactly as
 * the extension does, and the test watches it advance one at a time across an
 * interleaved sequence.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { ExtensionBridge } from '../extension-bridge.js';

process.env.CUSTOMAISE_MCP_ALLOW_INSECURE = '1';

function pkgRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'dist', 'cli', 'index.js'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('could not locate dist');
}
const ROOT = pkgRoot();
const CLI = join(ROOT, 'dist', 'cli', 'index.js');
const ENTRY = join(ROOT, 'dist', 'index.js');
const SRC_DIR = join(ROOT, 'src');

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

async function until(p: () => Promise<boolean> | boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await p()) return;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

let httpPort: number;
let wsPort: number;
let configDir: string;
let leader: ExtensionBridge;
let extension: WebSocket;
let daemon: ChildProcess;
let ideClient: Client;

/** The authoritative counter, kept where the real one lives: the extension. */
let dailyUsed = 0;
/** Which door each dispatch arrived through, in order. */
const seen: string[] = [];

const env = () => ({
  ...process.env,
  CUSTOMAISE_HTTP_PORT: String(httpPort),
  CUSTOMAISE_WS_PORT: String(wsPort),
  CUSTOMAISE_CONFIG_DIR: configDir,
  CUSTOMAISE_MCP_ALLOW_INSECURE: '1',
});

function runCli(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: env(), cwd: configDir });
    let stdout = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.on('close', (code) => resolve({ code: code ?? -1, stdout }));
  });
}

describe('cap parity across the stdio and loopback doors', () => {
  before(async () => {
    httpPort = await freePort();
    wsPort = await freePort();
    configDir = mkdtempSync(join(tmpdir(), 'customaise-parity-'));

    leader = new ExtensionBridge(wsPort);
    await leader.start();

    await until(async () => {
      const c = new WebSocket(`ws://127.0.0.1:${wsPort}`);
      try {
        await new Promise<void>((res, rej) => { c.once('open', () => res()); c.once('error', rej); });
        extension = c;
        return true;
      } catch { try { c.terminate(); } catch { /* gone */ } return false; }
    });

    extension.on('message', (raw) => {
      const f = JSON.parse(String(raw));
      if (f.type !== 'dispatch_tool') return;
      // Exactly what the extension does: count the successful dispatch, then
      // return the new authoritative value on the ack.
      dailyUsed += 1;
      seen.push(f.tool);
      extension.send(JSON.stringify({
        type: 'dispatch_ack', session_id: f.session_id, seq_num: f.seq_num,
        success: true, counter: dailyUsed, result: [],
      }));
    });

    extension.send(JSON.stringify({
      type: 'init_session', session_id: 'parity', install_id: 'i',
      tier: 'free', daily_cap: 50, weekly_cap: 150,
      current_used_daily: 0, current_used_week: 0,
    }));
    await new Promise((r) => setTimeout(r, 300));

    // Door 1: the CLI, through the resident daemon on loopback HTTP.
    daemon = spawn(process.execPath, [ENTRY, 'daemon'], { env: env(), stdio: 'ignore' });
    await until(async () => (await runCli(['doctor'])).code === 0);

    // Door 2: an IDE, over stdio, against the same leader and extension.
    ideClient = new Client({ name: 'parity-ide', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } });
    await ideClient.connect(new StdioClientTransport({
      command: process.execPath, args: [ENTRY], env: env() as Record<string, string>,
    }));
  });

  after(async () => {
    try { await ideClient?.close(); } catch { /* gone */ }
    await runCli(['daemon', 'stop']).catch(() => {});
    daemon?.kill('SIGKILL');
    try { extension?.close(); } catch { /* gone */ }
    try { await leader?.close(); } catch { /* gone */ }
    try { rmSync(configDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('both doors are live and neither is the leader', async () => {
    // If either turned out to be the leader this would be testing one door
    // twice, which is exactly how the follower relay bug hid for a session.
    assert.equal(leader.role, 'leader');
    const viaCli = await runCli(['tabs']);
    assert.equal(viaCli.code, 0, viaCli.stdout);
    const viaIde = await ideClient.callTool({ name: 'list_tabs', arguments: {} });
    assert.ok(viaIde, 'the stdio door returned nothing');
  });

  it('advances the counter by exactly one per call, interleaved', async () => {
    const start = dailyUsed;
    seen.length = 0;

    await runCli(['tabs']);                                         // loopback
    await ideClient.callTool({ name: 'list_tabs', arguments: {} });  // stdio
    await runCli(['tabs']);                                         // loopback
    await ideClient.callTool({ name: 'list_tabs', arguments: {} });  // stdio

    assert.equal(dailyUsed - start, 4,
      `four calls should cost four units, cost ${dailyUsed - start}`);
    assert.deepEqual(seen, ['list_tabs', 'list_tabs', 'list_tabs', 'list_tabs'],
      'a door dispatched something extra: ' + seen.join(', '));
  });

  it('the server has adopted the extension count, so neither door drifts', async () => {
    // The counter is bilateral: the server adopts on every ack and treats a
    // backwards value as tampering. Two doors disagreeing is how a user gets
    // their session integrity-locked for doing nothing wrong.
    const doctor = await runCli(['doctor']);
    const cap = JSON.parse(doctor.stdout).data.cap as string;
    assert.match(cap, new RegExp(`${dailyUsed}/50 today`),
      `doctor reports "${cap}" but the extension has counted ${dailyUsed}`);
  });

  it('serves tools/list in name order to a real client', async () => {
    // Asserted against what a client actually receives, not against the
    // registration source. The sort lives in `createServerFactory`, so a test
    // at the `registerTools` level would bypass the code it means to check.
    //
    // The list is cached for an hour, so an order that shifts between builds
    // makes a cached copy differ from a fresh one for no reason.
    const listed = await ideClient.listTools();
    const names = listed.tools.map((t: { name: string }) => t.name);
    // Compared against the SOURCE, not a literal.
    //
    // This test drives the built server in dist/, so a hardcoded count here
    // passes whenever dist and src happen to agree with it — including when
    // both are wrong. That is not hypothetical: `npm test` compiles to
    // test-out/ and never touches dist/, so a tool deleted from src/ stayed
    // in dist/ and this assertion went on passing against the stale build.
    // Deriving it means the door this test opens is the one the source
    // describes, and a stale dist fails here instead of shipping.
    const serverSrc = readFileSync(join(SRC_DIR, 'server.ts'), 'utf-8');
    const sourceToolCount = [...serverSrc.matchAll(/registerTool\('[a-z_]+'/g)].length;
    assert.ok(sourceToolCount > 0, 'could not read the tool surface from server.ts');
    assert.equal(names.length, sourceToolCount,
      `dist/ serves ${names.length} tools but src/server.ts registers ${sourceToolCount}` +
      ' — dist is stale, run `npm run build`');
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)),
      'tools/list came back in registration order: ' + names.join(', '));
  });

  it('a rejected call costs nothing on either door', async () => {
    // Failed dispatches do not count (ARD 4.1). A door that charged for them
    // would drift ahead of the other.
    const before = dailyUsed;
    await runCli(['tab', 'focus']);                    // usage error, exits before dispatch
    await runCli(['scripts', 'get', 'x', '--out']);    // usage error, same
    assert.equal(dailyUsed, before, 'a usage error must not reach the extension');
  });
});
