#!/usr/bin/env node
// Subagent rail: the renderer's pure view-model (status words, titles,
// drill previews, owner-verb availability), the server's registry mirror
// (persist/seed/fallback so rows survive a restart), and the owner-verb
// guards + wire shape (stop/resume/send → subagent/* with a UUIDv7
// commandId against the parent session).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// createChat background-warms by default — pin it off so unit tests never
// spawn a real agent (each suite is its own process).
process.env.MUSE_DESKTOP_CREATE_WARM = '0';

import { sanitizeChildItem } from '../src/server/msp-client.js';
import { SessionStore, SUBAGENT_STORE_CAP, normalizeSubagents } from '../src/server/session-store.js';
import { SUBAGENT_COMMANDS, agentRowLink, extractReminderDecision, nativeSubagentPatch, reminderDecisionLine, sanitizeDrillItem, SessionManager } from '../src/server/sessions.js';
import {
  OVERVIEW_WIRE_CAP,
  SUBAGENT_ACTION_LABEL,
  childWindowUrl,
  drillItemPreview,
  drillKindTag,
  overviewSubagentRows,
  partitionReminders,
  subagentActions,
  subagentDotClass,
  subagentStatusWord,
  subagentSub,
  subagentTitle,
} from '../src/renderer/rightbar.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'muse-subagents-')), 'chats.json');
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
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'muse-subagents-idx-')), 'search.sqlite');
}

function manager() {
  const store = new SessionStore({ file: tmpFile(), debounceMs: 5 });
  const wire = fakeWire();
  return { store, wire, mgr: new SessionManager({ store, wire, searchDbPath: tmpSearchDb() }) };
}

const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function kid(over = {}) {
  return {
    itemId: 'sub-1', kind: 'subagent', status: 'inProgress', subagentId: 'sub-a',
    agentPath: 'researcher', role: 'research', objective: 'research caches',
    depth: 1, controlStatus: 'running', childSessionId: 'child-1',
    updatedAt: 1000, ...over,
  };
}

// ------------------------------------------------------- rail view-model

test('subagent words + dots cover the MSP child states', () => {
  assert.equal(subagentStatusWord('inProgress'), 'กำลังรัน');
  assert.equal(subagentStatusWord('completed'), 'เสร็จ');
  assert.equal(subagentStatusWord('failed'), 'ล้มเหลว');
  assert.equal(subagentStatusWord('cancelled'), 'ยกเลิก');
  assert.equal(subagentStatusWord(null), '—');
  assert.equal(subagentStatusWord('weird-future'), 'weird-future');
  assert.equal(subagentDotClass('inProgress'), 'dot run');
  assert.equal(subagentDotClass('completed'), 'dot ok');
  assert.equal(subagentDotClass('failed'), 'dot bad');
  assert.equal(subagentDotClass('cancelled'), 'dot idle');
  assert.equal(subagentDotClass('bogus'), 'dot idle');
});

test('subagent titles prefer role, subs fold workflow children', () => {
  assert.equal(subagentTitle(kid()), 'research');
  assert.equal(subagentTitle(kid({ role: null })), 'researcher');
  assert.equal(subagentTitle({ kind: 'workflow', entryId: 'e1' }), 'e1');
  assert.equal(subagentTitle({}), 'child');
  assert.equal(subagentSub(kid()), 'depth 1 · running · research caches');
  assert.equal(
    subagentSub({ kind: 'workflow', children: [{}, {}], message: 'done' }),
    '2 children · done',
  );
  assert.equal(subagentSub({ kind: 'subagent', durationMs: 2500 }), '2.5s');
});

test('drill previews prefer text, then summary, then tool shape', () => {
  assert.equal(drillKindTag('agentMessage'), 'ตอบ');
  assert.equal(drillKindTag('userMessage'), 'ถาม');
  assert.equal(drillKindTag('toolCall'), 'tool');
  assert.equal(drillKindTag('subagent'), 'subagent');
  assert.equal(drillKindTag('workflow'), 'workflow');
  assert.equal(drillKindTag('reasoning'), 'คิด');
  assert.equal(drillKindTag('bogus'), 'bogus');
  assert.equal(drillItemPreview({ text: 'hi' }), 'hi');
  assert.equal(drillItemPreview({ result: { summary: 's' } }), 's');
  assert.equal(drillItemPreview({ tool: 'Bash', fallbackText: 'out' }), 'Bash → out');
  assert.equal(drillItemPreview({ tool: 'Bash' }), 'Bash');
  assert.equal(drillItemPreview({ objective: 'o' }), 'o');
  assert.equal(drillItemPreview({}), '');
});

