#!/usr/bin/env node
// Goal + tasks rail logic, Mcode ConversationStatusPanel parity: wire-true
// todo normalization, goal verb guards, and the rail's pure display helpers
// (status words, glyphs, focus window, fold labels).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// createChat background-warms by default — pin it off so unit tests never
// spawn a real agent (each suite is its own process).
process.env.MUSE_DESKTOP_CREATE_WARM = '0';
// Host-origin banners stay off here — unit suites never touch a desktop.
process.env.MUSE_DESKTOP_NOTIFY = 'off';

import { normalizeTodoItems } from '../src/server/msp-client.js';
import { SessionStore } from '../src/server/session-store.js';
import { SessionManager } from '../src/server/sessions.js';
import {
  goalControlFor,
  goalStatusWord,
  taskGlyph,
  taskStatusWord,
  todoFocusWindow,
  todoFoldLabel,
} from '../src/renderer/rightbar.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'muse-goal-tasks-')), 'chats.json');
}

function fakeWire() {
  const events = [];
  return {
    events,
    emit: (chatId, type, payload) => events.push({ chatId, type, ...payload }),
    of: (type) => events.filter((e) => e.type === type),
  };
}

function tmpSearchDb() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'muse-goal-tasks-idx-')), 'search.sqlite');
}

function manager() {
  const store = new SessionStore({ file: tmpFile(), debounceMs: 5 });
  const wire = fakeWire();
  return { store, wire, mgr: new SessionManager({ store, wire, searchDbPath: tmpSearchDb() }) };
}

test('normalizeTodoItems maps the wire shape onto the snake vocabulary', () => {
  assert.deepEqual(normalizeTodoItems(null), []);
  assert.deepEqual(normalizeTodoItems('nope'), []);
  const out = normalizeTodoItems([
    { text: 'a', status: 'pending' },
    { text: 'b', status: 'inProgress', activeForm: 'Doing b' },
    { text: 'c', status: 'completed' },
    { text: 'd', status: 'cancelled' },
    {},
    { content: 'legacy', status: 'in_progress' },
  ]);
  assert.deepEqual(
    out.map((e) => e.status),
    ['pending', 'in_progress', 'completed', 'cancelled', 'pending', 'in_progress'],
  );
  assert.equal(out[1].content, 'b');
  assert.equal(out[1].activeForm, 'Doing b');
  assert.equal(out[0].activeForm, undefined);
  assert.equal(out[4].content, '');
  assert.equal(out[5].content, 'legacy');
  // Blank activeForm is dropped, never rendered as an empty row.
  assert.deepEqual(normalizeTodoItems([{ text: 'x', status: 'inProgress', activeForm: '  ' }]), [
    { content: 'x', status: 'in_progress' },
  ]);
});

test('goalCommand guards: unknown chat 404, bad action 400, cold chat 409', async () => {
  const { mgr } = manager();
  const chat = mgr.createChat({ title: 'cold' });
  await assert.rejects(mgr.goalCommand('nope', 'pause'), (err) => {
    assert.equal(err.status, 404);
    return true;
  });
  await assert.rejects(mgr.goalCommand(chat.id, 'explode'), (err) => {
    assert.equal(err.status, 400);
    return true;
  });
  await assert.rejects(mgr.goalCommand(chat.id, ''), (err) => {
    assert.equal(err.status, 400);
    return true;
  });
  // No agent was ever spawned for this chat (CREATE_WARM=0) — nothing to
  // command. The rail button disables itself when cold; this is the backstop.
  await assert.rejects(mgr.goalCommand(chat.id, 'pause'), (err) => {
    assert.equal(err.status, 409);
    assert.equal(err.code, 'NO_SESSION');
    return true;
  });
});

