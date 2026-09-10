/**
 * The public mirror must be able to build and test itself.
 *
 * `package.json` points `repository` at getcustomaise/customaise-mcp, and
 * that repo is what MCP scanners and directories actually read. It was
 * hand-copied, and the hand-copy took seven of the twenty-one files in
 * `src/`. So the published repository did not compile (`server.ts` imports
 * `./request-context.js` and `./tool-envelope.js`, neither of which was
 * there) and shipped none of the test suites, which is why an external
 * audit reported "no test files found" and marked us down for it. The
 * finding was correct about the only copy of the code it could see.
 *
 * These assertions are about the SHAPE of what gets published, not about
 * whether someone has run the sync lately. A stale mirror is caught by
 * `sync-public-mirror.mjs --verify <checkout>`, which needs a checkout and
 * therefore a network, and cannot live in a unit suite.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function findPkgDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'src', 'server.ts'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('Could not locate the mcp package root from ' + import.meta.url);
}

const PKG = findPkgDir();

interface Plan {
  include: string[];
  exclude: Array<{ path: string; reason: string }>;
  untracked: string[];
}

/**
 * The script is the single source of truth, so this shells out to it rather
 * than reimplementing the rules. A second copy of the include logic here
 * would be free to agree with itself while disagreeing with what ships.
 */
const plan: Plan = JSON.parse(
  execFileSync('node', [join(PKG, 'scripts', 'sync-public-mirror.mjs'), '--json'], { encoding: 'utf-8' }),
);

const included = new Set(plan.include);

describe('public mirror plan', () => {
  it('ships every tracked TypeScript source file', () => {
    // Nothing is allowed to be published half-compiled again. The plan is
    // built from `git ls-files`, so this reads back what git says the
    // package contains and insists all of it is in the shipping set.
    const tracked = execFileSync('git', ['ls-files', '--', 'src'], { cwd: PKG, encoding: 'utf-8' })
      .split('\n')
      .filter((p) => p.endsWith('.ts'));
    assert.ok(tracked.length >= 20, `expected the src tree, saw ${tracked.length} files`);
    const dropped = tracked.filter((p) => !included.has(p));
    assert.deepEqual(dropped, [], 'source files git tracks that the mirror would not carry');
  });

  it('ships the test suites, which is the finding that started this', () => {
    const tests = plan.include.filter((p) => p.startsWith('src/__tests__/') && p.endsWith('.test.ts'));
    assert.ok(tests.length >= 30, `only ${tests.length} test files would be published`);
  });

  it('ships what a clone needs to build and run the suite', () => {
    for (const required of ['package.json', 'tsconfig.json', 'tsconfig.test.json', 'README.md', 'LICENSE']) {
      assert.ok(included.has(required), `${required} would not be published`);
    }
  });

  it('ships the lockfile, because that is what dependency scanners read', () => {
    // The ws advisories were found by reading a lockfile. Publishing
    // `package.json` alone leaves a scanner resolving ranges itself and
    // reporting whatever the range could resolve to rather than what we
    // pin. The live mirror carries no lockfile at all today.
    assert.ok(included.has('package-lock.json'), 'package-lock.json would not be published');
  });

  it('does not ship the test residue the suite writes into the repo', () => {
    const leaked = plan.include.filter((p) => p.startsWith('.customaise/'));
    assert.deepEqual(leaked, [], 'mock fixtures would be published');
    // A clean public clone has no tracked test residue to exclude. The
    // no-leak assertion above applies both there and in the monorepo.
  });

  it('surfaces uncommitted source rather than silently omitting it', () => {
    // The plan comes from `git ls-files`, so a file written but not yet
    // committed is invisible to it. That is the same drift one step earlier,
    // and the script refuses to mirror while any exists. This asserts the
    // reporting works, not that the tree happens to be clean right now.
    assert.ok(Array.isArray(plan.untracked), 'the plan no longer reports untracked files');
    for (const p of plan.untracked) {
      assert.ok(!included.has(p), `${p} is reported both untracked and shipping`);
    }
  });
});
