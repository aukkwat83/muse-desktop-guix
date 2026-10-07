#!/usr/bin/env node
// Turn-core invariants. These are the rules that, when broken, produce the
// classic agent-desktop bugs: a spinner that never stops, an answer painted
// twice, or a late reply from a dead turn wiping out the live one.

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { extractText, extractToolOutput, readUpdate, resolveWatchdogHardMs, SessionManager } from '../src/server/sessions.js';
import { SessionStore } from '../src/server/session-store.js';
import { MspClient } from '../src/server/msp-client.js';

// Unit tests must never spawn a real agent — createChat background-warms by
// default, so pin it off for this process (each suite is its own process).
process.env.MUSE_DESKTOP_CREATE_WARM = '0';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-turn-'));
  return new SessionStore({ file: path.join(dir, 'chats.json'), debounceMs: 5 });
}

function tmpSearchDb() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'muse-turn-idx-')), 'search.sqlite');
}

/** Wire double: records everything instead of writing to sockets. */
function fakeWire() {
  const events = [];
  return {
    events,
    emit(chatId, type, payload) {
      events.push({ chatId, type, ...payload });
      return events.length;
    },
    types: () => events.map((e) => e.type),
    of: (type) => events.filter((e) => e.type === type),
  };
}

function managerWithOpenTurn(turnId = 't1') {
  const store = tmpStore();
  const wire = fakeWire();
  const mgr = new SessionManager({ store, wire, searchDbPath: tmpSearchDb() });
  const chat = store.create({ title: 'x', cwd: os.tmpdir() });
  mgr.slots.set(chat.id, {
    client: null,
    lastUsed: Date.now(),
    turn: {
      turnId,
      text: '',
      thought: '',
      toolCalls: new Map(),
      plan: null,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      sawActivity: false,
      settled: false,
      promptText: 'hi',
    },
  });
  return { mgr, store, wire, chatId: chat.id };
}

test('extractText walks the agent content shapes', () => {
  assert.equal(extractText('plain'), 'plain');
  assert.equal(extractText({ type: 'text', text: 'a' }), 'a');
  assert.equal(extractText([{ text: 'a' }, { text: 'b' }]), 'ab');
  assert.equal(extractText({ content: { type: 'text', text: 'deep' } }), 'deep');
  assert.equal(extractText(null), '');
  assert.equal(extractText([{ type: 'content', content: { type: 'text', text: 'x' } }]), 'x');
});

test('readUpdate reads the discriminator from either nesting', () => {
  assert.equal(readUpdate({ update: { sessionUpdate: 'plan' } }).kind, 'plan');
  assert.equal(readUpdate({ sessionUpdate: 'tool_call' }).kind, 'tool_call');
  assert.equal(readUpdate({}).kind, '');
});

test('extractToolOutput prefers rawOutput over the content preview', () => {
  const update = {
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'preview' } }],
    rawOutput: 'real stdout',
  };
  assert.equal(extractToolOutput(update), 'real stdout');
  // …but an empty rawOutput must not shadow real content
  assert.equal(extractToolOutput({ rawOutput: '', content: [{ text: 'from content' }] }), 'from content');
});

test('an Edit-shaped tool_call renders its diff block, not the args JSON', () => {
  const { mgr, wire, chatId } = managerWithOpenTurn();
  // The real CLI unshifts a diff block ahead of the stringified-args text
  // block on every Edit/Write tool_call.
  mgr._onUpdate(chatId, {
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-edit',
      title: 'Edit',
      kind: 'edit',
      status: 'in_progress',
      rawInput: { file_path: 'src/demo.js', old_string: 'const a = 1', new_string: 'const a = 2' },
      content: [
        { type: 'diff', path: 'src/demo.js', oldText: 'const a = 1', newText: 'const a = 2' },
        { type: 'content', content: { type: 'text', text: '{"file_path":"src/demo.js","old_string":"const a = 1"}' } },
      ],
    },
  });
  const tool = wire.of('tool_call').at(-1).tool;
  assert.ok(tool.output.includes('src/demo.js'), `diff path missing: ${tool.output}`);
  assert.ok(tool.output.includes('- const a = 1'), `old line missing: ${tool.output}`);
  assert.ok(tool.output.includes('+ const a = 2'), `new line missing: ${tool.output}`);
  assert.ok(!tool.output.includes('{"file_path"'), 'args JSON should not shadow the diff');

  // The completed update carries rawOutput — it replaces the diff preview.
  mgr._onUpdate(chatId, {
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-edit',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'edited src/demo.js' } }],
      rawOutput: 'edited src/demo.js',
    },
  });
  assert.equal(wire.of('tool_call_update').at(-1).tool.output, 'edited src/demo.js');
});

