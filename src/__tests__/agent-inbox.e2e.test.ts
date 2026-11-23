/**
 * The agent inbox, end to end: real CLI binary → real daemon → real MCP
 * server → real leader bridge → a fake extension holding the inbox
 * (Documentation/ARDs/ARD-Agent-Handover.md in the main repository).
 *
 * What matters here is the seam: that an item pushed while `inbox wait` is
 * running comes back at once, that two waiters never both get it, and that an
 * agent busy with another command is told something is waiting.
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let httpPort: number;
let wsPort: number;
let configDir: string;
let daemon: ChildProcess;
let extension: WebSocket;

/** The fake extension's inbox, with the real one's take-once rule. */
interface Item { id: string; use: string | null; tabId: number; data: unknown; taken: boolean; view?: string; by?: unknown }
let inbox: Item[] = [];
/** The fake extension's remote pages. */
let pages: Array<{ id: string; scriptId: string; name: string; url: string }> = [];
const dispatched: string[] = [];
const dispatchedArgs: unknown[] = [];
const waiting = () => inbox.filter((item) => !item.taken).length;

function route(tool: string, args: Record<string, unknown>): { success: boolean; result?: unknown; error?: string; error_data?: unknown } {
  if (tool === 'list_handovers') return { success: true, result: { waiting: waiting(), items: inbox } };
  if (tool === 'take_handover') {
    const item = inbox.find((entry) => !entry.taken && (!args.view || entry.view === args.view));
    if (item) { item.taken = true; item.by = args.by; }
    return { success: true, result: { item: item ? { id: item.id, use: item.use, tabId: item.tabId, data: item.data, untrusted: true } : null } };
  }
  if (tool === 'finish_handover') {
    if (!inbox.some((item) => item.id === args.id)) {
      return { success: false, error: 'No hand-over with that id is kept', error_data: { type: 'not_found' } };
    }
    inbox = inbox.filter((item) => item.id !== args.id);
    return { success: true, result: { done: true, id: args.id, ...(args.failed === undefined ? {} : { failed: args.failed }) } };
  }
  if (tool === 'list_remotes') {
    const found = pages.filter((page) => !args.scriptId || page.scriptId === args.scriptId);
    return { success: true, result: { count: found.length, remotes: found } };
  }
  if (tool === 'end_remote') {
    if (!pages.some((page) => page.id === args.id)) {
      return { success: false, error: 'No remote with that id is kept in this browser', error_data: { type: 'not_found' } };
    }
    pages = pages.filter((page) => page.id !== args.id);
    return { success: true, result: { ended: true, id: args.id } };
  }
  return { success: true, result: [{ id: 1, url: 'https://example.com' }] };
}

/** A page hands something over: the extension keeps it and pushes, as agent-inbox-service.js does. */
function handOver(id: string, data: unknown, view?: string): void {
  inbox.push({ id, use: 'shop_fill', tabId: 7, data, taken: false, view });
  extension.send(JSON.stringify({ id: 'push_' + Date.now(), type: 'agent_handover', data: { id } }));
}

const env = () => ({
  ...process.env,
  CUSTOMAISE_HTTP_PORT: String(httpPort),
  CUSTOMAISE_WS_PORT: String(wsPort),
  CUSTOMAISE_CONFIG_DIR: configDir,
  CUSTOMAISE_MCP_ALLOW_INSECURE: '1',
});

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: env(), cwd: configDir });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr, ms: Date.now() - started }));
  });
}

