# Changelog

All notable changes to `@customaise/mcp` will be documented in this file.

## [3.2.3] - 2026-09-10

More reliable script saves and CLI connections, with progress and recovery information when a request is interrupted.

### Fixed

- **Script-save progress and cancellation.** Saves report their operation ID and preparation stage. Timeouts and client cancellation reach the owned request through both leader and follower processes. With extension 1.3.4, the deadline includes queueing and document setup, and delayed older saves cannot overwrite newer work.
- **Stale edits and uncertain save results.** `import_script` returns a source hash; `export_script` accepts `expectedCodeHash` to reject an edit based on outdated code. Check a save after a lost reply with `get_bridge_status({ scriptId, operationId })` or `customaise doctor --script ID --operation ID`. Status checks require the authenticated bridge and do not consume tool quota.
- **CLI workspace isolation.** Concurrent starts, replaced daemon credentials and project switching recover without deleting another daemon's token or inheriting another caller's workspace. Invalid tab identifiers return usage errors. Unicode paths use an explicit encoding; older daemons that cannot represent a path explain how to restart and retry.
- **Progress while waiting for approval.** HTTP/SSE responses stream immediately with backpressure instead of buffering until completion. Approval heartbeats reach the caller while a decision is pending.
- **Bounded HTTP requests.** Uploads, responses, concurrent requests and workspace retention have explicit limits. Disconnects and deadlines cancel owned requests; work that ignores cancellation keeps its admission slot until it settles.
- **Mixed-version reconnect loops.** Incompatible leader/follower relay versions return a clear rejection instead of repeatedly reconnecting. Normal leader handover remains available.

### Compatibility and limits

- Update all MCP processes together, including a running CLI daemon. The internal leader/follower relay now uses protocol 2. The same 19 MCP tools and extension bridge protocol are retained; full save cancellation and durable receipts require extension **1.3.4**. Older bridge-compatible extensions can still connect.
- Custom HTTP clients must send an absolute `x-customaise-workspace` on every request, including negotiation. URI-encoded paths also send `x-customaise-workspace-encoding: uri`; without it, percent escapes are literal. The CLI supplies these headers automatically. Stdio keeps its existing cwd/environment resolution.
- HTTP limits: uploads **8 MiB / 30 seconds**, cumulative responses **32 MiB**, concurrency **16**, recent workspaces **256 / 15 minutes**, and request duration **10 minutes**.
- A native storage write already submitted cannot be recalled. A timeout after submission can leave the outcome unknown; inspect the save status before retrying. An oversized response fails the transport rather than returning a truncated success.
- MCP tools cannot approve their own consent prompts. Remote approval routing does not independently authenticate a human or device against an agent with account credentials or full computer access.

### Release packaging

- The npm package and Claude Desktop `.mcpb` are prepared together. Release verification compares packaged JavaScript with the build, checks installed dependencies against the tested lockfile, and starts both artifacts to verify their tools and conventions.
- The Desktop builder uses the tested lockfile and an explicitly selected, pinned packer. Zod 4.6.1 and jose 6.2.12 align the lockfile with the verified npm installation.
- The public source mirror includes the complete source and test suite, builds independently, and ignores its own dependencies and build output. Mirror JSON output now finishes writing before the process exits.

## [3.2.2] - 2026-09-01

### Fixed

- **The AgentScript conventions no longer assume the reader is in an editor.** The document described a "two browsers" model whose second browser was an IDE, told the reader the daemon was "spawned by the IDE's MCP client", and offered its sample script to "IDE agents". None of that is true for an agent holding only a shell, which is precisely the reader 3.2.1 gave these documents to. The model is now two sides, brain and hands, with the brain in an editor or a bare shell and no difference to the script you write. The primer `customaise init` writes stops contrasting its reader with "an IDE agent" for the same reason.

## [3.2.1] - 2026-08-31

### Added

