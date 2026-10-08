#!/usr/bin/env node
// Renderer turn-view invariants (src/renderer/turn-view.js — pure, no DOM).
//
// The rule these tests protect: a window that missed `turn_started` must open
// the turn from the first scoped SSE event it sees, and a late frame from a
// superseded turn must never touch the view that replaced it.

import assert from 'node:assert/strict';

import { createTurnView, bindTurnId, interruptedMarkerText, liveChildOrder, createLivePaintScheduler, seedTurnView, resolveStatusVerb, ixSubmitTransition, IX_SUBMIT_ERROR_TEXT, toolStatusLabel, ixPrimaryOptionId, ixAnchorKey, ixKeyToOptionId, escStopAction, confirmedStopProceeds, outcomeLabel, applyIxSnapshot, messageChildOrder, shouldAutoExpandTool, toggleProgressOpen, progressSummary, progressTopic, toolTopic, inProgressPlanStep, configSelectsFromOptions, modelShortName, configMenuItems, isAgentTool, agentToolMeta, agentSubtitle, toolDisplayState, agentCounts, agentToolRows, formatElapsed, turnHeaderLabel } from '../src/renderer/turn-view.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('createTurnView starts empty and unbound', () => {
  const tv = createTurnView();
  assert.equal(tv.turnId, null);
  assert.equal(tv.text, '');
  assert.equal(tv.tools.size, 0);
  assert.equal(tv.plan, null);
  assert.equal(tv.interactions.size, 0);
  assert.equal(tv.cancelling, false);
});

test('fresh views start at structural rev 0', () => {
  assert.equal(createTurnView().rev, 0);
});

test('seedTurnView bumps the structural rev on merge', () => {
  const tv = createTurnView();
  tv.turnId = 't1';
  seedTurnView(tv, { turnId: 't1', partial: 'hi', tools: [], plan: null, pendingInteractions: [] });
  assert.equal(tv.rev, 1);
  seedTurnView(tv, { turnId: 't1', partial: 'hi!', tools: [], plan: null, pendingInteractions: [] });
  assert.equal(tv.rev, 2);
});

test('first scoped event binds the turnId and reports open', () => {
  const tv = createTurnView();
  const bind = bindTurnId(tv, { turnId: 't1' });
  assert.equal(bind, 'open');
  assert.equal(tv.turnId, 't1');
  assert.ok(tv.startedAt > 0, 'startedAt must be set on bind');
});

test('an unscoped event (no turnId) is accepted without binding', () => {
  const tv = createTurnView();
  assert.equal(bindTurnId(tv, {}), 'ok');
  assert.equal(tv.turnId, null);
});

test('the pending placeholder upgrades to the real turnId', () => {
  const tv = createTurnView();
  tv.turnId = 'pending'; // set by permission-card rehydrate after a reload
  const bind = bindTurnId(tv, { turnId: 't9' });
  assert.equal(bind, 'open');
  assert.equal(tv.turnId, 't9');
});

test('events for the bound turn are accepted; a superseded turn is dropped', () => {
  const tv = createTurnView();
  bindTurnId(tv, { turnId: 't1' });
  assert.equal(bindTurnId(tv, { turnId: 't1' }), 'ok');
  assert.equal(bindTurnId(tv, { turnId: 't2-late' }), 'drop');
  assert.equal(tv.turnId, 't1', 'a drop must not rebind');
});

test('bind keeps the original startedAt (elapsed time stays truthful)', () => {
  const tv = createTurnView();
  tv.startedAt = 1234; // e.g. seeded from the server's turn snapshot
  bindTurnId(tv, { turnId: 't1' });
  assert.equal(tv.startedAt, 1234);
});

test('interruptedMarkerText labels a user stop and a watchdog stop differently', () => {
  assert.equal(interruptedMarkerText('cancelled'), '⏹ หยุดโดยผู้ใช้');
  assert.equal(interruptedMarkerText('watchdog'), '⚠︎ ระบบหยุดให้ (เงียบเกินเพดาน watchdog)');
  assert.equal(interruptedMarkerText('interrupted'), '⏹ host หยุดระหว่างเทิร์น — prompt ใหม่เพื่อทำต่อ');
  // Anything else that reads as a manual interruption gets the user label.
  assert.equal(interruptedMarkerText(undefined), '⏹ หยุดโดยผู้ใช้');
});

test('liveChildOrder pins the answer below tools/plan and above permission cards', () => {
  const tv = createTurnView();
  // A tool call that starts AFTER some answer text must still sort above it.
  tv.text = 'partial answer';
  tv.tools.set('tc-1', { id: 'tc-1' });
  tv.plan = [{ content: 'step', status: 'in_progress' }];
  tv.interactions.set('ix-1', { id: 'ix-1' });
  assert.deepEqual(liveChildOrder(tv), ['tool:tc-1', 'plan', 'text', 'ix:ix-1']);
});

test('liveChildOrder omits absent content and keeps tool arrival order', () => {
  const tv = createTurnView();
  assert.deepEqual(liveChildOrder(tv), []);
  tv.tools.set('b', { id: 'b' });
  tv.tools.set('a', { id: 'a' });
  tv.text = 'x';
  assert.deepEqual(liveChildOrder(tv), ['tool:b', 'tool:a', 'text']);
});

test('live paint scheduler coalesces a burst of schedules into one paint', async () => {
  let painted = 0;
  const sched = createLivePaintScheduler(() => painted++, { minMs: 25 });
  for (let i = 0; i < 20; i++) sched.schedule();
  await sleep(80);
  assert.equal(painted, 1, `burst painted ${painted} times, want 1`);
  assert.equal(sched.paints, 1);
});

test('live paint scheduler flush paints synchronously and cancels the pending timer', async () => {
  let painted = 0;
  const sched = createLivePaintScheduler(() => painted++, { minMs: 25 });
  sched.schedule();
  sched.flush();
  assert.equal(painted, 1, 'flush must paint immediately');
  await sleep(60);
  assert.equal(painted, 1, 'the cancelled timer must not paint again');
  sched.schedule();
  await sleep(60);
  assert.equal(painted, 2, 'a later schedule still paints normally');
});

