import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

/**
 * Resolve a writable workspace directory for context files.
 * - Cursor/Windsurf: cwd is the project root (ideal)
 * - Claude Desktop: cwd is homedir (fine)
 * - Antigravity: cwd is '/' → falls back to homedir
 */
function getWorkspaceDir(): string {
  // Escape hatch for edge cases
  const envWorkspace = process.env.CUSTOMAISE_WORKSPACE;
  if (envWorkspace && envWorkspace !== '/' && envWorkspace !== '') {
    return envWorkspace;
  }
  const cwd = process.cwd();
  if (cwd === '/' || cwd === '') {
    return homedir();
  }
  return cwd;
}

import type { Bridge } from './bridge.js';
import { FileWatcher } from './file-watcher.js';

/**
 * Register all MCP tools with the server.
 *
 * **Cap-counting contract (ARD §4.4):** every tool handler in this
 * function MUST dispatch via `bridge.dispatchTool(toolName, args)`,
 * NOT `bridge.request(...)`. The former goes through cap enforcement
 * + bilateral counter handshake; the latter is the legacy v1 envelope
 * and bypasses cap. If you add a new tool, copy the pattern from any
 * existing `server.tool(...)` handler. If you're tempted to use
 * `bridge.request` for a "lightweight" call, the answer is no — read
 * the JSDoc on `Bridge.request` for the reasoning.
 */
