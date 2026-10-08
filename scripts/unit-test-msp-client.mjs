#!/usr/bin/env node
// MSP client invariants: the notification channel is load-bearing — a client
// that cannot hear the agent must fail loud at spawn, never serve deaf turns.

import assert from 'node:assert/strict';
import os from 'node:os';
import { MspClient, isMcpAuditFailedError, toolTitle } from '../src/server/msp-client.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('ensureSubscribed resolves and marks subscribed on first success', async () => {
  const client = new MspClient({ cwd: os.tmpdir() });
  client.sessionId = 's-1';
  let calls = 0;
  client.request = async (method) => {
    calls++;
    assert.equal(method, 'view/subscribe');
    return {};
  };
  await client.ensureSubscribed({ delayMs: 1 });
  assert.equal(client.subscribed, true);
  assert.equal(calls, 1);
});

test('ensureSubscribed retries transient failures, then succeeds', async () => {
  const client = new MspClient({ cwd: os.tmpdir() });
  client.sessionId = 's-1';
  let calls = 0;
  const stderr = [];
  client.on('stderr', (t) => stderr.push(t));
  client.request = async () => {
    calls++;
    if (calls < 3) throw new Error('boom');
    return {};
  };
  await client.ensureSubscribed({ delayMs: 1 });
  assert.equal(client.subscribed, true);
  assert.equal(calls, 3);
  assert.equal(stderr.length, 2, 'each failed attempt must be visible');
});

test('ensureSubscribed throws SUBSCRIBE_FAILED after exhausting attempts', async () => {
  const client = new MspClient({ cwd: os.tmpdir() });
  client.sessionId = 's-1';
  let calls = 0;
  client.request = async () => {
    calls++;
    throw new Error('nope');
  };
  await assert.rejects(
    () => client.ensureSubscribed({ attempts: 3, delayMs: 1 }),
    /view\/subscribe failed after 3 attempts/,
  );
  assert.equal(client.subscribed, false);
  assert.equal(calls, 3);
});

test('prompt refuses to run deaf (NOT_SUBSCRIBED)', async () => {
  const client = new MspClient({ cwd: os.tmpdir() });
  client.sessionId = 's-1';
  client.subscribed = false;
  await assert.rejects(() => client.prompt('hi'), /not subscribed/);
});

test('dropped turn/completed emits a diagnostic, never throws', () => {
  const client = new MspClient({ cwd: os.tmpdir() });
  const stderr = [];
  client.on('stderr', (t) => stderr.push(t));
  client._onTurnCompleted({ turnId: 'ghost', terminal: 'completed' }); // no active turn
  assert.equal(stderr.length, 1);
  assert.match(stderr[0], /no active turn/);
  client._activeTurn = { mspTurnId: 'live', resolve: () => {}, reject: () => {}, text: '' };
  client._onTurnCompleted({ turnId: 'stale', terminal: 'cancelled' }); // mismatched id
  assert.equal(stderr.length, 2);
  assert.match(stderr[1], /superseded/);
  assert.ok(client._activeTurn, 'a stale completion must not uninstall the live waiter');
});

test('isMcpAuditFailedError matches the verbatim production reason (BUG-082)', () => {
  const verbatim = 'invalid run configuration: MCP startup audit failed; MCP is disabled for this runtime';
  assert.equal(isMcpAuditFailedError(new Error(verbatim)), true);
  assert.equal(isMcpAuditFailedError({ message: verbatim }), true);
  assert.equal(isMcpAuditFailedError({ rpc: { message: verbatim } }), true);
  const wrapped = new Error('turn failed');
  wrapped.rpc = { message: verbatim };
  assert.equal(isMcpAuditFailedError(wrapped), true, 'failed-turn shape carries reason under rpc');
});

test('isMcpAuditFailedError rejects nearby failures', () => {
  assert.equal(isMcpAuditFailedError(new Error('turn failed')), false);
  assert.equal(isMcpAuditFailedError(new Error('Session not found; start a new session')), false);
  assert.equal(isMcpAuditFailedError(new Error('MCP inventory is unavailable')), false);
  assert.equal(isMcpAuditFailedError(null), false);
  assert.equal(isMcpAuditFailedError(undefined), false);
});