test('goal words cover the real MSP states, control follows Mcode', () => {
  assert.equal(goalStatusWord('active'), 'กำลังทำ');
  assert.equal(goalStatusWord('running'), 'กำลังทำ');
  assert.equal(goalStatusWord('paused'), 'หยุดชั่วคราว');
  assert.equal(goalStatusWord('complete'), 'เสร็จ');
  assert.equal(goalStatusWord('verified'), 'เสร็จ');
  assert.equal(goalStatusWord('blocked'), 'ติดขัด');
  assert.equal(goalStatusWord('weird-future'), 'weird-future');
  assert.equal(goalControlFor('active'), 'pause');
  assert.equal(goalControlFor('running'), 'pause');
  assert.equal(goalControlFor('paused'), 'resume');
  assert.equal(goalControlFor('complete'), 'done');
  assert.equal(goalControlFor('verified'), 'done');
  assert.equal(goalControlFor('blocked'), null);
  assert.equal(goalControlFor(null), null);
});

test('task glyphs differ by shape, words cover cancelled', () => {
  assert.deepEqual(taskGlyph('completed'), { glyph: '✓', cls: 'task-glyph done' });
  assert.deepEqual(taskGlyph('in_progress'), { glyph: '→', cls: 'task-glyph run' });
  assert.deepEqual(taskGlyph('pending'), { glyph: '○', cls: 'task-glyph idle' });
  assert.deepEqual(taskGlyph('cancelled'), { glyph: '✕', cls: 'task-glyph cancel' });
  assert.deepEqual(taskGlyph('bogus'), { glyph: '○', cls: 'task-glyph idle' });
  assert.equal(taskStatusWord('in_progress'), 'ทำอยู่');
  assert.equal(taskStatusWord('completed'), 'เสร็จ');
  assert.equal(taskStatusWord('cancelled'), 'ยกเลิก');
  assert.equal(taskStatusWord('pending'), 'รอ');
});

test('todoFocusWindow shows all of 6 or fewer', () => {
  const items = Array.from({ length: 6 }, (_, i) => ({ content: `t${i}`, status: 'pending' }));
  const w = todoFocusWindow(items);
  assert.equal(w.compact, false);
  assert.equal(w.focus.length, 6);
  assert.equal(w.preceding.length, 0);
  assert.equal(w.following.length, 0);
  const empty = todoFocusWindow(null);
  assert.equal(empty.compact, false);
  assert.equal(empty.focus.length, 0);
});

test('todoFocusWindow centers on the running row with context', () => {
  const items = [
    { content: 'd0', status: 'completed' },
    { content: 'd1', status: 'completed' },
    { content: 'd2', status: 'completed' },
    { content: 'd3', status: 'completed' },
    { content: 'run', status: 'in_progress' },
    { content: 'p5', status: 'pending' },
    { content: 'p6', status: 'pending' },
    { content: 'p7', status: 'pending' },
  ];
  const w = todoFocusWindow(items);
  assert.equal(w.compact, true);
  assert.deepEqual(w.focus.map((t) => t.content), ['run', 'p5', 'p6']);
  assert.deepEqual(w.preceding.map((t) => t.content), ['d0', 'd1', 'd2', 'd3']);
  assert.deepEqual(w.following.map((t) => t.content), ['p7']);
  // No running row: first unfinished anchors the window.
  const w2 = todoFocusWindow(items.map((t) => ({ ...t, status: 'completed' })).concat([
    { content: 'p8', status: 'pending' },
    { content: 'p9', status: 'pending' },
  ]));
  assert.equal(w2.compact, true);
  assert.deepEqual(w2.focus.map((t) => t.content), ['p7', 'p8', 'p9']);
  assert.equal(w2.preceding.length, 7);
  assert.equal(w2.following.length, 0);
  // All done: the tail stays visible.
  const w3 = todoFocusWindow(items.map((t) => ({ ...t, status: 'completed' })));
  assert.equal(w3.compact, true);
  assert.deepEqual(w3.focus.map((t) => t.content), ['p5', 'p6', 'p7']);
  assert.equal(w3.preceding.length, 5);
});

test('todoFoldLabel picks Mcode’s four cases', () => {
  const done = [{ status: 'completed' }, { status: 'completed' }];
  const mixed = [{ status: 'completed' }, { status: 'pending' }];
  const waiting = [{ status: 'pending' }, { status: 'pending' }];
  assert.equal(todoFoldLabel(done, 'preceding'), 'เสร็จแล้ว 2 รายการ');
  assert.equal(todoFoldLabel(mixed, 'preceding'), 'ก่อนหน้า 2 รายการ');
  assert.equal(todoFoldLabel(waiting, 'following'), 'รอทำ 2 รายการ');
  assert.equal(todoFoldLabel(mixed, 'following'), 'ถัดไป 2 รายการ');
});

