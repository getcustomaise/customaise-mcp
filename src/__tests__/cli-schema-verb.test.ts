/**
 * `customaise schema` is the CLI describing itself, and it must not lie.
 *
 * The table it prints lives next to USAGE and is edited by hand, which is
 * how every hand-maintained description of this CLI has drifted before (the
 * defect log has three IDE lists that disagreed). So: every verb the CLI
 * handles is in the table, every command in the table is a verb the CLI
 * handles, and every tool the table names is one the server registers and
 * one the CLI actually calls.
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
  throw new Error('could not locate mcp/src');
}
const SRC = findSrcDir();
const cli = readFileSync(join(SRC, 'cli', 'index.ts'), 'utf-8');
const server = readFileSync(join(SRC, 'server.ts'), 'utf-8');

const table = cli.slice(cli.indexOf('const COMMANDS'), cli.indexOf('interface Flags'));
const commands = [...table.matchAll(/command: '([^']+)'/g)].map((m) => m[1]);
const toolsInTable = new Set([...table.matchAll(/tool: '([^']+)'/g)].map((m) => m[1]));

/** Verbs the dispatcher handles, by either of the two shapes it uses. */
const handledVerbs = new Set([
  ...[...cli.matchAll(/case '([a-z]+)':/g)].map((m) => m[1]),
  ...[...cli.matchAll(/verb === '([a-z]+)'/g)].map((m) => m[1]),
  ...[...cli.matchAll(/positional\[0\] === '([a-z]+)'/g)].map((m) => m[1]),
]);
const registeredTools = new Set([...server.matchAll(/registerTool\('([a-z_]+)'/g)].map((m) => m[1]));
const calledTools = new Set([...cli.matchAll(/callTool(?:WithConsentBudget)?\('([a-z_]+)'/g)].map((m) => m[1]));

describe('customaise schema', () => {
  it('lists every verb the CLI handles, and nothing it does not', () => {
    const firstWords = new Set(commands.map((c) => c.split(' ')[0]));
    for (const verb of handledVerbs) {
      assert.ok(firstWords.has(verb), `CLI handles "${verb}" but schema omits it`);
    }
    for (const word of firstWords) {
      assert.ok(handledVerbs.has(word), `schema lists "${word}" but the CLI has no such verb`);
    }
  });

  it('names only tools the server registers', () => {
    for (const tool of toolsInTable) {
      assert.ok(registeredTools.has(tool), `schema names tool "${tool}" which server.ts does not register`);
    }
  });

  it('names every tool the CLI can reach', () => {
    for (const tool of calledTools) {
      assert.ok(toolsInTable.has(tool), `CLI calls "${tool}" but schema never mentions it`);
    }
  });

  it('every noun-verb alias has a description that says what it aliases', () => {
    for (const alias of ['tab list', 'tab shot', 'tab use']) {
      const m = table.match(new RegExp(`command: '${alias}'[^}]*description: '([^']+)'`));
      assert.ok(m, `no entry for ${alias}`);
      assert.match(m![1], /same as/, `${alias} should say which short verb it mirrors`);
    }
  });
});
