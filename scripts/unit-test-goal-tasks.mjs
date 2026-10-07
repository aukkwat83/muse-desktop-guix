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
