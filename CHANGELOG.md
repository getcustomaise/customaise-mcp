# Changelog

All notable changes to `@customaise/mcp` will be documented in this file.

## [2.0.1] - 2026-05-05

### Fixed
- **Documentation only.** The 2.0.0 release notes referenced "Customaise extension 1.4.0 or newer" as the v2 bridge cutoff. The actual cutoff is **1.2.3**, which is the version that ships the v2 bridge to the Chrome Web Store. README and CHANGELOG corrected. No code change.

## [2.0.0] - 2026-05-05

### Added
- **Free tier with caps.** MCP Bridge is now free for any signed-in Customaise user. Free use is capped at **50 successful tool calls per UTC day** and **150 per rolling 7-day window**. Power User unlocks unlimited. The cap covers every successful tool dispatch (built-in tools and WebMCP calls alike); failed calls and protocol-level traffic do not count toward it.
- **Sign-in required.** The bridge no longer accepts anonymous sessions. Sign in to Customaise from the extension popup before adding the MCP server to your IDE config.
- **New JSON-RPC error codes** in the implementation-defined slot, returned with structured `data` payloads so IDEs can render rich messages:
  - `-32028 MCP_AUTH_REQUIRED`. Sign in to Customaise from the extension popup.
  - `-32029 MCP_CAP_EXCEEDED`. Free cap reached. `data` carries `scope`, `used`, `limit`, `resetAt` so the IDE can show when access resumes.
  - `-32030 MCP_DISPATCH_TIMEOUT`. Extension did not ack within the configured window (default 90s, override via `CUSTOMAISE_MCP_DISPATCH_TIMEOUT_MS`).
  - `-32031 MCP_EXTENSION_OUTDATED`. Update Customaise from the Chrome Web Store.
  - `-32032 MCP_INTEGRITY_VIOLATION`. Reconnect MCP from the Customaise extension Settings.

### Changed (breaking)
- **v2 bridge protocol.** The WebSocket frames between the MCP server and the Customaise extension changed shape. **This MCP server requires Customaise extension 1.2.3 or newer.** Older extensions return `-32031 MCP_EXTENSION_OUTDATED` on first dispatch.
- **Server version reported on the MCP handshake** is now `2.0.0`.

### Compatibility
- Requires Customaise extension 1.2.3 or newer.
- No change to `.cursor/mcp.json` / `.windsurf/mcp.json` / `claude_desktop_config.json` / Codex / Antigravity / Kiro configs. Existing IDE configs continue to work unchanged.

## [1.3.0] - 2026-04-23

### Added
- **Multi-IDE support.** Run `customaise-mcp` from more than one IDE at the same time (e.g. Cursor + Claude Code, or Antigravity + Windsurf). Previously a second instance exited with "MCP error -32000: Connection closed" because port 4050 was already taken; now the second instance automatically routes through the first and both IDEs can use the Customaise extension concurrently.
- **Connected-IDE visibility in the extension.** The Customaise sidebar (Settings → Developer Tools) now shows which MCP version is connected and which IDEs are using it — useful to confirm the right agent is wired in before issuing commands.

### Security
- **Loopback-only WebSocket bridge.** WS handshakes from non-loopback addresses are rejected at 403. Closes a narrow LAN-peer probing path. No compat impact — the extension and MCP client both connect via localhost.
- **Handshake validation on the second MCP instance.** If the second instance finds port 4050 held by something that isn't `customaise-mcp`, it fails fast with a clear error instead of hanging.

### Compatibility
- No MCP-client-side contract changes. Existing `.cursor/mcp.json` / `.windsurf/mcp.json` / etc. configs continue to work unchanged.
- Requires Customaise extension 1.3.0+ to see the new connected-IDE panel; older extensions still work with this MCP but won't render the version/client list.

## [1.2.0] - 2026-04-19

### Added
- **WebMCP agent tools** (2 tools): `list_webmcp_tools` and `call_webmcp_tool`. AgentScripts can now register tools on web pages via `navigator.modelContext.registerTool(...)`, callable from your IDE through the MCP bridge.
- **Tab control** (3 tools): `open_tab`, `close_tab`, `focus_tab`. Tool count is now **18** (was 13).
- **AgentScript conventions resource**: `customaise://agentscript-conventions` with the full reference for declaring and registering WebMCP tools.
- `CHANGELOG.md` and `LICENSE` now ship in the tarball.

