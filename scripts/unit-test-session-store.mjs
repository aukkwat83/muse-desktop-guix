#!/usr/bin/env node
// Store guarantees — above all: state a restart depends on is written before
// the process can die, and a turn can never produce two assistant messages.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SessionStore, deriveTitle } from '../src/server/session-store.js';
import { hasLoneSurrogate } from '../src/server/text.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-store-'));
  return path.join(dir, 'chats.json');
}

test('create writes through immediately', () => {
  const file = tmpFile();
  const store = new SessionStore({ file, debounceMs: 10_000 });
  const chat = store.create({ title: 'hello', cwd: '/tmp' });
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.chats.length, 1);
  assert.equal(onDisk.chats[0].id, chat.id);
});

test('new chats default to yolo mode + ultra effort', () => {
  const file = tmpFile();
  const store = new SessionStore({ file, debounceMs: 10_000 });
  const chat = store.create({ title: 'x' });
  assert.equal(chat.mode, 'always');
  assert.equal(chat.effort, 'ultra');
  const explicit = store.create({ title: 'y', mode: 'normal', effort: 'low' });
  assert.equal(explicit.mode, 'normal');
  assert.equal(explicit.effort, 'low');
});

test('mspSessionId is flushed synchronously, not debounced', () => {
  // This is the bug that made grok rotate its agent session on every restart:
  // the id changed in memory, the debounce lost the race with exit, and the
  // next boot retried an id the agent had already discarded.
  const file = tmpFile();
  const store = new SessionStore({ file, debounceMs: 10_000 });
  const chat = store.create({ title: 'x' });
  store.update(chat.id, { mspSessionId: 'agent-abc' });
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.chats[0].mspSessionId, 'agent-abc');
});

test('ordinary field updates are debounced (not on disk yet)', () => {
  const file = tmpFile();
  const store = new SessionStore({ file, debounceMs: 10_000 });
  const chat = store.create({ title: 'x' });
  store.update(chat.id, { title: 'renamed' });
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.chats[0].title, 'x');
  assert.equal(store.get(chat.id).title, 'renamed');
});

test('setAssistantMessage updates in place for the same turn', () => {
  const file = tmpFile();
  const store = new SessionStore({ file, debounceMs: 5 });
  const chat = store.create({ title: 'x' });
  store.setAssistantMessage(chat.id, 'turn-1', 'partial');
  store.setAssistantMessage(chat.id, 'turn-1', 'partial + more');
  store.setAssistantMessage(chat.id, 'turn-1', 'final');
  const assistants = store.get(chat.id).messages.filter((m) => m.role === 'assistant');
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0].text, 'final');
});

test('a different turn gets its own message', () => {
  const file = tmpFile();
  const store = new SessionStore({ file, debounceMs: 5 });
  const chat = store.create({ title: 'x' });
  store.setAssistantMessage(chat.id, 'turn-1', 'one');
  store.setAssistantMessage(chat.id, 'turn-2', 'two');
  assert.equal(store.get(chat.id).messages.filter((m) => m.role === 'assistant').length, 2);
});

test('first user message titles the chat, later ones do not', () => {
  const file = tmpFile();
  const store = new SessionStore({ file, debounceMs: 5 });
  const chat = store.create({});
  store.addMessage(chat.id, { role: 'user', text: 'ช่วยดู log ให้หน่อย' });
  assert.equal(store.get(chat.id).title, 'ช่วยดู log ให้หน่อย');
  store.addMessage(chat.id, { role: 'user', text: 'อีกคำถาม' });
  assert.equal(store.get(chat.id).title, 'ช่วยดู log ให้หน่อย');
});

test('deriveTitle strips code fences and truncates', () => {
  assert.equal(deriveTitle(''), 'New chat');
  assert.equal(deriveTitle('```js\nconst a=1\n```  hello'), 'hello');
  assert.ok(deriveTitle('x'.repeat(200)).endsWith('…'));
});

test('deriveTitle never splits an emoji at the cut', () => {
  // 'x' + emoji run: UTF-16 offset 60 lands mid-emoji — slice() would orphan
  // a lone surrogate (� in the sidebar).
  const t = deriveTitle(`x${'🎉'.repeat(100)}`);
  assert.equal(hasLoneSurrogate(t), false);
  assert.ok(t.endsWith('…'));
});

test('reload from disk preserves chats and messages', () => {
  const file = tmpFile();
  const a = new SessionStore({ file, debounceMs: 5 });
  const chat = a.create({ title: 'persisted' });
  a.addMessage(chat.id, { role: 'user', text: 'hi' });
  a.flushNow();

  const b = new SessionStore({ file });
  assert.equal(b.list().length, 1);
  assert.equal(b.get(chat.id).messages[0].text, 'hi');
});

test('a corrupt file starts empty rather than throwing', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ this is not json', 'utf8');
  const store = new SessionStore({ file });
  assert.deepEqual(store.list(), []);
});

test('trimMessages keeps the newest window', () => {
  const file = tmpFile();
  const store = new SessionStore({ file, debounceMs: 5 });
  const chat = store.create({});
  for (let i = 0; i < 20; i++) store.addMessage(chat.id, { role: 'user', text: `m${i}` });
  store.trimMessages(chat.id, 5);
  const msgs = store.get(chat.id).messages;
  assert.equal(msgs.length, 5);
  assert.equal(msgs.at(-1).text, 'm19');
});

test('remove deletes and persists', () => {
  const file = tmpFile();
  const store = new SessionStore({ file, debounceMs: 10_000 });
  const chat = store.create({});
  assert.equal(store.remove(chat.id), true);
  assert.equal(store.remove(chat.id), false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).chats.length, 0);
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
console.log(`session-store: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
