#!/usr/bin/env node
// SSE wire: ids, replay, filtering, and the "terminal events are never lost"
// guarantee the UI leans on to leave its running state.

import assert from 'node:assert/strict';
import { SseWire } from '../src/server/sse-wire.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** Minimal ServerResponse double that captures the raw SSE text. */
function fakeRes({ writeReturns = true } = {}) {
  const chunks = [];
  const handlers = {};
  return {
    chunks,
    writeReturns,
    headers: null,
    ended: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    write(s) {
      chunks.push(s);
      return this.writeReturns;
    },
    end() {
      this.ended = true;
    },
    on(ev, fn) {
      handlers[ev] = fn;
    },
    fire(ev) {
      handlers[ev]?.();
    },
    text: () => chunks.join(''),
    frames() {
      return chunks
        .join('')
        .split('\n\n')
        .filter((f) => f.includes('event:'))
        .map((f) => {
          const id = /^id: (\d+)$/m.exec(f)?.[1];
          const event = /^event: (.+)$/m.exec(f)?.[1];
          const data = /^data: (.+)$/m.exec(f)?.[1];
          return { id: Number(id), event, data: JSON.parse(data) };
        });
    },
  };
}

test('sets streaming headers and greets with hello', () => {
  const wire = new SseWire();
  const res = fakeRes();
  wire.addClient('c1', res);
  assert.equal(res.status, 200);
  assert.match(res.headers['Content-Type'], /text\/event-stream/);
  assert.equal(res.headers['Cache-Control'], 'no-cache, no-transform');
  assert.equal(res.frames()[0].event, 'hello');
});

test('event ids are monotonic and appear on the wire', () => {
  const wire = new SseWire();
  const res = fakeRes();
  wire.addClient('c1', res);
  wire.emit('chat-1', 'message_delta', { delta: 'a' });
  wire.emit('chat-1', 'message_delta', { delta: 'b' });
  const frames = res.frames().filter((f) => f.event === 'message_delta');
  assert.equal(frames.length, 2);
  assert.ok(frames[1].id > frames[0].id);
});

test('payload carries chatId and type', () => {
  const wire = new SseWire();
  const res = fakeRes();
  wire.addClient('c1', res);
  wire.emit('chat-7', 'turn_done', { turnId: 't', content: 'x' });
  const f = res.frames().find((x) => x.event === 'turn_done');
  assert.equal(f.data.chatId, 'chat-7');
  assert.equal(f.data.type, 'turn_done');
  assert.equal(f.data.content, 'x');
});

test('subscription filters other chats but never host-level events', () => {
  const wire = new SseWire();
  const res = fakeRes();
  wire.addClient('c1', res, { chatIds: ['mine'] });
  wire.emit('mine', 'message_delta', { delta: 'yes' });
  wire.emit('theirs', 'message_delta', { delta: 'no' });
  wire.emit(null, 'host_note', { hi: 1 });
  const events = res.frames().map((f) => `${f.event}:${f.data.chatId}`);
  assert.ok(events.includes('message_delta:mine'));
  assert.ok(!events.includes('message_delta:theirs'));
  assert.ok(events.includes('host_note:null'));
});

test('Last-Event-ID replays exactly what was missed', () => {
  const wire = new SseWire();
  const first = fakeRes();
  wire.addClient('c1', first);
  const idA = wire.emit('c', 'message_delta', { delta: 'a' });
  wire.emit('c', 'message_delta', { delta: 'b' });
  wire.emit('c', 'turn_done', { turnId: 't' });

  const reconnect = fakeRes();
  wire.addClient('c2', reconnect, { lastEventId: String(idA) });
  const replayed = reconnect.frames().filter((f) => f.event !== 'hello');
  assert.deepEqual(
    replayed.map((f) => f.event),
    ['message_delta', 'turn_done'],
    'must replay after the last seen id, and only after it',
  );
});

test('the replay ring is bounded', () => {
  const wire = new SseWire({ ringSize: 10 });
  for (let i = 0; i < 50; i++) wire.emit('c', 'message_delta', { i });
  assert.equal(wire.ring.length, 10);
});

test('an evicted replay cursor gets exactly one resync frame with an advancing id', () => {
  const wire = new SseWire({ ringSize: 5 });
  wire.addClient('c1', fakeRes());
  for (let i = 0; i < 10; i++) wire.emit('c', 'message_delta', { i });
  // Ring now holds ids 6..10 — a cursor at 2 can never replay 3..5.
  const reconnect = fakeRes();
  wire.addClient('c2', reconnect, { lastEventId: '2' });
  const frames = reconnect.frames().filter((f) => f.event !== 'hello');
  assert.deepEqual(frames.map((f) => f.event), ['resync'], 'evicted cursor must be signalled');
  assert.ok(frames[0].id > 10, 'resync id must advance the cursor past the gap');
  assert.ok(
    !wire.ring.some((ev) => ev.type === 'resync'),
    'the synthetic resync frame must not be stored in the ring',
  );
});