### Changed (behavior MCP clients should know about)
- **`call_webmcp_tool` can block for up to 5 minutes** when the tool is declared with the `prompt` permission in the AgentScript `@webmcp` header. The Customaise extension surfaces an in-browser consent modal, and the tool body only runs if the user approves. Previously, tool calls were fire-and-forget; this is a **user-visible latency change** for any client that invokes prompt-gated tools. Surface a pending state to the end user rather than timing out aggressively.
- **"Always allow / Always deny"** persists per-script per-tool on the user's device, so subsequent identical calls may run without showing a modal. Transparent to the MCP client.
- **Remote HITL approvals (optional, user opt-in)**: if the user has Power User and has enabled Remote HITL Approvals on their account page, prompt-gated calls are also mirrored there. No MCP-client-side change; the tool simply returns whenever any authorised surface resolves.
- **Server-reported version now tracks `package.json`.** Previously the MCP handshake hardcoded `1.0.3` and drifted silently. The number IDE clients see is now the same as the published version.
- **`prompts` capability removed from the initialize handshake.** The server never registered any prompts, so advertising `prompts: {}` led clients to list an empty collection. If prompts ship later they will be added back alongside `server.prompt(...)` registrations.

### Security
- **WebSocket bridge enforces an Origin allowlist.** Only connections from Chrome extension service workers with the known Customaise extension IDs are accepted. A malicious webpage can no longer open `new WebSocket('ws://localhost:4050')` and issue tool calls behind the user's back. See the README "Security Boundary" section for the threat model and the `CUSTOMAISE_MCP_EXTRA_EXTENSION_IDS` / `CUSTOMAISE_MCP_ALLOW_INSECURE` env vars for dev and test flexibility.
- **Tool-call arguments are KMS-encrypted at rest** in Firestore when remote approvals are enabled. Metadata (toolName, scriptName, origin, timestamps) stays plaintext, matching the sensitivity tier of billing records. Arguments transit HTTPS in plaintext to the backend, then encrypt before persistence.
- No MCP client-side secrets, cookies, or session tokens cross the bridge. Tool calls run inside the user's browser session; the MCP server only initiates them.

## [1.1.1] - 2026-03-29

### Fixed
- Documented `CUSTOMAISE_WORKSPACE` for IDEs that don't set cwd to the project root (Claude Desktop, Antigravity).
- Clarified where `.customaise/dom-context/` files are saved in the README.

## [1.1.0] - 2026-03-29

### Added
- **Visual DOM Targeting** (1 tool): `get_selected_elements` retrieves user-selected DOM elements with bulletproof tiered selectors and cropped screenshots.
- **Real-time DOM context push**: when MCP is connected, `.dom.md` files and element screenshots are pushed to the workspace as the user selects elements in the browser.
- **Screenshot element highlighting**: `take_screenshot` now supports optional high-contrast red element highlighting for visual debugging.

### Fixed
- **Screenshot reliability**: hardened the capture pipeline with a defensive retry mechanism and pre-injection of content scripts to eliminate race conditions.
- **Message queueing**: MCP commands are queued via the onboarding queue if the React UI hasn't finished initializing, preventing silently dropped messages on fresh tabs.

### Changed
- Added Kiro to the supported IDE list in description and README.
- Added `kiro` and `antigravity` npm keywords for discoverability.
- Updated tool count from 12 to 13 in README.

## [1.0.1] - 2026-03-23

### Fixed
- Corrected repository URL in package metadata.

## [1.0.0] - 2026-03-23

### Added
- **Script Lifecycle** (5 tools): `list_scripts`, `import_script`, `export_script`, `delete_script`, `toggle_script`.
- **Browser Context** (3 tools): `get_page_context`, `get_console_context`, `list_tabs`.
- **Testing & Verification** (2 tools): `reload_tab`, `take_screenshot`.
- **UI Control** (1 tool): `toggle_ui`.
- **Batch Operations** (1 tool): `sync_scripts` with `.customaise-manifest.json` mapping.
- **File Watcher**: auto-exports `.user.js` files on save with a 500ms debounce.
- **MCP Resources**: `customaise://scripts`, `customaise://scripts/{id}`, `customaise://conventions`.
- **Rich validation feedback**: structured diagnostics from the Customaise sanitization pipeline.
- **Cross-platform `take_screenshot`**: uses `os.tmpdir()` for auto-generated paths.
- **Console log filtering**: client-side `level` parameter for `get_console_context`.
- **Filename collision handling**: deduplication in `sync_scripts` bulk export.
