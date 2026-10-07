#!/usr/bin/env node
// Session cost math for the right-bar calculator: rate resolution, USD→THB,
// env overrides. Money must never NaN — every test pins a number.

import assert from 'node:assert/strict';

import {
  formatThb,
  formatUsd,
  priceTable,
  rateFor,
  sessionCost,
  thbPerUsd,
} from '../src/server/pricing.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] == null) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] == null) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('built-in table prices a session in USD and THB', () => {
  withEnv({ MUSE_DESKTOP_PRICE_JSON: null, MUSE_DESKTOP_THB_PER_USD: null }, () => {
    const c = sessionCost({ promptTokens: 1_000_000, outputTokens: 500_000, model: 'muse-spark' });
    assert.equal(c.usd, 1 * 1.25 + 0.5 * 4.25);
    assert.equal(c.thb, c.usd * 35);
    assert.equal(c.matched, 'muse-spark');
    assert.equal(c.estimated, true); // built-in table is always an estimate
    assert.ok(Number.isFinite(c.usd) && Number.isFinite(c.thb));
  });
});

test('contributor costs ~10-20x less than standard, never equal', () => {
  // Regression: every row was {1.0, 4.0}, so a contributor session cost
  // exactly the same as a standard one — and both numbers were wrong.
  // Public Meta Model API pricing: standard $1.25/$4.25, contributor
  // $0.10/$0.20 per 1M input/output tokens (identical for 1.2 and 1.3).
  withEnv({ MUSE_DESKTOP_PRICE_JSON: null, MUSE_DESKTOP_THB_PER_USD: null }, () => {
    const usage = { promptTokens: 1_000_000, outputTokens: 500_000 };
    const std = sessionCost({ ...usage, model: 'muse-spark-1.3' });
    const con = sessionCost({ ...usage, model: 'muse-spark-1.3-contributor' });
    assert.equal(std.usd, 1.25 + 0.5 * 4.25);
    // 0.1/0.2 are not exact in binary — pin within a sub-cent tolerance.
    assert.ok(Math.abs(con.usd - (0.1 + 0.5 * 0.2)) < 1e-9, `contributor usd=${con.usd}`);
    assert.ok(con.usd < std.usd / 10);
    assert.equal(std.matched, 'muse-spark-1.3');
    assert.equal(con.matched, 'muse-spark-1.3-contributor');
    const std12 = sessionCost({ ...usage, model: 'muse-spark-1.2' });
    const con12 = sessionCost({ ...usage, model: 'muse-spark-1.2-contributor' });
    assert.equal(std12.usd, std.usd);
    assert.equal(con12.usd, con.usd);
    // Unknown models fall back to the standard row, not a stale placeholder.
    const fb = sessionCost({ ...usage, model: 'muse-spark-9.9' });
    assert.equal(fb.matched, 'default');
    assert.equal(fb.usd, std.usd);
  });
});

test('rateFor matches provider/model aliases and falls back to default', () => {
  withEnv({ MUSE_DESKTOP_PRICE_JSON: null }, () => {
    const table = priceTable();
    assert.equal(rateFor('meta/muse-spark', table).matched, 'muse-spark');
    assert.equal(rateFor('MUSE-SPARK', table).matched, 'muse-spark');
    // Mixed-case provider alias: suffix keeps its case and lowercase keeps
    // the prefix, so only the lowercase-suffix candidate matches.
    assert.equal(rateFor('Meta/Muse-Spark', table).matched, 'muse-spark');
    assert.equal(rateFor('meta/MUSE-SPARK-1.3-CONTRIBUTOR', table).matched, 'muse-spark-1.3-contributor');
    const fb = rateFor('unknown-model', table);
    assert.equal(fb.matched, 'default');
    assert.equal(fb.estimated, true);
  });
});

test('rateFor matches every advertised model id exactly, never default', () => {
  // Regression: the table only knew "muse-spark" while the agent advertises
  // versioned ids — every real model silently fell back to default and all
  // sessions cost the same.
  withEnv({ MUSE_DESKTOP_PRICE_JSON: null }, () => {
    const table = priceTable();
    for (const id of [
      'muse-spark-1.3',
      'muse-spark-1.3-contributor',
      'muse-spark-1.2',
      'muse-spark-1.2-contributor',
    ]) {
      const r = rateFor(id, table);
      assert.equal(r.matched, id);
      assert.equal(r.estimated, false);
    }
  });
});

test('MUSE_DESKTOP_PRICE_JSON replaces the table, THB rate is honored', () => {
  withEnv(
    {
      MUSE_DESKTOP_PRICE_JSON: JSON.stringify({
        effective: '2026-09-01',
        source: 'finops',
        models: { 'my-model': { input: 2, output: 8 } },
      }),
      MUSE_DESKTOP_THB_PER_USD: '36.5',
    },
    () => {
      assert.equal(thbPerUsd(), 36.5);
      const c = sessionCost({ promptTokens: 1_000_000, outputTokens: 0, model: 'my-model' });
      assert.equal(c.usd, 2);
      assert.equal(c.estimated, false);
      assert.equal(c.effective, '2026-09-01');
    },
  );
});

test('malformed override falls back to built-in, never throws', () => {
  withEnv({ MUSE_DESKTOP_PRICE_JSON: '{nope', MUSE_DESKTOP_THB_PER_USD: 'abc' }, () => {
    const table = priceTable();
    assert.equal(table.override, false);
    assert.equal(thbPerUsd(), 35);
    const c = sessionCost({ promptTokens: 10, outputTokens: 10 });
    assert.ok(Number.isFinite(c.usd) && Number.isFinite(c.thb));
  });
});

test('missing tokens cost zero, formatters never NaN', () => {
  withEnv({ MUSE_DESKTOP_PRICE_JSON: null }, () => {
    const c = sessionCost({});
    assert.equal(c.usd, 0);
    assert.equal(c.thb, 0);
    assert.match(formatThb(c.thb), /฿0\.00/);
    assert.match(formatUsd(c.usd), /\$0\.0000/);
    assert.match(formatThb(NaN), /฿0\.00/);
  });
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
console.log(`pricing: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