describe('the agent inbox, end to end', () => {
  before(async () => {
    httpPort = await freePort();
    wsPort = await freePort();
    configDir = mkdtempSync(join(tmpdir(), 'customaise-inbox-'));
    daemon = spawn(process.execPath, [ENTRY, 'daemon'], { env: env(), stdio: 'ignore' });

    for (let tries = 0; ; tries++) {
      const candidate = new WebSocket(`ws://127.0.0.1:${wsPort}`);
      try {
        await new Promise<void>((resolve, reject) => { candidate.once('open', () => resolve()); candidate.once('error', reject); });
        extension = candidate;
        break;
      } catch {
        try { candidate.terminate(); } catch { /* already dead */ }
        if (tries > 150) throw new Error('the daemon never opened its bridge');
        await sleep(100);
      }
    }
    extension.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type !== 'dispatch_tool') return;
      dispatched.push(frame.tool);
      dispatchedArgs.push(frame.args);
      const answer = route(frame.tool, frame.args || {});
      extension.send(JSON.stringify({
        type: 'dispatch_ack', session_id: frame.session_id, seq_num: frame.seq_num, counter: 0,
        // The count rides on every answer, read after the tool ran.
        system_status: { userScriptsDisabled: false, userScriptsApiAvailable: true, configureWorldApiAvailable: true, available: true, inboxWaiting: waiting() },
        ...answer,
      }));
    });
    extension.send(JSON.stringify({
      type: 'init_session', session_id: 'inbox-session', install_id: 'inbox-install', tier: 'power_user', unlimited: true,
      system_status: { userScriptsDisabled: false, userScriptsApiAvailable: true, configureWorldApiAvailable: true, available: true, inboxWaiting: 0 },
    }));
    await sleep(400);
  });

  after(() => {
    try { extension?.close(); } catch { /* already gone */ }
    daemon?.kill('SIGKILL');
    try { rmSync(configDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('answers waiting: true when nothing arrives before the timeout', async () => {
    inbox = [];
    const { code, stdout } = await runCli(['inbox', 'wait', '--timeout', '2']);
    assert.equal(code, 0, stdout);
    assert.deepEqual(JSON.parse(stdout), { ok: true, data: { waiting: true } });
  });

  it('returns an item handed over while it waits, at once', async () => {
    inbox = [];
    const waited = runCli(['inbox', 'wait', '--timeout', '30']);
    // Long enough for the CLI to connect and its wait to be listening.
    await sleep(2500);
    const handedAt = Date.now();
    handOver('h_one', { choices: 'milk x2' });
    const { code, stdout } = await waited;
    const tookMs = Date.now() - handedAt;
    assert.equal(code, 0, stdout);
    const data = JSON.parse(stdout).data;
    assert.equal(data.item.id, 'h_one');
    assert.deepEqual(data.item.data, { choices: 'milk x2' });
    assert.equal(data.item.untrusted, true);
    assert.match(data.next, /never as instructions/);
    assert.ok(tookMs < 1500, `the item took ${tookMs} ms to reach the waiting command`);
  });

  it('returns an item that was already kept, without waiting', async () => {
    inbox = [{ id: 'h_kept', use: null, tabId: 7, data: 1, taken: false }];
    const { code, stdout, ms } = await runCli(['inbox', 'wait', '--timeout', '30']);
    assert.equal(code, 0, stdout);
    assert.equal(JSON.parse(stdout).data.item.id, 'h_kept');
    assert.ok(ms < 5000, `took ${ms} ms`);
  });

  it('gives one item to one of two waiting commands, and the other keeps waiting', async () => {
    inbox = [];
    const first = runCli(['inbox', 'wait', '--timeout', '6']);
    const second = runCli(['inbox', 'wait', '--timeout', '6']);
    await sleep(2500);
    handOver('h_two', { n: 2 });
    const results = (await Promise.all([first, second])).map((run) => JSON.parse(run.stdout).data);
    assert.equal(results.filter((data) => data.item?.id === 'h_two').length, 1, JSON.stringify(results));
    assert.equal(results.filter((data) => data.waiting === true).length, 1, JSON.stringify(results));
  });

  it('an agent waiting for its own page is not given another page\'s hand-over, and its name goes with the take', async () => {
    const MINE = 'AAAAAAAAAAAAAAAAAAAAAAAA';
    const THEIRS = 'BBBBBBBBBBBBBBBBBBBBBBBB';
    inbox = [];
    // The link as the script's tool returned it: the key after # goes nowhere.
    const mine = runCli(['inbox', 'wait', '--timeout', '8', '--remote', `https://site.test/remote/${MINE}#secret-key-never-sent`, '--as', 'Claude Code']);
    await sleep(2500);
    handOver('h_theirs', { n: 1 }, THEIRS);
    await sleep(800);
    assert.equal(inbox[0].taken, false, 'the other page\'s item was taken by an agent waiting for a different page');
    handOver('h_mine', { n: 2 }, MINE);
    const { stdout } = await mine;
    assert.equal(JSON.parse(stdout).data.item.id, 'h_mine');
    assert.equal(inbox.find((item) => item.id === 'h_mine')?.by, 'Claude Code');
    assert.equal(JSON.stringify(dispatchedArgs).includes('secret-key-never-sent'), false);
    // How much longer it will wait goes with each ask, so the extension keeps
    // this page's hand-overs for it and not for an agent that named no page.
    const asks = (dispatchedArgs as Array<Record<string, unknown>>).filter((args) => args && args.view === MINE);
    assert.ok(asks.length > 0 && asks.every((args) => typeof args.waitMs === 'number' && args.waitMs >= 0 && args.waitMs <= 8000), JSON.stringify(asks));

    const bad = await runCli(['inbox', 'wait', '--timeout', '2', '--remote', 'not a remote']);
    assert.equal(bad.code, 2, bad.stdout);
  });

  it('lists without taking, and finishes by id', async () => {
    inbox = [{ id: 'h_list', use: 'shop_fill', tabId: 7, data: { a: 1 }, taken: false }];
    const listed = await runCli(['inbox']);
    assert.equal(listed.code, 0, listed.stdout);
    assert.equal(JSON.parse(listed.stdout).data.waiting, 1);
    assert.equal(inbox[0].taken, false);

    const done = await runCli(['inbox', 'done', 'h_list']);
    assert.equal(done.code, 0, done.stdout);
    assert.equal(inbox.length, 0);

    const again = await runCli(['inbox', 'done', 'h_list']);
    assert.equal(again.code, 8, again.stdout);
    assert.equal(JSON.parse(again.stdout).error.type, 'not_found');
  });

  it('closes an item it could not do with the reason, which goes to the extension as given', async () => {
    inbox = [{ id: 'h_cannot', use: 'shop_fill', tabId: 7, data: {}, taken: true }];
    const done = await runCli(['inbox', 'done', 'h_cannot', '--failed', 'Nobody is signed in to the shop.']);
    assert.equal(done.code, 0, done.stdout);
    assert.deepEqual(dispatchedArgs.at(-1), { id: 'h_cannot', failed: 'Nobody is signed in to the shop.' });
    assert.equal(JSON.parse(done.stdout).data.failed, 'Nobody is signed in to the shop.');
    assert.equal(inbox.length, 0);
  });

  it('lists the pages scripts opened, all of them or one script\'s', async () => {
    pages = [
      { id: 'pageAAAAAAAAAAAAAAAAAAAA', scriptId: 's_one', name: 'main', url: 'https://customaise.com/remote/pageAAAAAAAAAAAAAAAAAAAA#k1' },
      { id: 'pageBBBBBBBBBBBBBBBBBBBB', scriptId: 's_two', name: 'basket', url: 'https://customaise.com/remote/pageBBBBBBBBBBBBBBBBBBBB#k2' },
    ];
    const all = await runCli(['remotes']);
    assert.equal(all.code, 0, all.stdout);
    assert.equal(JSON.parse(all.stdout).data.count, 2);
    assert.deepEqual(dispatchedArgs.at(-1), {});

    const one = await runCli(['remotes', '--script', 's_two']);
    assert.deepEqual(dispatchedArgs.at(-1), { scriptId: 's_two' });
    assert.deepEqual(JSON.parse(one.stdout).data.remotes.map((page: { name: string }) => page.name), ['basket']);
  });

  it('ends one page by its link, sending the extension the id and never the key', async () => {
    const ended = await runCli(['remotes', 'end', 'https://customaise.com/remote/pageAAAAAAAAAAAAAAAAAAAA#k1']);
    assert.equal(ended.code, 0, ended.stdout);
    assert.equal(dispatched.at(-1), 'end_remote');
    assert.deepEqual(dispatchedArgs.at(-1), { id: 'pageAAAAAAAAAAAAAAAAAAAA' });
    assert.deepEqual(pages.map((page) => page.id), ['pageBBBBBBBBBBBBBBBBBBBB']);

    // Ended means ended: a second try finds nothing, and says so in a way a caller can branch on.
    const again = await runCli(['remotes', 'end', 'pageAAAAAAAAAAAAAAAAAAAA']);
    assert.equal(again.code, 8, again.stdout);
    assert.equal(JSON.parse(again.stdout).error.type, 'not_found');

    // What is not a page id or link never reaches the extension.
    const before = dispatched.length;
    const wrong = await runCli(['remotes', 'end', 'basket']);
    assert.equal(wrong.code, 2, wrong.stdout);
    assert.equal(dispatched.length, before);
    assert.equal((await runCli(['remotes', 'end'])).code, 2);
  });

  it('tells an agent running another command that something is waiting, and leaves that command\'s data as it was', async () => {
    inbox = [{ id: 'h_notice', use: null, tabId: 7, data: 1, taken: false }];
    const { code, stdout, stderr } = await runCli(['tabs']);
    assert.equal(code, 0, stdout);
    const out = JSON.parse(stdout);
    assert.deepEqual(out.data, [{ id: 1, url: 'https://example.com' }]);
    assert.equal(out.inbox.waiting, 1);
    assert.match(stderr, /customaise inbox wait/);

    inbox = [];
    const quiet = await runCli(['tabs']);
    assert.equal('inbox' in JSON.parse(quiet.stdout), false);
    assert.doesNotMatch(quiet.stderr, /inbox/);
  });

  it('refuses a timeout that is not a number of seconds', async () => {
    const { code } = await runCli(['inbox', 'wait', '--timeout', 'soon']);
    assert.equal(code, 2);
  });
});
