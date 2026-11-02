/**
 * Everything the CLI prints arrives whole, however large and wherever it goes.
 *
 * Every command ends in `process.exit`. Written through `process.stdout`, a
 * result piped into another program stopped at the pipe's 64 KiB buffer on
 * macOS: an 87 KB tool result arrived as 65,536 bytes and no longer parsed,
 * while the same call redirected to a file was whole. These run the real
 * writer in a child process whose output is a pipe, exiting the moment it has
 * written, and fail if any CLI source prints another way.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUTPUT = new URL('../cli/output.js', import.meta.url).href;
const CLI_SOURCE = fileURLToPath(new URL('../../src/cli/', import.meta.url));

/** A child that prints with the CLI's writers, then exits at once, as every command does. */
const printThenExit = (body: string) =>
  `const { writeOut, writeErr } = await import(${JSON.stringify(OUTPUT)});\n${body}\nprocess.exit(0);`;

const run = (body: string) =>
  spawnSync(process.execPath, ['--input-type=module', '-e', printThenExit(body)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

describe('CLI output', () => {
  it('a result many times a pipe buffer arrives whole, though the process exits straight after writing it', () => {
    const result = run(`writeOut(JSON.stringify({ ok: true, data: 'x'.repeat(300000) }) + '\\n');`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).data.length, 300000);
  });

  it('diagnostics on stderr arrive whole too', () => {
    const result = run(`writeErr('y'.repeat(200000) + '\\n');`);
    assert.equal(result.status, 0);
    assert.equal(result.stderr.length, 200001);
  });

  it('stdout and stderr sharing one pipe keep every byte, in the order written', { skip: process.platform === 'win32' }, () => {
    // Under 2>&1 the two are one pipe, which Node leaves non-blocking once it
    // has opened stderr: the writer waits for the reader instead of giving up.
    const code = printThenExit(`writeErr('first\\n'); writeOut('z'.repeat(200000) + '\\n'); writeErr('last\\n');`);
    const result = spawnSync('/bin/sh', ['-c', '"$0" --input-type=module -e "$1" 2>&1', process.execPath, code], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `first\n${'z'.repeat(200000)}\nlast\n`);
  });

  it('a reader that stops reading early ends the output quietly, without a crash', async () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', printThenExit(`writeOut('w'.repeat(2000000) + '\\n');`)]);
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    // Read one chunk, then close the pipe, as `| head` does.
    await new Promise<void>(resolve => child.stdout.once('data', () => { child.stdout.destroy(); resolve(); }));
    const status = await new Promise<number | null>(resolve => child.on('close', resolve));
    assert.equal(status, 0);
    assert.equal(stderr, '');
  });

  it('no CLI source prints any other way', () => {
    for (const file of readdirSync(CLI_SOURCE).filter(name => name.endsWith('.ts') && name !== 'output.ts')) {
      const source = readFileSync(CLI_SOURCE + file, 'utf8');
      assert.doesNotMatch(source, /process\.(stdout|stderr)\.write\(|console\.(log|info|warn|error)\(/, file);
    }
  });
});
