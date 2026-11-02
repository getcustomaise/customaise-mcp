/**
 * A page tool's result reaches the caller whole, whatever its size.
 *
 * `call_webmcp_tool` returned every result inline, so a tool that read a long
 * list or page answered with megabytes, and a client refuses a result past its
 * own limit: the caller got an error instead of data the tool had already
 * gathered, including the id it needed to carry on. Under the inline budget
 * nothing changes. Over it, file mode keeps the whole result on disk and
 * inline mode shortens lists (never text), and neither needs the tool run
 * again to recover what it returned.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTools } from '../server.js';

type Handler = (args: Record<string, unknown>, ctx: unknown) => Promise<{
  structuredContent: Record<string, any>;
  content: Array<{ type: string; text: string }>;
}>;

function callTool(bridgeResult: unknown): Handler {
  const tools = new Map<string, Handler>();
  const server = { registerTool: (name: string, _config: unknown, handler: Handler) => { tools.set(name, handler); } };
  const bridge = {
    dispatchTool: async () => JSON.parse(JSON.stringify(bridgeResult)),
    getSystemStatus: () => null,
    onPush: () => {},
    isConnected: true,
  };
  registerTools(server as never, bridge as never);
  return tools.get('call_webmcp_tool')!;
}

/** A page tool's answer: a few small values beside a list far past 64 KB. */
const bigResult = (rows = 3000) => ({
  ok: true,
  dataset: 'ds_abc123',
  rows_total: rows,
  next_offset: rows,
  next_step: 'Read the rest with scraper_rows.',
  rows: Array.from({ length: rows }, (_, id) => ({ id, title: `Row ${id}`, text: 'r'.repeat(80) })),
});

describe('call_webmcp_tool result delivery', () => {
  let workspace: string;
  const saved: Record<string, string | undefined> = {};
  const setEnv = (name: string, value: string | undefined) => {
    if (!(name in saved)) saved[name] = process.env[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  };

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'cm-tool-results-'));
    setEnv('CUSTOMAISE_WORKSPACE', workspace);
    setEnv('CUSTOMAISE_MCP_OUTPUT', undefined);
    setEnv('CUSTOMAISE_MCP_INLINE_MAX_KB', undefined);
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
      delete saved[name];
    }
    rmSync(workspace, { recursive: true, force: true });
  });

  const resultsDir = () => join(workspace, '.customaise', 'tool-results');

  it('a result within the budget comes back exactly as the tool returned it, and nothing is written', async () => {
    const small = { ok: true, rows: [{ id: 1 }], next_step: 'Done.' };
    const reply = await callTool(small)({ toolName: 'scraper_rows' }, {});
    assert.deepEqual(reply.structuredContent, small);
    assert.deepEqual(JSON.parse(reply.content[0].text), small);
    assert.equal(readdirSync(workspace).includes('.customaise'), false);
  });

  it('over the budget, file mode writes the whole result and returns its path with the small values', async () => {
    const result = bigResult();
    const reply = await callTool(result)({ toolName: 'scraper_rows' }, {});
    const p = reply.structuredContent;
    assert.equal(p.delivery, 'file');
    assert.equal(p.deliverySource, 'default');
    assert.equal(p.tool, 'scraper_rows');
    assert.ok(p.filePath.startsWith(resultsDir()), p.filePath);
    assert.deepEqual(JSON.parse(readFileSync(p.filePath, 'utf-8')), result, 'the file holds the whole result');
    // An id or next step can be acted on without opening the file.
    assert.equal(p.summary.dataset, 'ds_abc123');
    assert.equal(p.summary.next_step, 'Read the rest with scraper_rows.');
    assert.equal(p.summary.rows, '(a list of 3000 items, in the file)');
    assert.match(p.hint, /output: "inline"/);
    assert.match(p.hint, /runs the page tool again/);
    assert.ok(reply.content[0].text.length < 8 * 1024, 'the reply itself stays small');
  });

  it('over the budget, inline mode shortens lists, never text, and says what an offset in it no longer covers', async () => {
    const reply = await callTool(bigResult())({ toolName: 'scraper_rows', output: 'inline' }, {});
    const p = reply.structuredContent;
    assert.equal(p.delivery, 'inline');
    assert.equal(p.deliverySource, 'argument');
    assert.equal(p.truncated, true);
    assert.equal(p.omitted[0].path, 'rows');
    assert.ok(p.result.rows.length < 3000 && p.result.rows.length > 0);
    assert.equal(p.result.rows[0].text, 'r'.repeat(80), 'every value kept is whole');
    assert.equal(p.result.dataset, 'ds_abc123', 'every key is intact');
    assert.ok(JSON.stringify(p.result).length <= 64 * 1024);
    assert.match(p.hint, /can point past items it does not hold/);
    assert.equal(readdirSync(workspace).includes('.customaise'), false, 'inline writes nothing');
  });

  it('a result over the budget with no list to shorten comes back whole, and says nothing was dropped', async () => {
    const reply = await callTool({ ok: true, text: 'z'.repeat(120 * 1024) })({ toolName: 'page_text', output: 'inline' }, {});
    const p = reply.structuredContent;
    assert.equal(p.truncated, false);
    assert.equal(p.result.text.length, 120 * 1024);
    assert.match(p.hint, /nothing was dropped/);
  });

  it('CUSTOMAISE_MCP_OUTPUT decides when the call does not, and the budget follows CUSTOMAISE_MCP_INLINE_MAX_KB', async () => {
    setEnv('CUSTOMAISE_MCP_OUTPUT', 'inline');
    const fromEnv = (await callTool(bigResult())({ toolName: 'scraper_rows' }, {})).structuredContent;
    assert.deepEqual([fromEnv.delivery, fromEnv.deliverySource], ['inline', 'environment']);
    setEnv('CUSTOMAISE_MCP_INLINE_MAX_KB', '4096');
    const result = bigResult();
    assert.deepEqual((await callTool(result)({ toolName: 'scraper_rows' }, {})).structuredContent, result, 'within a raised budget it is returned as is');
  });

  it('keeps the newest 20 results, and never removes a file it did not write', async () => {
    mkdirSync(resultsDir(), { recursive: true });
    writeFileSync(join(resultsDir(), 'my-notes.json'), '{}');
    const handler = callTool(bigResult(1200));
    const paths: string[] = [];
    for (let i = 0; i < 23; i++) {
      paths.push((await handler({ toolName: 'scraper_rows' }, {})).structuredContent.filePath);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const left = readdirSync(resultsDir());
    assert.ok(left.includes('my-notes.json'));
    assert.equal(left.filter((name) => name !== 'my-notes.json').length, 20);
    for (const path of paths.slice(-20)) assert.ok(left.includes(path.slice(resultsDir().length + 1)), 'one of the newest 20 is missing');
  });

  it('a workspace that cannot be written falls back to inline, so the result the tool returned is not lost', async () => {
    const fileAsWorkspace = join(workspace, 'not-a-dir');
    writeFileSync(fileAsWorkspace, 'x');
    setEnv('CUSTOMAISE_WORKSPACE', fileAsWorkspace);
    const p = (await callTool(bigResult())({ toolName: 'scraper_rows' }, {})).structuredContent;
    assert.equal(p.delivery, 'inline');
    assert.equal(p.deliverySource, 'file-write-fallback');
    assert.match(p.fileWriteError, /ENOTDIR|not a directory/i);
    assert.equal(p.result.dataset, 'ds_abc123');
    assert.match(p.hint, /returned inline instead of being discarded/);
  });
});
