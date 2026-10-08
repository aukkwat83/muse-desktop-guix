#!/usr/bin/env node
// Wire revisions: GET snapshots must never overwrite newer same-chat SSE.
// A fetch that starts, an SSE frame that lands mid-fetch, then the fetch
// resolving, would otherwise resurrect a cleared goal or re-run a landed
// child. Every mirror write bumps; every snapshot apply checks.

import assert from 'node:assert/strict';

import { createWireRevisions } from '../src/renderer/wire-rev.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('revisions start at zero and bump per chat + resource', () => {
  const revs = createWireRevisions();
  assert.equal(revs.revOf('a', 'goal'), 0);
  revs.bump('a', 'goal');
  assert.equal(revs.revOf('a', 'goal'), 1);
  assert.equal(revs.revOf('a', 'subagents'), 0, 'resources are independent');
  assert.equal(revs.revOf('b', 'goal'), 0, 'chats are independent');
});

test('stale() detects a write after capture (the snapshot race)', () => {
  const revs = createWireRevisions();
  const captured = revs.revOf('a', 'goal');
  assert.equal(revs.stale('a', 'goal', captured), false, 'nothing landed yet');
  revs.bump('a', 'goal'); // SSE goal frame lands mid-fetch
  assert.equal(revs.stale('a', 'goal', captured), true, 'snapshot must skip');
  assert.equal(revs.stale('a', 'ctx', 0), false, 'other resources unaffected');
});

test('reset() invalidates one chat monotonically without touching the rest', () => {
  const revs = createWireRevisions();
  revs.bump('a', 'goal');
  revs.bump('b', 'goal');
  // Reset used to drop counters back to 0 — an ABA: any snapshot captured
  // at 0 before an SSE write would apply over the cleared mirror. Reset
  // now only moves forward, so every pre-reset capture reads stale.
  revs.reset('a');
  assert.equal(revs.revOf('a', 'goal'), 2);
  assert.equal(revs.revOf('b', 'goal'), 1);
  assert.equal(revs.stale('a', 'goal', 0), true);
  assert.equal(revs.stale('a', 'goal', 1), true);
  assert.equal(revs.stale('a', 'goal', 2), false);
});

test('select/resync/SSE-clear interleave: the old select snapshot loses', () => {
  const revs = createWireRevisions();
  const selCap = revs.revOf('c', 'goal'); // a select GET starts (0)
  revs.bump('c', 'goal'); // an SSE goal:null clear lands mid-fetch (1)
  revs.reset('c'); // resync clears the mirrors — must invalidate, not rewind (2)
  assert.equal(
    revs.stale('c', 'goal', selCap),
    true,
    'the stale select GET (old active goal) must not apply over the clear',
  );
  const rsCap = revs.revOf('c', 'goal'); // the resync GET starts after the clear
  assert.equal(
    revs.stale('c', 'goal', rsCap),
    false,
    'the resync snapshot (authoritative null) applies when nothing newer landed',
  );
  revs.bump('c', 'goal'); // resync applied
  assert.equal(revs.stale('c', 'goal', rsCap), true);
});

test('a capture before any write still loses to a later reset (no phantom 0)', () => {
  const revs = createWireRevisions();
  // A select GET captures all three resources on a chat nothing ever
  // wrote — revOf must register those captures, or reset has no key to
  // bump and the first in-flight select response wins over the newer
  // resync snapshot.
  const capGoal = revs.revOf('fresh', 'goal');
  const capCtx = revs.revOf('fresh', 'ctx');
  const capSubs = revs.revOf('fresh', 'subagents');
  revs.reset('fresh'); // resync clears the mirrors
  assert.equal(revs.stale('fresh', 'goal', capGoal), true, 'old select goal loses');
  assert.equal(revs.stale('fresh', 'ctx', capCtx), true, 'old select ctx loses');
  assert.equal(revs.stale('fresh', 'subagents', capSubs), true, 'old select registry loses');
  // ...while the resync snapshot itself still applies, then guards forward.
  const rsCap = revs.revOf('fresh', 'goal');
  assert.equal(revs.stale('fresh', 'goal', rsCap), false, 'resync null applies');
  revs.bump('fresh', 'goal');
  assert.equal(revs.stale('fresh', 'goal', capGoal), true);
  assert.equal(revs.stale('fresh', 'goal', rsCap), true);
  assert.equal(revs.stale('other', 'goal', 0), false, 'untouched chats read current');
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
console.log(`wire-rev: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
