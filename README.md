# @customaise/mcp

MCP server that connects AI coding agents to the [Customaise](https://customaise.com) Chrome extension. Manage UserScripts, build AgentScripts, call WebMCP tools inside the user's signed-in browser session, select DOM elements visually, and drive tabs directly from your IDE.

**18 tools, 5 resources, WebSocket bridge** between your IDE and a real Chrome session.

```
AI Agent ←(stdio)→ MCP Server ←(WebSocket)→ Customaise Extension
```

## Quick Start

### 1. Install Customaise
Install the [Customaise Chrome extension](https://customaise.com) and enable **MCP Bridge** in Settings.

### 2. Add to your IDE

**Cursor** (`.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "customaise": {
      "command": "npx",
      "args": ["-y", "@customaise/mcp"]
    }
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "customaise": {
      "command": "npx",
      "args": ["-y", "@customaise/mcp"]
    }
  }
}
```

**Windsurf** (`.windsurf/mcp.json`):
```json
{
  "mcpServers": {
    "customaise": {
      "command": "npx",
      "args": ["-y", "@customaise/mcp"]
    }
  }
}
```

**Kiro** (`.kiro/mcp.json`):
```json
{
  "mcpServers": {
    "customaise": {
      "command": "npx",
      "args": ["-y", "@customaise/mcp"]
    }
  }
}
```

**Codex** (`~/.codex/config.toml`):
```toml
[mcp_servers.customaise]
command = "npx"
args = ["-y", "@customaise/mcp"]
```

**Antigravity** (`mcp_config.json`):
```json
{
  "mcpServers": {
    "customaise": {
      "command": "npx",
      "args": ["-y", "@customaise/mcp"]
    }
  }
}
```

### 3. Done
Your agent can now read and edit UserScripts, build AgentScripts that expose WebMCP tools to it, select DOM elements visually, inspect the console, and take screenshots of the live tab.

## Tools (18)

### Script Lifecycle
| Tool | Description |
|------|-------------|
| `list_scripts` | List every script (UserScripts and AgentScripts) managed by the extension |
| `import_script` | Pull a script to a local file for editing |
| `export_script` | Push a local file to Customaise (validates and installs) |
| `delete_script` | Permanently delete a script |
| `toggle_script` | Enable or disable a script |

### Browser Context
| Tool | Description |
|------|-------------|
| `get_page_context` | DOM snapshot of the current page |
| `get_console_context` | Console logs, errors, and `GM_log` output |
| `list_tabs` | List all open browser tabs |

### Tab Control
| Tool | Description |
|------|-------------|
| `open_tab` | Open a new tab at a given URL |
| `close_tab` | Close a tab by ID |
| `focus_tab` | Switch focus to a tab by ID |
| `reload_tab` | Reload a tab to re-inject scripts |

### Visual DOM Targeting
| Tool | Description |
|------|-------------|
| `get_selected_elements` | Get the DOM elements the user has visually selected, with bulletproof selectors and screenshots |
| `take_screenshot` | Capture the visible tab, optionally highlighting specific elements |

### WebMCP Agent Tools
| Tool | Description |
|------|-------------|
| `list_webmcp_tools` | List the WebMCP tools currently registered on a tab by AgentScripts |
| `call_webmcp_tool` | Call a WebMCP tool; prompt-gated tools block on user consent (see below) |

### UI Control & Batch
| Tool | Description |
|------|-------------|
| `toggle_ui` | Show or hide the Customaise UI overlay |
| `sync_scripts` | Bulk export all scripts to a local directory |

## Resources (5)

Five resources any connected agent can read via `resources/read`. The two conventions handbooks define exactly how Customaise expects UserScripts and AgentScripts to be written. Agents should read the relevant handbook before touching a script.

| URI | Description |
|-----|-------------|
| `customaise://scripts` | Live JSON list of every script the extension manages (ID, name, enabled state, match patterns, shared flag) |
| `customaise://scripts/{scriptId}` | Full source and metadata for a specific script |
| `customaise://conventions` | Points at the right handbook for the script type you're working on |
| `customaise://userscript-conventions` | Full UserScript reference: file structure, IIFE pattern, `GM_*` APIs, symbol-level editing, `@match` and `@namespace` rules |
| `customaise://agentscript-conventions` | Full AgentScript reference: the `// ==AgentScript==` block, `// @webmcp <tool> <permission>` declarations, `navigator.modelContext.registerTool()`, consent model |

## WebMCP Tool Calls & Consent (HITL)

AgentScripts register tools on web pages via `navigator.modelContext.registerTool(...)`. Each tool is declared in the AgentScript's `// @webmcp <toolName> <permission>` header with one of three permissions:

- **`allow`**: tool executes immediately. ~50 to 100ms round-trip per call (the extension still runs permission checks).
- **`prompt`**: every call surfaces an in-browser consent modal and blocks until the user approves or denies. Up to **5 minutes**. Design for this. Don't chain prompt-gated calls in tight loops, and treat a long `call_webmcp_tool` as normal.
- **`deny`**: tool is suppressed and calls fail immediately.

"Always allow" and "Always deny" buttons on the consent modal persist the decision per-script per-tool until the user resets it in extension Settings. These overrides live in `chrome.storage.local` on the user's device; the MCP server has no visibility into them.

### Remote approvals (optional)

If the user has Power User and has enabled Remote HITL Approvals on their Customaise account page, prompt-gated calls are also mirrored there. They can approve or deny from any signed-in browser, including a phone. Either the extension modal or the remote surface can resolve; first signed decision wins. From the MCP client's perspective this is transparent: `call_webmcp_tool` simply returns the result when any authorised surface approves, or an error if denied or timed out.

### What MCP clients see

- A prompt-gated `call_webmcp_tool` response may take up to 5 minutes. Surface a pending state to the end user rather than timing out aggressively.
- If the user denies, `call_webmcp_tool` returns an error. The MCP server does not retry.
- Tool-call arguments transit HTTPS in plaintext to our backend and land **KMS-encrypted at rest** in Firestore. Metadata (toolName, scriptName, origin) stays plaintext. See the Customaise [Privacy Policy](https://customaise.com/privacy).

## Visual DOM Selection

Users can visually select elements in the browser, and the extension pushes context files to your workspace in real time:

```
.customaise/dom-context/<script-name>/
├── element-name.dom.md          # Selectors, element context, user comments
├── element-name.screenshot.png  # Cropped screenshot of the selected element
└── ...
```

> [!NOTE]
> **Where are the files saved?**
> The MCP server writes `.customaise/` to its current working directory (usually your project root in Cursor or Windsurf).
> If you are using a global IDE like Claude Desktop, it defaults to your home directory (`~/.customaise/`). To force a specific project folder, set `CUSTOMAISE_WORKSPACE` in your MCP config:
>
> ```json
> "env": { "CUSTOMAISE_WORKSPACE": "/absolute/path/to/your/project" }
> ```

Use `get_selected_elements` to retrieve selections programmatically, or read the pushed `.dom.md` files directly from the workspace.

Each selection includes **bulletproof tiered selectors** (stable IDs → data attributes → ARIA → semantic classes → structural positioning) so targeting survives page updates.

## Workflows

### UserScript

```
1. get_page_context       → understand the target page
2. User selects elements  → .dom.md files auto-pushed to workspace
3. Write .user.js file    → AI writes the script using IDE tools
4. export_script          → Customaise validates and installs
5. reload_tab             → re-inject the script
6. get_console_context    → check for errors
7. take_screenshot        → verify the visual result
```

### AgentScript

```
1. Read customaise://agentscript-conventions   → get the structure right before writing
2. get_page_context                            → find stable selectors on the target page
3. Write .agent.js file                        → declare tools via // @webmcp, register with navigator.modelContext.registerTool()
4. export_script                               → Customaise validates and injects
5. reload_tab                                  → the AgentScript registers its tools in the page
6. list_webmcp_tools                           → confirm tools surfaced
7. call_webmcp_tool                            → invoke one; prompt-gated calls wait for user consent
```

## File Sync

Use `sync_scripts` to bulk-export every script to a local directory:

```
sync_scripts({ directory: "~/customaise-scripts" })
```

This creates:
- **One `.user.js` file per script.** Filename is derived from the script name (lowercase, hyphens, e.g. `my-cool-script.user.js`).
- **`.customaise-manifest.json`**: maps filenames to script IDs for round-trip editing.

### Manifest format

```json
{
  "dark-mode-fix.user.js": "vm_script_1774225715376_lus75sdzn",
  "my-cool-script.user.js": "vm_script_1774225800123_abc12defg"
}
```

### Round-trip

1. `sync_scripts` exports all scripts to a directory.
2. Edit any `.user.js` file in your IDE.
3. `export_script` with the file path and `scriptId` from the manifest updates that script.
4. Omit `scriptId` when calling `export_script` to create a new script instead.

### File watcher (auto-export)

Once `sync_scripts` has been called, the MCP server watches the directory for `.user.js` changes. Saving a file in your IDE pushes it to Customaise automatically, no manual `export_script` needed.

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `CUSTOMAISE_WS_PORT` | `4050` | WebSocket server port |
| `CUSTOMAISE_MCP_EXTRA_EXTENSION_IDS` | _(empty)_ | Comma-separated list of extra extension IDs allowed to connect. Needed for unpacked dev builds with a non-standard extension ID |
| `CUSTOMAISE_MCP_ALLOW_INSECURE` | _(unset)_ | Set to `1` to disable the origin allowlist. **Tests only.** Emits a loud warning at startup |
| `CUSTOMAISE_WORKSPACE` | _(cwd)_ | Absolute path where `.customaise/` files should be written. Useful for IDEs that don't set cwd to the project root (Claude Desktop, Antigravity) |

## Security Boundary

The MCP server listens on `ws://localhost:4050` in plaintext on your loopback interface. The connection is authenticated by an **HTTP Origin header allowlist**:

- **Allowed**: `chrome-extension://anmpijcpaobaabcdncjjmnhdeibipmko` (production) and `chrome-extension://ijjaffggglamocdapoihpkcpealflopp` (staging). Chrome stamps this header automatically on WebSocket handshakes from extension service workers; you don't configure anything.
- **Rejected**: regular web pages (`https://...`), unknown extension IDs, and handshakes with no Origin header. Returns HTTP 403.

**What this stops**: a malicious webpage opening `new WebSocket('ws://localhost:4050')` and calling WebMCP tools behind your back. This is the most likely abuse vector.

**What this does NOT stop**: a malicious native process running as your user. Node's `ws` client (and most HTTP libraries) lets callers forge any Origin header. If you can't trust processes running as your OS user, the threat model is already broader than this bridge.

**Defense in depth**: every `prompt`-permissioned tool still requires your explicit approval in the Customaise consent modal before running. Tools declared `allow` run without asking, so only install AgentScripts from sources you trust.

**Dev builds**: if you load an unpacked extension with a custom key, set `CUSTOMAISE_MCP_EXTRA_EXTENSION_IDS=<your-extension-id>` in the MCP server's env.

## Requirements

- **Node.js** ≥ 18
- **Chrome** with the Customaise extension installed
- **MCP Bridge** enabled in Customaise Settings (Power User feature)

## Troubleshooting

**"Customaise extension is not connected"**
- Make sure Chrome is running with the Customaise extension.
- Check that MCP Bridge is enabled in extension Settings.
- The extension connects automatically within a few seconds.

**Port conflict on 4050**
- Set a different port: `CUSTOMAISE_WS_PORT=4051 npx @customaise/mcp`.

**Scripts not running after export**
- Call `reload_tab` to trigger script re-injection.
- Check the `@match` pattern covers the current URL.

**`call_webmcp_tool` hangs for minutes**
- The tool is `prompt`-gated. The user has to approve in the browser, or remotely if Remote HITL Approvals is on. 5-minute budget before auto-deny. Surface a pending state rather than timing out.

**`call_webmcp_tool` returned an error like "consent denied"**
- Expected when the user denied the modal, the 5-minute budget expired, or a previous "Always deny" override was set on that tool. The user can reset per-tool overrides in extension Settings.

**`list_webmcp_tools` returns empty after a reload**
- Walk the conventions handbook's troubleshooting checklist. Most common: the global AgentScripts toggle in Customaise Settings is off, or the `@match` pattern doesn't cover the URL. See `customaise://agentscript-conventions` for the full list.

## License

MIT