test('settleTurn is idempotent — a second call emits nothing', () => {
  const { mgr, wire, chatId } = managerWithOpenTurn();
  assert.equal(mgr.settleTurn(chatId, 't1', { content: 'done' }), true);
  assert.equal(mgr.settleTurn(chatId, 't1', { content: 'done again' }), false);
  assert.equal(wire.of('turn_done').length, 1);
});

test('settleTurn ignores a stale turnId', () => {
  const { mgr, wire, chatId } = managerWithOpenTurn('live');
  assert.equal(mgr.settleTurn(chatId, 'stale', { content: 'from an old turn' }), false);
  assert.equal(wire.of('turn_done').length, 0);
  // …and the live turn is still open and settleable
  assert.equal(mgr.settleTurn(chatId, 'live', { content: 'ok' }), true);
});

test('final content wins over accumulated chunks', () => {
  const { mgr, store, chatId } = managerWithOpenTurn();
  mgr.slots.get(chatId).turn.text = 'partial stream';
  mgr.settleTurn(chatId, 't1', { content: 'authoritative final' });
  const msgs = store.get(chatId).messages.filter((m) => m.role === 'assistant');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, 'authoritative final');
});

test('empty final content falls back to the stream', () => {
  const { mgr, store, chatId } = managerWithOpenTurn();
  mgr.slots.get(chatId).turn.text = 'streamed only';
  mgr.settleTurn(chatId, 't1', { content: null });
  const msgs = store.get(chatId).messages.filter((m) => m.role === 'assistant');
  assert.equal(msgs[0].text, 'streamed only');
});

test('one assistant message per turn even if settle is retried across paths', () => {
  const { mgr, store, chatId } = managerWithOpenTurn();
  mgr.slots.get(chatId).turn.text = 'a';
  mgr.settleTurn(chatId, 't1', { content: 'a' });
  // simulate a second, racing settle path re-opening and settling the same id
  mgr.slots.set(chatId, {
    client: null,
    lastUsed: Date.now(),
    turn: { turnId: 't1', text: 'a', toolCalls: new Map(), startedAt: Date.now(), settled: false },
  });
  mgr.settleTurn(chatId, 't1', { content: 'a' });
  const msgs = store.get(chatId).messages.filter((m) => m.role === 'assistant');
  assert.equal(msgs.length, 1, 'setAssistantMessage must update, not append');
});

test('user_message_chunk echo is dropped (no duplicate prompts)', () => {
  const { mgr, wire, chatId } = managerWithOpenTurn();
  mgr._onUpdate(chatId, { update: { sessionUpdate: 'user_message_chunk', content: { text: 'hi' } } });
  assert.equal(wire.events.length, 0);
});

test('message_delta carries the running total, not just the delta', async () => {
  const { mgr, wire, chatId } = managerWithOpenTurn();
  mgr._onUpdate(chatId, { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'ab' } } });
  mgr._onUpdate(chatId, { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'cd' } } });
  // Batched (16ms window): nothing has gone out yet…
  assert.equal(wire.of('message_delta').length, 0);
  // …until the flush timer fires — then one frame with the running total.
  await new Promise((r) => setTimeout(r, 40));
  const deltas = wire.of('message_delta');
  assert.equal(deltas.length, 1, 'chunks inside the flush window batch into one frame');
  assert.equal(deltas[0].text, 'abcd');
  assert.equal(deltas[0].delta, 'abcd');
});

test('a big chunk flushes immediately at the size threshold', () => {
  const { mgr, wire, chatId } = managerWithOpenTurn();
  mgr._onUpdate(chatId, {
    update: { sessionUpdate: 'agent_message_chunk', content: { text: 'x'.repeat(900) } },
  });
  const deltas = wire.of('message_delta');
  assert.equal(deltas.length, 1, '>= 768 chars must not wait for the timer');
  assert.equal(deltas[0].text.length, 900);
});