test('seedTurnView fills an empty view from the server snapshot', () => {
  const tv = createTurnView();
  seedTurnView(tv, {
    turnId: 't1',
    startedAt: 555,
    partial: 'partial answer',
    tools: [{ id: 'tc-1', status: 'in_progress' }],
    plan: [{ content: 'step', status: 'pending' }],
    pendingInteractions: [{ id: 'ix-1' }],
  });
  assert.equal(tv.turnId, 't1');
  assert.equal(tv.startedAt, 555);
  assert.equal(tv.text, 'partial answer');
  assert.ok(tv.tools.has('tc-1'));
  assert.equal(tv.plan.length, 1);
  assert.ok(tv.interactions.has('ix-1'));
});

test('seedTurnView never regresses newer local state for the same turn', () => {
  const tv = createTurnView();
  bindTurnId(tv, { turnId: 't1' });
  tv.text = 'locally streamed further';
  tv.tools.set('tc-2', { id: 'tc-2', status: 'completed' });
  const startedAt = tv.startedAt;
  // The snapshot was taken before the latest SSE deltas landed.
  seedTurnView(tv, {
    turnId: 't1',
    startedAt: 111,
    partial: 'shorter',
    tools: [{ id: 'tc-1', status: 'in_progress' }, { id: 'tc-2', status: 'in_progress' }],
  });
  assert.equal(tv.text, 'locally streamed further', 'older partial must not clobber SSE text');
  assert.equal(tv.startedAt, startedAt);
  assert.equal(tv.tools.get('tc-2').status, 'completed', 'fresher tool record must win');
  assert.ok(tv.tools.has('tc-1'), 'missing tool filled from snapshot');
});

test('seedTurnView upgrades the pending placeholder and adopts a new turn wholesale', () => {
  const tv = createTurnView();
  tv.turnId = 'pending';
  seedTurnView(tv, { turnId: 't1', partial: 'x' });
  assert.equal(tv.turnId, 't1');

  // A different live turnId: the local view was stale — the server wins.
  tv.text = 'old turn text that never settled locally';
  seedTurnView(tv, { turnId: 't2', partial: 'fresh', startedAt: 42 });
  assert.equal(tv.turnId, 't2');
  assert.equal(tv.text, 'fresh');
  assert.equal(tv.startedAt, 42);
});

test('seedTurnView ignores empty snapshots', () => {
  const tv = createTurnView();
  seedTurnView(tv, null);
  seedTurnView(tv, {});
  assert.equal(tv.turnId, null);
  assert.equal(tv.text, '');
});

test('ixSubmitTransition: fail hands the card back with an error line (BUG-025)', () => {
  let s = { submitting: false, error: null };
  s = ixSubmitTransition(s, 'start');
  assert.deepEqual(s, { submitting: true, error: null }, 'submit disables the buttons');
  // The whole point of the fix: a failed resolve must not stay submitting —
  // the buttons come back and the error line goes up.
  s = ixSubmitTransition(s, 'fail');
  assert.deepEqual(s, { submitting: false, error: IX_SUBMIT_ERROR_TEXT });
  s = ixSubmitTransition(s, 'start');
  assert.equal(s.error, null, 'a retry clears the error line');
  s = ixSubmitTransition(s, 'ok');
  assert.deepEqual(s, { submitting: false, error: null });
});

test('ixSubmitTransition passes unknown phases through untouched', () => {
  const s = { submitting: true, error: null };
  assert.equal(ixSubmitTransition(s, 'bogus'), s);
});

test('toolStatusLabel maps wire statuses to Thai, unknown passes through (BUG-027)', () => {
  assert.equal(toolStatusLabel('pending'), 'รอดำเนินการ');
  assert.equal(toolStatusLabel('in_progress'), 'กำลังทำงาน');
  assert.equal(toolStatusLabel('running'), 'กำลังทำงาน');
  assert.equal(toolStatusLabel('completed'), 'เสร็จแล้ว');
  assert.equal(toolStatusLabel('failed'), 'ล้มเหลว');
  assert.equal(toolStatusLabel('cancelled'), 'ถูกยกเลิก');
  // Case-insensitive like the status flips in settleTurn (BUG-004).
  assert.equal(toolStatusLabel('IN_PROGRESS'), 'กำลังทำงาน');
  // A status the mapping does not know must surface, never render blank.
  assert.equal(toolStatusLabel('waiting_for_input'), 'waiting_for_input');
  assert.equal(toolStatusLabel(undefined), '');
});

test('ixPrimaryOptionId: exactly one primary per card, allow_always preferred (BUG-028)', () => {
  // Canonical permission options: the session-approve wins over one-shot.
  assert.equal(
    ixPrimaryOptionId([
      { optionId: 'approve_once', kind: 'allow_once' },
      { optionId: 'approve_always', kind: 'allow_always' },
      { optionId: 'reject', kind: 'reject_once' },
    ]),
    'approve_always',
  );
  // AskUserQuestion: every answer is allow_once — only the first is primary,
  // and the Skip (reject_once) never is.
  assert.equal(
    ixPrimaryOptionId([
      { optionId: 'q0_opt_0', kind: 'allow_once' },
      { optionId: 'q0_opt_1', kind: 'allow_once' },
      { optionId: 'q0_skip', kind: 'reject_once' },
    ]),
    'q0_opt_0',
  );
  // ExitPlanMode fallback set.
  assert.equal(
    ixPrimaryOptionId([
      { optionId: 'plan_approve', kind: 'allow_once' },
      { optionId: 'plan_revise', kind: 'reject_once' },
      { optionId: 'plan_reject_and_exit', kind: 'reject_once' },
    ]),
    'plan_approve',
  );
  // No kind fields (the renderer's built-in fallback list): ids still work.
  assert.equal(
    ixPrimaryOptionId([
      { optionId: 'allow-once' },
      { optionId: 'allow-always' },
      { optionId: 'reject-once' },
    ]),
    'allow-always',
  );
  // All-reject or empty: nothing is primary.
  assert.equal(ixPrimaryOptionId([{ optionId: 'reject', kind: 'reject_once' }]), null);
  assert.equal(ixPrimaryOptionId([]), null);
  assert.equal(ixPrimaryOptionId(undefined), null);
});