const singleParams = (id) => ({
  userInputId: id,
  toolName: 'AskUserQuestion',
  questions: [
    { id: 'q1', question: 'Pick?', selection: { mode: 'single' }, options: [{ label: 'a' }, { label: 'b' }] },
  ],
});
const multiParams = (id) => ({
  userInputId: id,
  toolName: 'AskUserQuestion',
  questions: [
    { id: 'q1', question: 'First?', selection: { mode: 'single' }, options: [{ label: 'a' }] },
    { id: 'q2', question: 'Second?', selection: { mode: 'single' }, options: [{ label: 'x' }] },
  ],
});
// Malformed: unknown selection mode — no form can answer it.
const brokenParams = (id) => ({
  userInputId: id,
  toolName: 'AskUserQuestion',
  questions: [
    { id: 'q1', question: 'Bogus?', selection: { mode: 'fuzzy' }, options: [{ label: 'a' }] },
  ],
});

test('recoverUserInput mounts single AND multi as cards, cancels malformed (BUG-084)', async () => {
  const client = new MspClient({ cwd: os.tmpdir() });
  client.sessionId = 's-1';
  const sent = [];
  client.request = async (method, params) => {
    sent.push([method, params]);
    return {};
  };
  const perms = [];
  const updates = [];
  client.on('permission', (p) => perms.push(p));
  client.on('update', (u) => updates.push(u));
  assert.equal(client.recoverUserInput(singleParams('u-1'), 'poll'), 'card');
  assert.equal(perms.length, 1);
  assert.equal(perms[0].subtype, 'ask');
  assert.equal(client.hasInteractiveWaiter('u-1'), true);
  // Multi-question mounts since 1.1.33 — the form answers every question.
  assert.equal(client.recoverUserInput(multiParams('u-2'), 'poll'), 'card');
  assert.equal(perms.length, 2);
  assert.deepEqual(perms[1].questions.map((q) => q.id), ['q1', 'q2']);
  assert.equal(client.recoverUserInput(brokenParams('u-3'), 'poll'), 'cancelled');
  assert.ok(updates.some((u) => u.sessionUpdate === 'msp:user_input_unsupported'), 'malformed must leave the unsupported trace');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent.map(([m]) => m), ['userInput/cancel']);
  assert.equal(sent[0][1].userInputId, 'u-3');
  assert.ok(sent[0][1].reason?.length > 0, 'the cancel must carry a reason (binary 1.4.2 rejects reason-less cancels)');
});

test('recoverUserInput dedupes repeats and nulls id-less frames (BUG-084)', async () => {
  const client = new MspClient({ cwd: os.tmpdir() });
  client.sessionId = 's-1';
  client.request = async () => ({});
  let cards = 0;
  client.on('permission', () => cards++);
  assert.equal(client.recoverUserInput(singleParams('u-9')), 'card');
  assert.equal(client.recoverUserInput(singleParams('u-9')), 'duplicate');
  assert.equal(cards, 1, 'request + notification must mount exactly one card');
  assert.equal(client.recoverUserInput({ questions: [] }), null);
});

test('the cancel path dedupes the request + notification pair (BUG-084)', async () => {
  const client = new MspClient({ cwd: os.tmpdir() });
  client.sessionId = 's-1';
  let cancels = 0;
  client.request = async () => { cancels++; return {}; };
  let traces = 0;
  client.on('update', (u) => { if (u.sessionUpdate === 'msp:user_input_unsupported') traces++; });
  assert.equal(client.recoverUserInput(brokenParams('u-pair')), 'cancelled');
  assert.equal(client.recoverUserInput(brokenParams('u-pair')), 'duplicate');
  await new Promise((r) => setImmediate(r));
  assert.equal(cancels, 1, 'exactly one cancel RPC for the pair');
  assert.equal(traces, 1, 'exactly one transcript notice for the pair');
});

test('a rejected userInput/cancel is loud, never swallowed (BUG-084)', async () => {
  const client = new MspClient({ cwd: os.tmpdir() });
  client.sessionId = 's-1';
  client.request = async () => { throw new Error('rejected by host'); };
  const stderr = [];
  client.on('stderr', (t) => stderr.push(t));
  assert.equal(client.recoverUserInput(brokenParams('u-loud')), 'cancelled');
  await new Promise((r) => setImmediate(r));
  assert.equal(stderr.length, 1);
  assert.match(stderr[0], /userInput\/cancel FAILED/);
  assert.match(stderr[0], /u-loud/);
});

