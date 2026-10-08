#!/usr/bin/env node
// Question inbox pure core: draft store persistence, draft→answers
// collection mirroring the server validator, completeness counts and
// queue ordering. DOM builders need a browser and stay untested here.

import assert from 'node:assert/strict';

import {
  applyQuestionRoute,
  createQuestionDraftStore,
  draftCompleteness,
  draftToAnswers,
  INBOX_TEXT_MAX,
  orderInboxItems,
  routeHydrationNeeded,
  routeReceiptVerdict,
} from '../src/renderer/question-inbox.js';
import { applyIxSnapshot } from '../src/renderer/turn-view.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

const QUESTIONS = [
  {
    id: 'a', header: 'Cache', question: 'Cache where?', mode: 'single',
    minSelections: 1, maxSelections: 1, freeText: false,
    options: [{ label: 'Redis', description: '' }, { label: 'SQLite', description: '' }],
  },
  {
    id: 'b', header: 'Flags', question: 'Which?', mode: 'multiple',
    minSelections: 1, maxSelections: 2, freeText: false,
    options: [{ label: 'x', description: '' }, { label: 'y', description: '' }],
  },
  {
    id: 'c', header: 'Why', question: 'Why?', mode: 'single',
    minSelections: 1, maxSelections: 0, freeText: true, options: [],
  },
];

test('draft store merges per-question patches and survives a reload', () => {
  const storage = memStorage();
  const a = createQuestionDraftStore({ storage });
  a.setQuestion('ix-1', 'a', { selectedLabel: 'Redis' });
  a.setQuestion('ix-1', 'c', { freeText: 'because' });
  assert.deepEqual(a.get('ix-1'), { a: { selectedLabel: 'Redis' }, c: { freeText: 'because' } });
  // A fresh store over the same storage rehydrates lazily.
  const b = createQuestionDraftStore({ storage });
  assert.deepEqual(b.get('ix-1'), a.get('ix-1'));
  assert.equal(b.has('ix-1'), true);
  assert.equal(b.has('ix-9'), false);
  b.clear('ix-1');
  assert.deepEqual(b.get('ix-1'), {});
  assert.equal(storage.getItem('md.qDraft.ix-1'), null, 'clear drops the persisted copy too');
});

test('draft store tolerates corrupt storage', () => {
  const storage = memStorage();
  storage.setItem('md.qDraft.ix-1', '{nope');
  const s = createQuestionDraftStore({ storage });
  assert.deepEqual(s.get('ix-1'), {});
});