test('native + reminder titles lead with the readable identity', () => {
  assert.equal(subagentTitle({ kind: 'native', taskName: 'alpha-probe', role: 'research' }), 'alpha-probe');
  assert.equal(
    subagentTitle({ kind: 'reminderChild', reminderAgentId: 'skill-reminder', fallbackText: 'Reminder child session' }),
    'skill-reminder',
  );
  assert.equal(subagentTitle({ kind: 'reminderChild', fallbackText: 'Reminder child session' }), 'Reminder child session');
  assert.equal(subagentTitle(null), 'child');
  // The wire's one-size line is never a topic — a bare row shows its gen
  // until the server folds the verdict (or the stream while it runs).
  assert.equal(
    subagentSub({ kind: 'reminderChild', generationId: '17', fallbackText: 'Reminder child session' }),
    'gen 17',
  );
  assert.equal(
    subagentSub({ kind: 'reminderChild', generationId: 3, result: { summary: 'remind: capture it' } }),
    'gen 3 · remind: capture it',
  );
  assert.equal(
    subagentSub({ kind: 'reminderChild', generationId: 2, status: 'inProgress', liveText: 'scanning skills…' }),
    'gen 2 · scanning skills…',
  );
  assert.equal(
    subagentSub({ kind: 'reminderChild', generationId: 1, fallbackText: 'custom note' }),
    'gen 1 · custom note',
    'a fallback that says something real still shows',
  );
  assert.equal(
    subagentSub({ kind: 'native', taskName: 'a', objective: 'do a', durationMs: 1500 }),
    '1.5s',
    'task-named rows do not repeat the objective they already headline',
  );
});

test('partitionReminders folds system noise below real children', () => {
  const recs = [
    { itemId: 'rem-1', kind: 'reminderChild' },
    { itemId: 'native:x', kind: 'native' },
    { itemId: 'sub-1', kind: 'subagent' },
    { itemId: 'rem-2', kind: 'reminderChild' },
  ];
  const { main, reminders } = partitionReminders(recs);
  assert.deepEqual(main.map((r) => r.itemId), ['native:x', 'sub-1']);
  assert.deepEqual(reminders.map((r) => r.itemId), ['rem-1', 'rem-2']);
  assert.deepEqual(partitionReminders(null), { main: [], reminders: [] });
});

test('overview rows prefer the live turn, else the wire children (1.1.29)', () => {
  const tool = { id: 't1' };
  assert.deepEqual(overviewSubagentRows([tool], [{ itemId: 'w1' }]), { kind: 'turn', tools: [tool] });
  assert.deepEqual(overviewSubagentRows([], []), { kind: 'empty' });
  assert.deepEqual(overviewSubagentRows(null, null), { kind: 'empty' });
  const wire = overviewSubagentRows([], [{ itemId: 'w1', kind: 'subagent', status: 'inProgress', updatedAt: 2 }]);
  assert.equal(wire.kind, 'wire');
  assert.deepEqual(wire.main.map((r) => r.itemId), ['w1']);
  assert.equal(wire.hiddenMain, 0);
  assert.equal(wire.reminders, 0);
  assert.equal(wire.remindersRunning, 0);
});

test('overview wire rows sort newest first, cap mains, fold reminders (1.1.29)', () => {
  const recs = [];
  for (let i = 0; i < OVERVIEW_WIRE_CAP + 3; i++) {
    recs.push({ itemId: `sub-${i}`, kind: 'subagent', status: 'completed', updatedAt: 100 + i });
  }
  recs.push(
    { itemId: 'rem-run', kind: 'reminderChild', status: 'inProgress', updatedAt: 1 },
    { itemId: 'rem-done', kind: 'reminderChild', status: 'completed', updatedAt: 2 },
  );
  const s = overviewSubagentRows([], recs);
  assert.equal(s.kind, 'wire');
  assert.equal(s.main.length, OVERVIEW_WIRE_CAP);
  assert.deepEqual(s.main.map((r) => r.itemId)[0], `sub-${OVERVIEW_WIRE_CAP + 2}`);
  assert.equal(s.hiddenMain, 3);
  assert.equal(s.reminders, 2);
  assert.equal(s.remindersRunning, 1);
});