- **`customaise resources` and `customaise resource <name|uri>`.** The server publishes four resources and two of them are the only documents that say how to build a UserScript or an AgentScript. An MCP client gets them from `resources/list` for free; the CLI had no verb that reached any of them, so an agent with only a shell could install scripts and never learn how to write one. That bit hardest where the CLI is the only option, since a cloud agent VM cannot attach a local MCP server at all. A bare name is accepted (`customaise resource agentscript-conventions`) because that is what an agent reading the list will type, and the primer `customaise init` writes now points at them.

### Fixed

- **`doctor` reported the port it assumed, not the one the daemon is on.** The CLI read the WebSocket port from an environment fallback rather than from the daemon's own record, so it could report 4050 while the daemon listened elsewhere. That made a local verification of the bridge meaningless: it confirmed the default, not the daemon. It reads the record now.

- **A failed share says why.** Sharing a script that the server refused left the row silent, with the reason discarded. The error text is surfaced instead.

## [3.2.0] - 2026-08-28

### Added

- **A consent wait now reaches the client as progress.** The extension's approval modal has a five-minute budget; most IDEs time a tool call out at sixty seconds. Until now the bridge extended its own timer on every `dispatch_tool_pending` frame and told the client nothing, so a user who took ninety seconds to approve on their phone approved into a void: the client had reported the call failed, the tool then ran, and the agent re-issued it. Every pending frame is now a `notifications/progress` on requests that carried a `progressToken`, on both the leader and the follower door. Clients that reset their timeout on progress (the MCP SDK from 1.9, Claude Code) wait with us. Claude Desktop and Cursor cap at a fixed sixty seconds regardless at the time of writing, so `call_webmcp_tool`'s description now tells the agent what a timeout there does and does not mean, and not to blindly re-issue a call with side effects.

- **`customaise schema`** prints the command tree as JSON: every verb, the flags it takes, the MCP tool it reaches, and the exit codes. An agent discovers a CLI by asking it. A test fails if the tree and the dispatcher disagree, or if it names a tool the server does not register.

- **A modern client appears in the extension's client list from its first request.** On the 2026-07-28 revision a client's name rides `_meta` on every request, and it was read only inside tool calls, so a client that had listed tools and not yet called one had no row: Claude Desktop, freshly launched, lists tools and resources and then waits for a human, and its row was absent until the first tool call. Identity is now read from any inbound request on either door.

- **The CLI daemon appears in the extension's client list by name.** It never runs MCP `initialize`, which is where an editor's identity comes from, so it held the port invisibly: Settings showed every editor as `(follower)` and nothing as the leader. It now shows as `customaise daemon`, and the extension (1.3.2) labels the leader row `(leader)` rather than leaving it as the one with no tag.

- **Noun-verb forms for the three short verbs**: `tab list`, `tab shot`, `tab use` alongside `tabs`, `shot`, `use`, so every tab operation lives under one noun in `--help` and in the schema. `-h` now works as well as `--help`.

### Changed

- **Error codes moved out of the range the specification reserved.** The 2026-07-28 revision claims `-32020`..`-32099` for itself ("Implementations MUST NOT emit any code from this sub-range that is not defined by this specification"), and ours sat at `-32028`..`-32033` with the spec's own allocations walking toward them. They are now `-40028`..`-40033`, same last digits. Nothing branches on the number (the CLI and the envelope key on `error.type`, which did not change), and the server accepts the old values from extensions and leaders built before the move, so a mixed fleet shows one number per condition. Ships with extension 1.3.2, which emits the new values.

### Fixed

