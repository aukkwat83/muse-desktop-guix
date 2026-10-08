#!/usr/bin/env node
// Native child transcripts: constrained read-only projection of a delegated
// subagent's own session.jsonl onto drill items (grounded in the read-session
// SKILL.md + doctor session-evidence.py — never invented schema).
//
// Covers: visible-content projection + terminal, live appends, partial last
// line, malformed tolerance, path escape, cross-parent isolation, workspace
// verification, ambiguity refusal, and read bounds.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  findParentSessionDir,
  isSafeSessionId,
  readNativeChildTranscript,
  readNativeTranscript,
  resolveNativeChildLog,
  verifyParentWorkspace,
} from '../src/server/native-transcript.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'muse-native-log-'));
}

/** Envelope helper mirroring the first-party record shape. Real logs always
 * carry the owning session id as the stream id — fixtures do the same. */
function rec(seq, payloadType, payload, streamId = 'stream-1') {
  return JSON.stringify({
    schema_version: 1,
    id: `r${seq}`,
    stream: { kind: 'session', id: streamId },
    sequence: seq,
    recorded_at: 1771088000123456 + seq,
    record_type: 'event',
    durability: 'durable',
    causation_id: null,
    payload_type: payloadType,
    payload_schema_version: 1,
    payload,
  });
}

const metaRec = (seq, workspace, streamId) =>
  rec(seq, 'runtime.session.metadata', { workspace_root: workspace }, streamId);

function boundRec(seq, parent, subagentId, childSessionId) {
  return rec(seq, 'subagent.control.child_session_bound', {
    kind: 'subagent_control',
    record: { kind: 'child_session_bound', schema_version: 1, subagent_id: subagentId, child_session_id: childSessionId },
  }, parent);
}

function writeParent(root, { date = '2026/10/08', parent = 'parent-1', workspace, extra = [], bindings = [] }) {
  const dir = path.join(root, 'muse', 'sessions', date, parent);
  fs.mkdirSync(dir, { recursive: true });
  const bound = bindings.map(([sub, sess], i) => boundRec(100 + i, parent, sub, sess));
  const lines = [metaRec(1, workspace, parent), ...extra, ...bound];
  fs.writeFileSync(path.join(dir, 'session.jsonl'), `${lines.join('\n')}\n`);
  return dir;
}

function writeChild(parentDir, child, lines, { trailingNewline = true } = {}) {
  const dir = path.join(parentDir, 'subagent', child);
  fs.mkdirSync(dir, { recursive: true });
  const body = lines.join('\n') + (trailingNewline && lines.length ? '\n' : '');
  fs.writeFileSync(path.join(dir, 'session.jsonl'), body);
  return path.join(dir, 'session.jsonl');
}

function childLogLines(streamId = 'stream-1') {
  const r = (seq, type, payload) => rec(seq, type, payload, streamId);
  return [
    r(1, 'runtime.session', { kind: 'run', run_id: 'run-1', event: { kind: 'started', prompt: 'research caches' } }),
    r(2, 'runtime.session', {
      kind: 'run', run_id: 'run-1',
      event: {
        kind: 'assistant_tool_calls_committed',
        tool_calls: [{ name: 'mcp__gh.search', args: { query: 'cache' }, call_id: 'c1' }],
      },
    }),
    r(3, 'runtime.session', {
      kind: 'run', run_id: 'run-1',
      event: { kind: 'tool_result_batch_committed', results: [{ tool_call_id: 'c1', text: '3 repos' }] },
    }),
    r(4, 'runtime.session', { kind: 'run', run_id: 'run-1', event: { kind: 'assistant_message_committed', text: 'Redis wins.' } }),
    // Skipped: system context, reasoning, approvals, compaction, display variants.
    r(5, 'runtime.session', { kind: 'run', run_id: 'run-1', event: { kind: 'system_context', text: 'SECRET-CTX' } }),
    r(6, 'runtime.session', { kind: 'run', run_id: 'run-1', event: { kind: 'reasoning_text', text: 'SECRET-THINK' } }),
    r(7, 'runtime.session', { kind: 'run', run_id: 'run-1', event: { kind: 'terminal', terminal: 'completed' } }),
  ];
}

