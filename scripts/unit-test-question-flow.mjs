#!/usr/bin/env node
// ACK-safe question/approval submissions (1.1.33): pending → submitting →
// resolved only after the RPC ack or an authoritative settled event;
// identical retries share one flight and one commandId, conflicts 409,
// and rejections keep the card pending with the cause. In-process
// SessionManager + stub agent client — no sockets, no spawns.

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { SessionManager } from '../src/server/sessions.js';
import { SessionStore } from '../src/server/session-store.js';

process.env.MUSE_DESKTOP_CREATE_WARM = '0';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-qflow-'));
  return new SessionStore({ file: path.join(dir, 'chats.json'), debounceMs: 5 });
}

function tmpSearchDb() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'muse-qflow-idx-')), 'search.sqlite');
}

function fakeWire() {
  const events = [];
  return {
    events,
    emit(chatId, type, payload) {
      events.push({ chatId, type, ...payload });
      return events.length;
    },
    of: (type) => events.filter((e) => e.type === type),
  };
}

/** Alive-looking stub agent: the ACK-safe client surface over scripted RPC. */
function stubClient({ answer = null, decide = null, cancel = null } = {}) {
  const calls = [];
  return {
    calls,
    sessionId: 's-test',
    subscribed: true,
    _closing: false,
    proc: { exitCode: null, killed: false, stdin: { writable: true, destroyed: false } },
    _permWaiters: new Map(),
    status: 'idle',
    async answerUserInput(id, answers, { commandId } = {}) {
      calls.push(['userInput/answer', { id, answers, commandId }]);
      if (answer) return answer({ id, answers, commandId });
      return { commandId, status: 'accepted', userInputId: id };
    },
    async decideApproval(id, choiceId, { commandId } = {}) {
      calls.push(['approval/decide', { id, choiceId, commandId }]);
      if (decide) return decide({ id, choiceId, commandId });
      return { choiceId, commandId, status: 'accepted', terminal: true, approvalId: id };
    },
    async cancelUserInput(id, reason, { commandId } = {}) {
      calls.push(['userInput/cancel', { id, reason, commandId }]);
      if (cancel) return cancel({ id, reason, commandId });
      return { commandId, status: 'accepted', userInputId: id };
    },
    engageUserInput(id) {
      calls.push(['userInput/engaged', { id }]);
      return true;
    },
    cancelInteractive() { return false; },
  };
}

function managerWithClient(client) {
  const store = tmpStore();
  const wire = fakeWire();
  // Noop notifier: unit tests never touch a real desktop (nor the log).
  const notifier = { pending: () => ({}), withdraw: () => ({}) };
  const mgr = new SessionManager({ store, wire, searchDbPath: tmpSearchDb(), notifier });
  const chat = store.create({ title: 'x', cwd: os.tmpdir() });
  mgr.slots.set(chat.id, { client, lastUsed: Date.now(), turn: null, subagents: new Map(), cancelledPrompts: new Map() });
  return { mgr, store, wire, chatId: chat.id, client };
}

const askReq = (id) => ({
  id,
  toolName: 'AskUserQuestion',
  toolCallId: 'tc-1',
  summary: 'Cache where?',
  subtype: 'ask',
  body: 'Cache where?',
  options: [{ optionId: 'Redis', name: 'Redis' }],
  questions: [{
    id: 'q1', header: 'Cache', question: 'Cache where?', mode: 'single',
    minSelections: 1, maxSelections: 1, freeText: false,
    options: [{ label: 'Redis', description: '' }, { label: 'SQLite', description: '' }],
  }],
});

const approvalReq = (id) => ({
  id,
  toolName: 'Bash',
  toolCallId: 'tc-2',
  summary: 'rm -rf /tmp/demo',
  subtype: null,
  body: 'rm -rf /tmp/demo',
  options: [
    { optionId: 'approve_once', name: 'Approve once' },
    { optionId: 'reject', name: 'Reject' },
  ],
});

function rpcError(code, message) {
  const e = new Error(message);
  e.rpc = { code, message };
  return e;
}

test('interaction_resolved carries the turnId tombstone key (ack + settled paths)', async () => {
  const { mgr, wire, chatId, client } = managerWithClient(stubClient());
  mgr.slots.get(chatId).turn = { turnId: 't-9', settled: false };
  client._permWaiters.set('u-t', { kind: 'userInput', userInputId: 'u-t' });
  mgr._onPermission(chatId, askReq('u-t'));
  await mgr.submitInteraction('u-t', { answers: [{ questionId: 'q1', selectedLabel: 'Redis' }] });
  assert.equal(wire.of('interaction_resolved')[0].turnId, 't-9', 'ack path carries the live turn');
  client._permWaiters.set('u-s', { kind: 'userInput', userInputId: 'u-s' });
  mgr._onPermission(chatId, askReq('u-s'));
  mgr._onPermission(chatId, { id: 'u-s', resolved: true, outcome: 'timedOut' });
  const settled = wire.of('interaction_resolved').find((e) => e.id === 'u-s');
  assert.equal(settled.turnId, 't-9', 'settled path reuses the pending payload turn');
  assert.equal(settled.outcome, 'timedOut');
});