test('nativeSubagentPatch folds the probed spawn/wait shapes', () => {
  const spawn = nativeSubagentPatch({
    toolCallId: 'tc-1',
    kind: 'subagent_spawn',
    rawInput: JSON.stringify({ objective: 'answer alpha', role: 'research', task_name: 'alpha-probe' }),
    output: JSON.stringify({ status: 'accepted', subagent_id: 'sub-a', agent_path: 'main/alpha-probe/1', task_ref: 't#1' }),
    status: 'completed',
  });
  assert.deepEqual(spawn, {
    key: 'native:sub-a',
    rec: {
      status: 'inProgress', subagentId: 'sub-a', agentPath: 'main/alpha-probe/1',
      role: 'research', objective: 'answer alpha', taskName: 'alpha-probe', taskRef: 't#1',
    },
  });
  const wait = nativeSubagentPatch({
    toolCallId: 'tc-2',
    kind: 'subagent_wait',
    rawInput: JSON.stringify({ subagent_id: 'sub-a', timeout_ms: 30000 }),
    output: JSON.stringify({ status: 'ready', subagent_id: 'sub-a', summary: 'did it', evidence_refs: ['subagent/sub-a/session.jsonl'] }),
    status: 'completed',
  });
  assert.equal(wait.key, 'native:sub-a');
  assert.equal(wait.rec.status, 'completed');
  assert.equal(wait.rec.result.summary, 'did it');
  assert.deepEqual(wait.rec.result.evidenceRefs, ['subagent/sub-a/session.jsonl']);
  // A timed-out wait leaves the child running; cancel lands it.
  assert.equal(nativeSubagentPatch({
    toolCallId: 'tc-3', kind: 'subagent_wait',
    rawInput: JSON.stringify({ subagent_id: 'sub-a' }),
    output: JSON.stringify({ status: 'timeout', subagent_id: 'sub-a' }),
    status: 'completed',
  }).rec.status, 'inProgress');
  assert.equal(nativeSubagentPatch({
    toolCallId: 'tc-4', kind: 'subagent_cancel',
    rawInput: JSON.stringify({ subagent_id: 'sub-a' }),
    output: JSON.stringify({ status: 'cancelled' }),
    status: 'completed',
  }).rec.status, 'cancelled');
});

test('nativeSubagentPatch degrades clean on partial garbage', () => {
  // Unparseable spawn output: topic kept, keyed by tool call, still running.
  const degraded = nativeSubagentPatch({
    toolCallId: 'tc-9', kind: 'subagent_spawn',
    rawInput: JSON.stringify({ task_name: 'mystery' }),
    output: 'not-json{{{',
    status: 'completed',
  });
  assert.equal(degraded.key, 'native:tool:tc-9');
  assert.equal(degraded.rec.status, 'inProgress');
  assert.equal(degraded.rec.taskName, 'mystery');
  // A rejected spawn fails instead of haunting the rail as running.
  assert.equal(nativeSubagentPatch({
    toolCallId: 'tc-10', kind: 'subagent_spawn',
    rawInput: '{}',
    output: JSON.stringify({ status: 'rejected', subagent_id: 'sub-r' }),
    status: 'completed',
  }).rec.status, 'failed');
  // Wait output with an error fails with the reason attached.
  const failed = nativeSubagentPatch({
    toolCallId: 'tc-11', kind: 'subagent_wait',
    rawInput: JSON.stringify({ subagent_id: 'sub-a' }),
    output: JSON.stringify({ status: 'error', error: 'child blew up' }),
    status: 'completed',
  });
  assert.equal(failed.rec.status, 'failed');
  assert.equal(failed.rec.failureReason, 'child blew up');
  // Non-native tools, fire-and-forget verbs, and id-less waits fold nothing.
  assert.equal(nativeSubagentPatch({ toolCallId: 't', kind: 'Bash', status: 'completed' }), null);
  assert.equal(nativeSubagentPatch({ toolCallId: 't', kind: 'subagent_send_message', status: 'completed' }), null);
  assert.equal(nativeSubagentPatch({ toolCallId: 't', kind: 'subagent_status', status: 'completed' }), null);
  assert.equal(nativeSubagentPatch({ toolCallId: 't', kind: 'subagent_wait', status: 'completed' }), null);
  assert.equal(nativeSubagentPatch({ toolCallId: 't', kind: 'subagent_spawn', status: 'in_progress' }), null);
});

test('agentRowLink keys transcript rows to their registry record', () => {
  // Spawn names the child in its output; wait in its args; both shapes
  // (object or JSON string) link — the wire mixes them.
  assert.equal(agentRowLink({
    id: 'tc-1', kind: 'subagent_spawn', status: 'completed',
    rawInput: JSON.stringify({ task_name: 'alpha' }),
    output: JSON.stringify({ status: 'accepted', subagent_id: 'sub-a' }),
  }), 'native:sub-a');
  assert.equal(agentRowLink({
    id: 'tc-2', kind: 'subagent_wait', status: 'in_progress',
    rawInput: JSON.stringify({ subagent_id: 'sub-a' }),
    output: '',
  }), 'native:sub-a');
  assert.equal(agentRowLink({
    id: 'tc-3', kind: 'subagent_wait', status: 'completed',
    rawInput: { subagent_id: 'sub-b' },
    output: { status: 'ready', subagent_id: 'sub-b' },
  }), 'native:sub-b');
  // A spawn row gains its link when the output lands — null before that.
  assert.equal(agentRowLink({
    id: 'tc-4', kind: 'subagent_spawn', status: 'in_progress',
    rawInput: JSON.stringify({ task_name: 'alpha' }),
    output: '',
  }), null);
  // Plain tools never link, even when their payload mentions an id.
  assert.equal(agentRowLink({
    id: 'tc-5', kind: 'Bash', status: 'completed',
    rawInput: null, output: JSON.stringify({ subagent_id: 'sub-x' }),
  }), null);
  // Model-side Agent rows carry a type but no durable child id — the
  // row's own output is all the wire offers, so they stay unlinked.
  assert.equal(agentRowLink({
    id: 'tc-6', kind: 'other', status: 'completed',
    rawInput: { subagent_type: 'researcher', prompt: 'dig' },
    output: 'found it',
  }), null);
  assert.equal(agentRowLink(null), null);
  assert.equal(agentRowLink({}), null);
});

