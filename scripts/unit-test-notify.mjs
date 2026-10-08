#!/usr/bin/env node
// /api/notify payload contract: caps, defaults, AppleScript escaping and
// the deliver gate. Never spawns osascript — a unit suite that pops real
// banners would be rude; delivery itself was verified live on the host.

import assert from 'node:assert/strict';

import {
  buildNotifyPayload,
  buildQuestionNotice,
  createQuestionNotifier,
  escAppleScript,
  gdbusNotifyArgs,
  notifyArgs,
  NOTIFY_TEXT_MAX,
  NOTIFY_TITLE_MAX,
  QUESTION_ACTION,
  questionNoticeFile,
  questionNoticeKey,
  shouldDeliver,
} from '../src/server/notify.js';
import { hasLoneSurrogate } from '../src/server/text.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('payload caps title at 80 and text at 300 chars', () => {
  assert.equal(NOTIFY_TITLE_MAX, 80);
  assert.equal(NOTIFY_TEXT_MAX, 300);
  const p = buildNotifyPayload({ title: 't'.repeat(200), body: 'b'.repeat(500) });
  assert.equal(p.title.length, 80);
  assert.equal(p.text.length, 300);
});

test('payload caps never split an emoji', () => {
  const p = buildNotifyPayload({ title: `t${'🎉'.repeat(100)}`, body: `b${'🚀'.repeat(400)}` });
  assert.equal(hasLoneSurrogate(p.title), false);
  assert.equal(hasLoneSurrogate(p.text), false);
});

test('payload defaults the title and accepts body or text', () => {
  assert.equal(buildNotifyPayload({}).title, 'Muse Desktop');
  assert.equal(buildNotifyPayload(null).text, '');
  assert.equal(buildNotifyPayload({ text: 'hi' }).text, 'hi');
  assert.equal(buildNotifyPayload({ body: 'b', text: 't' }).text, 'b');
  assert.equal(buildNotifyPayload({ title: '  ' }).title, '  ');
});

test('AppleScript escaping neutralizes quotes and backslashes', () => {
  assert.equal(escAppleScript('say "hi"'), 'say \\"hi\\"');
  assert.equal(escAppleScript('a\\b'), 'a\\\\b');
  // Backslashes first: a literal \" must not become an escape hatch.
  assert.equal(escAppleScript('\\"'), '\\\\\\"');
});