test('mount banners host-side; resolve withdraws (injected notifier)', async () => {
  const seen = [];
  const fake = {
    pending: (p) => {
      seen.push(['pending', p]);
      return { attempted: true, delivered: false, queued: true, via: 'gdbus' };
    },
    withdraw: (id) => seen.push(['withdraw', id]),
  };
  const store = tmpStore();
  const wire = fakeWire();
  const mgr = new SessionManager({ store, wire, searchDbPath: tmpSearchDb(), notifier: fake });
  const chat = store.create({ title: 'งาน', cwd: os.tmpdir() });
  const client = stubClient();
  mgr.slots.set(chat.id, { client, lastUsed: Date.now(), turn: null, subagents: new Map(), cancelledPrompts: new Map() });
  client._permWaiters.set('u-n', { kind: 'userInput', userInputId: 'u-n' });
  mgr._onPermission(chat.id, askReq('u-n'));
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 'pending');
  assert.equal(seen[0][1].title, 'Muse มีคำถาม');
  assert.match(seen[0][1].body, /Cache where\?/, 'question text, not the tool name');
  assert.match(seen[0][1].body, /งาน/);
  assert.equal(mgr.pendingInteractions.get('u-n').payload.hostNotified, true, 'queued host banner marks the payload');
  assert.equal(wire.of('interaction')[0].hostNotified, true, 'watching renderers see it and skip their own banner');
  await mgr.submitInteraction('u-n', { answers: [{ questionId: 'q1', selectedLabel: 'Redis' }] });
  assert.deepEqual(seen[1], ['withdraw', 'u-n']);
});

test('an answer resolves only after the ack, with the answers summary', async () => {
  const { mgr, wire, chatId, client } = managerWithClient(stubClient());
  client._permWaiters.set('u-1', { kind: 'userInput', userInputId: 'u-1' });
  mgr._onPermission(chatId, askReq('u-1'));
  let release;
  const gate = new Promise((r) => { release = r; });
  client.answerUserInput = async (id, answers, { commandId } = {}) => {
    client.calls.push(['userInput/answer', { id, answers, commandId }]);
    await gate;
    return { commandId, status: 'accepted' };
  };
  const flight = mgr.submitInteraction('u-1', { answers: [{ questionId: 'q1', selectedLabel: 'Redis' }] });
  await new Promise((r) => setImmediate(r));
  assert.equal(mgr.pendingInteractions.has('u-1'), true, 'pending until the ack lands');
  assert.deepEqual(wire.of('interaction_state').map((e) => e.state), ['submitting']);
  assert.equal(wire.of('interaction_resolved').length, 0, 'no resolved before the ack');
  release();
  const res = await flight;
  assert.equal(res.ok, true);
  assert.equal(res.outcome, 'answered');
  assert.equal(mgr.pendingInteractions.has('u-1'), false);
  const resolved = wire.of('interaction_resolved');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].answers[0].display, 'Redis');
  assert.match(res.commandId, /^[0-9a-f-]{36}$/, 'ack carries the UUID commandId');
});

test('an identical retry after a landed ack is a 200 duplicate (lost response)', async () => {
  const { mgr, client } = managerWithClient(stubClient());
  client._permWaiters.set('u-2', { kind: 'userInput', userInputId: 'u-2' });
  const { chatId } = { chatId: [...mgr.slots.keys()][0] };
  mgr._onPermission(chatId, askReq('u-2'));
  const body = { answers: [{ questionId: 'q1', selectedLabel: 'SQLite' }] };
  const first = await mgr.submitInteraction('u-2', body);
  assert.equal(first.duplicate, undefined);
  const retry = await mgr.submitInteraction('u-2', body);
  assert.equal(retry.ok, true);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.outcome, 'answered');
  assert.equal(client.calls.length, 1, 'the duplicate must not re-send the RPC');
});

test('the settled event corrects the outcome but keeps the duplicate key', async () => {
  const { mgr, wire, client } = managerWithClient(stubClient());
  const chatId = [...mgr.slots.keys()][0];
  client._permWaiters.set('u-2b', { kind: 'userInput', userInputId: 'u-2b' });
  mgr._onPermission(chatId, askReq('u-2b'));
  const body = { answers: [{ questionId: 'q1', selectedLabel: 'Redis' }] };
  await mgr.submitInteraction('u-2b', body);
  // The host's authoritative settled event lands after our ack.
  mgr._onPermission(chatId, {
    id: 'u-2b', resolved: true, outcome: 'answered', decidedByCommandId: 'cmd-x',
  });
  const retry = await mgr.submitInteraction('u-2b', body);
  assert.equal(retry.duplicate, true, 'the settled event must not clobber the ack key');
  assert.equal(retry.outcome, 'answered');
  assert.equal(wire.of('interaction_resolved').length, 2, 'ack + authoritative correction both emit');
});

test('a settled event mid-flight resolves immediately, before the late ack', async () => {
  const { mgr, wire, client } = managerWithClient(stubClient());
  const chatId = [...mgr.slots.keys()][0];
  client._permWaiters.set('u-2c', { kind: 'userInput', userInputId: 'u-2c' });
  mgr._onPermission(chatId, askReq('u-2c'));
  let release;
  const gate = new Promise((r) => { release = r; });
  client.answerUserInput = async (id, answers, { commandId } = {}) => {
    await gate;
    return { commandId, status: 'accepted' };
  };
  const flight = mgr.submitInteraction('u-2c', { answers: [{ questionId: 'q1', selectedLabel: 'Redis' }] });
  await new Promise((r) => setImmediate(r));
  // The host's settled event arrives while our RPC is still in the air —
  // the card resolves NOW, with zero dependence on the late ack.
  mgr._onPermission(chatId, { id: 'u-2c', resolved: true, outcome: 'timedOut', reason: 'countdown hit zero' });
  assert.equal(mgr.pendingInteractions.has('u-2c'), false, 'pending clears before the ack lands');
  const early = wire.of('interaction_resolved');
  assert.equal(early.length, 1, 'one resolved at settle time, not after the ack');
  assert.equal(early[0].outcome, 'timedOut');
  assert.equal(early[0].reason, 'countdown hit zero');
  // The late ack resolves superseded: no second terminal event, and the
  // HTTP result reports the settled truth instead of the guessed answer.
  release();
  const res = await flight;
  assert.equal(res.superseded, true);
  assert.equal(res.outcome, 'timedOut', 'no downgrade of the settled outcome');
  assert.equal(wire.of('interaction_resolved').length, 1, 'no duplicate terminal event');
  // Retry bookkeeping survived separately: the identical retry duplicates.
  const dup = await mgr.submitInteraction('u-2c', { answers: [{ questionId: 'q1', selectedLabel: 'Redis' }] });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.outcome, 'timedOut');
});