test('ixAnchorKey points at the tool row that asked, else null (BUG-029)', () => {
  const tv = createTurnView();
  tv.tools.set('tc-1', { id: 'tc-1' });
  assert.equal(ixAnchorKey(tv, { id: 'ix-1', toolCallId: 'tc-1' }), 'tool:tc-1');
  // The row is not in this turn's view (rehydrated card, or the tool only
  // exists in the settled transcript) — the caller keeps the end position.
  assert.equal(ixAnchorKey(tv, { id: 'ix-2', toolCallId: 'tc-unknown' }), null);
  assert.equal(ixAnchorKey(tv, { id: 'ix-3' }), null);
  assert.equal(ixAnchorKey(tv, { id: 'ix-4', toolCallId: '' }), null);
  assert.equal(ixAnchorKey(createTurnView(), { toolCallId: 'tc-1' }), null);
});

test('ixKeyToOptionId: digits pick by position, Esc picks the reject-kind option (BUG-030)', () => {
  const canonical = [
    { optionId: 'approve_once', kind: 'allow_once' },
    { optionId: 'approve_always', kind: 'allow_always' },
    { optionId: 'reject', kind: 'reject_once' },
  ];
  assert.equal(ixKeyToOptionId(canonical, '1'), 'approve_once');
  assert.equal(ixKeyToOptionId(canonical, '3'), 'reject');
  assert.equal(ixKeyToOptionId(canonical, 'Escape'), 'reject');
  // AskUserQuestion: Esc lands on Skip (reject_once), digits on the answers.
  const ask = [
    { optionId: 'q0_opt_0', kind: 'allow_once' },
    { optionId: 'q0_opt_1', kind: 'allow_once' },
    { optionId: 'q0_skip', kind: 'reject_once' },
  ];
  assert.equal(ixKeyToOptionId(ask, '2'), 'q0_opt_1');
  assert.equal(ixKeyToOptionId(ask, 'Escape'), 'q0_skip');
  // Id-spelling fallback for kind-less option lists.
  assert.equal(
    ixKeyToOptionId([{ optionId: 'allow-once' }, { optionId: 'reject-once' }], 'Escape'),
    'reject-once',
  );
  // Unmapped keys and out-of-range digits are not swallowed.
  assert.equal(ixKeyToOptionId(canonical, '9'), null);
  assert.equal(ixKeyToOptionId(canonical, '0'), null);
  assert.equal(ixKeyToOptionId(canonical, 'a'), null);
  // A card with no reject option must not swallow Esc (the global stop
  // binding still applies).
  assert.equal(ixKeyToOptionId([{ optionId: 'q0_opt_0', kind: 'allow_once' }], 'Escape'), null);
  assert.equal(ixKeyToOptionId([], 'Escape'), null);
  assert.equal(ixKeyToOptionId(undefined, '1'), null);
});

test('escStopAction: ESC asks before stopping, and only while a turn runs', () => {
  assert.equal(escStopAction({ key: 'Escape', running: true }), 'confirm');
  assert.equal(escStopAction({ key: 'Escape', running: false }), 'none');
  assert.equal(escStopAction({ key: 'Escape', running: undefined }), 'none');
  assert.equal(escStopAction({ key: 'Enter', running: true }), 'none');
  assert.equal(escStopAction({ key: 'a', running: true }), 'none');
});

test('confirmedStopProceeds: a stale yes stops nothing', () => {
  assert.equal(confirmedStopProceeds({ escChatId: 'c1', activeChatId: 'c1', running: true }), true);
  // The turn settled behind the open popover.
  assert.equal(confirmedStopProceeds({ escChatId: 'c1', activeChatId: 'c1', running: false }), false);
  // The user switched chats behind the open popover.
  assert.equal(confirmedStopProceeds({ escChatId: 'c1', activeChatId: 'c2', running: true }), false);
  assert.equal(confirmedStopProceeds({ escChatId: 'c1', activeChatId: null, running: true }), false);
  assert.equal(confirmedStopProceeds({ escChatId: null, activeChatId: 'c1', running: true }), false);
});

test('outcomeLabel maps every settlement to Thai, unknowns pass through', () => {
  assert.equal(outcomeLabel('answered'), 'ตอบแล้ว');
  assert.equal(outcomeLabel('decided'), 'ตัดสินใจแล้ว');
  assert.equal(outcomeLabel('cancelled'), 'ยกเลิกแล้ว');
  assert.equal(outcomeLabel('timedOut'), 'หมดเวลา');
  assert.equal(outcomeLabel('settled-remote'), 'agent ดำเนินการเองแล้ว');
  assert.equal(outcomeLabel('settled'), 'จบพร้อมเทิร์น');
  assert.equal(outcomeLabel('weird-future'), 'weird-future');
  assert.equal(outcomeLabel(null), '');
});

test('applyIxSnapshot authoritative: add, refresh unresolved, remove absent', () => {
  const current = new Map([
    ['keep', { id: 'keep', turnId: 't1' }],
    ['gone', { id: 'gone', turnId: 't1' }],
    ['done', { id: 'done', turnId: 't1', resolved: true, optionId: 'x' }],
  ]);
  const out = applyIxSnapshot(current, [
    { id: 'keep', turnId: 't1', summary: 'fresh' },
    { id: 'new', turnId: 't1' },
  ], { authoritative: true });
  assert.deepEqual(out.added, ['new']);
  assert.deepEqual(out.updated, ['keep']);
  assert.deepEqual(out.removed, ['gone']);
  assert.equal(current.get('keep').summary, 'fresh', 'unresolved locals refresh from server truth');
  assert.equal(current.get('done').optionId, 'x', 'resolved locals are never touched');
  assert.equal(current.has('gone'), false);
});

