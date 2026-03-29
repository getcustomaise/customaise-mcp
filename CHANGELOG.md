# Changelog

All notable changes to `@customaise/mcp` will be documented in this file.

## [1.1.0] - 2026-03-29

### Added
- **Visual DOM Targeting** (1 tool): `get_selected_elements` — retrieve user-selected DOM elements with bulletproof tiered selectors and cropped screenshots
- **Real-time DOM context push**: When MCP is connected, `.dom.md` files and element screenshots are automatically pushed to the workspace as the user selects elements in the browser
- **Screenshot element highlighting**: `take_screenshot` now supports optional high-contrast red element highlighting for AI-visible visual debugging

### Fixed
- **Screenshot reliability**: Hardened the capture pipeline with defensive retry mechanism and pre-injection of content scripts to eliminate race conditions
- **Message queueing**: MCP commands are now queued via the onboarding queue if the React UI hasn't finished initializing, preventing silently dropped messages on fresh tabs

### Changed
- Added Kiro to supported IDE list in description and README
- Added `kiro` and `antigravity` npm keywords for discoverability
- Updated tool count from 12 to 13 in README

## [1.0.1] - 2026-03-23

### Fixed
- Corrected repository URL in package metadata

## [1.0.0] - 2026-03-23

### Added
- **Script Lifecycle** (5 tools): `list_scripts`, `import_script`, `export_script`, `delete_script`, `toggle_script`
- **Browser Context** (3 tools): `get_page_context`, `get_console_context`, `list_tabs`
- **Testing & Verification** (2 tools): `reload_tab`, `take_screenshot`
- **UI Control** (1 tool): `toggle_ui`
- **Batch Operations** (1 tool): `sync_scripts` with `.customaise-manifest.json` mapping
- **File Watcher**: Auto-export `.user.js` files on save with 500ms debounce
- **MCP Prompts**: `create-userscript` and `debug-userscript` guided workflows
- **MCP Resources**: `customaise://scripts`, `customaise://scripts/{id}`, `customaise://conventions`
- **Rich validation feedback**: Structured diagnostics from the Customaise sanitization pipeline
- **Cross-platform `take_screenshot`**: Uses `os.tmpdir()` for auto-generated paths
- **Console log filtering**: Client-side `level` parameter for `get_console_context`
- **Filename collision handling**: Deduplication in `sync_scripts` bulk export