test('a conflicting late answer 409s instead of overwriting', async () => {
  const { mgr, client } = managerWithClient(stubClient());
  const chatId = [...mgr.slots.keys()][0];
  client._permWaiters.set('u-3', { kind: 'userInput', userInputId: 'u-3' });
  mgr._onPermission(chatId, askReq('u-3'));
  await mgr.submitInteraction('u-3', { answers: [{ questionId: 'q1', selectedLabel: 'Redis' }] });
  await assert.rejects(
    () => mgr.submitInteraction('u-3', { answers: [{ questionId: 'q1', selectedLabel: 'SQLite' }] }),
    (err) => err.status === 409 && err.code === 'SUBMIT_CONFLICT',
  );
});

test('a rejected answer keeps the card and the retry reuses the commandId', async () => {
  const { mgr, wire, client } = managerWithClient(stubClient());
  const chatId = [...mgr.slots.keys()][0];
  client._permWaiters.set('u-4', { kind: 'userInput', userInputId: 'u-4' });
  mgr._onPermission(chatId, askReq('u-4'));
  let n = 0;
  client.answerUserInput = async (id, answers, { commandId } = {}) => {
    client.calls.push(['userInput/answer', { id, answers, commandId }]);
    n++;
    if (n === 1) throw new Error('transport down');
    return { commandId, status: 'accepted' };
  };
  const body = { answers: [{ questionId: 'q1', selectedLabel: 'Redis' }] };
  await assert.rejects(
    () => mgr.submitInteraction('u-4', body),
    (err) => err.status === 502 && err.retryable === true,
  );
  assert.equal(mgr.pendingInteractions.has('u-4'), true, 'rejection keeps the card pending');
  assert.equal(wire.of('interaction_resolved').length, 0, 'never a false resolved');
  assert.deepEqual(wire.of('interaction_state').map((e) => e.state), ['submitting', 'failed']);
  const retry = await mgr.submitInteraction('u-4', body);
  assert.equal(retry.ok, true);
  assert.equal(client.calls[0][1].commandId, client.calls[1][1].commandId, 'uncertain retry reuses the UUIDv7 handle');
});

test('identical concurrent POSTs share one flight; conflicting ones 409', async () => {
  const { mgr, client } = managerWithClient(stubClient());
  const chatId = [...mgr.slots.keys()][0];
  client._permWaiters.set('u-5', { kind: 'userInput', userInputId: 'u-5' });
  mgr._onPermission(chatId, askReq('u-5'));
  let release;
  const gate = new Promise((r) => { release = r; });
  client.answerUserInput = async (id, answers, { commandId } = {}) => {
    client.calls.push(['userInput/answer', { id, answers, commandId }]);
    await gate;
    return { commandId, status: 'accepted' };
  };
  const same = { answers: [{ questionId: 'q1', selectedLabel: 'Redis' }] };
  const p1 = mgr.submitInteraction('u-5', same);
  const p2 = mgr.submitInteraction('u-5', { answers: [{ questionId: 'q1', selectedLabel: 'Redis' }] });
  await assert.rejects(
    () => mgr.submitInteraction('u-5', { answers: [{ questionId: 'q1', selectedLabel: 'SQLite' }] }),
    (err) => err.status === 409,
  );
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.commandId, r2.commandId, 'concurrent identical POSTs share the flight');
  assert.equal(client.calls.length, 1, 'one RPC for two identical POSTs');
});

test('invalid answers 400 without touching the RPC', async () => {
  const { mgr, client } = managerWithClient(stubClient());
  const chatId = [...mgr.slots.keys()][0];
  client._permWaiters.set('u-6', { kind: 'userInput', userInputId: 'u-6' });
  mgr._onPermission(chatId, askReq('u-6'));
  await assert.rejects(
    () => mgr.submitInteraction('u-6', { answers: [] }),
    (err) => err.status === 400 && err.code === 'ANSWER_INCOMPLETE',
  );
  await assert.rejects(
    () => mgr.submitInteraction('u-6', { answers: [{ questionId: 'q1', selectedLabel: 'Nope' }] }),
    (err) => err.status === 400 && err.code === 'UNKNOWN_LABEL',
  );
  assert.equal(client.calls.length, 0, 'no RPC for invalid answers');
  assert.equal(mgr.pendingInteractions.has('u-6'), true);
});

test('approval decides share the ACK-safe path; unknown choices 400 (policy)', async () => {
  const { mgr, wire, client } = managerWithClient(stubClient());
  const chatId = [...mgr.slots.keys()][0];
  client._permWaiters.set('a-1', {
    kind: 'approval', approvalId: 'a-1', requirementId: 'req-1',
    choices: [
      { choiceId: 'approve_once', decision: 'approved', scope: 'once' },
      { choiceId: 'reject', decision: 'denied', scope: 'once' },
    ],
  });
  mgr._onPermission(chatId, approvalReq('a-1'));
  await assert.rejects(
    () => mgr.submitInteraction('a-1', { optionId: 'approve_always' }),
    (err) => err.status === 400 && err.code === 'UNKNOWN_CHOICE',
  );
  assert.equal(client.calls.length, 0, 'never decide blind');
  const res = await mgr.submitInteraction('a-1', { optionId: 'approve_once' });
  assert.equal(res.outcome, 'decided');
  assert.equal(wire.of('interaction_resolved')[0].optionId, 'approve_once');
  const dup = await mgr.submitInteraction('a-1', { optionId: 'approve_once' });
  assert.equal(dup.duplicate, true);
  await assert.rejects(
    () => mgr.submitInteraction('a-1', { optionId: 'reject' }),
    (err) => err.status === 409,
  );
});

