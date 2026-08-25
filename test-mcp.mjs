#!/usr/bin/env node
/**
 * MCP Server Test Harness (v2)
 * 
 * Starts the MCP server, waits for the extension to connect via WebSocket,
 * sends tool calls, and logs all responses.
 * 
 * Usage: node test-mcp.mjs
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, 'dist', 'index.js');

console.log('=== MCP Server Test Harness v2 ===\n');

const server = spawn('node', [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe']
});

let extensionConnected = false;

// Capture stderr
server.stderr.on('data', (data) => {
  const msg = data.toString().trim();
  console.log(`[STDERR] ${msg}`);
  if (msg.includes('Extension client connected')) {
    extensionConnected = true;
  }
});

// Parse MCP responses
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

function send(message) {
  const json = JSON.stringify(message);
  console.log(`[SEND] ${message.method || message.type} (id=${message.id || 'none'})`);
  server.stdin.write(json + '\n');
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

// Step 1: Initialize
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'antigravity-test', version: '1.0.0' }
}});
await wait(1500);

// Step 2: Initialized notification
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
await wait(500);

// Step 3: Wait for extension to connect (up to 15s with backoff)
console.log('\n⏳ Waiting for extension to connect (up to 15s)...');
for (let i = 0; i < 30; i++) {
  if (extensionConnected) break;
  await wait(500);
}

if (!extensionConnected) {
  console.log('\n❌ Extension did not connect within 15s. Tools that need the extension will fail.\n');
} else {
  console.log('\n✅ Extension connected!\n');
}
await wait(1000); // Give the connection a moment to stabilize

// Step 4: Call list_scripts
console.log('--- Test: list_scripts ---');
send({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'list_scripts', arguments: {} }});
await wait(5000);

// Step 5: Call list_tabs (if extension connected)
if (extensionConnected) {
  console.log('--- Test: list_tabs ---');
  send({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'list_tabs', arguments: {} }});
  await wait(5000);
}

// Summary
console.log('\n=== Summary ===');
console.log(`Extension connected: ${extensionConnected}`);
console.log(`Responses received: ${Object.keys(responses).length}`);
for (const [id, resp] of Object.entries(responses)) {
  const isError = resp.result?.isError;
  console.log(`  id=${id}: ${isError ? '❌ ERROR' : '✅ OK'}`);
}

// Cleanup
server.kill('SIGTERM');
await wait(500);
process.exit(0);