test('applyIxSnapshot stale: backfill unknown ids only, never overwrite/remove', () => {
  const local = { id: 'k', turnId: 't1', resolved: true, optionId: 'picked' };
  const current = new Map([
    ['k', local],
    ['stale-pending', { id: 'stale-pending', turnId: 't1' }],
  ]);
  const out = applyIxSnapshot(current, [
    { id: 'k', turnId: 't1', summary: 'older snapshot' },
    { id: 'fresh', turnId: 't1' },
  ], { authoritative: false });
  assert.deepEqual(out.added, ['fresh']);
  assert.deepEqual(out.updated, []);
  assert.deepEqual(out.removed, []);
  assert.equal(current.get('k'), local, 'a resolve that raced the GET must not resurrect');
  assert.equal(current.has('stale-pending'), true, 'no removal without authority');
});

test('applyIxSnapshot replaces a resolved fossil from an older turn', () => {
  const current = new Map([['q', { id: 'q', turnId: 't0', resolved: true }]]);
  const out = applyIxSnapshot(current, [{ id: 'q', turnId: 't1' }], { authoritative: true });
  assert.deepEqual(out.updated, ['q']);
  assert.equal(current.get('q').turnId, 't1');
  assert.equal(current.get('q').resolved, undefined);
});

test('applyIxSnapshot drops tombstoned same-turn ids (late-GET resurrection)', () => {
  // GET captured pending → resolved SSE (unseen id: model already gone) →
  // late GET: the snapshot row is older wire and must not come back.
  for (const authoritative of [true, false]) {
    const current = new Map();
    const tombs = new Map([['q', 't1']]);
    const out = applyIxSnapshot(current, [{ id: 'q', turnId: 't1' }], { authoritative, tombstones: tombs });
    assert.deepEqual(out.added, [], `authoritative=${authoritative}: tombstoned id is dropped`);
    assert.equal(current.has('q'), false);
    assert.equal(tombs.has('q'), true, 'the tombstone itself survives a stale row');
  }
});

test('applyIxSnapshot accepts a tombstoned id re-asked under a new turn', () => {
  const current = new Map();
  const tombs = new Map([['q', 't1']]);
  const out = applyIxSnapshot(current, [{ id: 'q', turnId: 't2' }], { authoritative: true, tombstones: tombs });
  assert.deepEqual(out.added, ['q']);
  assert.equal(tombs.has('q'), false, 'a new turn lifts the old tomb');
});

test('messageChildOrder mirrors liveChildOrder for the settled transcript (BUG-031)', () => {
  const msg = {
    role: 'assistant',
    text: 'คำตอบ',
    meta: {
      plan: [{ content: 'step', status: 'completed' }],
      toolCalls: [{ id: 'tc-1' }],
      reason: 'cancelled',
    },
  };
  // tools → plan → text → marker: the live paint's tools → plan → answer.
  assert.deepEqual(messageChildOrder(msg), ['tools', 'plan', 'text', 'marker']);
  const tv = createTurnView();
  tv.tools.set('tc-1', { id: 'tc-1' });
  tv.plan = msg.meta.plan;
  tv.text = msg.text;
  // Same relative order in both paths: tools before plan before answer.
  const live = liveChildOrder(tv);
  const rank = (k) => (k.startsWith('tool:') ? 'tools' : k);
  assert.deepEqual(live.map(rank), ['tools', 'plan', 'text']);
  // Absent content drops out; user/notice are single-node messages.
  assert.deepEqual(messageChildOrder({ role: 'assistant', text: 'x' }), ['text']);
  assert.deepEqual(messageChildOrder({ role: 'user', text: 'x' }), ['user']);
  assert.deepEqual(messageChildOrder({ role: 'notice', text: 'x' }), ['notice']);
});

test('shouldAutoExpandTool hides by default — only an explicit open expands (hide-defaults)', () => {
  const tv = createTurnView();
  // Streaming never pops rows open — not even running bash rows (the old
  // grok behaviour this replaced).
  assert.equal(shouldAutoExpandTool(tv, { id: 't1', status: 'in_progress' }), false);
  assert.equal(shouldAutoExpandTool(tv, { id: 't2', status: 'running' }), false);
  assert.equal(shouldAutoExpandTool(tv, { id: 't3', status: 'pending', kind: 'execute' }), false);
  assert.equal(shouldAutoExpandTool(tv, { id: 't4', status: 'pending', kind: 'bash' }), false);
  assert.equal(shouldAutoExpandTool(tv, { id: 't5', status: 'pending', kind: 'read' }), false);
  assert.equal(shouldAutoExpandTool(tv, { id: 't6', status: 'completed', kind: 'read' }), false);
  // A head click / "explain" records the row — repaints keep it open.
  tv.userToggledTools.add('t1');
  tv.userExpandedTools.add('t1');
  assert.equal(shouldAutoExpandTool(tv, { id: 't1', status: 'in_progress' }), true);
  // …but never leaks to other rows or next turn's fresh view.
  assert.equal(shouldAutoExpandTool(tv, { id: 't2', status: 'running' }), false);
  assert.equal(shouldAutoExpandTool(createTurnView(), { id: 't1', status: 'in_progress' }), false);
  // A manual collapse removes the row from the expanded set — the BUG-033
  // guard (toggled but not expanded) keeps it shut.
  tv.userExpandedTools.delete('t1');
  assert.equal(shouldAutoExpandTool(tv, { id: 't1', status: 'in_progress' }), false);
  assert.equal(shouldAutoExpandTool(tv, null), false);
});

