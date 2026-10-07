#!/usr/bin/env node
// The MSP card builders in hosts.js: approval headlines per subject kind,
// the body-only-when-it-adds-info rule, choice mapping, auto-pick helpers,
// and the single-question userInput card (multi-question shapes return null
// and the client auto-cancels them).

import assert from 'node:assert/strict';
import {
  classifyPendingUserInputs,
  formatDiffPreview,
  mspApprovalBody,
  mspApprovalCard,
  mspApprovalOptions,
  mspApprovalSummary,
  mspChoiceIsSticky,
  mspUserInputCard,
  pickMspApproveChoice,
  pickMspDenyChoice,
} from '../src/server/hosts.js';

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

test('formatDiffPreview renders path plus -/+ lines', () => {
  const out = formatDiffPreview({ path: 'a.js', oldText: 'x', newText: 'y' });
  assert.ok(out.includes('a.js'));
  assert.ok(out.includes('- x'));
  assert.ok(out.includes('+ y'));
});

test('shell approval summary is the command itself', () => {
  const s = mspApprovalSummary({
    toolName: 'Bash',
    subject: { kind: 'shell', command: 'rm -rf /tmp/demo' },
    rawArgs: '{"command":"rm -rf /tmp/demo"}',
  });
  assert.equal(s, 'rm -rf /tmp/demo');
});

test('fileAccess summary is access + path', () => {
  const s = mspApprovalSummary({
    toolName: 'write',
    subject: { kind: 'fileAccess', access: 'write', path: '/tmp/x.txt' },
  });
  assert.equal(s, 'write /tmp/x.txt');
});

test('network summary is protocol + host + port', () => {
  const s = mspApprovalSummary({
    toolName: 'fetch',
    subject: { kind: 'network', protocol: 'https', host: 'example.com', port: 443 },
  });
  assert.equal(s, 'https example.com:443');
});

test('tool summary leads with the name plus the telling arg', () => {
  const s = mspApprovalSummary({
    toolName: 'read',
    subject: { kind: 'tool' },
    rawArgs: '{"path":"/tmp/a.txt"}',
  });
  assert.equal(s, 'read /tmp/a.txt');
});

test('summary falls back to the tool name, never blank', () => {
  assert.equal(mspApprovalSummary({ toolName: 'Bash' }), 'Bash');
  assert.equal(mspApprovalSummary({}), 'tool');
});

test('body is empty when it would duplicate the summary', () => {
  assert.equal(
    mspApprovalBody({
      toolName: 'Bash',
      subject: { kind: 'shell', command: 'ls' },
      rawArgs: '{"command":"ls"}',
    }),
    '',
  );
});

test('body carries the full detail when it adds information', () => {
  const body = mspApprovalBody({
    toolName: 'Bash',
    subject: { kind: 'shell', command: `ls ${'x'.repeat(300)}` },
    rawArgs: '{"command":"ls xxx"}',
  });
  assert.ok(body.length > 240, 'full command must survive, not the 240-char headline');
});

test('tool body pretty-prints the verbatim args JSON', () => {
  const body = mspApprovalBody({
    toolName: 'read',
    subject: { kind: 'tool' },
    rawArgs: '{"path":"/tmp/a.txt","limit":5}',
  });
  assert.ok(body.includes('/tmp/a.txt'));
});

test('approval card keeps ids, toolCallId and choices', () => {
  const card = mspApprovalCard({
    approvalId: 'ap-1',
    currentRequirementId: 'req-9',
    toolName: 'Bash',
    toolCallId: 'tc-1',
    subject: { kind: 'shell', command: 'ls' },
    rawArgs: '{"command":"ls"}',
    availableChoices: [
      { choiceId: 'approve_once', label: 'Approve once', decision: 'approved', scope: 'once' },
      { choiceId: 'reject', label: 'Reject', decision: 'denied', scope: 'once' },
    ],
  });
  assert.equal(card.id, 'ap-1');
  assert.equal(card.approvalId, 'ap-1');
  assert.equal(card.requirementId, 'req-9');
  assert.equal(card.toolCallId, 'tc-1');
  assert.equal(card.subtype, null);
  assert.deepEqual(
    card.options.map((o) => o.optionId),
    ['approve_once', 'reject'],
  );
});

test('approval card is null without an approval id', () => {
  assert.equal(mspApprovalCard({ toolName: 'Bash' }), null);
});

test('choices without ids are dropped, never blank buttons', () => {
  const options = mspApprovalOptions({
    availableChoices: [{ choiceId: 'ok', label: 'Ok' }, { label: 'nameless' }],
  });
  assert.deepEqual(options.map((o) => o.optionId), ['ok']);
});

test('auto-approve prefers the widest approve grant', () => {
  const pick = pickMspApproveChoice([
    { choiceId: 'once', decision: 'approved', scope: 'once' },
    { choiceId: 'sess', decision: 'approvedForSession', scope: 'session' },
  ]);
  assert.equal(pick.choiceId, 'sess');
});

test('auto-approve is null when nothing approves', () => {
  assert.equal(pickMspApproveChoice([{ choiceId: 'no', decision: 'denied' }]), null);
  assert.equal(pickMspApproveChoice([]), null);
});

test('deny pick prefers an explicit deny', () => {
  const pick = pickMspDenyChoice([
    { choiceId: 'a', decision: 'approved' },
    { choiceId: 'd', decision: 'denied' },
  ]);
  assert.equal(pick.choiceId, 'd');
});

