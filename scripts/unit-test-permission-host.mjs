#!/usr/bin/env node
// The MSP card builders in hosts.js: approval headlines per subject kind,
// the body-only-when-it-adds-info rule, choice mapping, auto-pick helpers,
// the multi-shape userInput form card, and the answer validators the
// submit path enforces before any RPC goes out.

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
  submissionKey,
  summarizeUserInputAnswers,
  USER_INPUT_TEXT_MAX,
  validateApprovalDecision,
  validateUserInputAnswers,
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

test('multi-question and multi-select prompts mount a form card (1.1.33)', () => {
  const card = mspUserInputCard({
    userInputId: 'q-m',
    questions: [
      { id: 'a', header: 'A', question: 'A?', selection: { mode: 'single' }, options: [{ label: 'y' }] },
      {
        id: 'b', header: 'B', question: 'B?', selection: { mode: 'multiple', minSelections: 1, maxSelections: 2 },
        options: [{ label: 'x' }, { label: 'z' }],
      },
    ],
  });
  assert.ok(card, 'multi-question must mount, not auto-cancel');
  assert.equal(card.subtype, 'ask');
  assert.deepEqual(card.questions.map((q) => q.id), ['a', 'b']);
  assert.equal(card.questions[1].mode, 'multiple');
  assert.equal(card.questions[1].maxSelections, 2);
  assert.match(card.summary, /2 คำถาม/);
  assert.deepEqual(card.options, [], 'multi cards answer through the form, not quick-pick buttons');
});

test('an options-less question mounts as free-text (1.1.33)', () => {
  const card = mspUserInputCard({
    userInputId: 'q-f',
    questions: [{ id: 'a', header: 'Why', question: 'Why?', selection: { mode: 'single' }, options: [] }],
  });
  assert.ok(card);
  assert.equal(card.questions[0].freeText, true);
  assert.deepEqual(card.options, []);
});

test('malformed prompts still return null (auto-cancel with a trace)', () => {
  const base = { userInputId: 'q-x', questions: [] };
  // Unknown selection mode.
  assert.equal(
    mspUserInputCard({
      ...base,
      questions: [{ id: 'a', question: 'A?', selection: { mode: 'fuzzy' }, options: [{ label: 'y' }] }],
    }),
    null,
  );
  // Missing question id.
  assert.equal(
    mspUserInputCard({
      ...base,
      questions: [{ question: 'A?', selection: { mode: 'single' }, options: [{ label: 'y' }] }],
    }),
    null,
  );
  assert.equal(mspUserInputCard({ ...base, questions: [] }), null);
  assert.equal(mspUserInputCard({ questions: [] }), null);
  assert.equal(mspUserInputCard({}), null);
});

test('pending poll mounts every well-formed card and cancels only malformed (BUG-084)', () => {
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
  const broken = {
    userInputId: 'u-broken',
    questions: [{ id: 'a', question: 'A?', selection: { mode: 'fuzzy' }, options: [{ label: 'y' }] }],
  };
  const out = classifyPendingUserInputs({ pending: [single, multi, broken] });
  assert.deepEqual(out.mount.map((p) => p.userInputId), ['u-single', 'u-multi']);
  assert.deepEqual(out.cancel.map((p) => p.userInputId), ['u-broken']);
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
    questions: [{ id: 'a', question: 'A?', selection: { mode: 'fuzzy' }, options: [{ label: 'y' }] }],
  };
  const out = classifyPendingUserInputs({ pending: [dup, dup, { questions: [] }, null] });
  assert.deepEqual(out.cancel.map((p) => p.userInputId), ['u-dup']);
  assert.deepEqual(out.mount, []);
  assert.deepEqual(out.escalate, []);
});

const formQuestions = () => ([
  {
    id: 'a', header: 'Cache', question: 'Cache where?', mode: 'single',
    minSelections: 1, maxSelections: 1, freeText: false,
    options: [{ label: 'Redis', description: '' }, { label: 'SQLite', description: '' }],
  },
  {
    id: 'b', header: 'Flags', question: 'Which flags?', mode: 'multiple',
    minSelections: 1, maxSelections: 2, freeText: false,
    options: [{ label: 'x', description: '' }, { label: 'y', description: '' }, { label: 'z', description: '' }],
  },
  {
    id: 'c', header: 'Why', question: 'Why?', mode: 'single',
    minSelections: 1, maxSelections: 0, freeText: true, options: [],
  },
]);

