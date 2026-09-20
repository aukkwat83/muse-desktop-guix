#!/usr/bin/env node
// Mode model: the ask → plan → yolo cycle and its MSP mapping.

import assert from 'node:assert/strict';
import {
  SESSION_MODE_CYCLE,
  mspApprovalModeToSessionMode,
  cycleSessionMode,
  normalizeSessionMode,
  sessionModeAlwaysApprove,
  sessionModeLabel,
  sessionModeNeedsProcessRestart,
  sessionModePill,
  sessionModeToMspApprovalMode,
} from '../src/server/session-mode.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('normalize accepts the vocabulary users and agents actually type', () => {
  assert.equal(normalizeSessionMode('PLAN'), 'plan');
  assert.equal(normalizeSessionMode('planning'), 'plan');
  assert.equal(normalizeSessionMode('bypassPermissions'), 'always');
  assert.equal(normalizeSessionMode('always_approve'), 'always');
  assert.equal(normalizeSessionMode('yolo'), 'always');
  assert.equal(normalizeSessionMode('auto'), 'always');
  assert.equal(normalizeSessionMode(undefined), 'normal');
  assert.equal(normalizeSessionMode('nonsense'), 'normal');
});

test('the cycle is a closed loop of three', () => {
  assert.deepEqual(SESSION_MODE_CYCLE, ['normal', 'plan', 'always']);
  assert.equal(cycleSessionMode('normal'), 'plan');
  assert.equal(cycleSessionMode('plan'), 'always');
  assert.equal(cycleSessionMode('always'), 'normal');
  assert.equal(cycleSessionMode('garbage'), 'plan');
});

test('only always-approve auto-approves (plan needs an armed yolo)', () => {
  assert.equal(sessionModeAlwaysApprove('normal'), false);
  assert.equal(sessionModeAlwaysApprove('plan'), false);
  assert.equal(sessionModeAlwaysApprove('plan', true), true);
  assert.equal(sessionModeAlwaysApprove('always'), true);
});

test('round-trips through the MSP approval mode', () => {
  assert.equal(mspApprovalModeToSessionMode(sessionModeToMspApprovalMode('plan')), 'plan');
  assert.equal(mspApprovalModeToSessionMode(sessionModeToMspApprovalMode('always')), 'always');
  assert.equal(mspApprovalModeToSessionMode(sessionModeToMspApprovalMode('normal')), 'normal');
});

test('no mode change forces a respawn on the MSP path', () => {
  // session/setApprovalMode applies live — the ACP respawn rule is gone.
  assert.equal(sessionModeNeedsProcessRestart('normal', 'plan'), false);
  assert.equal(sessionModeNeedsProcessRestart('normal', 'always'), false);
  assert.equal(sessionModeToMspApprovalMode('normal'), 'promptUnmatched');
  assert.equal(sessionModeToMspApprovalMode('plan'), 'denyUnmatched');
  assert.equal(sessionModeToMspApprovalMode('always'), 'allowAll');
});

test('labels and pills stay short enough for the chip', () => {
  assert.equal(sessionModeLabel('normal'), 'ask');
  assert.equal(sessionModeLabel('always'), 'always-approve');
  assert.equal(sessionModeLabel('plan', { planState: 'pending' }), 'plan (pending)');
  assert.equal(sessionModePill('always'), 'yolo');
  assert.equal(sessionModePill('plan', { yoloArmed: true }), 'plan+yolo');
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
console.log(`session-mode: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
