#!/usr/bin/env node
// Context meter: grok's remaining-% thresholds, the used/limit pill text,
// and the never-invent-a-limit rule (absent window stays omitted).

import assert from 'node:assert/strict';

import { formatCtxMeter, formatTokensK } from '../src/renderer/ctx-meter.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('pill text is used / max (used%)', () => {
  const m = formatCtxMeter(123456, 1000000, 'normal');
  assert.equal(m.text, '123.5k / 1M (12%)');
  assert.equal(m.level, 'ok');
  assert.equal(Math.round(m.usedPct), 12);
});

test('compact formatter rounds like grok', () => {
  assert.equal(formatTokensK(999), '999');
  assert.equal(formatTokensK(23_000), '23k');
  assert.equal(formatTokensK(123_456), '123.5k');
  assert.equal(formatTokensK(1_000_000), '1M');
});

test('server pressure wins over thresholds', () => {
  assert.equal(formatCtxMeter(10_000, 1_000_000, 'warning').level, 'warn');
  assert.equal(formatCtxMeter(10_000, 1_000_000, 'blocked').level, 'danger');
  assert.equal(formatCtxMeter(900_000, 1_000_000, 'normal').level, 'ok');
});

test('remaining thresholds match grok when pressure is unknown', () => {
  assert.equal(formatCtxMeter(375_000, 500_000, 'mystery').level, 'ok');
  assert.equal(formatCtxMeter(375_001, 500_000, 'mystery').level, 'warn');
  assert.equal(formatCtxMeter(460_000, 500_000, 'mystery').level, 'danger');
});

test('absent limit omits the limit part', () => {
  const m = formatCtxMeter(12_400, null, 'normal');
  assert.equal(m.text, '12.4k / —');
  assert.equal(m.usedPct, null);
  assert.match(m.title, /ไม่บอก limit/);
});

test('session totals ride the tooltip', () => {
  const m = formatCtxMeter(1000, 100000, 'normal', {
    promptTokens: 900, outputTokens: 100, totalTokens: 1000,
  });
  assert.match(m.title, /Session นี้รวม 1,000 tokens/);
  assert.match(m.title, /prompt 900 · output 100/);
});

test('garbage in clamps, never throws', () => {
  const m = formatCtxMeter(-5, 0, null, null);
  assert.equal(m.text, '0 / —');
  const over = formatCtxMeter(600_000, 500_000, 'normal');
  assert.equal(over.usedPct, 100);
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
console.log(`ctx-meter: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
