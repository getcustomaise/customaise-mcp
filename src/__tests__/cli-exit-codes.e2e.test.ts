/**
 * The exit-code contract, driven end to end through every real layer.
 *
 * Real CLI binary → real daemon over loopback HTTP → real MCP server → real
 * leader bridge → a fake extension standing in for Chrome. Only the browser
 * is simulated, and only because a cap cannot be tripped on an account that
 * resolves to `unlimited`.
 *
 * This exists because every bug that mattered lived in the wiring, not the
 * logic. `cap-state.ts` had unit tests proving it returns MCP_CAP_EXCEEDED,
 * and separately the CLI had unit tests proving `cap_exceeded` maps to exit
 * 5, and in between the two the error arrived with its type stripped and the
 * CLI exited 1. Exits 6 and 7 were unreachable for the same reason, and the
 * commonest failure of all, Chrome not running, came back `internal_error`.
 * Testing each half proves nothing about the seam; this tests the seam.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { mkdtempSync, rmSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { workspaceHeaders } from '../daemon-http.js';

function pkgRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'dist'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('could not locate the package root (run `npm run build` first)');
}

const ROOT = pkgRoot();
const CLI = join(ROOT, 'dist', 'cli', 'index.js');
const ENTRY = join(ROOT, 'dist', 'index.js');

/** An ephemeral port the OS just told us is free. */
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

async function until(predicate: () => Promise<boolean> | boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** How the fake extension answers the next dispatch. */
type Ack = {
  success: boolean;
  result?: unknown;
  error?: string;
  error_code?: number;
  error_data?: unknown;
};

let httpPort: number;
let wsPort: number;
let configDir: string;
let daemon: ChildProcess;
let extension: WebSocket;
let nextAck: Ack = { success: true, result: [] };
/** Every tool the extension was actually asked to run. One entry, one cap unit. */
const dispatched: string[] = [];
/** Every hello frame the daemon sent: its client list, as the sidebar sees it. */
const hellos: Array<{ clients?: Array<{ name: string; version: string; role: string }> }> = [];
/** The master-gate state the fake extension reports, as the real one does. */
let systemStatus: Record<string, boolean> | null = null;
const initSession: Record<string, unknown> = {
  type: 'init_session',
  session_id: 'test-session',
  install_id: 'test-install',
  tier: 'free',
  daily_cap: 50,
  weekly_cap: 150,
  current_used_daily: 0,
  current_used_week: 0,
};

const env = () => ({
  ...process.env,
  CUSTOMAISE_HTTP_PORT: String(httpPort),
  CUSTOMAISE_WS_PORT: String(wsPort),
  CUSTOMAISE_CONFIG_DIR: configDir,
  CUSTOMAISE_MCP_ALLOW_INSECURE: '1',
});

/** Run the real CLI binary and resolve its exit code and stdout. */
function runCli(args: string[], cwd = configDir): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: env(), cwd });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Dial the fake extension into the daemon's bridge and answer dispatches.
 *
 * A function rather than inline setup because the disconnect case has to
 * close this socket, and a test that leaves shared state broken for whatever
 * runs next is a test that passes only in the order it was written.
 */
async function connectExtension(): Promise<void> {
  await until(async () => {
    const candidate = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    candidate.on('message', raw => {
      const frame = JSON.parse(String(raw));
      if (frame.role === 'hello') hellos.push(frame);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        candidate.once('open', () => resolve());
        candidate.once('error', reject);
      });
      extension = candidate;
      return true;
    } catch {
      // Close the failed attempt; the retry loop would otherwise leave one
      // half-open socket per tick.
      try { candidate.terminate(); } catch { /* already dead */ }
      return false;
    }
  });

  extension.on('message', (raw) => {
    const frame = JSON.parse(String(raw));
    if (frame.type === 'dispatch_tool') {
      dispatched.push(frame.tool);
      if (frame.tool === 'export_script') extension.send(JSON.stringify({
        type: 'dispatch_tool_pending', session_id: frame.session_id, seq_num: frame.seq_num,
        expected_timeout_ms: 90_000,
        reason: `script_save:normalization (${frame.args.saveOperationId}) script=${frame.args.scriptId}`,
      }));
      extension.send(JSON.stringify({
        type: 'dispatch_ack',
        session_id: frame.session_id,
        seq_num: frame.seq_num,
        counter: 1,
        system_status: systemStatus,
        ...nextAck,
      }));
    }
  });

  extension.send(JSON.stringify({ ...initSession, system_status: systemStatus }));
  // Let init_session land before the first dispatch, so the session resolves
  // to 'capped' rather than staying 'pending'.
  await new Promise((r) => setTimeout(r, 400));
}

