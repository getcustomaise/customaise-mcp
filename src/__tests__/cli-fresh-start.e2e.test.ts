/**
 * The first command an agent runs, on a computer where nothing is running yet.
 *
 * Two things a person watching the extension's connect card depends on:
 *
 *  1. `doctor` starts the daemon, and the extension has not found it yet: it
 *     looks every 3 seconds while its card is open. Answering "not connected"
 *     at once sent an agent off to wait half a minute for a setup that was
 *     already working (24 November 2026). A fresh start waits a moment.
 *
 *  2. The card names the agent the person picked. The daemon called itself
 *     "customaise daemon" whoever drove it, so the card ticked "Any agent"
 *     while the picked tile went on listening. The command line passes on the
 *     name its shell gives it, and the daemon carries it.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, connect } from 'node:net';

function pkgRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'dist'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('could not locate the package root (run `npm run build` first)');
}
const CLI = join(pkgRoot(), 'dist', 'cli', 'index.js');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = (srv.address() as { port: number }).port; srv.close(() => resolve(p)); });
  });
}
function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

let httpPort: number;
let wsPort: number;
let configDir: string;

function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], {
      cwd: configDir,
      env: {
        ...process.env, AI_AGENT: '', CLAUDECODE: '',
        CUSTOMAISE_HTTP_PORT: String(httpPort), CUSTOMAISE_WS_PORT: String(wsPort),
        CUSTOMAISE_CONFIG_DIR: configDir, CUSTOMAISE_MCP_ALLOW_INSECURE: '1',
        ...extraEnv,
      },
    });
    let stdout = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.resume();
    p.on('close', (code) => resolve({ code: code ?? -1, stdout }));
  });
}

/** An extension that finds the daemon `lateMs` after its port opens, as one that looks every few seconds does. */
function lateExtension(lateMs: number) {
  const hellos: Array<{ clients?: Array<{ name: string; role: string }> }> = [];
  let socket: WebSocket | null = null;
  let stopped = false;
  void (async () => {
    while (!stopped && !(await portOpen(wsPort))) await sleep(50);
    await sleep(lateMs);
    while (!stopped) {
      const candidate = new WebSocket(`ws://127.0.0.1:${wsPort}`);
      candidate.on('message', (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.role === 'hello') hellos.push(frame);
        if (frame.type === 'dispatch_tool') candidate.send(JSON.stringify({
          type: 'dispatch_ack', session_id: frame.session_id, seq_num: frame.seq_num, success: true, counter: 1, result: [],
        }));
      });
      try {
        await new Promise<void>((resolve, reject) => { candidate.once('open', () => resolve()); candidate.once('error', reject); });
        socket = candidate;
        candidate.send(JSON.stringify({
          type: 'init_session', session_id: 'fresh', install_id: 'i', tier: 'free',
          daily_cap: 50, weekly_cap: 150, current_used_daily: 0, current_used_week: 0,
        }));
        return;
      } catch { try { candidate.terminate(); } catch { /* gone */ } await sleep(100); }
    }
  })();
  const leaderName = () => (hellos[hellos.length - 1]?.clients ?? []).find((c) => c.role === 'leader')?.name;
  return { hellos, leaderName, stop: () => { stopped = true; try { socket?.close(); } catch { /* gone */ } } };
}

describe('the first command on a computer where nothing is running', { timeout: 60_000 }, () => {
  let extension: ReturnType<typeof lateExtension>;

  before(async () => {
    httpPort = await freePort();
    wsPort = await freePort();
    configDir = mkdtempSync(join(tmpdir(), 'customaise-fresh-'));
  });

  after(async () => {
    extension?.stop();
    await runCli(['daemon', 'stop']).catch(() => {});
    try { rmSync(configDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('doctor waits for the extension to find the daemon it has just started', async () => {
    // The extension arrives a second and a half after the daemon's port
    // opens. A doctor that answered at once said "extension_not_connected"
    // here and exited 3 (run with the wait switched off, 24 November 2026).
    extension = lateExtension(1500);
    const { code, stdout } = await runCli(['doctor'], { AI_AGENT: 'claude-code_2-1-330_agent' });
    assert.equal(code, 0, stdout);
    assert.equal(JSON.parse(stdout).data.extension, 'connected');
  });

  it('the daemon carries the name of the agent at the shell', async () => {
    assert.equal(extension.leaderName(), 'customaise daemon (claude-code)');
  });

  it('a later command from a plain terminal does not take the name away', async () => {
    const { code } = await runCli(['tabs']);
    assert.equal(code, 0);
    assert.equal(extension.leaderName(), 'customaise daemon (claude-code)');
  });
});
