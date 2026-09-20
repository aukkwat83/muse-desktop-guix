#!/usr/bin/env node
// End-to-end: a real host process, a real HTTP client, a real SSE stream —
// only the agent is a stand-in (`muse serve` needs a login + MCP audit, so the
// mock is the only way to exercise this path unattended).
//
// What it proves: prompt → stream → settle, tool rows, the permission
// round-trip, cancel, the 409 in-flight guard, the login gate, and that a
// finished turn leaves exactly one user + one assistant message on disk.

import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK = path.join(ROOT, 'scripts/mock-msp-agent.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickPort() {
  return 3900 + Math.floor(Math.random() * 400);
}

async function startHost({ authWall = false, museBin = MOCK } = {}) {
  const port = pickPort();
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-e2e-'));
  // Hermetic MCP catalog: the host must never touch the developer's real
  // ~/.config/muse/settings.json (the toggle e2e writes to it).
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-e2e-cfg-'));
  fs.mkdirSync(path.join(configHome, 'muse'), { recursive: true });
  const settingsFile = path.join(configHome, 'muse', 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({
    schema_version: 1,
    mcpServers: {
      github: { mode: 'optional', command: '/nonexistent/e2e-github-mcp' },
      mcpfix: { mode: 'optional', command: process.execPath, args: [path.join(ROOT, 'scripts/fixture-mcp-stdio.mjs')] },
    },
  }, null, 2));
  const proc = spawn(process.execPath, [path.join(ROOT, 'src/server/index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      MUSE_DESKTOP_PORT: String(port),
      MUSE_DESKTOP_HOST: '127.0.0.1',
      XDG_STATE_HOME: stateHome,
      XDG_CONFIG_HOME: configHome,
      NO_OPEN: '1',
      MUSE_BIN: museBin,
      MUSE_DESKTOP_MODEL: 'mock-model-1',
      MUSE_DESKTOP_EFFORT: 'max',
      // Short test-only watchdog clocks so the liveness E2E below runs in
      // seconds instead of minutes (production defaults: 180s / 15s).
      MUSE_DESKTOP_NO_ACTIVITY_MS: '1500',
      MUSE_DESKTOP_WATCHDOG_TICK_MS: '400',
      // 2ms delta flush: the mock's 10ms-spaced chunks still arrive per-frame,
      // while the 120-chunk "long" burst lands inside one window (BUG-009).
      MUSE_DESKTOP_DELTA_FLUSH_MS: '2',
      MOCK_MSP_CONFIG_LOG: path.join(stateHome, 'config-calls.log'),
      MOCK_MSP_HISTFAIL_MARKER: path.join(stateHome, 'histfail.marker'),
      MOCK_MSP_PROMPT_LOG: path.join(stateHome, 'prompts.log'),
      ...(authWall ? { MOCK_MSP_MODE: 'authwall' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  proc.stdout.on('data', (b) => logs.push(b.toString()));
  proc.stderr.on('data', (b) => logs.push(b.toString()));

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await req(base, 'GET', '/api/state');
      if (r.ok) return { proc, base, port, stateHome, configHome, settingsFile, logs };
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error(`host never became healthy:\n${logs.join('')}`);
}

function req(base, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base);
    const r = http.request(
      url,
      { method, headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, ...(text ? JSON.parse(text) : {}) });
          } catch {
            resolve({ status: res.statusCode, raw: text });
          }
        });
      },
    );
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

/** Live SSE consumer with a wait-for predicate. */
function openStream(base) {
  const events = [];
  const waiters = [];
  const url = new URL('/api/events', base);
  const request = http.get(url, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const event = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (!event || !data) continue;
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const record = { event, data: parsed };
        events.push(record);
        for (const w of [...waiters]) {
          if (w.match(record)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(record);
          }
        }
      }
    });
  });
  return {
    events,
    close: () => request.destroy(),
    of: (event) => events.filter((e) => e.event === event),
    waitFor(match, { timeoutMs = 15_000, label = 'event' } = {}) {
      const hit = events.find(match);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) {
            waiters.splice(i, 1);
            reject(new Error(`timeout waiting for ${label}`));
          }
        }, timeoutMs).unref?.();
      });
    },
  };
}

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log(`  ok   ${name}`);
  } catch (err) {
    results.push([false, name]);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

// ------------------------------------------------------------------ main

const host = await startHost();
const stream = openStream(host.base);
await sleep(300);

let chatId;

await step('create a chat', async () => {
  const r = await req(host.base, 'POST', '/api/chats', { title: 'e2e', cwd: os.tmpdir() });
  assert.equal(r.status, 201);
  chatId = r.chat.id;
  assert.equal(r.chat.mode, 'always', 'new chats default to yolo');
  // MUSE_DESKTOP_EFFORT=max on this host overrides the ultra default.
  assert.equal(r.chat.effort, 'max');
});

await step('create-warm: a fresh chat spawns its agent with no prompt', async () => {
  const r = await req(host.base, 'POST', '/api/chats', { title: 'warm', cwd: os.tmpdir() });
  assert.equal(r.status, 201);
  const warmId = r.chat.id;
  assert.equal(r.chat.live, false, 'create must return before the agent is up');
  await stream.waitFor((e) => e.event === 'agent_ready' && e.data.chatId === warmId, {
    label: 'agent_ready for warmed chat',
  });
  const after = await req(host.base, 'GET', `/api/chats/${warmId}`);
  assert.equal(after.chat.live, true);
});

await step('prompt returns 202 + turnId (never blocks on the turn)', async () => {
  const started = Date.now();
  const r = await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'hello' });
  assert.equal(r.status, 202);
  assert.ok(r.turnId, 'turnId missing');
  assert.ok(Date.now() - started < 3000, 'prompt blocked instead of returning immediately');
});

await step('stream delivers deltas then a single turn_done', async () => {
  const done = await stream.waitFor((e) => e.event === 'turn_done', { label: 'turn_done' });
  assert.equal(done.data.chatId, chatId);
  assert.ok(stream.of('message_delta').length >= 2, 'expected streamed chunks');
  assert.equal(stream.of('turn_done').length, 1, 'turn settled more than once');
});

await step('the final content wins over the streamed chunks', async () => {
  const done = stream.of('turn_done').at(-1);
  assert.equal(done.data.content, 'สวัสดีจาก mock agent (final)');
});

await step('transcript has exactly one user + one assistant message', async () => {
  const r = await req(host.base, 'GET', `/api/chats/${chatId}`);
  const roles = r.chat.messages.map((m) => m.role);
  assert.deepEqual(roles, ['user', 'assistant'], `got ${JSON.stringify(roles)}`);
  assert.equal(r.chat.messages[0].text, 'hello');
});