test('explicit cancel acks to cancelled; cancel on an approval 400s', async () => {
  const { mgr, client } = managerWithClient(stubClient());
  const chatId = [...mgr.slots.keys()][0];
  client._permWaiters.set('u-7', { kind: 'userInput', userInputId: 'u-7' });
  mgr._onPermission(chatId, askReq('u-7'));
  const res = await mgr.submitInteraction('u-7', { cancel: true, reason: 'ขอข้าม' });
  assert.equal(res.outcome, 'cancelled');
  assert.equal(client.calls[0][1].reason, 'ขอข้าม');
  client._permWaiters.set('a-2', { kind: 'approval', approvalId: 'a-2', requirementId: 'r', choices: [] });
  mgr._onPermission(chatId, approvalReq('a-2'));
  await assert.rejects(
    () => mgr.submitInteraction('a-2', { cancel: true }),
    (err) => err.status === 400 && err.code === 'CANCEL_UNSUPPORTED',
  );
});

test('already-settled at the host resolves as settled-remote, truthfully', async () => {
  const { mgr, wire, client } = managerWithClient(stubClient());
  const chatId = [...mgr.slots.keys()][0];
  client._permWaiters.set('u-8', { kind: 'userInput', userInputId: 'u-8' });
  mgr._onPermission(chatId, askReq('u-8'));
  client.answerUserInput = async () => { throw rpcError(-32056, 'userInputAlreadySettled'); };
  const res = await mgr.submitInteraction('u-8', { answers: [{ questionId: 'q1', selectedLabel: 'Redis' }] });
  assert.equal(res.outcome, 'settled-remote');
  assert.equal(mgr.pendingInteractions.has('u-8'), false, 'nothing left to answer');
  assert.equal(wire.of('interaction_resolved')[0].outcome, 'settled-remote');
});

test('a binary value-rejection 400s as non-retryable, card stays', async () => {
  const { mgr, client } = managerWithClient(stubClient());
  const chatId = [...mgr.slots.keys()][0];
  client._permWaiters.set('u-9', { kind: 'userInput', userInputId: 'u-9' });
  mgr._onPermission(chatId, askReq('u-9'));
  client.answerUserInput = async () => { throw rpcError(-32057, 'userInputAnswerInvalid'); };
  await assert.rejects(
    () => mgr.submitInteraction('u-9', { answers: [{ questionId: 'q1', selectedLabel: 'Redis' }] }),
    (err) => err.status === 400 && err.code === 'ANSWER_REJECTED' && err.retryable === false,
  );
  assert.equal(mgr.pendingInteractions.has('u-9'), true);
});

test('a stale answer after the settle sweep still 404s (BUG-025)', async () => {
  const { mgr, store, client } = managerWithClient(stubClient());
  const chatId = [...mgr.slots.keys()][0];
  client._permWaiters.set('u-10', { kind: 'userInput', userInputId: 'u-10' });
  mgr.slots.get(chatId).turn = {
    turnId: 't9', text: '', thought: '', toolCalls: new Map(), plan: null,
    startedAt: Date.now(), lastActivity: Date.now(), sawActivity: false,
    settled: false, promptText: 'hi',
  };
  mgr._onPermission(chatId, askReq('u-10'));
  mgr.settleTurn(chatId, 't9', { reason: 'cancelled' });
  await assert.rejects(
    () => mgr.submitInteraction('u-10', { answers: [{ questionId: 'q1', selectedLabel: 'Redis' }] }),
    (err) => err.status === 404,
  );
  assert.ok(store, 'store kept for parity with other suites');
});

test('unknown ids 404 with a clear code', async () => {
  const { mgr } = managerWithClient(stubClient());
  await assert.rejects(
    () => mgr.submitInteraction('nope', { optionId: 'x' }),
    (err) => err.status === 404 && err.code === 'INTERACTION_GONE',
  );
});

test('engageInteraction reports engagement, false when nothing waits', () => {
  const { mgr, client } = managerWithClient(stubClient());
  const chatId = [...mgr.slots.keys()][0];
  assert.equal(mgr.engageInteraction('u-x'), false);
  client._permWaiters.set('u-11', { kind: 'userInput', userInputId: 'u-11' });
  mgr._onPermission(chatId, askReq('u-11'));
  assert.equal(mgr.engageInteraction('u-11'), true);
  assert.deepEqual(client.calls.map(([m]) => m), ['userInput/engaged']);
});

test('terminal:false keeps the approval pending for the next stage', async () => {
  const { mgr, wire, client } = managerWithClient(stubClient());
  const chatId = [...mgr.slots.keys()][0];
  client._permWaiters.set('a-s', {
    kind: 'approval', approvalId: 'a-s', requirementId: 'req-1',
    choices: [{ choiceId: 'approve_once', decision: 'approved', scope: 'once' }],
  });
  mgr._onPermission(chatId, { ...approvalReq('a-s'), requirementId: 'req-1' });
  client.decideApproval = async (id, choiceId, { commandId } = {}) => {
    client.calls.push(['approval/decide', { id, choiceId, commandId }]);
    return { choiceId, commandId, status: 'accepted', terminal: false, approvalId: id };
  };
  const res = await mgr.submitInteraction('a-s', { optionId: 'approve_once', requirementId: 'req-1' });
  assert.equal(res.ok, true);
  assert.equal(res.terminal, false);
  assert.equal(mgr.pendingInteractions.has('a-s'), true, 'a non-terminal ack must not resolve the card');
  assert.equal(wire.of('interaction_resolved').length, 0);
  assert.equal(mgr.submissions.get('a-s')?.state, 'accepted', 'the accept stays cached for idempotent retry');
});