test('settleTurn flushes batched deltas before the terminal frame', async () => {
  const { mgr, wire, chatId } = managerWithOpenTurn();
  mgr._onUpdate(chatId, { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'tail' } } });
  assert.equal(wire.of('message_delta').length, 0);
  mgr.settleTurn(chatId, 't1', { content: null });
  const tail = wire.events.slice(-2).map((e) => e.type);
  assert.deepEqual(tail, ['message_delta', 'turn_done'], 'buffered text must land before turn_done');
  assert.equal(wire.of('message_delta')[0].text, 'tail');
  // No second flush may fire after the turn is gone.
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(wire.of('message_delta').length, 1);
});

test('unknown update kinds are forwarded, never silently dropped', () => {
  const { mgr, wire, chatId } = managerWithOpenTurn();
  mgr._onUpdate(chatId, { update: { sessionUpdate: 'brand_new_channel', hello: 1 } });
  const other = wire.of('agent_update_other');
  assert.equal(other.length, 1);
  assert.equal(other[0].kind, 'brand_new_channel');
});

test('settling a turn releases its pending approvals', () => {
  const { mgr, wire, chatId } = managerWithOpenTurn();
  mgr._onPermission(chatId, { id: 'ix-1', toolName: 'bash', options: [] });
  assert.equal(mgr.pendingInteractions.size, 1);
  mgr.settleTurn(chatId, 't1', { content: 'x' });
  assert.equal(mgr.pendingInteractions.size, 0, 'a stranded approval blocks the next turn forever');
  assert.equal(wire.of('interaction_resolved').length, 1);
});

test('settleTurn rejects the agent\'s real permission waiter, not just the UI card', () => {
  // pendingInteractions entries are metadata ({chatId, payload}) — the waiter
  // that unblocks the agent's approval/decide lives in
  // MspClient._permWaiters. A settle that only clears the metadata leaves the
  // agent parked while the UI shows the card as resolved.
  const { mgr, wire, chatId } = managerWithOpenTurn();
  const client = new MspClient({ cwd: os.tmpdir() });
  const settled = [];
  client._permWaiters.set('ix-7', { resolve: (v) => settled.push(v), reject: () => {} });
  mgr.slots.get(chatId).client = client;
  mgr._onPermission(chatId, { id: 'ix-7', toolName: 'bash', options: [] });
  mgr.settleTurn(chatId, 't1', { reason: 'watchdog', error: 'stalled' });
  assert.deepEqual(settled, ['reject'], 'the MSP waiter must hear the reject');
  assert.equal(client._permWaiters.size, 0, 'waiter must be consumed');
  assert.equal(mgr.pendingInteractions.size, 0);
  assert.equal(wire.of('interaction_resolved').length, 1);
});

test('a turn that ran tools but produced no text still persists its tool rows', () => {
  const { mgr, store, chatId } = managerWithOpenTurn();
  mgr._onUpdate(chatId, {
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'Read src/server/index.js',
      kind: 'read',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'ok: 42 lines' } }],
    },
  });
  // Cancel before any assistant text arrives.
  mgr.settleTurn(chatId, 't1', { reason: 'cancelled' });
  const msgs = store.get(chatId).messages;
  const asst = msgs.find((m) => m.role === 'assistant');
  assert.ok(asst, 'tool rows must survive even with no assistant text');
  assert.equal(asst.text, '');
  assert.equal(asst.meta.toolCalls.length, 1);
  assert.equal(asst.meta.toolCalls[0].id, 'tc-1');
  assert.equal(asst.meta.reason, 'cancelled');
});

test('an errored text-less turn keeps both its tool rows and the failure notice', () => {
  const { mgr, store, chatId } = managerWithOpenTurn();
  mgr._onUpdate(chatId, {
    update: { sessionUpdate: 'tool_call', toolCallId: 'tc-9', title: 'Bash', status: 'in_progress' },
  });
  mgr.settleTurn(chatId, 't1', { reason: 'watchdog', error: 'stalled' });
  const msgs = store.get(chatId).messages;
  const asst = msgs.find((m) => m.role === 'assistant');
  assert.ok(asst, 'tool rows must persist');
  assert.equal(asst.meta.toolCalls[0].status, 'cancelled', 'watchdog maps open tools to cancelled');
  const notice = msgs.find((m) => m.role === 'notice');
  assert.ok(notice?.text.includes('stalled'), 'the failure notice must not be lost either');
});