- **A process that loses the leader of `:4050` now takes the port itself.** Only one `customaise-mcp` binds the extension's WebSocket port; the rest follow it. Leadership was decided once at startup and never revisited, which left two holes with one root. A process that lost the bind and dialled a leader that had already exited died with "connection closed before handshake", which Claude Desktop reported as `Version negotiation failed` and left the Cowork and Code sessions without Customaise until the app was restarted. A process whose leader exited AFTER greeting it lived on as an orphan, dialling a dead port forever, while nobody re-bound it; the extension gives up after three reconnect attempts, so the user saw MCP "randomly disconnect" and had to toggle it by hand. Claude Desktop hits both routinely: it spawns a disposable copy of this server purely to probe its protocol revision and reaps it a second later, and on a cold boot the probe runs slowly enough for a real server to lose the bind race to it.

  `createBridge` now returns an `ElectingBridge` that races the port at startup and again the moment a follower's leader goes away, promoting itself if the port is free and rejoining whoever won it otherwise. The bind is the arbiter, so several followers losing one leader converge on exactly one. A tool call that lands mid-election waits for it rather than failing, and a call that was in flight when the leader died now fails with the typed `leader_unreachable` (CLI exit 3) instead of a bare error (exit 1). A follower evicted over a relay-protocol mismatch still fails at once with the leader's own explanation rather than waiting out an election that would only be evicted again. The 3.0.x reconnect loop inside `RemoteBridge`, which could dial but never bind, is gone; its comment had argued promotion was unnecessary because "if no leader ever comes back there is nothing to talk to anyway", which is false whenever the leader that died was the only other process.

- **A leader steps down for a newer package.** A resident daemon idle-exits only when no extension is attached, so with Chrome open it held `:4050` indefinitely: after `npm i -g @customaise/mcp@<newer>`, every editor spawned the new version, lost the bind to the old daemon, and followed it, while Settings showed "update available" for an update the user had already installed. Only `customaise daemon stop` cleared it. Every follower's hello already carried its package version; a leader that sees a strictly newer one, once that follower has identified itself as a client (Claude Desktop's disposable protocol-probe copy of this server never does, and yielding to it meant two hand-overs per Desktop update), now releases the port with a close code naming that version, the other followers hold back 300ms so it binds first, and the old leader rejoins last as a follower. If nothing binds, the election takes the port straight back, so stepping down never leaves the seat empty, and a leader that stepped down for a version that then failed to take the port will not do so again for that version for a minute, so a newer process that cannot bind leaves an older leader in place rather than an extension that is disconnected more often than not. A hand-over that succeeded is never rate-limited: if the newer process restarts and the older one wins the bind in between, it yields again at once. The version check runs before the relay-protocol check, so a newer package that also changed the relay protocol is handed the port rather than evicted with advice to restart a daemon that never exits. Prerelease tags compare equal to their base, so two builds of one release never trade the port back and forth. The extension sees the hand-over as one reconnect, a few seconds, once per update.

- **A consent modal no longer outlives the call it was asking about.** When the bridge closed with a dispatch still waiting on the user (an IDE quitting, or now a step-down), the extension was never told, so the modal stayed on screen for its full five minutes asking about a call nobody was coming back for. `close()` now sends `cancel_dispatch` for every pending call before the socket goes, the same frame an aborted call already sends, and the modal closes with it.

- **A follower evicted over a relay-protocol mismatch fails at once with the leader's explanation**, rather than waiting out an election that would only be evicted again. A call in flight when the leader died now fails with the typed `leader_unreachable` (CLI exit 3) instead of a bare error (exit 1).

### Extension side (1.3.2)

- **Reconnect heartbeat 5 minutes → 30 seconds.** The extension retries a dropped bridge three times over 35 seconds, then falls back to a `chrome.alarms` heartbeat, which is the only timer that survives the service worker being torn down. At five minutes, quitting one IDE and opening another a minute later left MCP showing disconnected for up to four more. Thirty seconds is the alarm floor on Chrome 120, the extension's minimum; one failed TCP connect per thirty seconds while nothing is listening costs nothing.

## [3.1.0] - 2026-08-25

### Added

