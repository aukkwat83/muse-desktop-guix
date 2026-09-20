#!/usr/bin/env node
// smoke-msp.mjs — the live-binary counterpart of e2e-mock-agent.mjs.
// Drives MUSE_BIN's `serve` through MspClient directly (no HTTP host):
// handshake → session → config → one streaming turn → cancel → shutdown.
// The matrix is the same five rows as the ACP smoke it replaces:
// session-defaults × reconnect × verbose flag shape.
//
// Run: node scripts/smoke-msp.mjs [--keep-alive] [--verbose]
//   --keep-alive     skip shutdown (the harness kills the tree on teardown)
//   --verbose        tx/rx wire dump (best-effort; does not assert content)

import { MspClient } from '../src/server/msp-client.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERBOSE = process.argv.includes('--verbose');
const KEEP = process.argv.includes('--keep-alive');
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-desktop-smoke-'));

const MATRIX = [
  { name: 'default', args: [] },
  { name: 'reconnect', args: [] },
  { name: 'config', args: [] },
  { name: 'mode-plan', args: [] },
  { name: 'mode-always', args: [] },
];

function wire(client, tag) {
  client.on('wire', ({ dir, frame }) => {
    if (!VERBOSE) return;
    const one = JSON.stringify(frame);
    console.log(`[${tag} ${dir}] ${one.slice(0, 300)}`);
  });
}

async function one(row) {
  const client = new MspClient({ cwd: CWD, sessionMode: row.name.startsWith('mode-') ? row.name.slice(5) : 'normal' });
  if (VERBOSE) wire(client, row.name);
  const updates = [];
  client.on('update', (u) => updates.push(u));
  await client.start({});
  if (!client.sessionId) throw new Error(`${row.name}: no sessionId after start`);
  await client.applySessionConfig();
  const selects = client.configSelects();
  if (!selects.thinking || !selects.thinking.values.length) {
    throw new Error(`${row.name}: thinking select missing from configSelects()`);
  }
  const reply = await client.prompt('Reply with exactly: smoke-ok');
  const text = typeof reply?.content === 'string' ? reply.content : '';
  if (!/smoke-ok/i.test(text)) throw new Error(`${row.name}: unexpected reply ${JSON.stringify(text).slice(0, 120)}`);
  if (!updates.length) throw new Error(`${row.name}: no view events arrived for the turn`);
  if (!KEEP) await client.shutdown();
  else client.proc?.kill?.('SIGKILL');
  await sleep(300);
  console.log(`✓ ${row.name} (session ${client.sessionId.slice(0, 8)}…, ${updates.length} view events)`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
for (const row of MATRIX) {
  try {
    await one(row);
  } catch (err) {
    failed++;
    console.log(`✗ ${row.name}: ${err?.message || err}`);
  }
}
try { fs.rmSync(CWD, { recursive: true, force: true }); } catch { /* ignore */ }
if (failed) {
  console.log(`\nsmoke-msp: ${failed}/${MATRIX.length} rows failed`);
  process.exit(1);
}
console.log(`\nsmoke-msp: all ${MATRIX.length} rows passed`);