test('a cancelled text-less turn persists a stub notice instead of nothing', () => {
  // Contract change (bcb3975b): silent settles looked exactly like "never
  // ran", so users re-sent and collected orphan user messages. Every reason
  // except 'rotated' (which has its own recovery notice) leaves a trace.
  const { mgr, store, wire, chatId } = managerWithOpenTurn();
  mgr.settleTurn(chatId, 't1', { reason: 'cancelled' });
  const msgs = store.get(chatId).messages;
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, 'notice');
  assert.match(msgs[0].text, /ยกเลิกเทิร์นแล้ว/);
  assert.equal(wire.of('turn_done').length, 1);
});

test('settleTurn flips still-open tool rows to a terminal status', () => {
  const { mgr, store, wire, chatId } = managerWithOpenTurn();
  const tools = mgr.slots.get(chatId).turn.toolCalls;
  tools.set('a', { id: 'a', title: 'Edit', status: 'in_progress', output: '' });
  tools.set('b', { id: 'b', title: 'Read', status: 'completed', output: 'ok' });
  tools.set('c', { id: 'c', title: 'Bash', status: 'pending', output: '' });
  mgr.settleTurn(chatId, 't1', { content: 'done' });

  const persisted = store.get(chatId).messages.find((m) => m.role === 'assistant');
  const byId = Object.fromEntries(persisted.meta.toolCalls.map((t) => [t.id, t.status]));
  assert.deepEqual(byId, { a: 'completed', b: 'completed', c: 'completed' });
  // …and the wire payload carries the same normalized statuses
  const emitted = Object.fromEntries(wire.of('turn_done')[0].toolCalls.map((t) => [t.id, t.status]));
  assert.deepEqual(emitted, byId);
});

test('open tool rows follow the stop reason: error → failed, cancel/watchdog → cancelled', () => {
  for (const [opts, want] of [
    [{ reason: 'error', error: 'boom' }, 'failed'],
    [{ reason: 'cancelled' }, 'cancelled'],
    [{ reason: 'watchdog', error: 'stalled' }, 'cancelled'],
  ]) {
    const { mgr, wire, chatId } = managerWithOpenTurn();
    mgr.slots.get(chatId).turn.toolCalls.set('x', { id: 'x', title: 'Edit', status: 'running', output: '' });
    mgr.settleTurn(chatId, 't1', { content: 'partial', ...opts });
    const emitted = wire.of(opts.error ? 'turn_error' : 'turn_done')[0];
    assert.equal(emitted.toolCalls[0].status, want, `${opts.reason} should map open tools to ${want}`);
  }
});

test('pending approvals survive out of view and are listable', () => {
  const { mgr, chatId } = managerWithOpenTurn();
  mgr._onPermission(chatId, { id: 'ix-9', toolName: 'bash', summary: 's', options: [] });
  const list = mgr.listPendingInteractions();
  assert.equal(list.length, 1);
  assert.equal(list[0].chatId, chatId);
  assert.equal(list[0].id, 'ix-9');
});

test('a rotated session prepends a recovery recap to the wire text, once', () => {
  const store = tmpStore();
  const mgr = new SessionManager({ store, wire: fakeWire(), searchDbPath: tmpSearchDb() });
  const chat = store.create({ title: 'x', cwd: os.tmpdir() });
  store.addMessage(chat.id, { role: 'user', text: 'build the thing' });
  store.addMessage(chat.id, { role: 'assistant', text: 'step 1 done' });

  // No rotation → the wire text is the body, untouched.
  assert.equal(mgr._buildRecoveryWireText(chat.id, 'continue'), 'continue');

  mgr._rotated.set(chat.id, { reason: 'load-miss', message: 'session not found' });
  const wire = mgr._buildRecoveryWireText(chat.id, 'continue');
  assert.ok(wire.startsWith('[SESSION RECOVERY'), 'recovery marker missing');
  assert.ok(wire.includes('load-miss'), 'rotation reason missing');
  assert.ok(wire.includes('build the thing'), 'last user message missing');
  assert.ok(wire.includes('step 1 done'), 'last assistant text missing');
  assert.ok(wire.endsWith('continue'), 'user text must follow the preamble');
  assert.equal(mgr._rotated.has(chat.id), false, 'the flag must be consumed');
  assert.equal(mgr._buildRecoveryWireText(chat.id, 'next'), 'next', 'the preamble fires once only');
});

