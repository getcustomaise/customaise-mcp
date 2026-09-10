#!/usr/bin/env node
/** Verify the actual release payloads and start them outside the source tree. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
const { values } = parseArgs({ options: {
  bundle: { type: 'string' }, npm: { type: 'string' }, output: { type: 'string' },
} });
assert.ok(values.bundle, 'Usage: verify-release.mjs --bundle <file.mcpb> [--npm <file.tgz>] [--output <report.json>]');
const scratch = mkdtempSync(join(tmpdir(), 'customaise-release-proof-'));
const report = { version: pkg.version, node: process.version, artifacts: [], scope: 'Actual packaged bytes and isolated stdio processes; ephemeral bridge ports, no user browser or account.' };
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const lock = JSON.parse(readFileSync(join(pkgRoot, 'package-lock.json'), 'utf8'));
const approvedDependencies = new Set(Object.entries(lock.packages)
  .filter(([path]) => path.includes('node_modules/'))
  .map(([path, entry]) => `${path.split('node_modules/').at(-1)}@${entry.version}`));

function verifyDependencies(dir) {
  const versions = new Set();
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name === 'package.json') {
        const dependency = JSON.parse(readFileSync(child, 'utf8'));
        if (!dependency.name || !dependency.version || dependency.name === pkg.name) continue;
        const key = `${dependency.name}@${dependency.version}`;
        versions.add(key);
      }
    }
  }
  walk(dir);
  const found = [...versions].sort();
  const untested = found.filter((key) => !approvedDependencies.has(key));
  assert.deepEqual(untested, [], 'packaged dependencies differ from tested lockfile');
  return found;
}

const run = (command, args, options = {}) => execFileSync(command, args, {
  encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024, ...options,
});

function files(dir, suffix, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '__tests__'].includes(entry.name)) return [];
      return files(path, suffix, base);
    }
    return entry.name.endsWith(suffix) ? [relative(base, path).replaceAll('\\', '/')] : [];
  }).sort();
}

const compiled = files(join(pkgRoot, 'dist'), '.js');
const expected = files(join(pkgRoot, 'src'), '.ts')
  .filter((name) => !name.endsWith('.d.ts')).map((name) => name.replace(/\.ts$/, '.js')).sort();
assert.deepEqual(compiled, expected, 'dist must contain every production source and no obsolete JavaScript');

function verifyPayload(serverDir) {
  assert.deepEqual(files(serverDir, '.js'), compiled, 'packaged JavaScript inventory differs from source build');
  for (const name of compiled) {
    assert.equal(hash(join(serverDir, name)), hash(join(pkgRoot, 'dist', name)), `stale packaged code: ${name}`);
  }
  assert.equal(run(process.execPath, [join(serverDir, 'index.js'), '--version']).trim(), pkg.version);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function verifyStdio(entry, cwd, env, expectedTools) {
  // Explicitly replace bridge/config/workspace paths; never attach this proof
  // to the user's resident daemon or their signed-in browser.
  const client = new Client({ name: 'customaise-release-proof', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [entry], cwd,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
      ...env, CUSTOMAISE_WS_PORT: String(await freePort()),
      CUSTOMAISE_WORKSPACE: cwd, CUSTOMAISE_CONFIG_DIR: join(cwd, 'config'),
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, pkg.version);
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(tools, expectedTools);
    const resources = (await client.listResources()).resources.map((resource) => resource.uri);
    for (const uri of ['customaise://conventions', 'customaise://agentscript-conventions', 'customaise://userscript-conventions']) {
      assert.ok(resources.includes(uri), `missing resource ${uri}`);
      const read = await client.readResource({ uri });
      assert.ok(read.contents.some((content) => typeof content.text === 'string' && content.text.length > 100), `empty ${uri}`);
    }
    return { tools: tools.length, resources: resources.length, conventionsRead: 3 };
  } catch (error) {
    throw new Error(`${error.message}\nPackaged server stderr: ${stderr}`, { cause: error });
  } finally {
    await client.close();
  }
}

try {
  const bundle = resolve(values.bundle);
  const listing = run('unzip', ['-Z1', bundle]).trim().split('\n');
  assert.ok(listing.every((name) => !name.startsWith('/') && !name.split('/').includes('..')), 'unsafe archive path');
  const bundleDir = join(scratch, 'desktop');
  mkdirSync(bundleDir);
  run('unzip', ['-q', bundle, '-d', bundleDir]);
  const manifest = JSON.parse(readFileSync(join(bundleDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.server.entry_point, 'server/index.js');
  assert.equal(manifest.server.mcp_config.env.CUSTOMAISE_MCP_OUTPUT, 'inline');
  const declaredTools = manifest.tools.map((tool) => tool.name).sort();
  assert.equal(declaredTools.length, 19);
  const serverDir = join(bundleDir, 'server');
  assert.equal(JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf8')).version, pkg.version);
  verifyPayload(serverDir);
  const desktopDependencies = verifyDependencies(join(serverDir, 'node_modules'));
  const desktop = await verifyStdio(join(serverDir, 'index.js'), bundleDir, manifest.server.mcp_config.env, declaredTools);
  report.artifacts.push({ kind: 'mcpb', sha256: hash(bundle), compiledFiles: compiled.length, dependencies: desktopDependencies, ...desktop });

  if (values.npm) {
    const archive = resolve(values.npm);
    const installDir = join(scratch, 'npm-install');
    mkdirSync(installDir);
    writeFileSync(join(installDir, 'package.json'), '{"name":"customaise-release-proof","version":"1.0.0","private":true}\n');
    // Install from the tarball, including its resolved production dependencies.
    // No source-tree node_modules can satisfy an omitted packaged dependency.
    run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', archive], { cwd: installDir });
    const installed = join(installDir, 'node_modules', '@customaise', 'mcp');
    const installedPkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    assert.equal(installedPkg.version, pkg.version);
    const dist = join(installed, 'dist');
    verifyPayload(dist);
    const npmDependencies = verifyDependencies(join(installDir, 'node_modules'));
    assert.equal(run(process.execPath, [join(installed, installedPkg.bin.customaise), '--version']).trim(), pkg.version);
    const npmResult = await verifyStdio(join(dist, 'index.js'), installDir, { CUSTOMAISE_MCP_OUTPUT: 'file' }, declaredTools);
    report.artifacts.push({ kind: 'npm', sha256: hash(archive), compiledFiles: compiled.length, dependencies: npmDependencies, cliVersion: pkg.version, ...npmResult });
  }
  if (values.output) writeFileSync(resolve(values.output), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
