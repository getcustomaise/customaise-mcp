#!/usr/bin/env node
/**
 * MCP Script Push Test (v3 — opt-in model)
 *
 * 1. Sets chrome.storage.local mcp_bridge_enabled = true (via extension message)
 * 2. Starts MCP server
 * 3. Waits for extension to connect
 * 4. Exports a userscript and verifies
 *
 * NOTE: Before running, enable MCP in the extension by running this in the
 * SW DevTools console:
 *
 *   chrome.storage.local.set({ mcp_bridge_enabled: true })
 *   self.mcpBridgeHandler.enable()
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, 'dist', 'index.js');
const scriptPath = join(__dirname, 'test-scripts', 'mcp-test.user.js');

console.log('=== MCP Script Push Test (v3 — opt-in) ===\n');
console.log('⚠️  Make sure you enabled MCP in the extension SW console:');
console.log('    chrome.storage.local.set({ mcp_bridge_enabled: true })');
console.log('    self.mcpBridgeHandler.enable()');
console.log('');

const scriptCode = readFileSync(scriptPath, 'utf-8');
console.log(`Script: ${scriptPath}`);
console.log(`Size: ${scriptCode.length} bytes\n`);

const server = spawn('node', [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
let extensionConnected = false;

server.stderr.on('data', (data) => {
  const msg = data.toString().trim();
  console.log(`[STDERR] ${msg}`);
  if (msg.includes('Extension client connected')) extensionConnected = true;
});

let responseBuf = '';
function waitForResponse(targetId) {
  return new Promise((resolve) => {
    const check = (data) => {
      responseBuf += data.toString();
      const lines = responseBuf.split('\n');
      responseBuf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === targetId) {
            server.stdout.removeListener('data', check);
            resolve(parsed);
            return;
          }
        } catch {}
      }
    };
    server.stdout.on('data', check);
    setTimeout(() => { server.stdout.removeListener('data', check); resolve(null); }, 90000);
  });
}

function send(msg) {
  server.stdin.write(JSON.stringify(msg) + '\n');
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

// 1. Initialize
console.log('1️⃣  Initializing MCP server...');
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2024-11-05', capabilities: {},
  clientInfo: { name: 'antigravity-push-test', version: '1.0.0' }
}});
const initResp = await waitForResponse(1);
console.log(`   ✅ Initialized: ${initResp?.result?.serverInfo?.name} v${initResp?.result?.serverInfo?.version}\n`);

send({ jsonrpc: '2.0', method: 'notifications/initialized' });
await wait(500);

// 2. Wait for extension (alarm-based — may take up to 60s)
console.log('2️⃣  Waiting for extension to connect (up to 90s — alarm interval is 60s)...');
for (let i = 0; i < 180 && !extensionConnected; i++) await wait(500);
if (!extensionConnected) { console.log('   ❌ Timeout — did you enable MCP in the extension?'); process.exit(1); }
console.log('   ✅ Extension connected\n');
await wait(1000);

// 3. Export script
console.log('3️⃣  Exporting script to extension (export_script)...');
send({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: {
  name: 'export_script',
  arguments: { filePath: scriptPath }
}});
const exportResp = await waitForResponse(10);
const exportResult = exportResp?.result?.content?.[0]?.text;
console.log(`   Response: ${exportResult}\n`);

// 4. List scripts to verify
console.log('4️⃣  Listing scripts (list_scripts)...');
send({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: {
  name: 'list_scripts', arguments: {}
}});
const listResp = await waitForResponse(11);
const listResult = listResp?.result?.content?.[0]?.text;
console.log(`   Scripts: ${listResult}\n`);

// 5. Get script source
const exportData = JSON.parse(exportResult || '{}');
if (exportData.success && exportData.scriptId) {
  console.log('5️⃣  Getting script source (get_script_source)...');
  send({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: {
    name: 'get_script_source', arguments: { scriptId: exportData.scriptId }
  }});
  const sourceResp = await waitForResponse(12);
  const sourceResult = JSON.parse(sourceResp?.result?.content?.[0]?.text || '{}');
  console.log(`   Script ID: ${sourceResult.scriptId}`);
  console.log(`   Source length: ${sourceResult.source?.length} chars`);
  console.log(`   Metadata: ${JSON.stringify(sourceResult.metadata, null, 2)}\n`);
}

console.log('=== Test Complete ===');
server.kill('SIGTERM');
await wait(500);
process.exit(0);