test('the recovery recap trims oversized context and skips the just-stored prompt', () => {
  const store = tmpStore();
  const mgr = new SessionManager({ store, wire: fakeWire(), searchDbPath: tmpSearchDb() });
  const chat = store.create({ title: 'x', cwd: os.tmpdir() });
  store.addMessage(chat.id, { role: 'user', text: 'old task' });
  store.addMessage(chat.id, { role: 'assistant', text: 'x'.repeat(20_000) });
  const fresh = store.addMessage(chat.id, { role: 'user', text: 'new prompt' });
  mgr._rotated.set(chat.id, { reason: 'history-incompatible', message: 'x' });
  const wire = mgr._buildRecoveryWireText(chat.id, 'new prompt', fresh.id);
  assert.ok(
    wire.includes('old task'),
    'recap should cite the PREVIOUS user message, not the one being sent',
  );
  assert.ok(wire.length < 10_000, `recap must be trimmed, got ${wire.length}`);
  assert.ok(wire.endsWith('new prompt'));
});

test('getTurn snapshots a live turn and reports none after settle', () => {
  const { mgr, chatId } = managerWithOpenTurn();
  assert.equal(mgr.getTurn('no-such-chat'), null, 'unknown chat → null');
  mgr._onUpdate(chatId, { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'abc' } } });
  mgr._onUpdate(chatId, {
    update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Read', status: 'in_progress' },
  });
  mgr._onPermission(chatId, { id: 'ix-1', toolName: 'Bash', options: [] });
  const snap = mgr.getTurn(chatId);
  assert.equal(snap.turn.turnId, 't1');
  assert.equal(snap.turn.partial, 'abc');
  assert.equal(snap.turn.tools.length, 1);
  assert.equal(snap.turn.tools[0].status, 'in_progress');
  assert.equal(snap.turn.pendingInteractions.length, 1);
  assert.ok(snap.turn.startedAt > 0);
  mgr.settleTurn(chatId, 't1', { content: 'done' });
  assert.equal(mgr.getTurn(chatId).turn, null, 'a settled turn is no longer live');
});

test('chatSummary reports the running turn so the sidebar can show it', () => {
  const { mgr, store, chatId } = managerWithOpenTurn();
  const s = mgr.chatSummary(store.get(chatId));
  assert.equal(s.running, true);
  assert.equal(s.turnId, 't1');
  mgr.settleTurn(chatId, 't1', { content: 'x' });
  assert.equal(mgr.chatSummary(store.get(chatId)).running, false);
});

test('mcp last-used marks persist across manager restarts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-usage-'));
  const file = path.join(dir, 'chats.json');
  const mgr = new SessionManager({ store: new SessionStore({ file, debounceMs: 5 }), wire: fakeWire(), searchDbPath: tmpSearchDb() });
  mgr._onUpdate('c1', { update: { sessionUpdate: 'tool_call', toolCallId: 't', kind: 'mcp__github.search_repositories' } });
  assert.ok(mgr.mcpUsageSnapshot().github > 0);
  await new Promise((r) => setTimeout(r, 1200)); // debounce window
  const mgr2 = new SessionManager({ store: new SessionStore({ file, debounceMs: 5 }), wire: fakeWire(), searchDbPath: tmpSearchDb() });
  assert.equal(mgr2.mcpUsageSnapshot().github, mgr.mcpUsageSnapshot().github);
});

