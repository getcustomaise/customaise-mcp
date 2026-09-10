/**
 * The loopback door's authentication.
 *
 * The daemon serves the same nineteen tools the IDE gets, against a browser
 * the user is already signed into. Anything that reaches it can act as them,
 * so the token is the whole boundary and these pin its properties rather
 * than trusting a code reading.
 *
 * What this does NOT claim: protection from a process already running as the
 * same user. That process can read the token file directly, and can read the
 * browser profile without going near Customaise at all. The boundary is the
 * user account, and extension-bridge.ts documents the same residual risk for
 * the WebSocket door.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function pkgRoot(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
        if (existsSync(join(dir, 'src', 'daemon.ts'))) return dir;
        dir = dirname(dir);
    }
    throw new Error('could not locate the mcp package root');
}

const src = readFileSync(join(pkgRoot(), 'src', 'daemon.ts'), 'utf-8');

/**
 * The source with comments stripped.
 *
 * Needed because the comment beside the bind reads "Never 0.0.0.0", and a
 * naive search for that string flags the very line that explains why it is
 * absent. The same shape of mistake made an earlier guard in this suite
 * report its own rationale as a defect.
 */
const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

describe('daemon token', () => {
    it('is minted from a CSPRNG with at least 128 bits', () => {
        const m = /randomBytes\((\d+)\)/.exec(src);
        assert.ok(m, 'token is no longer minted with randomBytes');
        assert.ok(
            Number(m[1]) * 8 >= 128,
            `token is ${Number(m[1]) * 8} bits; a guessable token is the whole boundary`,
        );
    });

    it('is compared in constant time, never with === or !==', () => {
        assert.match(src, /timingSafeEqual/, 'token comparison is not constant time');
        assert.ok(
            !/headers\[TOKEN_HEADER\]\s*!==\s*token/.test(src),
            'the raw !== comparison is back; it leaks the token prefix through timing',
        );
    });


});

describe('daemon exposure', () => {
    it('binds loopback only, never all interfaces', () => {
        assert.match(
            src, /server\.listen\([^)]*'127\.0\.0\.1'/,
            'the daemon must bind 127.0.0.1; this endpoint reaches a signed-in browser',
        );
        assert.ok(!/0\.0\.0\.0/.test(code), 'the daemon binds all interfaces');
    });

    it('writes the token file owner-only, in a owner-only directory', () => {
        // Line-based, not a `[^)]*` window: the writeFileSync call contains a
        // nested JSON.stringify(...), and a lazy paren class stops at ITS
        // closing paren and never reaches the mode. That exact bug shipped in
        // a schema check earlier in this work.
        const writeLine = src.split('\n').find((l) => l.includes('writeFileSync(tmp'));
        assert.ok(writeLine, 'the token write moved');
        assert.match(writeLine!, /mode: 0o600/, 'token file is not 0600');
        assert.match(src, /mkdirSync\([^)]*mode: 0o700/, 'config directory is not created 0700');
        // recursive:true only sets mode on directories it creates, and this
        // one usually exists from a previous run.
        assert.match(src, /chmodSync\([^,]+, 0o700\)/, 'an existing config directory is left at its old mode');
    });
});