test('draftToAnswers collects every shape, notes included', () => {
  const r = draftToAnswers(QUESTIONS, {
    a: { selectedLabel: 'Redis' },
    b: { selectedLabels: ['x', 'y'] },
    c: { freeText: 'because', note: 'n' },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.answers, [
    { questionId: 'a', selectedLabel: 'Redis' },
    { questionId: 'b', selectedLabels: ['x', 'y'] },
    { questionId: 'c', note: 'n', freeText: 'because' },
  ]);
});

test('draftToAnswers refuses incomplete drafts with Thai errors', () => {
  let r = draftToAnswers(QUESTIONS, {
    a: { selectedLabel: 'Redis' },
    b: { selectedLabels: ['x'] },
    c: {},
  });
  assert.equal(r.ok, false);
  assert.equal(r.questionId, 'c');
  assert.match(r.error, /พิมพ์คำตอบ/);
  r = draftToAnswers(QUESTIONS, {
    a: { selectedLabel: 'Bogus' },
    b: { selectedLabels: ['x'] },
    c: { freeText: 'x' },
  });
  assert.equal(r.code, 'UNKNOWN_LABEL');
  r = draftToAnswers(QUESTIONS, {
    a: { selectedLabel: 'Redis' },
    b: { selectedLabels: ['x', 'y', 'x'] },
    c: { freeText: 'x' },
  });
  assert.equal(r.ok, true, 'duplicate picks dedupe');
  assert.deepEqual(r.answers[1].selectedLabels, ['x', 'y']);
  r = draftToAnswers(QUESTIONS, {
    a: { selectedLabel: 'Redis' },
    b: { selectedLabels: ['x'] },
    c: { freeText: 't'.repeat(INBOX_TEXT_MAX + 1) },
  });
  assert.equal(r.code, 'TEXT_TOO_LONG');
  r = draftToAnswers([], {});
  assert.equal(r.code, 'NO_QUESTIONS');
});

test('draftCompleteness counts answered questions', () => {
  assert.deepEqual(draftCompleteness(QUESTIONS, {}), { done: 0, total: 3 });
  assert.deepEqual(
    draftCompleteness(QUESTIONS, { a: { selectedLabel: 'Redis' }, b: { selectedLabels: [] }, c: { freeText: '  ' } }),
    { done: 1, total: 3 },
  );
  assert.deepEqual(
    draftCompleteness(QUESTIONS, {
      a: { selectedLabel: 'Redis' }, b: { selectedLabels: ['x'] }, c: { freeText: 'x' },
    }),
    { done: 3, total: 3 },
  );
});

test('Other free-text answers choice questions; spaced labels compare exactly', () => {
  const qs = [
    { id: 's', header: 'DB', mode: 'single', options: [{ label: '  Postgres  ' }, { label: 'Redis' }] },
    {
      id: 'm', header: 'Flags', mode: 'multiple', minSelections: 0, maxSelections: 2,
      options: [{ label: ' a ' }, { label: 'b' }],
    },
  ];
  // Spaced labels survive verbatim — trim-on-submit would 400 at the agent.
  let r = draftToAnswers(qs, { s: { selectedLabel: '  Postgres  ' }, m: { selectedLabels: [] } });
  assert.equal(r.ok, true);
  assert.equal(r.answers[0].selectedLabel, '  Postgres  ');
  assert.deepEqual(r.answers[1].selectedLabels, [], 'min:0 allows an empty pick');
  // ...but a trimmed impostor does not match.
  r = draftToAnswers(qs, { s: { selectedLabel: 'Postgres' }, m: { other: true, freeText: 'c' } });
  assert.equal(r.code, 'UNKNOWN_LABEL');
  // Other rows type free text for single AND multi questions alike.
  r = draftToAnswers(qs, { s: { other: true, freeText: 'MySQL' }, m: { other: true, freeText: 'c' } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.answers, [
    { questionId: 's', freeText: 'MySQL' },
    { questionId: 'm', freeText: 'c' },
  ]);
  // Other without text refuses with a specific prompt.
  r = draftToAnswers(qs, { s: { other: true, freeText: '  ' }, m: { other: true, freeText: 'c' } });
  assert.equal(r.code, 'ANSWER_SHAPE');
  assert.match(r.error, /อื่นๆ/);
  assert.deepEqual(
    draftCompleteness(qs, { s: { other: true, freeText: 'x' }, m: { selectedLabels: [] } }),
    { done: 2, total: 2 },
  );
});

test('route receipt: applied on match, moot on tombstone, no fetch either way', async () => {
  let calls = 0;
  const lookup = async () => { calls++; return true; };
  assert.equal(await routeReceiptVerdict({ selectedId: 'q', route: { chatId: 'c', ixId: 'q' }, lookupAbsent: lookup }), 'applied');
  assert.equal(calls, 0, 'an opened route confirms without a lookup');
  assert.equal(await routeReceiptVerdict({ selectedId: 'other', route: { chatId: 'c', ixId: 'q' }, hasTombstone: true, lookupAbsent: lookup }), 'moot');
  assert.equal(calls, 0, 'a seen resolve confirms without a lookup');
  assert.equal(await routeReceiptVerdict({ selectedId: 'x', route: null, lookupAbsent: lookup }), 'none');
});

test('route receipt: unknown id needs a fresh lookup — absent is moot, present retains', async () => {
  const route = { chatId: 'c', ixId: 'q' };
  assert.equal(await routeReceiptVerdict({ selectedId: 'other', route, lookupAbsent: async () => true }), 'moot');
  assert.equal(await routeReceiptVerdict({ selectedId: 'other', route, lookupAbsent: async () => false }), 'retain');
});

test('route receipt: failed fetch then recover still routes the exact pending ix', async () => {
  const route = { chatId: 'chat-7', ixId: 'ix-9' };
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls < 3) throw new Error('fetch failed'); // boot GET + chat fetch both down
    return false; // recovered: the exact chat/ix is still pending server-side
  };
  const verdict = await routeReceiptVerdict({ selectedId: 'other', route, lookupAbsent: flaky, sleep: async () => {} });
  assert.equal(verdict, 'retain', 'a live route survives transport failure');
  assert.equal(calls, 3, 'bounded retries bridge the outage');
});

test('route receipt: persistent transport failure retains quietly, never spams', async () => {
  let calls = 0;
  const dead = async () => { calls++; throw new Error('down'); };
  const verdict = await routeReceiptVerdict({
    selectedId: 'other', route: { chatId: 'c', ixId: 'q' },
    lookupAbsent: dead, maxAttempts: 3, sleep: async () => {},
  });
  assert.equal(verdict, 'retain', 'transport failure must never pretend applied');
  assert.equal(calls, 3, 'bounded: no infinite rapid poll');
});

test('route hydration keys off loaded state, never activeId', () => {
  // The same-active-ID retry trap: activeId is SET (selectChat assigns it
  // before its GET) but nothing loaded — hydration must still run. The
  // helper takes loadedChatId, not activeId, so the trap is unexpressible.
  assert.equal(routeHydrationNeeded({ chatId: 'c', loadedChatId: null, ixPresent: false }), true);
  assert.equal(routeHydrationNeeded({ chatId: 'c', loadedChatId: 'other', ixPresent: false }), true);
  assert.equal(routeHydrationNeeded({ chatId: 'c', loadedChatId: 'c', ixPresent: false }), true, 'chat loaded but ix unknown');
  assert.equal(routeHydrationNeeded({ chatId: 'c', loadedChatId: 'c', ixPresent: true }), false, 'exact form can paint now');
  assert.equal(routeHydrationNeeded({ chatId: '', loadedChatId: null, ixPresent: true }), false);
});