test('toggleProgressOpen flips the group and bumps the structural rev', () => {
  const tv = createTurnView();
  assert.equal(tv.progressOpen, false);
  assert.equal(toggleProgressOpen(tv), true);
  assert.equal(tv.progressOpen, true);
  assert.equal(tv.rev, 1);
  assert.equal(toggleProgressOpen(tv), false);
  assert.equal(toggleProgressOpen(null), false);
});

test('progressSummary counts tools, running rows and plan steps', () => {
  const tv = createTurnView();
  tv.tools.set('a', { id: 'a', status: 'in_progress' });
  tv.tools.set('b', { id: 'b', status: 'completed' });
  tv.plan = [{ status: 'completed' }, { status: 'in_progress' }, { status: 'pending' }];
  assert.deepEqual(progressSummary(tv), { tools: 2, running: 1, planSteps: 3, planDone: 1 });
  assert.deepEqual(progressSummary(null), { tools: 0, running: 0, planSteps: 0, planDone: 0 });
});

test('seedTurnView resets progress-open state when the turn is replaced', () => {
  const tv = createTurnView();
  tv.turnId = 'old';
  tv.userExpandedTools.add('t1');
  tv.progressOpen = true;
  seedTurnView(tv, { turnId: 'new', partial: 'x' });
  assert.equal(tv.progressOpen, false);
  assert.equal(tv.userExpandedTools.size, 0);
});

test('resolveStatusVerb says preparing-tools while a fresh agent is silent', () => {
  const tv = createTurnView();
  tv.warming = true;
  assert.equal(resolveStatusVerb(tv), 'กำลังเตรียมเครื่องมือ…');
  tv.thoughtSeen = true;
  assert.equal(resolveStatusVerb(tv), 'กำลังคิด…');
  tv.thoughtSeen = false;
  tv.text = 'hi';
  assert.equal(resolveStatusVerb(tv), 'กำลังทำงาน…');
});

test('resolveStatusVerb falls back to working for an empty view', () => {
  assert.equal(resolveStatusVerb(null), '');
  assert.equal(resolveStatusVerb(createTurnView()), 'กำลังทำงาน…');
});

test('resolveStatusVerb picks the interaction verb by subtype', () => {
  const tv = createTurnView();
  tv.tools.set('tc-1', { id: 'tc-1', title: 'npm test', kind: 'execute', status: 'in_progress' });
  tv.plan = [{ content: 'ลงมือทำ', status: 'in_progress' }];
  tv.interactions.set('ix-1', { id: 'ix-1' });
  assert.equal(resolveStatusVerb(tv), 'รอการอนุญาต…', 'plain approval card');
  tv.interactions.get('ix-1').subtype = 'ask';
  assert.equal(resolveStatusVerb(tv), 'รอคำตอบจากคุณ…', 'AskUserQuestion card');
  tv.interactions.get('ix-1').subtype = 'plan';
  assert.equal(resolveStatusVerb(tv), 'แผนพร้อมแล้ว — รอตรวจสอบ…', 'ExitPlanMode card');
  tv.interactions.get('ix-1').resolved = true;
  assert.equal(resolveStatusVerb(tv), 'ลงมือทำ…', 'a resolved card stops blocking the verb');
});

test('resolveStatusVerb prefers the in-progress plan step over tools', () => {
  const tv = createTurnView();
  tv.tools.set('tc-1', { id: 'tc-1', title: 'npm test', kind: 'execute', status: 'in_progress' });
  tv.plan = [
    { content: 'อ่านโจทย์', status: 'completed' },
    { content: 'ลงมือทำ', status: 'in_progress' },
    { content: 'ตรวจงาน', status: 'pending' },
  ];
  assert.equal(resolveStatusVerb(tv), 'ลงมือทำ…');
});

test('resolveStatusVerb truncates a long plan step to 56 chars + ellipsis', () => {
  const tv = createTurnView();
  tv.plan = [{ content: 'x'.repeat(80), status: 'in_progress' }];
  const verb = resolveStatusVerb(tv);
  assert.equal(verb.length, 57);
  assert.ok(verb.endsWith('…'));
});

test('resolveStatusVerb maps the running tool kind to a Thai verb', () => {
  const tv = createTurnView();
  tv.tools.set('tc-0', { id: 'tc-0', title: 'src/app.js', kind: 'read', status: 'completed' });
  assert.equal(resolveStatusVerb(tv), 'กำลังทำงาน…', 'completed tools are done — not news');
  const cases = [
    // [kind, title, expected with title, expected without title]
    ['read', 'src/app.js', 'กำลังอ่าน src/app.js…', 'กำลังอ่าน…'],
    ['edit', 'src/app.js', 'กำลังแก้ไข src/app.js…', 'กำลังแก้ไข…'],
    ['execute', 'npm test', 'กำลังรัน npm test…', 'กำลังรันคำสั่ง…'],
    ['fetch', 'muse docs', 'กำลังค้นหา muse docs…', 'กำลังค้นหา…'],
    ['think', 'step by step', 'กำลังคิด…', 'กำลังคิด…'],
    ['other', 'WebFetch', 'กำลังใช้ WebFetch…', 'กำลังใช้เครื่องมือ…'],
  ];
  for (const [kind, title, withTitle, withoutTitle] of cases) {
    const a = createTurnView();
    a.tools.set('t', { id: 't', title, kind, status: 'in_progress' });
    assert.equal(resolveStatusVerb(a), withTitle, `kind ${kind} with title`);
    const b = createTurnView();
    b.tools.set('t', { id: 't', kind, status: 'in_progress' });
    assert.equal(resolveStatusVerb(b), withoutTitle, `kind ${kind} without title`);
  }
});

test('resolveStatusVerb keeps a verb-phrase title as-is', () => {
  const tv = createTurnView();
  tv.tools.set('t1', { id: 't1', title: 'กำลังวิเคราะห์โค้ด', kind: 'read', status: 'in_progress' });
  assert.equal(resolveStatusVerb(tv), 'กำลังวิเคราะห์โค้ด…', 'Thai verb phrase is not double-prefixed');
  const en = createTurnView();
  en.tools.set('t1', { id: 't1', title: 'Reading src/app.js', kind: 'read', status: 'in_progress' });
  assert.equal(resolveStatusVerb(en), 'Reading src/app.js…', 'English -ing phrase stays as-is');
});

