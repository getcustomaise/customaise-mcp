/**
 * Connecting the CLI to the daemon.
 *
 * Three things here are not obvious and each was found the hard way:
 *
 *  1. **A failed connect throws an unhandled asynchronous rejection.** The
 *     version-negotiation probe rejects outside the awaited call, so a
 *     `try`/`catch` around `connect()` catches one error and the process
 *     still dies with a Node stack trace. "The daemon is not running" and
 *     "your token is stale" are the two commonest failures an agent will
 *     hit, so without a guard the two most likely first runs are unreadable.
 *
 *  2. **A v2 client defaults to the 2025 era.** Even against a server that
 *     serves 2026-07-28 by default. Without `versionNegotiation: auto` the
 *     CLI would speak the old protocol to our own modern daemon: it would
 *     work, and it would quietly waste the door.
 *
 *  3. **Version skew is real and silent.** `npm i -g` while a daemon is
 *     resident leaves a new CLI talking to an old server. `getServerVersion()`
 *     works in both eras, so we compare and restart once.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { readDaemonRecord, tokenPath, TOKEN_HEADER, DEFAULT_HTTP_PORT, type DaemonRecord } from '../daemon.js';
import { workspaceHeaders } from '../daemon-http.js';
import { PKG_VERSION } from '../build-server.js';
import { EXIT } from './exit-codes.js';
import { mkdirSync, accessSync, constants } from 'node:fs';

/** Install before any connect. See (1) above. */
export function installCrashGuard(fail: (code: number, message: string) => never): void {
  const handle = (err: unknown) => {
    const msg = (err as any)?.message ? String((err as any).message) : String(err);
    const unreachable = /fetch failed|ECONNREFUSED|negotiation probe failed|socket hang up/i.test(msg);
    fail(unreachable ? EXIT.UNAVAILABLE : EXIT.ERROR, msg);
  };
  process.on('unhandledRejection', handle);
  process.on('uncaughtException', handle);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Is anything listening on this port?
 *
 * Bounded on purpose. An unbounded probe is not a liveness check: a process
 * that holds the port but never answers (a wedged daemon, or something
 * unrelated bound there) would hang the caller forever instead of failing,
 * and this is called from the retry loops that exist to handle exactly that.
 *
 * Any response at all, including 401, proves something is listening.
 */
export async function endpointAnswers(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    await fetch('http://127.0.0.1:' + port + '/mcp', {
      method: 'POST',
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return true;
  } catch { return false; }
}

/** Wait for the port to stop answering. Used before respawning, never to detect readiness. */
async function waitForPortFree(port: number, timeoutMs = 5000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!(await endpointAnswers(port))) return true;
    await sleep(100);
  }
  return false;
}

async function waitForDaemon(port: number, timeoutMs = 10000): Promise<DaemonRecord | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const record = readDaemonRecord();
    // listen() precedes the atomic token-file write. An open port alone is
    // not readiness, and a stale record from a different port is not ours.
    if (record?.port === port && await endpointAnswers(port)) return record;
    await sleep(100);
  }
  return null;
}

/**
 * Spawn the daemon by resolved module path, never by name. `customaise-mcp`
 * is only on PATH under a global install; under `npx -p` nothing is, and
 * spawning by name would fail there while working on the developer's
 * machine.
 */
function spawnDaemon(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = join(here, '..', 'index.js');   // dist/index.js
  const child = spawn(process.execPath, [entry, 'daemon'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
    // The bundle claims win32. Without this, a detached child flashes a
    // console window there; everywhere else it is a no-op.
    windowsHide: true,
  });
  child.unref();
}

export interface Connected {
  client: Client;
  record: DaemonRecord;
}

export async function connectToDaemon(
  fail: (code: number, message: string) => never,
  opts: { allowRestart?: boolean } = {},
): Promise<Connected> {
  let record = readDaemonRecord();

  if (!record || !(await endpointAnswers(record.port))) {
    // Check the one startup failure we can diagnose precisely, before
    // spawning. The daemon runs detached with no stdio, so if it dies we see
    // only that nothing came up, and the generic message would send someone
    // to check their Node version when the real fix is a chmod.
    const dir = dirname(tokenPath());
    try {
      mkdirSync(dir, { recursive: true });
      accessSync(dir, constants.W_OK);
    } catch (err: any) {
      fail(EXIT.UNAVAILABLE,
        'Cannot write the daemon token to ' + dir + ' (' + (err?.code ?? err?.message) + ').\n' +
        'Fix the directory permissions, or point CUSTOMAISE_CONFIG_DIR somewhere writable.');
    }

    spawnDaemon();
    const port = Number(process.env.CUSTOMAISE_HTTP_PORT) || DEFAULT_HTTP_PORT;
    record = await waitForDaemon(port);
    if (!record) {
      fail(EXIT.UNAVAILABLE,
        'The Customaise daemon did not come up on 127.0.0.1:' + port + '.\n' +
        'Run `customaise-mcp daemon` directly to see why it failed.');
    }
  }

  const client = new Client(
    { name: 'customaise-cli', version: PKG_VERSION },
    { versionNegotiation: { mode: 'auto' } },   // see (2)
  );

  try {
    await client.connect(new StreamableHTTPClientTransport(
      new URL('http://127.0.0.1:' + record.port + '/mcp'),
      {
        requestInit: {
          headers: {
            [TOKEN_HEADER]: record.token,
            // Where this invocation is standing. The daemon was spawned once
            // from some other directory and outlived it, so without this any
            // file it writes on our behalf lands somewhere we cannot see.
            ...workspaceHeaders(process.cwd(), record.workspaceEncoding === 'uri'),
          },
        },
      },
    ));
  } catch (err: any) {
    await client.close().catch(() => {});
    // Another cold-start caller may have replaced the record. Retry that
    // identity once, without deleting a live daemon's only credential.
    if (opts.allowRestart !== false && /401|unauthorized/i.test(String(err?.message))) {
      const current = readDaemonRecord();
      if (current && current.token !== record.token) {
        return connectToDaemon(fail, { allowRestart: false });
      }
    }
    fail(EXIT.UNAVAILABLE, 'Could not reach the Customaise daemon: ' + (err?.message ?? err));
  }

  // (3) Version skew. Exact equality both ways: a daemon NEWER than the CLI
  // means the user downgraded, which is equally wrong. Restart once.
  const serverVersion = (client.getServerVersion?.() as any)?.version;
  if (serverVersion && serverVersion !== PKG_VERSION) {
    if (opts.allowRestart === false) {
      fail(EXIT.ERROR,
        'Daemon is ' + serverVersion + ' but this CLI is ' + PKG_VERSION +
        ', and restarting it did not help. Stop it by hand: customaise daemon stop');
    }
    process.stderr.write(
      '[customaise] daemon ' + serverVersion + ' != cli ' + PKG_VERSION + ', restarting it\n');
    await client.close().catch(() => {});
    try { process.kill(record.pid, 'SIGTERM'); } catch { /* already gone */ }
    // Confirm the port is released BEFORE respawning. A replacement that
    // races a dying daemon loses the bind, exits 0 as designed, and leaves
    // nothing listening at all.
    if (!(await waitForPortFree(record.port))) {
      fail(EXIT.UNAVAILABLE, 'Old daemon on :' + record.port + ' did not release the port.');
    }
    return connectToDaemon(fail, { allowRestart: false });
  }

  return { client, record };
}
