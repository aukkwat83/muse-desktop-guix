#!/usr/bin/env node
// Fixture stdio MCP server for unit-test-mcp.mjs. Speaks just enough MCP to
// satisfy the desktop prober: initialize → tools/list (two tools).
// Exits nonzero when FIXTURE_MCP_MODE=crash; never replies in mode=hang.

import { createInterface } from 'node:readline';

const MODE = process.env.FIXTURE_MCP_MODE || 'ok';

if (MODE === 'crash') {
  console.error('fixture asked to crash');
  process.exit(3);
}

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (MODE === 'hang') return;
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture-mcp', version: '0.0.0' },
    } });
  } else if (msg.method === 'tools/list') {
    if (MODE === 'big') {
      // Azure/gitlab-shaped: a single-line response well past 64KB.
      const tools = [];
      for (let i = 0; i < 300; i++) {
        tools.push({ name: `tool_${i}`, description: `padding ${'x'.repeat(400)}`, inputSchema: { type: 'object' } });
      }
      send({ jsonrpc: '2.0', id: msg.id, result: { tools } });
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'alpha', description: 'first', inputSchema: { type: 'object' } },
      { name: 'beta', description: 'second', inputSchema: { type: 'object' } },
    ] } });
  } else if (msg.id != null) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown ${msg.method}` } });
  }
});
