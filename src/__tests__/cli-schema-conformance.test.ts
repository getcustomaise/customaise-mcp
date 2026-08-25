/**
 * Every argument the CLI sends must exist in the tool's input schema.
 *
 * `customaise scripts install` sent `{ code }` while `export_script` declares
 * `{ filePath, scriptId? }`. The flagship verb, the first example in both the
 * README and the changelog, had never once worked: it failed argument
 * validation before reaching the extension. Nine rounds of review missed it
 * because reading two files side by side is exactly the comparison a reviewer
 * skims, and the unit tests mocked the tool layer where the mismatch lives.
 *
 * Static rather than behavioural on purpose: catching this needs no daemon,
 * no Chrome and no sign-in, so it runs in CI where the live proof cannot.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function findSrcDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'src');
    if (existsSync(join(candidate, 'server.ts'))) return candidate;
    dir = dirname(dir);
  }
  throw new Error('Could not locate mcp/src from ' + import.meta.url);
}

const SRC = findSrcDir();

/** tool name -> { all keys, required keys } as declared by `registerTool`. */
function toolSchemas(): Map<string, { keys: Set<string>; required: Set<string> }> {
  const src = readFileSync(join(SRC, 'server.ts'), 'utf8');
  const out = new Map<string, { keys: Set<string>; required: Set<string> }>();
  const re = /registerTool\('([a-z_]+)'[\s\S]*?inputSchema:\s*z\.object\(\{([\s\S]*?)\}\)\s*,\s*annotations/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const body = m[2];
    const keys = new Set<string>();
    const required = new Set<string>();
    for (const line of body.split('\n')) {
      const k = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/.exec(line);
      if (!k) continue;
      keys.add(k[1]);
      if (!/\.optional\(\)/.test(line)) required.add(k[1]);
    }
    out.set(m[1], { keys, required });
  }
  return out;
}

/**
 * `callTool('name', { ... })` sites in the CLI, with the keys sent.
 *
 * Brace-matched rather than regex-captured. A `[^{}]*` capture stops at the
 * first nested brace, so it silently skipped
 * `{ filePath, ...(flag ? { scriptId } : {}) }` — which is to say it skipped
 * the one site that carried the bug this test exists for, and passed.
 */
function cliCallSites(): Array<{ tool: string; keys: Set<string>; line: number }> {
  const src = readFileSync(join(SRC, 'cli', 'index.ts'), 'utf8');
  const sites: Array<{ tool: string; keys: Set<string>; line: number }> = [];
  const open = /callTool\('([a-z_]+)',\s*\{/g;

  for (let m = open.exec(src); m; m = open.exec(src)) {
    const start = m.index + m[0].length;   // just inside the `{`
    let depth = 1;
    let i = start;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
    }
    const span = src.slice(start, i - 1);
    // Every `ident:` in the span, at any depth: a key inside a spread
    // conditional is still an argument the tool will receive.
    const keys = new Set<string>();
    for (const k of span.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g)) keys.add(k[1]);
    sites.push({ tool: m[1], keys, line: src.slice(0, m.index).split('\n').length });
  }
  return sites;
}

describe('CLI arguments conform to tool schemas', () => {
  const schemas = toolSchemas();
  const sites = cliCallSites();

  it('parsed both sides, so the checks below are not vacuous', () => {
    assert.ok(schemas.size >= 15, `expected many tool schemas, parsed ${schemas.size}`);
    assert.ok(sites.length >= 10, `expected many CLI call sites, parsed ${sites.length}`);
  });

  it('no call site hides its tool name behind a variable', () => {
    // The checks below can only see `callTool('literal', ...)`. Dispatching
    // through a name map (`callTool(tool, args)`) makes a site invisible, and
    // an invisible site is an unchecked one: this test would keep passing
    // while covering less. Two verbs used to do that, covering 13 of 15
    // sites while reading as though it covered all of them.
    const src = readFileSync(join(SRC, 'cli', 'index.ts'), 'utf8');
    const hidden = src.split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /callTool\(\s*[a-zA-Z_$][a-zA-Z0-9_$]*\s*,/.test(line));
    assert.deepEqual(
      hidden.map(({ n, line }) => `${n}: ${line.trim()}`),
      [],
      'these call sites pass a variable tool name and are therefore unchecked',
    );
  });

  it('every tool the CLI calls exists', () => {
    for (const site of sites) {
      assert.ok(schemas.has(site.tool), `cli/index.ts:${site.line} calls unknown tool "${site.tool}"`);
    }
  });

  it('sends no argument the tool does not declare', () => {
    for (const site of sites) {
      const schema = schemas.get(site.tool);
      if (!schema) continue;
      for (const key of site.keys) {
        assert.ok(
          schema.keys.has(key),
          `cli/index.ts:${site.line} sends "${key}" to ${site.tool}, which declares ` +
            `{ ${[...schema.keys].join(', ')} }. Argument validation rejects the call ` +
            'before it reaches the extension.',
        );
      }
    }
  });

  it('sends every argument the tool requires', () => {
    // A site that spreads a conditional (`...(flag ? { scriptId } : {})`) still
    // lists the key, so an optional-by-flag argument counts as sent.
    for (const site of sites) {
      const schema = schemas.get(site.tool);
      if (!schema) continue;
      for (const key of schema.required) {
        assert.ok(
          site.keys.has(key),
          `cli/index.ts:${site.line} calls ${site.tool} without required "${key}".`,
        );
      }
    }
  });
});
