#!/usr/bin/env node
// Placeholder discipline for pending-interaction snapshots
// (reconcileIxSnapshot in src/renderer/turn-view.js, called by selectChat
// and resyncFromServer in app.js).
//
// The P1 this guards: 1.1.33 bound `turnId = 'pending'` for EVERY snapshot
// including empty ones, and isRunning() reads ANY turnId — so an idle chat
// spun with Stop forever and sendMessage queued the next prompt behind a
// phantom turn that never settles. These tests drive the funnel with a
// plain Map store (same interface as state.turnViews) through the idle,
// reconnect, answered and live shapes on both orderings.

import assert from 'node:assert/strict';

import { createTurnView, reconcileIxSnapshot, ixSnapshotSurvives, ixHasUnresolved } from '../src/renderer/turn-view.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const IDLE = { authoritative: true, running: false, turnId: null };
const row = (id, extra = {}) => ({ id, chatId: 'c1', ...extra });

test('initial idle chat load: an empty snapshot creates no view', () => {
  const store = new Map();
  const tv = reconcileIxSnapshot(store, 'c1', [], IDLE);
  assert.equal(tv, null);
  assert.equal(store.has('c1'), false, 'no phantom view for an idle chat');
  assert.equal(store.get('c1')?.turnId ?? null, null, 'isRunning() stays false');
});

test('reconnect idle chat: a synthetic view with only stale locals is dropped', () => {
  const store = new Map();
  const tv = createTurnView();
  tv.turnId = 'pending';
  tv.interactions.set('q1', row('q1')); // stale unresolved: answered elsewhere
  store.set('c1', tv);
  const out = reconcileIxSnapshot(store, 'c1', [], IDLE);
  assert.equal(out, null);
  assert.equal(store.has('c1'), false, 'authoritative empty + idle drops the phantom');
});

test('question answer completion to idle: resolved-only synthetic view is dropped', () => {
  const store = new Map();
  const tv = createTurnView();
  tv.turnId = 'pending';
  tv.interactions.set('q1', row('q1', { resolved: true, outcome: 'answered' }));
  store.set('c1', tv);
  const out = reconcileIxSnapshot(store, 'c1', [], IDLE);
  assert.equal(out, null, 'resolved cards are history, not a live turn');
  assert.equal(store.has('c1'), false);
});

test('a prompt from idle sees no turnId, so sendMessage POSTs instead of queueing', () => {
  // sendMessage's branch is `if (isRunning(chatId)) enqueue; else POST` and
  // isRunning is `!!store.get(chatId)?.turnId` — this asserts the funnel
  // leaves exactly the precondition the POST branch needs. The branch
  // itself is covered by the real-browser harness (root: idle/send).
  const store = new Map();
  reconcileIxSnapshot(store, 'c1', [], IDLE);
  assert.equal(!!store.get('c1')?.turnId, false, 'no turnId → POST path, not the queue');
});

test('rows bind a view: snapshot turnId preferred, pending fallback', () => {
  const store = new Map();
  let adopted = null;
  const out = reconcileIxSnapshot(store, 'c1', [row('q1')], {
    ...IDLE, turnId: 't-7', adoptSubmits: (rows, auth) => { adopted = [rows, auth]; },
  });
  assert.equal(out, store.get('c1'));
  assert.equal(out.turnId, 't-7', 'real snapshot turn wins over the placeholder');
  assert.equal(out.interactions.has('q1'), true);
  assert.deepEqual(adopted[0], [row('q1')]);
  assert.equal(adopted[1], true);

  const store2 = new Map();
  const out2 = reconcileIxSnapshot(store2, 'c1', [row('q1')], IDLE);
  assert.equal(out2.turnId, 'pending', 'placeholder only when rows exist but no turn yet');
});

test('rows never clobber a live real turnId', () => {
  const store = new Map();
  const tv = createTurnView();
  tv.turnId = 't-live';
  store.set('c1', tv);
  const out = reconcileIxSnapshot(store, 'c1', [row('q1')], { ...IDLE, running: true, turnId: 't-live' });
  assert.equal(out.turnId, 't-live');
  assert.equal(out.interactions.has('q1'), true);
});

test('running chat with an empty snapshot keeps its view', () => {
  const store = new Map();
  const tv = createTurnView();
  tv.turnId = 'pending'; // turn_started missed; the server says busy
  store.set('c1', tv);
  const out = reconcileIxSnapshot(store, 'c1', [], { authoritative: true, running: true, turnId: 't-9' });
  assert.equal(out, tv, 'a busy server owns the placeholder, not the snapshot');
  assert.equal(store.get('c1').turnId, 'pending');
});

test('a snapshot turn id without running still protects the view', () => {
  const store = new Map();
  const tv = createTurnView();
  tv.turnId = 'pending';
  store.set('c1', tv);
  const out = reconcileIxSnapshot(store, 'c1', [], { authoritative: true, running: false, turnId: 't-settling' });
  assert.equal(out, tv, 'a settling turn resolves via turn_done, not here');
});

test('a real local turnId is never dropped by this funnel', () => {
  const store = new Map();
  const tv = createTurnView();
  tv.turnId = 't-missed'; // turn_done fell in an SSE gap; heal paths with
  store.set('c1', tv);    // queue dispatch own that — not the ix snapshot
  const out = reconcileIxSnapshot(store, 'c1', [], IDLE);
  assert.equal(out, tv);
  assert.equal(store.has('c1'), true);
});

