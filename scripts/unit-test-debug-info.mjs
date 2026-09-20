#!/usr/bin/env node
// Unit test for the /api/debug payload shape (BUG-071) — exercises
// debugSnapshot() directly so no HTTP host has to boot. The debug page can
// only be as truthful as this snapshot; a counter that lies here reads as a
// working feature there.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SseWire } from '../src/server/sse-wire.js';
import { debugSnapshot } from '../src/server/debug-info.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function fakeSessions(stats) {
  return { stats: () => stats };
}

function snap(wire, stats = {}) {
  return debugSnapshot({
    wire,
    sessions: fakeSessions({
      chats: 3,
      groups: 2,
      hot: 1,
      running: 1,
      maxHot: 6,
      pendingInteractions: 2,
      ...stats,
    }),
    pkg,
    port: 3849,
    host: '127.0.0.1',
    stateDir: '/tmp/muse-test',
  });
}

test('identity fields come straight from pkg + env', () => {
  const s = snap(new SseWire());
  assert.equal(s.version, pkg.version);
  assert.equal(s.name, pkg.productName || pkg.name);
  assert.equal(s.port, 3849);
  assert.equal(s.host, '127.0.0.1');
  assert.equal(s.stateDir, '/tmp/muse-test');
  assert.equal(s.pid, process.pid);
  assert.ok(typeof s.uptimeMs === 'number' && s.uptimeMs >= 0);
});

test('an idle wire reports an empty ring with null id bounds', () => {
  const s = snap(new SseWire());
  assert.equal(s.sse.clients, 0);
  assert.equal(s.sse.seq, 0);
  assert.equal(s.sse.ringSize, 0);
  assert.equal(s.sse.ringMax, 2000);
  assert.equal(s.sse.minId, null);
  assert.equal(s.sse.maxId, null);
});

test('emitted events show up as seq + ring id bounds', () => {
  const wire = new SseWire();
  wire.emit('c1', 'turn_started', {});
  wire.emit('c1', 'message_delta', { text: 'x' });
  wire.emit(null, 'chat_updated', {});
  const s = snap(wire);
  assert.equal(s.sse.seq, 3);
  assert.equal(s.sse.ringSize, 3);
  assert.equal(s.sse.minId, 1);
  assert.equal(s.sse.maxId, 3);
});

test('ring eviction moves minId forward (replay-cursor visibility)', () => {
  const wire = new SseWire({ ringSize: 5 });
  for (let i = 0; i < 8; i++) wire.emit('c1', 'message_delta', { i });
  const s = snap(wire);
  assert.equal(s.sse.ringSize, 5);
  assert.equal(s.sse.minId, 4);
  assert.equal(s.sse.maxId, 8);
  assert.equal(s.sse.seq, 8);
});

test('session counters pass through stats() unchanged', () => {
  const s = snap(new SseWire(), { running: 4, pendingInteractions: 7 });
  assert.deepEqual(s.sessions, {
    chats: 3,
    groups: 2,
    hot: 1,
    running: 4,
    maxHot: 6,
    pendingInteractions: 7,
  });
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
console.log(`debug-info: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
