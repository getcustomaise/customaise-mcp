/**
 * Every tool decides, explicitly, whether the master gate applies to it.
 *
 * "Allow user scripts" on the Customaise card in chrome://extensions resets
 * every time Chrome restarts or the extension reloads. With it off, scripts
 * are installed but Chrome will not run them — so a tool whose success
 * depends on a script actually executing returns a result that looks like a
 * different problem entirely: an empty list, a tool that is not there, a
 * reload that changed nothing.
 *
 * `withGate` exists so those tools say why. The rule is one line per tool and
 * nothing enforced it, which is how a tool shipped ungated: it returned an
 * empty result with nothing to explain it, while `list_webmcp_tools` right
 * next to it explained the identical cause.
 *
 * The fix for one tool is one line. The fix for the class is making the
 * decision unskippable: a new tool fails this test until someone classifies
 * it, and gets to that answer by reading the criterion rather than by
 * copying whichever neighbour they happened to paste from.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Walk up to mcp/src — tests run from test-out/, not from src/. */
function findSrcDir(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
        const candidate = join(dir, 'src');
        if (existsSync(join(candidate, 'server.ts'))) return candidate;
        dir = dirname(dir);
    }
    throw new Error('Could not locate mcp/src from ' + import.meta.url);
}

const src = readFileSync(join(findSrcDir(), 'server.ts'), 'utf8');

/**
 * The criterion: does this tool's result depend on user scripts actually
 * running? If yes it must gate, so a disabled toggle reads as a disabled
 * toggle rather than as a broken tool.
 */
const GATED = new Set([
    'list_scripts',        // scripts look active; none of them are
    'export_script',       // installs a script Chrome will not run
    'toggle_script',       // answers enabled:true for a script that stays inert
    'reload_tab',          // the reload cannot reinject anything
    'list_webmcp_tools',   // the list is empty, and not because there are none
    'call_webmcp_tool',    // the tool is absent, and not because it was removed
]);

/**
 * Tools that work identically with the toggle off. Gating these would cry
 * wolf: an agent that sees the banner on an export it just completed
 * correctly learns to ignore the banner.
 */
const UNGATED = new Set([
    'import_script',        // reads out of Customaise; execution irrelevant
    'delete_script',        // removal does not need the script to run
    'sync_scripts',         // pure export to disk; the files are correct
    'get_page_context',     // the page is the page
    'get_console_context',
    'get_selected_elements',
    'list_tabs',
    'open_tab',
    'close_tab',
    'focus_tab',
    'take_screenshot',
    'toggle_ui',
    // Carries the gate in its snapshot rather than as a banner: it reports
    // system status, so the toggle is data here, not an aside.
    'get_bridge_status',
]);

/** Each registered tool, with whether its handler calls `withGate`. */
function toolsWithGateUsage(): Array<{ name: string; gated: boolean }> {
    const re = /registerTool\('([a-z_]+)'/g;
    const marks: Array<{ name: string; at: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) marks.push({ name: m[1], at: m.index });

    return marks.map((t, i) => {
        const end = i + 1 < marks.length ? marks[i + 1].at : src.length;
        return { name: t.name, gated: src.slice(t.at, end).includes('withGate(') };
    });
}

describe('master-gate coverage', () => {
    const tools = toolsWithGateUsage();

    it('finds the tools it claims to be guarding', () => {
        // A guard that matches nothing passes for the wrong reason. Derived
        // from the classification rather than a literal, so removing a tool
        // does not mean editing a count in a second place and it still fails
        // if the regex ever stops finding the surface.
        assert.ok(tools.length > 0, 'no registerTool calls found — the regex broke');
        assert.equal(tools.length, GATED.size + UNGATED.size,
            'tool surface and classification disagree on size');
    });

    it('every registered tool is classified', () => {
        const unclassified = tools
            .filter((t) => !GATED.has(t.name) && !UNGATED.has(t.name))
            .map((t) => t.name);
        assert.deepEqual(
            unclassified,
            [],
            'new tool(s) with no master-gate decision. Read the criterion at the top of '
            + 'this file, then add each to GATED or UNGATED:\n  ' + unclassified.join('\n  '),
        );
    });

    it('classification has no stale entries', () => {
        // A renamed or deleted tool left behind in a set means the next
        // reader trusts a list that no longer describes the code.
        const live = new Set(tools.map((t) => t.name));
        const stale = [...GATED, ...UNGATED].filter((n) => !live.has(n));
        assert.deepEqual(stale, [], 'classified tools that no longer exist: ' + stale.join(', '));
    });

    it('every tool the criterion covers actually calls withGate', () => {
        const missing = tools.filter((t) => GATED.has(t.name) && !t.gated).map((t) => t.name);
        assert.deepEqual(missing, [], 'declared gated but never calls withGate: ' + missing.join(', '));
    });

    it('no tool gates without being classified as gated', () => {
        // The other direction matters too: a banner on a tool that works fine
        // teaches agents the banner is noise.
        const unexpected = tools.filter((t) => !GATED.has(t.name) && t.gated).map((t) => t.name);
        assert.deepEqual(unexpected, [], 'gates but is classified ungated: ' + unexpected.join(', '));
    });

    it('the banner reaches both halves of every gated result', () => {
        // `structuredContent` is what a CLI parses; `content` is what the
        // model reads. A banner on only one half was the original bug: the
        // model saw the explanation and the CLI got clean JSON with no hint,
        // or the CLI got a banner glued to its JSON and `JSON.parse` failed.
        const re = /registerTool\('([a-z_]+)'/g;
        const marks: Array<{ name: string; at: number }> = [];
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) marks.push({ name: m[1], at: m.index });

        for (const [i, t] of marks.entries()) {
            if (!GATED.has(t.name)) continue;
            const body = src.slice(t.at, i + 1 < marks.length ? marks[i + 1].at : src.length);
            assert.ok(
                body.includes('withGate('),
                `${t.name}: structuredContent half is not gated`,
            );
            assert.ok(
                body.includes('gate.warning +'),
                `${t.name}: content half carries no banner, so the model is never told`,
            );
        }
    });

    it('the gate costs nothing, so there is no reason to skip it', () => {
        // It reads state the server already holds. It was once a dispatch,
        // which made five tools charge two cap units instead of one and gave
        // people a real reason to leave it off a tool.
        const start = src.indexOf('function checkUserScriptsGate(');
        assert.ok(start > 0, 'checkUserScriptsGate was renamed or removed');
        // To the end of its body: the next declaration at the same indent.
        const fn = src.slice(start, src.indexOf('\n  }', start) + 4);
        assert.ok(fn.includes('bridge.getSystemStatus()'), 'gate no longer reads cached status');
        assert.ok(!fn.includes('dispatchTool'), 'the gate dispatches again — it now costs a cap unit');
        assert.ok(!fn.includes('await'), 'the gate is no longer synchronous');
    });
});
