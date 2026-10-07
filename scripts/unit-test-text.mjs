#!/usr/bin/env node
// Code-point-safe cuts: String.slice splits emoji (lone surrogates render
// as � in titles, previews and banners). Every user-visible truncation
// must go through cutText/cutEllipsis.

import assert from 'node:assert/strict';

import { cutEllipsis, cutText, hasLoneSurrogate } from '../src/server/text.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('cutText never splits a surrogate pair', () => {
  // 'x' + emoji: UTF-16 offset 2 lands mid-emoji — slice(0,2) orphans \ud83c.
  assert.equal('x🎉'.slice(0, 2), 'x\ud83c');
  assert.equal(cutText('x🎉', 2), 'x🎉');
  assert.equal(cutText('x🎉y', 2), 'x🎉');
  assert.equal(cutText('🎉'.repeat(100), 60), '🎉'.repeat(60));
});

test('cutText passes short text through untouched', () => {
  assert.equal(cutText('abc', 3), 'abc');
  assert.equal(cutText('abc', 99), 'abc');
  assert.equal(cutText('', 5), '');
  assert.equal(cutText(null, 5), '');
  assert.equal(cutText('abc', 0), '');
});

test('cutEllipsis appends … only when shortened', () => {
  assert.equal(cutEllipsis('x'.repeat(200), 60), `${'x'.repeat(60)}…`);
  assert.equal(cutEllipsis('short', 60), 'short');
  assert.equal(cutEllipsis('x🎉'.repeat(100), 60).endsWith('…'), true);
  assert.equal(hasLoneSurrogate(cutEllipsis('x🎉'.repeat(100), 60)), false);
});

test('hasLoneSurrogate spots split pairs', () => {
  assert.equal(hasLoneSurrogate('plain'), false);
  assert.equal(hasLoneSurrogate('🎉 intact'), false);
  assert.equal(hasLoneSurrogate('x\ud83c'), true);
  assert.equal(hasLoneSurrogate('\udf89y'), true);
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
console.log(`text: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