test('tool_call updates carry agentLink once the child id lands', () => {
  const { wire, mgr } = manager();
  const chat = mgr.createChat({ title: 'linkwire' });
  mgr.slots.set(chat.id, { client: null, turn: null, subagents: new Map() });
  mgr._onUpdate(chat.id, {
    sessionUpdate: 'tool_call', turnId: 'turn-1', toolCallId: 'tc-1',
    kind: 'subagent_spawn', title: 'spawn alpha', status: 'in_progress',
    rawInput: JSON.stringify({ task_name: 'alpha' }),
  });
  mgr._onUpdate(chat.id, {
    sessionUpdate: 'tool_call_update', turnId: 'turn-1', toolCallId: 'tc-1',
    kind: 'subagent_spawn', title: 'spawn alpha', status: 'completed',
    rawInput: JSON.stringify({ task_name: 'alpha' }),
    rawOutput: JSON.stringify({ status: 'accepted', subagent_id: 'sub-a' }),
  });
  const first = wire.of('tool_call').at(-1)?.tool || {};
  const second = wire.of('tool_call_update').at(-1)?.tool || {};
  assert.equal(first.agentLink, undefined, 'no id yet — no link');
  assert.equal(second.agentLink, 'native:sub-a', 'output lands the link');
});

test('tracker merges results and never lets nulls wipe topics', async () => {
  const { store, mgr } = manager();
  const chat = mgr.createChat({ title: 'native' });
  const slot = { client: null, turn: null, subagents: new Map() };
  mgr.slots.set(chat.id, slot);
  mgr._trackNativeSubagent(chat.id, 'turn-1', slot, {
    id: 'tc-1', kind: 'subagent_spawn', status: 'completed',
    rawInput: JSON.stringify({ task_name: 'alpha-probe', objective: 'answer alpha' }),
    output: JSON.stringify({ status: 'accepted', subagent_id: 'sub-a', agent_path: 'main/alpha-probe/1' }),
  });
  mgr._trackNativeSubagent(chat.id, 'turn-1', slot, {
    id: 'tc-2', kind: 'subagent_wait', status: 'completed',
    rawInput: JSON.stringify({ subagent_id: 'sub-a' }),
    output: JSON.stringify({ status: 'ready', subagent_id: 'sub-a', summary: 'did it' }),
  });
  mgr._trackNativeSubagent(chat.id, 'turn-1', slot, {
    id: 'tc-3', kind: 'subagent_read_result', status: 'completed',
    rawInput: JSON.stringify({ subagent_id: 'sub-a' }),
    output: JSON.stringify({ text: 'full result text here' }),
  });
  const rec = slot.subagents.get('native:sub-a');
  assert.equal(rec.status, 'completed');
  assert.equal(rec.taskName, 'alpha-probe', 'wait/read_result must not wipe the spawn topic');
  assert.equal(rec.result.summary, 'did it', 'read_result without a summary keeps the wait one');
  assert.equal(rec.result.text, 'full result text here');
  assert.ok(rec.durationMs >= 0);
  const drill = await mgr.readSubagent(chat.id, 'native:sub-a');
  assert.equal(drill.mode, 'native');
  assert.ok(drill.items.length >= 2);
  assert.ok(drill.items.some((it) => (it.fallbackText || '').includes('alpha-probe')));
});

test('subagentActions gates verbs on kind + id + status', () => {
  assert.deepEqual(subagentActions(kid()), ['stop', 'send']);
  assert.deepEqual(subagentActions(kid({ status: 'completed' })), ['resume']);
  assert.deepEqual(subagentActions(kid({ status: 'failed' })), ['resume']);
  assert.deepEqual(subagentActions(kid({ status: 'cancelled' })), ['resume']);
  // No durable id yet (a child that only just spawned) — nothing to address.
  assert.deepEqual(subagentActions(kid({ subagentId: null })), []);
  // Folds are not addressable children.
  assert.deepEqual(subagentActions({ kind: 'workflow', status: 'completed', subagentId: 'w' }), []);
  assert.deepEqual(subagentActions({ kind: 'reminderChild', status: 'completed', subagentId: 'w' }), []);
  assert.deepEqual(subagentActions(null), []);
  assert.deepEqual(subagentActions({ kind: 'subagent', status: 'bogus', subagentId: 'w' }), []);
  assert.deepEqual(Object.keys(SUBAGENT_ACTION_LABEL).sort(), ['resume', 'send', 'stop']);
});

// ------------------------------------------------------- server verb map

