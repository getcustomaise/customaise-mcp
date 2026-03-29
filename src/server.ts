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

import { ExtensionBridge } from './extension-bridge.js';
import { FileWatcher } from './file-watcher.js';

/**
 * Register all MCP tools with the server.
 */
export function registerTools(server: McpServer, bridge: ExtensionBridge, fileWatcher?: FileWatcher): void {

  // ─── Script Lifecycle ───────────────────────────────────────────────

  server.tool(
    'list_scripts',
    'List all userscripts installed in Customaise with their IDs, names, enabled status, match patterns, and whether they are shared (subscribed). Scripts marked isShared are read-only subscriptions — they cannot be imported, exported, edited, or deleted via MCP. To modify a shared script, the user must fork it from the extension UI.',
    {},
    async () => {
      const result = await bridge.request('list_scripts', {});
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  server.tool(
    'import_script',
    'Import an existing userscript from Customaise to a local file for editing. The file will include the full source code with metadata block. After editing the file with your IDE tools, use export_script to push changes back to Customaise. NOTE: Shared/subscribed scripts cannot be imported — they are read-only. The user must fork them from the extension UI first. IMPORTANT: Save files inside your current workspace or project directory (e.g., ./customaise-scripts/), never in /tmp.',
    {
      scriptId: z.string().describe('The ID of the script to import (get from list_scripts)'),
      filePath: z.string().describe('Local file path inside your workspace to write the script to (e.g., ./customaise-scripts/my-script.user.js). Do NOT use /tmp.')
    },
    async ({ scriptId, filePath }) => {
      const result = await bridge.request('import_script', { scriptId }) as {
        scriptId: string;
        source: string;
        metadata: Record<string, unknown>;
      };

      // Ensure directory exists and write file
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, result.source, 'utf-8');

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            filePath,
            scriptId: result.scriptId,
            metadata: result.metadata,
            bytesWritten: Buffer.byteLength(result.source, 'utf-8')
          }, null, 2)
        }]
      };
    }
  );

  server.tool(
    'export_script',
    `Export a userscript from a local file into Customaise. The file will be validated through Customaise's sanitization pipeline (syntax checking, AST validation, security analysis). If valid, the script is installed and ready to execute on matching pages. If invalid, detailed diagnostics explain exactly what to fix. Pass scriptId to update an existing script instead of creating a new one. NOTE: You cannot overwrite a shared/subscribed script — they are read-only.

Reminder: Scripts must use an IIFE with named functions for symbol-level editing, \`// @namespace https://customaise.com\`, and include @name, @match, @description, @version, and @grant directives.`,
    {
      filePath: z.string().describe('Local file path containing the userscript source code'),
      scriptId: z.string().optional().describe('ID of an existing script to update. Omit to create a new script.')
    },
    async ({ filePath, scriptId }) => {
      const code = readFileSync(filePath, 'utf-8');
      const result = await bridge.request('export_script', { code, scriptId });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );



  server.tool(
    'delete_script',
    'Permanently delete a userscript from Customaise. This action cannot be undone. NOTE: Shared/subscribed scripts cannot be deleted via MCP — the user must unsubscribe from the extension UI.',
    {
      scriptId: z.string().describe('The ID of the script to delete')
    },
    async ({ scriptId }) => {
      const result = await bridge.request('delete_script', { scriptId });
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
    async ({ scriptId, enabled }) => {
      const result = await bridge.request('set_script_enabled', { scriptId, enabled });
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
    async ({ tabId }) => {
      const result = await bridge.request('get_page_context', { tabId }) as Record<string, any>;

      // Strip fields that are only for the extension's internal chat UI
      delete result.displayContent;
      delete result.tokenEstimate;

      // Write full context to workspace file (overwrite each time)
      const contextDir = join(getWorkspaceDir(), '.customaise');
      mkdirSync(contextDir, { recursive: true });
      const filePath = join(contextDir, 'page-context.json');
      const fullJson = JSON.stringify(result, null, 2);
      writeFileSync(filePath, fullJson, 'utf-8');

      // Build lightweight summary for the agent's context window
      const url = result.url || '';
      const title = result.title || '';
      const elementCount = result.dom?.elementCount
        ?? result.elementCount
        ?? (typeof result.dom === 'object' ? JSON.stringify(result.dom).length : 0);
      const fileSizeKB = (Buffer.byteLength(fullJson, 'utf-8') / 1024).toFixed(1);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            url,
            title,
            filePath,
            fileSizeKB: `${fileSizeKB} KB`,
            elementCount,
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
    async ({ tabId, level }) => {
      const result = await bridge.request('get_console_context', { tabId }) as {
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
    async () => {
      const result = await bridge.request('list_tabs', {});
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
    'Reload a browser tab to re-inject updated userscripts. Use after export_script to see the effect of your changes. Waits for the page to fully load before returning.',
    {
      tabId: z.number().optional().describe('Tab ID to reload. Defaults to the active tab.')
    },
    async ({ tabId }) => {
      const result = await bridge.request('reload_tab', { tabId });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  server.tool(
    'take_screenshot',
    'Capture a screenshot of the current visible browser tab. Use to verify visual changes made by userscripts. The screenshot is saved as a PNG file.',
    {
      tabId: z.number().optional().describe('Tab ID to screenshot. Defaults to the active tab.'),
      filePath: z.string().optional().describe('Local file path to save the screenshot. Auto-generates a temp path if omitted.')
    },
    async ({ tabId, filePath }) => {
      const result = await bridge.request('take_screenshot', { tabId }) as {
        dataUrl: string;
        width?: number;
        height?: number;
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
            height: result.height
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
    async ({ tabId, panel }) => {
      const result = await bridge.request('show_ui', { tabId, panel });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );


  // ─── File Sync ──────────────────────────────────────────────────────

  server.tool(
    'sync_scripts',
    'Bulk export all your own scripts from Customaise to a local directory as individual .user.js files. Creates a .customaise-manifest.json mapping filenames to script IDs. Shared/subscribed scripts are excluded (they are read-only). Use this to set up a local workspace for editing scripts with your IDE.',
    {
      directory: z.string().describe('Local directory to export scripts to (e.g., ./customaise-scripts/)')
    },
    async ({ directory }) => {
      // Get all scripts with code
      const scripts = await bridge.request('list_scripts_with_code', {}) as Array<{
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
        // Generate a safe filename from the script name
        let safeName = (script.name || 'untitled')
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '');

        // Handle filename collisions — append short ID suffix if name already used
        let fileName = `${safeName}.user.js`;
        if (usedNames.has(fileName)) {
          const idSuffix = script.id.slice(-6);
          fileName = `${safeName}-${idSuffix}.user.js`;
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
    'Get DOM elements that the user has visually selected in the browser for a specific script. Returns each selection\'s bulletproof selectors, element context, and user comments. Use VM_findElement with the domId for precise targeting in scripts. When MCP is connected, .dom.md context files and screenshots are automatically pushed to the workspace (.customaise/dom-context/<script-name>/) in real-time as the user selects elements. Use this tool to retrieve selections if the auto-pushed files are missing or to get the raw JSON data.',
    {
      scriptId: z.string().optional().describe('Script ID to get selections for. Omit to get all scripts\' selections.'),
      writeFiles: z.boolean().optional().describe('If true, writes .dom.md context files to the workspace directory. Default: false.'),
      directory: z.string().optional().describe('Workspace directory for .dom.md files. Required if writeFiles is true.')
    },
    async ({ scriptId, writeFiles, directory }) => {
      const result = await bridge.request('get_selected_elements', { scriptId }) as any;

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
              sel.userComment ? `> ${sel.userComment.replace(/\n/g, '\n> ')}` : '> _No user comment provided._',
              '',
              hasScreenshot ? `![Element screenshot](./${safeElName}.screenshot.png)` : '',
              '',
              '## VM_findElement Usage',
              '```js',
              `const element = await VM_findElement('${sel.domId}');`,
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
      const yq = (s: string) => `"${(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
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
export function registerPromptsAndResources(server: McpServer, bridge: ExtensionBridge): void {

  // ─── Prompts ────────────────────────────────────────────────────────

  server.prompt(
    'create-userscript',
    'Guided workflow for creating a new userscript. Provides a step-by-step prompt that helps the AI agent understand what the user needs and produce a working script.',
    {
      targetUrl: z.string().describe('The URL pattern the script should match (e.g., *://*.example.com/*)'),
      goal: z.string().describe('What the script should accomplish')
    },
    async ({ targetUrl, goal }) => {
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: [
                `Create a userscript for Customaise that does the following:`,
                ``,
                `**Target URL:** ${targetUrl}`,
                `**Goal:** ${goal}`,
                ``,
                `## Requirements`,
                `1. Include a proper metadata block with @name, @namespace, @match, @description, @version, and @grant directives`,
                `2. Use \`// @namespace    https://customaise.com\``,
                `3. Use @match ${targetUrl}`,
                `4. CRITICAL: Wrap the script in an IIFE containing explicit, named top-level functions. Every distinct behavior MUST be a separate named function. Do NOT put logic inline. Customaise uses symbol-level editing (function-by-function) so this structure is mandatory.`,
                `5. If making cross-origin requests, include the @connect directive`,
                `6. Use GM_log for debug output (it appears in Customaise's console context)`,
                `7. Handle edge cases (element not found, page still loading, etc.)`,
                ``,
                `## Workflow`,
                `1. Use \`get_page_context\` to understand the page structure`,
                `2. Write the script code to a file in the workspace directory (e.g., ./customaise-scripts/), NEVER to /tmp`,
                `3. For targeting existing page elements, consider using \`VM_findElement\` with \`dom_*\` IDs from \`get_page_context\` for bulletproof selector resilience`,
                `4. Use \`export_script\` to install it in Customaise (it will be validated through the sanitization pipeline)`,
                `5. Use \`reload_tab\` to test it`,
                `6. Use \`get_console_context\` to check for errors or GM_log output`,
                `7. If there are issues, fix and re-export`,
                ``,
                `## Reference`,
                `Read the \`customaise://conventions\` resource for the full API reference (22 GM_* APIs, metadata directives, and advanced patterns).`,
              ].join('\n')
            }
          }
        ]
      };
    }
  );

  server.prompt(
    'debug-userscript',
    'Debugging workflow for an existing userscript that isn\'t working as expected. Guides the AI through systematic diagnosis using available tools.',
    {
      scriptId: z.string().describe('The ID of the script to debug')
    },
    async ({ scriptId }) => {
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: [
                `Debug the userscript with ID \`${scriptId}\`.`,
                ``,
                `## Debugging Steps`,
                `1. Use \`import_script\` to pull the script to a local file for inspection`,
                `2. Check if the script is enabled with \`list_scripts\``,
                `3. Use \`list_tabs\` to find a tab matching the script's @match pattern`,
                `4. Use \`reload_tab\` on that tab to trigger script injection`,
                `5. Use \`get_console_context\` to capture errors and GM_log output`,
                `6. Use \`get_page_context\` to verify the DOM state`,
                `7. If needed, use \`take_screenshot\` to see the visual result`,
                ``,
                `## Common Issues`,
                `- @match pattern doesn't match the current URL`,
                `- @run-at timing: script runs before target elements exist`,
                `- Missing @grant for GM_* or VM_* APIs used in the script`,
                `- Missing @connect directive for cross-origin GM_xmlhttpRequest calls`,
                `- CSP blocking inline script injection`,
                `- Element selectors changed on the page`,
                ``,
                `Fix any issues found and use \`export_script\` to push updates.`,
              ].join('\n')
            }
          }
        ]
      };
    }
  );

  // ─── Resources ──────────────────────────────────────────────────────

  server.resource(
    'scripts-list',
    'customaise://scripts',
    {
      description: 'Live list of all userscripts managed by Customaise, including their IDs, names, and enabled status.',
      mimeType: 'application/json'
    },
    async (uri) => {
      const result = await bridge.request('list_scripts', {});
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
      // Reuse the import_script bridge command (same logic, avoids duplication)
      const result = await bridge.request('import_script', { scriptId });
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
      description: 'Userscript writing conventions and best practices for Customaise.',
      mimeType: 'text/markdown'
    },
    async (uri) => {
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'text/markdown',
          text: CONVENTIONS_GUIDE
        }]
      };
    }
  );
}

const CONVENTIONS_GUIDE = `# Customaise Userscript Conventions

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
// @grant       VM_findElement
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
    // VM_findElement is our bulletproof DOM selector
    const banner = await VM_findElement('dom_banner_123');
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
| \`@grant\` | Optional | GM_* or VM_* APIs to enable (use \`none\` for no special APIs) |
| \`@run-at\` | Optional | When to inject: \`document-start\`, \`document-end\`, \`document-idle\` (default) |
| \`@connect\` | Optional | Domains allowed for \`GM_xmlhttpRequest\` (e.g., \`api.github.com\`) |
| \`@domId\` | Auto | Auto-managed by Customaise for \`VM_findElement\`. **Do not edit manually.** |
| \`@require\` | Optional | External JS libraries to load before the script |
| \`@resource\` | Optional | Named external resources (CSS, JSON, images) accessible via \`GM_getResourceText/URL\` |
| \`@namespace\` | Recommended | Script namespace. Use \`https://customaise.com\`. |
| \`@author\` | Optional | Script author |

## VM_findElement (Bulletproof DOM Targeting)

Customaise provides a revolutionary multi-tier selector API that guarantees 100% element targeting reliability, surviving UI redesigns and dynamic class changes.

**Usage:**
1. You must declare \`@grant VM_findElement\`
2. Pass a \`dom_*\` ID string (e.g., \`await VM_findElement('dom_1234567890_abc')\`)
3. **Important:** \`dom_*\` IDs are generated by the user using the Customaise DOM selector tooltip. Do not invent your own \`dom_*\` IDs. If creating elements dynamically, use standard \`document.querySelector\`.
4. The function is async and must be awaited.

**VM_findExternalElement:** Works like \`VM_findElement\` but targets elements inside cross-origin iframes. Requires \`@connect\` for the iframe's domain. Usage: \`await VM_findExternalElement('dom_ext_xxx')\`.

## Available GM_* APIs

Customaise supports 22 \`GM_*\` APIs, making it highly compatible with existing Greasemonkey/Tampermonkey scripts. You can use either the classic \`GM_*\` (underscore) or modern \`GM.*\` (promise-based) syntax.

### Environment & Console
| API | Description |
|-----|-------------|
| \`GM_log(msg)\` / \`GM.log(msg)\` | Log to Customaise console (visible via \`get_console_context\` tool) |
| \`GM_info\` / \`GM.info\` | Object containing script metadata |

### Storage (Extension-Scoped)
| API | Description |
|-----|-------------|
| \`GM_setValue(k, v)\` / \`GM.setValue(k, v)\` | Persistent storage (survives page reloads) |
| \`GM_getValue(k, def)\` / \`GM.getValue(k, def)\` | Read from persistent storage |
| \`GM_deleteValue(k)\` / \`GM.deleteValue(k)\` | Delete from persistent storage |
| \`GM_listValues()\` / \`GM.listValues()\` | List all stored keys |
| \`GM_addValueChangeListener(name, cb)\` | Listen for storage changes across tabs |
| \`GM_removeValueChangeListener(id)\` | Remove storage listener |

### DOM & UI
| API | Description |
|-----|-------------|
| \`GM_addStyle(css)\` / \`GM.addStyle(css)\` | Inject CSS into the page |
| \`GM_addElement(tag, attr)\` / \`GM.addElement(tag, attr)\` | Safely create and append DOM elements |
| \`GM_registerMenuCommand(name, fn)\` | Add a command to the Customaise extension menu |
| \`GM_unregisterMenuCommand(id)\` | Remove a menu command |
| \`GM_notification(details)\` / \`GM.notification(details)\` | Show a desktop OS notification |

### Network & Resources
| API | Description |
|-----|-------------|
| \`GM_xmlhttpRequest(details)\` | Cross-origin HTTP requests. **Requires \`@connect\` directive.** |
| \`GM.xmlHttpRequest(details)\` | Promise-based cross-origin HTTP requests |
| \`GM_download(details)\` | Download a file to disk |
| \`GM_getResourceText(name)\` / \`GM.getResourceText(name)\` | Read text content from a \`@resource\` |
| \`GM_getResourceURL(name)\` / \`GM.getResourceUrl(name)\` | Get base64 data URI for a \`@resource\` |

### Tabs & System
| API | Description |
|-----|-------------|
| \`GM_setClipboard(text)\` / \`GM.setClipboard(text)\` | Copy text to OS clipboard |
| \`GM_openInTab(url, options)\` / \`GM.openInTab(url, options)\` | Open a new browser tab |
| \`GM_getTab(cb)\` / \`GM.getTab()\` | Get persistent state for the current tab |
| \`GM_saveTab(obj)\` / \`GM.saveTab(obj)\` | Save persistent state for the current tab |
| \`GM_getTabs(cb)\` / \`GM.getTabs()\` | Get persistent state for all tabs running this script |

## Developer Workflow & Best Practices

1. **Use \`GM_log\` over \`console.log\`:** \`GM_log\` output is explicitly tracked by Customaise and is visible when using the \`get_console_context\` MCP tool.
2. **Cross-Origin Requests:** If your script needs to fetch data from \`api.github.com\`, you MUST include \`// @connect api.github.com\` in the metadata block, or \`GM_xmlhttpRequest\` will fail silently.
3. **Handle Dynamic Pages:** Most modern sites are SPAs (Single Page Applications). Elements may not exist immediately. Use \`VM_findElement\` or \`MutationObserver\` instead of assuming elements are present on load.
4. **Execution Timing:** \`// @run-at document-idle\` is the safest default as it ensures the initial DOM is fully parsed.
`;