test('resolveStatusVerb counts running subagent tools after plain tools', () => {
  const tv = createTurnView();
  tv.tools.set('a1', { id: 'a1', title: 'explore the repo', kind: 'other', status: 'in_progress', rawInput: { subagent_type: 'explore' } });
  assert.equal(resolveStatusVerb(tv), 'กำลังรัน 1 agent…');
  tv.tools.set('a2', { id: 'a2', title: 'swarm task', kind: 'other', status: 'pending', rawInput: { prompt_template: 'x' } });
  assert.equal(resolveStatusVerb(tv), 'กำลังรัน 2 agents…');
  tv.tools.get('a1').status = 'completed';
  assert.equal(resolveStatusVerb(tv), 'กำลังรัน 1 agent…', 'settled agents drop out of the count');
  // Agents outrank the thought stream…
  tv.thoughtSeen = true;
  assert.equal(resolveStatusVerb(tv), 'กำลังรัน 1 agent…');
  // …but a plain running tool wins slot 3 over any agent.
  tv.tools.set('t1', { id: 't1', title: 'npm test', kind: 'execute', status: 'in_progress' });
  assert.equal(resolveStatusVerb(tv), 'กำลังรัน npm test…');
});

test('resolveStatusVerb degrades gracefully when rawInput is null', () => {
  const tv = createTurnView();
  tv.tools.set('a1', { id: 'a1', title: 'lazy task', kind: 'other', status: 'in_progress', rawInput: null });
  assert.equal(resolveStatusVerb(tv), 'กำลังใช้ lazy task…', 'not identifiable as an agent → plain other-tool verb');
});

test('resolveStatusVerb shows thinking only after a thought chunk arrived', () => {
  const tv = createTurnView();
  assert.equal(resolveStatusVerb(tv), 'กำลังทำงาน…', 'no signal yet — the fallback stays honest');
  tv.thoughtSeen = true;
  assert.equal(resolveStatusVerb(tv), 'กำลังคิด…');
  // …but a running tool still outranks the thought stream.
  tv.tools.set('tc-1', { id: 'tc-1', title: 'npm test', kind: 'execute', status: 'in_progress' });
  assert.equal(resolveStatusVerb(tv), 'กำลังรัน npm test…');
});

test('toolTopic strips the old tool-name prefix, keeps bare topics', () => {
  assert.equal(toolTopic({ title: 'Bash ls /tmp/mock', kind: 'Bash' }), 'ls /tmp/mock');
  assert.equal(toolTopic({ title: 'bash ls /tmp/mock', kind: 'Bash' }), 'ls /tmp/mock', 'case-insensitive');
  assert.equal(toolTopic({ title: 'Read: src/app.js', kind: 'read' }), 'src/app.js');
  assert.equal(toolTopic({ title: 'ตรวจไฟล์ชั่วคราว', kind: 'Bash' }), 'ตรวจไฟล์ชั่วคราว', 'bare topic passes through');
  assert.equal(toolTopic({ title: 'Bash', kind: 'Bash' }), '', 'bare kind is not a topic');
  assert.equal(toolTopic({ title: '', kind: 'Bash' }), '');
  assert.equal(toolTopic({ kind: 'Bash' }), '');
  assert.equal(toolTopic(null), '');
});

test('resolveStatusVerb never repeats the tool name', () => {
  // Wire-true kinds are tool names (`Bash`), which take the default verb —
  // the point here is the stripped topic, not the kind mapping.
  const tv = createTurnView();
  tv.tools.set('t', { id: 't', title: 'Bash ls /tmp/mock', kind: 'Bash', status: 'in_progress' });
  assert.equal(resolveStatusVerb(tv), 'กำลังใช้ ls /tmp/mock…');
  const bare = createTurnView();
  bare.tools.set('t', { id: 't', title: 'Bash', kind: 'Bash', status: 'in_progress' });
  assert.equal(resolveStatusVerb(bare), 'กำลังใช้เครื่องมือ…', 'nothing left after the strip → kind fallback');
  const topic = createTurnView();
  topic.tools.set('t', { id: 't', title: 'ตรวจไฟล์ชั่วคราว', kind: 'Bash', status: 'in_progress' });
  assert.equal(resolveStatusVerb(topic), 'กำลังใช้ ตรวจไฟล์ชั่วคราว…');
});

test('inProgressPlanStep normalizes the running step once for both callers', () => {
  const tv = createTurnView();
  assert.equal(inProgressPlanStep(tv), '');
  assert.equal(inProgressPlanStep(null), '');
  tv.plan = [
    { content: 'อ่านโจทย์', status: 'completed' },
    { content: '  ลงมือ\nทำ  ', status: 'in_progress' },
  ];
  assert.equal(inProgressPlanStep(tv), 'ลงมือ ทำ');
});

test('progressTopic names the plan step, else the running tool, else agents', () => {
  assert.equal(progressTopic(null), '');
  assert.equal(progressTopic(createTurnView()), '', 'idle → caller falls back to Progress Bar');
  const tv = createTurnView();
  tv.tools.set('t', { id: 't', title: 'ตรวจไฟล์ชั่วคราว', kind: 'Bash', status: 'in_progress' });
  tv.tools.set('a', { id: 'a', title: 'explore', kind: 'other', status: 'in_progress', rawInput: { subagent_type: 'explore' } });
  assert.equal(progressTopic(tv), 'ตรวจไฟล์ชั่วคราว', 'plain tool beats agents');
  tv.plan = [{ content: 'ลงมือทำ', status: 'in_progress' }];
  assert.equal(progressTopic(tv), 'ลงมือทำ', 'plan step beats tools');
  tv.tools.get('t').status = 'completed';
  tv.plan = [{ content: 'done', status: 'completed' }];
  assert.equal(progressTopic(tv), '1 agent', 'only agents left → count');
  tv.tools.get('a').status = 'completed';
  assert.equal(progressTopic(tv), '', 'settled turn → no topic');
});