test('decideApproval acks then drops the waiter; a rejection keeps it', async () => {
  const waiter = () => ({
    kind: 'approval', approvalId: 'a9', requirementId: 'req-1',
    choices: [{ choiceId: 'approve_once', decision: 'approved', scope: 'once' }],
    resolve: () => {}, reject: () => {},
  });
  const ok = new MspClient({ cwd: os.tmpdir() });
  ok.sessionId = 's-1';
  ok.request = async () => ({ status: 'accepted', terminal: true, approvalId: 'a9' });
  ok._permWaiters.set('a9', waiter());
  const res = await ok.decideApproval('a9', 'approve_once');
  assert.equal(res.choiceId, 'approve_once');
  assert.equal(ok.hasInteractiveWaiter('a9'), false, 'acked decide drops the waiter');
  const bad = new MspClient({ cwd: os.tmpdir() });
  bad.sessionId = 's-1';
  bad.request = async () => { throw new Error('rejected by host'); };
  bad.on('stderr', () => {});
  bad._permWaiters.set('a9', waiter());
  await assert.rejects(() => bad.decideApproval('a9', 'approve_once'), /rejected by host/);
  assert.equal(bad.hasInteractiveWaiter('a9'), true, 'rejected decide keeps the waiter for the retry');
  await assert.rejects(() => bad.decideApproval('a9', 'nope'), /unknown choice/);
});

test('decideApproval sends sessionId and staged terminal semantics', async () => {
  const waiter = () => ({
    kind: 'approval', approvalId: 'a9', requirementId: 'req-1',
    choices: [{ choiceId: 'approve_once', decision: 'approved', scope: 'once' }],
    resolve: () => {}, reject: () => {},
  });
  const sent = [];
  const staged = new MspClient({ cwd: os.tmpdir() });
  staged.sessionId = 's-1';
  staged.request = async (method, params) => {
    sent.push([method, params]);
    return { status: 'accepted', terminal: false, approvalId: 'a9' };
  };
  staged._permWaiters.set('a9', waiter());
  const res = await staged.decideApproval('a9', 'approve_once');
  assert.equal(res.terminal, false);
  assert.equal(sent[0][1].sessionId, 's-1', 'decide params require sessionId (schema)');
  assert.equal(sent[0][1].requirementId, 'req-1');
  assert.equal(staged.hasInteractiveWaiter('a9'), true, 'terminal:false keeps the waiter for the next stage');
  const bad = new MspClient({ cwd: os.tmpdir() });
  bad.sessionId = 's-1';
  bad.request = async () => ({ status: 'accepted' });
  bad.on('stderr', () => {});
  bad._permWaiters.set('a9', waiter());
  await assert.rejects(() => bad.decideApproval('a9', 'approve_once'), /ack invalid/);
  assert.equal(bad.hasInteractiveWaiter('a9'), true, 'a malformed ack is a failure, never success');
});

test('sticky engages only after a validated approve ack (never deny, never pre-RPC)', async () => {
  const waiter = (choices) => ({
    kind: 'approval', approvalId: 'a9', requirementId: 'req-1', choices,
    resolve: () => {}, reject: () => {},
  });
  // A session-scoped DENY must not arm approve-sticky.
  const deny = new MspClient({ cwd: os.tmpdir() });
  deny.sessionId = 's-1';
  deny.request = async () => ({ status: 'accepted', terminal: true });
  deny._permWaiters.set('a9', waiter([{ choiceId: 'deny_session', decision: 'denied', scope: 'session' }]));
  await deny.decideApproval('a9', 'deny_session');
  assert.equal(deny.permissionStickyApprove, false, 'a deny must never arm approve-sticky');
  // A failed RPC must not arm it either.
  const fail = new MspClient({ cwd: os.tmpdir() });
  fail.sessionId = 's-1';
  fail.request = async () => { throw new Error('down'); };
  fail.on('stderr', () => {});
  fail._permWaiters.set('a9', waiter([{ choiceId: 'approve_always', decision: 'approvedForSession', scope: 'session' }]));
  await assert.rejects(() => fail.decideApproval('a9', 'approve_always'), /down/);
  assert.equal(fail.permissionStickyApprove, false, 'sticky only after a validated ack');
});

