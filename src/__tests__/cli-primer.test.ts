/**
 * How an agent finds out this CLI exists, and that what it is told is true.
 *
 * `--help` teaches usage well enough once an agent knows the name. The gap was
 * first contact: an agent holding only a shell has no way to discover the tool,
 * and the MCP server's instructions never mentioned it, so even an agent
 * already connected had no reason to know. `customaise init` closes that by
 * writing a primer into the project the agent is working in.
 *
 * The risk with a primer is that it becomes a fourth description of the CLI and
 * drifts, which is precisely how the three IDE lists in the defect log
 * diverged. So these check that what it teaches is what the CLI actually does.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildPrimer, PRIMER_BEGIN, PRIMER_END } from '../cli/primer.js';
import { EXIT } from '../cli/exit-codes.js';

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
const primer = buildPrimer('3.0.0');
const cli = readFileSync(join(SRC, 'cli', 'index.ts'), 'utf-8');

describe('the primer teaches only verbs that exist', () => {
  it('every command it shows is a real verb', () => {
    // A primer that teaches a verb we removed is worse than no primer: the
    // agent trusts it and burns a turn finding out.
    // Flags are not verbs: `customaise --help` is a real invocation but there
    // is no `--help` case to find.
    const shown = [...primer.matchAll(/^customaise ([a-z][a-z-]*)/gm)].map((m) => m[1]);
    assert.ok(shown.length >= 4, `expected several commands, found ${shown.length}`);
    for (const verb of new Set(shown)) {
      const handled = cli.includes(`case '${verb}':`) || cli.includes(`verb === '${verb}'`);
      assert.ok(handled, `primer teaches "customaise ${verb}" but the CLI has no such verb`);
    }
  });

  it('the exit codes it documents match the ones we ship', () => {
    for (const [code, meaning] of [[2, 'malformed'], [3, 'unreachable'], [5, 'quota'], [6, 'denied'], [8, 'rejected']] as const) {
      assert.match(primer, new RegExp(`\\\\| ${code} \\\\|`), `primer omits exit ${code} (${meaning})`);
    }
    assert.equal(EXIT.REJECTED, 8);
    assert.equal(EXIT.CAP, 5);
  });

  it('says doctor is free, because that is why it is the first instruction', () => {
    assert.match(primer, /costs no quota/);
  });

  it('states the consent rule an agent cannot discover by trying', () => {
    // An agent that does not know self-granted `allow` degrades to `prompt`
    // writes a script, watches it block, and concludes the tool is broken.
    assert.match(primer, /cannot grant itself an ungated tool/);
    assert.match(primer, /still behaves as .allow.|behaves as .prompt./);
  });
});

describe('the primer block is safe to write into a file someone else owns', () => {
  it('is fenced, so a re-run replaces rather than stacks', () => {
    assert.ok(primer.startsWith(PRIMER_BEGIN));
    assert.ok(primer.trimEnd().endsWith(PRIMER_END));
  });

  it('fences are HTML comments, invisible in rendered markdown', () => {
    assert.match(PRIMER_BEGIN, /^<!--.*-->$/);
    assert.match(PRIMER_END, /^<!--.*-->$/);
  });

  it('init writes without needing a daemon, a browser or a sign-in', () => {
    // Teaching an agent how to use the tool must not require the tool to be
    // working. The handler returns before any daemon connect.
    const initAt = cli.indexOf("verb === 'init'");
    // The CALL, not the import: the import line sits at the top of the file
    // and would make this pass no matter where the handler went.
    const connectAt = cli.indexOf('connectToDaemon(');
    assert.ok(initAt !== -1, 'no init verb');
    assert.ok(initAt < connectAt, 'init must be handled before the daemon connect');
  });
});

describe('the handbook teaches the provenance rule without dangling', () => {
  const server = readFileSync(join(SRC, 'server.ts'), 'utf-8');
  const handbook = server.slice(server.indexOf('agentscript-conventions'),
                                server.indexOf('agentscript-conventions') + 40000);

  it('states that a script cannot grant itself an ungated tool', () => {
    // An agent that does not know this writes `allow`, watches the call block,
    // and concludes the tool is broken.
    expect_(handbook.includes('cannot grant itself an ungated tool'),
      'the handbook never states the provenance rule');
  });

  it('names the warning the agent will actually receive', () => {
    expect_(handbook.includes('WEBMCP_ALLOW_DOWNGRADED'),
      'the handbook does not name the warning export_script returns');
  });

  it('points at nothing that does not exist', () => {
    // It used to say "(see the consent model)". There is no consent model
    // section in this handbook, so an agent following the pointer found
    // nothing. A cross-reference is a promise that something is there.
    const refs = [...handbook.matchAll(/\(see ([^)]{3,40})\)/g)].map((m) => m[1]);
    for (const ref of refs) {
      const head = ref.replace(/^the /, '').trim();
      expect_(handbook.toLowerCase().includes('## ' + head.toLowerCase())
        || handbook.toLowerCase().includes('### ' + head.toLowerCase()),
        `handbook points at "${ref}" but has no such section`);
    }
  });
});

function expect_(cond: boolean, msg: string): void {
  assert.ok(cond, msg);
}

describe('the CLI is discoverable from the surfaces an agent already sees', () => {
  it('the MCP server instructions point at it', () => {
    const instructions = readFileSync(join(SRC, 'build-server.ts'), 'utf-8');
    assert.match(instructions, /customaise doctor/);
    assert.match(instructions, /customaise init/);
  });

  it('the doctor line describes what doctor actually reports', () => {
    // It read "bridge, auth, cap and runtime state" while doctor had grown
    // sign-in, tier, quota and the user-scripts gate. A help line that
    // undersells the one command an agent runs when lost is worse than none.
    const line = cli.split('\n').find((l) => l.includes('customaise doctor '));
    assert.ok(line, 'no doctor line in --help');
    for (const word of ['sign-in', 'tier', 'quota', 'gate']) {
      assert.ok(line!.includes(word), `--help doctor line omits "${word}": ${line!.trim()}`);
    }
  });

  it('--help shows the loop, not just a verb list', () => {
    // A verb list leaves the agent to infer the order. The loop is the part
    // that is not obvious: install, reload, wait, call.
    assert.match(cli, /Typical loop:/);
    assert.match(cli, /scripts install[\s\S]{0,400}tab reload[\s\S]{0,200}call/);
  });
});