test('validateUserInputAnswers accepts a complete mixed-shape set', () => {
  const v = validateUserInputAnswers(formQuestions(), [
    { questionId: 'a', selectedLabel: 'Redis' },
    { questionId: 'b', selectedLabels: ['x', 'z'] },
    { questionId: 'c', freeText: 'because', note: 'n' },
  ]);
  assert.equal(v.ok, true);
  assert.equal(v.answers.length, 3);
  assert.equal(v.answers[1].selectedLabels.join(','), 'x,z');
});

test('validateUserInputAnswers is atomic: one bad entry rejects all', () => {
  const qs = formQuestions();
  // Missing one question.
  let v = validateUserInputAnswers(qs, [
    { questionId: 'a', selectedLabel: 'Redis' },
    { questionId: 'b', selectedLabels: ['x'] },
  ]);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'ANSWER_INCOMPLETE');
  // Unknown label.
  v = validateUserInputAnswers(qs, [
    { questionId: 'a', selectedLabel: 'Memcached' },
    { questionId: 'b', selectedLabels: ['x'] },
    { questionId: 'c', freeText: 'because' },
  ]);
  assert.equal(v.code, 'UNKNOWN_LABEL');
  assert.equal(v.questionId, 'a');
  // Multi below min / above max.
  v = validateUserInputAnswers(qs, [
    { questionId: 'a', selectedLabel: 'Redis' },
    { questionId: 'b', selectedLabels: [] },
    { questionId: 'c', freeText: 'because' },
  ]);
  assert.equal(v.code, 'SELECTION_BOUNDS', 'empty multi array breaks the min bound');
  v = validateUserInputAnswers(qs, [
    { questionId: 'a', selectedLabel: 'Redis' },
    { questionId: 'b', selectedLabels: ['x', 'y', 'z'] },
    { questionId: 'c', freeText: 'because' },
  ]);
  assert.equal(v.code, 'SELECTION_BOUNDS');
  // Free text empty / too long.
  v = validateUserInputAnswers(qs, [
    { questionId: 'a', selectedLabel: 'Redis' },
    { questionId: 'b', selectedLabels: ['x'] },
    { questionId: 'c', freeText: '   ' },
  ]);
  assert.equal(v.code, 'ANSWER_SHAPE');
  v = validateUserInputAnswers(qs, [
    { questionId: 'a', selectedLabel: 'Redis' },
    { questionId: 'b', selectedLabels: ['x'] },
    { questionId: 'c', freeText: 't'.repeat(USER_INPUT_TEXT_MAX + 1) },
  ]);
  assert.equal(v.code, 'TEXT_TOO_LONG');
  // Note too long.
  v = validateUserInputAnswers(qs, [
    { questionId: 'a', selectedLabel: 'Redis', note: 'n'.repeat(USER_INPUT_TEXT_MAX + 1) },
    { questionId: 'b', selectedLabels: ['x'] },
    { questionId: 'c', freeText: 'because' },
  ]);
  assert.equal(v.code, 'NOTE_TOO_LONG');
  // Two shapes at once.
  v = validateUserInputAnswers(qs, [
    { questionId: 'a', selectedLabel: 'Redis', freeText: 'x' },
    { questionId: 'b', selectedLabels: ['x'] },
    { questionId: 'c', freeText: 'because' },
  ]);
  assert.equal(v.code, 'ANSWER_SHAPE');
  // Duplicate + unknown question.
  v = validateUserInputAnswers(qs, [
    { questionId: 'a', selectedLabel: 'Redis' },
    { questionId: 'a', selectedLabel: 'SQLite' },
    { questionId: 'c', freeText: 'because' },
  ]);
  assert.equal(v.code, 'ANSWER_DUPLICATE');
  v = validateUserInputAnswers(qs, [
    { questionId: 'zzz', selectedLabel: 'Redis' },
    { questionId: 'b', selectedLabels: ['x'] },
    { questionId: 'c', freeText: 'because' },
  ]);
  assert.equal(v.code, 'UNKNOWN_QUESTION');
});