test('a cursor still inside the ring replays normally, no resync', () => {
  const wire = new SseWire({ ringSize: 5 });
  wire.addClient('c1', fakeRes());
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push(wire.emit('c', 'message_delta', { i }));
  const reconnect = fakeRes();
  wire.addClient('c2', reconnect, { lastEventId: String(ids[6]) }); // id 7 — inside ring 6..10
  const frames = reconnect.frames().filter((f) => f.event !== 'hello');
  assert.deepEqual(
    frames.map((f) => f.event),
    ['message_delta', 'message_delta', 'message_delta'],
  );
});

test('a slow consumer still receives terminal events', () => {
  // write() returning false = kernel buffer full. Non-terminal events may be
  // de-prioritised, but turn_done must always reach the client or the UI is
  // stuck "running" forever.
  const wire = new SseWire();
  const res = fakeRes({ writeReturns: false });
  wire.addClient('c1', res);
  wire.emit('c', 'message_delta', { delta: 'x' });
  wire.emit('c', 'turn_done', { turnId: 't' });
  const events = res.frames().map((f) => f.event);
  assert.ok(events.includes('turn_done'));
});

test('back-pressure coalesces deltas per chat and drops chatter, terminal is forced', () => {
  const wire = new SseWire();
  const res = fakeRes({ writeReturns: false });
  wire.addClient('c1', res);
  res.chunks.length = 0; // ignore retry/hello

  wire.emit('a', 'message_delta', { delta: '1', text: 'one' });
  wire.emit('a', 'message_delta', { delta: '2', text: 'one two' });
  wire.emit('b', 'message_delta', { delta: 'x', text: 'bee' });
  wire.emit('a', 'agent_stderr', { text: 'noise' });
  wire.emit('a', 'agent_update_other', { kind: 'whatever' });
  wire.emit('a', 'turn_done', { turnId: 't', content: 'one two final' });

  // Latest delta per chat survives the coalesce queue and lands BEFORE the
  // terminal frame (ordering); stderr/unknown-kind chatter is dropped.
  const frames = res.frames();
  assert.deepEqual(
    frames.map((f) => f.event),
    ['message_delta', 'message_delta', 'turn_done'],
  );
  assert.equal(frames[0].data.text, 'one two', 'only the latest delta per chat may survive');
  assert.equal(frames[1].data.text, 'bee');

  // After drain the queue is empty and the flag clears — the next delta
  // writes straight through again.
  res.fire('drain');
  wire.emit('a', 'message_delta', { delta: '3', text: 'three' });
  const after = res.frames().at(-1);
  assert.equal(after.event, 'message_delta');
  assert.equal(after.data.text, 'three');
});

test('back-pressure never duplicates or loses frames across drains', () => {
  // A write() that returned false still accepted (buffered) the frame — so a
  // drain flush must not re-queue it, or the client would see it twice.
  const wire = new SseWire();
  const res = fakeRes({ writeReturns: false });
  wire.addClient('c1', res);
  res.chunks.length = 0;

  wire.emit('a', 'message_delta', { delta: '1', text: 'one' });
  wire.emit('b', 'message_delta', { delta: '2', text: 'two' });
  res.writeReturns = true; // socket drains cleanly
  res.fire('drain');
  res.writeReturns = false;
  wire.emit('a', 'message_delta', { delta: '3', text: 'three' });
  res.writeReturns = true;
  res.fire('drain');

  const deltas = res.frames().filter((f) => f.event === 'message_delta');
  assert.deepEqual(
    deltas.map((f) => f.data.text),
    ['one', 'two', 'three'],
    'no duplicates and nothing lost across drains',
  );
});

test('removing a client ends the response and stops delivery', () => {
  const wire = new SseWire();
  const res = fakeRes();
  wire.addClient('c1', res);
  const before = res.chunks.length;
  wire.removeClient('c1');
  wire.emit('c', 'message_delta', { delta: 'late' });
  assert.equal(res.ended, true);
  assert.equal(res.chunks.length, before);
  assert.equal(wire.clientCount, 0);
});

test('socket close unregisters the client', () => {
  const wire = new SseWire();
  const res = fakeRes();
  wire.addClient('c1', res);
  assert.equal(wire.clientCount, 1);
  res.fire('close');
  assert.equal(wire.clientCount, 0);
});

test('subscribe() can be changed after connect', () => {
  const wire = new SseWire();
  const res = fakeRes();
  wire.addClient('c1', res, { chatIds: ['a'] });
  assert.equal(wire.subscribe('c1', ['b']), true);
  wire.emit('b', 'message_delta', { delta: 'now visible' });
  assert.ok(res.frames().some((f) => f.data.chatId === 'b'));
  assert.equal(wire.subscribe('nope', ['b']), false);
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
console.log(`sse-wire: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
