# Customaise for Claude Desktop

The bridge between Claude Desktop and your Customaise Chrome extension.
Speaks the MCP 2026-07-28 revision, negotiated per connection, so it follows
Claude Desktop to the stateless flow the moment Desktop asks for it, and works
unchanged until then.

Customaise is the layer between any site and any AI agent. It runs two kinds of small scripts in your browser:

- **UserScripts** reshape the pages you live in. The standard `.user.js` userscript format, plus an AI editor that writes them from a sentence.
- **AgentScripts** expose a site as custom WebMCP tools your agent can call. Build them yourself, install them from the community, or have Claude write them for you.

This bundle connects Claude Desktop to the extension so it can do both: call the custom WebMCP tools the way your IDE agent already does, and read or write the underlying scripts on your behalf.

## What Claude can do once this is installed

- **List and call custom WebMCP tools** registered on whichever tab is active, with the same human-in-the-loop consent gate that protects you in Cursor / Claude Code
- **Read live page state**: DOM snapshot, console output, screenshots, currently-selected elements
- **Write or edit scripts**: import an existing UserScript or AgentScript, edit it in Claude's chat, push the result back through Customaise's validation pipeline
- **Operate tabs**: list, focus, reload, open, close, take screenshots

Same 19 tools the Customaise MCP exposes to Cursor, Claude Code, Codex, Windsurf, Antigravity, and Kiro.

Everything runs in the browser session where you're already signed in. No API keys, no service accounts, no separate OAuth for the sites you use.

## Before you install

1. Install the [Customaise Chrome extension](https://customaise.com/install) from the Chrome Web Store.
2. Sign in to Customaise. The extension is the full product; a Power User plan unlocks unlimited use of this MCP bridge.
3. Open the Customaise side panel and enable the MCP bridge under Developer Tools.

## How to install this bundle

- Double-click `customaise.mcpb` and Claude Desktop prompts to install.
- Or drag the file into **Settings → Extensions** in Claude Desktop.
- Or use **Settings → Extensions → Advanced settings → Install Extension** and pick the file.

## How it talks to your browser

Claude Desktop spawns this bundle as a local Node.js process. The bundle opens a WebSocket to the Customaise extension on `localhost:4050`. Everything stays on your machine. The bundle does not call Customaise servers for tool execution; the extension does, using your signed-in browser session.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Tools list is empty | Make sure Chrome is running and the active tab matches an installed AgentScript |
| "MCP bridge disabled" error | Open Customaise → enable the MCP bridge under Developer Tools |
| Hitting the free-tier MCP call limit | Open a Power User plan at [customaise.com/pricing](https://customaise.com/pricing) for unlimited use |
| Port 4050 in use | Set `CUSTOMAISE_WS_PORT` in this extension's settings to a free port |

## Learn more

- Knowledge base: [customaise.com/learn](https://customaise.com/learn)
- How it compares: [customaise.com/compare](https://customaise.com/compare)
- Support: [customaise.com/support](https://customaise.com/support)