test('an updated stage before the ack supersedes it; the re-decide lands fresh', async () => {
  const { mgr, wire, client } = managerWithClient(stubClient());
  const chatId = [...mgr.slots.keys()][0];
  const waiter = {
    kind: 'approval', approvalId: 'a-u', requirementId: 'req-1',
    choices: [
      { choiceId: 'approve_once', decision: 'approved', scope: 'once' },
      { choiceId: 'reject', decision: 'denied', scope: 'once' },
    ],
  };
  client._permWaiters.set('a-u', waiter);
  mgr._onPermission(chatId, { ...approvalReq('a-u'), requirementId: 'req-1' });
  let release;
  const gate = new Promise((r) => { release = r; });
  client.decideApproval = async (id, choiceId, { commandId } = {}) => {
    client.calls.push(['approval/decide', { id, choiceId, commandId }]);
    await gate;
    return { choiceId, commandId, status: 'accepted', terminal: true, approvalId: id };
  };
  const flight = mgr.submitInteraction('a-u', { optionId: 'approve_once', requirementId: 'req-1' });
  await new Promise((r) => setImmediate(r));
  // approval/updated wins the race: new stage, new choices, re-emitted.
  waiter.requirementId = 'req-2';
  waiter.choices = [
    { choiceId: 'approve_once', decision: 'approved', scope: 'once' },
    { choiceId: 'escalate', decision: 'approved', scope: 'once' },
  ];
  mgr._onPermission(chatId, {
    ...approvalReq('a-u'),
    requirementId: 'req-2',
    options: [{ optionId: 'approve_once', name: 'Approve once' }, { optionId: 'escalate', name: 'Escalate' }],
  });
  release();
  const first = await flight;
  assert.equal(first.superseded, true, 'the stale-stage ack must not delete the newer pending');
  assert.equal(mgr.pendingInteractions.has('a-u'), true);
  assert.equal(wire.of('interaction_resolved').length, 0);
  // A decide against the dead stage 409s with fresh choices...
  await assert.rejects(
    () => mgr.submitInteraction('a-u', { optionId: 'approve_once', requirementId: 'req-1' }),
    (err) => err.status === 409 && err.code === 'STAGE_STALE' && Array.isArray(err.choices),
  );
  // ...while the current stage lands, with a NEW command (new fence).
  const second = await mgr.submitInteraction('a-u', { optionId: 'approve_once', requirementId: 'req-2' });
  assert.equal(second.outcome, 'decided');
  assert.notEqual(client.calls[0][1].commandId, client.calls[1][1].commandId, 'next stage mints a new command');
  const dup = await mgr.submitInteraction('a-u', { optionId: 'approve_once', requirementId: 'req-2' });
  assert.equal(dup.duplicate, true);
});

test('terminal:false caches the accept: identical retry replays, next stage sends new', async () => {
  const { mgr, wire, client } = managerWithClient(stubClient());
  const chatId = [...mgr.slots.keys()][0];
  const waiter = {
    kind: 'approval', approvalId: 'a-r', requirementId: 'req-1',
    choices: [{ choiceId: 'approve_once', decision: 'approved', scope: 'once' }],
  };
  client._permWaiters.set('a-r', waiter);
  mgr._onPermission(chatId, { ...approvalReq('a-r'), requirementId: 'req-1' });
  client.decideApproval = async (id, choiceId, { commandId } = {}) => {
    client.calls.push(['approval/decide', { id, choiceId, commandId }]);
    return { choiceId, commandId, status: 'accepted', terminal: false, approvalId: id };
  };
  const first = await mgr.submitInteraction('a-r', { optionId: 'approve_once', requirementId: 'req-1' });
  assert.equal(first.terminal, false);
  // Lost-response retry before the next stage: no second RPC, same UUID.
  const retry = await mgr.submitInteraction('a-r', { optionId: 'approve_once', requirementId: 'req-1' });
  assert.equal(retry.terminal, false);
  assert.equal(retry.commandId, first.commandId, 'the retry replays the cached accept');
  assert.equal(client.calls.length, 1, 'identical retry must not send another RPC');
  assert.equal(wire.of('interaction_resolved').length, 0);
  // The next stage arrives: the same choice is a new fence → new command.
  waiter.requirementId = 'req-2';
  mgr._onPermission(chatId, { ...approvalReq('a-r'), requirementId: 'req-2' });
  const second = await mgr.submitInteraction('a-r', { optionId: 'approve_once', requirementId: 'req-2' });
  assert.equal(second.terminal, false);
  assert.equal(client.calls.length, 2, 'a new stage sends a new RPC');
  assert.notEqual(second.commandId, first.commandId, 'a new stage mints a new command');
});

