#!/usr/bin/env node
// Group model: migration, ordering, deletion rules and chat membership.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SessionStore } from '../src/server/session-store.js';
import { SessionManager } from '../src/server/sessions.js';
import { hasLoneSurrogate } from '../src/server/text.js';

// createChat background-warms by default — pin it off so unit tests never
// spawn a real agent (each suite is its own process).
process.env.MUSE_DESKTOP_CREATE_WARM = '0';
// Host-origin banners stay off here — unit suites never touch a desktop.
process.env.MUSE_DESKTOP_NOTIFY = 'off';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'muse-groups-')), 'chats.json');
}

function freshStore() {
  return new SessionStore({ file: tmpFile(), debounceMs: 5 });
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
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'muse-groups-idx-')), 'search.sqlite');
}

function manager() {
  const store = freshStore();
  const wire = fakeWire();
  return { store, wire, mgr: new SessionManager({ store, wire, searchDbPath: tmpSearchDb() }) };
}

const names = (store) => store.listGroups().map((g) => g.name);

test('a fresh store always has one group', () => {
  const store = freshStore();
  assert.equal(store.listGroups().length, 1);
  assert.equal(store.activeGroupId, store.listGroups()[0].id);
});

test('a v1 file (no groups) migrates into one default group', () => {
  const file = tmpFile();
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      chats: [
        { id: 'a', title: 'one', messages: [] },
        { id: 'b', title: 'two', messages: [] },
      ],
    }),
    'utf8',
  );
  const store = new SessionStore({ file, debounceMs: 5 });
  const groups = store.listGroups();
  assert.equal(groups.length, 1);
  assert.equal(store.list().length, 2);
  for (const chat of store.list()) assert.equal(chat.groupId, groups[0].id);
  assert.equal(store.activeGroupId, groups[0].id);
});

test('a chat pointing at a group that no longer exists is rehomed', () => {
  const file = tmpFile();
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 2,
      groups: [{ id: 'g1', name: 'Keep', order: 0 }],
      chats: [{ id: 'a', title: 'orphan', groupId: 'ghost', messages: [] }],
    }),
    'utf8',
  );
  const store = new SessionStore({ file, debounceMs: 5 });
  assert.equal(store.get('a').groupId, 'g1');
});

test('a new group lands on top', () => {
  const store = freshStore();
  const a = store.listGroups()[0];
  store.createGroup({ name: 'B' });
  store.createGroup({ name: 'C' });
  assert.deepEqual(names(store), ['C', 'B', a.name]);
  assert.deepEqual(store.listGroups().map((g) => g.order), [0, 1, 2]);
});

test('position bottom appends (the ＋ group tab lands where it sits)', () => {
  const store = freshStore();
  const a = store.listGroups()[0];
  store.createGroup({ name: 'Top' });
  store.createGroup({ name: 'Bottom', position: 'bottom' });
  assert.deepEqual(names(store), ['Top', a.name, 'Bottom']);
  assert.deepEqual(store.listGroups().map((g) => g.order), [0, 1, 2]);
});

test('reorder actually reorders — and survives a reload', () => {
  // Regression: renumbering used to re-sort by the *old* order values first,
  // which put the list straight back and made the drag look like a no-op.
  const store = freshStore();
  const a = store.listGroups()[0];
  const b = store.createGroup({ name: 'B' });
  const c = store.createGroup({ name: 'C' });
  assert.deepEqual(names(store), ['C', 'B', a.name]); // newest on top

  store.reorderGroups([c.id, a.id, b.id]);
  assert.deepEqual(names(store), ['C', a.name, 'B']);
  assert.deepEqual(
    store.listGroups().map((g) => g.order),
    [0, 1, 2],
    'order must be renumbered densely',
  );

  const reloaded = new SessionStore({ file: store.file });
  assert.deepEqual(names(reloaded), ['C', a.name, 'B']);
});

test('reorder tolerates a partial or stale id list', () => {
  const store = freshStore();
  const a = store.listGroups()[0];
  const b = store.createGroup({ name: 'B' });
  store.createGroup({ name: 'C' });
  store.reorderGroups([b.id, 'nonexistent-id']);
  assert.equal(names(store)[0], 'B');
  assert.equal(store.listGroups().length, 3, 'no group may be lost');
});

test('the last group cannot be deleted', () => {
  const store = freshStore();
  assert.equal(store.removeGroup(store.listGroups()[0].id), null);
  assert.equal(store.listGroups().length, 1);
});