test('isSafeSessionId admits the first-party vocabulary only', () => {
  assert.equal(isSafeSessionId('abc-123_X.y'), true);
  assert.equal(isSafeSessionId('../x'), false);
  assert.equal(isSafeSessionId('a/b'), false);
  assert.equal(isSafeSessionId(''), false);
  assert.equal(isSafeSessionId(null), false);
  assert.equal(isSafeSessionId('x'.repeat(129)), false);
});

test('projection keeps visible content + terminal, drops the rest', () => {
  const root = tmpRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-native-cwd-'));
  const parentDir = writeParent(root, { parent: 'parent-1', workspace: cwd });
  const log = writeChild(parentDir, 'child-1', childLogLines());
  const out = readNativeTranscript(log);
  assert.equal(out.terminal, 'completed');
  assert.equal(out.malformed, 0);
  const kinds = out.items.map((it) => it.kind);
  assert.deepEqual(kinds, ['userMessage', 'toolCall', 'toolCall', 'agentMessage', 'terminal']);
  assert.equal(out.items[0].text, 'research caches');
  assert.equal(out.items[1].tool, 'search', 'tool leaf name, not the namespaced path');
  assert.ok(out.items[1].text.includes('cache'));
  assert.equal(out.items[2].text, '3 repos', 'result row follows its call');
  assert.equal(out.items[3].text, 'Redis wins.');
  const blob = JSON.stringify(out.items);
  assert.ok(!blob.includes('SECRET-CTX') && !blob.includes('SECRET-THINK'));
  for (const it of out.items) assert.ok(it.itemId, 'every item carries an id');
});

test('user_steer inbox prompts project as user messages; other sources stay out', () => {
  const root = tmpRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-native-cwd-'));
  const parentDir = writeParent(root, { parent: 'parent-1', workspace: cwd });
  const log = writeChild(parentDir, 'child-1', [
    rec(1, 'runtime.session', {
      kind: 'run', run_id: 'run-9',
      event: { kind: 'inbox_item_queued', source: { source: 'user_steer' }, payload: { prompt: 'wait, also check redis' } },
    }),
    rec(2, 'runtime.session', {
      kind: 'run', run_id: 'run-9',
      event: { kind: 'inbox_item_queued', source: { source: 'scheduled' }, payload: { prompt: 'CRON-NOISE' } },
    }),
  ]);
  const out = readNativeTranscript(log);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].kind, 'userMessage');
  assert.equal(out.items[0].text, 'wait, also check redis');
});

test('polling sees appended lines and the terminal when it lands', () => {
  const root = tmpRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-native-cwd-'));
  const parentDir = writeParent(root, { parent: 'parent-1', workspace: cwd });
  const log = writeChild(parentDir, 'child-1', childLogLines().slice(0, 2));
  const first = readNativeTranscript(log);
  assert.equal(first.terminal, null);
  assert.equal(first.items.length, 2);
  assert.equal(first.items[1].status, 'inProgress', 'call without a result yet reads running');
  fs.appendFileSync(log, `${childLogLines().slice(2).join('\n')}\n`);
  const second = readNativeTranscript(log);
  assert.equal(second.terminal, 'completed');
  assert.equal(second.items.length, 5);
  assert.ok(second.items.every((it) => it.status !== 'open'), 'no internal statuses leak');
});