await step('configured model + thinking effort reach the agent session', async () => {
  const lines = fs
    .readFileSync(path.join(host.stateHome, 'config-calls.log'), 'utf8')
    .trim()
    .split('\n');
  assert.ok(
    lines.some((l) => l === 'model=mock-model-1'),
    `session/setModel missing: ${JSON.stringify(lines)}`,
  );
  assert.ok(
    lines.some((l) => l === 'thinking=max'),
    `session/setReasoningEffort missing: ${JSON.stringify(lines)}`,
  );
});

await step('tool calls stream as rows and reach completed', async () => {
  await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'use a tool please' });
  await stream.waitFor((e) => e.event === 'tool_call', { label: 'tool_call' });
  const upd = await stream.waitFor(
    (e) => e.event === 'tool_call_update' && e.data.tool?.status === 'completed',
    { label: 'tool_call_update completed' },
  );
  assert.equal(upd.data.tool.output, 'ok: 42 lines');
  await stream.waitFor((e) => e.event === 'turn_done' && stream.of('turn_done').length === 2, {
    label: 'second turn_done',
  });
});

await step('an Edit tool_call streams its summary, then completes with the full output', async () => {
  await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'edit a file' });
  await stream.waitFor(
    (e) => e.event === 'tool_call' && e.data.tool?.id === 'tc-edit-1',
    { label: 'edit tool_call' },
  );
  // MSP streams the edit summary as tool output text (no diff content
  // blocks on this wire) — the mid-turn row must already show it, and the
  // raw args JSON must never shadow it.
  const mid = await stream.waitFor(
    (e) =>
      e.event === 'tool_call_update' &&
      e.data.tool?.id === 'tc-edit-1' &&
      (e.data.tool?.output || '').includes('const a = 1'),
    { label: 'edit tool_call_update with output' },
  );
  assert.match(mid.data.tool.output, /src\/demo\.js/, 'diff path missing');
  assert.match(mid.data.tool.output, /- const a = 1/, 'removed line missing');
  assert.ok(
    !mid.data.tool.output.includes('"file_path"'),
    'raw args JSON must not shadow the diff',
  );
  const upd = await stream.waitFor(
    (e) =>
      e.event === 'tool_call_update' &&
      e.data.tool?.id === 'tc-edit-1' &&
      e.data.tool?.status === 'completed',
    { label: 'edit tool_call_update completed' },
  );
  assert.match(upd.data.tool.output, /src\/demo\.js/, 'completed output lost the path');
  assert.match(upd.data.tool.output, /\+ const a = 2/, 'completed output lost the added line');
  await stream.waitFor((e) => e.event === 'turn_done' && stream.of('turn_done').length === 3, {
    label: 'third turn_done',
  });
});

await step('permission request surfaces with the real detail and the answer reaches the agent', async () => {
  // Cards only mount outside yolo — new chats default to always now, so
  // pin this chat to ask mode first (later ask-steps reuse it).
  const m = await req(host.base, 'POST', `/api/chats/${chatId}/mode`, { mode: 'normal' });
  assert.equal(m.mode, 'normal');
  const p = await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'ask me first' });
  const ix = await stream.waitFor((e) => e.event === 'interaction', { label: 'interaction' });
  assert.equal(ix.data.toolName, 'Bash');
  // Turn-scoped like every other turn event — a window that missed
  // turn_started binds the turn from this frame (BUG-015).
  assert.equal(ix.data.turnId, p.turnId, 'interaction must carry the live turnId');
  // The card must show WHAT is being approved — the real CLI puts the detail
  // in a content text block and sends no rawInput (BUG-001).
  assert.match(ix.data.summary || '', /rm -rf \/tmp\/demo/, 'permission summary lost the command');
  assert.deepEqual(
    ix.data.options.map((o) => o.optionId),
    ['approve_once', 'approve_always', 'reject'],
  );
  // The card anchors to the row that asked: the payload's toolCallId must
  // match a tool row that streamed in the same turn (BUG-029).
  assert.equal(ix.data.toolCallId, 'tc-perm-1', 'interaction must carry toolCallId');
  const anchorRow = stream
    .of('tool_call')
    .find((e) => e.data.turnId === p.turnId && e.data.tool?.id === 'tc-perm-1');
  assert.ok(anchorRow, 'no tool row streamed under the card\u2019s toolCallId');

  // A client that was never watching this chat must still be able to answer.
  const listed = await req(host.base, 'GET', '/api/interactions');
  assert.equal(listed.interactions.length, 1);

  const res = await req(host.base, 'POST', `/api/interactions/${ix.data.id}`, {
    optionId: 'approve_once',
  });
  assert.equal(res.ok, true);
  // The resolved event must carry the picked optionId — the renderer marks
  // the chosen button from exactly this field (BUG-032).
  const resolved = await stream.waitFor(
    (e) => e.event === 'interaction_resolved' && e.data.id === ix.data.id,
    { label: 'interaction_resolved' },
  );
  assert.equal(resolved.data.optionId, 'approve_once');
  const done = await stream.waitFor(
    (e) => e.event === 'turn_done' && stream.of('turn_done').length === 4,
    { label: 'fourth turn_done' },
  );
  assert.match(done.data.content, /permission → approve_once/);
});

await step('AskUserQuestion tunnels as a subtyped ask card with the question body (BUG-026)', async () => {
  const r = await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'quiz me' });
  assert.equal(r.status, 202);
  const knownIx = new Set(stream.of('interaction').map((e) => e.data.id));
  const ix = await stream.waitFor(
    (e) => e.event === 'interaction' && !knownIx.has(e.data.id),
    { label: 'quiz interaction' },
  );
  assert.equal(ix.data.subtype, 'ask', `subtype missing: ${JSON.stringify(ix.data)}`);
  assert.match(ix.data.body || '', /ควรเก็บ cache ไว้ที่ไหน?/, 'question text lost from the body');
  // MSP questions carry labels, not ids — the card posts the label back.
  assert.deepEqual(
    ix.data.options.map((o) => o.optionId),
    ['Redis', 'SQLite in-memory', 'Skip'],
  );
  // The labels (not the ids) are what the user reads — they must survive.
  assert.deepEqual(ix.data.options.map((o) => o.name), ['Redis', 'SQLite in-memory', 'Skip']);

  const res = await req(host.base, 'POST', `/api/interactions/${ix.data.id}`, {
    optionId: 'SQLite in-memory',
  });
  assert.equal(res.ok, true);
  const done = await stream.waitFor(
    (e) => e.event === 'turn_done' && e.data.turnId === r.turnId,
    { label: 'quiz turn_done' },
  );
  assert.match(done.data.content, /ask → SQLite in-memory/, 'the picked answer must reach the agent');
});