test('deleting a group takes its chats and reports them', () => {
  const store = freshStore();
  const first = store.listGroups()[0];
  const second = store.createGroup({ name: 'Second' });
  const keep = store.create({ title: 'keep', groupId: first.id });
  const doomedA = store.create({ title: 'a', groupId: second.id });
  const doomedB = store.create({ title: 'b', groupId: second.id });

  const result = store.removeGroup(second.id);
  assert.deepEqual(result.removedChatIds.sort(), [doomedA.id, doomedB.id].sort());
  assert.equal(store.list().length, 1);
  assert.equal(store.get(keep.id).title, 'keep');
  assert.equal(store.activeGroupId, first.id, 'active group must not dangle');
});

test('new chats land in the requested group, else the active one', () => {
  const store = freshStore();
  const first = store.listGroups()[0];
  const second = store.createGroup({ name: 'Second' });

  assert.equal(store.create({ title: 'x' }).groupId, first.id);
  assert.equal(store.create({ title: 'y', groupId: second.id }).groupId, second.id);

  store.setActiveGroup(second.id);
  assert.equal(store.create({ title: 'z' }).groupId, second.id);
});

test('moveChat requires both sides to exist', () => {
  const store = freshStore();
  const second = store.createGroup({ name: 'Second' });
  const chat = store.create({ title: 'movable' });
  assert.equal(store.moveChat(chat.id, 'ghost'), null);
  assert.equal(store.moveChat('ghost', second.id), null);
  assert.equal(store.moveChat(chat.id, second.id).groupId, second.id);
  assert.equal(store.listInGroup(second.id).length, 1);
});

test('listInGroup is newest-first', () => {
  const store = freshStore();
  const g = store.listGroups()[0].id;
  const older = store.create({ title: 'older', groupId: g });
  const newer = store.create({ title: 'newer', groupId: g });
  store.addMessage(newer.id, { role: 'user', text: 'bump' }); // activity moves it
  assert.equal(store.listInGroup(g)[0].id, newer.id);
  assert.equal(store.listInGroup(g)[1].id, older.id);
});

test('metadata update never reorders the queue', () => {
  const store = freshStore();
  const g = store.listGroups()[0].id;
  // Pin the clock: two creates inside one ms share an updatedAt and the
  // queue order between them is meaningless.
  const realNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    const first = store.create({ title: 'first', groupId: g });
    now += 1000;
    store.create({ title: 'second', groupId: g });
    now += 1000;
    const before = store.get(first.id).updatedAt;
    // Mode flip, model pick, agent spawn id, title edit — none is
    // conversation activity, so none may move the row.
    store.update(first.id, { title: 'first (renamed)' });
    store.update(first.id, { mode: 'plan' });
    store.update(first.id, { model: 'muse-x', effort: 'high' });
    store.update(first.id, { mspSessionId: 'sess-live' });
    assert.equal(store.get(first.id).updatedAt, before);
    assert.equal(store.listInGroup(g)[0].title, 'second');
    assert.equal(store.listInGroup(g)[1].id, first.id);
  } finally {
    Date.now = realNow;
  }
});

test('a prompt floats the continued session to the top', () => {
  const { mgr, store } = manager();
  const g = store.listGroups()[0].id;
  const realNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    const first = store.create({ title: 'first', groupId: g });
    now += 1000;
    store.create({ title: 'second', groupId: g });
    now += 1000;
    assert.equal(mgr.listChats()[0].title, 'second');

    store.addMessage(first.id, { role: 'user', text: 'continued' });
    assert.equal(mgr.listChats()[0].id, first.id, 'the prompted session must lead the queue');
  } finally {
    Date.now = realNow;
  }
});

test('a settled run floats the session to the top and persists', () => {
  const { mgr, store } = manager();
  const g = store.listGroups()[0].id;
  const realNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    const first = store.create({ title: 'first', groupId: g });
    now += 1000;
    store.create({ title: 'second', groupId: g });
    now += 1000;
    store.setAssistantMessage(first.id, 'turn-1', 'done');
    assert.equal(mgr.listChats()[0].id, first.id, 'the just-settled session must lead the queue');
  } finally {
    Date.now = realNow;
  }

  store.flushNow();
  const reloaded = new SessionStore({ file: store.file });
  assert.equal(
    reloaded.listInGroup(g)[0].title,
    'first',
    'the settle must survive a reload',
  );
});