test('ids and labels survive exactly (spaced labels are distinct picks)', () => {
  const card = mspUserInputCard({
    userInputId: 'q-sp',
    questions: [{
      id: ' a ',
      header: ' H ',
      question: ' Q? ',
      selection: { mode: 'single' },
      options: [{ label: ' SQLite ' }, { label: 'Redis' }],
    }],
  });
  assert.ok(card);
  assert.equal(card.questions[0].id, ' a ');
  assert.equal(card.questions[0].options[0].label, ' SQLite ');
  const v = validateUserInputAnswers(card.questions, [
    { questionId: ' a ', selectedLabel: ' SQLite ' },
  ]);
  assert.equal(v.ok, true);
  assert.equal(v.answers[0].selectedLabel, ' SQLite ', 'the RPC must carry the exact wire label');
  const trimmed = validateUserInputAnswers(card.questions, [
    { questionId: 'a', selectedLabel: 'SQLite' },
  ]);
  assert.equal(trimmed.ok, false, 'trimmed twins must not match exact ids/labels');
});

test('min:0 allows an empty multi-pick; bad bounds fail the frame', () => {
  const card = mspUserInputCard({
    userInputId: 'q-min0',
    questions: [{
      id: 'm', question: 'Flags?', selection: { mode: 'multiple', minSelections: 0, maxSelections: 2 },
      options: [{ label: 'x' }, { label: 'y' }],
    }],
  });
  assert.ok(card);
  const v = validateUserInputAnswers(card.questions, [{ questionId: 'm', selectedLabels: [] }]);
  assert.equal(v.ok, true);
  assert.deepEqual(v.answers[0].selectedLabels, []);
  // Invalid bounds make the frame malformed (auto-cancel with a trace).
  for (const selection of [
    { mode: 'multiple', minSelections: -1 },
    { mode: 'multiple', maxSelections: 1.5 },
    { mode: 'multiple', minSelections: 2, maxSelections: 1 },
  ]) {
    assert.equal(
      mspUserInputCard({ userInputId: 'q-bad', questions: [{ id: 'm', selection, options: [{ label: 'x' }] }] }),
      null,
      `bounds ${JSON.stringify(selection)} must fail normalize`,
    );
  }
});

test('freeText answers choice questions too (schema: independent alternative)', () => {
  const qs = formQuestions();
  const v = validateUserInputAnswers(qs, [
    { questionId: 'a', freeText: 'something else entirely' },
    { questionId: 'b', selectedLabels: ['x'] },
    { questionId: 'c', freeText: 'because' },
  ]);
  assert.equal(v.ok, true);
  assert.equal(v.answers[0].freeText, 'something else entirely');
  const both = validateUserInputAnswers(qs, [
    { questionId: 'a', selectedLabel: 'Redis', freeText: 'x' },
    { questionId: 'b', selectedLabels: ['x'] },
    { questionId: 'c', freeText: 'because' },
  ]);
  assert.equal(both.code, 'ANSWER_SHAPE', 'pick + text together is still two shapes');
});

test('validateApprovalDecision only passes current choices (policy gate)', () => {
  const choices = [
    { choiceId: 'approve_once', decision: 'approved', scope: 'once' },
    { choiceId: 'reject', decision: 'denied', scope: 'once' },
  ];
  assert.equal(validateApprovalDecision(choices, 'approve_once').ok, true);
  assert.equal(validateApprovalDecision(choices, 'reject').ok, true);
  const bad = validateApprovalDecision(choices, 'approve_always');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'UNKNOWN_CHOICE');
  assert.equal(validateApprovalDecision(choices, '').ok, false);
  assert.equal(validateApprovalDecision([], 'approve_once').ok, false);
});

test('summarizeUserInputAnswers renders one display row per answer', () => {
  const rows = summarizeUserInputAnswers(formQuestions(), [
    { questionId: 'a', selectedLabel: 'Redis' },
    { questionId: 'b', selectedLabels: ['x', 'z'] },
    { questionId: 'c', freeText: 'because reasons' },
  ]);
  assert.deepEqual(rows.map((r) => r.display), ['Redis', 'x, z', 'because reasons']);
  assert.deepEqual(rows.map((r) => r.header), ['Cache', 'Flags', 'Why']);
});

test('submissionKey is stable under key order', () => {
  const a = submissionKey({ kind: 'answer', answers: [{ questionId: 'a', selectedLabel: 'x' }] });
  const b = submissionKey({ answers: [{ selectedLabel: 'x', questionId: 'a' }], kind: 'answer' });
  assert.equal(a, b);
  assert.notEqual(a, submissionKey({ kind: 'answer', answers: [{ questionId: 'a', selectedLabel: 'y' }] }));
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
