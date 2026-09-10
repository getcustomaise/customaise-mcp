#!/usr/bin/env node
/**
 * Assemble the public mirror of this package.
 *
 * ── Why this exists ──────────────────────────────────────────────────
 *
 * `package.json` points `repository` at github.com/getcustomaise/customaise-mcp,
 * and the `.mcpb` manifest points there too. That repo is what every MCP
 * scanner, directory and curious developer actually reads. It was last
 * updated by hand on 2026-05-29 at version 2.0.7, and it carries seven of
 * the twenty-one files in `src/`.
 *
 * Two consequences, both of which have already happened:
 *
 *   1. It does not build. `server.ts` imports `./request-context.js` and
 *      `./tool-envelope.js`; neither was ever copied across. Anyone who
 *      clones the published repository cannot compile it.
 *   2. It does not test. All 33 suites live in `src/__tests__/`, none of
 *      which were copied, so an external audit reported "no test files
 *      found" — accurately, about the only copy of the code it can see.
 *
 * Hand-copying a subset is what produced both. This script copies the
 * git-tracked set instead, so the mirror is complete by construction and
 * the failure mode becomes "the script was not run" rather than "somebody
 * forgot a file".
 *
 * ── Usage ────────────────────────────────────────────────────────────
 *
 *   node scripts/sync-public-mirror.mjs --json          # print the plan, copy nothing
 *   node scripts/sync-public-mirror.mjs --out ../mirror # materialise the tree
 *   node scripts/sync-public-mirror.mjs --verify ../customaise-mcp
 *
 * `--verify` takes a checkout of the public repo and reports drift:
 * missing files, files whose contents differ, and files present there that
 * this package does not ship. Exit 1 on any drift, so it can gate a release.
 *
 * It deliberately does NOT push. Publishing is an outward-facing action and
 * stays a human's decision; the script prints the git commands and stops.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: PKG_DIR, encoding: 'utf-8' }).trim();

/**
 * Paths the mirror must not carry, each with the reason.
 *
 * Everything else that git tracks under `mcp/` ships. An allowlist would
 * reintroduce exactly the bug this script exists to fix: a new file lands,
 * nobody adds it to the list, and the mirror silently drifts again. A
 * denylist fails in the safe direction — a file we forgot to exclude gets
 * published, which is visible, rather than a file we forgot to include
 * going missing, which is not.
 */
const EXCLUDE = [
  {
    match: (p) => p.startsWith(`.customaise${sep}`) || p.startsWith('.customaise/'),
    reason: 'test residue: the server suite writes {"mock":true} fixtures here',
  },
];

/**
 * Paths that legitimately live only in the public repo.
 *
 * The mirror carries GitHub furniture this package has no reason to hold:
 * issue templates, and anything else that is about receiving contributions
 * rather than about the code. `--verify` must not report them as drift and
 * `--apply` must not delete them, or the first sync would quietly wipe the
 * repo's bug-report form.
 */
// `.mirror-stamp` is this script's own --out marker; the printed workflow
// commits that directory wholesale, so without this line every later
// --verify reports the stamp as one file of permanent drift.
const MIRROR_ONLY = [/^\.github\//, /^\.git\//, /^\.mirror-stamp$/];
const isMirrorOnly = (p) => MIRROR_ONLY.some((re) => re.test(p.split(sep).join('/')));

/** Every file git tracks under `mcp/`, package-relative. */
function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--', PKG_DIR], { cwd: REPO_ROOT, encoding: 'utf-8' });
  return out
    .split('\0')
    .filter(Boolean)
    .map((p) => relative(PKG_DIR, join(REPO_ROOT, p)))
    .sort();
}

/**
 * Files under `mcp/` that git neither tracks nor ignores.
 *
 * The plan is built from `git ls-files`, so a source file that has been
 * written but not yet committed is invisible to it, and mirroring at that
 * moment would publish a tree missing the very thing being released. That
 * is the same shape as the bug this script exists to fix, one step earlier,
 * so it is reported rather than skipped.
 */
function untrackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard', '--', PKG_DIR], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  return out
    .split('\0')
    .filter(Boolean)
    .map((p) => relative(PKG_DIR, join(REPO_ROOT, p)))
    .filter((p) => !EXCLUDE.some((r) => r.match(p)))
    .sort();
}

export function buildPlan() {
  const include = [];
  const exclude = [];
  for (const path of trackedFiles()) {
    const rule = EXCLUDE.find((r) => r.match(path));
    if (rule) exclude.push({ path, reason: rule.reason });
    else include.push(path);
  }
  return { include, exclude, untracked: untrackedFiles() };
}

/** Files present in `dir` that the plan does not account for. */
function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    if (dir === base && ['dist', 'test-out'].includes(entry.name)) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, base, out);
    else out.push(relative(base, p));
  }
  return out;
}

