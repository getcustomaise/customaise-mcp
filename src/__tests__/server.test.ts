/**
 * MCP Server — Tool/Prompt/Resource Registration Tests
 *
 * Verifies that all 12 tools, 2 prompts, and 3 resources are registered
 * correctly and that tool handlers delegate to the ExtensionBridge with
 * the right request type and arguments.
 *
 * Runner: Node's built-in node:test + tsx for TypeScript
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, rmSync } from 'node:fs';
import { registerTools, registerPromptsAndResources } from '../server.js';

const TMP_TEST_FILES = [
  '/tmp/test-import.user.js',
  '/tmp/test-export.user.js',
  '/tmp/test-screenshot.png',
];
const TMP_TEST_DIRS = [
  '/tmp/test-sync-scripts',
];

// ─── Mock Bridge ──────────────────────────────────────────────────────

function createMockBridge() {
  return {
    request: mock.fn(async () => ({ mock: true })),
    // v2 cap-enforced dispatch path. Tool handlers in server.ts route
    // through this; tests assert on the call shape exactly the same
    // way they used to for `request`.
    dispatchTool: mock.fn(async () => ({ mock: true })),
    onPush: mock.fn(),
    isConnected: true,
    // The master-gate banner is READ from here, not fetched. It used to be a
    // second `dispatchTool` per call on five tools, which billed the free
    // tier twice for the documented loop. Returning null exercises the
    // fail-open path: an unknown gate must not manufacture a warning.
    getSystemStatus: mock.fn(() => null),
    getSessionSnapshot: mock.fn(() => ({
      extensionConnected: true, systemStatus: null, tier: null, authenticated: null,
      remoteApprovals: null, capMode: null, dailyUsed: null, dailyCap: null,
      weeklyUsed: null, weeklyCap: null,
    })),
  };
}

// ─── Mock MCP Server ──────────────────────────────────────────────────

function createMockServer() {
  const tools: Array<{ name: string; handler: Function }> = [];
  const prompts: Array<{ name: string; handler: Function }> = [];
  const resources: Array<{ name: string; uri: any; handler: Function }> = [];

  return {
    // v2 registration surface: `registerTool(name, config, handler)` and
    // `registerResource(name, uri, metadata, handler)`. The config object
    // carries description, inputSchema and annotations; none of it matters
    // here, so it is discarded and only the handler is kept.
    //
    // These replaced the v1 variadic `.tool()` / `.resource()` in the
    // 2026-07-28 migration. When the codemod rewrote server.ts, this mock
    // was the only thing that broke, and it broke loudly: 22 failures that
    // looked like a migration bug and were a stale test double.
    registerTool: mock.fn((name: string, _config: unknown, handler?: Function) => {
      tools.push({ name, handler: typeof handler === 'function' ? handler : () => {} });
    }),
    registerPrompt: mock.fn((name: string, _config: unknown, handler?: Function) => {
      prompts.push({ name, handler: typeof handler === 'function' ? handler : () => {} });
    }),
    registerResource: mock.fn((name: string, uri: any, _metadata: unknown, handler?: Function) => {
      resources.push({ name, uri, handler: typeof handler === 'function' ? handler : () => {} });
    }),
    _tools: tools,
    _prompts: prompts,
    _resources: resources,
  };
}

// ─── Expected Tool Names ──────────────────────────────────────────────

const EXPECTED_TOOLS = [
  // Reads state the server already holds; spends no cap unit. `doctor` is
  // built on it precisely so diagnosing a cap problem does not cost a call.
  'get_bridge_status',
  // Blocks until a tool registers, for ONE unit however long it waits. The
  // alternative is polling `list_webmcp_tools`, which costs a unit per poll.
  'list_scripts',
  'import_script',
  'export_script',
  'delete_script',
  'toggle_script',
  'get_page_context',
  'get_console_context',
  'list_tabs',
  'reload_tab',
  'take_screenshot',
  'toggle_ui',
  'sync_scripts',
];

const EXPECTED_PROMPTS: string[] = [];

const EXPECTED_RESOURCES = [
  'scripts-list',
  'script-source',
  'conventions',
  'userscript-conventions',
  'agentscript-conventions',
];

describe('Server Tool Registration', () => {
  let server: ReturnType<typeof createMockServer>;
  let bridge: ReturnType<typeof createMockBridge>;

  beforeEach(() => {
    server = createMockServer();
    bridge = createMockBridge();
    registerTools(server as any, bridge as any);
    registerPromptsAndResources(server as any, bridge as any);
  });

  afterEach(() => {
    for (const f of TMP_TEST_FILES) {
      try { unlinkSync(f); } catch {}
    }
    for (const d of TMP_TEST_DIRS) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  // ─── Registration Counts ────────────────────────────────────────

  it('registers exactly 19 tools', () => {
    assert.equal(server.registerTool.mock.callCount(), 19);
  });

  it('registers exactly 0 prompts', () => {
    assert.equal(server.registerPrompt.mock.callCount(), 0);
  });

  it('registers exactly 5 resources', () => {
    assert.equal(server.registerResource.mock.callCount(), 5);
  });

  // ─── Tool Names ─────────────────────────────────────────────────

  it('registers all expected tool names', () => {
    const registeredNames = server.registerTool.mock.calls.map((call: any) => call.arguments[0]);
    for (const name of EXPECTED_TOOLS) {
      assert.ok(registeredNames.includes(name), `Tool '${name}' not registered`);
    }
  });

  it('registers all expected prompt names', () => {
    const registeredNames = server.registerPrompt.mock.calls.map((call: any) => call.arguments[0]);
    for (const name of EXPECTED_PROMPTS) {
      assert.ok(registeredNames.includes(name), `Prompt '${name}' not registered`);
    }
  });

  it('registers all expected resource names', () => {
    const registeredNames = server.registerResource.mock.calls.map((call: any) => call.arguments[0]);
    for (const name of EXPECTED_RESOURCES) {
      assert.ok(registeredNames.includes(name), `Resource '${name}' not registered`);
    }
  });

  // ─── Tool Handler Delegation ────────────────────────────────────

  describe('tool handlers delegate to bridge correctly', () => {
    const PASSTHROUGH_TOOLS: Array<{ tool: string; bridgeType: string; args?: Record<string, unknown> }> = [
      { tool: 'list_scripts', bridgeType: 'list_scripts' },
      { tool: 'delete_script', bridgeType: 'delete_script', args: { scriptId: 'test-id' } },
      { tool: 'toggle_script', bridgeType: 'set_script_enabled', args: { scriptId: 'test-id', enabled: true } },
      { tool: 'get_page_context', bridgeType: 'get_page_context', args: { tabId: 1 } },
      { tool: 'get_console_context', bridgeType: 'get_console_context', args: { tabId: 1, level: 'error' } },
      { tool: 'list_tabs', bridgeType: 'list_tabs' },
      { tool: 'reload_tab', bridgeType: 'reload_tab', args: { tabId: 1 } },
      { tool: 'toggle_ui', bridgeType: 'show_ui', args: { tabId: 1, panel: 'scripts' } },
    ];

    for (const { tool, bridgeType, args } of PASSTHROUGH_TOOLS) {
      it(`${tool} → bridge.dispatchTool('${bridgeType}')`, async () => {
        bridge.dispatchTool.mock.resetCalls();
        const toolEntry = server._tools.find(t => t.name === tool);
        assert.ok(toolEntry, `Tool '${tool}' not found`);

        await toolEntry!.handler(args || {});

        // Some tools also invoke checkUserScriptsGate(), which adds a
        // legitimate 'get_system_status' dispatch alongside the primary
        // one. Assert the primary bridgeType is among the dispatched
        // calls rather than asserting an exact count.
        const dispatchedTypes = (bridge.dispatchTool.mock.calls as any[]).map((c) => c.arguments[0]);
        assert.ok(
          dispatchedTypes.includes(bridgeType),
          `Expected dispatch to '${bridgeType}', got: [${dispatchedTypes.join(', ')}]`
        );
      });
    }

    // ── Tools with file I/O (need shaped bridge responses) ────────

    it('import_script → bridge.dispatchTool(\'import_script\') + writes file', async () => {
      (bridge as any).dispatchTool = mock.fn(async () => ({
        scriptId: 'test-id',
        source: '// ==UserScript==\n// @name Test\n// ==/UserScript==',
        metadata: { name: 'Test' },
      }));
      server = createMockServer();
      registerTools(server as any, bridge as any);

      const toolEntry = server._tools.find(t => t.name === 'import_script');
      assert.ok(toolEntry, 'import_script not found');

      const result = await toolEntry!.handler({ scriptId: 'test-id', filePath: '/tmp/test-import.user.js' });
      assert.ok(result.content, 'Should return MCP content');
      assert.equal((bridge as any).dispatchTool.mock.callCount(), 1);
      assert.equal((bridge as any).dispatchTool.mock.calls[0].arguments[0], 'import_script');
    });

    it('import_script with fork:true → dispatches fork_script BEFORE import_script; uses fork\'s id', async () => {
      // The fork option's contract: ALWAYS create a new script first
      // (symmetric across shared/owned, never a silent no-op), then
      // import the FORK. Verifies the two-dispatch pattern, argument
      // shapes, and that the response surfaces the fork outcome.
      let callIndex = 0;
      (bridge as any).dispatchTool = mock.fn(async (tool: string, args: Record<string, unknown>) => {
        callIndex++;
        if (callIndex === 1) {
          assert.equal(tool, 'fork_script', 'fork_script must dispatch FIRST');
          assert.equal(args.scriptId, 'original-id', 'fork_script receives the original scriptId');
          return {
            success: true,
            scriptId: 'forked-id-new',
            name: 'Test Script (Fork)',
            scriptType: 'agentscript',
            wasShared: true,
            wasPublished: false,
            forkedFrom: { shareId: 'share-abc', snapshotVersion: 2, forkedAt: 1700000000000 },
          };
        }
        if (callIndex === 2) {
          assert.equal(tool, 'import_script', 'import_script must dispatch SECOND');
          assert.equal(args.scriptId, 'forked-id-new', 'import_script receives the FORKED id (not the original)');
          return {
            scriptId: 'forked-id-new',
            source: '// ==AgentScript==\n// @name Test Script (Fork)\n// ==/AgentScript==',
            metadata: { name: 'Test Script (Fork)' },
          };
        }
        throw new Error('unexpected dispatch');
      });
      server = createMockServer();
      registerTools(server as any, bridge as any);

      const toolEntry = server._tools.find(t => t.name === 'import_script');
      assert.ok(toolEntry, 'import_script not found');

      const result = await toolEntry!.handler({
        scriptId: 'original-id',
        filePath: '/tmp/test-import.user.js',
        fork: true,
      });

      // Two dispatches: fork_script then import_script.
      assert.equal((bridge as any).dispatchTool.mock.callCount(), 2);

      // Response payload surfaces the fork outcome so the agent can
      // tell what happened without guessing.
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.success, true);
      assert.equal(payload.forked, true);
      assert.equal(payload.scriptId, 'forked-id-new');
      assert.equal(payload.originalScriptId, 'original-id');
      assert.equal(payload.forkVerb, 'Fork');
      assert.deepEqual(payload.forkedFrom, { shareId: 'share-abc', snapshotVersion: 2, forkedAt: 1700000000000 });
      assert.ok(payload.note && payload.note.includes('DISABLED'), 'Response notes D10 disabled-by-default');
    });

    it('import_script with fork:true on owned script → forkVerb=\'Duplicate\' (no forkedFrom lineage)', async () => {
      // Symmetric across source types: fork=true on an owned script
      // produces a Duplicate (no upstream lineage). Critical so agents
      // can use the same call for "remix my own script" without a
      // separate tool.
      let callIndex = 0;
      (bridge as any).dispatchTool = mock.fn(async (tool: string, _args: Record<string, unknown>) => {
        callIndex++;
        if (callIndex === 1) {
          assert.equal(tool, 'fork_script');
          return {
            success: true,
            scriptId: 'dup-id',
            name: 'My Script (Copy)',
            scriptType: 'userscript',
            wasShared: false,
            wasPublished: false,
            forkedFrom: undefined,
          };
        }
        return {
          scriptId: 'dup-id',
          source: '// ==UserScript==\n// ==/UserScript==',
          metadata: {},
        };
      });
      server = createMockServer();
      registerTools(server as any, bridge as any);

      const toolEntry = server._tools.find(t => t.name === 'import_script');
      const result = await toolEntry!.handler({
        scriptId: 'my-owned-id',
        filePath: '/tmp/test-import.user.js',
        fork: true,
      });
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.forkVerb, 'Duplicate', 'Owned source → Duplicate verb');
      assert.equal(payload.forkedFrom, null, 'No upstream lineage for duplicate of owned script');
    });

    it('import_script without fork → single dispatch (back-compat)', async () => {
      // Regression guard: default behavior must not change. Existing
      // agents that don't pass `fork` get the original single-dispatch
      // flow + the read-only refusal for shared scripts (asserted in
      // separate extension-side handler tests).
      (bridge as any).dispatchTool = mock.fn(async () => ({
        scriptId: 'test-id',
        source: '// ==UserScript==\n// ==/UserScript==',
        metadata: {},
      }));
      server = createMockServer();
      registerTools(server as any, bridge as any);
      const toolEntry = server._tools.find(t => t.name === 'import_script');
      await toolEntry!.handler({ scriptId: 'test-id', filePath: '/tmp/test-import.user.js' });
      assert.equal((bridge as any).dispatchTool.mock.callCount(), 1, 'No fork dispatch when fork omitted');
    });

    it('export_script → bridge.dispatchTool(\'export_script\') with file content', async () => {
      (bridge as any).dispatchTool = mock.fn(async () => ({ success: true, scriptId: 'new-id' }));
      server = createMockServer();
      registerTools(server as any, bridge as any);

      // Write a test file to read
      const { writeFileSync } = await import('node:fs');
      writeFileSync('/tmp/test-export.user.js', '// test code', 'utf-8');

      const toolEntry = server._tools.find(t => t.name === 'export_script');
      assert.ok(toolEntry, 'export_script not found');

      const result = await toolEntry!.handler({ filePath: '/tmp/test-export.user.js' });
      assert.ok(result.content, 'Should return MCP content');
      // export_script also invokes checkUserScriptsGate() which dispatches
      // 'get_system_status'. Assert 'export_script' is among the calls
      // rather than asserting an exact count.
      const dispatchedTypes = ((bridge as any).dispatchTool.mock.calls as any[]).map((c) => c.arguments[0]);
      assert.ok(
        dispatchedTypes.includes('export_script'),
        `Expected dispatch to 'export_script', got: [${dispatchedTypes.join(', ')}]`
      );
    });

    it('take_screenshot → bridge.dispatchTool(\'take_screenshot\') + writes PNG', async () => {
      (bridge as any).dispatchTool = mock.fn(async () => ({
        dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        width: 800,
        height: 600,
      }));
      server = createMockServer();
      registerTools(server as any, bridge as any);

      const toolEntry = server._tools.find(t => t.name === 'take_screenshot');
      assert.ok(toolEntry, 'take_screenshot not found');

      const result = await toolEntry!.handler({ tabId: 1, filePath: '/tmp/test-screenshot.png' });
      assert.ok(result.content, 'Should return MCP content');
      assert.equal((bridge as any).dispatchTool.mock.callCount(), 1);
      assert.equal((bridge as any).dispatchTool.mock.calls[0].arguments[0], 'take_screenshot');
    });

    it('sync_scripts → bridge.dispatchTool(\'list_scripts_with_code\') + writes files', async () => {
      (bridge as any).dispatchTool = mock.fn(async () => ([
        { id: 's1', name: 'Script One', code: '// code1', enabled: true },
      ]));
      server = createMockServer();
      registerTools(server as any, bridge as any);

      const toolEntry = server._tools.find(t => t.name === 'sync_scripts');
      assert.ok(toolEntry, 'sync_scripts not found');

      const result = await toolEntry!.handler({ directory: '/tmp/test-sync-scripts/' });
      assert.ok(result.content, 'Should return MCP content');
      assert.equal((bridge as any).dispatchTool.mock.callCount(), 1);
      // sync_scripts uses a different bridge type than its tool name
      assert.equal((bridge as any).dispatchTool.mock.calls[0].arguments[0], 'list_scripts_with_code');
    });
  });

  // ─── Response Format ────────────────────────────────────────────

  it('tool handlers return MCP content blocks', async () => {
    (bridge as any).dispatchTool = mock.fn(async () => ({ scripts: [{ id: '1', name: 'Test' }] }));
    // Re-register with the updated bridge
    server = createMockServer();
    registerTools(server as any, bridge as any);

    const toolEntry = server._tools.find(t => t.name === 'list_scripts');
    assert.ok(toolEntry);

    const result = await toolEntry!.handler({});
    assert.ok(result.content, 'Result should have content property');
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, 'text');
    assert.equal(typeof result.content[0].text, 'string');

    const parsed = JSON.parse(result.content[0].text);
    assert.deepEqual(parsed, { scripts: [{ id: '1', name: 'Test' }] });
  });
});
