#!/usr/bin/env node
// Renderer scroll-pin invariants (src/renderer/scroll-pin.js — pure, no DOM).
//
// The rule these tests protect: an explicit user scroll-up (wheel / touch)
// unpins IMMEDIATELY — even inside the near-bottom threshold — while a bare
// scroll event must never unpin (content growing under a pinned reader fires
// scroll events too, and those are not the user leaving).

import assert from 'node:assert/strict';

import { computePin } from '../src/renderer/scroll-pin.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('a pinned reader at the bottom stays pinned and scrolls', () => {
  const d = computePin({ pinned: true, nearBottom: true, userScrolled: false, newContent: true });
  assert.equal(d.pinned, true);
  assert.equal(d.shouldScroll, true);
  assert.equal(d.showJump, false);
});

test('user scroll-up unpins even when still near the bottom', () => {
  // The <threshold nudge: without userScrolled this would re-pin and the next
  // delta would yank the view down (BUG-045).
  const d = computePin({ pinned: true, nearBottom: true, userScrolled: true, newContent: false });
  assert.equal(d.pinned, false);
  assert.equal(d.shouldScroll, false);
});

test('a bare scroll event away from the bottom never unpins by itself', () => {
  // Content grew under a pinned reader: the scroll event fires with
  // nearBottom=false but no user gesture — the pin must survive.
  const d = computePin({ pinned: true, nearBottom: false, userScrolled: false, newContent: false });
  assert.equal(d.pinned, true);
});

test('an unpinned reader stays unpinned on mid-transcript scroll events', () => {
  const d = computePin({ pinned: false, nearBottom: false, userScrolled: false, newContent: true });
  assert.equal(d.pinned, false);
  assert.equal(d.shouldScroll, false);
  assert.equal(d.showJump, true, 'unpinned + new content raises the jump pill');
});

test('scrolling back to the bottom re-pins', () => {
  const d = computePin({ pinned: false, nearBottom: true, userScrolled: false, newContent: true });
  assert.equal(d.pinned, true);
  assert.equal(d.shouldScroll, true);
  assert.equal(d.showJump, false);
});

test('no jump pill without new content, even when unpinned', () => {
  const d = computePin({ pinned: false, nearBottom: false, userScrolled: false, newContent: false });
  assert.equal(d.showJump, false);
});

test('missing flags degrade to a safe unpinned/no-scroll decision', () => {
  const d = computePin({});
  assert.equal(d.pinned, false);
  assert.equal(d.shouldScroll, false);
  assert.equal(d.showJump, false);
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
console.log(`scroll-pin: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