await step('a multi-question prompt auto-cancels with a visible trace instead of stranding the turn', async () => {
  // MSP has no plan-review channel (the ACP ExitPlanMode card has no
  // counterpart); what the card UI cannot answer — multi-question,
  // multi-select, free-text — the client cancels with a trace, and the
  // turn must still settle. A hang here fails the wait below.
  const r = await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'quizmulti run' });
  assert.equal(r.status, 202);
  const knownIx = new Set(stream.of('interaction').map((e) => e.data.id));
  const done = await stream.waitFor(
    (e) => e.event === 'turn_done' && e.data.turnId === r.turnId,
    { label: 'quizmulti turn_done' },
  );
  assert.match(done.data.content, /Continuing without an answer/, 'turn must settle after auto-cancel');
  const freshCards = stream.of('interaction').filter((e) => !knownIx.has(e.data.id));
  assert.equal(freshCards.length, 0, 'no card can answer a multi-question prompt');
  const trace = stream.of('agent_update_other').find(
    (e) => e.data.update?.sessionUpdate === 'msp:user_input_unsupported',
  );
  assert.ok(trace, 'the auto-cancel left no visible trace');
});

await step('a long streamed answer batches deltas but ends in exactly one turn_done', async () => {
  const deltasBefore = stream.of('message_delta').length;
  await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'give me a long answer' });
  const done = await stream.waitFor(
    (e) => e.event === 'turn_done' && stream.of('turn_done').length === 7,
    { label: 'long-answer turn_done' },
  );
  // The mock fired 120 chunks in one burst; batching must collapse them into
  // far fewer SSE frames without losing a single character.
  const deltas = stream.of('message_delta').slice(deltasBefore);
  assert.ok(
    deltas.length >= 1 && deltas.length < 120,
    `expected batched deltas, got ${deltas.length} frames for 120 chunks`,
  );
  const assembled = Array.from({ length: 120 }, (_, i) => `chunk-${String(i).padStart(3, '0')} `).join('');
  assert.equal(deltas.at(-1).data.text, assembled, 'running total lost characters to batching');
  assert.equal(done.data.content, `${assembled}(final)`, 'final content must survive intact');
});

await step('history-incompatible prompt error rotates the agent and retries once', async () => {
  const donesBefore = stream.of('turn_done').length;
  const errsBefore = stream.of('turn_error').length;
  const r = await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'histfail please' });
  assert.equal(r.status, 202, `prompt must still return 202: ${JSON.stringify(r)}`);
  // Turn 1 settles as rotated; the retry on a fresh agent settles again —
  // exactly two new terminal events, the second carrying the real answer.
  await stream.waitFor(
    (e) => e.event === 'turn_done' && stream.of('turn_done').length === donesBefore + 2,
    { label: 'rotated retry turn_done' },
  );
  const settled = stream.of('turn_done').slice(donesBefore);
  assert.equal(settled.length, 2, 'turn 1 (rotated) + turn 2 (retry) must each settle once');
  assert.notEqual(settled[0].data.turnId, settled[1].data.turnId);
  assert.equal(settled[0].data.reason, 'rotated');
  assert.match(settled[1].data.content || '', /สวัสดีจาก mock agent \(final\)/, 'retry must land the answer');
  assert.equal(stream.of('turn_error').length, errsBefore, 'rotation must not surface as turn_error');

  const chat = await req(host.base, 'GET', `/api/chats/${chatId}`);
  assert.equal(
    chat.chat.messages.filter((m) => m.role === 'user' && m.text.includes('histfail')).length,
    1,
    'the retry must not duplicate the stored user message',
  );
  const notice = chat.chat.messages.find((m) => m.role === 'notice' && m.text.includes('เปิดเซสชันใหม่'));
  assert.ok(notice, 'the transcript should carry the rotation notice');

  // The dead agent-session id must be gone — replaced by the fresh agent's.
  const raw = JSON.parse(
    fs.readFileSync(path.join(host.stateHome, 'muse-desktop/chats.json'), 'utf8'),
  );
  const stored = raw.chats.find((c) => c.id === chatId);
  assert.ok(String(stored.mspSessionId || '').startsWith('mock-session-'), 'rotation did not persist a fresh mspSessionId');
});

await step('mid-turn GET /turn exposes the open turn, then 404s after settle', async () => {
  const knownIx = new Set(stream.of('interaction').map((e) => e.data.id));
  const donesBefore = stream.of('turn_done').length;
  await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'ask me first' });
  const ix = await stream.waitFor(
    (e) => e.event === 'interaction' && !knownIx.has(e.data.id),
    { label: 'fresh interaction' },
  );
  const mid = await req(host.base, 'GET', `/api/chats/${chatId}/turn`);
  assert.equal(mid.status, 200, `mid-turn snapshot missing: ${JSON.stringify(mid)}`);
  assert.ok(mid.turn.turnId, 'turnId missing mid-turn');
  assert.equal(typeof mid.turn.partial, 'string');
  assert.ok(Array.isArray(mid.turn.tools));
  assert.equal(mid.turn.pendingInteractions.length, 1, 'mounted permission card must be in the snapshot');

  const res = await req(host.base, 'POST', `/api/interactions/${ix.data.id}`, { optionId: 'approve_once' });
  assert.equal(res.ok, true);
  await stream.waitFor(
    (e) => e.event === 'turn_done' && stream.of('turn_done').length === donesBefore + 1,
    { label: 'ask turn_done' },
  );
  const after = await req(host.base, 'GET', `/api/chats/${chatId}/turn`);
  assert.equal(after.status, 404, 'a settled turn must report no live turn');
});

await step('a stale interaction id 404s after its turn settled (BUG-025)', async () => {
  // The renderer's dead-card fix relies on exactly this contract: a resolve
  // POST for an id the server no longer holds (settle/auto-reject raced the
  // click) fails loudly — {ok:false} + 404 — so the card can re-arm instead
  // of sitting disabled forever. The DOM re-enable itself needs a browser;
  // the wire half is what the harness can prove.
  const knownIx = new Set(stream.of('interaction').map((e) => e.data.id));
  const r = await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'ask me first' });
  const ix = await stream.waitFor(
    (e) => e.event === 'interaction' && !knownIx.has(e.data.id),
    { label: 'stale-race interaction' },
  );
  const c = await req(host.base, 'POST', `/api/chats/${chatId}/cancel`);
  assert.equal(c.ok, true);
  await stream.waitFor((e) => e.event === 'turn_done' && e.data.turnId === r.turnId, {
    label: 'stale-race turn cancelled',
  });
  const stale = await req(host.base, 'POST', `/api/interactions/${ix.data.id}`, {
    optionId: 'approve_once',
  });
  assert.equal(stale.status, 404, `stale id must 404, got ${stale.status}`);
  assert.equal(stale.ok, false);
});