test('SUBAGENT_COMMANDS is the small honest set onto SS3.16', () => {
  assert.deepEqual(SUBAGENT_COMMANDS, {
    stop: 'subagent/stop',
    resume: 'subagent/resume',
    send: 'subagent/sendMessage',
  });
});

// ------------------------------------------------------- registry mirror

test('normalizeSubagents drops malformed rows, strips liveText, caps at 50', () => {
  assert.deepEqual(normalizeSubagents(null), []);
  assert.deepEqual(normalizeSubagents('nope'), []);
  const many = Array.from({ length: SUBAGENT_STORE_CAP + 10 }, (_, i) => kid({ itemId: `s-${i}` }));
  const out = normalizeSubagents([
    ...many,
    null, 'x', 42,
    { kind: 'subagent' }, // no itemId
    { itemId: 'no-kind' }, // no kind
    kid({ itemId: 'live', liveText: 'streaming…' }),
  ]);
  assert.equal(out.length, SUBAGENT_STORE_CAP);
  assert.equal(out[0].itemId, 's-0');
  assert.ok(out.every((r) => !('liveText' in r)), 'liveText must never reach disk');
});

test('saveSubagents persists per chat without touching queue order', () => {
  const { store } = manager();
  const chat = store.create({ title: 'kids' });
  const before = chat.updatedAt;
  const saved = store.saveSubagents(chat.id, [kid(), kid({ itemId: 'wf-1', kind: 'workflow' })]);
  assert.equal(saved.length, 2);
  assert.equal(store.get(chat.id).updatedAt, before, 'registry writes must not reshuffle the sidebar');
  assert.equal(store.saveSubagents('nope', [kid()]), null);
  // saveSubagents debounces — flush before re-reading from disk.
  store.flushNow();
  const reloaded = new SessionStore({ file: store.file, debounceMs: 5 });
  assert.deepEqual(
    reloaded.get(chat.id).subagents.map((r) => r.itemId),
    ['sub-1', 'wf-1'],
  );
});

test('listSubagents + subagentRecord fall back to disk on a cold chat', () => {
  const { store, mgr } = manager();
  const chat = store.create({ title: 'cold' });
  store.saveSubagents(chat.id, [kid({ updatedAt: 5 }), kid({ itemId: 'wf-1', kind: 'workflow', updatedAt: 9 })]);
  // No slot exists — nothing was ever spawned for this chat.
  assert.deepEqual(
    mgr.listSubagents(chat.id).map((r) => r.itemId),
    ['wf-1', 'sub-1'],
    'cold list must serve newest-first from the store',
  );
  assert.equal(mgr.subagentRecord(chat.id, 'sub-1').subagentId, 'sub-a');
  assert.equal(mgr.subagentRecord(chat.id, 'nope'), null);
  // A live slot wins over the store.
  mgr.slots.set(chat.id, { subagents: new Map([['sub-1', kid({ status: 'completed' })]]) });
  assert.equal(mgr.subagentRecord(chat.id, 'sub-1').status, 'completed');
  assert.deepEqual(mgr.listSubagents(chat.id).map((r) => r.itemId), ['sub-1']);
});

// ------------------------------------------------------- owner-verb guards

function chatWithKids(mgr, store) {
  const chat = mgr.createChat({ title: 'cmds' });
  store.saveSubagents(chat.id, [
    kid(),
    kid({ itemId: 'done-1', status: 'completed', subagentId: 'sub-d', result: { summary: 'did' } }),
    { itemId: 'wf-1', kind: 'workflow', status: 'completed', children: [], updatedAt: 3 },
    kid({ itemId: 'young-1', subagentId: null, status: 'inProgress' }),
  ]);
  return chat;
}

test('subagentCommand guards: 404/400/409 before any agent wakes', async () => {
  const { store, mgr } = manager();
  const chat = chatWithKids(mgr, store);
  await assert.rejects(mgr.subagentCommand('nope', 'sub-1', 'stop'), (err) => {
    assert.equal(err.status, 404);
    return true;
  });
  await assert.rejects(mgr.subagentCommand(chat.id, 'nope', 'stop'), (err) => {
    assert.equal(err.status, 404);
    assert.equal(err.code, 'NOT_FOUND');
    return true;
  });
  await assert.rejects(mgr.subagentCommand(chat.id, 'sub-1', 'explode'), (err) => {
    assert.equal(err.status, 400);
    return true;
  });
  await assert.rejects(mgr.subagentCommand(chat.id, 'sub-1', ''), (err) => {
    assert.equal(err.status, 400);
    return true;
  });
  await assert.rejects(mgr.subagentCommand(chat.id, 'wf-1', 'stop'), (err) => {
    assert.equal(err.status, 409);
    assert.equal(err.code, 'UNSUPPORTED');
    return true;
  });
  await assert.rejects(mgr.subagentCommand(chat.id, 'young-1', 'stop'), (err) => {
    assert.equal(err.status, 409);
    assert.equal(err.code, 'NO_SUBAGENT');
    return true;
  });
  await assert.rejects(mgr.subagentCommand(chat.id, 'sub-1', 'send', { body: '   ' }), (err) => {
    assert.equal(err.status, 400);
    return true;
  });
  // None of the above may have spawned: no slot, no client.
  assert.equal(mgr.slots.has(chat.id), false, 'guards must not warm an agent');
});