test('reuseEmpty returns the existing blank chat instead of piling up new ones', () => {
  // Several clients booting against an empty store (app window + a browser
  // tab, or a fast reload) each used to POST /api/chats, leaving a row of
  // identical "New chat" entries.
  const store = tmpStore();
  const mgr = new SessionManager({ store, wire: fakeWire(), searchDbPath: tmpSearchDb() });

  const a = mgr.createChat({ reuseEmpty: true });
  const b = mgr.createChat({ reuseEmpty: true });
  const c = mgr.createChat({ reuseEmpty: true });
  assert.equal(a.id, b.id);
  assert.equal(b.id, c.id);
  assert.equal(store.list().length, 1);

  // An explicit "＋ new chat" is user intent — always a fresh chat.
  const explicit = mgr.createChat({});
  assert.notEqual(explicit.id, a.id);
  assert.equal(store.list().length, 2);

  // Once a chat has been used, it is no longer reusable.
  store.addMessage(explicit.id, { role: 'user', text: 'hello' });
  store.update(a.id, { mspSessionId: 'agent-1' });
  const fresh = mgr.createChat({ reuseEmpty: true });
  assert.notEqual(fresh.id, a.id);
  assert.notEqual(fresh.id, explicit.id);
  assert.equal(store.list().length, 3);
});

test('watchdog settles a turn that never produced activity', () => {
  const { mgr, wire, chatId } = managerWithOpenTurn();
  mgr.slots.get(chatId).turn.startedAt = Date.now() - 10 * 60 * 1000;
  mgr._checkWatchdog(chatId, 't1');
  assert.equal(wire.of('turn_error').length, 1);
});

/** Satisfies isClientAlive + the in-flight turn/start check. */
function fakeLivelyClient() {
  return {
    _closing: false,
    sessionId: 's-1',
    status: 'running',
    _pending: new Map([['c-1', { method: 'turn/start' }]]),
    proc: { killed: false, exitCode: null, stdin: { destroyed: false, writable: true } },
  };
}

test('watchdog never settles a lively turn that already produced activity', () => {
  const { mgr, wire, chatId } = managerWithOpenTurn();
  const slot = mgr.slots.get(chatId);
  slot.client = fakeLivelyClient();
  // …the stall path is guarded the same way once activity was seen
  slot.turn.sawActivity = true;
  slot.turn.lastActivity = Date.now() - 20 * 60 * 1000; // past STALL threshold in tests' clocks
  mgr._checkWatchdog(chatId, 't1');
  assert.equal(wire.of('turn_error').length, 0);
  assert.equal(slot.turn?.settled, false);
});

test('watchdog settles a lively turn that never produced a single frame (81442763)', () => {
  // Contract change from 'never settles while lively': chat 81442763 held
  // two already-completed runs open forever because the client was deaf —
  // zero frames is not a quiet build (turn/started + item/started always
  // precede any work). A lively client with nothing to show past
  // NO_ACTIVITY_MS is wedged: settle loudly and release it so the next
  // prompt boots a fresh one. Turns WITH activity still hold (74f04882).
  const { mgr, wire, chatId } = managerWithOpenTurn();
  const slot = mgr.slots.get(chatId);
  slot.client = fakeLivelyClient();
  slot.turn.startedAt = Date.now() - 10 * 60 * 1000; // way past NO_ACTIVITY_MS
  mgr._checkWatchdog(chatId, 't1');
  const errs = wire.of('turn_error');
  assert.equal(errs.length, 1);
  assert.match(errs[0].error, /ไม่ได้ยิน/);
  assert.equal(mgr.slots.has(chatId), false, 'a deaf client must be released, not reused');
  assert.equal(wire.of('agent_released').length, 1);
});

test('watchdog holds a lively silent turn by default, like the CLI (74f04882)', () => {
  // Contract change: chat 74f04882 ran 3h09m with 22 tools done and the agent
  // silent, and the old 65 min default cut it. The CLI waits indefinitely
  // (the user Ctrl-C's a wedged turn); the desktop now holds the same way —
  // the stop button is the Ctrl-C. A ceiling exists only as an explicit
  // MUSE_DESKTOP_WATCHDOG_HARD_MS opt-in (next test).
  const saved = process.env.MUSE_DESKTOP_WATCHDOG_HARD_MS;
  delete process.env.MUSE_DESKTOP_WATCHDOG_HARD_MS;
  try {
    const { mgr, wire, chatId } = managerWithOpenTurn();
    const slot = mgr.slots.get(chatId);
    slot.client = fakeLivelyClient();
    slot.turn.startedAt = Date.now() - 70 * 60 * 1000;
    slot.turn.sawActivity = true;
    slot.turn.lastActivity = Date.now() - 70 * 60 * 1000;
    mgr._checkWatchdog(chatId, 't1');
    assert.equal(wire.of('turn_error').length, 0, 'default must hold a lively turn');
    assert.equal(slot.turn.settled, false);
  } finally {
    if (saved == null) delete process.env.MUSE_DESKTOP_WATCHDOG_HARD_MS;
    else process.env.MUSE_DESKTOP_WATCHDOG_HARD_MS = saved;
  }
});