test('progressTopic strips old prefixes and caps at 48 chars', () => {
  const tv = createTurnView();
  tv.tools.set('t', { id: 't', title: 'Bash ls /tmp/mock', kind: 'Bash', status: 'in_progress' });
  assert.equal(progressTopic(tv), 'ls /tmp/mock');
  const long = createTurnView();
  long.plan = [{ content: 'x'.repeat(80), status: 'in_progress' }];
  assert.equal(progressTopic(long).length, 48);
});

test('configSelectsFromOptions normalizes the advertised selects (BUG-075)', () => {
  const selects = configSelectsFromOptions([
    { id: 'model', currentValue: 'muse-spark', options: [{ value: 'muse-spark' }, { value: 'muse-spark-fast' }] },
    { id: 'thinking', currentValue: 'max', options: [{ value: 'off' }, { value: 'low' }, { value: 'high' }, { value: 'max' }] },
    { id: 'mode', currentValue: 'code', options: [{ value: 'code' }] },
  ]);
  assert.equal(selects.model.id, 'model');
  assert.equal(selects.model.currentValue, 'muse-spark');
  assert.deepEqual(selects.model.values, ['muse-spark', 'muse-spark-fast']);
  assert.deepEqual(selects.thinking.values, ['off', 'low', 'high', 'max']);
  // A non-thinking model omits the select entirely (0.36.1).
  assert.equal(configSelectsFromOptions([{ id: 'model', options: [] }]).thinking, null);
  // String-shaped and `values`-shaped rows work too; garbage in → nulls out.
  assert.deepEqual(configSelectsFromOptions([{ id: 'thinking', values: ['low', 'high'] }]).thinking.values, ['low', 'high']);
  assert.deepEqual(configSelectsFromOptions(null), { model: null, thinking: null });
});

test('modelShortName takes the last alias segment (BUG-075)', () => {
  assert.equal(modelShortName('meta/muse-spark'), 'muse-spark');
  assert.equal(modelShortName('muse-spark-fast'), 'muse-spark-fast');
  assert.equal(modelShortName('plain-id'), 'plain-id');
  assert.equal(modelShortName(null), '—');
  assert.equal(modelShortName(''), '—');
});

test('configMenuItems flags the current value (BUG-075)', () => {
  const select = { id: 'thinking', currentValue: 'max', values: ['off', 'low', 'high', 'max'] };
  const items = configMenuItems(select, 'high');
  assert.deepEqual(items.map((i) => i.value), ['off', 'low', 'high', 'max']);
  assert.equal(items.find((i) => i.current)?.value, 'high', 'an explicit current wins');
  assert.equal(configMenuItems(select).find((i) => i.current)?.value, 'max', 'else the select currentValue');
  assert.deepEqual(configMenuItems(null), []);
});

test('agentToolMeta reads Agent and AgentSwarm rawInput shapes (BUG-076)', () => {
  assert.equal(agentToolMeta({ title: 'x', kind: 'other' }), null, 'plain tool');
  assert.equal(agentToolMeta({ rawInput: null }), null, 'lazy-created call without rawInput');
  assert.equal(agentToolMeta({ rawInput: { prompt: 'hi' } }), null, 'rawInput without agent keys');
  assert.deepEqual(
    agentToolMeta({ rawInput: { subagent_type: 'explore', prompt: 'p', run_in_background: true } }),
    { swarm: false, type: 'explore', count: 1, background: true },
  );
  assert.deepEqual(
    agentToolMeta({ rawInput: { prompt_template: 't', items: [1, 2, 3, 4, 5, 6, 7], resume_agent_ids: { a: 1, b: 2, c: 3, d: 4, e: 5 } } }),
    { swarm: true, type: 'swarm', count: 12, background: false },
    'swarm fan-out = fresh items + resumed agents',
  );
  assert.equal(agentToolMeta({ rawInput: { prompt_template: 't' } }).count, 0, 'no items known yet');
});

test('agentSubtitle names the type or the swarm fan-out (BUG-076)', () => {
  assert.equal(agentSubtitle({ rawInput: { subagent_type: 'coder' } }), 'coder');
  assert.equal(agentSubtitle({ rawInput: { prompt_template: 't', items: [1, 2, 3] } }), 'swarm · 3 ตัว');
  assert.equal(agentSubtitle({ rawInput: { prompt_template: 't' } }), 'swarm');
  assert.equal(agentSubtitle({ title: 'plain' }), '');
});

test('toolDisplayState: completed background agent reads background, not done (BUG-076)', () => {
  const bg = { status: 'completed', rawInput: { subagent_type: 'explore', run_in_background: true } };
  assert.equal(toolDisplayState(bg), 'background');
  assert.equal(toolDisplayState({ status: 'completed', rawInput: { subagent_type: 'explore' } }), 'done', 'foreground agent completes normally');
  assert.equal(toolDisplayState({ status: 'completed' }), 'done');
  assert.equal(toolDisplayState({ status: 'failed' }), 'failed');
  assert.equal(toolDisplayState({ status: 'cancelled' }), 'failed');
  assert.equal(toolDisplayState({ status: 'pending' }), 'pending');
  assert.equal(toolDisplayState({ status: 'in_progress' }), 'running');
  assert.equal(toolDisplayState({ status: 'running' }), 'running');
});