test('subagentCommand sends the exact wire shape over a live client', async () => {
  const { store, mgr } = manager();
  const chat = chatWithKids(mgr, store);
  const calls = [];
  // ensureClient returns a slot client untouched when it looks alive — no
  // spawn, no mock binary, just the RPC shape under test.
  mgr.slots.set(chat.id, {
    client: {
      sessionId: 'parent-1',
      proc: { exitCode: null },
      request: async (method, params) => {
        calls.push([method, params]);
        return { status: 'accepted' };
      },
    },
    subagents: new Map(),
  });
  const stop = await mgr.subagentCommand(chat.id, 'sub-1', 'stop', { reason: '  enough  ' });
  assert.deepEqual(stop, { action: 'stop', subagentId: 'sub-a' });
  assert.equal(calls[0][0], 'subagent/stop');
  assert.equal(calls[0][1].sessionId, 'parent-1', 'verbs address the child via its parent session');
  assert.equal(calls[0][1].subagentId, 'sub-a');
  assert.equal(calls[0][1].reason, 'enough', 'reason arrives trimmed');
  assert.match(calls[0][1].commandId, UUIDV7_RE, 'commandId must be UUIDv7');
  const send = await mgr.subagentCommand(chat.id, 'sub-1', 'send', { body: '  go left  ' });
  assert.deepEqual(send, { action: 'send', subagentId: 'sub-a' });
  assert.equal(calls[1][0], 'subagent/sendMessage');
  assert.equal(calls[1][1].body, 'go left');
  assert.ok(!('reason' in calls[1][1]), 'send carries no reason field');
  const resume = await mgr.subagentCommand(chat.id, 'done-1', 'resume');
  assert.deepEqual(resume, { action: 'resume', subagentId: 'sub-d' });
  assert.equal(calls[2][0], 'subagent/resume');
  assert.deepEqual(Object.keys(calls[2][1]).sort(), ['commandId', 'sessionId', 'subagentId']);
});

test('subagentCommand trims a long reason and surfaces RPC failures', async () => {
  const { store, mgr } = manager();
  const chat = chatWithKids(mgr, store);
  const calls = [];
  mgr.slots.set(chat.id, {
    client: {
      sessionId: 'parent-1',
      proc: { exitCode: null },
      request: async (method, params) => {
        calls.push([method, params]);
        throw new Error('unknown subagent gone-1');
      },
    },
    subagents: new Map(),
  });
  await assert.rejects(
    mgr.subagentCommand(chat.id, 'sub-1', 'stop', { reason: `x${'y'.repeat(600)}` }),
    (err) => {
      assert.match(err.message, /unknown subagent/, 'RPC errors propagate for the route to 502');
      return true;
    },
  );
  assert.equal(calls[0][1].reason.length, 500, 'reason is capped at 500 chars');
});

// ------------------------------------------------------- sanitizer caps

test('readSubagent falls back to record detail when the session is gone', async () => {
  const { store, mgr } = manager();
  const chat = mgr.createChat({ title: 'gone' });
  store.saveSubagents(chat.id, [{
    itemId: 'rem-9', kind: 'reminderChild', status: 'cancelled',
    childSessionId: 'gone-1', reminderAgentId: 'todo-reminder', generationId: '2',
    taskId: 'task-9', fallbackText: 'Reminder child session',
  }]);
  mgr.slots.set(chat.id, {
    client: {
      sessionId: 'parent-1',
      proc: { exitCode: null },
      request: async () => { throw new Error('session gone-1 was not found: {"kind":"sessionNotFound"}'); },
    },
    subagents: new Map(),
  });
  const drill = await mgr.readSubagent(chat.id, 'rem-9');
  assert.equal(drill.mode, 'gone');
  assert.match(drill.readError, /was not found/);
  const text = drill.items.map((it) => it.text || '').join('\n');
  assert.match(text, /todo-reminder/);
  assert.match(text, /generation: 2/);
  assert.match(text, /task-9/);
});

