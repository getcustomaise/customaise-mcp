/**
 * Daemon — the resident half of the CLI control plane.
 *
 * Two independent things, on two independent ports, and conflating them
 * would break the common case:
 *
 *   • The loopback MCP endpoint is the daemon's identity. It owns that port
 *     unconditionally, and contention for it is how two racing spawns are
 *     resolved: the loser sees EADDRINUSE and exits 0.
 *
 *   • The `Bridge` to the extension is on :4050, and `createBridge()`
 *     decides the role exactly as it does for every IDE server. A follower
 *     daemon is the NORMAL case, not a degraded one. An IDE usually holds
 *     :4050 already, and a daemon that insisted on leadership would refuse
 *     to start for precisely the developer this CLI is for. A follower's
 *     dispatches are relayed by the leader with cap enforcement and HITL
 *     intact.
 *
 * The token is minted only after the bind succeeds, which does double duty:
 * a visible token file implies a live endpoint, and two daemons can never
 * both write one because only one gets past `listen()`.
 */

import http from 'node:http';
import { mkdirSync, writeFileSync, renameSync, rmSync, readFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createBridge } from './bridge.js';
import { FileWatcher } from './file-watcher.js';
import { createServerFactory, PKG_VERSION } from './build-server.js';
import { resolvePushTarget } from './push-target.js';
import { withRequestContext } from './request-context.js';

export const DEFAULT_HTTP_PORT = 4051;
export const TOKEN_HEADER = 'x-customaise-token';
/**
 * Where the calling CLI is standing.
 *
 * The daemon was spawned once from whatever directory the first invocation
 * happened to be in and then outlived it, so its own cwd is meaningless.
 * Callers say where they are, per request.
 */
export const WORKSPACE_HEADER = 'x-customaise-workspace';

/** Where the daemon's token lives. Same resolution in the daemon and the CLI. */
export function tokenPath(): string {
  const base = process.env.CUSTOMAISE_CONFIG_DIR
    || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'customaise');
  return join(base, 'daemon.json');
}

export interface DaemonRecord {
  token: string;
  port: number;
  pid: number;
  version: string;
}

export function readDaemonRecord(): DaemonRecord | null {
  try {
    const raw = JSON.parse(readFileSync(tokenPath(), 'utf-8'));
    if (typeof raw?.token === 'string' && typeof raw?.port === 'number') return raw as DaemonRecord;
  } catch { /* absent or unreadable is the same answer */ }
  return null;
}

/**
 * Whether a presented token is the daemon's, compared in constant time.
 *
 * `!==` on a secret leaks its prefix through timing. Over loopback with a
 * 192-bit token that is not a practical attack, and an attacker who can time
 * it can usually read the token file instead. It is two lines, and "we
 * compare secrets in constant time" is a better answer to a security
 * reviewer than an argument about why the leak does not matter here.
 *
 * The length check short-circuits before the comparison because
 * `timingSafeEqual` throws on unequal lengths. That leaks the token's
 * length, which is fixed at 48 hex characters and not secret.
 */
function tokenMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function writeDaemonRecord(rec: DaemonRecord): void {
  const p = tokenPath();
  // 0700 on the directory, not just 0600 on the file. The file is what holds
  // the secret, but a world-listable directory tells another user on the box
  // that a daemon is running here and what it is called. chmod separately
  // because `recursive: true` only applies mode to directories it creates,
  // and this one usually already exists from a previous run.
  const dir = dirname(p);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best effort: Windows has no equivalent */ }
  const tmp = p + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
}

function clearDaemonRecord(port: number): void {
  const rec = readDaemonRecord();
  // Only clear a record that is ours. A daemon that lost the bind must not
  // delete the winner's token on its way out.
  if (rec && rec.pid === process.pid && rec.port === port) {
    try { rmSync(tokenPath(), { force: true }); } catch { /* best effort */ }
  }
}

