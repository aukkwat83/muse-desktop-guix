#!/usr/bin/env node
// Renderer slash-command parser invariants (src/renderer/slash-commands.js —
// pure).
//
// The rule these tests protect: /plan, /ask and /always-approve map to
// muse-desktop's internal SessionMode names (never MSP wire ids — those are
// resolved server-side), and an unknown leading slash is reported, never
// silently eaten or silently treated as plain text.

import assert from 'node:assert/strict';

import { parseSlashCommand } from '../src/renderer/slash-commands.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('plain text is not a command', () => {
  assert.deepEqual(parseSlashCommand('hello world'), { type: 'none' });
  assert.deepEqual(parseSlashCommand(''), { type: 'none' });
  assert.deepEqual(parseSlashCommand(null), { type: 'none' });
  assert.deepEqual(parseSlashCommand('a /plan mention mid-text'), { type: 'none' });
});

test('/plan switches to plan mode, optional remainder rides along', () => {
  assert.deepEqual(parseSlashCommand('/plan'), { type: 'mode', mode: 'plan', rest: '' });
  assert.deepEqual(parseSlashCommand('/plan ทำ authentication'), {
    type: 'mode',
    mode: 'plan',
    rest: 'ทำ authentication',
  });
  assert.deepEqual(parseSlashCommand('/PLAN   multi\nline  '), {
    type: 'mode',
    mode: 'plan',
    rest: 'multi\nline',
  });
});

test('/ask returns to normal mode', () => {
  assert.deepEqual(parseSlashCommand('/ask'), { type: 'mode', mode: 'normal', rest: '' });
  assert.deepEqual(parseSlashCommand('/ask  '), { type: 'mode', mode: 'normal', rest: '' });
});

test('/always-approve on|off map to always/normal; bare toggles', () => {
  assert.deepEqual(parseSlashCommand('/always-approve on'), {
    type: 'mode',
    mode: 'always',
    rest: '',
  });
  assert.deepEqual(parseSlashCommand('/always-approve OFF'), {
    type: 'mode',
    mode: 'normal',
    rest: '',
  });
  assert.deepEqual(parseSlashCommand('/always-approve'), { type: 'toggle-always' });
});

test('unknown leading slashes are reported with their name', () => {
  assert.deepEqual(parseSlashCommand('/compact'), { type: 'unknown', name: '/compact' });
  assert.deepEqual(parseSlashCommand('/planx do it'), { type: 'unknown', name: '/planx' });
  assert.deepEqual(parseSlashCommand('/ask now please'), { type: 'unknown', name: '/ask' });
  assert.deepEqual(parseSlashCommand('/always-approve maybe'), {
    type: 'unknown',
    name: '/always-approve',
  });
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
console.log(`slash-commands: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