test('settled-before-ack, our command wins: our choice attributed immediately', async () => {
  const { mgr, wire, client } = managerWithClient(stubClient());
  const chatId = [...mgr.slots.keys()][0];
  client._permWaiters.set('a-w', {
    kind: 'approval', approvalId: 'a-w', requirementId: 'req-1',
    choices: [{ choiceId: 'approve_once', decision: 'approved', scope: 'once' }],
  });
  mgr._onPermission(chatId, { ...approvalReq('a-w'), requirementId: 'req-1' });
  let release;
  const gate = new Promise((r) => { release = r; });
  client.decideApproval = async (id, choiceId, { commandId } = {}) => {
    client.calls.push(['approval/decide', { id, choiceId, commandId }]);
    await gate;
    return { choiceId, commandId, status: 'accepted', terminal: true, approvalId: id };
  };
  const flight = mgr.submitInteraction('a-w', { optionId: 'approve_once', requirementId: 'req-1' });
  await new Promise((r) => setImmediate(r));
  const ourCommand = client.calls[0][1].commandId;
  // The authoritative resolved frame wins the race with our ack — and its
  // winner IS our command: the emit carries our choice, immediately.
  mgr._onPermission(chatId, { id: 'a-w', resolved: true, outcome: 'approved', decidedByCommandId: ourCommand });
  assert.equal(mgr.pendingInteractions.has('a-w'), false, 'settlement is not delayed by the ack');
  const early = wire.of('interaction_resolved');
  assert.equal(early.length, 1, 'one terminal event, at settle time');
  assert.equal(early[0].optionId, 'approve_once', 'winner match attributes our submitted choice');
  assert.equal(early[0].outcome, 'approved', 'the enum stays the outcome');
  release();
  const res = await flight;
  assert.equal(res.superseded, true);
  assert.equal(res.outcome, 'approved');
  assert.equal(wire.of('interaction_resolved').length, 1, 'the late ack emits nothing');
  const dup = await mgr.submitInteraction('a-w', { optionId: 'approve_once', requirementId: 'req-1' });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.outcome, 'approved');
});

test('settled-before-ack, foreign command wins: choice null, outcome kept, retry still duplicates', async () => {
  const { mgr, wire, client } = managerWithClient(stubClient());
  const chatId = [...mgr.slots.keys()][0];
  client._permWaiters.set('a-f', {
    kind: 'approval', approvalId: 'a-f', requirementId: 'req-1',
    choices: [{ choiceId: 'approve_once', decision: 'approved', scope: 'once' }],
  });
  mgr._onPermission(chatId, { ...approvalReq('a-f'), requirementId: 'req-1' });
  let release;
  const gate = new Promise((r) => { release = r; });
  client.decideApproval = async (id, choiceId, { commandId } = {}) => {
    client.calls.push(['approval/decide', { id, choiceId, commandId }]);
    await gate;
    return { choiceId, commandId, status: 'accepted', terminal: true, approvalId: id };
  };
  const flight = mgr.submitInteraction('a-f', { optionId: 'approve_once', requirementId: 'req-1' });
  await new Promise((r) => setImmediate(r));
  // Another command settled first: immediate, but our choice is NOT
  // attributed to it — unknown choice stays null, outcome separate.
  mgr._onPermission(chatId, { id: 'a-f', resolved: true, outcome: 'denied', decidedByCommandId: 'cmd-foreign' });
  assert.equal(mgr.pendingInteractions.has('a-f'), false);
  const early = wire.of('interaction_resolved');
  assert.equal(early.length, 1);
  assert.equal(early[0].optionId, null, 'never pretend a foreign command chose our choice');
  assert.equal(early[0].outcome, 'denied');
  release();
  const res = await flight;
  assert.equal(res.superseded, true);
  assert.equal(res.outcome, 'denied', 'no downgrade of the settled outcome');
  assert.equal(wire.of('interaction_resolved').length, 1);
  // Retry bookkeeping is ours regardless of winner: the identical retry
  // (token and legacy no-token alike) duplicates instead of 404/409.
  const dup = await mgr.submitInteraction('a-f', { optionId: 'approve_once', requirementId: 'req-1' });
  assert.equal(dup.duplicate, true);
  const legacy = await mgr.submitInteraction('a-f', { optionId: 'approve_once' });
  assert.equal(legacy.duplicate, true, 'the record keeps our choice for legacy retry matching');
});

test('stage1 submit, stage2 update, external settle: resolved before the old ack', async () => {
  const { mgr, wire, client } = managerWithClient(stubClient());
  const chatId = [...mgr.slots.keys()][0];
  const waiter = {
    kind: 'approval', approvalId: 'a-x', requirementId: 'req-1',
    choices: [{ choiceId: 'approve_once', decision: 'approved', scope: 'once' }],
  };
  client._permWaiters.set('a-x', waiter);
  mgr._onPermission(chatId, { ...approvalReq('a-x'), requirementId: 'req-1' });
  let release;
  const gate = new Promise((r) => { release = r; });
  client.decideApproval = async (id, choiceId, { commandId } = {}) => {
    client.calls.push(['approval/decide', { id, choiceId, commandId }]);
    await gate; // left unresolved: the ack must not gate the settlement
    return { choiceId, commandId, status: 'accepted', terminal: false, approvalId: id };
  };
  const flight = mgr.submitInteraction('a-x', { optionId: 'approve_once', requirementId: 'req-1' });
  await new Promise((r) => setImmediate(r));
  // Stage 2 arrives mid-flight, then the agent settles the id externally.
  waiter.requirementId = 'req-2';
  mgr._onPermission(chatId, { ...approvalReq('a-x'), requirementId: 'req-2' });
  mgr._onPermission(chatId, { id: 'a-x', resolved: true, outcome: 'cancelled', reason: 'agent moved on' });
  // Assert BEFORE releasing the old ack: settlement is immediate.
  assert.equal(mgr.pendingInteractions.has('a-x'), false, 'pending clears without the ack');
  const early = wire.of('interaction_resolved');
  assert.equal(early.length, 1, 'exactly one resolved, at settle time');
  assert.equal(early[0].outcome, 'cancelled');
  assert.equal(early[0].reason, 'agent moved on');
  // The late terminal:false ack reports the settled truth — no re-pending,
  // no second event, no new RPC.
  release();
  const res = await flight;
  assert.equal(res.superseded, true);
  assert.equal(res.outcome, 'cancelled');
  assert.equal(res.terminal, undefined, 'must not claim the card is still pending');
  assert.equal(wire.of('interaction_resolved').length, 1, 'no duplicate terminal event');
  assert.equal(client.calls.length, 1, 'no second RPC');
  // Retry bookkeeping survived separately: the identical retry duplicates.
  const dup = await mgr.submitInteraction('a-x', { optionId: 'approve_once', requirementId: 'req-1' });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.outcome, 'cancelled');
});