test('answerUserInput keeps the waiter until the ack', async () => {
  const waiter = () => ({ kind: 'userInput', userInputId: 'u9', resolve: () => {}, reject: () => {} });
  const sent = [];
  const client = new MspClient({ cwd: os.tmpdir() });
  client.sessionId = 's-1';
  client.request = async (method, params) => { sent.push([method, params]); return { status: 'accepted' }; };
  client._permWaiters.set('u9', waiter());
  const answers = [{ questionId: 'q1', selectedLabel: 'a' }];
  const res = await client.answerUserInput('u9', answers, { commandId: 'cmd-1' });
  assert.equal(res.commandId, 'cmd-1', 'caller-owned commandId rides the RPC');
  assert.deepEqual(sent[0][1].answers, answers);
  assert.equal(client.hasInteractiveWaiter('u9'), false);
  const failing = new MspClient({ cwd: os.tmpdir() });
  failing.sessionId = 's-1';
  failing.request = async () => { throw new Error('boom'); };
  failing.on('stderr', () => {});
  failing._permWaiters.set('u9', waiter());
  await assert.rejects(() => failing.answerUserInput('u9', answers), /boom/);
  assert.equal(failing.hasInteractiveWaiter('u9'), true, 'the card stays answerable after a rejection');
});

test('userInput/settled forwards the authoritative outcome, not a blanket answered', () => {
  const client = new MspClient({ cwd: os.tmpdir() });
  client._permWaiters.set('u7', { kind: 'userInput', userInputId: 'u7', resolve: () => {}, reject: () => {} });
  const perms = [];
  client.on('permission', (p) => perms.push(p));
  client._onNotification('userInput/settled', {
    sessionId: 's-1', userInputId: 'u7', outcome: 'timedOut',
    decidedByCommandId: 'cmd-9', reason: 'auto-resolution',
  });
  assert.equal(perms.length, 1);
  assert.equal(perms[0].outcome, 'timedOut');
  assert.equal(perms[0].optionId, null, 'the outcome enum is never the optionId');
  assert.equal(perms[0].decidedByCommandId, 'cmd-9');
  assert.equal(client.hasInteractiveWaiter('u7'), false);
});

test('approval/resolved carries the decision as outcome, never as optionId', () => {
  const client = new MspClient({ cwd: os.tmpdir() });
  client._permWaiters.set('a1', { kind: 'approval', approvalId: 'a1', resolve: () => {}, reject: () => {} });
  const perms = [];
  client.on('permission', (p) => perms.push(p));
  client._onNotification('approval/resolved', {
    sessionId: 's-1', approvalId: 'a1', decision: 'approvedForSession', decidedByCommandId: 'cmd-4',
  });
  assert.equal(perms.length, 1);
  assert.equal(perms[0].resolved, true);
  assert.equal(perms[0].outcome, 'approvedForSession', 'the enum stays the outcome');
  assert.equal(perms[0].optionId, null, 'no choice identity on the wire — sessions attributes via winner match');
  assert.equal(perms[0].decidedByCommandId, 'cmd-4');
});

test('engageUserInput notifies once per id and never throws', () => {
  const client = new MspClient({ cwd: os.tmpdir() });
  client.sessionId = 's-1';
  const sent = [];
  client.notify = (method, params) => sent.push([method, params]);
  assert.equal(client.engageUserInput('u-e'), true);
  assert.equal(client.engageUserInput('u-e'), true, 'repeat engage is a deduped no-op');
  assert.deepEqual(sent.map(([m]) => m), ['userInput/engaged']);
  assert.equal(sent[0][1].userInputId, 'u-e');
  assert.ok(!('commandId' in sent[0][1]), 'engaged carries no commandId (schema)');
  const dead = new MspClient({ cwd: os.tmpdir() });
  dead.sessionId = 's-1';
  dead.notify = () => { throw new Error('stdin gone'); };
  dead.on('stderr', () => {});
  assert.equal(dead.engageUserInput('u-e'), false);
});

