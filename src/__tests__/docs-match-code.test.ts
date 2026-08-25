/**
 * The README describes what the code does, in both directions.
 *
 * Two failures of this kind shipped, and neither was catchable by any test
 * that only reads code:
 *
 *   - `--help` said `--pretty` gives "human-readable rendering on stderr".
 *     It indents JSON on stdout and writes nothing to stderr. Anyone who
 *     redirected stderr to read it saw an empty stream. mcp/README.md had it
 *     right, so two of three descriptions disagreed with the one behaviour.
 *
 *   - `CUSTOMAISE_CONFIG_DIR` and `CUSTOMAISE_HTTP_PORT` are read by the code
 *     and were in no table anywhere, which was only noticed because the
 *     Privacy Policy started telling people to delete the directory one of
 *     them relocates.
 *
 * Documentation drift is invisible to a test suite that only reads code, and
 * the cost lands on whoever believes the docs. These compare the two.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function pkgRoot(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
        if (existsSync(join(dir, 'src', 'server.ts'))) return dir;
        dir = dirname(dir);
    }
    throw new Error('could not locate the mcp package root');
}

const ROOT = pkgRoot();
const readme = readFileSync(join(ROOT, 'README.md'), 'utf-8');
const cli = readFileSync(join(ROOT, 'src', 'cli', 'index.ts'), 'utf-8');

/**
 * Every source file, not a hand-picked list.
 *
 * The first version of this test named three files and immediately reported
 * two documented vars as phantoms, because they are read in
 * extension-bridge.ts. A list of files to check is the same mistake this
 * suite has now made four times in different guises: it works until somebody
 * puts the thing somewhere the list does not mention.
 */
function allSources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        const p = join(dir, entry.name);
        if (entry.isDirectory()) allSources(p, out);
        else if (entry.name.endsWith('.ts')) out.push(readFileSync(p, 'utf-8'));
    }
    return out;
}
const SOURCES = allSources(join(ROOT, 'src'));

/** Every CUSTOMAISE_* name appearing in a source file. */
function envNamesIn(text: string): Set<string> {
    return new Set([...text.matchAll(/CUSTOMAISE_[A-Z_]+/g)].map((m) => m[0]));
}

describe('README and code agree on environment variables', () => {
    it('documents every env var a user could need to set', () => {
        // Internal tuning knobs are deliberately excluded: they exist for
        // debugging a wedged dispatch, not for users, and documenting them
        // would invite tuning that hides a real problem.
        const INTERNAL = new Set([
            'CUSTOMAISE_MCP_DISPATCH_TIMEOUT_MS',
            'CUSTOMAISE_MCP_INIT_SESSION_GRACE_MS',
        ]);

        const inCode = new Set(SOURCES.flatMap((t) => [...envNamesIn(t)]));
        const documented = envNamesIn(readme);

        const undocumented = [...inCode].filter((n) => !INTERNAL.has(n) && !documented.has(n));
        assert.deepEqual(
            undocumented, [],
            'read by the code, in no README table:\n  ' + undocumented.join('\n  ')
            + '\n\nAdd them, or add them to INTERNAL here with a reason.',
        );
    });

    it('does not document env vars the code never reads', () => {
        const inCode = new Set(SOURCES.flatMap((t) => [...envNamesIn(t)]));
        const phantom = [...envNamesIn(readme)].filter((n) => !inCode.has(n));
        assert.deepEqual(
            phantom, [],
            'documented but never read, so setting it does nothing:\n  ' + phantom.join('\n  '),
        );
    });
});

describe('README and --help agree on what --pretty does', () => {
    it('neither claims --pretty writes to stderr', () => {
        // It writes indented JSON to stdout. Verified by capturing the two
        // streams separately: stdout 294 bytes, stderr 0.
        // The line the user actually sees in --help, not the first mention
        // of the flag anywhere in the file. The docstring above it explains
        // that --pretty does NOT go to stderr, and matching on the word
        // rather than the claim made this test flag its own explanation.
        const helpLine = cli.split('\n').find((l) => /^\s*--pretty\s{2,}/.test(l));
        assert.ok(helpLine, '--help no longer has a --pretty line');
        assert.ok(
            !/stderr/i.test(helpLine!),
            `--help says: "${helpLine!.trim()}" but --pretty writes to stdout`,
        );

        // Same in the README: the sentence describing the flag, not any
        // sentence that happens to mention stderr nearby.
        const readmeSentence = (readme.match(/[^.\n]*`--pretty`[^.\n]*\./) || [''])[0];
        assert.ok(readmeSentence, 'README no longer describes --pretty');
        assert.ok(
            !/stderr/i.test(readmeSentence),
            `README says: "${readmeSentence.trim()}" but --pretty writes to stdout`,
        );
    });

    it('the code really does write the result to stdout', () => {
        // If this ever moves to stderr, the docs above become correct and
        // this test is what tells you to update them.
        assert.match(cli, /process\.stdout\.write\(JSON\.stringify\(payload/);
    });
});

describe('the published package ships what it claims and nothing dead', () => {
    /**
     * Source maps were 28% of the unpacked tarball and every one of them was
     * broken: they name `../src/*.ts`, `src/` is not published, and no
     * `sourcesContent` is embedded. A debugger following them finds nothing.
     *
     * The tsc output is not minified, so stack traces already point at
     * readable JavaScript; the maps only added TypeScript line numbers that
     * could never resolve. The .mcpb bundle already stripped them, so this
     * was the one artefact still carrying them.
     */
    it('excludes source maps from the npm tarball', () => {
        const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
        assert.ok(
            (pkg.files || []).includes('!dist/**/*.map'),
            'package.json files[] no longer excludes source maps; they point at '
            + 'src/, which is not published, so every one of them is a dead reference',
        );
    });

    it('declares public access explicitly, because scoped defaults to private', () => {
        // npm publishes a SCOPED package as `restricted` unless told
        // otherwise. @customaise/mcp is public today only because 2.0.7 is,
        // and the next publish inherits that. Inheritance is not an
        // intention, and the failure mode is silent: a publish that reports
        // success and that nobody can install.
        const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
        assert.equal(
            pkg.publishConfig?.access, 'public',
            'publishConfig.access is not "public"; a scoped package would publish restricted',
        );
    });

    it('refuses to publish code that has not been built and tested', () => {
        // Publishing is irreversible: a bad version cannot be meaningfully
        // unpublished, and npx caches it, so recovery is a new version plus
        // waiting out the cache. The build half already exists because a
        // stale dist nearly shipped a tool deleted from source; the test
        // half is 7.6 seconds.
        const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
        const hook = pkg.scripts?.prepublishOnly ?? '';
        assert.match(hook, /npm run build/, 'prepublishOnly no longer rebuilds; a stale dist could ship');
        assert.match(hook, /npm test/, 'prepublishOnly no longer runs the suite');
    });

    it('still declares both binaries, and both have a shebang', () => {
        // npm sets the exec bit, but a bin entry without `#!/usr/bin/env node`
        // fails at invocation, and only on a real install.
        const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
        const bins = Object.entries<string>(pkg.bin || {});
        assert.equal(bins.length, 2, 'expected customaise-mcp and customaise');
        for (const [name, target] of bins) {
            const p = join(ROOT, target);
            assert.ok(existsSync(p), `${name} -> ${target} does not exist`);
            assert.ok(
                readFileSync(p, 'utf-8').startsWith('#!'),
                `${name} -> ${target} has no shebang, so npx cannot run it`,
            );
        }
    });
});
