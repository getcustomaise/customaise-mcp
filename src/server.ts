import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExtensionBridge } from './extension-bridge.js';
import { FileWatcher } from './file-watcher.js';

/**
 * Register all MCP tools with the server.
 */
export function registerTools(server: McpServer, bridge: ExtensionBridge, fileWatcher?: FileWatcher): void {

  // ─── Script Lifecycle ───────────────────────────────────────────────

  server.tool(
    'list_scripts',
    'List all userscripts managed by Customaise. Returns each script\'s ID, name, enabled status, URL match patterns, and description. Use this to discover available scripts before importing or modifying them.',
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
    'Import an existing userscript from Customaise to a local file for editing. The file will include the full source code with metadata block. After editing the file with your IDE tools, use export_script to push changes back to Customaise.',
    {
      scriptId: z.string().describe('The ID of the script to import (get from list_scripts)'),
      filePath: z.string().describe('Local file path to write the script to (e.g., ./scripts/my-script.user.js)')
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
    'Export a userscript from a local file into Customaise. The file will be validated through Customaise\'s sanitization pipeline (syntax checking, AST validation, security analysis). If valid, the script is installed and ready to execute on matching pages. If invalid, detailed diagnostics explain exactly what to fix. Pass scriptId to update an existing script instead of creating a new one.',
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
    'Permanently delete a userscript from Customaise. This action cannot be undone.',
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

  server.tool(
    'get_page_context',
    'Get a DOM snapshot of the current page including URL, title, page structure, and visible elements. Use this to understand the page layout before writing userscripts that manipulate it.',
    {
      tabId: z.number().optional().describe('Tab ID to inspect. Defaults to the active tab.')
    },
    async ({ tabId }) => {
      const result = await bridge.request('get_page_context', { tabId });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  server.tool(
    'get_console_context',
    'Get console logs from the browser, including errors, warnings, and userscript GM_log output. Use after reload_tab to check for script runtime errors. Logs include userscript-specific entries by default.',
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

      // Apply level filter client-side — ConsoleContextService returns
      // pre-structured arrays (errors, warnings, userscriptLogs).
      if (level && level !== 'all') {
        const filtered: Record<string, unknown> = { ...result };
        if (level === 'error') {
          delete filtered.warnings;
          delete filtered.userscriptLogs;
        } else if (level === 'warn') {
          delete filtered.errors;
          delete filtered.userscriptLogs;
        } else if (level === 'info' || level === 'debug') {
          delete filtered.errors;
          delete filtered.warnings;
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(filtered, null, 2)
          }]
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2)
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
    'Bulk export all scripts from Customaise to a local directory as individual .user.js files. Creates a .customaise-manifest.json mapping filenames to script IDs. Use this to set up a local workspace for editing scripts with your IDE.',
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
                `1. Include a proper metadata block with @name, @match, @description, @version, and @grant directives`,
                `2. Use @match ${targetUrl}`,
                `3. Wrap the script in an IIFE containing named functions (required for symbol-level editing via Customaise)`,
                `4. If making cross-origin requests, include the @connect directive`,
                `5. Use GM_log for debug output (it appears in Customaise's console context)`,
                `6. Handle edge cases (element not found, page still loading, etc.)`,
                ``,
                `## Workflow`,
                `1. Use \`get_page_context\` to understand the page structure`,
                `2. Write the script code`,
                `3. For targeting existing page elements, consider using \`VM_findElement\` with \`dom_*\` IDs from \`get_page_context\` for bulletproof selector resilience`,
                `4. Use \`export_script\` to install it in Customaise (it will be validated through the sanitization pipeline)`,
                `5. Use \`reload_tab\` to test it`,
                `6. Use \`get_console_context\` to check for errors or GM_log output`,
                `7. If there are issues, fix and re-export`,
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
| \`@namespace\` | Optional | Script namespace (used for de-duplication with imported scripts) |
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

