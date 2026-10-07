#!/usr/bin/env node
// Right-rail resize math: mirror of unit-test-sidebar-resize.mjs. The rail
// additionally accounts for the live left-sidebar width when guarding room
// for the result column.

import assert from 'node:assert/strict';

import {
  RIGHTBAR_MAIN_MIN_PX,
  RIGHTBAR_MAX_PX,
  RIGHTBAR_MIN_PX,
  clampRightbarWidth,
  parseStoredRightbarWidth,
  widthFromClientXRight,
} from '../src/renderer/rightbar-resize.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('constants are sane', () => {
  assert.equal(RIGHTBAR_MIN_PX, 220);
  assert.equal(RIGHTBAR_MAX_PX, 520);
  assert.equal(RIGHTBAR_MAIN_MIN_PX, 300);
});

test('clamp keeps in-range widths, rounded', () => {
  assert.equal(clampRightbarWidth(250.4, 1400, 256), 250);
  assert.equal(clampRightbarWidth(250.6, 1400, 256), 251);
});

test('clamp pins to MIN/MAX on a wide window', () => {
  assert.equal(clampRightbarWidth(50, 1400, 256), RIGHTBAR_MIN_PX);
  assert.equal(clampRightbarWidth(9999, 1400, 256), RIGHTBAR_MAX_PX);
});

test('clamp keeps MAIN_MIN room after the sidebar takes its share', () => {
  // 900px window, 256px sidebar → rail at most 344px so main keeps 300px.
  assert.equal(clampRightbarWidth(9999, 900, 256), 344);
  assert.equal(clampRightbarWidth(250, 900, 256), 250);
});

test('clamp never goes below MIN even on a tiny window', () => {
  assert.equal(clampRightbarWidth(9999, 500, 256), RIGHTBAR_MIN_PX);
  assert.equal(clampRightbarWidth(10, 500, 256), RIGHTBAR_MIN_PX);
});

test('clamp treats garbage input as MIN', () => {
  assert.equal(clampRightbarWidth(NaN, 1400, 256), RIGHTBAR_MIN_PX);
  assert.equal(clampRightbarWidth(undefined, 1400, 256), RIGHTBAR_MIN_PX);
  assert.equal(clampRightbarWidth(Infinity, 1400, 256), RIGHTBAR_MIN_PX);
});

test('pointer x maps relative to the app right edge', () => {
  assert.equal(widthFromClientXRight(1140, 1400, 1400, 256), 260);
  assert.equal(widthFromClientXRight(1150, 1400, 1400, 256), 250);
  assert.equal(widthFromClientXRight(1390, 1400, 1400, 256), RIGHTBAR_MIN_PX);
});

test('stored width accepts in-range ints only', () => {
  assert.equal(parseStoredRightbarWidth('250'), 250);
  assert.equal(parseStoredRightbarWidth('  250  '), 250);
  assert.equal(parseStoredRightbarWidth(250), 250);
  assert.equal(parseStoredRightbarWidth(String(RIGHTBAR_MIN_PX)), RIGHTBAR_MIN_PX);
  assert.equal(parseStoredRightbarWidth(String(RIGHTBAR_MAX_PX)), RIGHTBAR_MAX_PX);
});

test('stored width rejects garbage and out-of-range', () => {
  for (const raw of ['', '  ', 'abc', '250px', '25.5', '-5', '219', '521', '9999', null, undefined, {}, [], NaN, 250.5]) {
    assert.equal(parseStoredRightbarWidth(raw), null, JSON.stringify(raw));
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
console.log(`rightbar-resize: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
