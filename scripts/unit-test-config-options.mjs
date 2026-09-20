#!/usr/bin/env node
// setConfigOption() against a real MspClient with a stubbed transport:
// model validates against model/list, thinking against the schema's closed
// tier vocabulary, and every rejection is a 400 (never a 500).

import assert from 'node:assert/strict';
import os from 'node:os';
import { MspClient, REASONING_TIERS } from '../src/server/msp-client.js';

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

function liveClient() {
  const client = new MspClient({ cwd: os.tmpdir() });
  client.sessionId = 's-live';
  client.proc = {}; // live enough for setConfigOption's guard
  client.modelCatalog = [{ modelId: 'mock-model-1' }, { modelId: 'mock-model-2' }];
  client.modelId = 'mock-model-2';
  client.effort = 'high';
  client._refreshConfigOptions();
  const calls = [];
  client.request = async (method, params) => {
    calls.push({ method, params });
    return {};
  };
  return { client, calls };
}

test('model + thinking selects come from the catalog and the tier list', () => {
  const { client } = liveClient();
  const selects = client.configSelects();
  assert.equal(selects.model.currentValue, 'mock-model-2');
  assert.deepEqual(selects.model.values, ['mock-model-1', 'mock-model-2']);
  assert.equal(selects.thinking.currentValue, 'high');
  assert.deepEqual(selects.thinking.values, REASONING_TIERS);
});

test('model change drives session/setModel and refreshes currentValue', async () => {
  const { client, calls } = liveClient();
  const selects = await client.setConfigOption('model', 'mock-model-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'session/setModel');
  assert.equal(calls[0].params.model.modelId, 'mock-model-1');
  assert.equal(selects.model.currentValue, 'mock-model-1');
});

test('thinking change drives session/setReasoningEffort', async () => {
  const { client, calls } = liveClient();
  const selects = await client.setConfigOption('thinking', 'max');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'session/setReasoningEffort');
  assert.equal(calls[0].params.reasoningEffort, 'max');
  assert.equal(selects.thinking.currentValue, 'max');
});

test('unadvertised model is a 400, not a 500', async () => {
  const { client } = liveClient();
  await assert.rejects(() => client.setConfigOption('model', 'nope'), (err) => {
    assert.equal(err.status, 400);
    assert.match(err.message, /not advertised/);
    return true;
  });
});

test('unknown thinking tier is a 400', async () => {
  const { client } = liveClient();
  await assert.rejects(() => client.setConfigOption('thinking', 'turbo'), (err) => {
    assert.equal(err.status, 400);
    return true;
  });
});

test('unknown configId and empty values are 400s', async () => {
  const { client } = liveClient();
  await assert.rejects(() => client.setConfigOption('nope', 'x'), (err) => {
    assert.equal(err.status, 400);
    return true;
  });
  await assert.rejects(() => client.setConfigOption('model', ''), (err) => {
    assert.equal(err.status, 400);
    return true;
  });
});

test('no live session is a 400', async () => {
  const client = new MspClient({ cwd: os.tmpdir() });
  await assert.rejects(() => client.setConfigOption('model', 'mock-model-1'), (err) => {
    assert.equal(err.status, 400);
    return true;
  });
});

test('empty catalog skips validation instead of rejecting everything', async () => {
  const { client, calls } = liveClient();
  client.modelCatalog = []; // model/list came back empty
  await client.setConfigOption('model', 'anything');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.model.modelId, 'anything');
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
console.log(`config-options: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