await step('a rotated session prepends a recovery recap to the retry wire text, once', async () => {
  const prompts = () =>
    fs
      .readFileSync(path.join(host.stateHome, 'prompts.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
  const histfail = prompts().filter((p) => p.includes('histfail'));
  assert.equal(histfail.length, 2, 'expected the original attempt + the rotated retry');
  assert.ok(histfail[0].startsWith('histfail'), 'the first attempt goes out bare');
  assert.ok(histfail[1].startsWith('[SESSION RECOVERY'), 'retry must open with the recap preamble');
  assert.ok(histfail[1].includes('history-incompatible'), 'rotation reason missing');
  assert.ok(histfail[1].includes('chunk-000'), 'recap should cite the previous assistant output');
  assert.ok(histfail[1].endsWith('histfail please'), 'user text must follow the preamble');

  // …and the preamble fires exactly once: the next prompt goes out bare.
  const donesBefore = stream.of('turn_done').length;
  await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'hello again' });
  await stream.waitFor(
    (e) => e.event === 'turn_done' && stream.of('turn_done').length === donesBefore + 1,
    { label: 'post-rotation turn_done' },
  );
  assert.equal(prompts().at(-1), 'hello again', 'the preamble must fire once only');
});

await step('a second prompt while one is in flight is rejected with 409', async () => {
  await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'slow one' });
  const second = await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'racer' });
  assert.equal(second.status, 409);
  assert.equal(second.code, 'TURN_IN_FLIGHT');
});

await step('cancel settles the in-flight turn', async () => {
  const r = await req(host.base, 'POST', `/api/chats/${chatId}/cancel`);
  assert.equal(r.ok, true);
  const done = await stream.waitFor(
    (e) => e.event === 'turn_done' && e.data.reason === 'cancelled',
    { label: 'cancelled turn_done' },
  );
  assert.equal(done.data.reason, 'cancelled');
  // The settled partial survives WITH its reason — the renderer paints the
  // interrupted marker from exactly this meta after the reload (BUG-017).
  const chat = await req(host.base, 'GET', `/api/chats/${chatId}`);
  const settled = chat.chat.messages.find(
    (m) => m.role === 'assistant' && m.meta?.turnId === r.turnId,
  );
  assert.ok(settled, 'a cancelled turn must persist its partial text');
  assert.equal(settled.meta.reason, 'cancelled');
});

await step('the prompt queue contract: 409 while busy, in-order sends after each settle (BUG-051)', async () => {
  // The queue lives in the renderer; what the server must guarantee is that
  // mid-turn POSTs 409 without side effects and that one POST after each
  // settle starts exactly one turn with exactly one persisted user message.
  // 'slow' keeps each turn open long enough for the racing POSTs to land.
  const r1 = await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'slow queue-1' });
  assert.equal(r1.status, 202);
  const busy1 = await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'queue-2' });
  assert.equal(busy1.status, 409, 'enqueue point: mid-turn POST is rejected');
  const busy2 = await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'queue-3' });
  assert.equal(busy2.status, 409);
  await stream.waitFor((e) => e.event === 'turn_done' && e.data.turnId === r1.turnId, {
    label: 'queue-1 turn_done',
  });

  // The renderer's queue now dispatches queue-2 (front of FIFO).
  const r2 = await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'slow queue-2' });
  assert.equal(r2.status, 202, 'post-settle dispatch must be accepted');
  const busy3 = await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'queue-3' });
  assert.equal(busy3.status, 409, 'queue-3 waits for queue-2 — order preserved');
  await stream.waitFor((e) => e.event === 'turn_done' && e.data.turnId === r2.turnId, {
    label: 'queue-2 turn_done',
  });

  const r3 = await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'queue-3' });
  assert.equal(r3.status, 202);
  await stream.waitFor((e) => e.event === 'turn_done' && e.data.turnId === r3.turnId, {
    label: 'queue-3 turn_done',
  });

  const chat = await req(host.base, 'GET', `/api/chats/${chatId}`);
  const tail = chat.chat.messages
    .filter((m) => m.role === 'user')
    .slice(-3)
    .map((m) => m.text);
  assert.deepEqual(tail, ['slow queue-1', 'slow queue-2', 'queue-3'], 'one user message each, in order');
  // Each dispatched prompt produced exactly one settled assistant turn.
  for (const r of [r1, r2, r3]) {
    const settled = chat.chat.messages.filter(
      (m) => m.role === 'assistant' && m.meta?.turnId === r.turnId,
    );
    assert.equal(settled.length, 1, `turn ${r.turnId} settled exactly once`);
  }
});

await step('an errored turn carries the message over SSE and persists a notice (BUG-017)', async () => {
  const r = await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'boom' });
  assert.equal(r.status, 202);
  const err = await stream.waitFor(
    (e) => e.event === 'turn_error' && e.data.turnId === r.turnId,
    { label: 'turn_error' },
  );
  assert.match(err.data.error || '', /exploded/, 'turn_error must carry the agent error');
  const chat = await req(host.base, 'GET', `/api/chats/${chatId}`);
  const notice = chat.chat.messages.find(
    (m) => m.role === 'notice' && m.meta?.turnId === r.turnId && /ไม่สำเร็จ/.test(m.text),
  );
  assert.ok(notice, 'persisted failure notice missing');
});

await step('a stream that connects mid-turn can bind the turn from scoped events (BUG-015)', async () => {
  const r = await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'slow one' });
  assert.equal(r.status, 202);
  // This client connects AFTER turn_started went out — it never sees the
  // opener and must reconstruct the turn from the scoped events alone
  // (the reload / second-window case the renderer handles via bindTurnId).
  const late = openStream(host.base);
  try {
    const delta = await late.waitFor(
      (e) => e.event === 'message_delta' && e.data.chatId === chatId,
      { label: 'late-stream message_delta' },
    );
    assert.equal(delta.data.turnId, r.turnId, 'scoped delta must carry the live turnId');
    const snap = await req(host.base, 'GET', `/api/chats/${chatId}/turn`);
    assert.equal(snap.turn?.turnId, r.turnId, 'turn snapshot must agree with the stream');
  } finally {
    late.close();
  }
  // Stop must work for a bound-but-never-saw-turn_started window too.
  const c = await req(host.base, 'POST', `/api/chats/${chatId}/cancel`);
  assert.equal(c.ok, true);
  await stream.waitFor((e) => e.event === 'turn_done' && e.data.turnId === r.turnId, {
    label: 'late-bind turn cancelled',
  });
});

