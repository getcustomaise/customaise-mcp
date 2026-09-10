/**
 * Usage errors, driven through the real binary.
 *
 * These need no daemon and no extension: `parseFlags` runs before anything
 * connects, so a bad invocation must fail before the CLI reaches out. That
 * ordering is the point of testing the binary rather than the parser, which
 * is not exported (importing `cli/index.ts` runs `main()`).
 *
 * The case that motivated this: `--out` with nothing after it became boolean
 * `true`, the path resolver turned that into a file literally named "true",
 * and the CLI wrote the script there and exited 0 reporting success.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function pkgRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'dist', 'cli', 'index.js'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('could not locate dist/cli/index.js (run `npm run build` first)');
}

const CLI = join(pkgRoot(), 'dist', 'cli', 'index.js');

function run(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], (err, _stdout, stderr) => {
      resolve({ code: (err as { code?: number } | null)?.code ?? 0, stderr });
    });
  });
}

describe('usage errors exit 2 and say what is wrong', () => {
  const cases: Array<[string, string[], RegExp]> = [
    ['a value flag given bare', ['scripts', 'get', 'abc', '--out'], /--out expects a value/],
    ['-o with nothing after it', ['scripts', 'get', 'abc', '-o'], /-o expects a file path/],
    ['--tab given bare', ['tools', '--tab'], /--tab expects a value/],
    ['--args given bare', ['call', 'x', '--args'], /--args expects a value/],
    ['--id given bare', ['scripts', 'install', CLI, '--id'], /--id expects a value/],
    ['a required positional missing', ['tab', 'focus'], /tab focus <tabId>/],
    ['open without a url', ['tab', 'open'], /tab open <url>/],
    ['an unknown verb', ['nonsense'], /unknown command/],
    ['an unknown subcommand', ['context', 'nonsense'], /context <page\|console\|selection>/],
    ['a non-numeric tab id', ['tab', 'focus', 'abc'], /tab id must be a number/],
    ['a negative remembered tab id', ['use', '--tab', '-1'], /non-negative integer/],
    ['a fractional remembered tab id', ['use', '--tab', '1.5'], /non-negative integer/],
  ];

  for (const [name, args, expected] of cases) {
    it(name, async () => {
      const { code, stderr } = await run(args);
      assert.equal(code, 2, `${args.join(' ')} -> exit ${code}: ${stderr}`);
      assert.match(stderr, expected);
    });
  }

  it('never reaches the daemon: none of these need one running', async () => {
    // If a usage error connected first, these would hang or exit 3 instead.
    const { code } = await run(['tab', 'focus']);
    assert.equal(code, 2);
  });
});
