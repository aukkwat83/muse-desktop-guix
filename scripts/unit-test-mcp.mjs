#!/usr/bin/env node
// MCP catalog / probe / toggle: safe projection (no secrets leak), stdio
// handshake success + failure modes, and the enabled-flag round trip.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  probeAll,
  probeServer,
  readCatalog,
  safeEntry,
  setEnabled,
} from '../src/server/mcp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixture-mcp-stdio.mjs');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function writeSettings(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
  const file = join(dir, 'settings.json');
  writeFileSync(file, JSON.stringify({ schema_version: 1, mcpServers: entries }, null, 2));
  return file;
}

test('safeEntry exposes no secrets', () => {
  const s = safeEntry('github', {
    mode: 'optional',
    command: '/usr/bin/python3',
    args: ['secret-env.py', 'GITHUB_PERSONAL_ACCESS_TOKEN=XXX'],
    env: { TOKEN: 'sekrit' },
    headers: { Authorization: 'Bearer sekrit' },
    url: 'https://user:pass@host/mcp',
  });
  const blob = JSON.stringify(s);
  assert.ok(!blob.includes('python3'));
  assert.ok(!blob.includes('sekrit'));
  assert.ok(!blob.includes('GITHUB_PERSONAL_ACCESS_TOKEN'));
  assert.ok(!blob.includes('user:pass'));
  assert.equal(s.name, 'github');
  assert.equal(s.transport, 'stdio');
  assert.equal(s.enabled, true);
});

test('safeEntry marks http transport with host only', () => {
  const s = safeEntry('remote', { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'x' } });
  assert.equal(s.transport, 'http');
  assert.equal(s.host, 'mcp.example.com');
  assert.ok(!JSON.stringify(s).includes('Authorization'));
});

test('readCatalog sorts and flags disabled', () => {
  const file = writeSettings({
    zebra: { command: '/bin/true' },
    alpha: { command: '/bin/true', enabled: false },
  });
  const { servers, error } = readCatalog(file);
  assert.equal(error, null);
  assert.deepEqual(servers.map((s) => s.name), ['alpha', 'zebra']);
  assert.equal(servers[0].enabled, false);
  assert.equal(servers[1].enabled, true);
});

test('readCatalog reports missing file instead of empty-hiding it', () => {
  const { servers, error } = readCatalog(join(tmpdir(), 'does-not-exist-xyz', 'settings.json'));
  assert.deepEqual(servers, []);
  assert.match(error, /not found/);
});

test('probeServer connects to the fixture and counts tools', async () => {
  const file = writeSettings({ fix: { command: process.execPath, args: [FIXTURE] } });
  const r = await probeServer('fix', { file, timeoutMs: 8000 });
  assert.equal(r.status, 'connected');
  assert.equal(r.tools, 2);
  assert.ok(r.latencyMs >= 0);
});

test('probeServer never spawns a disabled server', async () => {
  const file = writeSettings({ fix: { command: '/nonexistent/spawn-me', enabled: false } });
  const r = await probeServer('fix', { file, timeoutMs: 2000 });
  assert.equal(r.status, 'disabled');
});

test('probeServer fails fast on a bogus command', async () => {
  const file = writeSettings({ bogus: { command: '/nonexistent/mcp-xyz-123' } });
  const r = await probeServer('bogus', { file, timeoutMs: 5000 });
  assert.equal(r.status, 'failed');
  assert.ok(r.error);
});

test('probeServer survives a >64KB tools/list (azure/gitlab-shaped)', async () => {
  const file = writeSettings({
    big: { command: process.execPath, args: [FIXTURE], env: { FIXTURE_MCP_MODE: 'big' } },
  });
  const r = await probeServer('big', { file, timeoutMs: 8000 });
  assert.equal(r.status, 'connected');
  assert.equal(r.tools, 300);
});

test('probeServer reports a crashing server', async () => {
  const file = writeSettings({
    crash: { command: process.execPath, args: [FIXTURE], env: { FIXTURE_MCP_MODE: 'crash' } },
  });
  const r = await probeServer('crash', { file, timeoutMs: 5000 });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /exit|handshake|ENOENT/);
});

test('probeAll covers every entry and never throws per-server', async () => {
  const file = writeSettings({
    fix: { command: process.execPath, args: [FIXTURE] },
    bogus: { command: '/nonexistent/mcp-xyz-123' },
    off: { command: '/bin/true', enabled: false },
  });
  const { results, probedAt, error } = await probeAll({ file, timeoutMs: 8000, concurrency: 2 });
  assert.equal(error, null);
  assert.ok(probedAt > 0);
  assert.deepEqual(results.map((r) => r.name), ['bogus', 'fix', 'off']);
  assert.deepEqual(results.map((r) => r.status), ['failed', 'connected', 'disabled']);
});

test('setEnabled round-trips the flag and keeps a backup', () => {
  const file = writeSettings({ fix: { command: process.execPath, mode: 'optional' } });
  const before = readFileSync(file, 'utf8');
  assert.equal(setEnabled('fix', false, file).enabled, false);
  assert.equal(existsSync(`${file}.bak-muse-desktop`), true);
  assert.equal(readFileSync(`${file}.bak-muse-desktop`, 'utf8'), before);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).mcpServers.fix.enabled, false);
  assert.equal(setEnabled('fix', true, file).enabled, true);
  assert.ok(!('enabled' in JSON.parse(readFileSync(file, 'utf8')).mcpServers.fix));
});

test('setEnabled refuses unknown servers', () => {
  const file = writeSettings({ fix: { command: process.execPath } });
  assert.throws(() => setEnabled('nope', false, file), /unknown MCP server/);
});

test('probe result carries no entry secrets', async () => {
  const file = writeSettings({
    fix: { command: process.execPath, args: [FIXTURE], env: { FIXTURE_MCP_MODE: 'ok', S3CR3T: 'hunter2' } },
  });
  const r = await probeServer('fix', { file, timeoutMs: 8000 });
  assert.ok(!JSON.stringify(r).includes('hunter2'));
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
console.log(`mcp: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