test('sticky engages on session scope or an always-named id', () => {
  assert.equal(mspChoiceIsSticky({ choiceId: 'x', scope: 'session' }), true);
  assert.equal(mspChoiceIsSticky({ choiceId: 'x', scope: 'localPersistent' }), true);
  assert.equal(mspChoiceIsSticky({ choiceId: 'approve_always', scope: 'once' }), true);
  assert.equal(mspChoiceIsSticky({ choiceId: 'approve_once', scope: 'once' }), false);
});

test('single-question userInput becomes an ask card with label ids', () => {
  const card = mspUserInputCard({
    userInputId: 'q-1',
    toolName: 'AskUserQuestion',
    toolCallId: 'tc-q',
    questions: [
      {
        id: 'q1',
        question: 'ควรเก็บ cache ไว้ที่ไหน?',
        selection: { mode: 'single' },
        options: [{ label: 'Redis' }, { label: 'SQLite in-memory' }, { label: 'Skip' }],
      },
    ],
  });
  assert.equal(card.id, 'q-1');
  assert.equal(card.subtype, 'ask');
  assert.ok(card.body.includes('ควรเก็บ cache ไว้ที่ไหน?'));
  assert.deepEqual(
    card.options.map((o) => o.optionId),
    ['Redis', 'SQLite in-memory', 'Skip'],
  );
});

test('multi-question, multi-select and option-less prompts return null', () => {
  const base = { userInputId: 'q-x', questions: [] };
  assert.equal(
    mspUserInputCard({
      ...base,
      questions: [
        { id: 'a', question: 'A?', selection: { mode: 'single' }, options: [{ label: 'y' }] },
        { id: 'b', question: 'B?', selection: { mode: 'single' }, options: [{ label: 'z' }] },
      ],
    }),
    null,
  );
  assert.equal(
    mspUserInputCard({
      ...base,
      questions: [{ id: 'a', question: 'A?', selection: { mode: 'multi' }, options: [{ label: 'y' }] }],
    }),
    null,
  );
  assert.equal(
    mspUserInputCard({
      ...base,
      questions: [{ id: 'a', question: 'A?', selection: { mode: 'single' }, options: [] }],
    }),
    null,
  );
  assert.equal(mspUserInputCard({ questions: [] }), null);
});

test('pending poll mounts single cards and cancels the rest (BUG-084)', () => {
  const single = {
    userInputId: 'u-single',
    questions: [{ id: 'a', question: 'A?', selection: { mode: 'single' }, options: [{ label: 'y' }] }],
  };
  const multi = {
    userInputId: 'u-multi',
    questions: [
      { id: 'a', question: 'A?', selection: { mode: 'single' }, options: [{ label: 'y' }] },
      { id: 'b', question: 'B?', selection: { mode: 'single' }, options: [{ label: 'z' }] },
    ],
  };
  const out = classifyPendingUserInputs({ pending: [single, multi] });
  assert.deepEqual(out.mount.map((p) => p.userInputId), ['u-single']);
  assert.deepEqual(out.cancel.map((p) => p.userInputId), ['u-multi']);
  assert.deepEqual(out.escalate, []);
});

test('pending poll skips mounted cards and in-grace cancels (BUG-084)', () => {
  const mounted = {
    userInputId: 'u-mounted',
    questions: [{ id: 'a', question: 'A?', selection: { mode: 'single' }, options: [{ label: 'y' }] }],
  };
  const fresh = {
    userInputId: 'u-fresh',
    questions: [
      { id: 'a', question: 'A?', selection: { mode: 'single' }, options: [{ label: 'y' }] },
      { id: 'b', question: 'B?', selection: { mode: 'single' }, options: [{ label: 'z' }] },
    ],
  };
  const out = classifyPendingUserInputs({
    pending: [mounted, fresh],
    knownIds: new Set(['u-mounted']),
    cancelledAt: new Map([['u-fresh', 10_000]]),
    now: 20_000,
    graceMs: 30_000,
  });
  assert.deepEqual(out.mount, []);
  assert.deepEqual(out.cancel, []);
  assert.deepEqual(out.escalate, []);
});

test('a cancel the agent ignored past grace escalates (BUG-084)', () => {
  const stuck = {
    userInputId: 'u-stuck',
    questions: [{ id: 'a', question: 'A?', selection: { mode: 'single' }, options: [] }],
  };
  const out = classifyPendingUserInputs({
    pending: [stuck],
    cancelledAt: new Map([['u-stuck', 10_000]]),
    now: 41_000,
    graceMs: 30_000,
  });
  assert.deepEqual(out.mount, []);
  assert.deepEqual(out.cancel, []);
  assert.equal(out.escalate.length, 1);
  assert.equal(out.escalate[0].userInputId, 'u-stuck');
  assert.equal(out.escalate[0].waitedMs, 31_000);
});

test('pending poll dedupes repeats and drops id-less entries (BUG-084)', () => {
  const dup = {
    userInputId: 'u-dup',
    questions: [
      { id: 'a', question: 'A?', selection: { mode: 'single' }, options: [{ label: 'y' }] },
      { id: 'b', question: 'B?', selection: { mode: 'single' }, options: [{ label: 'z' }] },
    ],
  };
  const out = classifyPendingUserInputs({ pending: [dup, dup, { questions: [] }, null] });
  assert.deepEqual(out.cancel.map((p) => p.userInputId), ['u-dup']);
  assert.deepEqual(out.mount, []);
  assert.deepEqual(out.escalate, []);
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
console.log(`permission-host: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
