#!/usr/bin/env node
// Sidebar resize math: clamp bounds, the narrow-window guard that keeps
// room for the result column, pointer-x mapping, and stored-value parsing
// (garbage in storage must fall back to the stylesheet default, never a
// broken layout).

import assert from 'node:assert/strict';

import {
  SIDEBAR_MAIN_MIN_PX,
  SIDEBAR_MAX_PX,
  SIDEBAR_MIN_PX,
  clampSidebarWidth,
  parseStoredWidth,
  widthFromClientX,
} from '../src/renderer/sidebar-resize.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('constants are sane', () => {
  assert.equal(SIDEBAR_MIN_PX, 200);
  assert.equal(SIDEBAR_MAX_PX, 480);
  assert.equal(SIDEBAR_MAIN_MIN_PX, 300);
});

test('clamp keeps in-range widths, rounded', () => {
  assert.equal(clampSidebarWidth(250.4, 1400), 250);
  assert.equal(clampSidebarWidth(250.6, 1400), 251);
});

test('clamp pins to MIN/MAX on a wide window', () => {
  assert.equal(clampSidebarWidth(50, 1400), SIDEBAR_MIN_PX);
  assert.equal(clampSidebarWidth(9999, 1400), SIDEBAR_MAX_PX);
});

test('clamp keeps MAIN_MIN room on a narrow window', () => {
  // 600px window → sidebar at most 300px so the result keeps 300px.
  assert.equal(clampSidebarWidth(9999, 600), 300);
  assert.equal(clampSidebarWidth(250, 600), 250);
});

test('clamp never goes below MIN even on a tiny window', () => {
  assert.equal(clampSidebarWidth(9999, 400), SIDEBAR_MIN_PX);
  assert.equal(clampSidebarWidth(10, 400), SIDEBAR_MIN_PX);
});

test('clamp treats garbage input as MIN', () => {
  assert.equal(clampSidebarWidth(NaN, 1400), SIDEBAR_MIN_PX);
  assert.equal(clampSidebarWidth(undefined, 1400), SIDEBAR_MIN_PX);
  assert.equal(clampSidebarWidth(Infinity, 1400), SIDEBAR_MIN_PX);
});

test('pointer x maps relative to the app left edge', () => {
  assert.equal(widthFromClientX(260, 0, 1400), 260);
  assert.equal(widthFromClientX(260, 10, 1400), 250);
  assert.equal(widthFromClientX(20, 0, 1400), SIDEBAR_MIN_PX);
});

test('stored width accepts in-range ints only', () => {
  assert.equal(parseStoredWidth('250'), 250);
  assert.equal(parseStoredWidth('  250  '), 250);
  assert.equal(parseStoredWidth(250), 250);
  assert.equal(parseStoredWidth(String(SIDEBAR_MIN_PX)), SIDEBAR_MIN_PX);
  assert.equal(parseStoredWidth(String(SIDEBAR_MAX_PX)), SIDEBAR_MAX_PX);
});

test('stored width rejects garbage and out-of-range', () => {
  for (const raw of ['', '  ', 'abc', '250px', '25.5', '-5', '199', '481', '9999', null, undefined, {}, [], NaN, 250.5]) {
    assert.equal(parseStoredWidth(raw), null, JSON.stringify(raw));
  }
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}
console.log(`sidebar-resize: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