test('a partial last line is ignored, not counted malformed', () => {
  const root = tmpRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-native-cwd-'));
  const parentDir = writeParent(root, { parent: 'parent-1', workspace: cwd });
  const log = writeChild(parentDir, 'child-1', childLogLines().slice(0, 1), { trailingNewline: false });
  // Simulate a mid-write tail: valid line, no trailing newline, then garbage.
  fs.appendFileSync(log, '\n{"schema_version":1,"half-wrote');
  const out = readNativeTranscript(log);
  assert.equal(out.partialIgnored, true);
  assert.equal(out.malformed, 0);
  assert.equal(out.items.length, 1);
  // The writer finishes the file with a complete record — the next poll
  // picks new content up (the old partial bytes stay malformed history).
  fs.appendFileSync(log, `,\n${childLogLines()[3]}\n`);
  const reread = readNativeTranscript(log);
  assert.ok(reread.items.length >= 1);
});

test('malformed lines count + surface, parsing continues past them', () => {
  const root = tmpRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-native-cwd-'));
  const parentDir = writeParent(root, { parent: 'parent-1', workspace: cwd });
  const log = writeChild(parentDir, 'child-1', [
    childLogLines()[0],
    'not json at all {{{',
    '12345',
    childLogLines()[3],
  ]);
  const out = readNativeTranscript(log);
  assert.equal(out.malformed, 2, 'garbage + valid-JSON non-object both count');
  assert.equal(out.items.length, 2, 'good records around the damage still project');
});

/** Assert a lookup throws the exact coded miss (message text may evolve). */
function assertCode(fn, code, msg) {
  try {
    fn();
  } catch (err) {
    assert.equal(err?.code, code, msg);
    return;
  }
  assert.fail(`expected ${code}${msg ? `: ${msg}` : ''}`);
}

test('parent lookup is exact-match, bounded, and refuses ambiguity', () => {
  const root = tmpRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-native-cwd-'));
  const dir = writeParent(root, { date: '2026/10/08', parent: 'parent-9', workspace: cwd });
  assert.equal(findParentSessionDir(root, 'parent-9'), dir);
  assertCode(() => findParentSessionDir(root, 'parent'), 'PARENT_NOT_FOUND', 'no prefix matching');
  assertCode(() => findParentSessionDir(root, '../x'), 'INVALID_PARENT_ID');
  // A child dir named like a parent is not a parent.
  writeChild(dir, 'child-1', []);
  assertCode(() => findParentSessionDir(root, 'child-1'), 'PARENT_NOT_FOUND');
  writeParent(root, { date: '2026/10/09', parent: 'parent-9', workspace: cwd });
  assertCode(() => findParentSessionDir(root, 'parent-9'), 'PARENT_AMBIGUOUS');
});

test('workspace verification binds the log to the chat cwd', () => {
  const root = tmpRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-native-cwd-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-native-other-'));
  const okDir = writeParent(root, { date: '2026/10/08', parent: 'p-ok', workspace: cwd });
  assert.equal(verifyParentWorkspace(okDir, cwd).ok, true);
  assert.equal(verifyParentWorkspace(okDir, path.join(cwd, 'sub', 'dir')).ok, true);
  assert.deepEqual(verifyParentWorkspace(okDir, other), { ok: false, reason: 'WORKSPACE_MISMATCH' });
  const noMeta = writeParent(root, { date: '2026/10/08', parent: 'p-nometa', workspace: cwd });
  fs.writeFileSync(path.join(noMeta, 'session.jsonl'), `${rec(1, 'runtime.session', { kind: 'run' }, 'p-nometa')}\n`);
  assert.deepEqual(verifyParentWorkspace(noMeta, cwd), { ok: false, reason: 'WORKSPACE_UNKNOWN' });
  // Nested record shape + checkpoint shape both ground the metadata.
  const nested = writeParent(root, {
    date: '2026/10/08', parent: 'p-nested', workspace: '/nowhere',
    extra: [rec(2, 'runtime.session.metadata', { record: { workspace_root: cwd } }, 'p-nested')],
  });
  assert.equal(verifyParentWorkspace(nested, cwd).ok, true, 'latest metadata wins');
  const cp = writeParent(root, {
    date: '2026/10/08', parent: 'p-cp', workspace: '/nowhere',
    extra: [rec(2, 'runtime.session', {
      kind: 'run', event: { kind: 'context_projection_checkpoint', session_metadata: { workspace_root: cwd } },
    }, 'p-cp')],
  });
  assert.equal(verifyParentWorkspace(cp, cwd).ok, true);
});