test('cancelInteractive sweeps approvals to deny and questions to cancel', async () => {
  const client = new MspClient({ cwd: os.tmpdir() });
  client.sessionId = 's-1';
  const sent = [];
  client.request = async (method, params) => { sent.push([method, params]); return {}; };
  client._permWaiters.set('a-s', {
    kind: 'approval', approvalId: 'a-s', requirementId: 'req-1',
    choices: [
      { choiceId: 'approve_once', decision: 'approved', scope: 'once' },
      { choiceId: 'reject', decision: 'denied', scope: 'once' },
    ],
    resolve: () => {}, reject: () => {},
  });
  client._permWaiters.set('u-s', { kind: 'userInput', userInputId: 'u-s', resolve: () => {}, reject: () => {} });
  assert.equal(client.cancelInteractive('a-s', 'turn settled'), true);
  assert.equal(client.cancelInteractive('u-s', 'turn settled'), true);
  assert.equal(client.cancelInteractive('missing', 'turn settled'), false);
  await new Promise((r) => setImmediate(r));
  const decide = sent.find(([m]) => m === 'approval/decide');
  assert.equal(decide[1].choiceId, 'reject', 'the sweep denies, never approves');
  const cancel = sent.find(([m]) => m === 'userInput/cancel');
  assert.equal(cancel[1].reason, 'turn settled');
});

test('listPending normalizes the snapshot to arrays (BUG-084)', async () => {
  const client = new MspClient({ cwd: os.tmpdir() });
  client.sessionId = 's-1';
  client.request = async (method, params) => {
    assert.equal(method, 'approval/listPending');
    assert.equal(params.sessionId, 's-1');
    return { approvals: [{ approvalId: 'a1' }], userInputs: null };
  };
  assert.deepEqual(await client.listPending(), { approvals: [{ approvalId: 'a1' }], userInputs: [] });
});

test('interrupt sends turn/interrupt without touching the waiter (BUG-084)', async () => {
  const client = new MspClient({ cwd: os.tmpdir() });
  client.sessionId = 's-1';
  const waiter = { mspTurnId: 'msp-t-1', resolve: () => {}, reject: () => {}, text: '' };
  client._activeTurn = waiter;
  let got = null;
  client.request = async (method, params) => { got = [method, params]; return {}; };
  assert.equal(await client.interrupt(), true);
  assert.equal(got[0], 'turn/interrupt');
  assert.equal(got[1].turnId, 'msp-t-1');
  assert.equal(client._activeTurn, waiter, 'escalation settles the turn itself');
});

test('toolCall completion carries visibleOutput for instant tools', () => {
  const client = new MspClient({ cwd: os.tmpdir() });
  const updates = [];
  client.on('update', (u) => updates.push(u));
  client._onItemEvent('item/started', { item: {
    itemId: 'tc-spawn', kind: 'toolCall', status: 'inProgress', tool: 'subagent_spawn',
    callId: 'call-1', args: '{"task_name":"a"}', turnId: 't-1',
  } });
  // No deltas — instant tools land their whole output on completion.
  client._onItemEvent('item/completed', { item: {
    itemId: 'tc-spawn', kind: 'toolCall', status: 'completed', tool: 'subagent_spawn',
    callId: 'call-1', args: '{"task_name":"a"}', turnId: 't-1',
    visibleOutput: '{"status":"accepted","subagent_id":"sub-a"}',
  } });
  const done = updates.find((u) => u.sessionUpdate === 'tool_call_update');
  assert.ok(done, 'completion must emit');
  assert.match(done.rawOutput, /sub-a/, 'visibleOutput must reach the row, not vanish');
});

test('streamed tool output keeps winning over visibleOutput', () => {
  const client = new MspClient({ cwd: os.tmpdir() });
  const updates = [];
  client.on('update', (u) => updates.push(u));
  client._onItemEvent('item/started', { item: {
    itemId: 'tc-bash', kind: 'toolCall', status: 'inProgress', tool: 'Bash',
    callId: 'call-2', args: 'ls', turnId: 't-1',
  } });
  client._onItemEvent('item/delta', { itemId: 'tc-bash', field: 'output', delta: 'full-streamed-text' });
  client._onItemEvent('item/completed', { item: {
    itemId: 'tc-bash', kind: 'toolCall', status: 'completed', tool: 'Bash',
    callId: 'call-2', args: 'ls', turnId: 't-1', visibleOutput: 'bounded…',
  } });
  const done = updates.find((u) => u.sessionUpdate === 'tool_call_update');
  assert.equal(done.rawOutput, 'full-streamed-text', 'live rows must not shrink to the bounded text');
});

