# @customaise/mcp

MCP server and CLI that connect AI coding agents to the [Customaise](https://customaise.com) Chrome extension. Manage UserScripts, build AgentScripts, call WebMCP tools inside the user's signed-in browser session, select DOM elements visually, and drive tabs. Drive it over stdio from an IDE, or as a `customaise` command from a shell.

**19 tools, 5 resources, WebSocket bridge** between your agent and a real Chrome session, whichever door it arrives through.

Two ways in. `customaise-mcp` is the MCP server an IDE spawns over stdio.
`customaise` is a CLI for agents that have a shell instead, driving the same
tools through a resident daemon. Both go through the same cap enforcement and
the same consent gate.

```
AI Agent ←(stdio)→ MCP Server ←(WebSocket)→ Customaise Extension
```

Speaks the **MCP 2026-07-28 revision**, negotiated per connection: a client on
that revision gets the stateless flow with cacheable `tools/list`, and a client
on the 2025 revisions keeps working unchanged. The package is 3.x precisely so
nobody has to guess this from a 2.x version number.

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

**Claude Code** (one command, no file to edit):
```bash
claude mcp add customaise -- npx -y @customaise/mcp
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

## Tools (19)

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
| `take_screenshot` | Capture any tab (not just the visible one) as a viewport or full-page image |

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

### Diagnostics
| Tool | Description |
|------|-------------|
| `get_bridge_status` | Report extension attachment, plan tier, sign-in, and remaining daily and weekly quota. Costs no quota itself. |

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

> [!NOTE]
> **From the CLI**, the directory you ran the command in wins over both. The
> daemon is long-lived and was started from whatever directory you happened to
> be in the first time, so it takes the caller's word for it on every command.
> `CUSTOMAISE_WORKSPACE` still beats a plain cwd for IDE servers, unchanged.


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
| `CUSTOMAISE_CONFIG_DIR` | `~/.config/customaise` | Where the CLI keeps its daemon connection file and remembered tab. Delete this directory to remove everything the CLI stores; uninstalling the extension does not, because these live outside the browser profile |
| `CUSTOMAISE_HTTP_PORT` | `4051` | Loopback port the daemon serves the CLI on. Distinct from `CUSTOMAISE_WS_PORT`, which is the extension's WebSocket bridge |
| `CUSTOMAISE_MCP_OUTPUT` | `file` | Where `get_page_context`, `get_console_context` and `take_screenshot` put their full payload when the call does not say. `file` writes to disk and returns a summary plus the path; `inline` writes nothing and returns the whole payload (for the screenshot, the image itself) in the response. Set this to `inline` for a client with no filesystem tool. See [Chat clients and file-less agents](#chat-clients-and-file-less-agents) |
| `CUSTOMAISE_MCP_INLINE_MAX_KB` | `64` | Ceiling on an inline JSON payload. Over it, lists are shortened (never the JSON itself, so it still parses) and the response reports exactly what was dropped |
| `CUSTOMAISE_MCP_INLINE_IMAGE_MAX_KB` | `1536` | Ceiling on an inline `take_screenshot` image, in KB of base64. Over it the capture is saved to a file instead, because half an image is not an image |

## Chat clients and file-less agents

`get_page_context`, `get_console_context` and `take_screenshot` spool their
full payload to a file by default and hand back a summary plus a path. That is the right shape
for an IDE agent: a DOM snapshot is routinely hundreds of KB and belongs on
disk rather than in a context window.

It is a dead end for a chat client. Claude Desktop runs this server over
stdio, so the write succeeds, but the model on the other end has no
filesystem tool with which to open what was written. It receives a path it
can never read.

Three ways out, in the order they are consulted:

1. **Per call.** Pass `output: "inline"` and the full payload comes back in
   the response, with nothing written to disk. All three tools say so in their
   own descriptions and in every file-mode response, so an agent that hits the
   dead end can recover on its own in one extra call.
2. **Per install.** Set `CUSTOMAISE_MCP_OUTPUT=inline` in the server's env.
   The `.mcpb` bundle ships with this set, because that bundle is installed
   into Claude Desktop and nowhere else. For an IDE, put it in the `env`
   block of your MCP config. For the CLI, exporting it in your shell is
   enough: the `customaise` binary reads it and forwards it per call, so it
   does not matter that the resident daemon was started earlier without it.
3. **Default.** `file`, unchanged.

`take_screenshot` is the same flag with a different payload: `output: "inline"`
attaches the capture to the response as an MCP image block rather than writing
a PNG and returning its path, so a multimodal chat client can actually see it.
An image cannot be shortened the way a snapshot can, so a capture over
`CUSTOMAISE_MCP_INLINE_IMAGE_MAX_KB` (1536 KB of base64) falls back to a file
and tells the caller to retry with `fullPage: false`, which is usually small
enough, or to raise the ceiling.

Inline JSON responses are capped at `CUSTOMAISE_MCP_INLINE_MAX_KB` (64 KB by
default). Over the cap the payload is shortened by trimming lists, not by
truncating the JSON text, so what arrives still parses and still has every
key and nesting level. The response carries `truncated: true` and an
`omitted` array naming each shortened list and how many items it lost.

There is deliberately no client detection here. `clientInfo.name` is a
guessing game, and the `roots` capability says the client declares project
directories, not that the model can read them. It is also unavailable on
2026-07-28 connections. An explicit flag with a self-advertising
fallback beats a heuristic that is confidently wrong.

## Publishing the public mirror

This package is developed in a private monorepo and mirrored to
[getcustomaise/customaise-mcp](https://github.com/getcustomaise/customaise-mcp),
which is what `package.json` `repository` points at and what MCP scanners
and directories read. Keep them in step with the sync script rather than by
hand: the previous hand-copy shipped 7 of 21 source files, so the published
repo did not compile and carried none of the test suites.

```bash
npm run mirror:plan                     # what would be published, as JSON
npm run mirror:verify -- ../customaise-mcp   # drift report, exit 1 if adrift
npm run mirror:apply  -- ../customaise-mcp   # copy the plan over a checkout
```

`mirror:apply` writes into a clone, deletes files this package no longer
ships, and leaves the repo's own `.github/` furniture alone. It never
pushes. Review `git diff` in the checkout and push yourself.

The plan is built from `git ls-files`, so anything uncommitted is invisible
to it. The script refuses to run while untracked files exist under `mcp/`
rather than publishing a tree that is missing them. `src/__tests__/public-mirror.test.ts`
guards the shape of the plan in CI; the drift check needs a checkout and so
stays a release step.

## Security Boundary

The MCP server listens on `ws://localhost:4050` in plaintext on your loopback interface. The connection is authenticated by an **HTTP Origin header allowlist**:

- **Allowed**: `chrome-extension://anmpijcpaobaabcdncjjmnhdeibipmko` (production) and `chrome-extension://ijjaffggglamocdapoihpkcpealflopp` (staging). Chrome stamps this header automatically on WebSocket handshakes from extension service workers; you don't configure anything.
- **Rejected**: regular web pages (`https://...`), unknown extension IDs, and handshakes with no Origin header. Returns HTTP 403.

**What this stops**: a malicious webpage opening `new WebSocket('ws://localhost:4050')` and calling WebMCP tools behind your back. This is the most likely abuse vector.

**What this does NOT stop**: a malicious native process running as your user. Node's `ws` client (and most HTTP libraries) lets callers forge any Origin header. If you can't trust processes running as your OS user, the threat model is already broader than this bridge.

**Defense in depth**: every `prompt`-permissioned tool still requires your explicit approval in the Customaise consent modal before running.

Tools declared `allow` run without asking, with one exception that matters here: **a script written through this bridge or the `customaise` CLI does not get to grant itself `allow`.** Its self-declared `allow` resolves as `prompt`, so the first call shows you what the agent built. Choosing "Always allow" stores an override and it never prompts again. An agent that could clear its own gate would not be gated, and the whole point of the consent modal is that it lives somewhere the calling agent cannot reach.

Scripts you wrote yourself, and scripts you subscribed to from the marketplace, are unaffected: `allow` means `allow`. For marketplace scripts that means the old advice still holds, so only subscribe to AgentScripts from sources you trust.

**Dev builds**: if you load an unpacked extension with a custom key, set `CUSTOMAISE_MCP_EXTRA_EXTENSION_IDS=<your-extension-id>` in the MCP server's env.

## CLI

For an agent with a terminal rather than an MCP client.

```sh
npm i -g @customaise/mcp     # both binaries on PATH
customaise doctor            # bridge, sign-in, tier, quota, and whether
                             # "Allow user scripts" is on. Costs no quota.
customaise init              # writes AGENTS.md in this project, so the next
                             # agent finds the CLI without being told
```

```sh
customaise scripts list
customaise scripts install ./my-tool.agent.js
customaise scripts get mcp_script_123 -o ./my-tool.agent.js
customaise scripts enable mcp_script_123      # or disable
customaise scripts fork shared_abc -o ./mine.agent.js
customaise scripts rm mcp_script_123
customaise sync ./customaise-scripts          # bulk export your scripts
customaise tabs
customaise tab reload 42
customaise use --tab 42                      # remember it for later commands
customaise tools                             # WebMCP tools on that tab
customaise call my_tool --args '{"q":"hi"}'
customaise context page                      # DOM snapshot
customaise shot -o ./page.png
customaise daemon status | stop
```

Without a global install, `npx -p @customaise/mcp customaise <verb>` works but
costs roughly half a second of package resolution per command against about
fifty milliseconds installed. For anything in a loop, install it.

**Output contract.** JSON on stdout, always, so it pipes. Diagnostics on
stderr. `--pretty` indents the JSON. Exit codes are the interface:

| Code | Meaning |
|---|---|
| 0 | success |
| 2 | usage error |
| 3 | daemon or extension unreachable, including after signing out or with "Allow user scripts" off |
| 4 | signed in, but the token expired or could not be refreshed |
| 5 | free-tier cap reached |
| 6 | consent denied by the user |
| 7 | consent expired unanswered |
| 8 | rejected by Customaise (diagnostics in the payload) |

Two things make `3` more common than it looks. Signing out of Customaise tears
the bridge down deliberately, so it reports `3`, not `4`. And the "Allow user
scripts" toggle on the Customaise card in `chrome://extensions` resets on every
Chrome restart; while it is off, scripts install fine and no tool ever
registers, so `doctor` reports `3` rather than claiming a healthy setup that
cannot run anything. `4` is the narrower case: the bridge is up and the token behind
it went stale. Both mean stop, and both are worth telling the user about, but
only `3` is worth checking Chrome over.

Codes 5, 6 and 7 are deliberately distinct: an agent that cannot tell a cap
from a refusal from a timeout retries into a wall. Code 8 is the one to
handle first when installing scripts: the sanitization pipeline refused the
file and the diagnostics say what to change, where a 1 means something broke
and rewriting the script will not help.

**The daemon.** Started on first use, and it holds the WebSocket to the
extension so commands do not each pay for a reconnect. It binds `127.0.0.1`
only and authenticates the CLI with a token in a `0600` file that exists only
while the endpoint is live. `customaise daemon stop` ends it.

When several customaise-mcp processes share a machine, the first to bind
`:4050` leads and the rest relay through it, so one extension serves every
IDE and every shell at once. That seam carries its own protocol version: a
process built against different frames is refused rather than served, with an
error naming both versions and which one to restart (`-32033`). Package
versions may differ freely; only a change to the frames themselves moves it.

## Requirements

- **Node.js** ≥ 20
- **Chrome** with the Customaise extension installed (≥ 1.2.3 for the v2 bridge protocol; older extensions still work but don't surface the cap-usage display)
- **MCP Bridge** enabled in Customaise Settings (free, signed-in)

## Plan tiers

The MCP Bridge is free for any signed-in Customaise user. Free use is capped at **50 calls per UTC day** and **150 calls per rolling 7-day window**. **Power User** unlocks unlimited MCP. The cap covers every successful tool dispatch (built-in tools and WebMCP calls alike); failed calls and protocol-level traffic don't count.

When the cap fires, the server returns a JSON-RPC error in the implementation-defined `-32029` slot with a human-readable message + structured `data` carrying scope, used/limit, and reset timestamp. IDEs that surface tool errors render the message verbatim. Sign-in is required regardless of tier; without a fresh Firebase ID token the server returns `-32028 MCP_AUTH_REQUIRED`.

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
