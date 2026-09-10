/**
 * Three CLI invocations racing on a cold box must leave ONE daemon.
 *
 * An agent scripting this will fire commands concurrently, and on a cold box
 * every one of them finds no daemon and tries to start one. If that race is
 * not arbitrated, you get several daemons fighting over the loopback port, or
 * several token files, and the losers report failure for work that succeeded.
 *
 * The arbitration is the port bind itself: whoever binds owns the daemon, and
 * the losers wait for the endpoint rather than erroring. This proves it
 * against real processes rather than reasoning about the intent.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
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
const CLI = join(pkgRoot(), 'dist', 'cli', 'index.js');

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
const spawned: ChildProcess[] = [];

const env = () => ({
  ...process.env,
  CUSTOMAISE_HTTP_PORT: String(httpPort),
  CUSTOMAISE_WS_PORT: String(wsPort),
  CUSTOMAISE_CONFIG_DIR: configDir,
  CUSTOMAISE_MCP_ALLOW_INSECURE: '1',
});

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: env(), cwd: configDir });
    spawned.push(p);
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe('a cold-start race leaves one daemon and one token', () => {
  before(async () => {
    httpPort = await freePort();
    wsPort = await freePort();
    configDir = mkdtempSync(join(tmpdir(), 'customaise-race-'));

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
      if (f.type === 'dispatch_tool') {
        extension.send(JSON.stringify({
          type: 'dispatch_ack', session_id: f.session_id, seq_num: f.seq_num,
          success: true, counter: 1, result: [],
        }));
      }
    });
    extension.send(JSON.stringify({
      type: 'init_session', session_id: 'race', install_id: 'i',
      tier: 'free', daily_cap: 50, weekly_cap: 150,
      current_used_daily: 0, current_used_week: 0,
    }));
    await new Promise((r) => setTimeout(r, 300));
  });

  after(async () => {
    for (const p of spawned) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
    await runCli(['daemon', 'stop']).catch(() => {});
    try { extension?.close(); } catch { /* gone */ }
    try { await leader?.close(); } catch { /* gone */ }
    try { rmSync(configDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('all three succeed, and none reports a failure the others caused', async () => {
    // The cold box: nothing running, no token file yet.
    assert.equal(readdirSync(configDir).length, 0, 'config dir should start empty');

    const results = await Promise.all([
      runCli(['tabs']),
      runCli(['tabs']),
      runCli(['tabs']),
    ]);

    for (const [i, r] of results.entries()) {
      assert.equal(r.code, 0, `invocation ${i + 1} failed: ${r.stderr || r.stdout}`);
      assert.equal(JSON.parse(r.stdout).ok, true);
    }
  });

  it('leaves exactly one daemon and one token file', async () => {
    // Several daemons would mean several CapSessions and a counter that
    // disagrees with itself; several token files would mean the next CLI
    // picks one at random.
    const tokens = readdirSync(configDir).filter((f) => f.includes('daemon') || f.endsWith('.json'));
    assert.equal(tokens.length, 1, `expected one daemon record, found: ${tokens.join(', ')}`);

    const status = await runCli(['daemon', 'status']);
    assert.equal(status.code, 0);
    const data = JSON.parse(status.stdout).data;
    assert.equal(data.running, true);
    assert.equal(data.port, httpPort);
  });

  it('a fourth invocation reuses the daemon rather than starting another', async () => {
    const before = JSON.parse((await runCli(['daemon', 'status'])).stdout).data.pid;
    const r = await runCli(['tabs']);
    assert.equal(r.code, 0);
    const after = JSON.parse((await runCli(['daemon', 'status'])).stdout).data.pid;
    assert.equal(after, before, 'the daemon was replaced when it should have been reused');
  });

  it('recovers a stale record after the configured HTTP port changes', async () => {
    await runCli(['daemon', 'stop']);
    const oldPort = await freePort();
    writeFileSync(join(configDir, 'daemon.json'), JSON.stringify({
      token: 'stale-token', port: oldPort, pid: 99999999, version: '0.0.0',
    }));
    const result = await runCli(['tabs']);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse((await runCli(['daemon', 'status'])).stdout).data.port, httpPort);
  });
});