- **`output: "inline"`, so a chat client can actually read what it asked for.** `get_page_context` and `get_console_context` write their full payload to `.customaise/` in your workspace and return a summary plus the path. That is right for an IDE agent: a DOM snapshot is routinely hundreds of KB and belongs on disk rather than in a context window. It is a dead end in Claude Desktop, which runs this server over stdio so the write succeeds, while the model on the other end has no filesystem tool with which to open what was written. The agent received a path it could never read, and there was no second move.

  Three tools now take `output`: `"file"` (the default, unchanged), `"inline"` (returns the whole payload in the response and writes nothing), and `"auto"` (follows the `CUSTOMAISE_MCP_OUTPUT` environment variable, falling back to `file`). The `.mcpb` bundle ships with `CUSTOMAISE_MCP_OUTPUT=inline` because that bundle is installed into Claude Desktop and nowhere else, so it is the one place in the system that knows its own client for certain.

  There is deliberately no client detection. `clientInfo.name` is a string allowlist, wrong for every client not on it, and the `roots` capability says a client declares project directories, not that the model can read them. Instead every file-mode response carries the retry instruction literally: call again with `output: "inline"`. A wrong default costs one extra tool call rather than ending the run.

- **`take_screenshot` can attach the image to the response.** With `output: "inline"` the capture comes back as an MCP image block instead of a PNG on disk and a path a chat client cannot open. An image cannot be shortened the way a snapshot can, so a capture over `CUSTOMAISE_MCP_INLINE_IMAGE_MAX_KB` (1536 KB of base64) saves to a file and says so, suggesting `fullPage: false`.

- **Three environment variables**, all documented in the README: `CUSTOMAISE_MCP_OUTPUT`, `CUSTOMAISE_MCP_INLINE_MAX_KB` (64), `CUSTOMAISE_MCP_INLINE_IMAGE_MAX_KB` (1536).

### Fixed

- **Tool annotations described tools that do the opposite.** Nine of nineteen tools declared only `readOnlyHint` and `openWorldHint`, and four of those claimed `readOnlyHint: true` while their handlers wrote files. `sync_scripts` was the worst: annotated read-only, it writes a directory of scripts and overwrites any local edit it lands on. Annotations are the only thing a client has to decide whether a tool needs confirming before it runs, so "read-only" on a tool that overwrites files is a missing consent prompt rather than a documentation slip. All nineteen now declare all four hints as explicit booleans matching what the handler does, every writing tool says so in its description, and a test fails the build if either drifts. OpenAI's MCP directory also rejects tools where any of the four hints is missing.

- **An unwritable workspace no longer discards a paid-for result.** The context tools dispatch to the extension first and write second, so a failed write meant a cap unit was spent and the snapshot thrown away as an error. The workspace path is a guess on IDEs that do not set a useful working directory, which makes an unwritable path an environment fact rather than an exceptional one. File mode now falls back to inline delivery with `fileWriteError` naming the cause.

- **A capture with no pixels reported success.** A bridge fault (the tab closing mid-capture, a page that blocks capture) produced a zero-byte PNG and `success: true`. It now fails with a message saying what to try.

- **`take_screenshot` corrupted any non-PNG capture**, having stripped a hardcoded `data:image/png;base64,` prefix regardless of the actual mime type.

- **`ws` upgraded to 8.21.3**, clearing CVE-2026-45736 (uninitialized memory disclosure) and CVE-2026-48779 (memory-exhaustion denial of service). Shipped bundles already carried a patched build; the declared floor did not.

### Changed

- **Large inline payloads are shortened by trimming lists, never by truncating the JSON.** What arrives still parses and keeps every key and nesting level, and the response reports each shortened list and how many items it lost. Payloads with no lists to shorten are returned complete rather than flagged truncated.

- **`customaise shot -o FILE` always writes the file**, whatever `CUSTOMAISE_MCP_OUTPUT` says. The command's contract is the path it was given.

