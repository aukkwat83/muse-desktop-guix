#!/usr/bin/env node
// Deep Research invariants (v1.1.39):
//  - server wire builder: the research harness rides on the wire only —
//    the user's topic stays verbatim at the end and is never rewritten;
//  - renderer store: the toggle is per-chat (never a single global) and
//    survives a reload via sessionStorage;
//  - prompt queue: a queued deep prompt keeps its flag through
//    enqueue/requeue so a 409 race cannot silently downgrade it.

import assert from 'node:assert/strict';

import {
  DEEP_RESEARCH_MARKER,
  buildDeepResearchWireText,
  applyDeepResearchWireText,
} from '../src/server/deep-research.js';
import { createDeepResearchStore } from '../src/renderer/deep-research.js';
import { createPromptQueue } from '../src/renderer/prompt-queue.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('wire text carries the harness and the verbatim topic last', () => {
  const topic = 'เปรียบเทียบแบต LFP กับ NMC สำหรับรถ EV ในไทย';
  const wire = buildDeepResearchWireText(topic);
  assert.ok(wire.startsWith(DEEP_RESEARCH_MARKER), 'marker missing');
  assert.ok(wire.endsWith(topic), 'topic must ride verbatim at the end');
  assert.match(wire, /fan-out/i);
  assert.match(wire, /adversarial/i);
  assert.match(wire, /cit/i); // cited report requirement
  // Live-E2E regression guard: a background Workflow launch settles the
  // desktop turn empty and the synthesis never lands — the harness must
  // keep the research inline and demand the report in the same turn.
  assert.match(wire, /Do NOT use\s+the Workflow tool/);
  assert.match(wire, /never end\s+the turn empty/);
});

test('empty topic never produces a harness-only prompt', () => {
  assert.equal(buildDeepResearchWireText(''), '');
  assert.equal(buildDeepResearchWireText('   '), '');
  assert.equal(buildDeepResearchWireText(null), '');
});

test('apply composes after a recovery preamble, topic still verbatim last', () => {
  const body = 'หัวข้อวิจัย';
  const recovered = `[SESSION RECOVERY — Muse Desktop]\nrecap\n\n${body}`;
  const wire = applyDeepResearchWireText(recovered, body);
  assert.ok(wire.startsWith('[SESSION RECOVERY'), 'recovery preamble kept');
  assert.ok(wire.includes(DEEP_RESEARCH_MARKER), 'harness inserted');
  assert.ok(wire.endsWith(body), 'topic last');
  assert.equal(applyDeepResearchWireText(body, body), buildDeepResearchWireText(body));
});

test('store is per-chat and persists through storage', () => {
  const backing = new Map();
  const storage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
  };
  const store = createDeepResearchStore({ storage });
  assert.equal(store.get('chat-a'), false);
  store.set('chat-a', true);
  assert.equal(store.get('chat-a'), true);
  assert.equal(store.get('chat-b'), false, 'toggle leaked across chats');
  // A fresh store over the same storage (a reload) sees the same state.
  const reloaded = createDeepResearchStore({ storage });
  assert.equal(reloaded.get('chat-a'), true);
  assert.equal(reloaded.toggle('chat-a'), false);
  assert.equal(createDeepResearchStore({ storage }).get('chat-a'), false);
  assert.equal(store.get(''), false);
  assert.equal(store.toggle(''), false);
});

test('queued prompts keep the deep flag through enqueue and requeue', () => {
  const q = createPromptQueue();
  const item = q.enqueue('chat-1', 'วิจัยเรื่อง X', [], { deepResearch: true });
  assert.equal(item.deepResearch, true);
  const plain = q.enqueue('chat-1', 'สวัสดี');
  assert.equal(plain.deepResearch, false);
  const again = q.requeueFront('chat-1', q.dequeue('chat-1'));
  assert.equal(again.deepResearch, true, '409 requeue dropped the flag');
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
console.log(`deep-research: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