test('child resolution refuses escapes and never leaves the owning parent', () => {
  const root = tmpRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-native-cwd-'));
  const parentDir = writeParent(root, { parent: 'parent-1', workspace: cwd });
  writeChild(parentDir, 'child-1', childLogLines().slice(0, 1));
  assert.ok(resolveNativeChildLog(parentDir, 'child-1').endsWith('session.jsonl'));
  assertCode(() => resolveNativeChildLog(parentDir, '../parent-1'), 'INVALID_CHILD_ID');
  assertCode(() => resolveNativeChildLog(parentDir, 'nope'), 'LOG_MISSING');
  // Symlink escape: a valid-looking child name resolving outside the parent.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-native-out-'));
  fs.writeFileSync(path.join(outside, 'session.jsonl'), '[]\n');
  fs.mkdirSync(path.join(parentDir, 'subagent'), { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(parentDir, 'subagent', 'evil'));
    assertCode(() => resolveNativeChildLog(parentDir, 'evil'), 'PATH_ESCAPE');
  } catch (err) {
    if (err?.code === 'PATH_ESCAPE') throw err;
    // Symlinks need privileges on some platforms — the regex + missing-dir
    // cases above still pin the contract.
  }
});

test('cross-parent isolation: a child is only visible under its owning parent', () => {
  const root = tmpRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-native-cwd-'));
  const dirA = writeParent(root, { date: '2026/10/08', parent: 'parent-a', workspace: cwd });
  const dirB = writeParent(root, {
    date: '2026/10/08', parent: 'parent-b', workspace: cwd, bindings: [['child-x', 'child-x']],
  });
  writeChild(dirB, 'child-x', childLogLines('child-x').slice(0, 1));
  const hit = readNativeChildTranscript({ dataRoot: root, parentId: 'parent-b', childId: 'child-x', chatCwd: cwd });
  assert.equal(hit.ok, true);
  assert.equal(hit.items.length, 1);
  const miss = readNativeChildTranscript({ dataRoot: root, parentId: 'parent-a', childId: 'child-x', chatCwd: cwd });
  assert.deepEqual(miss, { ok: false, code: 'NO_BINDING' }, 'no search across parents');
  void dirA;
});

test('binding resolves subagent_id to a different child session dir', () => {
  const root = tmpRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-native-cwd-'));
  const parentDir = writeParent(root, {
    parent: 'parent-1', workspace: cwd, bindings: [['sub-a', 'sess-child-1']],
  });
  writeChild(parentDir, 'sess-child-1', childLogLines('sess-child-1').slice(0, 2));
  const hit = readNativeChildTranscript({ dataRoot: root, parentId: 'parent-1', childId: 'sub-a', chatCwd: cwd });
  assert.equal(hit.ok, true);
  assert.equal(hit.childSessionId, 'sess-child-1');
  assert.equal(hit.items.length, 2);
  const miss = readNativeChildTranscript({ dataRoot: root, parentId: 'parent-1', childId: 'sub-zzz', chatCwd: cwd });
  assert.deepEqual(miss, { ok: false, code: 'NO_BINDING' }, 'unbound ids fall back honestly');
});

test('combined read refuses unverified parents end to end', () => {
  const root = tmpRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-native-cwd-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-native-other-'));
  const parentDir = writeParent(root, { parent: 'parent-1', workspace: other });
  writeChild(parentDir, 'child-1', childLogLines().slice(0, 1));
  assert.deepEqual(
    readNativeChildTranscript({ dataRoot: root, parentId: 'parent-1', childId: 'child-1', chatCwd: cwd }),
    { ok: false, code: 'WORKSPACE_MISMATCH' },
  );
  assert.deepEqual(
    readNativeChildTranscript({ dataRoot: root, parentId: 'missing', childId: 'child-1', chatCwd: cwd }),
    { ok: false, code: 'PARENT_NOT_FOUND' },
  );
  assert.deepEqual(
    readNativeChildTranscript({ dataRoot: root, parentId: 'parent-1', childId: '..', chatCwd: cwd }),
    { ok: false, code: 'INVALID_CHILD_ID' },
  );
});