test('goal snapshot persists and rehydrates after a host restart (1.1.30)', () => {
  const file = tmpFile();
  const wire = fakeWire();
  const store = new SessionStore({ file, debounceMs: 5 });
  const mgr = new SessionManager({ store, wire, searchDbPath: tmpSearchDb() });
  const chat = mgr.createChat({ title: 'goal-persist' });
  const slot = { client: null, turn: null, goal: null, subagents: new Map() };
  mgr.slots.set(chat.id, slot);
  mgr._onUpdate(chat.id, {
    sessionUpdate: 'msp:goal',
    goal: {
      objective: 'Ship it', percentComplete: 42, status: 'running',
      currentWork: 'wiring', nextWork: 'tests',
    },
  });
  assert.equal(mgr.getGoal(chat.id)?.objective, 'Ship it');
  assert.equal(store.get(chat.id)?.goal?.percentComplete, 42, 'msp:goal mirrors to the store');
  const before = store.get(chat.id).updatedAt;
  mgr._onUpdate(chat.id, {
    sessionUpdate: 'msp:goal',
    goal: { objective: 'Ship it', percentComplete: 43, status: 'running' },
  });
  assert.equal(store.get(chat.id).updatedAt, before, 'goal ticks never reshuffle queue order');
  store.flushNow();

  // Fresh host, same disk: cold chat still shows the last known goal.
  const store2 = new SessionStore({ file, debounceMs: 5 });
  const mgr2 = new SessionManager({ store: store2, wire: fakeWire(), searchDbPath: tmpSearchDb() });
  const g = mgr2.getGoal(chat.id);
  assert.equal(g?.objective, 'Ship it');
  assert.equal(g?.percentComplete, 43);
  assert.equal(g?.status, 'running');
});

test('goal snapshot binds to its session: rotation retires, resume retains', () => {
  const file = tmpFile();
  const store = new SessionStore({ file, debounceMs: 5 });
  const mgr = new SessionManager({ store, wire: fakeWire(), searchDbPath: tmpSearchDb() });
  const chat = mgr.createChat({ title: 'goal-bound' });
  store.update(chat.id, { mspSessionId: 'sess-one' });
  const slot = { client: { sessionId: 'sess-one' }, turn: null, goal: null, subagents: new Map() };
  mgr.slots.set(chat.id, slot);
  mgr._onUpdate(chat.id, {
    sessionUpdate: 'msp:goal',
    goal: { objective: 'Bound', percentComplete: 10, status: 'running' },
  });
  assert.equal(store.get(chat.id)?.goal?.sessionId, 'sess-one', 'snapshot stamps the origin');
  mgr.slots.delete(chat.id); // cold from here on — store fallback decides
  assert.equal(mgr.getGoal(chat.id)?.objective, 'Bound', 'resume (same id) retains');
  store.update(chat.id, { mspSessionId: 'sess-two' }); // rotation swaps the id
  assert.equal(mgr.getGoal(chat.id), null, 'rotation retires the stale snapshot');
  // Legacy snapshots without a stamp keep the old retain behavior.
  store.update(chat.id, { goal: { objective: 'Legacy', percentComplete: 5, status: 'running' } });
  assert.equal(mgr.getGoal(chat.id)?.objective, 'Legacy');
});

test('goal snapshot validation: malformed disk state reads as no goal', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ chats: [{ id: 'c1', goal: 'bogus' }] }));
  const store = new SessionStore({ file, debounceMs: 5 });
  assert.equal(store.get('c1')?.goal, null);
});

