# Changelog

All notable changes to `@customaise/mcp` will be documented in this file.

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