test('settled after a failed attempt keeps the fingerprint (no 404 on retry)', async () => {
  const { mgr, client } = managerWithClient(stubClient());
  const chatId = [...mgr.slots.keys()][0];
  client._permWaiters.set('u-f', { kind: 'userInput', userInputId: 'u-f' });
  mgr._onPermission(chatId, askReq('u-f'));
  client.answerUserInput = async () => { throw new Error('transport down'); };
  const body = { answers: [{ questionId: 'q1', selectedLabel: 'Redis' }] };
  await assert.rejects(() => mgr.submitInteraction('u-f', body), (err) => err.status === 502);
  // The host settles from another path while the card shows the failure.
  mgr._onPermission(chatId, { id: 'u-f', resolved: true, outcome: 'timedOut' });
  const retry = await mgr.submitInteraction('u-f', body);
  assert.equal(retry.duplicate, true, 'identical retry after settled-while-failed must duplicate');
  assert.equal(retry.outcome, 'timedOut', 'the authoritative outcome survives');
});

test('a transport failure after a mid-flight settle lands settled, never 502', async () => {
  const { mgr, wire, client } = managerWithClient(stubClient());
  const chatId = [...mgr.slots.keys()][0];
  client._permWaiters.set('u-t', { kind: 'userInput', userInputId: 'u-t' });
  mgr._onPermission(chatId, askReq('u-t'));
  let release;
  const gate = new Promise((r) => { release = r; });
  client.answerUserInput = async () => {
    await gate;
    throw new Error('transport down');
  };
  const flight = mgr.submitInteraction('u-t', { answers: [{ questionId: 'q1', selectedLabel: 'Redis' }] });
  await new Promise((r) => setImmediate(r));
  mgr._onPermission(chatId, { id: 'u-t', resolved: true, outcome: 'cancelled', reason: 'agent moved on' });
  release();
  const res = await flight;
  assert.equal(res.ok, true);
  assert.equal(res.outcome, 'cancelled', 'the stashed authoritative outcome wins over the transport error');
  assert.deepEqual(wire.of('interaction_state').map((e) => e.state), ['submitting'], 'no failed emit after settle');
  assert.equal(wire.of('interaction_resolved').length, 1);
});

test('an acked explicit cancel enters watchdog tracking until confirmed gone', async () => {
  const { mgr, client } = managerWithClient(stubClient());
  const chatId = [...mgr.slots.keys()][0];
  client._permWaiters.set('u-c', { kind: 'userInput', userInputId: 'u-c' });
  mgr._onPermission(chatId, askReq('u-c'));
  await mgr.submitInteraction('u-c', { cancel: true });
  const tracked = mgr.slots.get(chatId).cancelledPrompts.get('u-c');
  assert.ok(tracked, 'cancel-ack must be tracked until the poll confirms the prompt gone');
});

test('snapshots expose live submit states for reconnecting renderers', async () => {
  const { mgr, client } = managerWithClient(stubClient());
  const chatId = [...mgr.slots.keys()][0];
  client._permWaiters.set('u-n', { kind: 'userInput', userInputId: 'u-n' });
  mgr._onPermission(chatId, askReq('u-n'));
  let release;
  const gate = new Promise((r) => { release = r; });
  let n = 0;
  client.answerUserInput = async (id, answers, { commandId } = {}) => {
    n++;
    if (n === 1) {
      await gate;
      throw new Error('transport down');
    }
    return { commandId, status: 'accepted' };
  };
  const body = { answers: [{ questionId: 'q1', selectedLabel: 'Redis' }] };
  const flight = mgr.submitInteraction('u-n', body);
  await new Promise((r) => setImmediate(r));
  assert.equal(mgr.listPendingInteractions()[0].submit?.state, 'submitting');
  release();
  await assert.rejects(() => flight, (err) => err.status === 502);
  const snap = mgr.listPendingInteractions()[0];
  assert.equal(snap.submit?.state, 'failed');
  assert.match(snap.submit?.error || '', /transport down/);
  const chat = mgr.chatSummary(mgr.store.get(chatId));
  assert.equal(chat.pendingInteractions[0].submit?.state, 'failed', 'chat snapshot carries it too');
});

test('ensureClient awaits the full boot, never a half-open client', async () => {
  const { mgr, store } = managerWithClient(stubClient());
  const chatId = [...mgr.slots.keys()][0];
  // A boot in flight: sessionId assigned, subscription AND config open.
  const booting = {
    sessionId: 's-boot', subscribed: false, _sessionReady: false, _closing: false,
    proc: { exitCode: null, killed: false, stdin: { writable: true, destroyed: false } },
    status: 'starting',
  };
  let release;
  const gate = new Promise((r) => { release = r; });
  mgr.slots.set(chatId, {
    client: booting, lastUsed: Date.now(), turn: null,
    subagents: new Map(), cancelledPrompts: new Map(),
    starting: gate.then(() => {
      booting.subscribed = true;
      booting._sessionReady = true;
      booting.status = 'idle';
      return booting;
    }),
  });
  const p = mgr.ensureClient(chatId);
  let settled = false;
  void p.then(() => { settled = true; });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, 'must not return before the subscription completes');
  release();
  const client = await p;
  assert.equal(client.subscribed, true);
  assert.ok(store, 'store kept for parity with other suites');
});