function main(argv) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : (argv[i + 1] ?? true);
  };
  const plan = buildPlan();

  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    return 0;
  }

  const verifyDir = flag('--verify');
  if (typeof verifyDir === 'string') {
    if (!existsSync(verifyDir)) {
      console.error(`--verify: ${verifyDir} does not exist. Clone the public repo there first.`);
      return 2;
    }
    const there = new Set(walk(verifyDir));
    const missing = plan.include.filter((p) => !there.has(p));
    const differs = plan.include
      .filter((p) => there.has(p))
      .filter((p) => readFileSync(join(PKG_DIR, p)).compare(readFileSync(join(verifyDir, p))) !== 0);
    const extra = [...there].filter((p) => !plan.include.includes(p) && !isMirrorOnly(p)).sort();

    const report = (label, list) => {
      if (!list.length) return;
      console.log(`\n${label} (${list.length}):`);
      for (const p of list.slice(0, 40)) console.log('  ' + p);
      if (list.length > 40) console.log(`  ... and ${list.length - 40} more`);
    };
    report('MISSING from the mirror', missing);
    report('DIFFERENT in the mirror', differs);
    report('EXTRA in the mirror, not shipped here', extra);

    const drift = missing.length + differs.length + extra.length;
    console.log(drift ? `\n${drift} file(s) adrift.` : '\nMirror matches this package exactly.');
    return drift ? 1 : 0;
  }

  const applyDir = flag('--apply');
  const outDir = flag('--out');
  if (typeof applyDir !== 'string' && typeof outDir !== 'string') {
    console.error('Usage: sync-public-mirror.mjs (--json | --apply <checkout> | --out <dir> | --verify <dir>)');
    return 2;
  }

  // Refuse rather than publish a tree that is missing work already on disk.
  // `--force` is there for the case where the untracked files are genuinely
  // not meant to ship, which should be rare enough to be typed out.
  if (plan.untracked.length && !argv.includes('--force')) {
    console.error(`Refusing to mirror: ${plan.untracked.length} file(s) under mcp/ are neither committed nor ignored, so the mirror would be missing them.\n`);
    for (const p of plan.untracked.slice(0, 20)) console.error('  ' + p);
    if (plan.untracked.length > 20) console.error(`  ... and ${plan.untracked.length - 20} more`);
    console.error('\nCommit them, add them to .gitignore, or re-run with --force.');
    return 2;
  }

  // `--apply` is the flow that keeps the mirror correct over time: copy the
  // plan over a real checkout, delete what this package no longer ships, and
  // leave the repo's own furniture alone. The human reviews `git diff` and
  // pushes. Copying over a checkout rather than force-pushing a fresh tree
  // is what preserves the mirror's history and its issue templates.
  if (typeof applyDir === 'string') {
    if (!existsSync(join(applyDir, '.git'))) {
      console.error(`--apply: ${applyDir} is not a git checkout. Clone the public repo there first.`);
      return 2;
    }
    const before = walk(applyDir).filter((p) => !isMirrorOnly(p));
    const shipped = new Set(plan.include);
    const removed = before.filter((p) => !shipped.has(p));
    let changed = 0;
    for (const p of plan.include) {
      const dest = join(applyDir, p);
      const src = join(PKG_DIR, p);
      const same = existsSync(dest) && readFileSync(dest).compare(readFileSync(src)) === 0;
      if (same) continue;
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest);
      changed++;
    }
    for (const p of removed) rmSync(join(applyDir, p), { force: true });

    console.log(`Applied to ${applyDir}: ${changed} added or updated, ${removed.length} removed, ${plan.include.length - changed} already current.`);
    for (const p of removed.slice(0, 20)) console.log(`  removed ${p}`);
    console.log(`
Next, by hand:
  cd ${applyDir}
  git status && git diff        # review before you publish
  git add -A && git commit -m "sync ${JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf-8')).version}"
  git push origin main
  git tag v${JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf-8')).version} && git push origin v${JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf-8')).version}
  gh release create v${JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf-8')).version} --repo getcustomaise/customaise-mcp --title "..." --notes "..."
  # Releases do not create themselves: 2.0.7, 3.0.0 and 3.1.0 all reached
  # npm while the repo's Latest release sat at 2.0.2 for three months.`);
    return 0;
  }

  // Only ever clears a directory this script produced, never an arbitrary
  // path the caller named: wiping a mistyped --out would be unrecoverable.
  const stamp = join(outDir, '.mirror-stamp');
  if (existsSync(outDir)) {
    if (!existsSync(stamp)) {
      console.error(`--out: ${outDir} exists and was not created by this script. Remove it yourself, or pick another path.`);
      return 2;
    }
    rmSync(outDir, { recursive: true, force: true });
  }
  for (const p of plan.include) {
    const dest = join(outDir, p);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(PKG_DIR, p), dest);
  }
  mkdirSync(dirname(stamp), { recursive: true });
  writeFileSync(stamp, 'generated by sync-public-mirror.mjs\n');

  const bytes = plan.include.reduce((n, p) => n + statSync(join(PKG_DIR, p)).size, 0);
  console.log(`Wrote ${plan.include.length} files (${(bytes / 1024).toFixed(1)} KB) to ${outDir}`);
  for (const e of plan.exclude) console.log(`  excluded ${e.path} (${e.reason})`);
  console.log(`
Next, by hand:
  cd ${outDir}
  git init && git remote add origin git@github.com:getcustomaise/customaise-mcp.git
  git add -A && git commit -m "sync <version>"
  git push --force origin main    # review the diff first`);
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('sync-public-mirror.mjs')) {
  process.exitCode = main(process.argv.slice(2));
}