await step('a background chat settling mid-stream stays scoped to its own chatId (BUG-016)', async () => {
  // Chat A streams slowly while chat B runs a quick turn to completion
  // underneath. The wire must keep both turns correctly chat-scoped the whole
  // time — the renderer keys its live DOM off exactly these chatIds, and a
  // background settle must not disturb the active stream.
  const other = await req(host.base, 'POST', '/api/chats', { title: 'background', cwd: os.tmpdir() });
  const bgId = other.chat.id;
  const slow = await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'slow one' });
  assert.equal(slow.status, 202);
  const activeDeltas = () =>
    stream.of('message_delta').filter((e) => e.data.chatId === chatId && e.data.turnId === slow.turnId);
  await stream.waitFor(
    (e) => e.event === 'message_delta' && e.data.chatId === chatId && e.data.turnId === slow.turnId,
    { label: 'active delta' },
  );
  const bg = await req(host.base, 'POST', `/api/chats/${bgId}/prompt`, { text: 'hello' });
  const bgDone = await stream.waitFor((e) => e.event === 'turn_done' && e.data.chatId === bgId, {
    label: 'background turn_done',
  });
  assert.equal(bgDone.data.turnId, bg.turnId);
  // The active chat's stream must keep flowing after the background settle.
  const seen = activeDeltas().length;
  await stream.waitFor(() => activeDeltas().length > seen, { label: 'active stream continues' });
  const c = await req(host.base, 'POST', `/api/chats/${chatId}/cancel`);
  assert.equal(c.ok, true);
  await stream.waitFor((e) => e.event === 'turn_done' && e.data.turnId === slow.turnId, {
    label: 'active turn cancelled',
  });
});

await step('text → tool_call → text keeps its order on the wire (BUG-018)', async () => {
  // The renderer pins its live DOM to the tv shape (unit-tested); this proves
  // the wire actually delivers the interleaving the ordering rule depends on.
  const r = await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'mixorder please' });
  assert.equal(r.status, 202);
  await stream.waitFor((e) => e.event === 'turn_done' && e.data.turnId === r.turnId, {
    label: 'mixorder turn_done',
  });
  const seq = stream.events
    .filter(
      (e) =>
        e.data.turnId === r.turnId &&
        ['message_delta', 'tool_call', 'tool_call_update'].includes(e.event),
    )
    .map((e) => e.event);
  const firstDelta = seq.indexOf('message_delta');
  const toolAt = seq.indexOf('tool_call');
  assert.ok(firstDelta >= 0 && toolAt > firstDelta, `a delta must precede the tool: ${seq}`);
  assert.ok(seq.lastIndexOf('message_delta') > toolAt, `a delta must follow the tool: ${seq}`);
});

await step('a running turn hydrates from GET /turn: partial, startedAt, tools (BUG-020)', async () => {
  // The renderer's reload path seeds its live view from exactly this payload —
  // assert the snapshot carries everything the repaint needs mid-turn.
  const r = await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'slow tool' });
  assert.equal(r.status, 202);
  await stream.waitFor((e) => e.event === 'tool_call' && e.data.turnId === r.turnId, {
    label: 'hydrate tool_call',
  });
  await stream.waitFor((e) => e.event === 'message_delta' && e.data.turnId === r.turnId, {
    label: 'hydrate delta',
  });
  const snap = await req(host.base, 'GET', `/api/chats/${chatId}/turn`);
  assert.equal(snap.status, 200);
  assert.equal(snap.turn.turnId, r.turnId);
  assert.ok(snap.turn.startedAt > 0, 'startedAt missing — the elapsed timer cannot render');
  assert.ok(snap.turn.partial.length > 0, 'streamed-so-far text missing from the snapshot');
  assert.ok(
    snap.turn.tools.some((t) => t.id === 'tc-1'),
    'the open tool row must be in the snapshot',
  );
  const c = await req(host.base, 'POST', `/api/chats/${chatId}/cancel`);
  assert.equal(c.ok, true);
  await stream.waitFor((e) => e.event === 'turn_done' && e.data.turnId === r.turnId, {
    label: 'hydrate turn cancelled',
  });
});

await step('no pending approvals are stranded after the turns end', async () => {
  const r = await req(host.base, 'GET', '/api/interactions');
  assert.equal(r.interactions.length, 0);
});

await step('watchdog leaves a silent turn alone while the turn is in flight', async () => {
  const r = await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'hang in there' });
  // Without a live turn this whole step would pass vacuously — prove it opened.
  assert.equal(r.status, 202, `hang prompt must open a turn: ${JSON.stringify(r)}`);
  const dones = stream.of('turn_done').length;
  const errs = stream.of('turn_error').length;
  // Well past the test-only no-activity threshold (1.5s) and several ticks.
  await sleep(4000);
  assert.equal(stream.of('turn_error').length, errs, 'watchdog settled a live in-flight turn');
  assert.equal(stream.of('turn_done').length, dones, 'a silent but live turn must stay open');
  const c = await req(host.base, 'POST', `/api/chats/${chatId}/cancel`);
  assert.equal(c.ok, true);
  // Match THIS turn — an older cancelled turn_done must not satisfy the wait.
  await stream.waitFor((e) => e.event === 'turn_done' && e.data.turnId === r.turnId, {
    label: 'hang turn cancelled',
  });
});

await step('mode change is applied and echoed', async () => {
  const r = await req(host.base, 'POST', `/api/chats/${chatId}/mode`, { mode: 'always' });
  assert.equal(r.mode, 'always');
  // the mock echoes the MSP approval mode id back over session/approvalModeChanged
  const echo = await stream.waitFor(
    (e) => e.event === 'agent_mode_echo' && e.data.modeId === 'allowAll',
    { label: 'agent_mode_echo allowAll' },
  );
  assert.equal(echo.data.modeId, 'allowAll');
  const p = await req(host.base, 'POST', `/api/chats/${chatId}/mode`, { mode: 'plan' });
  assert.equal(p.mode, 'plan');
  const planEcho = await stream.waitFor(
    (e) => e.event === 'agent_mode_echo' && e.data.modeId === 'denyUnmatched',
    { label: 'agent_mode_echo denyUnmatched' },
  );
  assert.equal(planEcho.data.modeId, 'denyUnmatched');
  const back = await req(host.base, 'POST', `/api/chats/${chatId}/mode`, { mode: 'normal' });
  assert.equal(back.mode, 'normal');
});