test('liveChildOrder pins agent rows above plain tools, arrival order within groups (BUG-076)', () => {
  const tv = createTurnView();
  tv.tools.set('t1', { id: 't1', title: 'npm test', kind: 'execute', status: 'in_progress' });
  tv.tools.set('a1', { id: 'a1', title: 'Launching explore agent: scan', kind: 'other', status: 'in_progress', rawInput: { subagent_type: 'explore' } });
  tv.tools.set('t2', { id: 't2', title: 'src/app.js', kind: 'read', status: 'completed' });
  tv.tools.set('a2', { id: 'a2', title: 'Launching agent swarm: batch', kind: 'other', status: 'in_progress', rawInput: { prompt_template: 't', items: [1] } });
  tv.plan = [{ content: 'step', status: 'in_progress' }];
  tv.text = 'answer';
  tv.interactions.set('ix-1', { id: 'ix-1' });
  assert.deepEqual(liveChildOrder(tv), ['tool:a1', 'tool:a2', 'tool:t1', 'tool:t2', 'plan', 'text', 'ix:ix-1']);
  // A plain-tools-only turn keeps pure arrival order (the pre-BUG-076 shape).
  const tv2 = createTurnView();
  tv2.tools.set('x', { id: 'x', title: 'a', status: 'completed' });
  tv2.tools.set('y', { id: 'y', title: 'b', status: 'in_progress' });
  assert.deepEqual(liveChildOrder(tv2), ['tool:x', 'tool:y']);
});

test('agentCounts: swarm is one row, background-done leaves the running count (BUG-077)', () => {
  const tv = createTurnView();
  assert.deepEqual(agentCounts(tv), { running: 0, total: 0 }, 'empty view');
  assert.deepEqual(agentCounts(null), { running: 0, total: 0 });
  tv.tools.set('t1', { id: 't1', title: 'npm test', kind: 'execute', status: 'in_progress' });
  assert.deepEqual(agentCounts(tv), { running: 0, total: 0 }, 'plain tools are not agents');
  tv.tools.set('a1', { id: 'a1', status: 'in_progress', rawInput: { subagent_type: 'explore' } });
  tv.tools.set('a2', { id: 'a2', status: 'pending', rawInput: { prompt_template: 't', items: [1, 2, 3, 4, 5] } });
  assert.deepEqual(agentCounts(tv), { running: 2, total: 2 }, 'a 5-item swarm still counts as one row');
  tv.tools.get('a1').status = 'completed';
  assert.deepEqual(agentCounts(tv), { running: 1, total: 2 }, 'settled agents stay in total only');
  tv.tools.get('a1').rawInput.run_in_background = true;
  assert.deepEqual(agentCounts(tv), { running: 1, total: 2 }, 'background-done is excluded from running');
  tv.tools.get('a2').status = 'failed';
  assert.deepEqual(agentCounts(tv), { running: 0, total: 2 }, 'failed agents are not running');
});

test('agentToolRows reads RAW tools: linked + unlinked agent rows survive (1.1.30)', () => {
  assert.deepEqual(agentToolRows(null), []);
  assert.deepEqual(agentToolRows(createTurnView()), []);
  const tv = createTurnView();
  tv.tools.set('t1', { id: 't1', title: 'npm test', kind: 'execute', status: 'in_progress' });
  tv.tools.set('a1', {
    id: 'a1', kind: 'subagent_spawn', status: 'in_progress',
    title: 'spawn alpha', agentLink: 'native:sub-a',
    rawInput: { subagent_type: 'explore' },
  });
  tv.tools.set('a2', {
    id: 'a2', status: 'completed', kind: 'Agent',
    title: 'model-side agent', agentLink: null,
    rawInput: { subagent_type: 'general', description: 'free agent' },
  });
  const rows = agentToolRows(tv);
  assert.equal(rows.length, 2, 'plain tools excluded, both agent rows kept');
  assert.equal(rows[0].id, 'a1');
  assert.equal(rows[0].agentLink, 'native:sub-a', 'durable link rides along for union dedupe');
  assert.ok(rows[0].title && rows[0].title.length > 0);
  assert.equal(rows[1].id, 'a2');
  assert.equal(rows[1].agentLink, null, 'unlinked rows list honestly undrillable');
  // The regression this pins: mapping `.tool` off raw values yields
  // undefined rows and the whole live side of the union disappears.
  assert.ok(rows.every((r) => r && typeof r === 'object'), 'no undefined rows');
  // Liveness is captured at extraction for the union count.
  assert.equal(rows[0].running, true, 'in-progress agent row counts running');
  assert.equal(rows[1].running, false, 'completed agent row counts idle');
});

test('formatElapsed: compact clock for turn headers (1.1.26)', () => {
  assert.equal(formatElapsed(0), '0s');
  assert.equal(formatElapsed(24_000), '24s');
  assert.equal(formatElapsed(59_999), '59s');
  assert.equal(formatElapsed(60_000), '1m');
  assert.equal(formatElapsed(349_000), '5m 49s');
  assert.equal(formatElapsed(3_600_000), '1h');
  assert.equal(formatElapsed(3_720_000), '1h 2m');
  assert.equal(formatElapsed(-5), '0s');
  assert.equal(formatElapsed(NaN), '0s');
});

test('turnHeaderLabel: live clock + counts like ChatGPT Desktop (1.1.26)', () => {
  assert.equal(
    turnHeaderLabel({ running: true, elapsedMs: 24_000 }),
    'กำลังทำ 24s',
    'empty live turn still shows the clock',
  );
  assert.equal(
    turnHeaderLabel({ running: true, elapsedMs: 65_000, topic: 'npm test', tools: 3, runningTools: 1, planSteps: 4, planDone: 2, agentsRunning: 1, agentsTotal: 2 }),
    'กำลังทำ 1m 5s · npm test · 3 tools · 1 กำลังรัน · plan 2/4 · agents 1/2',
  );
  assert.equal(
    turnHeaderLabel({ running: false, durationMs: 36_000, tools: 2 }),
    'ทำไป 36s · 2 tools',
    'settled turn shows the persisted clock',
  );
  assert.equal(
    turnHeaderLabel({ running: false, tools: 2, planSteps: 1, planDone: 1 }),
    '2 tools · plan 1/1',
    'old transcripts without duration fall back to counts',
  );
  assert.equal(turnHeaderLabel({}), 'เทิร์นนี้');
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
console.log(`turn-view: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