test('_backfillNativeSubagents rebuilds rows the tracker never saw', async () => {
  const { mgr } = manager();
  const chat = mgr.createChat({ title: 'old' });
  const slot = { client: null, turn: null, subagents: new Map() };
  mgr.slots.set(chat.id, slot);
  const fake = {
    sessionId: 'parent-9',
    request: async (method) => {
      assert.equal(method, 'session/read');
      return { history: { mode: 'inline', items: [
        {
          itemId: 'h-spawn', kind: 'toolCall', status: 'completed', tool: 'subagent_spawn',
          turnId: 'turn-0',
          args: JSON.stringify({ task_name: 'old-probe', objective: 'answer old' }),
          visibleOutput: JSON.stringify({ status: 'accepted', subagent_id: 'sub-old' }),
        },
        {
          itemId: 'h-wait', kind: 'toolCall', status: 'completed', tool: 'subagent_wait',
          turnId: 'turn-0',
          args: JSON.stringify({ subagent_id: 'sub-old' }),
          visibleOutput: JSON.stringify({ status: 'ready', subagent_id: 'sub-old', summary: 'old did it' }),
        },
        { itemId: 'h-bash', kind: 'toolCall', status: 'completed', tool: 'Bash' },
      ] } };
    },
  };
  await mgr._backfillNativeSubagents(chat.id, slot, fake);
  const rec = slot.subagents.get('native:sub-old');
  assert.equal(rec.taskName, 'old-probe');
  assert.equal(rec.status, 'completed');
  assert.equal(rec.result.summary, 'old did it');
  assert.equal(slot.subagents.size, 1, 'non-native tools must not become rows');
  // Second call is a no-op — one boot, one backfill.
  await mgr._backfillNativeSubagents(chat.id, slot, { request: async () => { throw new Error('must not refetch'); } });
});

test('sanitizeChildItem + sanitizeDrillItem cap text and keep drill keys', () => {
  const big = 'z'.repeat(5000);
  const child = sanitizeChildItem({
    itemId: 'sub-1', kind: 'subagent', status: 'completed', subagentId: 'a',
    childSessionId: 'c1', result: { summary: 's', text: big },
  });
  assert.equal(child.result.text.length, 4000);
  assert.equal(child.result.truncated, true);
  assert.equal(child.childSessionId, 'c1');
  assert.equal(sanitizeChildItem(null), null);
  const drill = sanitizeDrillItem({
    itemId: 'm1', kind: 'agentMessage', status: 'completed', text: big,
  });
  assert.equal(drill.text.length, 2001, 'drill text caps at 2000 + ellipsis');
  assert.equal(drill.truncated, true);
  const nested = sanitizeDrillItem({
    itemId: 'c-sub', kind: 'subagent', status: 'completed', subagentId: 'a',
    childSessionId: 'c2', agentPath: 'deep',
  });
  assert.equal(nested.childSessionId, 'c2', 'nested drill keys survive for the next level');
  assert.equal(sanitizeDrillItem(null), null);
});

test('extractReminderDecision reads the one verdict call, nothing else', () => {
  const dec = (args) => ({
    itemId: 'd', kind: 'toolCall', status: 'completed', tool: 'submit_reminder_decision', args,
  });
  assert.deepEqual(
    extractReminderDecision([
      { itemId: 'm', kind: 'agentMessage', status: 'completed', text: 'noted' },
      dec(JSON.stringify({ decision: 'remind', reason: 'capture the choice' })),
    ]),
    { decision: 'remind', reason: 'capture the choice' },
  );
  assert.equal(extractReminderDecision([]), null);
  assert.equal(extractReminderDecision(null), null);
  assert.equal(extractReminderDecision([{ itemId: 'm', kind: 'agentMessage', text: 'x' }]), null);
  // Garbage args and empty verdicts are skipped, not fatal.
  assert.equal(extractReminderDecision([dec('not-json{{{')]), null);
  assert.equal(extractReminderDecision([dec(JSON.stringify({ decision: null, reason: null }))]), null);
  // rawInput is the legacy arg carrier; decision-only still counts.
  assert.deepEqual(
    extractReminderDecision([{
      itemId: 'd', kind: 'toolCall', tool: 'submit_reminder_decision',
      rawInput: JSON.stringify({ decision: 'none' }),
    }]),
    { decision: 'none', reason: null },
  );
  // Caps hold: 80 on the verdict word, 500 on the reason.
  const capped = extractReminderDecision([dec(JSON.stringify({
    decision: 'x'.repeat(200), reason: 'y'.repeat(900),
  }))]);
  assert.equal(capped.decision.length, 80);
  assert.equal(capped.reason.length, 500);
});

test('reminderDecisionLine joins verdict + reason, tolerates halves', () => {
  assert.equal(reminderDecisionLine({ decision: 'remind', reason: 'do it' }), 'remind: do it');
  assert.equal(reminderDecisionLine({ decision: 'none', reason: null }), 'none');
  assert.equal(reminderDecisionLine({ decision: null, reason: 'quiet' }), 'quiet');
  assert.equal(reminderDecisionLine({}), null);
  assert.equal(reminderDecisionLine(null), null);
});

test('childWindowUrl addresses item drills and nested sessions', () => {
  assert.equal(childWindowUrl('c1', { itemId: 'native:sub-a' }), '/child.html?chat=c1&item=native%3Asub-a');
  assert.equal(childWindowUrl('c1', { childSessionId: 'mock-child-1' }), '/child.html?chat=c1&session=mock-child-1');
  assert.equal(childWindowUrl('c 1/2', {}), '/child.html?chat=c%201%2F2');
  assert.equal(
    childWindowUrl('c1', { itemId: 'i', childSessionId: 's' }),
    '/child.html?chat=c1&item=i',
    'the record wins when both keys are given',
  );
});