test('notify argv carries the escaped payload', () => {
  const argv = notifyArgs({ title: 'T"1', text: 'a\\b' });
  assert.equal(argv[0], '-e');
  assert.match(argv[1], /display notification "a\\\\b" with title "T\\"1"/);
});

test('delivery gate: macOS + non-empty body only', () => {
  assert.equal(shouldDeliver({ title: 't', text: 'x' }, 'darwin'), true);
  assert.equal(shouldDeliver({ title: 't', text: '' }, 'darwin'), false);
  assert.equal(shouldDeliver({ title: 't', text: 'x' }, 'linux'), false);
  assert.equal(shouldDeliver({ title: 't' }, 'darwin'), false);
});

test('question keys are filename- and GVariant-safe', () => {
  assert.equal(questionNoticeKey('u-1'), 'q-u-1');
  assert.equal(questionNoticeKey('../../x'), 'q-x');
  assert.equal(questionNoticeKey('a"b\\c'), 'q-a-b-c');
  assert.match(questionNoticeKey(''), /^q-/);
  assert.equal(
    questionNoticeFile('/run/user/1000/', 'q-u-1'),
    '/run/user/1000/muse-desktop/notify-q-u-1.json',
  );
});

test('question notice carries Thai titles and the question text', () => {
  const ask = buildQuestionNotice({ subtype: 'ask', chatTitle: 'งาน', summary: 'Cache where?' });
  assert.equal(ask.title, 'Muse มีคำถาม');
  assert.match(ask.text, /งาน/);
  assert.match(ask.text, /Cache where\?/);
  assert.equal(buildQuestionNotice({ subtype: 'plan', summary: 's' }).title, 'Muse รอตรวจแผน');
  assert.equal(buildQuestionNotice({ subtype: null, summary: 's' }).title, 'Muse รอการอนุญาต');
  assert.equal(hasLoneSurrogate(buildQuestionNotice({ summary: `x${'🎉'.repeat(400)}` }).text), false);
});

test('gdbus argv activates with a variant-wrapped (op, key) tuple', () => {
  // org.gtk.Actions.Activate is (name, parameter:variant, data): the
  // tuple MUST ride as [<('op','key')>] — an actual GLib parse on the
  // Guix host rejects the bare [(..)] form. This asserts the TYPE shape,
  // not just a mirrored string: variant brackets around a string tuple.
  const argv = gdbusNotifyArgs({ op: 'show', key: 'q-u-1' });
  assert.equal(argv[0], 'call');
  const mi = argv.indexOf('--method');
  assert.deepEqual(argv.slice(mi + 1, mi + 2), ['org.gtk.Actions.Activate']);
  const tail = argv.slice(mi + 2);
  assert.equal(tail.length, 3, 'Activate takes exactly (name, variant, dict)');
  assert.equal(tail[0], `'${QUESTION_ACTION}'`);
  assert.match(tail[1], /^\[<\(('show'|'withdraw'), '[^']+'\)>\]$/, 'parameter must be a variant-wrapped (op, key) tuple');
  assert.ok(!tail[1].includes('[(') || tail[1].includes('[<('), 'no bare tuple form');
  assert.equal(tail[1], "[<('show', 'q-u-1')>]");
  assert.equal(tail[2], '{}');
  assert.ok(argv.includes('com.aukkwat83.MuseDesktop'));
  assert.equal(gdbusNotifyArgs({ op: 'withdraw', key: 'q-u-1' }).at(-2), "[<('withdraw', 'q-u-1')>]");
});

function stubHarness({ status = 0, stderr = '' } = {}) {
  const calls = [];
  const files = new Map();
  const logs = [];
  const n = createQuestionNotifier({
    platform: 'linux',
    runtimeDir: '/run/user/1000',
    spawnAsyncFn: async (cmd, argv, opts) => {
      calls.push([cmd, argv, opts]);
      return { status, stderr };
    },
    writeFileFn: (content, file) => {
      if (content == null) files.delete(file);
      else files.set(file, content);
    },
    mkdirFn: () => {},
    logFn: (...a) => logs.push(a.join(' ')),
    env: {},
  });
  return { n, calls, files, logs };
}

test('host pending writes the JSON file then queues the typed action', async () => {
  const { n, calls, files, logs } = stubHarness();
  const r = n.pending({ id: 'u-1', chatId: 'c', title: 'Muse มีคำถาม', body: 'งาน — Cache?' });
  assert.equal(r.attempted, true);
  assert.equal(r.queued, true, 'sync receipt says queued, never visually delivered');
  assert.equal(r.via, 'gdbus');
  const file = questionNoticeFile('/run/user/1000', 'q-u-1');
  const payload = JSON.parse(files.get(file));
  assert.equal(payload.chatId, 'c');
  assert.equal(payload.ixId, 'u-1');
  assert.equal(payload.title, 'Muse มีคำถาม');
  await n.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'gdbus');
  assert.ok(logs.some((l) => l.includes('queued')), 'queue receipt is logged');
  assert.ok(logs.some((l) => l.includes('accepted')), 'terminal accepted lands in the log');
  assert.ok(!logs.some((l) => l.includes('delivered')), 'nothing claims visual delivery');
});

test('identical repeats dedupe; withdraw clears and re-arms', async () => {
  const { n, calls } = stubHarness();
  const first = { id: 'u-2', chatId: 'c', title: 't', body: 'b' };
  assert.equal(n.pending(first).queued, true);
  const early = n.pending({ ...first });
  assert.equal(early.via, 'dedupe-queued', 'a repeat before dispatch must not claim delivered');
  assert.equal(early.delivered, false);
  await n.flush();
  assert.equal(calls.length, 1);
  const late = n.pending({ ...first });
  assert.equal(late.via, 'dedupe', 'a repeat after bus-accept dedupes delivered');
  assert.equal(late.delivered, true);
  const w = n.withdraw('u-2');
  assert.equal(w.queued, true);
  await n.flush();
  assert.equal(calls.length, 2);
  assert.ok(calls[1][1].join(' ').includes('withdraw'));
  assert.equal(n.pending({ ...first }).queued, true, 're-pending after withdraw re-banners');
});

test('coalesced update + failed dispatch: the retry re-attempts, never dedupes forever', async () => {
  // maxConcurrent 1 with a blocker: A(old) queues, A(new) coalesces onto
  // the queued job, the dispatch fails, and the A(new) retry must make a
  // fresh bus call. Before the fix the coalesce kept the OLD fingerprint
  // while seen held the NEW one, so the failure cleared nothing and every
  // retry falsely deduped.
  let releaseBlocker;
  const blocker = new Promise((r) => { releaseBlocker = r; });
  const script = []; // per-call results, in dispatch order
  const calls = [];
  const n = createQuestionNotifier({
    platform: 'linux',
    runtimeDir: '/run/user/1000',
    spawnAsyncFn: async (...a) => {
      calls.push(a);
      return script[calls.length - 1] || { status: 0, stderr: '' };
    },
    writeFileFn: () => {},
    mkdirFn: () => {},
    logFn: () => {},
    env: {},
    maxConcurrent: 1,
  });
  // Hold the only slot: the blocker job runs until released.
  script[0] = blocker.then(() => ({ status: 0, stderr: '' }));
  n.pending({ id: 'blocker', chatId: 'c', title: 't', body: 'held' });
  n.pending({ id: 'u-9', chatId: 'c', title: 't', body: 'old' });
  const updated = n.pending({ id: 'u-9', chatId: 'c', title: 't', body: 'new' });
  assert.equal(updated.queued, true, 'new body is a new generation, not a dupe');
  script[1] = { status: 1, stderr: 'GDBus.Error: timed out' };
  releaseBlocker();
  await n.flush();
  assert.equal(calls.length, 2, 'blocker + one coalesced A dispatch');
  const retry = n.pending({ id: 'u-9', chatId: 'c', title: 't', body: 'new' });
  assert.notEqual(retry.via, 'dedupe', 'the failed generation must not dedupe');
  assert.notEqual(retry.via, 'dedupe-queued', 'the failed generation must re-attempt');
  script[2] = { status: 0, stderr: '' };
  await n.flush();
  assert.equal(calls.length, 3, 'the retry makes a fresh bus call');
});

test('a failed gdbus un-marks the key: the retry re-attempts, never fake-delivers', async () => {
  const { n, calls, logs } = stubHarness({ status: 1, stderr: 'GDBus.Error: name has no owner' });
  const r = n.pending({ id: 'u-3', chatId: 'c', title: 't', body: 'b' });
  assert.equal(r.attempted, true);
  assert.equal(r.queued, true);
  await n.flush();
  assert.ok(logs.some((l) => l.includes('FAILED') && l.includes('no owner')));
  assert.equal(calls.length, 1);
  // The retry must make a SECOND bus call — not report delivered:true off the failed mark.
  const r2 = n.pending({ id: 'u-3', chatId: 'c', title: 't', body: 'b' });
  assert.notEqual(r2.via, 'dedupe', 'failures must not dedupe');
  await n.flush();
  assert.equal(calls.length, 2, 'the retry re-attempts the bus call');
});

test('dispatch is async and bounded: pending never blocks on the bus', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = [];
  const n = createQuestionNotifier({
    platform: 'linux',
    runtimeDir: '/run/user/1000',
    spawnAsyncFn: async (...a) => {
      calls.push(a);
      await gate;
      return { status: 0, stderr: '' };
    },
    writeFileFn: () => {},
    mkdirFn: () => {},
    logFn: () => {},
    env: {},
    maxConcurrent: 1,
  });
  const t0 = Date.now();
  n.pending({ id: 'a', chatId: 'c', title: 't', body: 'b' });
  n.pending({ id: 'b', chatId: 'c', title: 't', body: 'b' });
  assert.ok(Date.now() - t0 < 1000, 'pending returns without waiting for gdbus');
  assert.equal(calls.length, 1, 'bounded: one in flight with maxConcurrent 1');
  release();
  await n.flush();
  assert.equal(calls.length, 2, 'the queued job runs after the first settles');
});

test('MUSE_DESKTOP_NOTIFY=off disables; _LOG sinks lines for E2E', () => {
  const off = createQuestionNotifier({ platform: 'linux', env: { MUSE_DESKTOP_NOTIFY: 'off' }, logFn: () => {} });
  assert.equal(off.pending({ id: 'x', title: 't', body: 'b' }).via, 'off');
  assert.equal(off.withdraw('x').attempted, false);
  const sunk = [];
  const logged = createQuestionNotifier({
    platform: 'linux',
    env: { MUSE_DESKTOP_NOTIFY_LOG: '/tmp/n.log' },
    writeFileFn: (content, file) => sunk.push([file, content]),
    logFn: () => {},
  });
  assert.equal(logged.pending({ id: 'u-9', chatId: 'c', title: 't', body: 'b' }).via, 'log');
  logged.withdraw('u-9');
  assert.equal(sunk.length, 2);
  assert.equal(sunk[0][0], '/tmp/n.log');
  assert.match(sunk[0][1], /"ixId":"u-9"/);
  assert.match(sunk[1][1], /"op":"withdraw"/);
});

test('non-Linux hosts stay on their existing paths', () => {
  const mac = createQuestionNotifier({ platform: 'darwin', env: {}, logFn: () => {} });
  assert.equal(mac.pending({ id: 'x', title: 't', body: 'b' }).via, 'mac-route');
  assert.equal(mac.withdraw('x').attempted, false);
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
console.log(`notify: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