test('manager reports per-group counts and broadcasts changes', () => {
  const { mgr, store, wire } = manager();
  const second = mgr.createGroup({ name: 'Second' });
  store.create({ title: 'a', groupId: second.id });
  store.create({ title: 'b', groupId: second.id });

  const listed = mgr.listGroups().find((g) => g.id === second.id);
  assert.equal(listed.chatCount, 2);
  assert.equal(listed.runningCount, 0);
  assert.equal(wire.of('group_created').length, 1);

  mgr.renameGroup(second.id, 'Renamed');
  assert.equal(wire.of('group_updated').length, 1);
  assert.equal(mgr.listGroups().find((g) => g.id === second.id).name, 'Renamed');

  mgr.reorderGroups(mgr.listGroups().map((g) => g.id).reverse());
  assert.equal(wire.of('groups_reordered').length, 1);
});

test('deleting the last group is refused at the manager too', async () => {
  const { mgr, store } = manager();
  const only = store.listGroups()[0];
  assert.equal(await mgr.removeGroup(only.id), null);
  assert.equal(store.listGroups().length, 1);
});

test('reuseEmpty is scoped to the group being added to', () => {
  const { mgr, store } = manager();
  const first = store.listGroups()[0];
  const second = mgr.createGroup({ name: 'Second' });

  const a = mgr.createChat({ reuseEmpty: true, groupId: first.id });
  const b = mgr.createChat({ reuseEmpty: true, groupId: first.id });
  assert.equal(a.id, b.id, 'same group ⇒ reuse');

  const c = mgr.createChat({ reuseEmpty: true, groupId: second.id });
  assert.notEqual(c.id, a.id, 'a blank chat in another group must not be hijacked');
  assert.equal(c.groupId, second.id);
});

test('chat summaries expose groupId and a preview', () => {
  const { mgr, store } = manager();
  const chat = store.create({ title: 'x' });
  store.addMessage(chat.id, { role: 'user', text: 'ช่วยดู log หน่อย' });
  store.addMessage(chat.id, { role: 'assistant', text: '```js\ncode\n```\nดูให้แล้ว' });
  const summary = mgr.chatSummary(store.get(chat.id));
  assert.equal(summary.groupId, store.listGroups()[0].id);
  assert.match(summary.preview, /ดูให้แล้ว/);
  assert.ok(!summary.preview.includes('```'), 'code fences must not leak into the preview');
});

test('chat preview never splits an emoji at the cut', () => {
  const { mgr, store } = manager();
  const chat = store.create({ title: 'e' });
  // 'y' + emoji run: UTF-16 offset 90 lands mid-emoji.
  store.addMessage(chat.id, { role: 'user', text: `y${'🚀'.repeat(100)}` });
  const summary = mgr.chatSummary(store.get(chat.id));
  assert.equal(hasLoneSurrogate(summary.preview), false);
  assert.ok(summary.preview.endsWith('…'));
});

test('chat summaries expose the agent session id (stored, live wins)', () => {
  const { mgr, store } = manager();
  const chat = store.create({ title: 'x' });
  assert.equal(mgr.chatSummary(store.get(chat.id)).mspSessionId, null);
  store.update(chat.id, { mspSessionId: 'stored-1' });
  assert.equal(mgr.chatSummary(store.get(chat.id)).mspSessionId, 'stored-1');
  // A hot client reports its own id — the stored copy lags during rotation.
  mgr.slots.set(chat.id, { client: { sessionId: 'live-2' } });
  assert.equal(mgr.chatSummary(store.get(chat.id)).mspSessionId, 'live-2');
});

test('SessionManager honors searchDbPath — suite index never touches the real one', () => {
  const dbPath = tmpSearchDb();
  const store = freshStore();
  const mgr = new SessionManager({ store, wire: fakeWire(), searchDbPath: dbPath });
  assert.equal(mgr.searchIndex.dbPath, dbPath);
  const chat = store.create({ title: 'search seam probe', cwd: os.tmpdir() });
  store.addMessage(chat.id, { role: 'user', text: 'zz9 hermetic marker' });
  mgr.searchIndex.flushNow();
  assert.ok(fs.existsSync(dbPath), 'the index file must live at the given path');
  const r = mgr.search('zz9 hermetic');
  assert.ok(r.ok && r.hits.some((h) => h.sessionId === chat.id), 'fixture must round-trip through the temp index');
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
console.log(`groups: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
