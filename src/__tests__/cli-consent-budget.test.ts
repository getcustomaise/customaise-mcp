/**
 * `customaise call` waits out the consent modal instead of abandoning it.
 *
 * A call against a `prompt`-gated tool blocks until the user answers the
 * modal in the browser, up to the extension's five-minute budget. The SDK's
 * default request timeout is sixty seconds, so a bare `client.callTool`
 * abandons the call at minute one while the modal is still up: the user
 * clicks Approve at minute two and nobody is listening.
 *
 * This was finding 46 in the ARD, specified with its own paragraph ("give
 * `call` a timeout at least as long as the modal budget, and print a line to
 * stderr when it starts waiting") — and still missed in the first
 * implementation pass, because every e2e test answers consent through a
 * mocked ack in milliseconds. A requirement only a five-minute wall-clock
 * wait can exercise needs a source pin, since no fast test will ever
 * exercise it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function pkgRoot(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
        if (existsSync(join(dir, 'src', 'cli', 'index.ts'))) return dir;
        dir = dirname(dir);
    }
    throw new Error('could not locate the mcp package root');
}

const ROOT = pkgRoot();
const cli = readFileSync(join(ROOT, 'src', 'cli', 'index.ts'), 'utf-8');

describe('the consent budget on customaise call', () => {
    it('covers the extension modal budget with headroom', () => {
        const m = /CONSENT_BUDGET_MS = ([\d_]+)/.exec(cli);
        assert.ok(m, 'CONSENT_BUDGET_MS is gone from the CLI');
        const budget = Number(m![1].replace(/_/g, ''));
        // The extension holds the modal open for HITL_CONSENT_TIMEOUT_MS
        // (300_000 in hitl-gate-service.js). The CLI must outlast it, plus
        // headroom for the round trips on either side.
        assert.ok(
            budget >= 300_000 + 15_000,
            `budget is ${budget}ms; the modal alone runs 300000ms and the answer still has to travel back`,
        );
    });

    it('the call verb uses the budget, not the bare client', () => {
        const at = cli.indexOf("case 'call':");
        assert.ok(at > 0, "the 'call' verb moved");
        const body = cli.slice(at, cli.indexOf('case ', at + 10));
        assert.match(
            body, /callToolWithConsentBudget\(\s*'call_webmcp_tool'/,
            "customaise call no longer goes through the consent budget; the SDK's 60s default abandons a modal the user is still reading",
        );
    });

    it('says on stderr why the terminal has gone quiet', () => {
        // A terminal silent for a minute looks hung. stderr, never stdout:
        // stdout is the JSON contract.
        const helper = cli.slice(
            cli.indexOf('const callToolWithConsentBudget'),
            cli.indexOf("switch (verb)"),
        );
        assert.match(helper, /process\.stderr\.write/, 'the waiting note is gone');
        assert.match(helper, /clearTimeout/, 'the note timer is never cleared, so a fast call would print it late');
        assert.ok(!/process\.stdout\.write/.test(helper), 'the note writes to stdout, which corrupts the JSON contract');
    });
});
