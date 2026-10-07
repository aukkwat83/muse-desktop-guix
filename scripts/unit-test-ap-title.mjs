#!/usr/bin/env node
// SCB AP project detection: code extraction + [APxxxx] title prefixes.
// Ported contract from grok-desktop's ap-title.js — both desktops must tag
// the same sessions the same way.

import assert from 'node:assert/strict';

import {
  applyApPrefixFromMessages,
  applyApPrefixToTitle,
  extractApCodes,
  extractApTagsFromTitle,
  formatApTagPrefix,
  stripApTitlePrefixes,
} from '../src/server/ap-title.js';
import { hasLoneSurrogate } from '../src/server/text.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('extractApCodes normalizes spacing and dedupes in first-seen order', () => {
  assert.deepEqual(extractApCodes('ดู AP1845 กับ ap 1226 หน่อย'), ['AP1845', 'AP1226']);
  assert.deepEqual(extractApCodes('AP1845 then AP-1845 then AP_1845'), ['AP1845']);
  assert.deepEqual(extractApCodes('no project here'), []);
  assert.deepEqual(extractApCodes(''), []);
  assert.deepEqual(extractApCodes(null), []);
});

test('extractApCodes ignores short numbers and non-AP words', () => {
  assert.deepEqual(extractApCodes('AP123 is too short'), []);
  assert.deepEqual(extractApCodes('happy mapping'), []);
});

test('title tags round-trip: extract, strip, format', () => {
  assert.deepEqual(extractApTagsFromTitle('[AP1845] [AP1226] rest'), ['AP1845', 'AP1226']);
  assert.deepEqual(extractApTagsFromTitle('no tags'), []);
  assert.equal(stripApTitlePrefixes('[AP1845] [AP1226]  rest '), 'rest');
  assert.equal(formatApTagPrefix(['AP1845', 'AP1226']), '[AP1845] [AP1226]');
});

test('applyApPrefixToTitle prefixes a default title from the prompt', () => {
  const r = applyApPrefixToTitle('New chat', 'ช่วยดู AP1845 เรื่อง redis หน่อย');
  assert.equal(r.changed, true);
  assert.equal(r.ap, 'AP1845');
  assert.deepEqual(r.codes, ['AP1845']);
  assert.match(r.title, /^\[AP1845\] /);
  assert.ok(!r.title.includes('New chat'));
});

test('applyApPrefixToTitle keeps a human title body, source order first', () => {
  const r = applyApPrefixToTitle('[AP1226] migrate db', 'แล้ว AP1845 ล่ะ');
  assert.deepEqual(r.codes, ['AP1845', 'AP1226']);
  assert.match(r.title, /^\[AP1845\] \[AP1226\] migrate db$/);
});

test('applyApPrefixToTitle with preferExisting keeps title order (assistant)', () => {
  const r = applyApPrefixToTitle('[AP1226] migrate db', 'done for AP1845', {
    preferExistingTitleTags: true,
  });
  assert.deepEqual(r.codes, ['AP1226', 'AP1845']);
});

test('applyApPrefixToTitle without AP mentions changes nothing', () => {
  const r = applyApPrefixToTitle('plain title', 'nothing about projects');
  assert.equal(r.changed, false);
  assert.equal(r.ap, null);
  assert.equal(r.title, 'plain title');
});

test('applyApPrefixToTitle never splits an emoji at the cut', () => {
  const r = applyApPrefixToTitle('New chat', `AP1845 z${'🎉'.repeat(100)}`);
  assert.equal(hasLoneSurrogate(r.title), false);
  const long = applyApPrefixToTitle(`[AP1845] ${'w'.repeat(200)}`, 'AP1845 AP1226 extra');
  assert.equal(hasLoneSurrogate(long.title), false);
});

test('applyApPrefixFromMessages merges user order, assistant appends', () => {
  const r = applyApPrefixFromMessages('New chat', [
    { role: 'user', content: 'ดู AP1845 หน่อย' },
    { role: 'assistant', content: 'เสร็จแล้วครับ AP1226 ด้วย' },
  ]);
  assert.equal(r.changed, true);
  assert.deepEqual(r.codes, ['AP1845', 'AP1226']);
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
console.log(`ap-title: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