test('toolTitle prefers the human topic over the raw command', () => {
  assert.equal(
    toolTitle('Bash', '{"command":"ls /tmp/mock","description":"ตรวจไฟล์ชั่วคราว"}'),
    'ตรวจไฟล์ชั่วคราว',
  );
  assert.equal(
    toolTitle('Edit', '{"file_path":"src/a.js","summary":"แก้ import วงจร"}'),
    'แก้ import วงจร',
  );
  assert.equal(toolTitle('Read', '{"path":"x","topic":"อ่าน config"}'), 'อ่าน config');
  // The topic stands alone — the kind chip + status verb already name the tool.
  assert.ok(!toolTitle('Bash', '{"command":"ls","description":"d"}').startsWith('Bash'));
});

test('toolTitle reads agent-task topics (objective/task_name)', () => {
  assert.equal(
    toolTitle('subagent_spawn', '{"task_name":"old-probe","objective":"answer old","role":"research"}'),
    'answer old',
    'objective outranks task_name',
  );
  assert.equal(toolTitle('subagent_spawn', '{"task_name":"old-probe"}'), 'old-probe');
  assert.ok(
    !toolTitle('subagent_spawn', '{"task_name":"a"}').includes('{'),
    'never a raw JSON dump',
  );
});

test('toolTitle falls back to short technical labels, never raw JSON', () => {
  assert.equal(toolTitle('Read', '{"file_path":"src/deeply/nested/auth.js"}'), 'Read auth.js');
  assert.equal(toolTitle('Read', '{"path":"C:\\\\proj\\\\cfg.yaml"}'), 'Read cfg.yaml');
  assert.equal(toolTitle('Bash', '{"command":"ls"}'), 'Bash ls');
  assert.equal(
    toolTitle('Bash', '{"command":"sleep 1\\nrm -rf /tmp/x"}'),
    'Bash sleep 1 rm -rf /tmp/x',
    'multiline commands flatten to one line',
  );
  assert.ok(toolTitle('Bash', `{"command":"${'x'.repeat(200)}"}`).length <= 'Bash '.length + 80);
  assert.equal(toolTitle('mcp__github.search_repositories', '{"query":"mcp"}'), 'mcp__github.search_repositories');
  assert.equal(toolTitle('Bash', 'ls'), 'Bash ls', 'non-JSON args slice short');
  assert.equal(toolTitle('Bash', ''), 'Bash');
  assert.equal(toolTitle('Bash', null), 'Bash');
  assert.equal(toolTitle(null, null), 'tool');
});

test('toolTitle tolerates object args and skips empty topics', () => {
  assert.equal(toolTitle('Bash', { command: 'ls', description: '' }), 'Bash ls');
  assert.equal(toolTitle('Bash', { command: 'ls', description: '  ' }), 'Bash ls');
  assert.equal(toolTitle('Bash', { description: 'หัวข้อ', command: 'ls' }), 'หัวข้อ');
});

test('tool_call events carry the topic title end to end (client level)', () => {
  const client = new MspClient({ cwd: os.tmpdir() });
  const updates = [];
  client.on('update', (u) => updates.push(u));
  client._onItemEvent('item/started', { item: {
    itemId: 'tc-topic', kind: 'toolCall', status: 'inProgress', tool: 'Bash',
    callId: 'call-3', args: '{"command":"ls /tmp/mock","description":"ตรวจไฟล์ชั่วคราว"}', turnId: 't-1',
  } });
  const started = updates.find((u) => u.sessionUpdate === 'tool_call');
  assert.equal(started.title, 'ตรวจไฟล์ชั่วคราว');
  assert.ok(!started.title.includes('ls /tmp/mock'), 'the raw command must not leak into the title');
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
console.log(`msp-client: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
