#!/usr/bin/env node
// Renderer composer-draft store invariants (src/renderer/composer-draft.js —
// pure, storage injected).
//
// The rule these tests protect: a typed-but-unsent draft must survive a
// renderer reload (sessionStorage mirror), stay keyed per chat, and disappear
// for good when the chat is deleted or the prompt is sent.

import assert from 'node:assert/strict';

import { createComposerDraftStore } from '../src/renderer/composer-draft.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** Minimal Storage stand-in backed by a Map. */
function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

test('set/get roundtrip in memory', () => {
  const s = createComposerDraftStore({ storage: fakeStorage() });
  s.set('c1', 'hello');
  assert.equal(s.get('c1'), 'hello');
  assert.equal(s.get('c2'), '');
  assert.equal(s.size(), 1);
});

test('every set is mirrored under kd.composerDraft.<id>', () => {
  const storage = fakeStorage();
  const s = createComposerDraftStore({ storage });
  s.set('c1', 'draft one');
  assert.equal(storage.getItem('kd.composerDraft.c1'), 'draft one');
});

test('a fresh store rehydrates lazily from storage (the reload case)', () => {
  const storage = fakeStorage();
  createComposerDraftStore({ storage }).set('c1', 'survives reload');
  const s2 = createComposerDraftStore({ storage });
  assert.equal(s2.size(), 0, 'nothing is loaded eagerly');
  assert.equal(s2.get('c1'), 'survives reload');
  assert.equal(s2.size(), 1, 'the read hydrates the Map');
});

test('setting an empty draft removes the storage key', () => {
  const storage = fakeStorage();
  const s = createComposerDraftStore({ storage });
  s.set('c1', 'x');
  s.set('c1', '');
  assert.equal(storage.getItem('kd.composerDraft.c1'), null);
  assert.equal(s.get('c1'), '');
});

test('clear removes both the Map entry value and the storage key', () => {
  const storage = fakeStorage();
  const s = createComposerDraftStore({ storage });
  s.set('c1', 'x');
  s.clear('c1');
  assert.equal(s.get('c1'), '');
  assert.equal(storage.getItem('kd.composerDraft.c1'), null);
  // A fresh store must not resurrect a cleared draft.
  assert.equal(createComposerDraftStore({ storage }).get('c1'), '');
});

test('clearAll wipes every chat', () => {
  const storage = fakeStorage();
  const s = createComposerDraftStore({ storage });
  s.set('c1', 'a');
  s.set('c2', 'b');
  s.clearAll();
  assert.equal(s.size(), 0);
  assert.equal(storage._map.size, 0);
});

test('an empty chatId is a safe no-op', () => {
  const storage = fakeStorage();
  const s = createComposerDraftStore({ storage });
  s.set(null, 'x');
  s.set('', 'x');
  assert.equal(s.get(null), '');
  assert.equal(s.size(), 0);
  assert.equal(storage._map.size, 0);
});

test('has() checks the Map and falls back to storage', () => {
  const storage = fakeStorage();
  const s = createComposerDraftStore({ storage });
  s.set('c1', 'x');
  assert.equal(s.has('c1'), true);
  assert.equal(s.has('nope'), false);
  assert.equal(createComposerDraftStore({ storage }).has('c1'), true);
});

test('a throwing storage (private mode) leaves the Map working', () => {
  const storage = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
    removeItem() {
      throw new Error('denied');
    },
  };
  const s = createComposerDraftStore({ storage });
  s.set('c1', 'memory only');
  assert.equal(s.get('c1'), 'memory only');
  assert.equal(s.has('c1'), true);
});

test('persist:false never touches storage', () => {
  const storage = fakeStorage();
  const s = createComposerDraftStore({ storage, persist: false });
  s.set('c1', 'x');
  assert.equal(storage._map.size, 0);
  assert.equal(s.get('c1'), 'x');
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
console.log(`composer-draft: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