test('applyQuestionRoute hydrates-then-opens, falls through on failure, honors replacement', async () => {
  const route = { chatId: 'c', ixId: 'q' };
  let selected = null;
  let opened = null;
  const openFn = (id) => { opened = id; };
  // Loaded + present: straight to the form, no refetch.
  let r = await applyQuestionRoute({
    route, loadedChatId: 'c', ixPresent: true,
    selectChatFn: async () => { selected = 'should-not-run'; },
    openFn, isCurrent: () => true,
  });
  assert.equal(r, 'opened');
  assert.equal(selected, null);
  assert.equal(opened, 'q');
  // Unloaded: select first, then open.
  selected = null; opened = null;
  r = await applyQuestionRoute({
    route, loadedChatId: null, ixPresent: false,
    selectChatFn: async (cid) => { selected = cid; },
    openFn, isCurrent: () => true,
  });
  assert.equal(r, 'opened');
  assert.equal(selected, 'c');
  assert.equal(opened, 'q');
  // Failed select still opens (the verifier retains + can recover).
  selected = null; opened = null;
  r = await applyQuestionRoute({
    route, loadedChatId: null, ixPresent: false,
    selectChatFn: async () => { selected = 'c'; throw new Error('GET down'); },
    openFn, isCurrent: () => true,
  });
  assert.equal(r, 'opened');
  assert.equal(opened, 'q');
  // A newer tap mid-fetch: stale, never paints.
  selected = null; opened = null;
  let current = true;
  r = await applyQuestionRoute({
    route, loadedChatId: null, ixPresent: false,
    selectChatFn: async () => { current = false; },
    openFn, isCurrent: () => current,
  });
  assert.equal(r, 'stale');
  assert.equal(opened, null);
  assert.equal(await applyQuestionRoute({ route: null, openFn }), 'none');
});

test('recovery timeline: outage, retried tap finds the row, merge, exact form, applied', async () => {
  // The real-browser failure, end to end at the helper level: first fetch
  // down (nothing loaded, activeId already set), native retry re-runs
  // hydration, the receipt lookup recovers the exact row, the merge
  // adopts it under the real guards, and the reopen confirms applied.
  const route = { chatId: 'chat-7', ixId: 'ix-9' };
  assert.equal(routeHydrationNeeded({ chatId: 'chat-7', loadedChatId: null, ixPresent: false }), true);
  const serverRows = [{ id: 'ix-9', chatId: 'chat-7', turnId: 't1', subtype: 'ask', questions: [] }];
  let foundRow = null;
  let calls = 0;
  const lookupAbsent = async () => {
    calls++;
    if (calls === 1) throw new Error('GET still down');
    foundRow = serverRows.find((i) => String(i?.id) === route.ixId) || null;
    return !foundRow;
  };
  const verdict = await routeReceiptVerdict({
    selectedId: 'other', route, hasTombstone: false, lookupAbsent, sleep: async () => {},
  });
  assert.equal(verdict, 'retain', 'lookup success with a present row retains for the merge');
  assert.ok(foundRow, 'the recovered row is kept for merging, not discarded');
  const interactions = new Map();
  const tombs = new Map();
  const merged = applyIxSnapshot(interactions, [foundRow], { authoritative: true, tombstones: tombs });
  assert.deepEqual(merged.added, ['ix-9']);
  const reopened = await routeReceiptVerdict({ selectedId: 'ix-9', route, hasTombstone: false, lookupAbsent });
  assert.equal(reopened, 'applied', 'the exact form open confirms the receipt');
});

test('recovery timeline: same-turn tombstone turns the found row moot, not painted', async () => {
  const route = { chatId: 'chat-7', ixId: 'ix-9' };
  const foundRow = { id: 'ix-9', chatId: 'chat-7', turnId: 't1', subtype: 'ask' };
  const interactions = new Map();
  const tombs = new Map([['ix-9', 't1']]); // we SAW this turn resolve
  applyIxSnapshot(interactions, [foundRow], { authoritative: true, tombstones: tombs });
  assert.equal(interactions.has('ix-9'), false, 'stale same-turn row is dropped');
  assert.equal(tombs.has('ix-9'), true, '...which recounts as moot, never painted');
});

test('orderInboxItems puts asks first, oldest first', () => {
  const out = orderInboxItems([
    { id: 'ap1', subtype: null, ts: 10 },
    { id: 'q2', subtype: 'ask', ts: 20 },
    { id: 'q1', subtype: 'ask', ts: 5 },
    { id: 'ap0', subtype: null, ts: 1 },
  ]);
  assert.deepEqual(out.map((i) => i.id), ['q1', 'q2', 'ap0', 'ap1']);
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
console.log(`question-inbox: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
