#!/usr/bin/env node
/**
 * Build customaise.mcpb — Claude Desktop Extension bundle for @customaise/mcp.
 *
 * Layout produced:
 *   mcp/mcpb/staging/
 *     manifest.json          (with version synced from mcp/package.json)
 *     icon.png
 *     README.md
 *     server/
 *       index.js + ...       (mcp/dist/* flattened in)
 *       package.json         (slim: deps minus sharp/native binaries)
 *       node_modules/        (production-only, sharp/@img stripped)
 *
 * Then `mcpb pack` zips that into mcp/customaise.mcpb.
 *
 * Convention: every release of @customaise/mcp must ship a matching .mcpb.
 * See ARD-Claude-Desktop-MCPB-Extension.md §12 and the paired-release
 * memory.
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(MCP_ROOT, '..');
const STAGING = join(HERE, 'staging');
const SERVER_STAGING = join(STAGING, 'server');
const OUTPUT = join(MCP_ROOT, 'customaise.mcpb');

function log(msg) {
  process.stdout.write(`[build-mcpb] ${msg}\n`);
}

function run(command, args, cwd = HERE) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

// 1. Read version from @customaise/mcp package.json — single source of truth.
const mcpPkg = readJson(join(MCP_ROOT, 'package.json'));
const VERSION = mcpPkg.version;
log(`@customaise/mcp version: ${VERSION}`);

// 2. Ensure dist/ is fresh. ALWAYS rebuild, never trust what is there.
//
// This used to build only when dist/index.js was missing, which checks the
// wrong thing: a dist that exists but predates the last source edit passes
// that test and gets bundled silently. It nearly shipped a bundle carrying a
// tool that had been deleted from the source, because `npm test` compiles to
// test-out/ and leaves dist/ untouched, so a full green suite says nothing
// about what is in dist. tsc takes a couple of seconds; a bundle built from
// stale code is found by users.
log('rebuilding mcp/dist from source');
run('npm', ['run', 'build'], MCP_ROOT);
const distIndex = join(MCP_ROOT, 'dist', 'index.js');
if (!existsSync(distIndex)) {
  throw new Error('npm run build did not produce mcp/dist/index.js');
}

// 3. Wipe and recreate staging.
if (existsSync(STAGING)) {
  rmSync(STAGING, { recursive: true, force: true });
}
mkdirSync(SERVER_STAGING, { recursive: true });

// 4. Copy dist/ contents into staging/server/.
//    The compiled entry point becomes staging/server/index.js — matches
//    the manifest's server.entry_point.
cpSync(join(MCP_ROOT, 'dist'), SERVER_STAGING, { recursive: true });
log('copied dist/ → staging/server/');

// 5. Write slim production package.json into staging/server/.
//    The filter and the scrub below are belt and braces: `sharp` was
//    removed from mcp/package.json once it was confirmed unused, so
//    nothing should match. They stay because a transitive native
//    dependency would silently lock the .mcpb to one OS.
const slimPkg = {
  name: '@customaise/mcp',
  version: VERSION,
  type: 'module',
  private: true,
  main: 'index.js',
  dependencies: Object.fromEntries(
    Object.entries(mcpPkg.dependencies || {}).filter(
      // The bundle serves stdio to Claude Desktop and nothing else. It never
      // runs the `customaise` CLI, which is the only thing that imports the
      // MCP client, so shipping the client would add roughly a megabyte for
      // code the bundle cannot reach. `sharp`/`@img` are belt and braces
      // against a transitive native dependency locking the .mcpb to one OS.
      ([name]) => !name.startsWith('sharp')
        && !name.startsWith('@img/')
        && name !== '@modelcontextprotocol/client',
    ),
  ),
};
writeJson(join(SERVER_STAGING, 'package.json'), slimPkg);
log('wrote staging/server/package.json (sharp/@img excluded)');

// 6. Install the tested production graph. Resolving ranges afresh here can
// silently ship different dependencies than the source tests ran against.
// Use the full package during npm ci, then remove the CLI-only client and
// restore the Desktop package surface without re-resolving any dependencies.
writeJson(join(SERVER_STAGING, 'package.json'), mcpPkg);
cpSync(join(MCP_ROOT, 'package-lock.json'), join(SERVER_STAGING, 'package-lock.json'));
run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], SERVER_STAGING);
rmSync(join(SERVER_STAGING, 'node_modules', '@modelcontextprotocol', 'client'), { recursive: true, force: true });
writeJson(join(SERVER_STAGING, 'package.json'), slimPkg);
rmSync(join(SERVER_STAGING, 'package-lock.json'));

// 7. Defensive scrub: even if a transitive sneaks in, strip native blobs.
const nm = join(SERVER_STAGING, 'node_modules');
for (const sub of ['sharp', '@img']) {
  const p = join(nm, sub);
  if (existsSync(p)) {
    rmSync(p, { recursive: true, force: true });
    log(`scrubbed node_modules/${sub}`);
  }
}

// 8. Copy manifest, icon, README into staging root, with version overridden.
const manifest = readJson(join(HERE, 'manifest.json'));
manifest.version = VERSION;
writeJson(join(STAGING, 'manifest.json'), manifest);
log(`wrote staging/manifest.json (version=${VERSION})`);

cpSync(join(HERE, 'icon.png'), join(STAGING, 'icon.png'));
cpSync(join(HERE, 'README.md'), join(STAGING, 'README.md'));
log('copied icon.png + README.md into staging/');

// 8b. Also write a minimal package.json at bundle root.
//     The compiled `dist/index.js` reads `../package.json` at module load
//     (via an IIFE that resolves the PKG_VERSION constant). In npm layout
//     that lands on `mcp/package.json`. In our bundle layout, `server/`
//     replaces `dist/`, so `../package.json` resolves to the bundle root.
//     Without this shim, the IIFE throws ENOENT and the MCP process exits
//     before responding to Claude's `initialize` message.
//     Follow-up: harden `mcp/src/index.ts` to fall back to `./package.json`
//     so the bundle layout can collapse. Then this shim becomes dead code.
writeJson(join(STAGING, 'package.json'), {
  name: 'customaise-mcpb-bundle',
  version: VERSION,
  private: true,
});
log('wrote staging/package.json (version shim for PKG_VERSION IIFE)');

// 9. Pack via @anthropic-ai/mcpb. Output ends up at mcp/customaise.mcpb.
log('packing → mcp/customaise.mcpb');
// Explicit package/bin selection also works inside an outer npm exec runtime.
// Pin the packer so a fresh release build does not silently change its format.
const MCPB_TOOL = '@anthropic-ai/mcpb@2.1.2';
run('npm', ['exec', '--yes', '--package=' + MCPB_TOOL, '--', 'mcpb', 'pack', STAGING, OUTPUT]);

// 10. Show info on the produced bundle.
run('npm', ['exec', '--yes', '--package=' + MCPB_TOOL, '--', 'mcpb', 'info', OUTPUT]);

log('done.');
log(`artifact: ${OUTPUT}`);
