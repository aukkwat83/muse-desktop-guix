#!/usr/bin/env node
// /api/notify payload contract: caps, defaults, AppleScript escaping and
// the deliver gate. Never spawns osascript — a unit suite that pops real
// banners would be rude; delivery itself was verified live on the host.

import assert from 'node:assert/strict';

import {
  buildNotifyPayload,
  escAppleScript,
  notifyArgs,
  NOTIFY_TEXT_MAX,
  NOTIFY_TITLE_MAX,
  shouldDeliver,
} from '../src/server/notify.js';
import { hasLoneSurrogate } from '../src/server/text.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('payload caps title at 80 and text at 300 chars', () => {
  assert.equal(NOTIFY_TITLE_MAX, 80);
  assert.equal(NOTIFY_TEXT_MAX, 300);
  const p = buildNotifyPayload({ title: 't'.repeat(200), body: 'b'.repeat(500) });
  assert.equal(p.title.length, 80);
  assert.equal(p.text.length, 300);
});

test('payload caps never split an emoji', () => {
  const p = buildNotifyPayload({ title: `t${'🎉'.repeat(100)}`, body: `b${'🚀'.repeat(400)}` });
  assert.equal(hasLoneSurrogate(p.title), false);
  assert.equal(hasLoneSurrogate(p.text), false);
});

test('payload defaults the title and accepts body or text', () => {
  assert.equal(buildNotifyPayload({}).title, 'Muse Desktop');
  assert.equal(buildNotifyPayload(null).text, '');
  assert.equal(buildNotifyPayload({ text: 'hi' }).text, 'hi');
  assert.equal(buildNotifyPayload({ body: 'b', text: 't' }).text, 'b');
  assert.equal(buildNotifyPayload({ title: '  ' }).title, '  ');
});

test('AppleScript escaping neutralizes quotes and backslashes', () => {
  assert.equal(escAppleScript('say "hi"'), 'say \\"hi\\"');
  assert.equal(escAppleScript('a\\b'), 'a\\\\b');
  // Backslashes first: a literal \" must not become an escape hatch.
  assert.equal(escAppleScript('\\"'), '\\\\\\"');
});

test('notify argv carries the escaped payload', () => {
  const argv = notifyArgs({ title: 'T"1', text: 'a\\b' });
  assert.equal(argv[0], '-e');
  assert.match(argv[1], /display notification "a\\\\b" with title "T\\"1"/);
});

test('delivery gate: macOS + non-empty body only', () => {
  assert.equal(shouldDeliver({ title: 't', text: 'x' }, 'darwin'), true);
  assert.equal(shouldDeliver({ title: 't', text: '' }, 'darwin'), false);
  assert.equal(shouldDeliver({ title: 't', text: 'x' }, 'linux'), false);
  assert.equal(shouldDeliver({ title: 't' }, 'darwin'), false);
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
console.log(`notify: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
