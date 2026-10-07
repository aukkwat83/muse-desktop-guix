#!/usr/bin/env node
// On-disk usage snapshot for Übersicht: every memory-cache update must also
// land in usage.json next to chats.json, atomically, and a failed write must
// never throw into the turn that triggered it.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { USAGE_CACHE_VERSION, usageCacheFile, usageCachePayload, writeUsageCache } from '../src/server/usage-cache.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const SAMPLE = {
  tier: 'contributor',
  observedAtMs: 1787457840000,
  window: { usedPercent: 34, resetsAtMs: 1787475600000, windowDurationMins: 300 },
  weekly: { usedPercent: 12, resetsAtMs: 1788062400000 },
};

test('usageCacheFile lives next to chats.json', () => {
  assert.equal(usageCacheFile('/s/muse-desktop'), path.join('/s/muse-desktop', 'usage.json'));
});

test('payload carries version + write stamp + verbatim usage', () => {
  const p = usageCachePayload(SAMPLE, 111);
  assert.equal(p.version, USAGE_CACHE_VERSION);
  assert.equal(p.writtenAtMs, 111);
  assert.deepEqual(p.usage, SAMPLE);
});

test('writeUsageCache round-trips valid JSON with no tmp leftover', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-usage-'));
  const file = usageCacheFile(dir);
  assert.equal(writeUsageCache(file, SAMPLE, 222), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), usageCachePayload(SAMPLE, 222));
  assert.deepEqual(fs.readdirSync(dir), ['usage.json']);
  // Second write wins — readers never see a torn mix of two snapshots.
  assert.equal(writeUsageCache(file, { ...SAMPLE, tier: 'x' }, 333), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).usage.tier, 'x');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeUsageCache never throws, reports false instead', () => {
  assert.equal(writeUsageCache(null, SAMPLE), false);
  assert.equal(writeUsageCache('/nope/usage.json', null), false);
  assert.equal(writeUsageCache('/definitely/not/a/dir/usage.json', SAMPLE), false);
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
console.log(`usage-cache: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