test('a stale snapshot never drops: backfill only, SSE stays authoritative', () => {
  const store = new Map();
  const tv = createTurnView();
  tv.turnId = 'pending';
  tv.interactions.set('q1', row('q1')); // newer than the snapshot
  store.set('c1', tv);
  const out = reconcileIxSnapshot(store, 'c1', [], { authoritative: false, running: false, turnId: null });
  assert.equal(out, tv);
  assert.equal(tv.interactions.has('q1'), true, 'stale empty must not strand a live card');
});

test('a tombstoned-same-turn row is not resurrected and leaves no view', () => {
  const store = new Map();
  const tombs = new Map([['q1', 't-3']]);
  const out = reconcileIxSnapshot(store, 'c1', [row('q1', { turnId: 't-3' })], { ...IDLE, tombstones: tombs });
  assert.equal(out, null, 'stale row skipped, synthetic view dropped: net no view');
  assert.equal(store.has('c1'), false);
});

test('a re-asked id under a new turn lifts the tombstone and binds', () => {
  const store = new Map();
  const tombs = new Map([['q1', 't-3']]);
  const out = reconcileIxSnapshot(store, 'c1', [row('q1', { turnId: 't-4' })], { ...IDLE, tombstones: tombs });
  assert.equal(out.turnId, 'pending');
  assert.equal(out.interactions.has('q1'), true);
  assert.equal(tombs.has('q1'), false);
});

test('P1 edge exact case: stale + tombstoned + empty store creates nothing', () => {
  const store = new Map();
  let adopted = 0;
  const out = reconcileIxSnapshot(store, 'c', [{ id: 'q', turnId: 'turn1' }], {
    authoritative: false,
    running: false,
    tombstones: new Map([['q', 'turn1']]),
    adoptSubmits: () => { adopted++; },
  });
  assert.equal(out, null);
  assert.equal(store.has('c'), false, 'no view for fully filtered rows');
  assert.equal(store.get('c')?.turnId ?? null, null, 'no synthetic turnId');
  assert.equal(adopted, 0, 'no submit mirror without a view');
});

test('a resolved-only snapshot allocates no view on an empty store', () => {
  const store = new Map();
  const out = reconcileIxSnapshot(store, 'c1', [row('q1', { resolved: true })], IDLE);
  assert.equal(out, null);
  assert.equal(store.has('c1'), false);
});

test('resolved-only rows merge into a live view without touching its turnId', () => {
  const store = new Map();
  const tv = createTurnView();
  tv.turnId = 't-live';
  store.set('c1', tv);
  const out = reconcileIxSnapshot(store, 'c1', [row('q1', { resolved: true })], { ...IDLE, running: true, turnId: 't-live' });
  assert.equal(out, tv);
  assert.equal(out.turnId, 't-live');
  assert.equal(out.interactions.has('q1'), true);
});

test('a live view survives tombstoned-only rows untouched', () => {
  const store = new Map();
  const tv = createTurnView();
  tv.turnId = 't-live'; // SSE-bound view: the snapshot must not reshape it
  store.set('c1', tv);
  const tombs = new Map([['q1', 't-3']]);
  const out = reconcileIxSnapshot(store, 'c1', [row('q1', { turnId: 't-3' })], {
    authoritative: false, running: true, turnId: 't-live', tombstones: tombs,
  });
  assert.equal(out, tv);
  assert.equal(out.turnId, 't-live');
  assert.equal(out.interactions.has('q1'), false, 'filtered row adds nothing');
});

test('mixed filtered + fresh rows bind a view holding only the fresh row', () => {
  const store = new Map();
  const tombs = new Map([['q1', 't-3']]);
  const out = reconcileIxSnapshot(store, 'c1', [row('q1', { turnId: 't-3' }), row('q2')], {
    authoritative: false, running: false, turnId: null, tombstones: tombs,
  });
  assert.equal(out.turnId, 'pending');
  assert.equal(out.interactions.has('q1'), false);
  assert.equal(out.interactions.has('q2'), true);
});

test('a stale re-ask under a new turn still binds (probe un-tombs)', () => {
  const store = new Map();
  const tombs = new Map([['q1', 't-3']]);
  const out = reconcileIxSnapshot(store, 'c1', [row('q1', { turnId: 't-4' })], {
    authoritative: false, running: false, turnId: null, tombstones: tombs,
  });
  assert.equal(out.turnId, 'pending');
  assert.equal(out.interactions.has('q1'), true);
});

test('bind happens post-merge: filtered rows bind nothing on a husk view', () => {
  const store = new Map();
  const tv = createTurnView(); // null turnId, nothing live
  store.set('c1', tv);
  const tombs = new Map([['q1', 't-3']]);
  const out = reconcileIxSnapshot(store, 'c1', [row('q1', { turnId: 't-3' })], {
    authoritative: false, running: false, turnId: null, tombstones: tombs,
  });
  assert.equal(out, tv);
  assert.equal(out.turnId, null, 'no placeholder without a live card');
});

test('the route-merge probe answers the same rule directly', () => {
  // mergeRoutedRow calls ixSnapshotSurvives before allocating; these pin
  // the probe contract it relies on.
  assert.equal(ixSnapshotSurvives([{ id: 'q', turnId: 't1' }], {
    authoritative: false, tombstones: new Map([['q', 't1']]),
  }), false);
  assert.equal(ixSnapshotSurvives([{ id: 'q' }], { authoritative: false }), true);
  assert.equal(ixSnapshotSurvives([{ id: 'q', resolved: true }], { authoritative: true }), false);
  assert.equal(ixSnapshotSurvives([], { authoritative: true }), false);
  assert.equal(ixHasUnresolved(new Map([['a', { resolved: true }]])), false);
  assert.equal(ixHasUnresolved(new Map([['a', {}]])), true);
  assert.equal(ixHasUnresolved(null), false);
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
console.log(`ix-placeholder: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