test('readSubagent folds a reminder verdict into the row + drill head', async () => {
  const { store, wire, mgr } = manager();
  const chat = mgr.createChat({ title: 'verdict' });
  store.saveSubagents(chat.id, [{
    itemId: 'rem-1', kind: 'reminderChild', status: 'completed',
    childSessionId: 'mock-rem-1', reminderAgentId: 'memory-reminder', generationId: 3,
    taskId: 'mock-task-1', fallbackText: 'Reminder child session',
  }]);
  mgr.slots.set(chat.id, {
    client: {
      sessionId: 'parent-1',
      proc: { exitCode: null },
      request: async (method) => {
        assert.equal(method, 'session/read');
        return { history: { mode: 'inline', items: [
          { itemId: 'rem-msg-1', kind: 'agentMessage', status: 'completed', text: 'reminder noted. ' },
          {
            itemId: 'rem-dec-1', kind: 'toolCall', status: 'completed', tool: 'submit_reminder_decision',
            args: JSON.stringify({ decision: 'remind', reason: 'memory: capture the Redis choice' }),
          },
        ] } };
      },
    },
    subagents: new Map(),
  });
  const drill = await mgr.readSubagent(chat.id, 'rem-1');
  assert.deepEqual(drill.reminderDecision, { decision: 'remind', reason: 'memory: capture the Redis choice' });
  assert.match(drill.items[0].text, /^สรุป: remind: memory:/, 'verdict card leads the drill');
  const rec = mgr.subagentRecord(chat.id, 'rem-1');
  assert.equal(rec.result.summary, 'remind: memory: capture the Redis choice');
  assert.equal(subagentSub(rec), 'gen 3 · remind: memory: capture the Redis choice');
  assert.ok(
    wire.of('subagent').some((e) => e.subagent?.result?.summary),
    'the fold repaints the row over SSE',
  );
});

test('_onUpdate folds a landed reminder verdict without warming', async () => {
  const { mgr } = manager();
  const chat = mgr.createChat({ title: 'livefold' });
  let reads = 0;
  mgr.slots.set(chat.id, {
    client: {
      sessionId: 'parent-1',
      proc: { exitCode: null },
      request: async () => {
        reads += 1;
        return { history: { mode: 'inline', items: [
          {
            itemId: 'd', kind: 'toolCall', status: 'completed', tool: 'submit_reminder_decision',
            args: JSON.stringify({ decision: 'none', reason: 'quiet turn' }),
          },
        ] } };
      },
    },
    subagents: new Map(),
    turn: null,
  });
  mgr._onUpdate(chat.id, {
    sessionUpdate: 'msp:reminder_child',
    item: {
      itemId: 'rem-9', kind: 'reminderChild', status: 'completed',
      childSessionId: 'mock-rem-9', reminderAgentId: 'todo-reminder', generationId: 2,
    },
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(reads, 1);
  assert.equal(mgr.subagentRecord(chat.id, 'rem-9').result.summary, 'none: quiet turn');
  // A running row has nothing to fold — no read, no verdict.
  mgr._onUpdate(chat.id, {
    sessionUpdate: 'msp:reminder_child',
    item: {
      itemId: 'rem-10', kind: 'reminderChild', status: 'inProgress',
      childSessionId: 'mock-rem-10', reminderAgentId: 'todo-reminder', generationId: 3,
    },
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(reads, 1, 'running rows must not trigger a background read');
  assert.equal(mgr.subagentRecord(chat.id, 'rem-10').result, undefined);
});

test('readSubagent summarizes a running native child from its stream tail', async () => {
  const { mgr } = manager();
  const chat = mgr.createChat({ title: 'natrun' });
  const slot = { client: null, turn: null, subagents: new Map() };
  mgr.slots.set(chat.id, slot);
  mgr._trackNativeSubagent(chat.id, 'turn-1', slot, {
    id: 'tc-1', kind: 'subagent_spawn', status: 'completed',
    rawInput: JSON.stringify({ task_name: 'beta-probe', objective: 'answer beta' }),
    output: JSON.stringify({ status: 'accepted', subagent_id: 'sub-b' }),
  });
  const rec = slot.subagents.get('native:sub-b');
  rec.liveText = 'halfway there';
  rec.startedAt = Date.now() - 12_000;
  const drill = await mgr.readSubagent(chat.id, 'native:sub-b');
  assert.equal(drill.mode, 'native');
  const running = drill.items.find((it) => it.itemId === 'native:sub-b:running');
  assert.match(running.text, /กำลังรัน \d+\.\ds/, 'elapsed rides the state line');
  assert.match(running.text, /ล่าสุด: halfway there/);
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
console.log(`subagents: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
