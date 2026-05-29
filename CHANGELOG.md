# Changelog

All notable changes to `@customaise/mcp` will be documented in this file.

## [2.0.7] - 2026-05-28

### Added
- **`CM_promptAI` on-device AI conventions.** New `CM_promptAI` section in both UserScript and AgentScript conventions resources covers the full Phase 1.5 surface shipping alongside this release. When to reach for the user's local Gemini Nano model (Chrome 148+) instead of routing every prompt through the calling IDE agent. The `@grant CM_promptAI` declaration. The bare call (`await CM_promptAI(input, opts?)`) with options (`schema`, `system`, `temperature`, `topK`, `timeoutMs`, `signal`, `omitResponseConstraintInput`). The sub-method surface: `CM_promptAI.availability()`, `CM_promptAI.params()`, `CM_promptAI.warm()`, `CM_promptAI.session(opts?)`, `CM_promptAI.stream(input, opts?)`. The session-instance shape (`.prompt`, `.promptStream`, `.append`, `.clone`, `.measureContextUsage`, `.refresh`, `.destroy`). Multimodal input as a parts array carrying text + image (Blob / ImageBitmap / BufferSource / ArrayBuffer) + audio (Blob / BufferSource). Token-by-token streaming returned as `AsyncIterable<string>` consumed with `for await`. The per-part 4 MB size cap and 16-megapixel ImageBitmap pre-encode guard. The sampling-pair rule (`temperature` and `topK` both-or-neither). The 16-sessions-per-tab cap with 10-minute idle GC. The `'downloadprogress'` event channel via `EventTarget`. The 13 typed error codes (`PROMPT_AI_UNAVAILABLE`, `PROMPT_AI_TIMEOUT`, `PROMPT_AI_SCHEMA_UNSUPPORTED`, `PROMPT_AI_SCHEMA_VIOLATION`, `PROMPT_AI_BAD_INPUT`, `PROMPT_AI_ENCODING`, `PROMPT_AI_CONTEXT_OVERFLOW`, `PROMPT_AI_NETWORK`, `PROMPT_AI_SESSION_GONE`, `PROMPT_AI_SESSION_RECYCLED`, `PROMPT_AI_ABORTED`, `PROMPT_AI_CANCELLED`, `PROMPT_AI_FAILED`). The 25-second default timeout with a 28-second bridge ceiling. A structured-output example using `opts.schema`. The "use it for classification, summarisation, JSON extraction, image and audio description, short multi-turn dialogue. NOT for large code generation or multi-step reasoning" use-case guidance.
- **`GM_cookie` sub-method documentation.** The `GM_cookie` entry now spells out the frozen-object shape (`.list` / `.set` / `.delete`), the `details` argument shape (mirroring `chrome.cookies.getAll`'s filter), the promise + Node-style callback dual-mode contract, and notes the `.store` method as a Firefox-container-specific Tampermonkey method that's stubbed and will reject on Chromium.
- **Bulk storage entries** (`GM_setValues`, `GM_getValues`, `GM_deleteValues`) under the Storage table, marked Tampermonkey v5.3+ parity, with the right argument shapes (object for set, array-or-object for get with defaults, array for delete).
- **`details` shapes for the previously-vague network and UI APIs.** `GM_xmlhttpRequest`, `GM_download`, `GM_notification`, `GM_setClipboard`, `GM_openInTab`, and `GM_getTab` / `GM_saveTab` / `GM_getTabs` now document every field IDE agents would otherwise have to guess (method, url, headers, data, responseType, timeout, onload + callbacks for the network APIs; title, image, highlight, silent, timeout, onclick, ondone for notification; active, insert, setParent for openInTab; the per-tab-vs-extension-wide storage distinction for the tab APIs).

### Changed
- **GM_* table count from 22 to 26.** Adding `GM_cookie` + the three bulk-storage entries brings the documented surface in line with the canonical `SUPPORTED_GRANTS` set in `extension/src/background/services/metadata-schema-normalizer.js`.
- **CM_devtools error code list completed.** Adds `DEBUGGER_PERMISSION_NOT_GRANTED` and clarifies the semantic split with `DEVTOOLS_DISABLED_BY_USER`: the former is the rare "Chrome's `debugger` permission itself is revoked" failure (user fixes via extension reload), the latter is the common "Settings → Scripts → Chrome DevTools Access toggle is OFF" failure (user fixes by flipping the toggle).
- **Paired with extension 1.2.7.** `MIN_EXTENSION_VERSION` stays at `1.2.3` (the v2-bridge-protocol floor, unchanged); the extension's `EXPECTED_MCP_VERSION` constants are bumped to `2.0.7` so the in-extension MCP status surface shows "current" for this release and "update available" for any 2.0.6 client still running.

## [2.0.6] - 2026-05-22

### Changed
- **Public script API renamed `VM_` → `CM_`.** The conventions resources (`customaise://userscript-conventions`, `customaise://agentscript-conventions`) and tool guidance now reference `CM_findElement`, `CM_findExternalElement`, `CM_devtools`, and `CM_withDevtools`. Internal storage keys and wire identifiers are unchanged.
- **`MIN_EXTENSION_VERSION` corrected to `1.2.3`** — the actual extension version that shipped the v2 bridge protocol. The previous `1.4.0` was a stale display string; it never gated the v2 handshake (which keys off `protocolVersion`), so functional behaviour is unchanged. It only affected the "update your extension" message shown to genuinely pre-v2 extensions, which now names the correct version.

### Added
- **Chrome DevTools access conventions.** New `CM_devtools` / `CM_withDevtools` section in both conventions resources: when CDP is the right tool, the `@grant CM_devtools` + `@devtools-justification` requirement, the per-session **Settings → Scripts → Chrome DevTools Access** toggle (off by default, resets every Chrome restart), session lifecycle, usage patterns, and the full error-code table.

## [2.0.5] - 2026-05-15

### Added
- **`take_screenshot` full-page and any-tab capture.** New `fullPage` boolean captures the whole scrollable page in one image. The response now includes `width`, `height` (parsed from the PNG), `captureMode`, and `truncated`. Background and cross-window tabs are captured without stealing OS focus.

### Changed
- **`open_tab` opens in the background by default** (`active: false`). Pass `active: true` to bring the new tab to the foreground. Stops AI agents from snatching the user's current tab while building or testing scripts.
- **`get_page_context` summary** reads `componentsSummary` and `overview.counts` for a richer DOM overview.

## [2.0.4] - 2026-05-15

### Added
- **Claude Desktop `.mcpb` bundle.** New `mcp/mcpb/` build pipeline (manifest, `build.mjs`, README, icon) producing `customaise.mcpb`, so Claude Desktop users install the same bridge that Cursor, Claude Code, and Codex users get through their MCP configs.

## [2.0.3] - 2026-05-13

### Added
- **AgentScript conventions: bare `navigator.modelContext` guidance.** New section in the `customaise://agentscript-conventions` resource telling AI agents to reference `navigator.modelContext` with the bare `navigator` identifier — never `globalThis.navigator.modelContext`, `window.navigator.modelContext`, or `self.navigator.modelContext`. Customaise wraps `navigator.modelContext` per-script with a function-scoped Proxy that enforces user-set Deny overrides, attributes tool-conflict signals to the right scriptId, and surfaces collisions through the Tool Conflict UI badge. Explicit-global lookups skip the lexical scope chain and hit the unwrapped browser navigator, bypassing those semantics. The section also documents a deliberate W3C spec deviation: the wrapper SWALLOWS the `InvalidStateError` throw on duplicate tool registration so multi-conflict UX surfaces all collisions in one pass — scripts that explicitly `try/catch` that error will never see it; rely on the Tool Conflict badge instead. No bridge code change; documentation-only.

## [2.0.2] - 2026-05-05

### Fixed
- **Doubled error prefix in IDE error popups.** Cap-exceeded and other typed errors surfaced in IDEs as `MCP error -32029: MCP error -32029: Daily MCP cap reached…`. The MCP SDK's `McpError` constructor prepends `MCP error <code>:` to the underlying message; when the server threw an `McpError` and the SDK serialized `error.message` over the wire, the client-side SDK prepended the prefix a second time on receipt. The bridge now throws a plain `Error` with `code` and `data` attached so the prefix appears exactly once in IDE error popups.

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