/** Drop and re-open the extension link so a fresh init_session is announced. */
async function reconnectExtension(): Promise<void> {
  extension.close();
  await new Promise((r) => setTimeout(r, 400));
  await connectExtension();
}

describe('CLI exit codes, end to end', () => {
  before(async () => {
    httpPort = await freePort();
    wsPort = await freePort();
    configDir = mkdtempSync(join(tmpdir(), 'customaise-e2e-'));

    daemon = spawn(process.execPath, [ENTRY, 'daemon'], { env: env(), stdio: 'ignore' });

    await connectExtension();
  });

  after(async () => {
    try { extension?.close(); } catch { /* already gone */ }
    daemon?.kill('SIGKILL');
    try { rmSync(configDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('exits 0 and emits JSON when the extension answers', async () => {
    nextAck = { success: true, result: [{ id: 1, url: 'https://example.com' }] };
    const { code, stdout } = await runCli(['tabs']);
    assert.equal(code, 0, stdout);
    assert.equal(JSON.parse(stdout).ok, true);
  });

  it('doctor can reconcile a specific save through authenticated dispatch', async () => {
    nextAck = { success: true, result: { scriptId: 's1', operationId: 'lost-ack', outcome: 'committed' } };
    const before = dispatched.length;
    const result = await runCli(['doctor', '--script', 's1', '--operation', 'lost-ack']);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).data.saveStatus.outcome, 'committed');
    assert.deepEqual(dispatched.slice(before), ['get_script_save_status']);
  });

  it('writes real context files into each HTTP caller workspace and rejects a missing declaration', async () => {
    nextAck = { success: true, result: { overview: { url: 'https://example.com', title: 'Fixture' }, elements: [] } };
    const record = JSON.parse(readFileSync(join(configDir, 'daemon.json'), 'utf8'));
    assert.equal(record.workspaceEncoding, 'uri');
    const url = new URL(`http://127.0.0.1:${httpPort}/mcp`);
    const dirs = ['project-a', '日本語 %2F'].map(name => join(configDir, name));
    await Promise.all(dirs.map(async (dir) => {
      mkdirSync(dir);
      const client = new Client({ name: 'workspace-test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
      try {
        await client.connect(new StreamableHTTPClientTransport(url, { requestInit: {
          headers: { 'x-customaise-token': record.token, ...workspaceHeaders(dir, true) },
        } }));
        const result = await client.callTool({ name: 'get_page_context', arguments: { tabId: 1, output: 'file' } });
        assert.equal(result.isError, undefined, JSON.stringify(result));
        assert.equal((result.structuredContent as any).filePath, join(dir, '.customaise', 'page-context.json'));
        assert.equal(JSON.parse(readFileSync(join(dir, '.customaise', 'page-context.json'), 'utf8')).overview.title, 'Fixture');
      } finally { await client.close(); }
    }));
    const unicodeCli = await runCli(['tabs'], dirs[1]);
    assert.equal(unicodeCli.code, 0, unicodeCli.stderr);
    const before = dispatched.length;
    const rejected = await fetch(url, { method: 'POST', headers: { 'x-customaise-token': record.token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_page_context', arguments: { tabId: 1 } } }) });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).outcome, 'not_dispatched');
    assert.equal(dispatched.length, before);
    assert.equal(existsSync(join(configDir, '.customaise', 'page-context.json')), false);
  });

  it('the daemon keeps its own name in the client list after serving a CLI call', async () => {
    // The previous test ran a real `customaise` command through this daemon.
    // The factory reports the first MCP client's identity as the process's
    // own, which is right for a stdio server (it IS its IDE) and wrong here:
    // the daemon named itself once, and the CLI that passed through must not
    // rename it. Every hello since, including the latest, must still say so.
    assert.ok(hellos.length > 0, 'the daemon never sent a hello frame');
    const latest = hellos[hellos.length - 1];
    const leader = (latest.clients ?? []).find((c) => c.role === 'leader');
    assert.ok(leader, 'no leader row: the daemon is invisible in its own list');
    assert.equal(leader!.name, 'customaise daemon');
    assert.ok(!(latest.clients ?? []).some((c) => c.name === 'customaise-cli'),
      'a passing CLI invocation must not appear as a resident client');
  });

  it('exits 4 when the extension says sign-in is required', async () => {
    nextAck = {
      success: false,
      error: 'Customaise sign-in required.',
      error_code: -32028,
      error_data: { type: 'auth_required', reason: 'NOT_AUTHENTICATED' },
    };
    const { code, stdout } = await runCli(['tabs']);
    assert.equal(code, 4, stdout);
    assert.equal(JSON.parse(stdout).error.type, 'auth_required');
  });

  it('exits 5 when the free-tier cap is reached', async () => {
    nextAck = {
      success: false,
      error: 'Daily MCP limit reached.',
      error_code: -32029,
      error_data: { type: 'cap_exceeded', scope: 'daily' },
    };
    const { code, stdout } = await runCli(['tabs']);
    assert.equal(code, 5, stdout);
    assert.equal(JSON.parse(stdout).error.type, 'cap_exceeded');
  });

  it('exits 6 when the user denies consent', async () => {
    // The gate refuses without a numeric code; the type is the whole signal,
    // which is exactly the path that used to lose it and exit 1.
    nextAck = {
      success: false,
      error: 'The user denied this tool call.',
      error_data: { type: 'consent_denied' },
    };
    const { code, stdout } = await runCli(['tabs']);
    assert.equal(code, 6, stdout);
    assert.equal(JSON.parse(stdout).error.type, 'consent_denied');
  });

  it('exits 7 when consent expires unanswered', async () => {
    nextAck = {
      success: false,
      error: 'The consent request timed out.',
      error_data: { type: 'consent_timeout' },
    };
    const { code, stdout } = await runCli(['tabs']);
    assert.equal(code, 7, stdout);
    assert.equal(JSON.parse(stdout).error.type, 'consent_timeout');
  });

  it('exits 8 when the sanitization pipeline rejects a script', async () => {
    nextAck = {
      success: true,
      result: {
        success: false,
        diagnostics: { code: 'SYNTAX_ERROR', message: 'Failed canonical parse.', hint: 'Fix the syntax.' },
      },
    };
    const { code, stdout, stderr } = await runCli(['scripts', 'install', CLI]);
    assert.equal(code, 8, stdout + stderr);
    assert.match(stderr, /Failed canonical parse\. Fix the syntax\./);
    assert.match(stderr, /script_save:normalization .*script=mcp_script_/);
  });

  it('exits 3 when the extension goes away', async () => {
    extension.close();
    await new Promise((r) => setTimeout(r, 500));
    try {
      const { code, stdout } = await runCli(['tabs']);
      assert.equal(code, 3, stdout);
      assert.match(JSON.parse(stdout).error.type, /extension_not_connected|dispatch_timeout/);
    } finally {
      // Restore it, so this case does not have to be last and the next one
      // added after it does not fail for a reason that has nothing to do
      // with what it is testing.
      await connectExtension();
    }
  });

  it('recovers once the extension reconnects', async () => {
    // Also proves the restore above actually works, rather than being a
    // comment claiming it does.
    nextAck = { success: true, result: [] };
    const { code } = await runCli(['tabs']);
    assert.equal(code, 0);
  });

  describe('the diagnostics do not spend the budget they report on', () => {
    it('doctor costs zero cap units', async () => {
      // It used to call `list_tabs`, so working out why MCP was failing spent
      // one of the fifty daily calls that might be why it was failing.
      // `get_bridge_status` reads the CapSession the server already holds from
      // init_session and never reaches the extension at all.
      dispatched.length = 0;
      const { code, stdout } = await runCli(['doctor']);
      assert.equal(code, 0, stdout);
      assert.deepEqual(dispatched, [], 'doctor must not dispatch anything');
    });

    it('doctor reports the fields the design asked for', async () => {
      const { stdout } = await runCli(['doctor']);
      const data = JSON.parse(stdout).data;
      for (const field of ['cli', 'daemon', 'node', 'endpoint', 'extension', 'signedIn', 'tier', 'cap', 'remoteApprovals']) {
        assert.ok(field in data, `doctor is missing ${field}`);
      }
      // init_session in this harness says free with a 50/150 cap.
      assert.equal(data.tier, 'free');
      assert.match(String(data.cap), /today/);
    });

    it('the core loop bills one unit per call, not two', async () => {
      // `checkUserScriptsGate()` used to be a second dispatch on five tools:
      // list_scripts, export_script, reload_tab, list_webmcp_tools and
      // call_webmcp_tool. So install, reload, list, call billed EIGHT units
      // instead of four, and the free tier's real budget for the documented
      // loop was half what it advertises. The gate now rides in on the ack.
      dispatched.length = 0;
      nextAck = { success: true, result: [] };
      await runCli(['scripts', 'list']);
      assert.deepEqual(dispatched, ['list_scripts'],
        'list_scripts must not also fetch the master-gate state');

      dispatched.length = 0;
      await runCli(['tools', '--tab', '1']);
      assert.deepEqual(dispatched, ['list_webmcp_tools']);

      dispatched.length = 0;
      await runCli(['tab', 'reload', '1']);
      assert.deepEqual(dispatched, ['reload_tab']);
    });

    it('never dispatches get_system_status at all', async () => {
      // Reading it off the ack is the whole point. A reappearance means
      // someone reintroduced the fetch.
      dispatched.length = 0;
      nextAck = { success: true, result: [] };
      await runCli(['scripts', 'list']);
      await runCli(['tabs']);
      assert.ok(!dispatched.includes('get_system_status'),
        `get_system_status was dispatched: ${dispatched.join(', ')}`);
    });

    it('tells the user when the master gate is off', async () => {
      // The banner used to reach only the `content` half, which a model reads.
      // A terminal agent got silence in exactly the situation it exists for:
      // installs succeed, no tool ever registers, and nothing says the
      // "Allow user scripts" toggle is off. That toggle resets on every
      // Chrome restart, so it is not an edge case.
      nextAck = { success: true, result: [] };
      systemStatus = { userScriptsDisabled: true, userScriptsApiAvailable: true,
                       configureWorldApiAvailable: true, available: true };
      // Force a fresh init_session so the leader adopts the new gate state.
      await reconnectExtension();

      const { stderr } = await runCli(['scripts', 'list']);
      assert.match(stderr, /Allow user scripts.*is OFF/i,
        'the CLI said nothing about the gate');
      assert.match(stderr, /resets every time Chrome restarts/i,
        'it should say why it keeps happening');
    });

    it('doctor refuses to report healthy while the gate is off', async () => {
      // Nothing will work, so exiting 0 would be a lie an agent plans against.
      const { code, stdout } = await runCli(['doctor']);
      assert.equal(code, 3, stdout);
      assert.equal(JSON.parse(stdout).data.userScripts, 'DISABLED');
    });

    it('and says nothing once the gate is back on', async () => {
      systemStatus = { userScriptsDisabled: false, userScriptsApiAvailable: true,
                       configureWorldApiAvailable: true, available: true };
      await reconnectExtension();
      const { stderr, code } = await runCli(['scripts', 'list']);
      assert.equal(code, 0);
      assert.doesNotMatch(stderr, /Allow user scripts/i,
        'a healthy gate must not nag');
      const doctor = await runCli(['doctor']);
      assert.equal(JSON.parse(doctor.stdout).data.userScripts, 'enabled');
    });

    it('rejects a bare --timeout like every other value flag', async () => {
      const { code } = await runCli(['tools', '--tab']);
      assert.equal(code, 2);
    });
  });
});