- **`customaise context page|console` read `CUSTOMAISE_MCP_OUTPUT` from the shell that ran them.** The tools' own default consults the resident daemon's environment, and the daemon inherited its environment from whichever invocation happened to spawn it, minutes or hours earlier. Exporting the variable in your shell therefore worked against a cold daemon and did nothing against a warm one. The CLI now forwards its own environment per call, so the setting behaves the same on both doors.

## [3.0.0] - 2026-08-21

### Added

- **`customaise`, a terminal control plane.** A second binary alongside `customaise-mcp`. It talks to a resident daemon over a loopback MCP endpoint, so a coding agent with a shell can list scripts, install them, drive tabs and call WebMCP tools without an IDE in the loop.

  ```sh
  npm i -g @customaise/mcp
  customaise doctor
  customaise scripts install ./my-tool.agent.js
  customaise tab reload 42
  customaise call my_tool --args '{"q":"hello"}'
  ```

  JSON on stdout, diagnostics on stderr, and exit codes an agent can branch on: `0` ok, `2` usage, `3` extension or daemon unreachable (signing out counts, because it takes the bridge down with it), `4` the token expired or could not refresh while the bridge was up, `5` cap reached, `6` consent denied, `7` consent timed out, `8` rejected by Customaise. `8` is the one to handle first when installing scripts: it means the sanitization pipeline refused the file and the diagnostics in the payload say what to change, where `1` means something broke and rewriting the script will not help. Everything routes through the same cap enforcement and the same human-in-the-loop consent gate as the IDE path; the CLI is another door onto the same room, not a way around it.

  The daemon starts on first use and stops with `customaise daemon stop`. It authenticates the CLI with a token in a `0600` file that only exists while the endpoint is live, and it binds `127.0.0.1` only.

- **The CLI now tells you when "Allow user scripts" is off.** That toggle lives on the Customaise card in `chrome://extensions`, it resets every time Chrome restarts or the extension reloads, and while it is off no script runs and no WebMCP tool registers. The warning existed, but only in the half of a tool result a model reads: the CLI parses the structured half, deliberately kept as clean JSON, so a terminal agent got silence in exactly the situation the warning exists for. Installs succeeded, tools never appeared, and nothing said why. It is now a field on the structured result, printed to stderr so stdout stays pipeable, and `customaise doctor` reports `userScripts` and exits 3 rather than claiming a healthy setup that cannot run anything.

- **The core loop no longer bills twice.** Five tools fetched the "Allow user scripts" banner with a second, invisible `dispatchTool`, and that dispatch spent a cap unit: `list_scripts`, `export_script`, `reload_tab`, `list_webmcp_tools` and `call_webmcp_tool`. The documented loop of install, reload, list, call therefore cost **eight units instead of four**, so the free tier's real budget for the workflow the product is built around was half what it advertises. The extension now attaches that state to every `dispatch_ack` and to `init_session`, so the banner is fresher than a cached fetch would be and costs nothing. No change to what counts as usage; the second call simply stopped existing.

- **`get_bridge_status`, and `doctor` now costs nothing.** Reports whether the extension is attached, your plan tier, whether you are signed in, whether remote approvals are on, and how much of the cap is left today and this week. It spends **no cap units**: everything it reports already arrives on the bridge's `init_session` frame, so the server answers from state it holds rather than calling the browser. `customaise doctor` previously ran `list_tabs`, which meant working out why MCP was failing cost one of the fifty daily calls that might have been why it was failing. Fields that the extension has not reported come back as `unknown` rather than as a confident `false`.

- **`--version` and `--help` on `customaise-mcp`.** The published install instructions have told every IDE flow to verify with `npx -y @customaise/mcp --version`. There was no argument handling, so that command started a stdio server and hung the terminal with no output: the one step meant to say "it worked" was the step that looked broken. It now prints the version and exits.

