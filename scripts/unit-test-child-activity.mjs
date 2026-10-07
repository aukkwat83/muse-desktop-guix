#!/usr/bin/env node
// Inline child activity (transcript agent rows): the pure view-model behind
// the nested delegate view — drill summaries and headlines. DOM mounting,
// fetch caching and live patching stay in the browser (child-activity.js
// has no top-level DOM touch, so these import cleanly in Node).

import assert from 'node:assert/strict';

import { childActivityHeadline, childActivitySummary } from '../src/renderer/child-activity.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function drill(items, status = 'inProgress') {
  return { record: { status }, items };
}

test('childActivitySummary counts steps by state', () => {
  assert.deepEqual(
    childActivitySummary(drill([
      { status: 'completed' },
      { status: 'completed' },
      { status: 'inProgress' },
      { status: 'pending' },
      { status: 'weird-future' },
    ])),
    { total: 5, done: 2, running: 1 },
  );
  assert.deepEqual(childActivitySummary(drill([])), { total: 0, done: 0, running: 0 });
  assert.deepEqual(childActivitySummary(null), { total: 0, done: 0, running: 0 });
  assert.deepEqual(childActivitySummary({}), { total: 0, done: 0, running: 0 });
});

test('childActivityHeadline pairs the child status with the step count', () => {
  assert.equal(
    childActivityHeadline(drill([{ status: 'completed' }], 'inProgress')),
    'กำลังรัน · 1 ขั้นตอน',
  );
  assert.equal(
    childActivityHeadline(drill(
      [{ status: 'completed' }, { status: 'completed' }, { status: 'failed' }],
      'completed',
    )),
    'เสร็จ · 3 ขั้นตอน',
  );
  assert.equal(childActivityHeadline(drill([], 'failed')), 'ล้มเหลว · 0 ขั้นตอน');
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
console.log(`child-activity: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