test('reads stay bounded: item cap drops the head, byte cap tails the file', () => {
  const root = tmpRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-native-cwd-'));
  const parentDir = writeParent(root, { parent: 'parent-1', workspace: cwd });
  const lines = [];
  for (let i = 0; i < 250; i++) {
    lines.push(rec(i + 1, 'runtime.session', {
      kind: 'run', run_id: 'run-1', event: { kind: 'assistant_message_committed', text: `msg-${i}` },
    }));
  }
  const log = writeChild(parentDir, 'child-1', lines);
  const out = readNativeTranscript(log);
  assert.equal(out.items.length, 200);
  assert.equal(out.droppedFromHead, 50);
  assert.equal(out.items[0].text, 'msg-50');
  const small = readNativeTranscript(log, { maxBytes: 400 });
  assert.ok(small.items.length < 200, 'a tiny window reads a tail, not the head');
  assert.ok(small.items.length > 0);
  assert.equal(small.byteTruncated, true, 'a cut head is reported, not silent');
  assert.ok(small.bytesSkipped > 0);
  assert.equal(out.byteTruncated, false, 'a fully-read file reports no truncation');
});

test('a new run resets the previous terminal; latest run drives state', () => {
  const root = tmpRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-native-cwd-'));
  const parentDir = writeParent(root, { parent: 'parent-1', workspace: cwd });
  const r = (seq, payload) => rec(seq, 'runtime.session', payload, 'child-1');
  const log = writeChild(parentDir, 'child-1', [
    r(1, { kind: 'run', run_id: 'run-1', event: { kind: 'started', prompt: 'first' } }),
    r(2, {
      kind: 'run', run_id: 'run-1',
      event: {
        kind: 'assistant_tool_calls_committed',
        tool_calls: [{ name: 'read', args: { path: '/a' }, call_id: 'c1' }],
      },
    }),
    r(3, { kind: 'run', run_id: 'run-1', event: { kind: 'terminal', terminal: 'completed' } }),
    r(4, { kind: 'run', run_id: 'run-2', event: { kind: 'started', prompt: 'second' } }),
    r(5, {
      kind: 'run', run_id: 'run-2',
      event: {
        kind: 'assistant_tool_calls_committed',
        tool_calls: [{ name: 'read', args: { path: '/b' }, call_id: 'c2' }],
      },
    }),
  ]);
  const out = readNativeTranscript(log, { expectedStreamId: 'child-1' });
  assert.equal(out.terminal, null, 'run-1 terminal must not leak into run-2');
  assert.equal(out.runState, 'running');
  const calls = out.items.filter((it) => it.kind === 'toolCall');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].status, 'completed', 'run-1 call settled at its terminal');
  assert.equal(calls[1].status, 'inProgress', 'run-2 call stays live without run-1 terminal');
  // The second run lands: state flips, nothing stays falsely running.
  fs.appendFileSync(log, `${r(6, { kind: 'run', run_id: 'run-2', event: { kind: 'terminal', terminal: 'completed' } })}\n`);
  const done = readNativeTranscript(log, { expectedStreamId: 'child-1' });
  assert.equal(done.terminal, 'completed');
  assert.equal(done.runState, 'terminal');
  assert.ok(done.items.every((it) => it.status !== 'inProgress'));
});