- **Machine-readable tool errors.** Every tool now fails with a structured payload carrying a stable `type` alongside the human message, instead of a thrown string: `auth_required`, `cap_exceeded`, `extension_not_connected`, `dispatch_timeout`, `extension_outdated`, `integrity_violation`, `consent_denied`, `consent_timeout`, `internal_error`. Sixteen handlers previously threw untyped, which reached the client as an opaque failure that an agent could only respond to by retrying. Branch on `type`, never on the message text or the numeric code: the numbers sit in a range the `2026-07-28` revision has since reserved and may yet move, and the strings will not.

### Changed

- **Speaks the MCP `2026-07-28` revision, and still speaks `2025-11-25`.** The server now runs on the v2 SDK (`@modelcontextprotocol/server`) through its `serveStdio` entry, which negotiates the protocol revision per connection. A client that has not moved gets `2025-11-25`, the exact revision this server spoke before, served from the same factory. A 2026-capable client gets `2026-07-28`. One binary, both eras, nothing to configure and no flag day.

  **Why the major version.** The package was at `2.0.7` while the specification revision is colloquially called "MCP 2.0", so `2.0.7` read as though it already spoke it. It did not. Shipping the real migration as `2.1.0` would have made that worse, so the version jumps to make the two numbers stop arguing. Nothing about the extension-to-server bridge protocol changed: `MIN_EXTENSION_VERSION` is still `1.2.3` and no working install is stranded.

- **Node 20 or newer is now required** (was 18), following the v2 SDK's floor. Claude Desktop bundles its own Node and clears this comfortably.

- **zod 4.2 or newer is now required** (was 3.24), also following the SDK. Tool descriptions written with `.describe()` are preserved through the new schema conversion, and the emitted JSON Schema now declares the 2020-12 dialect.

- **Tool and resource list results carry cache hints on 2026-07-28 connections.** `tools/list`, `resources/list`, `resources/templates/list` and `server/discover` advertise a one-hour TTL, because those registration sets are fixed at build time. `resources/read` deliberately does not: it covers `customaise://scripts`, which is your live script library, and a cached copy of that would have an agent writing against scripts you no longer have. The three static conventions handbooks opt into caching individually. Everything is `cacheScope: private`.

### Fixed

- **A second MCP process no longer breaks when the first one exits.** Only one `customaise-mcp` binds the extension's WebSocket port; the rest run as followers and proxy through it. When that leader went away, followers never reattached, so restarting one IDE left every other MCP client and the CLI daemon returning "extension not connected" until each was restarted by hand. Followers now reconnect with a capped backoff and pick up whichever process holds the port next. The code comment describing the old behaviour claimed a promotion mechanism that was never implemented, which is why this survived review.

- **The connected-IDE name no longer disappears on modern clients.** Client identity arrives through the `initialize` handshake on `2025-11-25` and through a per-request `_meta` envelope on `2026-07-28`, and neither source is populated in the other era. The server now reads both, so the extension's Settings panel names the connected IDE whichever revision it negotiated.

### Internal

- The test suite no longer substitutes a hand-written stub for the MCP SDK. It had done so since March, which meant 105 tests had never exercised the library they describe. Removing the substitution required no test changes.
- `mcp/` is covered by the repository's CI for the first time, along with a changelog currency gate mirroring the extension's.

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
  - `-32033 MCP_RELAY_PROTOCOL_MISMATCH`. Two customaise-mcp processes on this machine were built against different relay frame vocabularies. The error names both versions; restart the older process (usually the IDE-spawned server, or `customaise daemon stop`).

### Changed (breaking)
- **Leader/follower relay contract.** When several customaise-mcp processes share one machine, the first binds `:4050` and the rest relay through it. That seam now carries its own protocol version, negotiated at attach: the leader evicts a follower from a different contract, and a follower refuses to dispatch through a leader from one, each with an error naming both versions and which process to restart. Package versions may differ freely across a rollout; only frame-shape changes move this number.

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
