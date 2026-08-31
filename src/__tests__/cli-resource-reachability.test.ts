/**
 * Every resource the server publishes must be reachable from the CLI.
 *
 * `server.ts` registers four, and two of them are the ONLY documents that say
 * how to build a UserScript or an AgentScript: `customaise://userscript-
 * conventions` (19k chars) and `customaise://agentscript-conventions`. An MCP
 * client gets them from `resources/list` for free. The CLI had no verb that
 * reached any of them, so an agent with only a shell could install scripts and
 * never learn how to write one.
 *
 * That bites hardest exactly where the CLI is the only option. A cloud agent
 * VM cannot attach a local MCP server at all, so its agent is both the one that
 * most needs the conventions and the one that could not read them.
 *
 * WHY IT WAS MISSED, which is what this test is really guarding against.
 * The ARD reasoned parity at the transport: "the CLI is a client of the
 * protocol, not of the transport, which is what keeps a single definition of
 * every tool." True, and the daemon was serving these the whole time. But the
 * command surface was then enumerated from the TOOL list, so a capability the
 * protocol carried had no verb. A test over tools alone cannot see that, which
 * is why this one is over resources.
 *
 * Source-extraction, in the style of `cli-schema-conformance.test.ts` and for
 * the same reason: it compares two files that must agree, and neither is worth
 * booting a server to read.
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

/** Every `customaise://` uri the server registers as a resource. */
function registeredResources(): string[] {
  const src = readFileSync(join(SRC, 'server.ts'), 'utf8');
  const found = new Set<string>();
  // registerResource('name', 'customaise://uri', ...) and ResourceTemplate('customaise://uri/{x}')
  const re = /registerResource\(\s*'[^']+'\s*,\s*(?:new ResourceTemplate\(\s*)?'(customaise:\/\/[^']+)'/g;
  for (let m = re.exec(src); m; m = re.exec(src)) found.add(m[1]);
  return [...found].sort();
}

const cli = () => readFileSync(join(SRC, 'cli', 'index.ts'), 'utf8');

describe('the CLI can reach what the server publishes', () => {
  it('the server registers resources at all (guards the extractor itself)', () => {
    // A regex that silently matched nothing would make every assertion below
    // vacuously true, which is the failure mode this whole file exists to stop.
    const uris = registeredResources();
    assert.ok(uris.length >= 3, `expected several resources, extracted ${uris.length}: ${uris.join(', ')}`);
    assert.ok(
      uris.some((u) => u.includes('agentscript-conventions')),
      'agentscript-conventions was not extracted; the regex has drifted from server.ts',
    );
  });

  it('has a verb to LIST them', () => {
    assert.match(
      cli(),
      /case 'resources':[\s\S]{0,200}listResources\(\)/,
      'no `customaise resources` verb: an agent cannot discover what documents exist',
    );
  });

  it('has a verb to READ one', () => {
    assert.match(
      cli(),
      /case 'resource':[\s\S]{0,600}readResource\(/,
      'no `customaise resource <uri>` verb: an agent can list the conventions and not open them',
    );
  });

  it('accepts a bare name, not only a full uri', () => {
    // An agent reading the list types `agentscript-conventions`, not the uri.
    assert.match(
      cli(),
      /sub\.includes\(':\/\/'\)\s*\?\s*sub\s*:\s*`customaise:\/\/\$\{sub\}`/,
      'the read verb requires a full customaise:// uri',
    );
  });

  it('both verbs appear in `schema`, so an agent discovers them the usual way', () => {
    const src = cli();
    for (const command of ['resources', 'resource']) {
      assert.match(
        src,
        new RegExp(`\\{ command: '${command}',`),
        `\`${command}\` is dispatchable but absent from the schema table, so an agent asking the CLI what it can do is told wrong`,
      );
    }
  });

  it('both verbs appear in --help', () => {
    const src = cli();
    assert.match(src, /customaise resources\s+documents the server publishes/);
    assert.match(src, /customaise resource <name\|uri>/);
  });
});