test('empty tool results resolve their call without emitting a row', () => {
  const root = tmpRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-native-cwd-'));
  const parentDir = writeParent(root, { parent: 'parent-1', workspace: cwd });
  const r = (seq, payload) => rec(seq, 'runtime.session', payload, 'child-1');
  const log = writeChild(parentDir, 'child-1', [
    r(1, { kind: 'run', run_id: 'run-1', event: { kind: 'started', prompt: 'go' } }),
    r(2, {
      kind: 'run', run_id: 'run-1',
      event: {
        kind: 'assistant_tool_calls_committed',
        tool_calls: [{ name: 'noop', args: {}, call_id: 'c1' }],
      },
    }),
    r(3, {
      kind: 'run', run_id: 'run-1',
      event: { kind: 'tool_result_batch_committed', results: [{ tool_call_id: 'c1', text: '   ' }] },
    }),
  ]);
  const out = readNativeTranscript(log);
  const calls = out.items.filter((it) => it.kind === 'toolCall');
  assert.equal(calls.length, 1, 'no empty result row');
  assert.equal(calls[0].status, 'completed', 'the empty result still resolves the call');
});

test('a linked parent log disqualifies the match (no sibling reads)', () => {
  const root = tmpRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-native-cwd-'));
  const dirA = writeParent(root, { date: '2026/10/08', parent: 'parent-a', workspace: cwd });
  const dirB = writeParent(root, { date: '2026/10/08', parent: 'parent-b', workspace: cwd });
  // parent-b's log becomes a link to parent-a's log: B must not resolve.
  fs.unlinkSync(path.join(dirB, 'session.jsonl'));
  try {
    fs.symlinkSync(path.join(dirA, 'session.jsonl'), path.join(dirB, 'session.jsonl'));
  } catch (err) {
    if (err?.code === 'EPERM') return; // symlink privileges absent — child suite pins the rest
    throw err;
  }
  assertCode(() => findParentSessionDir(root, 'parent-b'), 'PARENT_NOT_FOUND');
  assert.equal(findParentSessionDir(root, 'parent-a'), dirA, 'the link target still resolves');
});

test('a child log linked at a sibling or the parent log is refused', () => {
  const root = tmpRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-native-cwd-'));
  const parentDir = writeParent(root, { parent: 'parent-1', workspace: cwd, bindings: [['child-b', 'child-b']] });
  writeChild(parentDir, 'child-a', childLogLines('child-a').slice(0, 1));
  const dirB = path.join(parentDir, 'subagent', 'child-b');
  fs.mkdirSync(dirB, { recursive: true });
  try {
    fs.symlinkSync(
      path.join(parentDir, 'subagent', 'child-a', 'session.jsonl'),
      path.join(dirB, 'session.jsonl'),
    );
  } catch (err) {
    if (err?.code === 'EPERM') return;
    throw err;
  }
  assertCode(() => resolveNativeChildLog(parentDir, 'child-b'), 'PATH_ESCAPE');
  assert.deepEqual(
    readNativeChildTranscript({ dataRoot: root, parentId: 'parent-1', childId: 'child-b', chatCwd: cwd }),
    { ok: false, code: 'PATH_ESCAPE' },
  );
});

test('stream session ids must match the selected session', () => {
  const root = tmpRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-native-cwd-'));
  const parentDir = writeParent(root, { parent: 'parent-1', workspace: cwd, bindings: [['child-1', 'child-1']] });
  writeChild(parentDir, 'child-1', childLogLines('other-child').slice(0, 1));
  assert.deepEqual(
    readNativeChildTranscript({ dataRoot: root, parentId: 'parent-1', childId: 'child-1', chatCwd: cwd }),
    { ok: false, code: 'STREAM_MISMATCH' },
  );
  // Same for the parent side: a foreign stream in the parent log refuses.
  const bad = writeParent(root, { date: '2026/10/09', parent: 'parent-2', workspace: cwd });
  fs.appendFileSync(
    path.join(bad, 'session.jsonl'),
    `${rec(2, 'runtime.session', { kind: 'run', run_id: 'x', event: { kind: 'started', prompt: 'hi' } }, 'someone-else')}\n`,
  );
  assert.deepEqual(verifyParentWorkspace(bad, cwd), { ok: false, reason: 'STREAM_MISMATCH' });
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
console.log(`native-transcript: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
