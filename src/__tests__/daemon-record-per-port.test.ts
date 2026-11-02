/**
 * One daemon record per bridge port. With a single shared record, a CLI pointed
 * at the staging extension (CUSTOMAISE_WS_PORT=4150) used the production daemon
 * whenever one was running, and a production CLI used a staging daemon, so
 * commands meant for one extension reached the other.
 */

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

let dir: string;
let daemon: typeof import('../daemon.js');
const saved = { ...process.env };
const record = (wsPort: number | undefined, port: number) =>
  JSON.stringify({ token: 't'.repeat(48), port, pid: 1, version: '3.2.9', ...(wsPort === undefined ? {} : { wsPort }) });

describe('daemon records per bridge port', () => {
  before(async () => { daemon = await import('../daemon.js'); });
  beforeEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), 'customaise-daemon-'));
    process.env.CUSTOMAISE_CONFIG_DIR = dir;
    delete process.env.CUSTOMAISE_WS_PORT;
    delete process.env.VIBEMONKEY_WS_PORT;
    delete process.env.CUSTOMAISE_HTTP_PORT;
  });
  after(() => { rmSync(dir, { recursive: true, force: true }); process.env = { ...saved }; });

  it('keeps the production name and gives staging its own record and loopback port', () => {
    assert.equal(basename(daemon.tokenPath()), 'daemon.json');
    assert.equal(daemon.httpPortFor(daemon.requestedWsPort()), 4051);
    process.env.CUSTOMAISE_WS_PORT = '4150';
    assert.equal(basename(daemon.tokenPath()), 'daemon-4150.json');
    assert.equal(daemon.httpPortFor(daemon.requestedWsPort()), 4151);
    process.env.CUSTOMAISE_HTTP_PORT = '4999';
    assert.equal(daemon.httpPortFor(daemon.requestedWsPort()), 4999, 'an explicit loopback port wins');
  });

  it('never hands a staging caller the production daemon, or the reverse', () => {
    writeFileSync(join(dir, 'daemon.json'), record(4050, 4051));
    process.env.CUSTOMAISE_WS_PORT = '4150';
    assert.equal(daemon.readDaemonRecord(), null);
    writeFileSync(join(dir, 'daemon-4150.json'), record(4150, 4151));
    assert.equal(daemon.readDaemonRecord()?.port, 4151);
    delete process.env.CUSTOMAISE_WS_PORT;
    assert.equal(daemon.readDaemonRecord()?.port, 4051);
  });

  it('reads a record from before records were per port only for the port it names', () => {
    writeFileSync(join(dir, 'daemon.json'), record(4150, 4151));
    assert.equal(daemon.readDaemonRecord(), null, 'production must not use a staging daemon');
    process.env.CUSTOMAISE_WS_PORT = '4150';
    assert.equal(daemon.readDaemonRecord()?.port, 4151, 'a staging daemon from the old layout is still found');
    writeFileSync(join(dir, 'daemon.json'), record(undefined, 4051));
    assert.equal(daemon.readDaemonRecord(), null, 'a record naming no port belongs to the default port');
    delete process.env.CUSTOMAISE_WS_PORT;
    assert.equal(daemon.readDaemonRecord()?.port, 4051);
  });
});