await step('agent session id is persisted for resume', async () => {
  const raw = JSON.parse(
    fs.readFileSync(path.join(host.stateHome, 'muse-desktop/chats.json'), 'utf8'),
  );
  const chat = raw.chats.find((c) => c.id === chatId);
  assert.ok(String(chat.mspSessionId || '').startsWith('mock-session-'), 'mspSessionId not stored');
});

await step('SSE replay after a reconnect loses nothing', async () => {
  const lastId = 3;
  const replay = await new Promise((resolve, reject) => {
    const url = new URL(`/api/events?lastEventId=${lastId}`, host.base);
    const seen = [];
    const r = http.get(url, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const id = /^id: (\d+)$/m.exec(frame)?.[1];
          if (id) seen.push(Number(id));
        }
        if (seen.length > 5) {
          r.destroy();
          resolve(seen);
        }
      });
    });
    r.on('error', () => resolve(seen));
    setTimeout(() => {
      r.destroy();
      resolve(seen);
    }, 3000).unref?.();
  });
  const afterHello = replay.filter((id) => id > lastId);
  assert.ok(afterHello.length > 0, 'nothing replayed');
  assert.deepEqual(afterHello, [...afterHello].sort((a, b) => a - b), 'replay out of order');
});

// ---------------------------------------------------------------- groups

await step('groups: create, list and select over the wire', async () => {
  const before = await req(host.base, 'GET', '/api/groups');
  assert.equal(before.groups.length, 1, 'a fresh host starts with exactly one group');

  const created = await req(host.base, 'POST', '/api/groups', { name: 'งานที่สอง' });
  assert.equal(created.status, 201);
  assert.equal(created.group.name, 'งานที่สอง');
  assert.equal(created.groups.length, 2);

  const selected = await req(host.base, 'POST', `/api/groups/${created.group.id}/select`);
  assert.equal(selected.activeGroupId, created.group.id);
  await stream.waitFor((e) => e.event === 'group_created', { label: 'group_created' });
});

await step('groups: a new chat lands in the group it was asked for', async () => {
  const groups = (await req(host.base, 'GET', '/api/groups')).groups;
  const second = groups.find((g) => g.name === 'งานที่สอง');
  const made = await req(host.base, 'POST', '/api/chats', {
    title: 'in second',
    groupId: second.id,
  });
  assert.equal(made.chat.groupId, second.id);

  const filtered = await req(host.base, 'GET', `/api/chats?groupId=${second.id}`);
  assert.equal(filtered.chats.length, 1);
  assert.equal(filtered.chats[0].id, made.chat.id);
});

await step('groups: moving a chat updates both sides', async () => {
  const groups = (await req(host.base, 'GET', '/api/groups')).groups;
  const [first, second] = [groups[0], groups.find((g) => g.name === 'งานที่สอง')];
  const chat = (await req(host.base, `GET`, `/api/chats?groupId=${second.id}`)).chats[0];

  const moved = await req(host.base, 'POST', `/api/chats/${chat.id}/move`, { groupId: first.id });
  assert.equal(moved.chat.groupId, first.id);
  await stream.waitFor((e) => e.event === 'chat_moved', { label: 'chat_moved' });

  const after = (await req(host.base, 'GET', '/api/groups')).groups;
  assert.equal(after.find((g) => g.id === second.id).chatCount, 0);
});

await step('groups: reorder persists and is broadcast', async () => {
  const groups = (await req(host.base, 'GET', '/api/groups')).groups;
  const reversed = groups.map((g) => g.id).reverse();
  const res = await req(host.base, 'POST', '/api/groups/reorder', { order: reversed });
  assert.deepEqual(res.groups.map((g) => g.id), reversed, 'server did not apply the new order');
  assert.deepEqual(res.groups.map((g) => g.order), [0, 1]);
  await stream.waitFor((e) => e.event === 'groups_reordered', { label: 'groups_reordered' });

  const onDisk = JSON.parse(
    fs.readFileSync(path.join(host.stateHome, 'muse-desktop/chats.json'), 'utf8'),
  );
  assert.deepEqual(
    [...onDisk.groups].sort((a, b) => a.order - b.order).map((g) => g.id),
    reversed,
    'reorder must survive a restart',
  );
});

await step('groups: deleting one takes its chats with it', async () => {
  const groups = (await req(host.base, 'GET', '/api/groups')).groups;
  const victim = groups.find((g) => g.name === 'งานที่สอง');
  await req(host.base, 'POST', '/api/chats', { title: 'doomed', groupId: victim.id });

  const res = await req(host.base, 'DELETE', `/api/groups/${victim.id}`);
  assert.equal(res.ok, true);
  assert.equal(res.removedChatIds.length, 1);
  assert.equal(res.groups.length, 1);
  assert.ok(!res.chats.some((c) => c.groupId === victim.id), 'orphaned chats left behind');
  await stream.waitFor((e) => e.event === 'group_removed', { label: 'group_removed' });
});

await step('groups: the last group is refused with 409', async () => {
  const groups = (await req(host.base, 'GET', '/api/groups')).groups;
  assert.equal(groups.length, 1);
  const res = await req(host.base, 'DELETE', `/api/groups/${groups[0].id}`);
  assert.equal(res.status, 409);
  assert.equal(res.code, 'LAST_GROUP');
  assert.equal((await req(host.base, 'GET', '/api/groups')).groups.length, 1);
});

await step('groups: rename round-trips', async () => {
  const groups = (await req(host.base, 'GET', '/api/groups')).groups;
  const res = await req(host.base, 'PATCH', `/api/groups/${groups[0].id}`, { name: 'เปลี่ยนชื่อแล้ว' });
  assert.equal(res.group.name, 'เปลี่ยนชื่อแล้ว');
  await stream.waitFor((e) => e.event === 'group_updated', { label: 'group_updated' });
});