test('ensureClient waits out a subscribed-but-unconfigured boot', async () => {
  const { mgr, store } = managerWithClient(stubClient());
  const chatId = [...mgr.slots.keys()][0];
  // subscribed:true but config still landing (_handshake applies model/mode
  // AFTER the subscribe): the fast path must not admit it while starting.
  const booting = {
    sessionId: 's-boot', subscribed: true, _sessionReady: false, _closing: false,
    proc: { exitCode: null, killed: false, stdin: { writable: true, destroyed: false } },
    status: 'starting',
  };
  let release;
  const gate = new Promise((r) => { release = r; });
  mgr.slots.set(chatId, {
    client: booting, lastUsed: Date.now(), turn: null,
    subagents: new Map(), cancelledPrompts: new Map(),
    starting: gate.then(() => {
      booting._sessionReady = true;
      booting.status = 'idle';
      return booting;
    }),
  });
  const p = mgr.ensureClient(chatId);
  let settled = false;
  void p.then(() => { settled = true; });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, 'subscribed without config is still a partial boot');
  release();
  const client = await p;
  assert.equal(client._sessionReady, true);
  assert.ok(store, 'store kept for parity with other suites');
});

test('ensureClient heals an unsubscribed live session without a respawn', async () => {
  const { mgr } = managerWithClient(stubClient());
  const chatId = [...mgr.slots.keys()][0];
  let heals = 0;
  const live = {
    sessionId: 's-live', subscribed: false, _closing: false,
    proc: { exitCode: null, killed: false, stdin: { writable: true, destroyed: false } },
    status: 'idle',
    async ensureSubscribed() { heals++; this.subscribed = true; },
  };
  mgr.slots.set(chatId, {
    client: live, lastUsed: Date.now(), turn: null,
    subagents: new Map(), cancelledPrompts: new Map(), starting: null,
  });
  const client = await mgr.ensureClient(chatId);
  assert.equal(client, live);
  assert.equal(heals, 1, 'resubscribes instead of failing the prompt');
  const again = await mgr.ensureClient(chatId);
  assert.equal(again, live);
  assert.equal(heals, 1, 'a subscribed client returns immediately');
});

test('an authoritative settled event normalizes answers to the renderer summary (.display)', async () => {
  const { mgr, wire, client } = managerWithClient(stubClient());
  const chatId = [...mgr.slots.keys()][0];
  client._permWaiters.set('u-ax', { kind: 'userInput', userInputId: 'u-ax' });
  mgr._onPermission(chatId, askReq('u-ax'));
  let release;
  const gate = new Promise((r) => { release = r; });
  client.answerUserInput = async (id, answers, { commandId } = {}) => {
    client.calls.push(['userInput/answer', { id, answers, commandId }]);
    await gate;
    return { commandId, status: 'accepted' };
  };
  const flight = mgr.submitInteraction('u-ax', { answers: [{ questionId: 'q1', selectedLabel: 'Redis' }] });
  await new Promise((r) => setImmediate(r));
  // The settled frame wins the race; its RAW answers must still surface
  // the renderer summary — whichever path lands, .display is present.
  // The event's answer (SQLite) differs from ours (Redis): the emit must
  // carry the authoritative truth, not our flight's answer.
  mgr._onPermission(chatId, {
    id: 'u-ax', resolved: true, outcome: 'answered', decidedByCommandId: client.calls[0][1].commandId,
    answers: [{ questionId: 'q1', selectedLabel: 'SQLite' }],
  });
  const resolved = wire.of('interaction_resolved');
  assert.equal(resolved.length, 1, 'immediate, before the ack');
  assert.equal(resolved[0].answers[0].display, 'SQLite', 'the authoritative answer keeps its own display');
  assert.equal(resolved[0].answers[0].header, 'Cache', 'header resolved from the pending questions');
  release();
  const res = await flight;
  assert.equal(res.superseded, true);
  assert.equal(wire.of('interaction_resolved').length, 1, 'the late ack emits nothing');
});

test('a repeated foreign-winner settlement stays unattributed (no our-choice echo)', async () => {
  const { mgr, wire, client } = managerWithClient(stubClient());
  const chatId = [...mgr.slots.keys()][0];
  client._permWaiters.set('a-r', {
    kind: 'approval', approvalId: 'a-r', requirementId: 'req-1',
    choices: [{ choiceId: 'approve_once', decision: 'approved', scope: 'once' }],
  });
  mgr._onPermission(chatId, { ...approvalReq('a-r'), requirementId: 'req-1' });
  let release;
  const gate = new Promise((r) => { release = r; });
  client.decideApproval = async (id, choiceId, { commandId } = {}) => {
    client.calls.push(['approval/decide', { id, choiceId, commandId }]);
    await gate;
    return { choiceId, commandId, status: 'accepted', terminal: true, approvalId: id };
  };
  const flight = mgr.submitInteraction('a-r', { optionId: 'approve_once', requirementId: 'req-1' });
  await new Promise((r) => setImmediate(r));
  const evt = { id: 'a-r', resolved: true, outcome: 'denied', decidedByCommandId: 'cmd-foreign' };
  mgr._onPermission(chatId, { ...evt });
  mgr._onPermission(chatId, { ...evt }); // replay/duplicate delivery of the same frame
  const resolved = wire.of('interaction_resolved');
  assert.equal(resolved.length, 2);
  assert.equal(resolved[0].optionId, null);
  assert.equal(resolved[1].optionId, null, 'the repeat must not echo our choice via the stored winner');
  assert.equal(resolved[1].outcome, 'denied');
  release();
  const res = await flight;
  assert.equal(res.superseded, true);
  assert.equal(res.outcome, 'denied');
  const dup = await mgr.submitInteraction('a-r', { optionId: 'approve_once', requirementId: 'req-1' });
  assert.equal(dup.duplicate, true, 'the retry fingerprint survives');
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
console.log(`question-flow: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