export function registerTools(server: McpServer, bridge: Bridge, fileWatcher?: FileWatcher): void {

  // ─── Master-gate detection (Round-33 follow-up) ─────────────────────
  // The "Allow user scripts" toggle on chrome://extensions resets on every
  // Chrome restart (Chromium design — security gate for chrome.userScripts
  // API access). When off, every UserScript and AgentScript is snoozed
  // globally, zero tools register on any tab, and the agent investigating
  // "why no tools" typically spends N tool calls poking at the page before
  // it discovers the gate. This helper queries the SW's SystemStatusService
  // (via the new `get_system_status` MCP dispatch) and, when the gate is
  // off, returns a user-facing instruction string the calling tool prepends
  // to its response. Fail-open: any error → no warning, caller falls back
  // to the regular response (don't spam false alarms on transient errors).
  const GATE_WARNING_HEADER = (
    `╔════════════════════════════════════════════════════════════════════╗\n` +
    `║ ⚠️  ACTION REQUIRED — Customaise scripts are snoozing.             ║\n` +
    `╚════════════════════════════════════════════════════════════════════╝\n` +
    `\n` +
    `The "Allow user scripts" master toggle on chrome://extensions is OFF.\n` +
    `This toggle resets on every Chrome restart and silently disables every\n` +
    `UserScript and AgentScript globally — including the test rig you just\n` +
    `installed. Zero tools will register on any tab until it's re-enabled.\n` +
    `\n` +
    `TELL THE USER: open chrome://extensions, enable "Developer mode" (top-\n` +
    `right toggle), find the Customaise card, and toggle "Allow user scripts"\n` +
    `ON. Then reload the target tab. The scripts will wake up automatically.\n` +
    `\n` +
    `(The structured response below is included for reference; until the\n` +
    `toggle is on it will report 0 active tools regardless of script state.)\n` +
    `\n` +
    `────────────────────────────────────────────────────────────────────\n\n`
  );
  async function checkUserScriptsGate(): Promise<{ disabled: boolean; warning: string }> {
    try {
      const status = await bridge.dispatchTool('get_system_status', {}) as {
        userScriptsDisabled?: boolean;
        available?: boolean;
      };
      if (status && status.available && status.userScriptsDisabled) {
        return { disabled: true, warning: GATE_WARNING_HEADER };
      }
    } catch {
      // Fail-open — see helper comment.
    }
    return { disabled: false, warning: '' };
  }

  // ─── Script Lifecycle ───────────────────────────────────────────────

  server.tool(
    'list_scripts',
    'List all scripts (UserScripts & AgentScripts) installed in Customaise with their IDs, names, enabled status, match patterns, and whether they are shared (subscribed). Scripts marked isShared are read-only subscriptions — they cannot be imported, exported, or deleted directly. To edit a shared script, call import_script with fork:true (creates an independent editable copy). To uninstall a shared script, the user must unsubscribe from the extension UI.',
    {},
    { title: 'List scripts', readOnlyHint: true, openWorldHint: false },
    async () => {
      const [result, gate] = await Promise.all([
        bridge.dispatchTool('list_scripts', {}),
        checkUserScriptsGate()
      ]);
      return {
        content: [{
          type: 'text' as const,
          text: gate.warning + JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  server.tool(
    'import_script',
    `Import a Customaise script (UserScript or AgentScript) to a local file for editing. The file contains the full source with metadata block. After editing with your IDE tools, use export_script to push changes back.

Optional 'fork' flag (default false): when set to true, the script is FORKED into a new independent local copy BEFORE import, and the FORK is what gets written to the file. ALWAYS creates a new script — symmetric across source types, never a silent no-op:
  - Subscribed/shared sources: "Fork" verb. Clears the subscription link (no more publisher updates), captures forkedFrom lineage so a later publish can render "Forked from <original>" on the marketplace.
  - Owned sources: "Duplicate" verb. Clears publishedShareId so the dup isn't tied to the original's published listing. Use when you want a remix while keeping the original intact.
Forked/duplicated scripts land DISABLED in the user's library (D10 trust ceremony). The returned scriptId is the NEW script (not the original); the agent can immediately export back to it.

Without 'fork', subscribed scripts cannot be imported — they're read-only and the call refuses with a clear error pointing at fork:true. Owned scripts import normally (edit-in-place workflow).

IMPORTANT: Save files inside your current workspace or project directory (e.g., ./customaise-scripts/), never in /tmp.`,
    {
      scriptId: z.string().describe('The ID of the script to import (get from list_scripts). When fork=true, this is the source script to fork from; the returned scriptId is the new fork.'),
      filePath: z.string().describe('Local file path inside your workspace to write the script to (e.g., ./customaise-scripts/my-script.agent.js). Do NOT use /tmp.'),
      fork: z.boolean().optional().describe('When true, fork the script into a new editable copy and import THAT copy. Always creates a new script (Fork for shared sources, Duplicate for owned). Required for subscribed/shared scripts. Default false.')
    },
    // readOnlyHint:false because fork=true creates a new script (state-mutating);
    // the hint applies to the tool surface, not per-invocation.
    { title: 'Import script', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async ({ scriptId, filePath, fork }) => {
      // Fork branch — dispatch fork_script first; the new scriptId
      // is what we hand to the import dispatch below. SW handler
      // mirrors the extension UI's Fork helper (identity-clearing,
      // unique-name, D9 lineage when shared, D10 disabled-by-default).
      let effectiveScriptId = scriptId;
      interface ForkOutcome {
        success: boolean;
        scriptId: string;
        name: string;
        scriptType?: string;
        wasShared?: boolean;
        wasPublished?: boolean;
        forkedFrom?: unknown;
      }
      let forkOutcome: ForkOutcome | null = null;
      if (fork === true) {
        forkOutcome = await bridge.dispatchTool('fork_script', { scriptId }) as ForkOutcome;
        effectiveScriptId = forkOutcome.scriptId;
      }

      const result = await bridge.dispatchTool('import_script', { scriptId: effectiveScriptId }) as {
        scriptId: string;
        source: string;
        metadata: Record<string, unknown>;
      };

      // File-write atomicity. If we just forked and the import
      // succeeded but the local file-write fails (disk full,
      // permission denied, invalid path), the fork is durable in
      // the user's library but the agent gets an exception with no
      // path forward. Surface the fork's scriptId in the error so
      // the agent knows it CAN re-call import_script with that
      // scriptId (and no `fork` flag) to retry just the file-write
      // step — no second fork created.
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, result.source, 'utf-8');
      } catch (fsErr) {
        const msg = (fsErr as Error)?.message || String(fsErr);
        if (forkOutcome) {
          throw new Error(
            `Fork created (scriptId: ${forkOutcome.scriptId}, name: "${forkOutcome.name}") ` +
            `but file-write to ${filePath} failed: ${msg}. ` +
            `To recover: call import_script again with scriptId: "${forkOutcome.scriptId}" ` +
            `(no fork option) to write the file. The fork itself is durable.`,
          );
        }
        throw fsErr;
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            filePath,
            scriptId: result.scriptId,
            metadata: result.metadata,
            bytesWritten: Buffer.byteLength(result.source, 'utf-8'),
            ...(forkOutcome ? {
              forked: true,
              originalScriptId: scriptId,
              forkVerb: forkOutcome.wasShared ? 'Fork' : 'Duplicate',
              forkedFrom: forkOutcome.forkedFrom ?? null,
              newScriptName: forkOutcome.name,
              note: 'Forked/duplicated script lands DISABLED. User reviews + enables explicitly per the D10 trust ceremony.',
            } : {}),
          }, null, 2)
        }]
      };
    }
  );

  server.tool(
    'export_script',
    `Export a script from a local file into Customaise. The file will be validated through Customaise's sanitization pipeline (syntax checking, AST validation, security analysis). If valid, the script is installed and ready to execute on matching pages. If invalid, detailed diagnostics explain exactly what to fix. Pass scriptId to update an existing script instead of creating a new one. NOTE: You cannot overwrite a shared/subscribed script — they are read-only. If you need to edit a shared script, first call import_script with fork:true (creates an editable independent copy), then export to that copy's scriptId.

    Reminder for UserScripts: Must use an IIFE with named functions for symbol-level editing, \`// @namespace https://customaise.com\`, and standard directives (@name, @match, @grant).
    Reminder for AgentScripts: MUST use \`// ==AgentScript==\` block, MUST explicitly declare tools via \`// @webmcp <toolName> <permission>\` (e.g. \`// @webmcp my_tool prompt\`). Permissions: allow (autonomous), prompt (interactive), deny (blocked). Must NOT use IIFEs. CAN use GM_* APIs for persistence, networking, and observability alongside \`navigator.modelContext.registerTool()\`.`,
    {
      filePath: z.string().describe('Local file path containing the userscript source code'),
      scriptId: z.string().optional().describe('ID of an existing script to update. Omit to create a new script.')
    },
    { title: 'Export script', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async ({ filePath, scriptId }) => {
      const code = readFileSync(filePath, 'utf-8');
      const [result, gate] = await Promise.all([
        bridge.dispatchTool('export_script', { code, scriptId }),
        checkUserScriptsGate()
      ]);
      return {
        content: [{
          type: 'text' as const,
          text: gate.warning + JSON.stringify(result, null, 2)
        }]
      };
    }
  );



  server.tool(
    'delete_script',
    'Permanently delete a script (UserScript or AgentScript) from Customaise. This action cannot be undone. NOTE: Shared/subscribed scripts cannot be deleted via MCP — the user must unsubscribe from the extension UI. Forks created via import_script(fork:true) are owned scripts and CAN be deleted via MCP.',
    {
      scriptId: z.string().describe('The ID of the script to delete')
    },
    { title: 'Delete script', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async ({ scriptId }) => {
      const result = await bridge.dispatchTool('delete_script', { scriptId });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  server.tool(
    'toggle_script',
    'Enable or disable a userscript. Disabled scripts are not injected into matching pages. Use this to temporarily turn off a script without deleting it.',
    {
      scriptId: z.string().describe('The ID of the script to enable/disable'),
      enabled: z.boolean().describe('true to enable, false to disable')
    },
    { title: 'Toggle script', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ scriptId, enabled }) => {
      const result = await bridge.dispatchTool('set_script_enabled', { scriptId, enabled });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  // ─── Browser Context ────────────────────────────────────────────────
  // These tools write full data to workspace files and return lightweight
  // summaries. This prevents huge DOM snapshots or console logs from
  // bloating the AI agent's context window. Files are overwritten on
  // each call so the agent always has the freshest snapshot.

  server.tool(
    'get_page_context',
    'Get a DOM snapshot of the current page including URL, title, page structure, and visible elements. Use this to understand the page layout before writing userscripts that manipulate it. The full DOM snapshot is saved to .customaise/page-context.json in your workspace — use view_file or grep_search to read only what you need.',
    {
      tabId: z.number().optional().describe('Tab ID to inspect. Defaults to the active tab.')
    },
    { title: 'Get page context', readOnlyHint: true, openWorldHint: true },
    async ({ tabId }) => {
      const result = await bridge.dispatchTool('get_page_context', { tabId }) as Record<string, any>;

      // Strip fields that are only for the extension's internal chat UI
      delete result.displayContent;
      delete result.tokenEstimate;

      // Write full context to workspace file (overwrite each time)
      const contextDir = join(getWorkspaceDir(), '.customaise');
      mkdirSync(contextDir, { recursive: true });
      const filePath = join(contextDir, 'page-context.json');
      const fullJson = JSON.stringify(result, null, 2);
      writeFileSync(filePath, fullJson, 'utf-8');

      // Build lightweight summary for the agent's context window.
      // The extension's page-context-runtime returns componentsSummary
      // (buttons/forms/tables/links/inputs/headers/images/modals with
      // counts + sample selectors) and overview.counts. The legacy
      // `result.dom.elementCount` field does not exist; reading from
      // the real fields is the fix for the "elementCount: 0" bug.
      const overview = result.overview || {};
      const summary = result.componentsSummary || {};
      const counts = overview.counts || {};
      const fileSizeKB = (Buffer.byteLength(fullJson, 'utf-8') / 1024).toFixed(1);

      const componentLine = (name: string, entry: any): string | null =>
        entry?.count
          ? `${name}: ${entry.count}${
              entry.samples?.length
                ? ` (e.g. ${entry.samples.slice(0, 3).join(', ')})`
                : ''
            }`
          : null;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            url: overview.url ?? result.url ?? '',
            title: overview.title ?? result.title ?? '',
            detailTier: overview.detailTier,
            filePath,
            fileSizeKB: `${fileSizeKB} KB`,
            components: [
              componentLine('buttons', summary.buttons),
              componentLine('forms', summary.forms),
              componentLine('tables', summary.tables),
              componentLine('inputs', summary.inputs),
              componentLine('headers', summary.headers),
              componentLine('images', summary.images),
              componentLine('modals', summary.modals),
              summary.links?.count ? `links: ${summary.links.count}` : null
            ].filter(Boolean),
            domCounts: counts,
            hint: 'Full DOM snapshot saved to the file above. Use view_file or grep_search to inspect specific elements, selectors, or text content without loading the entire snapshot.'
          }, null, 2)
        }]
      };
    }
  );

  server.tool(
    'get_console_context',
    'Get console logs from the browser, including errors, warnings, and userscript GM_log output. Use after reload_tab to check for script runtime errors. The full log data is saved to .customaise/console-context.json in your workspace — use view_file or grep_search to read only what you need.',
    {
      tabId: z.number().optional().describe('Tab ID to get logs from. Defaults to the active tab.'),
      level: z.enum(['all', 'error', 'warn', 'info', 'debug']).optional().describe('Filter by log level. Default: all')
    },
    { title: 'Get console context', readOnlyHint: true, openWorldHint: true },
    async ({ tabId, level }) => {
      const result = await bridge.dispatchTool('get_console_context', { tabId }) as {
        errors?: Array<Record<string, unknown>>;
        warnings?: Array<Record<string, unknown>>;
        userscriptLogs?: Array<Record<string, unknown>>;
        summary?: Record<string, unknown>;
        [key: string]: unknown;
      };

      // Strip fields that are only for the extension's internal chat UI
      delete result.displayContent;
      delete result.tokenEstimate;

      // Apply level filter client-side before saving
      let dataToSave: Record<string, unknown> = result;
      if (level && level !== 'all') {
        dataToSave = { ...result };
        if (level === 'error') {
          delete dataToSave.warnings;
          delete dataToSave.userscriptLogs;
        } else if (level === 'warn') {
          delete dataToSave.errors;
          delete dataToSave.userscriptLogs;
        } else if (level === 'info' || level === 'debug') {
          delete dataToSave.errors;
          delete dataToSave.warnings;
        }
      }

      // Write full logs to workspace file (overwrite each time)
      const contextDir = join(getWorkspaceDir(), '.customaise');
      mkdirSync(contextDir, { recursive: true });
      const filePath = join(contextDir, 'console-context.json');
      const fullJson = JSON.stringify(dataToSave, null, 2);
      writeFileSync(filePath, fullJson, 'utf-8');

      // Build lightweight summary for the agent's context window
      const errorCount = Array.isArray(result.errors) ? result.errors.length : 0;
      const warnCount = Array.isArray(result.warnings) ? result.warnings.length : 0;
      const gmLogCount = Array.isArray(result.userscriptLogs) ? result.userscriptLogs.length : 0;
      const fileSizeKB = (Buffer.byteLength(fullJson, 'utf-8') / 1024).toFixed(1);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            filePath,
            fileSizeKB: `${fileSizeKB} KB`,
            counts: {
              errors: errorCount,
              warnings: warnCount,
              userscriptLogs: gmLogCount,
              levelFilter: level || 'all'
            },
            hint: 'Full console logs saved to the file above. Use view_file or grep_search to inspect specific errors, warnings, or GM_log output without loading all logs.'
          }, null, 2)
        }]
      };
    }
  );

  server.tool(
    'list_tabs',
    'List all open browser tabs with their IDs, URLs, titles, and active status. Use to find a specific tab ID for other tools like reload_tab or take_screenshot.',
    {},
    { title: 'List tabs', readOnlyHint: true, openWorldHint: true },
    async () => {
      const result = await bridge.dispatchTool('list_tabs', {});
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  server.tool(
    'open_tab',
    'Open a new browser tab with the specified URL. Defaults to opening in the background so the user is not snatched away from the tab they are currently viewing. Returns the new tab ID.',
    {
      url: z.string().describe('The URL to open in the new tab'),
      active: z.boolean().optional().describe('Whether the new tab should become the active tab. Defaults to false (opens in background). Set to true only when the agent genuinely needs the new tab brought to focus.')
    },
    { title: 'Open tab', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async ({ url, active }) => {
      const result = await bridge.dispatchTool('open_tab', { url, active });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  server.tool(
    'close_tab',
    'Close a specific browser tab. Defaults to the active tab if no tabId is provided.',
    {
      tabId: z.number().optional().describe('The ID of the tab to close')
    },
    { title: 'Close tab', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async ({ tabId }) => {
      const result = await bridge.dispatchTool('close_tab', { tabId });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  server.tool(
    'focus_tab',
    'Bring a specific browser tab to the front and make it active.',
    {
      tabId: z.number().describe('The ID of the tab to focus')
    },
    { title: 'Focus tab', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ tabId }) => {
      const result = await bridge.dispatchTool('focus_tab', { tabId });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  server.tool(
    'reload_tab',
    'Reload a browser tab to re-inject updated userscripts. Use after export_script to see the effect of your changes. Waits for the page to fully load before returning. If the tab has AgentScript (WebMCP) tools registered, automatically waits for them to re-register before returning.',
    {
      tabId: z.number().optional().describe('Tab ID to reload. Defaults to the active tab.')
    },
    { title: 'Reload tab', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ tabId }) => {
      // The bridge handler auto-detects WebMCP tabs and waits event-driven.
      // No client-side polling needed — plain userscript tabs return immediately,
      // AgentScript tabs auto-wait for tool re-registration.
      const [result, gate] = await Promise.all([
        bridge.dispatchTool('reload_tab', { tabId }),
        checkUserScriptsGate()
      ]);

      return {
        content: [{
          type: 'text' as const,
          text: gate.warning + JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  server.tool(
    'take_screenshot',
    'Capture a screenshot of a browser tab without stealing focus from the user. Defaults to the visible viewport. Set fullPage: true to capture the entire scrollable page as one tall image. The screenshot is saved as a PNG file. For background tabs and full-page captures, Chrome briefly displays its standard yellow developer-tools notice at the top of the target tab during capture; it clears automatically when capture completes (typically under one second).',
    {
      tabId: z.number().optional().describe('Tab ID to screenshot. Defaults to the active tab.'),
      filePath: z.string().optional().describe('Local file path to save the screenshot. Auto-generates a temp path if omitted.'),
      fullPage: z.boolean().optional().describe('If true, capture the entire scrollable page (single tall PNG). If false or omitted, capture the visible viewport only.')
    },
    { title: 'Take screenshot', readOnlyHint: true, openWorldHint: true },
    async ({ tabId, filePath, fullPage }) => {
      const result = await bridge.dispatchTool('take_screenshot', { tabId, fullPage }) as {
        dataUrl: string;
        width?: number;
        height?: number;
        captureMode?: string;
        truncated?: boolean;
      };

      // Write base64 PNG data to file
      const savePath = filePath || join(tmpdir(), `customaise-screenshot-${Date.now()}.png`);
      const base64Data = result.dataUrl.replace(/^data:image\/png;base64,/, '');
      mkdirSync(dirname(savePath), { recursive: true });
      writeFileSync(savePath, Buffer.from(base64Data, 'base64'));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            filePath: savePath,
            width: result.width,
            height: result.height,
            captureMode: result.captureMode,
            truncated: result.truncated
          }, null, 2)
        }]
      };
    }
  );

  server.tool(
    'toggle_ui',
    'Show or hide the Customaise UI overlay on the active tab. Use this to make the Customaise interface visible or dismiss it — AI agents cannot click the extension icon directly. Optionally specify which panel to open.',
    {
      tabId: z.number().optional().describe('Tab ID to toggle UI on. Defaults to the active tab.'),
      panel: z.string().optional().describe('Panel to open: "scripts", "chat", "settings"')
    },
    { title: 'Toggle UI', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ tabId, panel }) => {
      const result = await bridge.dispatchTool('show_ui', { tabId, panel });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );


  server.tool(
    'list_webmcp_tools',
    'List all WebMCP tools currently registered by AgentScripts for a specific browser tab. Use this to verify that an exported AgentScript is correctly registering its tools on the target page.',
    {
      tabId: z.number().optional().describe('Tab ID to query. Defaults to the active tab.')
    },
    { title: 'List WebMCP tools', readOnlyHint: true, openWorldHint: true },
    async ({ tabId }) => {
      const [result, gate] = await Promise.all([
        bridge.dispatchTool('list_webmcp_tools', { tabId }),
        checkUserScriptsGate()
      ]);
      return {
        content: [{
          type: 'text' as const,
          text: gate.warning + JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  server.tool(
    'call_webmcp_tool',
    'Execute a registered WebMCP tool directly on the target browser tab. If the tool is interactive (trust level), the user will be natively prompted by CustomAIse to approve the execution before it returns.',
    {
      tabId: z.number().optional().describe('Tab ID to execute on. Defaults to active tab.'),
      toolName: z.string().describe('The EXACT name of the WebMCP tool to invoke'),
      toolArgs: z.record(z.any()).optional().describe('JSON object of arguments for the tool')
    },
    { title: 'Call WebMCP tool', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async ({ tabId, toolName, toolArgs }) => {
      // Gate check FIRST. call_webmcp_tool against a snoozing extension
      // will error with "tool not registered" — surfacing the gate here
      // tells the agent why the error is happening BEFORE the dispatch
      // returns its no-such-tool failure.
      const gate = await checkUserScriptsGate();
      const result = await bridge.dispatchTool('call_webmcp_tool', { tabId, toolName, toolArgs });
      return {
        content: [{
          type: 'text' as const,
          text: gate.warning + JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  // ─── File Sync ──────────────────────────────────────────────────────

  server.tool(
    'sync_scripts',
    'Bulk export all your own scripts from Customaise to a local directory as individual .user.js or .agent.js files. Creates a .customaise-manifest.json mapping filenames to script IDs. Shared/subscribed scripts are excluded (they are read-only). Use this to set up a local workspace for editing scripts with your IDE.',
    {
      directory: z.string().describe('Local directory to export scripts to (e.g., ./customaise-scripts/)')
    },
    { title: 'Sync scripts to workspace', readOnlyHint: true, openWorldHint: false },
    async ({ directory }) => {
      // Get all scripts with code
      const scripts = await bridge.dispatchTool('list_scripts_with_code', {}) as Array<{
        id: string;
        name: string;
        code: string;
        enabled: boolean;
      }>;

      mkdirSync(directory, { recursive: true });

      const manifest: Record<string, string> = {};
      let filesWritten = 0;

      const usedNames = new Set<string>();

      for (const script of scripts) {
        // Determine file extension based on content
        const isAgentScript = typeof script.code === 'string' && script.code.includes('// ==AgentScript==');
        const fileExt = isAgentScript ? '.agent.js' : '.user.js';

        // Generate a safe filename from the script name
        let safeName = (script.name || 'untitled')
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '');

        // Handle filename collisions — append short ID suffix if name already used
        let fileName = `${safeName}${fileExt}`;
        if (usedNames.has(fileName)) {
          const idSuffix = script.id.slice(-6);
          fileName = `${safeName}-${idSuffix}${fileExt}`;
        }
        usedNames.add(fileName);
        const filePath = `${directory}/${fileName}`;

        // Mute each file to prevent the watcher from re-exporting
        if (fileWatcher) fileWatcher.muteFile(fileName);
        writeFileSync(filePath, script.code || '', 'utf-8');
        manifest[fileName] = script.id;
        filesWritten++;
      }

      // Write manifest for ID mapping
      const manifestPath = `${directory}/.customaise-manifest.json`;
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

      // Start file watcher on the synced directory
      if (fileWatcher) {
        fileWatcher.start(directory);
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            directory,
            filesWritten,
            manifestPath,
            scripts: Object.entries(manifest).map(([file, id]) => ({ file, id }))
          }, null, 2)
        }]
      };
    }
  );


  // ─── DOM Selection Bridge ──────────────────────────────────────────

  server.tool(
    'get_selected_elements',
    'Get DOM elements that the user has visually selected in the browser for a specific script. Returns each selection\'s bulletproof selectors, element context, and user comments. Use CM_findElement with the domId for precise targeting in scripts. When MCP is connected, .dom.md context files and screenshots are automatically pushed to the workspace (.customaise/dom-context/<script-name>/) in real-time as the user selects elements. Use this tool to retrieve selections if the auto-pushed files are missing or to get the raw JSON data.',
    {
      scriptId: z.string().optional().describe('Script ID to get selections for. Omit to get all scripts\' selections.'),
      writeFiles: z.boolean().optional().describe('If true, writes .dom.md context files to the workspace directory. Default: false.'),
      directory: z.string().optional().describe('Workspace directory for .dom.md files. Required if writeFiles is true.')
    },
    { title: 'Get selected elements', readOnlyHint: true, openWorldHint: false },
    async ({ scriptId, writeFiles, directory }) => {
      const result = await bridge.dispatchTool('get_selected_elements', { scriptId }) as any;

      // Optionally write .dom.md files to workspace
      if (writeFiles && directory) {
        const selections = scriptId
          ? [{ scriptId: result.scriptId, scriptName: result.scriptName, selections: result.selections }]
          : (result.scripts || []);

        for (const script of selections) {
          if (!script.selections || script.selections.length === 0) continue;

          const safeName = (script.scriptName || 'unknown')
            .toLowerCase()
            .replace(/[^a-z0-9_-]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '') || 'script';
          // Normalize: strip trailing .customaise/dom-context if caller already included it
          let baseDir = directory;
          if (baseDir.replace(/\/+$/, '').endsWith('.customaise/dom-context')) {
            baseDir = baseDir.replace(/\/?\.customaise\/dom-context\/?$/, '');
          }
          const scriptDir = join(baseDir, '.customaise', 'dom-context', safeName);
          mkdirSync(scriptDir, { recursive: true });

          const manifest: Record<string, any> = {};
          const usedNames = new Set<string>();

          for (const sel of script.selections) {
            // Generate safe filename from display name, with collision prevention
            let safeElName = (sel.displayName || sel.tagName || 'element')
              .toLowerCase()
              .replace(/[^a-z0-9_-]/g, '-')
              .replace(/-+/g, '-')
              .replace(/^-|-$/g, '') || 'element';

            // Deduplicate filenames: append counter if collision
            if (usedNames.has(safeElName)) {
              let counter = 2;
              while (usedNames.has(`${safeElName}-${counter}`)) counter++;
              safeElName = `${safeElName}-${counter}`;
            }
            usedNames.add(safeElName);

            // Helper to safely quote YAML values
            const yq = (val: string) => `"${(val || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;

            // Write .dom.md with YAML frontmatter (all values defensively quoted)
            // Helper: render a YAML list of selectors, skipping empty tiers
            const bp = sel.bulletproofSelectors || {} as any;
            const tierLines: string[] = [];
            tierLines.push(`  tier1_stableId: ${bp.tier1_stableId ? yq(bp.tier1_stableId) : 'null'}`);
            const tierArrays: [string, string[]][] = [
              ['tier2_dataAttributes', bp.tier2_dataAttributes || []],
              ['tier3_ariaLabels', bp.tier3_ariaLabels || []],
              ['tier4_semanticClasses', bp.tier4_semanticClasses || []],
              ['tier5_structuralPositioning', bp.tier5_structuralPositioning || []],
              ['tier6_structuralXPath', bp.tier6_structuralXPath || []],
              ['tier7_structural', bp.tier7_structural || []],
            ];
            for (const [name, arr] of tierArrays) {
              if (arr.length > 0) {
                tierLines.push(`  ${name}:`);
                for (const item of arr) tierLines.push(`    - ${yq(item)}`);
              }
            }
            if (bp.textContentHash) tierLines.push(`  textContentHash: ${yq(bp.textContentHash)}`);
            if (bp.structuralFingerprint) tierLines.push(`  structuralFingerprint: ${yq(bp.structuralFingerprint)}`);

            // Capture screenshot FIRST so we know whether to include the link in dom.md
            // When captureScreenshots is true, ALWAYS use capture_element_screenshot
            // which highlights the element, scrolls into view, and takes a fresh capture.
            // The pre-stored sel.screenshot is just a generic full-tab capture from
            // selection time — it doesn't show highlights or scroll to off-screen elements.
            // Use pre-stored screenshot if available (captured at selection time)
            let hasScreenshot = false;
            if (sel.screenshot) {
              try {
                const imgBuffer = Buffer.from(sel.screenshot, 'base64');
                writeFileSync(join(scriptDir, `${safeElName}.screenshot.png`), imgBuffer);
                hasScreenshot = true;
              } catch {
                // Non-fatal
              }
            }

            const domMd = [
              '---',
              `domId: ${yq(sel.domId)}`,
              `displayName: ${yq(sel.displayName || '')}`,
              `tagName: ${yq(sel.tagName)}`,
              `cssPath: ${yq(sel.cssPath || '')}`,
              `textPreview: ${yq((sel.textPreview || '').slice(0, 200))}`,
              `role: ${yq(sel.semantics?.role || 'unknown')}`,
              `purpose: ${yq(sel.semantics?.purpose || 'unknown')}`,
              `interactivity: ${sel.semantics?.interactivity || false}`,
              `pageUrl: ${yq(sel.pageUrl)}`,
              `pageTitle: ${yq(sel.pageTitle || '')}`,
              `selectedAt: ${sel.selectedAt}`,
              'bulletproofSelectors:',
              ...tierLines,
              '---',
              '',
              `# ${sel.displayName || sel.tagName}`,
              '',
              sel.userComment ? `> ${sel.userComment.replace(/\\n/g, '\n> ')}` : '> _No user comment provided._',
              '',
              hasScreenshot ? `![Element screenshot](./${safeElName}.screenshot.png)` : '',
              '',
              '## CM_findElement Usage',
              '```js',
              `const element = await CM_findElement('${sel.domId}');`,
              '```',
              ''
            ].filter(Boolean).join('\n');

            writeFileSync(join(scriptDir, `${safeElName}.dom.md`), domMd, 'utf-8');

            manifest[sel.domId] = {
              file: `${safeElName}.dom.md`,
              displayName: sel.displayName,
              tagName: sel.tagName
            };
          }

          // Write manifest
          writeFileSync(
            join(scriptDir, '_manifest.json'),
            JSON.stringify({ scriptId: script.scriptId, scriptName: script.scriptName, elements: manifest }, null, 2),
            'utf-8'
          );
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );


  // ─── Agent-Triggered DOM Selection ──────────────────────────────────


  // ─── Push Handler: Real-time DOM Selection File Writes ─────────────
  // When the user selects an element in the browser, the extension pushes
  // the selection data + screenshot immediately. We write the files to
  // the workspace directory (process.cwd()) so the IDE agent has them.
  bridge.onPush((type, data) => {
    if (type !== 'dom_selection_file') return;

    try {
      const { scriptId, scriptName, selection, screenshot } = data || {};
      if (!selection || !selection.domId) {
        process.stderr.write(`[customaise-mcp] Push ignored: missing selection data\n`);
        return;
      }

      const baseDir = getWorkspaceDir();
      const safeName = (scriptName || scriptId || 'unknown')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
      const scriptDir = join(baseDir, '.customaise', 'dom-context', safeName);
      mkdirSync(scriptDir, { recursive: true });

      const elName = (selection.displayName || selection.domId || 'element')
        .replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'element';
      const safeElName = `${elName}_${selection.domId?.slice(-8) || 'unknown'}`;

      // Write screenshot
      let hasScreenshot = false;
      if (screenshot) {
        try {
          const imgBuffer = Buffer.from(screenshot, 'base64');
          writeFileSync(join(scriptDir, `${safeElName}.screenshot.png`), imgBuffer);
          hasScreenshot = true;
        } catch { /* non-fatal */ }
      }

      // Write dom.md
      const yq = (s: string) => `"${(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\\n/g, '\\n')}"`;
      const bp = selection.bulletproofSelectors || {};
      const tierLines: string[] = [];
      if (bp.tier1_stableId) tierLines.push(`  tier1_stableId: ${yq(bp.tier1_stableId)}`);
      if (bp.tier2_dataAttributes?.length) tierLines.push(`  tier2_dataAttributes: [${bp.tier2_dataAttributes.map(yq).join(', ')}]`);
      if (bp.tier3_ariaLabels?.length) tierLines.push(`  tier3_ariaLabels: [${bp.tier3_ariaLabels.map(yq).join(', ')}]`);
      if (bp.tier4_semanticClasses?.length) tierLines.push(`  tier4_semanticClasses: [${bp.tier4_semanticClasses.map(yq).join(', ')}]`);
      if (bp.tier5_structuralPositioning?.length) tierLines.push(`  tier5_structuralPositioning: [${bp.tier5_structuralPositioning.map(yq).join(', ')}]`);
      if (bp.textContentHash) tierLines.push(`  textContentHash: ${yq(bp.textContentHash)}`);
      if (bp.structuralFingerprint) tierLines.push(`  structuralFingerprint: ${yq(bp.structuralFingerprint)}`);

      const domMd = [
        '---',
        `domId: ${yq(selection.domId)}`,
        `displayName: ${yq(selection.displayName || '')}`,
        `tagName: ${yq(selection.tagName)}`,
        `cssPath: ${yq(selection.cssPath || '')}`,
        `textPreview: ${yq((selection.textPreview || '').slice(0, 200))}`,
        `pageUrl: ${yq(selection.pageUrl || '')}`,
        `pageTitle: ${yq(selection.pageTitle || '')}`,
        hasScreenshot ? `screenshot: "${safeElName}.screenshot.png"` : null,
        'bulletproofSelectors:',
        ...tierLines,
        '---',
        '',
        selection.userComment ? `> **User note:** ${selection.userComment}` : null,
        '',
      ].filter(Boolean).join('\n');

      writeFileSync(join(scriptDir, `${safeElName}.dom.md`), domMd, 'utf-8');

      process.stderr.write(`[customaise-mcp] DOM selection file written: ${safeElName}.dom.md (screenshot: ${hasScreenshot})\n`);
    } catch (err: any) {
      process.stderr.write(`[customaise-mcp] Push handler error: ${err?.message}\n`);
    }
  });
}

/**
 * Register MCP Prompts and Resources.
 */
export function registerPromptsAndResources(server: McpServer, bridge: Bridge): void {

  // ─── Resources ──────────────────────────────────────────────────────

  server.resource(
    'scripts-list',
    'customaise://scripts',
    {
      description: 'Live list of all userscripts managed by Customaise, including their IDs, names, and enabled status.',
      mimeType: 'application/json'
    },
    async (uri) => {
      const result = await bridge.dispatchTool('list_scripts', {});
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  server.resource(
    'script-source',
    new ResourceTemplate('customaise://scripts/{scriptId}', { list: undefined }),
    {
      description: 'Full source code and metadata of a specific userscript. Use the script ID from the scripts list.',
      mimeType: 'application/json'
    },
    async (uri, variables) => {
      const scriptId = variables.scriptId as string;
      const result = await bridge.dispatchTool('import_script', { scriptId });
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  server.resource(
    'conventions',
    'customaise://conventions',
    {
      description: 'Directory pointer for Customaise conventions.',
      mimeType: 'text/markdown'
    },
    async (uri) => {
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'text/markdown',
          text: '> **Directory Redirect**\n> \n> Customaise supports two script paradigms with distinct architectures.\n> \n> - For traditional DOM manipulation, read `customaise://userscript-conventions`\n> - For WebMCP tool injection, read `customaise://agentscript-conventions`'
        }]
      };
    }
  );

  server.resource(
    'userscript-conventions',
    'customaise://userscript-conventions',
    {
      description: 'Complete conventions, workflow, and API guide for building Customaise UserScripts.',
      mimeType: 'text/markdown'
    },
    async (uri) => {
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'text/markdown',
          text: USERSCRIPT_CONVENTIONS
        }]
      };
    }
  );

  server.resource(
    'agentscript-conventions',
    'customaise://agentscript-conventions',
    {
      description: 'Complete conventions, workflow, and API guide for building Customaise AgentScripts.',
      mimeType: 'text/markdown'
    },
    async (uri) => {
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'text/markdown',
          text: AGENTSCRIPT_CONVENTIONS
        }]
      };
    }
  );
}


const USERSCRIPT_CONVENTIONS = `# Customaise UserScripts

## File Format & Structure
Every userscript is a single \`.user.js\` file with a metadata block at the top. 
**CRITICAL**: Customaise supports symbol-level editing (function-by-function). To enable this, your script MUST be wrapped in an IIFE containing **named functions**, rather than flat inline code.

\`\`\`javascript
// ==UserScript==
// @name        My Script
// @namespace   https://customaise.com
// @description What this script does
// @match       https://example.com/*
// @version     1.0
// @grant       GM_log
// @grant       CM_findElement
// @run-at      document-idle
// ==/UserScript==

(function() {
  'use strict';
  
  // Good: Named functions allow Customaise to edit them individually
  async function init() {
    GM_log('Script initialized');
    await hideAnnoyingBanner();
  }

  async function hideAnnoyingBanner() {
    // CM_findElement is our bulletproof DOM selector
    const banner = await CM_findElement('dom_banner_123');
    if (banner) banner.style.display = 'none';
  }

  init();
})();
\`\`\`

## Metadata Directives
| Directive | Required | Description |
|-----------|----------|-------------|
| \`@name\` | ✅ | Script name (must be unique) |
| \`@match\` | ✅ | URL pattern(s) where the script runs (\`*://*.example.com/*\`) |
| \`@description\` | Recommended | What the script does |
| \`@version\` | Recommended | Semantic version (defaults to 1.0) |
| \`@grant\` | Optional | GM_* or CM_* APIs to enable (use \`none\` for no special APIs) |
| \`@run-at\` | Optional | When to inject: \`document-start\`, \`document-end\`, \`document-idle\` (default) |
| \`@connect\` | Optional | Domains allowed for \`GM_xmlhttpRequest\` (e.g., \`api.github.com\`) |
| \`@domId\` | Auto | Auto-managed by Customaise for \`CM_findElement\`. **Do not edit manually.** |
| \`@require\` | Optional | External JS libraries to load before the script |
| \`@resource\` | Optional | Named external resources (CSS, JSON, images) accessible via \`GM_getResourceText/URL\` |
| \`@namespace\` | Recommended | Script namespace. Use \`https://customaise.com\`. |
| \`@author\` | Optional | Script author |

## CM_findElement (Bulletproof DOM Targeting)
Customaise provides a revolutionary multi-tier selector API that guarantees 100% element targeting reliability, surviving UI redesigns and dynamic class changes.

**Usage:**
1. You must declare \`@grant CM_findElement\`
2. Pass a \`dom_*\` ID string (e.g., \`await CM_findElement('dom_1234567890_abc')\`)
3. **Important:** \`dom_*\` IDs are generated by the user using the Customaise DOM selector tooltip. Do not invent your own \`dom_*\` IDs. If creating elements dynamically, use standard \`document.querySelector\`.
4. The function is async and must be awaited.

**CM_findExternalElement:** Works like \`CM_findElement\` but targets elements inside cross-origin iframes. Requires \`@connect\` for the iframe's domain. Usage: \`await CM_findExternalElement('dom_ext_xxx')\`.

## CM_promptAI (On-Device AI / Gemini Nano)

Run Chrome's built-in Prompt API (on-device Gemini Nano) from your script. Runs on-device: no API key, no cost, no server round-trip, works offline once the model is provisioned. Chrome desktop only (the model is not present on Android/iOS or other browsers), so always feature-detect.

Declare \`// @grant CM_promptAI\`.

### Capability probe

- \`await CM_promptAI.availability()\` → \`'available' | 'downloadable' | 'downloading' | 'unavailable'\`. Check it first and degrade gracefully when it is not \`'available'\`.
- \`await CM_promptAI.params()\` → \`{ defaultTopK, maxTopK, defaultTemperature, maxTemperature }\` or \`null\`. Use it to default sampling options safely; hard-coded values may drift across Chrome versions. Returns \`null\` when Nano is unavailable.

### Single-shot prompt (most common)

\`\`\`js
const text = await CM_promptAI(input, options?);
\`\`\`

\`input\` is one of:
- A plain string (treated as a user-role text prompt).
- A multi-turn message array: \`[{ role: 'system'|'user'|'assistant', content: <string OR parts[]> }]\` where the system message must be index 0.

Multimodal \`content\` parts: \`[{ type: 'text', value: '...' }, { type: 'image', value: <Blob|ImageBitmap|ArrayBuffer|data-URL> }, { type: 'audio', value: <Blob|ArrayBuffer|data-URL> }]\`. Image/audio cross the bridge as base64 data URLs (the shim serialises Blob/ImageBitmap automatically) and the SW reconstructs them before passing to Chrome. **Per-part size cap is 4 MB** (Blob \`.size\` or PNG-encoded byte length for ImageBitmap), plus a **16 megapixel pre-encode guard for ImageBitmap** (4096 × 4096 max — covers any realistic photo including 4K). Larger inputs reject with \`PROMPT_AI_BAD_INPUT\` and an actionable downscale message.

\`options\`:
- \`schema\` — JSON Schema → \`responseConstraint\`. The result string \`JSON.parse\`s into your schema.
- \`omitResponseConstraintInput: true\` — keeps the schema OUT of the model's context window (token economy). **Requires \`schema\` too** — passing it without a schema rejects with \`PROMPT_AI_BAD_INPUT\` (the option only suppresses serialising a constraint that exists).
- \`system\` — convenience string folded into \`initialPrompts[0]\` when no \`initialPrompts\` array is supplied.
- \`initialPrompts\` — full \`[{role, content}]\` array; takes precedence over \`system\`.
- \`temperature\` AND \`topK\` — sampling. **Both-or-neither**: Chrome rejects session-init if only one is provided. Out-of-range values (\`topK<1\`, \`temperature<0\`, \`temperature>maxTemperature\`) also reject as \`PROMPT_AI_BAD_INPUT\`. Pre-flight validated at the shim; you'll get the typed error rather than Chrome's misleading internal error. Read \`CM_promptAI.params()\` for defaults/limits.
- \`expectedInputs\` / \`expectedOutputs\` — \`[{type: 'text'|'image'|'audio', languages?: ['en','ja',...]}]\`. Hint to Chrome for download-on-demand language packs; pass to \`availability()\` and \`prompt()\` with the same options.
- \`timeoutMs\` — defaults 25000ms; hard cap 28000ms (MAIN_WORLD_BRIDGE 30s ceiling).
- \`signal\` — AbortSignal. Aborting cancels the SW-side generation immediately.

### Streaming (token-by-token)

\`\`\`js
for await (const chunk of CM_promptAI.stream(input, options?)) {
  appendToUI(chunk);                  // delta strings
}
\`\`\`

Returns an AsyncIterable<string>. \`options\` accepts everything from the single-shot surface. \`responseConstraint\` is honoured during streaming — chunks accumulate into a single JSON value (the final chunks may just be closing braces).

### Sessions (multi-turn, opt-in)

The bare \`CM_promptAI(...)\` call is per-call isolated — every call creates and destroys its own session so context never bleeds across unrelated work. For stateful conversation, opt into a session:

\`\`\`js
const session = await CM_promptAI.session({
  system, initialPrompts,             // seed context
  temperature, topK,                   // sampling
  expectedInputs, expectedOutputs,
});

const a = await session.prompt('Hi, my name is Aria.');
const b = await session.prompt('What did I say my name was?');   // remembers
for await (const c of session.promptStream('Write a long story.', { schema })) { /* ... */ }
await session.append([{ role: 'user', content: 'Also remember this fact.' }]);
const branch = await session.clone();                 // fork an independent copy
const tokens = await session.measureContextUsage('How many tokens is this?');

session.contextUsage;                                  // last-known used count
session.contextWindow;                                 // last-known budget
await session.refresh();                               // pull fresh counts without prompting

await session.destroy();                               // explicit cleanup
\`\`\`

Lifecycle: sessions auto-destroy when the tab closes, when idle for 10 minutes, when a per-tab cap (16) evicts the oldest, or when you explicitly call \`destroy()\`. After teardown, every method on the handle throws \`PROMPT_AI_SESSION_GONE\`.

### Download progress + warm

When \`availability()\` returns \`'downloadable'\` you can kick the download yourself and listen for progress:

\`\`\`js
CM_promptAI.addEventListener('downloadprogress', (e) => {
  showProgress(e.loaded);              // 0 → 1; e.total is always 1
});
await CM_promptAI.warm();              // kicks model download/load
\`\`\`

\`CM_promptAI.warm()\` resolves to the post-warm availability state. Listeners survive across calls and receive events from any script that triggered a warm (the model is browser-global).

### What Nano is good for / not

**Use it for** classification, summarisation, JSON extraction, short rewrites, intent parsing, and short tool-selection (using \`responseConstraint\` to emit a tagged union — there is NO native function calling in Chrome 148 stable). Gemini Nano is small (~9216-token context) and weakens past 2 reasoning steps. **Do not** use it for code generation or multi-step reasoning; route those to the IDE agent.

### Errors

Every rejection is an \`Error\` with \`.code\` set; \`PROMPT_AI_CONTEXT_OVERFLOW\` also carries \`.details = { requested, contextWindow }\`. Branch on \`.code\`:

| \`.code\` | When |
|---|---|
| \`PROMPT_AI_UNAVAILABLE\` | API not in this browser, or model can't be loaded |
| \`PROMPT_AI_BAD_INPUT\` | Empty input, malformed message shape, sampling-pair half-set |
| \`PROMPT_AI_TIMEOUT\` | Hard timeout or SW-side internal abort |
| \`PROMPT_AI_CANCELLED\` | Your \`signal.abort()\` fired |
| \`PROMPT_AI_ABORTED\` | Iterator/handle aborted (stream / session path) |
| \`PROMPT_AI_CONTEXT_OVERFLOW\` | Chrome \`QuotaExceededError\` — context too small for input. Check \`err.details\` |
| \`PROMPT_AI_SCHEMA_UNSUPPORTED\` | JSON Schema uses features Nano can't constrain |
| \`PROMPT_AI_SCHEMA_VIOLATION\` | Model output failed your \`responseConstraint\` |
| \`PROMPT_AI_ENCODING\` | Multimodal Blob malformed |
| \`PROMPT_AI_NETWORK\` | Model download failure |
| \`PROMPT_AI_SESSION_GONE\` | Session handle is destroyed/recycled |
| \`PROMPT_AI_SESSION_RECYCLED\` | Session was idle-GC'd before this call landed |
| \`PROMPT_AI_FAILED\` | Generic fallback |

### Example: schema-constrained single-shot

\`\`\`js
// @grant CM_promptAI
if (await CM_promptAI.availability() !== 'available') return;
const limits = await CM_promptAI.params();
const raw = await CM_promptAI('Summarise this in one sentence as JSON {"summary":"..."}', {
  schema: { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } },
  system: 'You output only JSON.',
  temperature: limits.defaultTemperature,
  topK: limits.defaultTopK,
});
const { summary } = JSON.parse(raw);
\`\`\`

## CM_devtools (Chrome DevTools Protocol Access)

Gives your script Chrome DevTools Protocol (CDP) access. Use only when DOM, \`fetch\` interception, and \`CM_findElement\` aren't enough — typically for: Network events across cross-origin iframes, genuinely-trusted Input events, mid-flight request rewriting, headless screenshots, or breakpoints.

CDP reference: <https://chromedevtools.github.io/devtools-protocol/> — look up method names there; do not invent them.

### Prerequisites

1. \`// @grant CM_devtools\` — this implicitly grants \`CM_withDevtools\` too.
2. \`// @devtools-justification <80-500 chars explaining WHY>\` — shows in the user's install consent and per-row tooltip. Required for marketplace publish; soft warning at export.
3. User must enable **Settings → Scripts → Chrome DevTools Access**. Resets every Chrome restart by design. Until enabled, CDP calls return \`DEVTOOLS_DISABLED_BY_USER\`.
4. Chrome shows its standard yellow "X is debugging this browser" banner while you hold a session. The user can click **Cancel** on it.

### Behavior to know

- **CDP is tab-scoped, not frame-scoped.** \`Network.*\` and \`DOM.*\` events fire across every frame in the tab including cross-origin iframes — the main reason to reach for CDP.
- **\`@connect\` does NOT gate CDP traffic.** Your \`@connect\` allowlist applies to \`GM_xmlhttpRequest\`, not to CDP. Your justification must reflect what your CDP code reads or modifies cross-origin.
- **Acquire inside the function that uses CDP; release before returning.** Don't hold a session across page changes — cross-origin navigation auto-detaches, and inactive sessions auto-detach after a short idle window.
- **If the user clicks Cancel on the banner, that tab is locked.** Re-attach is refused for ~5 minutes (or until tab reload). They reload to allow CDP again.

### Usage

\`\`\`javascript
// One-shot CDP command
const dt = await CM_devtools();
try {
  const m = await dt.send('Page.getLayoutMetrics');
  // use m
} finally {
  await dt.close();
}

// Scoped session — auto-acquires and auto-releases (even on throw)
const events = await CM_withDevtools(async (dt) => {
  await dt.send('Network.enable');
  const out = [];
  const off = dt.on('Network.requestWillBeSent', (p) => {
    out.push({ method: p.request.method, url: p.request.url });
  });
  await new Promise(r => setTimeout(r, 3000));
  off();
  return out;
});

// Live event subscription. dt.on returns synchronously but the underlying
// subscription is async — yield ~50ms before the action you want to capture.
const dt = await CM_devtools();
await dt.send('Network.enable');
const off = dt.on('Network.responseReceived', (p) => { /* ... */ });
await new Promise(r => setTimeout(r, 50));
triggerTheAction();
off();
await dt.close();
\`\`\`

To capture requests during the page's own load, use \`@run-at document-start\` and subscribe before yielding. The first few requests may still beat you; if you need every request from cold start, monkey-patch \`fetch\`/\`XMLHttpRequest\` synchronously instead.

### Errors

CDP calls throw \`Error\` with a \`.code\`:

| \`.code\` | When | Tell the user |
|---|---|---|
| \`DEVTOOLS_DISABLED_BY_USER\` | Toggle is off | Enable Settings → Scripts → Chrome DevTools Access |
| \`DEBUGGER_DETACHED_BY_USER\` | User clicked Cancel on the banner | Reload the tab to re-allow |
| \`DEBUGGER_BUSY\` | Chrome DevTools is open on this tab | Close DevTools (F12) and retry |
| \`DEVTOOLS_NOT_ACQUIRED\` | Session lost (tab navigated, etc.) | Re-acquire with a fresh \`CM_devtools()\` |
| \`DEBUGGER_ATTACH_TIMEOUT\` | Tab is discarded/frozen | Focus the tab and reload |
| \`DEBUGGER_UNSUPPORTED_URL\` | chrome://, devtools://, chromewebstore.google.com | Different URL, or skip CDP |
| \`DEBUGGER_TAB_GONE\` | Tab closed mid-call | Re-acquire on a live tab |
| \`DEBUGGER_NO_INCOGNITO_ACCESS\` | Incognito + Allow-in-incognito off | Enable at chrome://extensions |

Branch on the common ones:

\`\`\`javascript
try {
  const dt = await CM_devtools();
  try { return await dt.send('Page.getLayoutMetrics'); }
  finally { await dt.close(); }
} catch (e) {
  if (e.code === 'DEVTOOLS_DISABLED_BY_USER') return { error: 'devtools-off', action: 'Enable Settings → Scripts → Chrome DevTools Access' };
  if (e.code === 'DEBUGGER_BUSY')             return { error: 'devtools-busy', action: 'Close DevTools (F12) and retry' };
  if (e.code === 'DEBUGGER_DETACHED_BY_USER') return { error: 'devtools-cancelled', action: 'Reload the tab to re-allow' };
  throw e;
}
\`\`\`

### Don't

- **Don't retry these in a loop.** \`DEVTOOLS_DISABLED_BY_USER\`, \`DEBUGGER_BUSY\`, \`DEBUGGER_DETACHED_BY_USER\` all need human action. Surface and stop.
- **Don't acquire at script load.** Acquire inside the function that uses CDP, release before returning.
- **Don't subscribe to high-frequency events you don't need.** \`Network.dataReceived\` fires per TCP chunk; \`Network.requestWillBeSent\` is usually what you want.
- **Don't invent CDP method names.** \`Page.captureFullScreenshot\` doesn't exist; \`Page.captureScreenshot\` does.

## Available GM_* APIs
Customaise supports 26 \`GM_*\` APIs (full list canonical in \`extension/src/background/services/metadata-schema-normalizer.js\` \`SUPPORTED_GRANTS\`). You can use either the classic \`GM_*\` (underscore) or modern \`GM.*\` (promise-based) syntax.

### Environment & Console
| API | Description |
|-----|-------------|
| \`GM_log(msg)\` | Log to Customaise console (visible via \`get_console_context\` tool) |
| \`GM_info\` | Object containing script metadata |

### Storage (Extension-Scoped)
| API | Description |
|-----|-------------|
| \`GM_setValue(k, v)\` | Persistent storage (survives page reloads) |
| \`GM_getValue(k, def)\` | Read from persistent storage |
| \`GM_deleteValue(k)\` | Delete from persistent storage |
| \`GM_listValues()\` | List all stored keys |
| \`GM_setValues({k:v,...})\` | Bulk set (v5.3+); atomic write of multiple keys in one call |
| \`GM_getValues([keys])\` | Bulk read (v5.3+); fewer round-trips than per-key \`getValue\` |
| \`GM_deleteValues([keys])\` | Bulk delete (v5.3+) |
| \`GM_addValueChangeListener(name, cb)\` | Listen for storage changes across tabs |
| \`GM_removeValueChangeListener(id)\` | Remove storage listener |

### Cookies (Advanced)
| API | Description |
|-----|-------------|
| \`GM_cookie\` | Frozen object with sub-methods, NOT a callable. \`await GM_cookie.list(details)\` returns matching cookies; \`await GM_cookie.set(details)\` writes one; \`await GM_cookie.delete(details)\` removes one. Each method also accepts a Node-style \`(err, result) => ...\` callback as a second arg; omit it to get a Promise back. \`details\` is the same shape \`chrome.cookies\` uses (url / name / domain / path / value / secure / httpOnly / sameSite / expirationDate etc.). Subject to host permissions and the script's \`@connect\` allowlist. Note: \`.store\` is a Firefox-container-specific Tampermonkey method that's stubbed in Chromium and will reject. |

### DOM & UI
| API | Description |
|-----|-------------|
| \`GM_addStyle(css)\` | Inject CSS into the page |
| \`GM_addElement(tag, attr)\` | Safely create and append DOM elements |
| \`GM_registerMenuCommand(name, fn)\` | Add a command to the extension menu |
| \`GM_unregisterMenuCommand(id)\` | Remove a menu command |
| \`GM_notification(details)\` | Show a desktop OS notification |

### Network & Resources
| API | Description |
|-----|-------------|
| \`GM_xmlhttpRequest(details)\` | Cross-origin HTTP request. \`details\` shape: \`{ method, url, headers?, data?, responseType?, timeout?, onload, onerror, onreadystatechange?, ontimeout?, onabort?, onprogress? }\`. Returns an object with an \`.abort()\` method. **Requires \`@connect <host>\` directive** for the URL's host, otherwise the call fails silently. Successful response object exposes \`status\`, \`statusText\`, \`responseHeaders\`, \`responseText\`, \`response\` (parsed per \`responseType\`), \`finalUrl\`. |
| \`GM_download(details)\` | Save a URL to disk. \`details\` shape: \`{ url, name, headers?, saveAs?, onload?, onerror?, ontimeout?, onprogress? }\`. The \`name\` is the suggested filename; \`saveAs: true\` prompts the user for the location. Same \`@connect\` gating as \`GM_xmlhttpRequest\`. |
| \`GM_notification(details)\` | Show a desktop OS notification. \`details\` shape: \`{ text, title?, image?, highlight?, silent?, timeout?, onclick?, ondone? }\` OR the short form \`GM_notification(text, title?, image?, onclick?)\`. \`timeout\` in milliseconds (0 = sticky). |
| \`GM_getResourceText(name)\` | Read text content from a \`@resource\` declaration |
| \`GM_getResourceURL(name)\` | Get base64 data URI for a \`@resource\` declaration |

### Tabs & System
| API | Description |
|-----|-------------|
| \`GM_setClipboard(text, type?)\` | Copy text to OS clipboard. \`type\` defaults to \`'text'\`; use \`'html'\` to copy rich HTML. |
| \`GM_openInTab(url, options?)\` | Open a new browser tab. \`options\` shape: \`{ active?, insert?, setParent? }\` (all booleans). Shorthand: pass a boolean instead of the object as \`loadInBackground\` (legacy form). Returns an object with \`.close()\` and \`.closed\` (boolean). |
| \`GM_getTab(cb)\` | Read the per-tab persisted object for the current tab. \`cb\` receives the stored object (or empty \`{}\`). Per-tab storage is independent from \`GM_setValue\`'s extension-wide storage and is cleared when the tab closes. |
| \`GM_saveTab(obj)\` | Persist an object as the current tab's per-tab state. Overwrites any previous value. |
| \`GM_getTabs(cb)\` | Read every tab's per-tab persisted object. \`cb\` receives \`{ tabId: object, ... }\`. |

## Developer Workflow & Best Practices
1. **Use \`GM_log\` over \`console.log\`:** \`GM_log\` output is explicitly tracked by Customaise and is visible when using the \`get_console_context\` MCP tool.
2. **Cross-Origin Requests:** If your script needs to fetch data from \`api.github.com\`, you MUST include \`// @connect api.github.com\` in the metadata block, or \`GM_xmlhttpRequest\` will fail silently.
3. **Handle Dynamic Pages:** Most modern sites are SPAs (Single Page Applications). Elements may not exist immediately. Use \`CM_findElement\` or \`MutationObserver\` instead of assuming elements are present on load.
4. **Execution Timing:** \`// @run-at document-idle\` is the safest default as it ensures the initial DOM is fully parsed.
`;

const AGENTSCRIPT_CONVENTIONS = `# Customaise AgentScripts

AgentScripts inject WebMCP tools onto any web page via \`navigator.modelContext\`.

## Setup & environment

**No Chrome flag required.** Customaise ships a polyfill of \`navigator.modelContext\` that runs on stable Chromium today. The Chrome \`#enable-webmcp-testing\` flag is OPTIONAL — it only matters if the user wants third-party WebMCP-spec inspector tools to introspect Customaise's tool registry. The Customaise stack itself (the in-extension AI, the IDE MCP bridge, every \`@webmcp\`-declared tool) works flag-off.

**The "two browsers" mental model.** Customaise is intentionally split across two browsers:
- **The user's daily Chrome** (or Edge / Brave / any Chromium) — where Customaise is installed, where the user is logged into the target sites (bank, CRM, internal Jira, etc.), where AgentScripts inject. This is where the "hands" live.
- **The IDE running the agent** (Cursor, Claude Code, Windsurf, etc.) — where the agent's "brain" lives. The IDE's built-in browser is NOT where Customaise should run.

The two communicate via a WebSocket on \`localhost:4050\` (the Customaise MCP server, spawned by the IDE's MCP client). The agent never sees the user's cookies or auth tokens — it just calls registered tools and the tools execute inside the user's authenticated session. This split is what unlocks "Bring Your Own Session" automation: any web app the user is already logged into becomes addressable, with no API keys, no OAuth dance, no scraping.

**Prerequisites for the user (one-time).** They need:
1. Customaise extension installed (Web Store or unpacked).
2. If unpacked: \`chrome://extensions\` → Developer mode ON, plus the "Allow user scripts" toggle on Customaise's card.
3. The global AgentScripts toggle in Customaise Settings → Script Management → ON. (Without this, every AgentScript is unregistered globally regardless of per-script enable state.)
4. Whatever site they want to automate, opened and signed in normally.

## Format Requirements
1. MUST use the \`// ==AgentScript==\` metadata block (NOT UserScript).
2. MUST declare each tool via \`// @webmcp <toolName> <permission>\` (permissions: allow, prompt, deny). Undeclared tools are denied by default.
3. Top-level \`navigator.modelContext.registerTool()\` is **strongly recommended** (NOT enforced — IIFE-wrapped scripts also work). The reason: Customaise's in-browser AI editor performs **symbol-level edits** (function-by-function) only on functions that are addressable at the top level or inside a clearly-named IIFE structure with named functions. Flat anonymous code or deeply-nested anonymous arrows force the editor to fall back to **whole-script rewrite**, which is slower, more error-prone, and loses git-friendly diffs. If symbol-editability matters (it usually does for long-lived scripts), structure your code as named top-level functions referenced by your \`registerTool\` calls.

\`\`\`javascript
// ==AgentScript==
// @name         GitHub Agent Actions
// @namespace    https://customaise.com
// @version      1.0.0
// @match        https://github.com/*
// @description  Exposes GitHub issues data to IDE agents via WebMCP tools
// @webmcp       list_open_issues prompt
// @grant        GM_log
// @grant        GM_setValue
// @grant        GM_getValue
// ==/AgentScript==

// AgentScripts execute in the MAIN world, but they CAN use GM_* APIs!
// A built-in bridge automatically routes GM_* requests to the extension securely.
const usageCount = await GM.getValue('usage_count', 0);
await GM.setValue('usage_count', usageCount + 1);
GM_log(\`AgentScript loaded. Usage count: \${usageCount + 1}\`);

navigator.modelContext.registerTool({
  name: "list_open_issues",
  description: "Returns all open issues with titles and labels",
  schema: { type: "object", properties: {} },
  readOnlyHint: true, // Set to true if your tool does not mutate the page (defaults to false)
  execute: async (args) => {
    const issues = document.querySelectorAll('.js-issue-row');
    return Array.from(issues).map(row => ({
      title: row.querySelector('.Link--primary')?.textContent?.trim(),
      labels: Array.from(row.querySelectorAll('.IssueLabel'))
        .map(l => l.textContent?.trim())
    }));
  }
});
\`\`\`

## Required Directives
| Directive | Description |
|-----------|-------------|
| \`@webmcp\`  | **Mandatory.** Format: \`<toolName> <allow|prompt|deny>\`. Declares explicit permissions for each registered tool. |

## Granular Tool Permissions
- \`allow\` — Autonomous. Executes immediately without user confirmation.
- \`prompt\` — Interactive. Triggers the Customaise UX asking for explicit user consent before execution.
- \`deny\` — Blocked. Tool is suppressed and fails if called. All undeclared tools default to deny.

### Consent gate timing (important when designing tools)
Every \`navigator.modelContext.callTool(...)\` invocation — yours, the IDE MCP client's, the in-extension AI's, or any other in-page agent — round-trips to the extension service worker for permission evaluation **before** your \`execute\` body runs. Two practical consequences:
- \`allow\` tools add ~50–100 ms latency per call. Fine for human-paced flows; avoid hot-loop calls.
- \`prompt\` tools may **block for up to 5 minutes** while waiting on the user. Design tools so this is acceptable (no timing-sensitive logic between trigger and execute).

The same gate enforces the same \`@webmcp\` policy across **every call path**, so a tool you mark \`prompt\` will reliably show the consent modal regardless of who invokes it. This is a guarantee you can rely on for security-sensitive operations.

## Manual HITL Requests
Even if your tool is granted the \`allow\` permission, you can dynamically invoke the Customaise consent modal inside an execute block:
\`const consent = await navigator.modelContext.requestUserInteraction({ toolName: 'my_tool', reason: '...' });\`

## GM_* API Support in MAIN World
- AgentScripts execute in the browser's MAIN world so they can access \`navigator.modelContext\`.
- **Customaise provides a secure, native MAIN world bridge for GM_* APIs.**
- AgentScripts are executed contextually by Customaise, so **top-level await is fully supported**.
- \`GM_setValue\`, \`GM_xmlhttpRequest\`, \`GM_log\`, etc., are fully supported.
- You MUST explicitly include a \`@grant\` directive for each API you use, exactly like a UserScript.
- \`unsafeWindow\` should NOT be used (it is redundant because you are already in the MAIN world).

## navigator.modelContext: USE BARE NAME (do not prefix with globalThis/window/self)

Customaise wraps \`navigator.modelContext\` per-script via a function-scoped Proxy injected by the IIFE wrapper. The Proxy enforces:
- User-set **Deny** overrides (silent no-op when the user has denied this script's tool)
- Tool-conflict attribution (when two scripts register the same tool name on the same tab, the SW conflict ledger gets the right scriptId so the UI badge shows on both)
- Multi-conflict iteration UX (dup throws are swallowed so all conflicts surface in one pass instead of crashing on the first)

**Always reference \`navigator.modelContext\` with the bare \`navigator\` identifier:**
\`\`\`js
// CORRECT — resolves through the per-script Proxy
navigator.modelContext.registerTool({ name: 'foo', description: '...', execute: ... });
const tools = navigator.modelContext.listTools();
\`\`\`

**Never explicitly access via the global object — those bypass the Proxy:**
\`\`\`js
// WRONG — these skip Customaise's Deny enforcement, conflict attribution,
//         and multi-conflict UX. The user's overrides will silently not apply.
globalThis.navigator.modelContext.registerTool({ ... });
window.navigator.modelContext.registerTool({ ... });
self.navigator.modelContext.registerTool({ ... });
\`\`\`

The bare \`navigator\` is shadowed by a function-local declaration inside the IIFE wrapper. Explicit globalThis/window/self lookups skip the lexical scope chain and hit the unwrapped browser navigator instead. This is a deliberate Customaise convention — the W3C \`navigator.modelContext\` spec doesn't require Customaise's deny/attribution semantics, but our scripts depend on them for proper UX.

**Spec deviation note**: when a tool name collides with another script's registration on the same tab, the W3C spec says \`registerTool\` should throw \`InvalidStateError\`. Customaise's wrapper SWALLOWS this throw (sends the conflict signal to the SW for badge surfacing, then returns a no-op handle) so user code continues past the duplicate call. This means scripts that explicitly \`try/catch\` \`InvalidStateError\` will not see it; rely on the Tool Conflict badge in the script row UI for resolution instead.

## Advanced Networking & Auth Interception
You can use \`@run-at document-start\` to inject your AgentScript before the target page loads.
This allows you to patch \`window.fetch\` or \`XMLHttpRequest\` to capture bearer tokens or authentication headers.
You can then securely store them using \`GM_setValue\` and retrieve them using \`GM_getValue\` inside your WebMCP tool executions, enabling your AI agents to perform authenticated actions on behalf of the user.

## CM_promptAI (On-Device AI / Gemini Nano)

Run Chrome's built-in Prompt API (on-device Gemini Nano) from your tool's \`execute\`. Runs on-device: no API key, no cost, no server round-trip, works offline once the model is provisioned. Chrome desktop only (the model is not present on Android/iOS or other browsers), so always feature-detect.

Declare \`// @grant CM_promptAI\`.

**Why use it inside a WebMCP tool?** Classifying user input, picking a label from a small enum, summarising a chunk before returning it to the IDE agent, drafting a short reply — all things where round-tripping to the IDE agent would be slower and more expensive than calling Nano locally for ~600ms. **Route heavy synthesis to the IDE agent (yourself), not to CM_promptAI.** Nano weakens past 2 reasoning steps; it is your fast local label-maker, not a sub-agent.

### Capability probe

- \`await CM_promptAI.availability()\` → \`'available' | 'downloadable' | 'downloading' | 'unavailable'\`.
- \`await CM_promptAI.params()\` → \`{ defaultTopK, maxTopK, defaultTemperature, maxTemperature }\` or \`null\`.

### Single-shot prompt

\`\`\`js
const text = await CM_promptAI(input, options?);
\`\`\`

\`input\`: plain string OR \`[{role: 'system'|'user'|'assistant', content: <string OR parts[]>}]\` where the system message must be index 0. Multimodal \`content\` parts: \`[{type: 'text', value: '...'}, {type: 'image', value: <Blob|ImageBitmap|ArrayBuffer|data-URL>}, {type: 'audio', value: <Blob|ArrayBuffer|data-URL>}]\`. The shim serialises image/audio across the bridge automatically. **Per-part size cap is 4 MB**, plus a 16 megapixel pre-encode guard for ImageBitmap (4096 × 4096 max). Larger inputs reject with \`PROMPT_AI_BAD_INPUT\` — downscale or compress.

\`options\`:
- \`schema\` — JSON Schema → \`responseConstraint\`. Result string \`JSON.parse\`s into your schema.
- \`omitResponseConstraintInput: true\` — schema NOT serialised into context window (saves tokens). **Requires \`schema\` too** — passing it alone rejects with \`PROMPT_AI_BAD_INPUT\`.
- \`system\` / \`initialPrompts\` — system message convenience OR full \`[{role, content}]\` seed array.
- \`temperature\` AND \`topK\` — sampling. **Both-or-neither**; out-of-range values reject as \`PROMPT_AI_BAD_INPUT\`. Default via \`CM_promptAI.params()\`.
- \`expectedInputs\` / \`expectedOutputs\` — \`[{type: 'text'|'image'|'audio', languages?: [...]}]\` language/modality hints.
- \`timeoutMs\` — default 25000ms, hard cap 28000ms.
- \`signal\` — AbortSignal.

### Streaming (token-by-token)

\`\`\`js
for await (const chunk of CM_promptAI.stream(input, options?)) { /* delta strings */ }
\`\`\`

Same options as single-shot. Streams JSON when \`schema\` is set (concat chunks then \`JSON.parse\`).

### Sessions (multi-turn, opt-in)

The bare \`CM_promptAI(...)\` is per-call isolated. For stateful conversation:

\`\`\`js
const session = await CM_promptAI.session({ system, initialPrompts, temperature, topK });
const a = await session.prompt('Remember the project codename is "Halcyon".');
const b = await session.prompt('What codename did I just give you?');
for await (const c of session.promptStream('Long explanation...', { schema })) {}
await session.append([{ role: 'user', content: 'Also remember the deadline is Friday.' }]);
const fork = await session.clone();                                  // independent branch
const tokens = await session.measureContextUsage('How many tokens?');
session.contextUsage; session.contextWindow;                          // live (refresh with session.refresh())
await session.destroy();
\`\`\`

Auto-cleanup: tab close, 10-minute idle, per-tab cap (16), or explicit \`destroy()\`. After teardown every method throws \`PROMPT_AI_SESSION_GONE\`.

**HITL applies normally** — \`CM_promptAI\` calls happen inside your tool's \`execute\` body, after the user has already approved the tool. The local-AI call itself isn't gated (no network, no privileged surface beyond what your tool already does).

### Download progress

\`\`\`js
CM_promptAI.addEventListener('downloadprogress', (e) => { /* e.loaded: 0→1 */ });
await CM_promptAI.warm();              // kicks model load; resolves to post-warm state
\`\`\`

### Errors

Every rejection is an \`Error\` with \`.code\`; \`PROMPT_AI_CONTEXT_OVERFLOW\` carries \`.details = { requested, contextWindow }\`. Codes: \`PROMPT_AI_UNAVAILABLE\`, \`PROMPT_AI_BAD_INPUT\`, \`PROMPT_AI_TIMEOUT\`, \`PROMPT_AI_CANCELLED\`, \`PROMPT_AI_ABORTED\`, \`PROMPT_AI_CONTEXT_OVERFLOW\`, \`PROMPT_AI_SCHEMA_UNSUPPORTED\`, \`PROMPT_AI_SCHEMA_VIOLATION\`, \`PROMPT_AI_ENCODING\`, \`PROMPT_AI_NETWORK\`, \`PROMPT_AI_SESSION_GONE\`, \`PROMPT_AI_SESSION_RECYCLED\`, \`PROMPT_AI_FAILED\`. Branch on \`err.code\` and surface actionable messages.

### Example: classify inside an AgentScript tool

\`\`\`js
// @grant CM_promptAI
// @webmcp classify_sentiment allow
navigator.modelContext.registerTool({
  name: 'classify_sentiment',
  description: 'Classify text into positive/negative/neutral via on-device Nano.',
  schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
  readOnlyHint: true,
  execute: async ({ text }) => {
    if (await CM_promptAI.availability() !== 'available') {
      return { ok: false, error: 'nano-unavailable' };
    }
    const raw = await CM_promptAI(\`Classify: \${text}\\nReturn JSON.\`, {
      schema: {
        type: 'object', required: ['label', 'confidence'],
        properties: {
          label: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
      system: 'You output only JSON.',
    });
    return { ok: true, ...JSON.parse(raw) };
  },
});
\`\`\`

## CM_devtools (Chrome DevTools Protocol Access)

Expose Chrome DevTools Protocol (CDP) as a WebMCP tool. Use only when DOM, \`fetch\` interception, and \`CM_findElement\` aren't enough — typically for: Network events across cross-origin iframes, genuinely-trusted Input events, mid-flight request rewriting, headless screenshots, or breakpoints.

CDP reference: <https://chromedevtools.github.io/devtools-protocol/> — look up method names there; do not invent them.

### Prerequisites

1. \`// @grant CM_devtools\` — this implicitly grants \`CM_withDevtools\` too.
2. \`// @devtools-justification <80-500 chars explaining WHY>\` — shows in the user's install consent and per-row tooltip. \`export_script\` returns \`DEVTOOLS_JUSTIFICATION_MISSING\` in \`warnings[]\` if absent. Required for marketplace publish.
3. User must enable **Settings → Scripts → Chrome DevTools Access**. Resets every Chrome restart by design. While off, CDP calls return \`DEVTOOLS_DISABLED_BY_USER\` and the script's row toggle renders amber as a heads-up.
4. Chrome shows its standard yellow "X is debugging this browser" banner while you hold a session. The user can click **Cancel** on it — say so in your tool description if it matters.

### Behavior to know

- **CDP is tab-scoped, not frame-scoped.** \`Network.*\` and \`DOM.*\` events fire across every frame in the tab including cross-origin iframes — the main reason to reach for CDP.
- **\`@connect\` does NOT gate CDP traffic.** Your \`@connect\` allowlist applies to \`GM_xmlhttpRequest\`, not to CDP. Your justification must reflect what your CDP code reads or modifies cross-origin.
- **Acquire inside \`execute\`; release before returning.** Don't hold a session across tool calls or page changes — cross-origin navigation auto-detaches, and inactive sessions auto-detach after a short idle window. Use \`CM_withDevtools\` to make the lifecycle obvious.
- **If the user clicks Cancel on the banner, that tab is locked.** Re-attach is refused for ~5 minutes or until tab reload. They reload to allow CDP again.

### Pattern — CDP-backed tool

\`\`\`javascript
// ==AgentScript==
// @name         Network Sniffer
// @match        https://target.example.com/*
// @webmcp       tgt_capture_network allow
// @grant        CM_devtools
// @grant        GM_log
// @devtools-justification Subscribes to Network.requestWillBeSent for a brief window so the agent can see what API endpoints the page hits in response to a UI action. The page uses cross-origin iframes whose requests window.fetch interception cannot see.
// ==/AgentScript==

// Prefix tool names with a 2-4 letter site code — WebMCP tool names share
// a global namespace across all open AgentScripts on the tab, so generic
// names like 'capture_network' will collide.
navigator.modelContext.registerTool({
  name: 'tgt_capture_network',
  description: 'Hold a CDP session for N ms and return requests the page makes during the window. Chrome shows a yellow "debugging this browser" banner while active.',
  schema: {
    type: 'object',
    properties: { durationMs: { type: 'number', description: 'Capture window in ms. 500-10000.' } },
  },
  readOnlyHint: true,
  execute: async (args) => {
    const ms = Math.min(Math.max(Number(args?.durationMs) || 3000, 500), 10000);
    const captured = [];
    try {
      await CM_withDevtools(async (dt) => {
        await dt.send('Network.enable');
        const off = dt.on('Network.requestWillBeSent', (p) => {
          captured.push({ method: p.request.method, url: p.request.url, type: p.type });
        });
        // dt.on returns synchronously but the underlying subscription is
        // async. Yield once so events fired right at the start of the
        // window are picked up.
        await new Promise(r => setTimeout(r, 50));
        await new Promise(r => setTimeout(r, ms));
        off();
      });
      return { ok: true, captured };
    } catch (e) {
      if (e.code === 'DEVTOOLS_DISABLED_BY_USER') return { ok: false, error: 'devtools-off',       action: 'Enable Settings → Scripts → Chrome DevTools Access' };
      if (e.code === 'DEBUGGER_BUSY')             return { ok: false, error: 'devtools-busy',      action: 'Close Chrome DevTools (F12) and retry' };
      if (e.code === 'DEBUGGER_DETACHED_BY_USER') return { ok: false, error: 'devtools-cancelled', action: 'Reload the tab to re-allow' };
      return { ok: false, error: e.code || 'devtools-failed', message: String(e.message || e) };
    }
  },
});
\`\`\`

### Errors

| \`.code\` | When | Tell the user |
|---|---|---|
| \`DEVTOOLS_DISABLED_BY_USER\` | Toggle is off | Enable Settings → Scripts → Chrome DevTools Access |
| \`DEBUGGER_DETACHED_BY_USER\` | User clicked Cancel on the banner | Reload the tab to re-allow |
| \`DEBUGGER_BUSY\` | Chrome DevTools is open on this tab | Close DevTools (F12) and retry |
| \`DEVTOOLS_NOT_ACQUIRED\` | Session lost (tab navigated, etc.) | Re-acquire with a fresh \`CM_devtools()\` |
| \`DEBUGGER_ATTACH_TIMEOUT\` | Tab is discarded/frozen | Focus the tab and reload |
| \`DEBUGGER_UNSUPPORTED_URL\` | chrome://, devtools://, chromewebstore.google.com | Different URL, or skip CDP |
| \`DEBUGGER_TAB_GONE\` | Tab closed mid-call | Re-acquire on a live tab |
| \`DEBUGGER_NO_INCOGNITO_ACCESS\` | Incognito + Allow-in-incognito off | Enable at chrome://extensions |

### Don't

- **Don't retry these in a loop.** \`DEVTOOLS_DISABLED_BY_USER\`, \`DEBUGGER_BUSY\`, \`DEBUGGER_DETACHED_BY_USER\` all need human action. Surface the error and stop.
- **Don't acquire at module scope.** Always inside \`execute\` so the session lifecycle aligns with the tool call.
- **Don't subscribe to high-frequency events you don't need.** \`Network.dataReceived\` fires per TCP chunk; \`Network.requestWillBeSent\` is usually what you want.
- **Don't use unprefixed tool names.** WebMCP tool names share a global namespace across all open AgentScripts on the tab. Prefix with a 2-4 letter site code.
- **Don't invent CDP method names.** Look them up.

## AgentScript Workflow
1. Use \`get_page_context\` to understand the page structure
2. Identify areas of the page that would make good "read" tools (tables, lists, data)
3. Identify forms/buttons that would make good "write" tools (interactive). For those, ensure \`readOnlyHint: false\`.
4. Write the \`.agent.js\` code to a file in the workspace directory (e.g., ./customaise-scripts/), NEVER to /tmp.
5. Use \`export_script\` to install it into Customaise. **Read the response \`warnings[]\` array** — silent issues like malformed \`@webmcp\` lines or tools registered without a matching \`@webmcp\` declaration are surfaced there. They will NOT be re-surfaced when the tool fails at call time.
6. Use \`reload_tab\` on the target page so the AgentScript actually injects.
7. Use \`list_webmcp_tools\` to verify your tools successfully registered on the page.
8. Call them via \`call_webmcp_tool\`.

## Patterns & Recipes — how to actually be productive

The single biggest mental shift: **WebMCP turns the page into a REPL for you.** You aren't writing one big script that has to work first try. You build a small introspective tool, call it via \`call_webmcp_tool\`, observe the structured JSON, modify the script, re-export, call again. Tight loop. Throw the diagnostic tools away when done.

### Recipe 1 — The "diagnostic tool" pattern (your single most important habit)
Whenever you start work against a page you don't know well, your **first** AgentScript should be a no-op tool whose only job is to surface state.

\`\`\`javascript
// ==AgentScript==
// @name        Page Inspector
// @match       https://target.example.com/*
// @webmcp      inspect_state allow
// @grant       GM_log
// @run-at      document-start
// ==/AgentScript==

const _captured = { posts: [], headers: {}, ready: false };

const _origFetch = window.fetch;
window.fetch = function (input, init) {
  const url = typeof input === 'string' ? input : input?.url;
  if (init?.method === 'POST' && url?.includes('/api/')) {
    _captured.posts.push({ url, body: typeof init.body === 'string' ? init.body.slice(0, 300) : null });
    if (init.headers) Object.assign(_captured.headers, init.headers);
    _captured.ready = true;
  }
  return _origFetch.apply(this, arguments);
};

navigator.modelContext.registerTool({
  name: 'inspect_state',
  description: 'Returns intercepted POST endpoints and headers seen so far.',
  schema: { type: 'object', properties: {} },
  readOnlyHint: true,
  execute: async () => ({ ..._captured, headerKeys: Object.keys(_captured.headers) }),
});
\`\`\`

Now you can call \`inspect_state\` from your IDE after performing actions on the page — you'll see exactly what API endpoints exist, what headers carry auth, what payloads look like. **You couldn't do this without WebMCP**: a plain userscript could capture the same data but you'd have to dump it via \`GM_log\` and grep \`get_console_context\` for it. Round-trip too slow to iterate against.

### Recipe 2 — Auth-interception → replay (the "BYO session" trick)
When the target site has no public API but you want to drive it programmatically, the page's own authenticated requests are your API. Pattern:

1. **Intercept at \`document-start\`** (so you catch the page's first requests):
   \`\`\`javascript
   // @run-at document-start
   const captured = { headers: {} };
   const origOpen = XMLHttpRequest.prototype.open;
   const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
   const origSend = XMLHttpRequest.prototype.send;
   XMLHttpRequest.prototype.open = function (method, url) {
     this._vmHeaders = {};
     return origOpen.apply(this, arguments);
   };
   XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
     if (this._vmHeaders) this._vmHeaders[name.toLowerCase()] = value;
     return origSetHeader.apply(this, arguments);
   };
   XMLHttpRequest.prototype.send = function (body) {
     if (this._vmHeaders && Object.keys(this._vmHeaders).length > 2) {
       Object.assign(captured.headers, this._vmHeaders);
     }
     return origSend.apply(this, arguments);
   };
   \`\`\`
2. **Surface what you've captured via a \`check_auth\` tool** (Recipe 1 pattern).
3. **In your action tool, replay the captured headers** on a fresh XHR with your payload:
   \`\`\`javascript
   const xhr = new XMLHttpRequest();
   xhr.open('POST', '/api/the/endpoint', true);
   xhr.withCredentials = true;
   xhr.setRequestHeader('Content-Type', 'application/json');
   for (const [k, v] of Object.entries(captured.headers)) {
     if (!['content-type', 'content-length'].includes(k)) {
       try { xhr.setRequestHeader(k, v); } catch (_) {}
     }
   }
   xhr.send(JSON.stringify(payload));
   \`\`\`

This pattern unlocks **any** web app that the user is logged into. No API keys, no OAuth dance, no scraping. The agent operates as the user, with the user's permission.

### Recipe 3 — Capture-at-execute (don't capture-at-registration)
SPAs change pages without reload. If you read \`document.title\` or any DOM state inside \`registerTool\` (or in module scope at script load), you'll be holding stale data. **Always read live state inside the \`execute\` body.** Wrong:
\`\`\`javascript
const currentPrice = parseFloat(document.title.match(/[\\d.]+/)[0]); // captured ONCE at script load
navigator.modelContext.registerTool({ name: 'foo', execute: async () => ({ currentPrice }) });
\`\`\`
Right:
\`\`\`javascript
navigator.modelContext.registerTool({
  name: 'foo',
  execute: async () => ({ currentPrice: parseFloat(document.title.match(/[\\d.]+/)[0]) }),
});
\`\`\`

### Recipe 4 — Iterate fast, expand state on each cycle
When something doesn't work, **don't rewrite the action tool**. Add fields to your inspection tool's return value. Find the missing piece. Then fix the action. The diagnostic tool grows; the action tool stays focused.

\`\`\`
1. inspect_state shows: 0 captured POSTs → page hasn't done anything yet → user needs to click something
2. inspect_state shows: 12 captured POSTs but no /api/order/place → wrong action triggered, look at page UI
3. inspect_state shows: the right endpoint, but body has fields you didn't expect → copy the format
4. action tool now succeeds
\`\`\`

Each iteration takes seconds because the inspect_state response is structured JSON delivered to you, not a string in a console somewhere.

### Recipe 5 — \`prompt\` for anything with side effects, \`allow\` for reads
Default to \`allow\` for tools that just observe. Use \`prompt\` for anything that mutates state (orders, posts, deletes, transfers). The user's consent is your safety harness — don't bypass it just because \`allow\` is more convenient. The 5-minute consent budget is generous; design tools assuming the user might take 30 seconds to read what you're about to do.

### Recipe 6 — Throw away your diagnostic tools when shipping
Once your action tool works, \`delete_script\` the inspector. Or move its tools to \`@webmcp inspect_state deny\` so they're not callable. Diagnostics in production = attack surface.

## Troubleshooting — \`list_webmcp_tools\` returns empty after reload
Walk these in order. Most common cause first:
1. **Global AgentScripts gate is OFF.** Customaise has a master toggle in Settings → Script Management. If off, every AgentScript is unregistered globally, regardless of per-script enable state. Ask the user to enable it once (per browser profile).
2. **\`@match\` doesn't actually match the URL.** Verify with \`list_tabs\` then compare the URL against your \`@match\` patterns. \`https://demo.example.com/*\` doesn't match \`http://...\` or a different subdomain.
3. **The script is per-script-disabled.** Even with the global gate on, the per-script toggle in Customaise's Script Management UI must be on. \`list_scripts\` shows the \`enabled\` boolean.
4. **Tab wasn't reloaded after export.** Manifest content scripts re-inject only on navigation. Call \`reload_tab\` explicitly.
5. **Script body threw before \`registerTool\` ran.** Use \`get_console_context\` on the tab to look for early errors. Nothing after the throw runs, so your tools never registered.
6. **\`@webmcp\` declarations are malformed and were silently stripped at parse time.** Re-read the \`webmcp[]\` field in the \`export_script\` response — if it's empty but you intended grants, fix the directive syntax (\`<toolName> <allow|prompt|deny>\`, single space, no extra tokens).
7. **You called \`registerTool\` for a tool that isn't declared in any \`@webmcp\` line.** It registers in the page registry but is filtered from \`list_webmcp_tools\` and rejected at call time. Add the \`@webmcp\` line.
`;