await step('subagents: a kids turn streams subagent + workflow frames', async () => {
  const before = stream.of('turn_done').length;
  await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'spawn kids please' });
  const first = await stream.waitFor(
    (e) => e.event === 'subagent' && e.data.subagent?.itemId === 'sub-1',
    { label: 'subagent sub-1' },
  );
  assert.equal(first.data.chatId, chatId);
  await stream.waitFor((e) => e.event === 'subagent_delta' && e.data.itemId === 'sub-1', {
    label: 'subagent_delta',
  });
  await stream.waitFor(
    (e) => e.event === 'subagent' && e.data.subagent?.itemId === 'wf-1',
    { label: 'subagent wf-1' },
  );
  await stream.waitFor((e) => e.event === 'turn_done' && stream.of('turn_done').length === before + 1, {
    label: 'kids turn_done',
  });
});

await step('subagents: the child stream never pollutes the parent transcript', async () => {
  const r = await req(host.base, 'GET', `/api/chats/${chatId}`);
  const lastAssistant = [...r.chat.messages].reverse().find((m) => m.role === 'assistant');
  assert.equal(lastAssistant.text, 'Delegated to a child. ');
});

await step('subagents: the registry lists both children with drill keys', async () => {
  const r = await req(host.base, 'GET', `/api/chats/${chatId}/subagents`);
  assert.equal(r.status, 200);
  const ids = r.subagents.map((s) => s.itemId).sort();
  assert.deepEqual(ids, ['sub-1', 'wf-1']);
  const sub = r.subagents.find((s) => s.itemId === 'sub-1');
  assert.equal(sub.status, 'completed');
  assert.equal(sub.childSessionId, 'mock-child-1');
  assert.equal(sub.result.summary, 'Redis wins');
  const wf = r.subagents.find((s) => s.itemId === 'wf-1');
  assert.equal(wf.children.length, 2);
  assert.equal(wf.children[1].childId, 'build');
});

await step('subagents: drill-down reads the child session with its nested child', async () => {
  const r = await req(host.base, 'GET', `/api/chats/${chatId}/subagents/sub-1`);
  assert.equal(r.status, 200);
  assert.equal(r.mode, 'inline');
  assert.ok(r.items.some((it) => it.itemId === 'c-msg-1' && it.text.includes('Redis wins')));
  const nested = r.items.find((it) => it.itemId === 'c-sub-1');
  assert.ok(nested, 'nested subagent missing from child history');
  assert.equal(nested.childSessionId, 'mock-child-1-1');
  const deeper = await req(host.base, 'GET', `/api/chats/${chatId}/child-session/mock-child-1-1`);
  assert.equal(deeper.status, 200);
  assert.ok(deeper.items.some((it) => it.text && it.text.includes('grandchild report')));
});

await step('subagents: unknown child and unknown chat fail clean', async () => {
  const r = await req(host.base, 'GET', `/api/chats/${chatId}/subagents/nope`);
  assert.equal(r.status, 404);
  const c = await req(host.base, 'GET', '/api/chats/nope/subagents');
  assert.equal(c.status, 404);
});

await step('mcp: the catalog lists fixture servers as unknown, with no secrets', async () => {
  const r = await req(host.base, 'GET', '/api/mcp/servers');
  assert.equal(r.status, 200);
  assert.deepEqual(r.servers.map((s) => s.name), ['github', 'mcpfix']);
  assert.ok(r.servers.every((s) => s.status === 'unknown'));
  assert.ok(!JSON.stringify(r).includes('fixture-mcp-stdio'), 'entry args leaked to the UI');
});

await step('mcp: probe reports connected + failed and broadcasts', async () => {
  const r = await req(host.base, 'POST', '/api/mcp/probe', {});
  assert.equal(r.status, 200);
  const byName = Object.fromEntries(r.servers.map((s) => [s.name, s]));
  assert.equal(byName.mcpfix.status, 'connected');
  assert.equal(byName.mcpfix.tools, 2);
  assert.equal(byName.github.status, 'failed');
  assert.ok(byName.github.probeError);
  await stream.waitFor((e) => e.event === 'mcp_servers', { label: 'mcp_servers' });
});

await step('mcp: toggle off writes enabled=false and rotates the idle agent', async () => {
  const r = await req(host.base, 'POST', '/api/mcp/servers/mcpfix/enabled', { enabled: false });
  assert.equal(r.status, 200);
  assert.equal(r.enabled, false);
  assert.ok(r.released.includes(chatId), `idle agent not rotated: ${JSON.stringify(r)}`);
  const doc = JSON.parse(fs.readFileSync(host.settingsFile, 'utf8'));
  assert.equal(doc.mcpServers.mcpfix.enabled, false);
  const snap = await req(host.base, 'GET', '/api/mcp/servers');
  assert.equal(snap.servers.find((s) => s.name === 'mcpfix').status, 'disabled');
});

await step('mcp: toggle on removes the flag again', async () => {
  const r = await req(host.base, 'POST', '/api/mcp/servers/mcpfix/enabled', { enabled: true });
  assert.equal(r.status, 200);
  assert.equal(r.enabled, true);
  const doc = JSON.parse(fs.readFileSync(host.settingsFile, 'utf8'));
  assert.ok(!('enabled' in doc.mcpServers.mcpfix));
});

await step('warming: the first turn on a fresh agent says so, later turns do not', async () => {
  // Lives down here with the other feature steps: the early steps scan the
  // global stream history assuming only chatId has turned.
  const r = await req(host.base, 'POST', '/api/chats', { title: 'warmverb', cwd: os.tmpdir() });
  const wid = r.chat.id;
  const p1 = await req(host.base, 'POST', `/api/chats/${wid}/prompt`, { text: 'hello' });
  const started1 = await stream.waitFor(
    (e) => e.event === 'turn_started' && e.data.chatId === wid && e.data.message?.text === 'hello',
    { label: 'turn_started 1' },
  );
  assert.equal(started1.data.warming, true, 'first turn must carry warming');
  await stream.waitFor((e) => e.event === 'turn_done' && e.data.turnId === p1.turnId, {
    label: 'turn_done 1',
  });
  const p2 = await req(host.base, 'POST', `/api/chats/${wid}/prompt`, { text: 'hello again' });
  const started2 = await stream.waitFor(
    (e) => e.event === 'turn_started' && e.data.chatId === wid && e.data.message?.text === 'hello again',
    { label: 'turn_started 2' },
  );
  assert.equal(started2.data.warming, undefined, 'second turn must not carry warming');
  await stream.waitFor((e) => e.event === 'turn_done' && e.data.turnId === p2.turnId, {
    label: 'turn_done 2',
  });
});