test('watchdog honors an explicit ceiling, but live tools still hold it', () => {
  const saved = process.env.MUSE_DESKTOP_WATCHDOG_HARD_MS;
  process.env.MUSE_DESKTOP_WATCHDOG_HARD_MS = '3600000'; // 60 min ceiling
  try {
    const { mgr, wire, chatId } = managerWithOpenTurn();
    const slot = mgr.slots.get(chatId);
    slot.client = fakeLivelyClient();
    slot.turn.sawActivity = true;
    slot.turn.lastActivity = Date.now() - 70 * 60 * 1000;
    slot.turn.toolCalls.set('long', { id: 'long', status: 'in_progress' });
    mgr._checkWatchdog(chatId, 't1');
    assert.equal(wire.of('turn_error').length, 0, 'a live tool holds even an explicit ceiling');
    assert.equal(slot.turn.settled, false);

    slot.turn.toolCalls.set('long', { id: 'long', status: 'completed' });
    mgr._checkWatchdog(chatId, 't1');
    const errs = wire.of('turn_error');
    assert.equal(errs.length, 1, 'explicit ceiling settles a stuck RPC past it');
    assert.match(errs[0].error, /hard cap/);
  } finally {
    if (saved == null) delete process.env.MUSE_DESKTOP_WATCHDOG_HARD_MS;
    else process.env.MUSE_DESKTOP_WATCHDOG_HARD_MS = saved;
  }
});

test('watchdog ceiling resolves per tick, unset/0/false/garbage all hold', () => {
  const saved = process.env.MUSE_DESKTOP_WATCHDOG_HARD_MS;
  try {
    delete process.env.MUSE_DESKTOP_WATCHDOG_HARD_MS;
    assert.equal(resolveWatchdogHardMs(), 0, 'unset holds forever (CLI parity)');
    process.env.MUSE_DESKTOP_WATCHDOG_HARD_MS = '0';
    assert.equal(resolveWatchdogHardMs(), 0);
    process.env.MUSE_DESKTOP_WATCHDOG_HARD_MS = 'false';
    assert.equal(resolveWatchdogHardMs(), 0);
    process.env.MUSE_DESKTOP_WATCHDOG_HARD_MS = '7200000';
    assert.equal(resolveWatchdogHardMs(), 7200000);
    process.env.MUSE_DESKTOP_WATCHDOG_HARD_MS = '30000';
    assert.equal(resolveWatchdogHardMs(), 0, 'below the 60s floor means hold');
    process.env.MUSE_DESKTOP_WATCHDOG_HARD_MS = 'nope';
    assert.equal(resolveWatchdogHardMs(), 0, 'garbage holds (safe direction)');
  } finally {
    if (saved == null) delete process.env.MUSE_DESKTOP_WATCHDOG_HARD_MS;
    else process.env.MUSE_DESKTOP_WATCHDOG_HARD_MS = saved;
  }
});

test('settleTurn never blanks an empty turn (bcb3975b)', () => {
  // No text + no tools + no error used to persist NOTHING — the spinner died
  // and the user could not tell "ran and said nothing" from "never ran".
  const { mgr, store, chatId } = managerWithOpenTurn();
  assert.equal(mgr.settleTurn(chatId, 't1', { reason: 'end_turn' }), true);
  const msgs = store.get(chatId).messages;
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, 'notice');
  assert.match(msgs[0].text, /ไม่มีข้อความตอบกลับ/);
});

test('settleTurn skips the empty stub for rotations (own notice covers it)', () => {
  const { mgr, store, chatId } = managerWithOpenTurn();
  assert.equal(mgr.settleTurn(chatId, 't1', { reason: 'rotated' }), true);
  assert.equal(store.get(chatId).messages.length, 0);
});

