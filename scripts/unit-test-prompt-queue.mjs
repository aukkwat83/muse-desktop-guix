#!/usr/bin/env node
// Renderer prompt-queue invariants (src/renderer/prompt-queue.js — pure).
//
// The rule these tests protect: prompts typed during a turn queue per chat in
// FIFO order, dispatch strictly one-at-a-time after settle, and a 409 race
// requeues at the FRONT so nothing is lost or reordered.

import assert from 'node:assert/strict';

import { createPromptQueue, shouldDispatch } from '../src/renderer/prompt-queue.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('enqueue/dequeue is FIFO per chat', () => {
  const q = createPromptQueue();
  q.enqueue('c1', 'first');
  q.enqueue('c1', 'second');
  q.enqueue('c2', 'other chat');
  assert.equal(q.length('c1'), 2);
  assert.equal(q.dequeue('c1').text, 'first');
  assert.equal(q.dequeue('c1').text, 'second');
  assert.equal(q.dequeue('c1'), null, 'empty bucket dequeues null');
  assert.equal(q.length('c2'), 1, 'other chats are isolated');
});

test('enqueue trims and rejects empty text or empty chatId', () => {
  const q = createPromptQueue();
  assert.equal(q.enqueue('c1', '   '), null);
  assert.equal(q.enqueue('', 'x'), null);
  assert.equal(q.enqueue(null, 'x'), null);
  assert.equal(q.length('c1'), 0);
});

test('peek does not consume; items carry stable ids', () => {
  const q = createPromptQueue();
  const a = q.enqueue('c1', 'a');
  q.enqueue('c1', 'b');
  assert.equal(q.peek('c1').id, a.id);
  assert.equal(q.peek('c1').id, a.id, 'peek twice — same head');
  assert.equal(q.length('c1'), 2);
});

test('removeAt removes exactly the indexed item and cleans up empty buckets', () => {
  const q = createPromptQueue();
  q.enqueue('c1', 'a');
  const b = q.enqueue('c1', 'b');
  q.enqueue('c1', 'c');
  assert.equal(q.removeAt('c1', 1).id, b.id);
  assert.deepEqual(q.list('c1').map((i) => i.text), ['a', 'c']);
  assert.equal(q.removeAt('c1', 5), null, 'out of range is null, not a hole');
  assert.equal(q.removeAt('c1', -1), null);
  q.removeAt('c1', 0);
  q.removeAt('c1', 0);
  assert.equal(q.length('c1'), 0);
});

test('requeueFront restores order after a 409 race', () => {
  const q = createPromptQueue();
  q.enqueue('c1', 'a');
  const head = q.dequeue('c1');
  q.enqueue('c1', 'b');
  // The dequeued head 409s — it must return to the FRONT, ahead of 'b'.
  q.requeueFront('c1', head);
  assert.deepEqual(q.list('c1').map((i) => i.text), ['a', 'b']);
  assert.equal(q.peek('c1').id, head.id, 'the item keeps its identity');
});

test('requeueFront accepts bare text and rejects empties', () => {
  const q = createPromptQueue();
  q.enqueue('c1', 'kept');
  q.requeueFront('c1', '  raced text  ');
  assert.deepEqual(q.list('c1').map((i) => i.text), ['raced text', 'kept']);
  assert.equal(q.requeueFront('c1', '   '), null);
  assert.equal(q.requeueFront('', 'x'), null);
});

test('clear/clearAll wipe queues', () => {
  const q = createPromptQueue();
  q.enqueue('c1', 'a');
  q.enqueue('c2', 'b');
  q.clear('c1');
  assert.equal(q.length('c1'), 0);
  assert.equal(q.length('c2'), 1);
  q.clearAll();
  assert.equal(q.length('c2'), 0);
});

test('shouldDispatch only when settled and non-empty', () => {
  assert.equal(shouldDispatch('idle', 2), true);
  assert.equal(shouldDispatch(null, 1), true, 'no view means settled');
  assert.equal(shouldDispatch('running', 2), false);
  assert.equal(shouldDispatch('starting', 2), false);
  assert.equal(shouldDispatch('settling', 2), false);
  assert.equal(shouldDispatch('waiting_input', 2), false);
  assert.equal(shouldDispatch('idle', 0), false, 'empty queue never dispatches');
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
console.log(`prompt-queue: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