test('live goal retires on actual session rotation, retains on same-id resume', () => {
  const { store, wire, mgr } = manager();
  const chat = mgr.createChat({ title: 'goal-live-bound' });
  // Live slot with a goal ingested under session A.
  const slot = { client: { sessionId: 'sess-A' }, turn: null, goal: null, subagents: new Map() };
  mgr.slots.set(chat.id, slot);
  mgr._onUpdate(chat.id, {
    sessionUpdate: 'msp:goal',
    goal: { objective: 'Live', percentComplete: 10, status: 'running' },
  });
  assert.equal(mgr.getGoal(chat.id)?.objective, 'Live');
  assert.equal(slot.goalSessionId, 'sess-A', 'live goal stamps its origin session');

  // Exit + respawn under the SAME id (ordinary resume): retained, silent.
  slot.client = null; // agent exit
  assert.equal(mgr.getGoal(chat.id)?.objective, 'Live', 'cold slot keeps last-known');
  slot.client = { sessionId: 'sess-A' }; // resume
  assert.equal(mgr._retireGoalOnRotation(chat.id, slot, 'sess-A'), false);
  assert.equal(mgr.getGoal(chat.id)?.objective, 'Live', 'same-id resume retains');
  assert.equal(
    wire.of('goal').filter((e) => e.goal == null).length,
    0,
    'no invalidation broadcast on ordinary resume',
  );

  // Exit + respawn under a NEW id (rotation / resume miss): retired loudly.
  slot.client = null;
  slot.client = { sessionId: 'sess-B' };
  assert.equal(mgr._retireGoalOnRotation(chat.id, slot, 'sess-B'), true);
  assert.equal(mgr.getGoal(chat.id), null, 'rotated goal reads null');
  assert.equal(store.get(chat.id)?.goal, null, 'persisted snapshot retires too');
  const nulls = wire.of('goal').filter((e) => e.chatId === chat.id && e.goal == null);
  assert.equal(nulls.length, 1, 'one authoritative goal:null invalidates renderer mirrors');

  // Backstop: a session swap that bypassed the hook still reads null.
  slot.goal = { objective: 'Smuggled', percentComplete: 1, status: 'running' };
  slot.goalSessionId = 'sess-A';
  slot.client = { sessionId: 'sess-C' };
  assert.equal(mgr.getGoal(chat.id), null, 'a live goal bound to another session never leaks');
});

test('persisted-only goal retires on a new session id, retains on same id', () => {
  const { store, wire, mgr } = manager();
  const chat = mgr.createChat({ title: 'goal-persisted-only' });
  // Pre-restart goal persisted under session A, then a host restart (or
  // slot eviction): a FRESH slot with no live goal at all (undefined),
  // booting under a new client id B. The saved goal must retire loudly.
  store.saveGoal(chat.id, { objective: 'Persisted', percentComplete: 20, status: 'running' }, 'sess-A');
  store.update(chat.id, { mspSessionId: 'sess-A' });
  const slot = { client: { sessionId: 'sess-B' }, turn: null, subagents: new Map() };
  mgr.slots.set(chat.id, slot);
  assert.equal(mgr._retireGoalOnRotation(chat.id, slot, 'sess-B'), true);
  assert.equal(mgr.getGoal(chat.id), null, 'rotated persisted goal reads null');
  assert.equal(store.get(chat.id)?.goal, null, 'saved snapshot retires too');
  const nulls = () => wire.of('goal').filter((e) => e.chatId === chat.id && e.goal == null);
  assert.equal(nulls().length, 1, 'exactly one authoritative goal:null');
  // Idempotent: a second pass finds nothing to retire and stays silent.
  assert.equal(mgr._retireGoalOnRotation(chat.id, slot, 'sess-B'), false);
  assert.equal(nulls().length, 1, 'no duplicate invalidation');

  // Same-id persisted-only resume: retained, silent.
  store.saveGoal(chat.id, { objective: 'Persisted', percentComplete: 20, status: 'running' }, 'sess-A');
  const slot2 = { client: { sessionId: 'sess-A' }, turn: null, subagents: new Map() };
  mgr.slots.set(chat.id, slot2);
  assert.equal(mgr._retireGoalOnRotation(chat.id, slot2, 'sess-A'), false);
  assert.equal(mgr.getGoal(chat.id)?.objective, 'Persisted', 'same-id resume retains the snapshot');
  assert.equal(nulls().length, 1, 'no invalidation on same-id resume');

  // No proven new id, no proven rotation: an unknown boot id never wipes.
  assert.equal(mgr._retireGoalOnRotation(chat.id, slot2, null), false);
  assert.equal(store.get(chat.id)?.goal?.objective, 'Persisted');
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
console.log(`goal-tasks: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
