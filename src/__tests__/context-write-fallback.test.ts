/**
 * An unwritable workspace must not discard data the caller has paid for.
 *
 * The context tools dispatch to the extension FIRST and write the payload
 * to the workspace second, so by the time a write fails a cap unit is
 * already spent and the data is already in the handler's hands. The
 * workspace path is a guess on some IDEs (see getWorkspaceDir: Antigravity
 * spawns with cwd '/', Claude Desktop with the home directory), so the
 * guess being unwritable is an environment fact, not an exceptional one.
 * Before this fallback, an ENOTDIR here threw the whole snapshot away as
 * an error; now it degrades to inline delivery with the failure named.
 *
 * take_screenshot deliberately has NO such fallback: an explicit filePath
 * is a promise to the caller (the CLI's `shot -o FILE` contract), and its
 * default temp directory does not share the guessed-workspace risk.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTools } from '../server.js';

type Handler = (args: Record<string, unknown>, ctx: unknown) => Promise<{
  structuredContent: Record<string, any>;
}>;

function handlers(bridgeResult: Record<string, unknown>): Map<string, Handler> {
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      tools.set(name, handler);
    },
  };
  const bridge = {
    dispatchTool: async () => JSON.parse(JSON.stringify(bridgeResult)),
    getSystemStatus: () => null,
    onPush: () => {},
    isConnected: true,
  };
  registerTools(server as never, bridge as never);
  return tools;
}

describe('context tools with an unwritable workspace', () => {
  let dir: string;
  let savedWorkspace: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cm-fallback-'));
    // A regular FILE as the workspace: mkdirSync(<file>/.customaise) fails
    // with ENOTDIR, the cheapest reliable stand-in for a read-only mount.
    const fileAsWorkspace = join(dir, 'not-a-dir');
    writeFileSync(fileAsWorkspace, 'x');
    savedWorkspace = process.env.CUSTOMAISE_WORKSPACE;
    process.env.CUSTOMAISE_WORKSPACE = fileAsWorkspace;
  });

  afterEach(() => {
    if (savedWorkspace === undefined) delete process.env.CUSTOMAISE_WORKSPACE;
    else process.env.CUSTOMAISE_WORKSPACE = savedWorkspace;
    rmSync(dir, { recursive: true, force: true });
  });

  it('get_page_context falls back to inline with the failure named', async () => {
    const h = handlers({ overview: { url: 'https://x.com', title: 'T' }, elements: [1, 2, 3] });
    const r = await h.get('get_page_context')!({}, {});
    const p = r.structuredContent;
    assert.equal(p.delivery, 'inline');
    assert.equal(p.wroteFile, false);
    // Not the file decision's source: `delivery: inline, deliverySource:
    // default` would claim the default is inline, and an agent would
    // repeat that to the user.
    assert.equal(p.deliverySource, 'file-write-fallback');
    assert.match(p.fileWriteError, /ENOTDIR|not a directory/i);
    assert.deepEqual(p.page.elements, [1, 2, 3], 'the paid-for snapshot survives');
    assert.match(p.hint, /returned inline instead of being discarded/);
  });

  it('get_console_context falls back the same way', async () => {
    const h = handlers({ errors: [{ msg: 'boom' }], warnings: [], userscriptLogs: [] });
    const r = await h.get('get_console_context')!({}, {});
    const p = r.structuredContent;
    assert.equal(p.delivery, 'inline');
    assert.match(p.fileWriteError, /ENOTDIR|not a directory/i);
    assert.equal(p.console.errors[0].msg, 'boom');
    assert.equal(p.counts.errors, 1);
  });

  it('explicit inline mode is unaffected: no fileWriteError, no write attempted', async () => {
    const h = handlers({ overview: { url: 'https://x.com' }, elements: [1] });
    const p = (await h.get('get_page_context')!({ output: 'inline' }, {})).structuredContent;
    assert.equal(p.delivery, 'inline');
    assert.equal(p.fileWriteError, undefined);
  });
});
