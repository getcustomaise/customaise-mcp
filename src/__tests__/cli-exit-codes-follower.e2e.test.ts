/**
 * The exit-code contract with the daemon running as a FOLLOWER.
 *
 * This is the configuration everybody actually runs: an IDE holds `:4050` and
 * the CLI daemon proxies through it. The existing e2e spawns the daemon into
 * a free port, so it is always the leader, and every typed error it asserts
 * takes the direct path.
 *
 * That gap hid a real bug. The leader relayed an error to a follower as a
 * JSON envelope only when it was a `ProtocolError`; the extension's typed
 * refusals are deliberately plain errors carrying `.data`, so their type was
 * dropped on the way through. `consent_denied`, `consent_timeout`,
 * `not_found` and `invalid_argument` all arrived as generic failures, which
 * means exits 6 and 7 were unreachable through the CLI in the normal setup
 * while the leader-path e2e reported them working.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { ExtensionBridge } from '../extension-bridge.js';

function pkgRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'dist', 'cli', 'index.js'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('could not locate dist (run `npm run build` first)');
}

const ROOT = pkgRoot();
const CLI = join(ROOT, 'dist', 'cli', 'index.js');
const ENTRY = join(ROOT, 'dist', 'index.js');

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

async function until(predicate: () => Promise<boolean> | boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

type Ack = { success: boolean; result?: unknown; error?: string; error_code?: number; error_data?: unknown };

// The in-process leader reads this at construction, from THIS process env.
// Setting it only in the daemon's child env leaves the leader rejecting the
// fake extension's handshake, which shows up as the before-hook timing out.
process.env.CUSTOMAISE_MCP_ALLOW_INSECURE = '1';

let httpPort: number;
let wsPort: number;
let configDir: string;
let leader: ExtensionBridge;
let daemon: ChildProcess;
let extension: WebSocket;
let nextAck: Ack = { success: true, result: [] };

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

describe('exit codes survive the follower relay', () => {
  before(async () => {
    httpPort = await freePort();
    wsPort = await freePort();
    configDir = mkdtempSync(join(tmpdir(), 'customaise-follower-'));

    // Take the leader slot FIRST, so the daemon has no choice but to follow.
    leader = new ExtensionBridge(wsPort);
    await leader.start();

    daemon = spawn(process.execPath, [ENTRY, 'daemon'], { env: env(), stdio: 'ignore' });

    await until(async () => {
      const candidate = new WebSocket(`ws://127.0.0.1:${wsPort}`);
      try {
        await new Promise<void>((resolve, reject) => {
          candidate.once('open', () => resolve());
          candidate.once('error', reject);
        });
        extension = candidate;
        return true;
      } catch {
        try { candidate.terminate(); } catch { /* already dead */ }
        return false;
      }
    });

    extension.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === 'dispatch_tool') {
        extension.send(JSON.stringify({
          type: 'dispatch_ack',
          session_id: frame.session_id,
          seq_num: frame.seq_num,
          counter: 1,
          ...nextAck,
        }));
      }
    });
    extension.send(JSON.stringify({
      type: 'init_session', session_id: 'follower-test', install_id: 'i',
      tier: 'free', daily_cap: 50, weekly_cap: 150,
      current_used_daily: 0, current_used_week: 0,
    }));
    await new Promise((r) => setTimeout(r, 400));
  });

  after(async () => {
    try { extension?.close(); } catch { /* gone */ }
    daemon?.kill('SIGKILL');
    try { await leader?.close(); } catch { /* gone */ }
    try { rmSync(configDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('proves the daemon really is a follower', async () => {
    // If this fails the rest is testing the leader path again and proving
    // nothing, which is exactly how the original bug survived.
    assert.equal(leader.role, 'leader');
    const { code } = await runCli(['tabs']);
    assert.equal(code, 0);
  });

  it('carries a CODELESS typed refusal through: consent denied -> 6', async () => {
    // The case that was broken. No numeric code, type is the whole signal.
    nextAck = { success: false, error: 'The user denied this tool call.', error_data: { type: 'consent_denied' } };
    const { code, stdout } = await runCli(['tabs']);
    assert.equal(code, 6, stdout);
    assert.equal(JSON.parse(stdout).error.type, 'consent_denied');
  });

  it('consent timeout -> 7', async () => {
    nextAck = { success: false, error: 'The consent request timed out.', error_data: { type: 'consent_timeout' } };
    const { code, stdout } = await runCli(['tabs']);
    assert.equal(code, 7, stdout);
  });

  it('not_found -> 8', async () => {
    nextAck = { success: false, error: 'No tab with id: 999999.', error_data: { type: 'not_found' } };
    const { code, stdout } = await runCli(['tabs']);
    assert.equal(code, 8, stdout);
  });

  it('invalid_argument -> 2', async () => {
    nextAck = { success: false, error: 'tabId is required', error_data: { type: 'invalid_argument' } };
    const { code, stdout } = await runCli(['tabs']);
    assert.equal(code, 2, stdout);
  });

  it('still carries a CODED error through: cap exceeded -> 5', async () => {
    nextAck = {
      success: false, error: 'Daily MCP limit reached.',
      error_code: -32029, error_data: { type: 'cap_exceeded', scope: 'daily' },
    };
    const { code, stdout } = await runCli(['tabs']);
    assert.equal(code, 5, stdout);
  });

  it('leaves an untyped failure as a generic one', async () => {
    // The fallback must stay put: no data, no code, nothing to branch on.
    nextAck = { success: false, error: 'something broke' };
    const { code } = await runCli(['tabs']);
    assert.equal(code, 1);
  });
});