test('shutdown without killing agents settles live turns with a trace', async () => {
  // Deploy/restart used to evaporate in-flight turns silently (user message,
  // no reply, no error). The stored session id is kept for resume.
  const { mgr, store, chatId } = managerWithOpenTurn();
  store.update(chatId, { mspSessionId: 's-keep' });
  await mgr.shutdown({ killAgents: false });
  const slot = mgr.slots.get(chatId);
  assert.equal(slot.turn, null, 'settleTurn clears the live turn');
  const msgs = store.get(chatId).messages;
  assert.equal(msgs[msgs.length - 1].role, 'notice');
  assert.match(msgs[msgs.length - 1].text, /host หยุดทำงานระหว่างเทิร์น/);
  assert.equal(store.get(chatId).mspSessionId, 's-keep', 'resume id must survive the restart');
});

test('a pending permission card freezes the stall clock', () => {
  const { mgr, wire, chatId } = managerWithOpenTurn();
  const slot = mgr.slots.get(chatId);
  slot.turn.sawActivity = true;
  slot.turn.lastActivity = Date.now() - 60 * 60 * 1000; // ancient — would stall-settle
  mgr._onPermission(chatId, { id: 'ix-p', toolName: 'bash', options: [] });
  mgr._checkWatchdog(chatId, 't1');
  assert.equal(wire.of('turn_error').length, 0, 'a mounted card is an intentional human wait');
  assert.ok(Date.now() - slot.turn.lastActivity < 5000, 'stall clock should restart at the freeze');
});

test('every session/update kind counts as activity, not just rendered ones', () => {
  const { mgr, chatId } = managerWithOpenTurn();
  const slot = mgr.slots.get(chatId);
  slot.turn.lastActivity = 0;
  mgr._onUpdate(chatId, { update: { sessionUpdate: 'brand_new_channel', hello: 1 } });
  assert.equal(slot.turn.sawActivity, true);
  assert.ok(slot.turn.lastActivity > 0);
});

test('sticky approve engages on a session-scoped approve choice', () => {
  const approvalWaiter = (choices) => ({
    kind: 'approval',
    approvalId: 'a1',
    requirementId: 'req-1',
    choices,
    resolve: () => {},
    reject: () => {},
  });
  const client = new MspClient({ cwd: os.tmpdir() });
  client._permWaiters.set('p1', approvalWaiter([
    { choiceId: 'approve_once', decision: 'approved', scope: 'once' },
    { choiceId: 'approve_always', decision: 'approvedForSession', scope: 'session' },
  ]));
  assert.equal(client.permissionStickyApprove, false);
  client.resolvePermission('p1', 'approve_always');
  assert.equal(client.permissionStickyApprove, true, 'session-scoped approve must set the sticky flag');
  // …and the legacy spelling keeps working via the always-name fallback
  const legacy = new MspClient({ cwd: os.tmpdir() });
  legacy._permWaiters.set('p2', approvalWaiter([
    { choiceId: 'allow_always', decision: 'approved', scope: 'once' },
  ]));
  legacy.resolvePermission('p2', 'allow_always');
  assert.equal(legacy.permissionStickyApprove, true);
  // approve_once must NOT make the session sticky
  const once = new MspClient({ cwd: os.tmpdir() });
  once._permWaiters.set('p3', approvalWaiter([
    { choiceId: 'approve_once', decision: 'approved', scope: 'once' },
  ]));
  once.resolvePermission('p3', 'approve_once');
  assert.equal(once.permissionStickyApprove, false);
});

test('resolveModeId maps plan/normal/always onto the MSP approval modes', () => {
  const client = new MspClient({ cwd: os.tmpdir() });
  // Static vocabulary — MSP hosts do not advertise mode ids per version.
  assert.equal(client.resolveModeId('normal'), 'promptUnmatched');
  assert.equal(client.resolveModeId('plan'), 'denyUnmatched');
  assert.equal(client.resolveModeId('always'), 'allowAll');
  // Aliases normalize first.
  assert.equal(client.resolveModeId('yolo'), 'allowAll');
  client.configOptions = [];
  assert.equal(client.resolveModeId('plan'), 'denyUnmatched');
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
console.log(`turn-core: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
