#!/usr/bin/env node
// Renderer history-window invariants (src/renderer/history-window.js — pure).
//
// The rule these tests protect: the transcript mounts only a trailing window
// of a long chat (turn-based with a message-count floor), "load older" expands
// upward in whole turns without ever moving the start down, and the window
// math never throws on empty/degenerate histories.

import assert from 'node:assert/strict';

import {
  HISTORY_EXPAND_TURNS,
  HISTORY_MIN_MESSAGES,
  HISTORY_WINDOW_TURNS,
  adaptiveHistoryDefaults,
  computeHistoryStartIndex,
  expandHistoryStartIndex,
  sliceHistoryMessages,
  userMessageIndices,
} from '../src/renderer/history-window.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** n user turns, each a user + assistant pair. */
function chatOf(turns, extraAssistant = 0) {
  const msgs = [];
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: 'user', text: `q${i}` });
    msgs.push({ role: 'assistant', text: `a${i}` });
    for (let k = 0; k < extraAssistant; k++) msgs.push({ role: 'assistant', text: `a${i}.${k}` });
  }
  return msgs;
}

test('a short history mounts fully', () => {
  const w = computeHistoryStartIndex(chatOf(3));
  assert.equal(w.startIndex, 0);
  assert.equal(w.truncated, false);
  assert.equal(w.turnCount, 3);
});

test('a long history windows by trailing user turns', () => {
  const msgs = chatOf(30);
  const w = computeHistoryStartIndex(msgs);
  assert.equal(w.truncated, true);
  // 30 turns, window 12 → keep turns 18..29 → start at user index of turn 18.
  assert.equal(w.startIndex, 18 * 2);
  assert.equal(w.windowTurns, HISTORY_WINDOW_TURNS);
});

test('the minMessages floor expands the window when turns are message-light', () => {
  // 30 turns of ONE message each: the 12-turn window would mount only 12
  // messages; the floor pulls the start back so 24 mount.
  const msgs = Array.from({ length: 30 }, (_, i) => ({ role: 'user', text: `q${i}` }));
  const w = computeHistoryStartIndex(msgs);
  assert.equal(w.startIndex, 30 - HISTORY_MIN_MESSAGES);
  assert.equal(w.truncated, true);
});

test('the floor never shrinks a turn window that already mounts more', () => {
  // 30 turns × 4 messages: the turn window mounts the last 48 — more than the
  // floor — so the start stays exactly at the turn boundary.
  const msgs = chatOf(30, 2); // user + assistant + 2 extra = 4 per turn
  const w = computeHistoryStartIndex(msgs);
  assert.equal(w.startIndex, 18 * 4);
  assert.equal(w.truncated, true);
});

test('empty and degenerate inputs never throw and never truncate', () => {
  for (const msgs of [[], null, undefined]) {
    const w = computeHistoryStartIndex(msgs);
    assert.equal(w.startIndex, 0);
    assert.equal(w.truncated, false);
  }
  const w = computeHistoryStartIndex(chatOf(2), { forceFull: true });
  assert.equal(w.startIndex, 0);
});

test('explicit windowTurns/minMessages options are honoured', () => {
  const msgs = chatOf(10);
  const w = computeHistoryStartIndex(msgs, { windowTurns: 3, minMessages: 2 });
  assert.equal(w.startIndex, 7 * 2, 'last 3 turns');
});

test('expand steps back whole user turns and never increases the start', () => {
  const msgs = chatOf(30);
  const cur = 18 * 2;
  const next = expandHistoryStartIndex(msgs, cur, HISTORY_EXPAND_TURNS);
  assert.equal(next, 6 * 2, '12 turns earlier');
  assert.ok(expandHistoryStartIndex(msgs, next, HISTORY_EXPAND_TURNS) <= next);
});

test('expand near the top clamps to 0; a zero start stays 0', () => {
  const msgs = chatOf(30);
  assert.equal(expandHistoryStartIndex(msgs, 4, HISTORY_EXPAND_TURNS), 0);
  assert.equal(expandHistoryStartIndex(msgs, 0), 0);
});

test('expand without any user message steps back by 4× expandTurns', () => {
  const msgs = Array.from({ length: 100 }, (_, i) => ({ role: 'assistant', text: `a${i}` }));
  assert.equal(expandHistoryStartIndex(msgs, 60, 12), 60 - 48);
});

test('sliceHistoryMessages clamps and returns the tail slice', () => {
  const msgs = chatOf(5);
  assert.deepEqual(sliceHistoryMessages(msgs, 4).slice, msgs.slice(4));
  assert.equal(sliceHistoryMessages(msgs, 999).slice.length, 0);
  assert.equal(sliceHistoryMessages(msgs, -3).startIndex, 0);
  assert.deepEqual(sliceHistoryMessages(null, 2).slice, []);
});

test('adaptiveHistoryDefaults shrinks the first window on low-core hosts', () => {
  const low = adaptiveHistoryDefaults({ cores: 4 });
  assert.equal(low.windowTurns, 10);
  assert.equal(low.minMessages, 20);
  const hi = adaptiveHistoryDefaults({ cores: 16 });
  assert.equal(hi.windowTurns, HISTORY_WINDOW_TURNS);
  assert.equal(hi.minMessages, HISTORY_MIN_MESSAGES);
  assert.equal(hi.expandTurns, HISTORY_EXPAND_TURNS);
});

test('userMessageIndices finds turn starts and skips non-user roles', () => {
  const msgs = [
    { role: 'user' },
    { role: 'assistant' },
    { role: 'notice' },
    { role: 'user' },
  ];
  assert.deepEqual(userMessageIndices(msgs), [0, 3]);
  assert.deepEqual(userMessageIndices(null), []);
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
console.log(`history-window: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