export interface DaemonOptions {
  port?: number;
  wsPort?: number;
  /** Arm the sync_scripts file watcher. Off by default in daemon mode. */
  watch?: boolean;
  /** Shut down after this long with no request and no extension attached. */
  idleMs?: number;
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<void> {
  const port = opts.port ?? (Number(process.env.CUSTOMAISE_HTTP_PORT) || DEFAULT_HTTP_PORT);
  const wsPort = opts.wsPort ?? (Number(process.env.CUSTOMAISE_WS_PORT) || 4050);
  const idleMs = opts.idleMs ?? 30 * 60 * 1000;

  const bridge = await createBridge(wsPort);
  // Off unless asked for. See the FileWatcher docstring: a resident daemon
  // writing scripts into the browser unattended, and spending a cap unit per
  // file save, is not a default anyone chose.
  const fileWatcher = new FileWatcher(bridge, { enabled: opts.watch === true });
  const token = randomBytes(24).toString('hex');
  const factory = createServerFactory({
    bridge,
    fileWatcher,
    resolvePushTarget: () => resolvePushTarget(activeWorkspaces),
  });
  const handler = createMcpHandler(factory);

  /**
   * Workspaces that have spoken to this daemon recently, and when. The policy
   * that reads it lives in `push-target.ts`; this is just the state.
   */
  const activeWorkspaces = new Map<string, number>();

  let lastActivity = Date.now();
  // Fallback for a request that arrives without the workspace header, so a
  // tool still resolves paths somewhere sensible. Pushes do NOT read this:
  // they go through `pushTarget()`, which refuses to guess between several
  // active workspaces. See `activeWorkspaces` above.
  let lastWorkspace: string | undefined;

  const server = http.createServer(async (req, res) => {
    lastActivity = Date.now();
    if (!tokenMatches(req.headers[TOKEN_HEADER], token)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      // Carry the client's disconnect through as an abort.
      //
      // Without this the whole cancellation path is dead on the door it was
      // built for. A CLI that is Ctrl-C'd closes its socket, and if the
      // `Request` handed to the handler has no signal, `ctx.mcpReq.signal`
      // never fires, the dispatch runs to completion, and the consent modal
      // it was waiting on stays open in the user's browser for its full five
      // minutes with nobody coming back for the answer.
      //
      // `close` covers both a clean close and an abort; the `aborted` guard
      // keeps a normally-completed request from signalling one.
      const ac = new AbortController();
      const onClientGone = () => { if (!res.writableEnded) ac.abort(); };
      req.on('aborted', onClientGone);
      res.on('close', onClientGone);

      const request = new Request('http://127.0.0.1:' + port + (req.url ?? '/'), {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
        signal: ac.signal,
        // @ts-expect-error Node requires duplex for a streaming body
        duplex: 'half',
      });
      // Attach the caller's workspace for the length of this request, and
      // remember it for unsolicited pushes, which have no request to read.
      const declared = req.headers[WORKSPACE_HEADER];
      if (typeof declared === 'string' && declared) {
        lastWorkspace = declared;
        activeWorkspaces.set(declared, Date.now());
      }

      const out = await withRequestContext(
        { workspaceDir: typeof declared === 'string' ? declared : lastWorkspace },
        () => handler.fetch(request),
      );
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
    } catch (err: any) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message || 'daemon error' }));
    }
  });

  let shuttingDown = false;
  let idleTimer: ReturnType<typeof setInterval> | null = null;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (idleTimer) clearInterval(idleTimer);
    clearDaemonRecord(port);
    // Stop accepting immediately so a replacement can bind straight away.
    await new Promise<void>((r) => server.close(() => r()));
    fileWatcher.stop();
    await bridge.close();
    process.exit(0);
  };

  await new Promise<void>((resolve, reject) => {
    server.on('error', (err: any) => {
      if (err?.code === 'EADDRINUSE') {
        // Another daemon won the race. Say so and leave; the CLI that
        // spawned us is polling the endpoint, and the winner will serve it.
        process.stderr.write('[customaise-daemon] :' + port + ' already served, exiting\n');
        process.exit(0);
      }
      reject(err);
    });
    // Loopback only. Never 0.0.0.0: this endpoint reaches a signed-in browser.
    server.listen(port, '127.0.0.1', resolve);
  });

  writeDaemonRecord({ token, port, pid: process.pid, version: PKG_VERSION });
  process.stderr.write(
    '[customaise-daemon] ' + PKG_VERSION + ' listening on 127.0.0.1:' + port +
    ' (bridge role=' + bridge.role + ')\n'
  );

  process.stderr.write(opts.watch
    ? '[customaise-daemon] auto-export enabled (--watch)\n'
    : '[customaise-daemon] auto-export off; sync_scripts will export once and not watch\n');

  // Idle exit, but never while an extension is actually attached: dropping
  // its socket costs the next command up to five minutes of rediscovery.
  //
  // The condition is `isConnected`, not `role`. Holding `:4050` says nothing
  // about whether Chrome is running, and an earlier version of this guard
  // checked the role: a leader daemon with no extension attached would then
  // never exit, which is precisely the case where exiting is free.
  idleTimer = setInterval(() => {
    if (Date.now() - lastActivity < idleMs) return;
    if (bridge.isConnected) return;
    process.stderr.write('[customaise-daemon] idle, shutting down\n');
    void shutdown();
  }, 60_000);
  idleTimer.unref?.();

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
