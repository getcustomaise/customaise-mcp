# @customaise/mcp

MCP server that connects AI coding agents to the [Customaise](https://customaise.com) Chrome extension for userscript management, visual DOM targeting, and browser automation.

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

### 3. Done!
Your AI agent can now manage userscripts, visually target DOM elements, inspect browser pages, and take screenshots — all through natural language.

## Available Tools (13)

### Script Lifecycle
| Tool | Description |
|------|-------------|
| `list_scripts` | List all managed userscripts |
| `import_script` | Pull a script to a local file for editing |
| `export_script` | Push a local file to Customaise (validates + installs) |
| `delete_script` | Permanently delete a script |
| `toggle_script` | Enable or disable a script |

### Browser Context
| Tool | Description |
|------|-------------|
| `get_page_context` | DOM snapshot of the current page |
| `get_console_context` | Console logs, errors, and GM_log output |
| `list_tabs` | List all open browser tabs |

### Visual DOM Targeting
| Tool | Description |
|------|-------------|
| `get_selected_elements` | Get DOM elements the user has visually selected in the browser, with bulletproof selectors and screenshots |

### Testing & Verification
| Tool | Description |
|------|-------------|
| `reload_tab` | Reload a tab to re-inject scripts |
| `take_screenshot` | Capture a screenshot of the visible tab with optional element highlighting |

### UI Control
| Tool | Description |
|------|-------------|
| `toggle_ui` | Show or hide the Customaise UI overlay |

### Batch Operations
| Tool | Description |
|------|-------------|
| `sync_scripts` | Bulk export all scripts to a local directory |

## Visual DOM Selection

Users can visually select elements in the browser, and the extension automatically pushes context files to your workspace in real-time:

```
.customaise/dom-context/<script-name>/
├── element-name.dom.md          # Selectors, element context, user comments
├── element-name.screenshot.png  # Cropped screenshot of the selected element
└── ...
```

> [!NOTE] 
> **Where are the files saved?**
> The MCP server writes the `.customaise` folder to its current working directory (usually your open project root in Cursor or Windsurf). 
> If you are using a global IDE like Claude Desktop, it will default to your Home directory (`~/.customaise`). To force the files to save in a specific project folder, add the `CUSTOMAISE_WORKSPACE` environment variable to your MCP config:
> 
> ```json
> "env": { "CUSTOMAISE_WORKSPACE": "/absolute/path/to/your/project" }
> ```

Use `get_selected_elements` to retrieve selections programmatically, or read the auto-pushed `.dom.md` files directly from the workspace.

Each selection includes **bulletproof tiered selectors** (stable IDs → data attributes → ARIA → semantic classes → structural positioning) for resilient element targeting that survives page updates.

## Typical Workflow

```
1. get_page_context       → understand the target page
2. User selects elements  → .dom.md files auto-pushed to workspace
3. Write .user.js file    → AI creates the script using IDE tools
4. export_script          → Customaise validates and installs
5. reload_tab             → re-inject the script
6. get_console_context    → check for errors
7. take_screenshot        → verify visual result (with element highlighting)
```

## File Sync

Use `sync_scripts` to bulk-export all scripts to a local directory:

```
sync_scripts({ directory: "~/customaise-scripts" })
```

This creates:
- **One `.user.js` file per script** — filename is derived from the script name (lowercase, hyphens, e.g. `my-cool-script.user.js`)
- **`.customaise-manifest.json`** — maps filenames to script IDs for round-trip editing

### Manifest format

```json
{
  "dark-mode-fix.user.js": "vm_script_1774225715376_lus75sdzn",
  "my-cool-script.user.js": "vm_script_1774225800123_abc12defg"
}
```

### Round-trip workflow

1. `sync_scripts` → exports all scripts to a directory
2. Edit any `.user.js` file in your IDE
3. `export_script` with the file path + `scriptId` from the manifest → updates the script
4. Omit `scriptId` when calling `export_script` → creates a new script instead

### File watcher (auto-export)

When `sync_scripts` has been called, the MCP server watches the directory for `.user.js` changes. Saving a file in your IDE automatically pushes it to Customaise — no manual `export_script` call needed.

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `CUSTOMAISE_WS_PORT` | `4050` | WebSocket server port |

## Requirements

- **Node.js** ≥ 18
- **Chrome** with the Customaise extension installed
- **MCP Bridge** enabled in Customaise Settings (Power User feature)

## Troubleshooting

**"Customaise extension is not connected"**
- Make sure Chrome is running with the Customaise extension
- Check that MCP Bridge is enabled in extension Settings
- The extension connects automatically within a few seconds

**Port conflict on 4050**
- Set a different port: `CUSTOMAISE_WS_PORT=4051 npx @customaise/mcp`

**Scripts not running after export**
- Call `reload_tab` to trigger script re-injection
- Check `@match` pattern matches the current URL

## License

MIT
