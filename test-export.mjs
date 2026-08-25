#!/usr/bin/env node
/**
 * MCP Export Test — uses newline-delimited JSON (matching test-mcp.mjs)
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, 'dist', 'index.js');

const SCRIPT_CODE = `// ==UserScript==
// @name        MCP Push Test
// @namespace   vibemonkey-mcp-test
// @version     1.0.0
// @description Test script pushed via MCP bridge
// @match       *://*/*
// @grant       none
// ==/UserScript==

(function() {
  'use strict';
  console.log('[MCP-Test] Hello from MCP bridge!');
})();`;

console.log('=== MCP Export Script Test ===\n');

const server = spawn('node', [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
let extensionConnected = false;

server.stderr.on('data', (data) => {
  const msg = data.toString().trim();
  console.log(`[STDERR] ${msg}`);
  if (msg.includes('Extension client connected')) extensionConnected = true;
});

let responseBuf = '';
const responses = {};
server.stdout.on('data', (data) => {
  responseBuf += data.toString();
  const lines = responseBuf.split('\n');
  responseBuf = lines.pop() || '';
  for (const line of lines) {
    if (line.trim()) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.id) responses[parsed.id] = parsed;
        console.log(`\n[RESPONSE id=${parsed.id}] ${JSON.stringify(parsed.result || parsed.error, null, 2)}\n`);
      } catch { /* incomplete */ }
    }
  }
});

function send(msg) {
  const json = JSON.stringify(msg);
  console.log(`[SEND] ${msg.method} (id=${msg.id || 'none'})`);
  server.stdin.write(json + '\n');
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

// Init
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2024-11-05', capabilities: {},
  clientInfo: { name: 'export-test', version: '1.0.0' }
}});
await wait(1500);
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
await wait(500);

// Wait for extension
console.log('\n⏳ Waiting for extension to connect (35s max)...');
for (let i = 0; i < 70; i++) {
  if (extensionConnected) break;
  await wait(500);
}

if (!extensionConnected) {
  console.log('\n❌ Extension did not connect. Exiting.\n');
  server.kill(); process.exit(1);
}
console.log('\n✅ Extension connected!\n');
await wait(1000);

// list_scripts before
console.log('--- list_scripts (before) ---');
send({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'list_scripts', arguments: {} }});
await wait(3000);

// export_script with filePath
console.log('--- export_script ---');
send({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: {
  name: 'export_script', arguments: { filePath: '/tmp/mcp-push-test.user.js' }
}});
await wait(5000);

// list_scripts after
console.log('--- list_scripts (after) ---');
send({ jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'list_scripts', arguments: {} }});
await wait(3000);

// Summary
console.log('\n=== Summary ===');
console.log(`Extension connected: ${extensionConnected}`);
for (const [id, resp] of Object.entries(responses)) {
  const isError = resp.result?.isError;
  console.log(`  id=${id}: ${isError ? '❌ ERROR' : '✅ OK'}`);
}

server.kill('SIGTERM');
await wait(500);
process.exit(0);