await step('usage: quota turn broadcasts globally and the endpoint serves it', async () => {
  const before = stream.of('turn_done').length;
  await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'show quota now' });
  const ev = await stream.waitFor((e) => e.event === 'usage' && e.data.usage?.tier, {
    label: 'usage',
  });
  assert.equal(ev.data.chatId, null, 'subscription usage is account-level');
  assert.equal(ev.data.usage.window.usedPercent, 12);
  assert.equal(ev.data.usage.weekly.usedPercent, 34);
  await stream.waitFor((e) => e.event === 'turn_done' && stream.of('turn_done').length === before + 1, {
    label: 'quota turn_done',
  });
  const r = await req(host.base, 'GET', '/api/usage');
  assert.equal(r.status, 200);
  assert.equal(r.usage.tier, 'mock-pro');
  assert.equal(r.usage.window.windowDurationMins, 300);
});

await step('ctx: usage pair broadcasts and the endpoint serves the snapshot', async () => {
  const before = stream.of('turn_done').length;
  await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'show ctxusage now' });
  const ev = await stream.waitFor((e) => e.event === 'ctx' && e.data.ctx?.usedTokens, {
    label: 'ctx',
  });
  assert.equal(ev.data.chatId, chatId);
  assert.equal(ev.data.ctx.windowTokens, 1000000);
  assert.equal(ev.data.ctx.pressure, 'normal');
  await stream.waitFor((e) => e.event === 'turn_done' && stream.of('turn_done').length === before + 1, {
    label: 'ctxusage turn_done',
  });
  const r = await req(host.base, 'GET', `/api/chats/${chatId}/ctx`);
  assert.equal(r.status, 200);
  assert.equal(r.ctx.usedTokens, 123456);
  assert.equal(r.tokens.totalTokens, 123456);
  const c = await req(host.base, 'GET', '/api/chats/nope/ctx');
  assert.equal(c.status, 404);
});

await step('goal: a goal turn broadcasts the block and the endpoint serves it', async () => {
  const before = stream.of('turn_done').length;
  await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'set a goal now' });
  const ev = await stream.waitFor((e) => e.event === 'goal' && e.data.goal?.objective, {
    label: 'goal',
  });
  assert.equal(ev.data.chatId, chatId);
  assert.equal(ev.data.goal.percentComplete, 45);
  assert.equal(ev.data.goal.status, 'running');
  await stream.waitFor((e) => e.event === 'turn_done' && stream.of('turn_done').length === before + 1, {
    label: 'goal turn_done',
  });
  const r = await req(host.base, 'GET', `/api/chats/${chatId}/goal`);
  assert.equal(r.status, 200);
  assert.equal(r.goal.objective, 'Ship the tasks panel');
  assert.equal(r.goal.currentWork, 'wiring the goal chip');
});

await step('goal: an explicit null clears, and unknown chats 404', async () => {
  const before = stream.of('turn_done').length;
  await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'clear the ungoal' });
  await stream.waitFor((e) => e.event === 'goal' && e.data.goal === null, { label: 'goal cleared' });
  await stream.waitFor((e) => e.event === 'turn_done' && stream.of('turn_done').length === before + 1, {
    label: 'ungoal turn_done',
  });
  const r = await req(host.base, 'GET', `/api/chats/${chatId}/goal`);
  assert.equal(r.goal, null);
  const c = await req(host.base, 'GET', '/api/chats/nope/goal');
  assert.equal(c.status, 404);
});

await step('mcp: an MCP tool call marks the server used', async () => {
  const before = stream.of('turn_done').length;
  await req(host.base, 'POST', `/api/chats/${chatId}/prompt`, { text: 'run mcptool now' });
  await stream.waitFor((e) => e.event === 'turn_done' && stream.of('turn_done').length === before + 1, {
    label: 'mcptool turn_done',
  });
  const r = await req(host.base, 'GET', '/api/mcp/servers');
  const github = r.servers.find((s) => s.name === 'github');
  assert.ok(github.lastUsedAt && github.lastUsedAt > 0, 'github usage not learned');
});

stream.close();
await req(host.base, 'POST', '/api/host/shutdown', { killAgents: true }).catch(() => {});
await sleep(400);
try { host.proc.kill('SIGKILL'); } catch { /* already gone */ }

// ------------------------------------------------------------ auth gate

const wall = await startHost({ authWall: true });
const wallStream = openStream(wall.base);
await sleep(300);

await step('an unauthenticated agent raises auth_required with a terminal command', async () => {
  const created = await req(wall.base, 'POST', '/api/chats', { cwd: os.tmpdir() });
  const id = created.chat.id;
  const started = req(wall.base, 'POST', `/api/chats/${id}/prompt`, { text: 'hi' });
  const ev = await wallStream.waitFor((e) => e.event === 'auth_required', { label: 'auth_required' });
  assert.ok(ev.data.command?.command, 'no login command surfaced');
  const r = await started;
  assert.notEqual(r.status, 202, 'prompt should not claim success without auth');
});

wallStream.close();
await req(wall.base, 'POST', '/api/host/shutdown', { killAgents: true }).catch(() => {});
await sleep(300);
try { wall.proc.kill('SIGKILL'); } catch { /* already gone */ }

// ------------------------------------------------------------ agent_error

// A binary path that EXISTS but is not executable: resolveMuseBin() accepts
// it (it only checks existence), and spawn then fails with EACCES — the
// spawn-failure path a missing/broken install takes in production.
const badBinPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'muse-badbin-')), 'muse');
fs.writeFileSync(badBinPath, '#!/bin/sh\nexit 1\n', { mode: 0o644 });
const badBin = await startHost({ museBin: badBinPath });
const badStream = openStream(badBin.base);
await sleep(300);

await step('a spawn failure surfaces as agent_error over SSE (BUG-023)', async () => {
  const created = await req(badBin.base, 'POST', '/api/chats', { cwd: os.tmpdir() });
  // Do not await the prompt's HTTP response: the handshake with the dead
  // binary hangs until its own timeout — the agent_error frame (which a
  // second window / post-reload view relies on) is the contract under test.
  void req(badBin.base, 'POST', `/api/chats/${created.chat.id}/prompt`, { text: 'hi' });
  const ev = await badStream.waitFor((e) => e.event === 'agent_error', { label: 'agent_error' });
  assert.ok(ev.data.message, 'agent_error must carry a message');
  assert.equal(ev.data.chatId, created.chat.id, 'agent_error must be chat-scoped');
});

badStream.close();
await req(badBin.base, 'POST', '/api/host/shutdown', { killAgents: true }).catch(() => {});
await sleep(300);
try { badBin.proc.kill('SIGKILL'); } catch { /* already gone */ }

const failed = results.filter(([ok]) => !ok).length;
console.log(`e2e: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
