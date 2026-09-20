#!/usr/bin/env node
// Mock MSP agent for e2e-mock-agent.mjs. Speaks the same newline-delimited
// JSON-RPC the real `muse serve` does (initialize / session/start|resume /
// turn/start|interrupt, item/* + turn/* + approval/* + userInput/* events)
// with canned trigger-word scripts. MUSE_BIN=<this file> makes the host
// spawn it instead of the real CLI.
//
// Trigger words inside the prompt text:
//   tool     → a tool_call row with streamed stdout + closing text
//   edit     → short text turn
//   ask      → an approval card (waits for approval/decide before finishing)
//   quiz     → a userInput question card (waits for userInput/answer)
//   exitplan → completes immediately (plan-mode smoke)
//   plan     → a session/todoListChanged plan + text
//   slow     → ~600ms of silence, then text (deadline guard rail)
//   hang     → never answers (watchdog + cancel coverage)
//   long     → 60 chunks then an authoritative completed object
//   mixorder → text, tool row, thought, text (frame-order assertion)
//   histfail → first turn fails session-not-found (rotation), then normal
//   boom     → turn fails with a synthetic error
//   kids     → subagent lifecycle + workflow fold (panel e2e; session/read drillable)
//   mcptool  → one mcp__github.* tool call (usage-learning e2e)
//   goal     → session/goalChanged set (45% running); ungoal → goal:null clear
//   ctxusage → session/contextUsage + session/tokenUsage pair
//   quota    → usage/changed broadcast (usage/read answers the same shape)
//
// Modes (MOCK_MSP_MODE, set per host process by the e2e):
//   normal   → everything above
//   authwall → session/start refuses with a login error

import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MODE = process.env.MOCK_MSP_MODE || 'normal';
const LOG = process.env.MOCK_MSP_CONFIG_LOG || '';
const DECIDE_LOG = process.env.MOCK_MSP_DECIDE_LOG || '';
const ID_FILE = process.env.MOCK_MSP_ID_FILE || '';
const MARKER = process.env.MOCK_MSP_HISTFAIL_MARKER || '';
const PROMPT_LOG = process.env.MOCK_MSP_PROMPT_LOG || '';

const MODEL = process.env.MUSE_DESKTOP_MODEL || 'mock-model-1';
const EFFORT = process.env.MUSE_DESKTOP_EFFORT || 'max';

let sidCounter = 0;
try {
  sidCounter = Number(fs.readFileSync(ID_FILE, 'utf8')) || 0;
} catch { /* first agent in this e2e — counter starts at 0 */ }
sidCounter += 1;
try { fs.writeFileSync(ID_FILE, String(sidCounter)); } catch { /* ignore */ }
const SESSION_ID = `mock-session-${sidCounter}`;
let turnCounter = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}
function mockUsage() {
  const now = Date.now();
  return {
    tier: 'mock-pro',
    observedAtMs: now,
    window: { usedPercent: 12, resetsAtMs: now + 4 * 3600_000, windowDurationMins: 300 },
    weekly: { usedPercent: 34, resetsAtMs: now + 3 * 86400_000 },
  };
}
function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}
function replyError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}

// decision waiters: approvalId|userInputId → resolve(decision params)
const waiters = new Map();
// cancelled turnIds (turn/interrupt) — the script checks between steps.
const cancelled = new Set();

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method && msg.id == null) return; // notifications (initialized) need nothing
  if (!msg.method) return;
  void handle(msg);
});

function sessionObject() {
  return {
    sessionId: SESSION_ID,
    status: 'idle',
    workspaceRoot: process.env.MUSE_DESKTOP_CWD || os.homedir(),
    providerId: 'mock',
    // Deliberately NOT the env MODEL — the host must drive session/setModel
    // to reach the configured model, which the config-calls log asserts.
    modelId: 'mock-model-2',
    turnCount: turnCounter,
    approvalMode: { mode: 'promptUnmatched', source: 'test' },
  };
}

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      reply(id, {
        serverInfo: { name: 'mock-msp', version: '0.0.0' },
        schema: { version: 1 },
        sessionDurability: 'durable',
      });
      return;
    case 'session/start': {
      if (MODE === 'authwall') {
        replyError(id, -32001, 'not logged in: run muse login');
        return;
      }
      reply(id, { session: sessionObject(), viewCursor: 'mock-cursor-0' });
      notify('session/started', { session: sessionObject() });
      return;
    }
    case 'session/resume':
      reply(id, { session: sessionObject(), viewCursor: 'mock-cursor-0', history: { mode: 'none' } });
      return;
    case 'usage/read': {
      reply(id, { usage: mockUsage() });
      return;
    }
    case 'session/read': {
      // Drill-down fixture: mock-child-1 nests one deeper, everything else
      // is a leaf. Unknown ids read as empty history (mode none).
      const sid = String(params?.sessionId || '');
      const leaf = sid === 'mock-child-1-1';
      const items = sid === 'mock-child-1' ? [
        { itemId: 'c-user-1', kind: 'userMessage', status: 'completed', text: 'research the cache options' },
        { itemId: 'c-msg-1', kind: 'agentMessage', status: 'completed', text: 'Redis wins on latency. ' },
        { itemId: 'c-tool-1', kind: 'toolCall', status: 'completed', tool: 'mcp__github.search_repositories', args: '{}', fallbackText: '3 repos' },
        {
          itemId: 'c-sub-1', kind: 'subagent', status: 'completed', subagentId: 'mock-sub-1-1',
          agentPath: 'nested-researcher', depth: 2, durationMs: 1500, controlStatus: 'closed',
          childSessionId: 'mock-child-1-1',
          result: { artifactRefs: [], evidenceRefs: [], summary: 'nested done' },
        },
      ] : leaf ? [
        { itemId: 'g-msg-1', kind: 'agentMessage', status: 'completed', text: 'grandchild report. ' },
      ] : null;
      reply(id, {
        session: { ...sessionObject(), sessionId: sid || SESSION_ID, status: 'idle', turnCount: 1 },
        viewCursor: 'mock-cursor-read',
        pendingRequests: [],
        history: items ? { mode: 'inline', items, snapshot: null } : { mode: 'none', items: null, snapshot: null, noneReason: 'unknownSession' },
      });
      return;
    }
    case 'view/subscribe':
      reply(id, { sessionId: SESSION_ID, viewCursor: 'mock-cursor-1' });
      return;
    case 'model/list':
      reply(id, { models: [{ modelId: MODEL }, { modelId: 'mock-model-2' }] });
      return;
    case 'session/setModel':
      if (LOG) fs.appendFileSync(LOG, `model=${params?.model?.modelId}\n`);
      reply(id, {});
      notify('session/modelChanged', { sessionId: SESSION_ID, modelId: params?.model?.modelId });
      return;
    case 'session/setReasoningEffort':
      if (LOG) fs.appendFileSync(LOG, `thinking=${params?.reasoningEffort}\n`);
      reply(id, {});
      notify('session/reasoningEffortChanged', { sessionId: SESSION_ID, reasoningEffort: params?.reasoningEffort });
      return;
    case 'session/setApprovalMode': {
      const mode = params?.mode;
      if (LOG) fs.appendFileSync(LOG, `approvalMode=${mode}\n`);
      reply(id, {});
      notify('session/approvalModeChanged', { sessionId: SESSION_ID, mode });
      return;
    }
    case 'approval/decide': {
      if (DECIDE_LOG) fs.appendFileSync(DECIDE_LOG, `${JSON.stringify(params)}\n`);
      reply(id, {});
      const w = waiters.get(params?.approvalId);
      if (w) {
        waiters.delete(params.approvalId);
        w.resolve(params);
      }
      notify('approval/resolved', {
        sessionId: SESSION_ID,
        approvalId: params?.approvalId,
        decision: 'approvedForSession',
      });
      return;
    }
    case 'userInput/answer': {
      if (DECIDE_LOG) fs.appendFileSync(DECIDE_LOG, `${JSON.stringify(params)}\n`);
      reply(id, {});
      const w = waiters.get(params?.userInputId);
      if (w) {
        waiters.delete(params.userInputId);
        w.resolve(params);
      }
      notify('userInput/settled', { sessionId: SESSION_ID, userInputId: params?.userInputId });
      return;
    }
    case 'userInput/cancel':
      if (DECIDE_LOG) fs.appendFileSync(DECIDE_LOG, `cancel ${JSON.stringify(params)}\n`);
      reply(id, {});
      return;
    case 'turn/interrupt':
      if (params?.turnId) cancelled.add(String(params.turnId));
      // Unpark any script awaiting a decision — it checks cancelled next.
      for (const [, w] of waiters) {
        try { w.resolve({ cancelled: true }); } catch { /* ignore */ }
      }
      waiters.clear();
      reply(id, {});
      return;
    case 'turn/start': {
      turnCounter += 1;
      const turnId = `mock-turn-${turnCounter}`;
      const text = String(params?.input?.[0]?.text || params?.input?.[0]?.data || '');
      if (PROMPT_LOG) fs.appendFileSync(PROMPT_LOG, `${JSON.stringify(text)}\n`);
      reply(id, { commandId: params?.commandId, status: 'accepted', turnId, startedNewTurn: true, disposition: 'started' });
      void runTurn(turnId, text).catch(() => {});
      return;
    }
    default:
      replyError(id, -32601, `Method not found: ${method}`);
  }
}

function turnNotify(turnId, method, params) {
  notify(method, { sessionId: SESSION_ID, turnId, ...params });
}

function msgItem(itemId, kind, extra = {}) {
  return { itemId, kind, status: 'inProgress', ...extra };
}

async function emitAgentText(itemId, chunks, finalText, turnId) {
  turnNotify(turnId, 'item/started', { item: msgItem(itemId, 'agentMessage') });
  for (const c of chunks) {
    if (cancelled.has(turnId)) return false;
    await sleep(30);
    turnNotify(turnId, 'item/delta', { itemId, delta: c });
  }
  turnNotify(turnId, 'item/completed', {
    item: { itemId, kind: 'agentMessage', status: 'completed', text: finalText },
  });
  return !cancelled.has(turnId);
}

function completeTurn(turnId, terminal = 'completed', extra = {}) {
  turnNotify(turnId, 'turn/completed', { terminal, ...extra });
}

async function runTurn(turnId, text) {
  turnNotify(turnId, 'turn/started', {});
  const t = text.toLowerCase();

  if (t.includes('boom')) {
    await sleep(30);
    completeTurn(turnId, 'failed', { reason: 'the mock exploded' });
    return;
  }

  if (t.includes('histfail')) {
    let seen = false;
    try { seen = fs.existsSync(MARKER); } catch { /* ignore */ }
    if (!seen) {
      try { fs.writeFileSync(MARKER, '1'); } catch { /* ignore */ }
      await sleep(30);
      completeTurn(turnId, 'failed', { reason: 'Session not found; start a new session' });
      return;
    }
    if (await emitAgentText('m-hist', ['สวัสดีจาก mock agent '], 'สวัสดีจาก mock agent (final)', turnId)) {
      completeTurn(turnId);
    }
    return;
  }

  if (t.includes('hang')) {
    await sleep(30);
    return; // never completes — the watchdog / cancel owns this turn now
  }

  if (t.includes('slow') && t.includes('tool')) {
    // Hydration probe: slow enough to snapshot mid-turn, then hold the turn
    // open until the harness cancels it.
    await sleep(600);
    if (cancelled.has(turnId)) return;
    turnNotify(turnId, 'item/started', {
      item: msgItem('tc-1', 'toolCall', { tool: 'Bash', args: '{"command":"sleep 30"}' }),
    });
    await sleep(30);
    if (cancelled.has(turnId)) return;
    turnNotify(turnId, 'item/started', { item: msgItem('m-hyd', 'agentMessage') });
    turnNotify(turnId, 'item/delta', { itemId: 'm-hyd', delta: 'Working on it. ' });
    return; // held open — cancel owns the rest
  }

  if (t.includes('slow')) {
    // First delta immediately (a cancel in the first 100ms still persists a
    // partial), then spaced deltas — the turn stays visibly alive ~1.1s so
    // background and late-bind probes can observe it mid-flight.
    turnNotify(turnId, 'item/started', { item: msgItem('m-slow', 'agentMessage') });
    turnNotify(turnId, 'item/delta', { itemId: 'm-slow', delta: 'Slow ' });
    for (const d of ['turn ', 'done. ']) {
      await sleep(500);
      if (cancelled.has(turnId)) return;
      turnNotify(turnId, 'item/delta', { itemId: 'm-slow', delta: d });
    }
    await sleep(100);
    if (cancelled.has(turnId)) return;
    turnNotify(turnId, 'item/completed', {
      item: { itemId: 'm-slow', kind: 'agentMessage', status: 'completed', text: 'Slow turn done. ' },
    });
    completeTurn(turnId);
    return;
  }

  if (t.includes('long')) {
    let assembled = '';
    for (let i = 0; i < 120; i++) assembled += `chunk-${String(i).padStart(3, '0')} `;
    turnNotify(turnId, 'item/started', { item: msgItem('m-long', 'agentMessage') });
    // One burst, no pacing — the host's char-window batcher must collapse it.
    for (let i = 0; i < 120; i++) {
      if (cancelled.has(turnId)) return;
      turnNotify(turnId, 'item/delta', { itemId: 'm-long', delta: `chunk-${String(i).padStart(3, '0')} ` });
    }
    turnNotify(turnId, 'item/completed', {
      item: { itemId: 'm-long', kind: 'agentMessage', status: 'completed', text: `${assembled}(final)` },
    });
    completeTurn(turnId);
    return;
  }

  if (t.includes('mixorder')) {
    turnNotify(turnId, 'item/started', { item: msgItem('m-mix', 'agentMessage') });
    await sleep(20);
    turnNotify(turnId, 'item/delta', { itemId: 'm-mix', delta: 'before-tool ' });
    await sleep(20);
    turnNotify(turnId, 'item/started', {
      item: msgItem('tc-mix', 'toolCall', { tool: 'Bash', args: '{"command":"ls /tmp/mock"}' }),
    });
    await sleep(20);
    turnNotify(turnId, 'item/delta', { itemId: 'tc-mix', field: 'output', delta: 'mock-file.txt\n' });
    await sleep(20);
    turnNotify(turnId, 'item/completed', {
      item: { itemId: 'tc-mix', kind: 'toolCall', status: 'completed', tool: 'Bash', args: '{"command":"ls /tmp/mock"}', fallbackText: 'mock-file.txt\n' },
    });
    await sleep(20);
    turnNotify(turnId, 'item/started', { item: msgItem('r-mix', 'reasoning') });
    turnNotify(turnId, 'item/delta', { itemId: 'r-mix', field: 'summary.0', delta: 'Steward thinking about the request.' });
    turnNotify(turnId, 'item/completed', {
      item: { itemId: 'r-mix', kind: 'reasoning', status: 'completed', summary: [{ type: 'text', text: 'Steward thinking about the request.' }] },
    });
    await sleep(20);
    turnNotify(turnId, 'item/delta', { itemId: 'm-mix', delta: 'after-tool' });
    await sleep(20);
    turnNotify(turnId, 'item/completed', {
      item: { itemId: 'm-mix', kind: 'agentMessage', status: 'completed', text: 'before-tool after-tool' },
    });
    completeTurn(turnId);
    return;
  }

  if (t.includes('mcptool')) {
    // One namespaced MCP tool call — the host learns `github` was used.
    // BEFORE the plain `tool` branch: "mcptool" contains "tool".
    turnNotify(turnId, 'item/started', {
      item: msgItem('tc-mcp-1', 'toolCall', { tool: 'mcp__github.search_repositories', args: '{"query":"mcp"}' }),
    });
    await sleep(30);
    turnNotify(turnId, 'item/completed', {
      item: { itemId: 'tc-mcp-1', kind: 'toolCall', status: 'completed', tool: 'mcp__github.search_repositories', args: '{"query":"mcp"}', fallbackText: '3 repos' },
    });
    await sleep(20);
    if (await emitAgentText('m-mcp', ['Found via GitHub. '], 'Found via GitHub. ', turnId)) {
      completeTurn(turnId);
    }
    return;
  }

  if (t.includes('tool')) {
    turnNotify(turnId, 'item/started', {
      item: msgItem('tc-1', 'toolCall', { tool: 'Bash', args: '{"command":"ls"}' }),
    });
    await sleep(30);
    turnNotify(turnId, 'item/delta', { itemId: 'tc-1', field: 'output', delta: 'ok: ' });
    await sleep(30);
    turnNotify(turnId, 'item/delta', { itemId: 'tc-1', field: 'output', delta: '42 lines' });
    await sleep(30);
    turnNotify(turnId, 'item/completed', {
      item: { itemId: 'tc-1', kind: 'toolCall', status: 'completed', tool: 'Bash', args: '{"command":"ls"}', fallbackText: 'ok: 42 lines' },
    });
    await sleep(20);
    if (await emitAgentText('m-tool', ['The directory listing is above. '], 'The directory listing is above. ', turnId)) {
      completeTurn(turnId);
    }
    return;
  }

  if (t.includes('ask')) {
    // Unique per turn — a real host never reuses an approval id, and the
    // harness dedupes cards by id.
    const approvalId = `mock-perm-${turnId}`;
    // The row that asks, streamed BEFORE the card (BUG-029 anchoring).
    turnNotify(turnId, 'item/started', {
      item: msgItem('tc-perm-1', 'toolCall', { tool: 'Bash', args: '{"command":"rm -rf /tmp/demo"}' }),
    });
    await sleep(20);
    const params = {
      sessionId: SESSION_ID,
      approvalId,
      toolName: 'Bash',
      toolCallId: 'tc-perm-1',
      subject: { kind: 'shell', command: 'rm -rf /tmp/demo' },
      rawArgs: '{"command":"rm -rf /tmp/demo"}',
      currentRequirementId: 'req-1',
      availableChoices: [
        { choiceId: 'approve_once', label: 'Approve once', decision: 'approved', scope: 'once' },
        { choiceId: 'approve_always', label: 'Always approve', decision: 'approvedForSession', scope: 'session' },
        { choiceId: 'reject', label: 'Reject', decision: 'denied', scope: 'once' },
      ],
    };
    // Both the server-initiated request AND the notification, like a real
    // host — the client must mount exactly one card.
    send({ jsonrpc: '2.0', id: `mock-req-${turnId}-a`, method: 'approval/request', params });
    notify('approval/requested', params);
    const decision = await new Promise((resolve) => waiters.set(approvalId, { resolve }));
    if (cancelled.has(turnId)) return;
    const picked = decision?.choiceId || 'nothing';
    await sleep(30);
    if (await emitAgentText('m-ask', [`permission → ${picked}. `], `permission → ${picked}.`, turnId)) {
      completeTurn(turnId);
    }
    turnNotify(turnId, 'item/completed', {
      item: { itemId: 'tc-perm-1', kind: 'toolCall', status: 'completed', tool: 'Bash', args: '{"command":"rm -rf /tmp/demo"}', fallbackText: 'done' },
    });
    return;
  }

  if (t.includes('quizmulti')) {
    // Two questions — wider than the single-optionId card. The client must
    // auto-cancel (with a visible trace) instead of stranding the turn.
    const userInputId = 'mock-quiz-multi';
    notify('userInput/requested', {
      sessionId: SESSION_ID,
      userInputId,
      toolName: 'AskUserQuestion',
      questions: [
        { id: 'q1', question: 'First?', selection: { mode: 'single' }, options: [{ label: 'a' }, { label: 'b' }] },
        { id: 'q2', question: 'Second?', selection: { mode: 'single' }, options: [{ label: 'x' }, { label: 'y' }] },
      ],
    });
    await sleep(300);
    if (cancelled.has(turnId)) return;
    if (await emitAgentText('m-quizm', ['Continuing without an answer. '], 'Continuing without an answer.', turnId)) {
      completeTurn(turnId);
    }
    return;
  }

  if (t.includes('quiz')) {
    const userInputId = `mock-quiz-${turnId}`;
    const params = {
      sessionId: SESSION_ID,
      userInputId,
      toolName: 'AskUserQuestion',
      toolCallId: 'mock-tool-quiz',
      questions: [
        {
          id: 'q1',
          question: 'ควรเก็บ cache ไว้ที่ไหน?',
          header: 'Cache',
          selection: { mode: 'single' },
          options: [{ label: 'Redis' }, { label: 'SQLite in-memory' }, { label: 'Skip' }],
        },
      ],
    };
    send({ jsonrpc: '2.0', id: `mock-req-${turnId}-q`, method: 'userInput/request', params });
    notify('userInput/requested', params);
    const answer = await new Promise((resolve) => waiters.set(userInputId, { resolve }));
    if (cancelled.has(turnId)) return;
    const picked = answer?.answers?.[0]?.selectedLabel || 'nothing';
    await sleep(30);
    if (await emitAgentText('m-quiz', [`ask → ${picked}. `], `ask → ${picked}.`, turnId)) {
      completeTurn(turnId);
    }
    return;
  }

  if (t.includes('plan') && !t.includes('explain')) {
    notify('session/todoListChanged', {
      sessionId: SESSION_ID,
      items: [
        { content: 'Set up scaffolding', status: 'pending' },
        { content: 'Wire the mock provider', status: 'in_progress' },
        { content: 'Ship it', status: 'completed' },
      ],
    });
    await sleep(30);
    if (await emitAgentText('m-plan', ['Plan is ready. '], 'Plan is ready. ', turnId)) {
      completeTurn(turnId);
    }
    return;
  }

  if (t.includes('edit')) {
    // MSP has no diff content blocks — the edit summary streams as tool
    // output text, and completion carries the one-line result.
    turnNotify(turnId, 'item/started', {
      item: msgItem('tc-edit-1', 'toolCall', { tool: 'Edit', args: '{"file_path":"src/demo.js"}' }),
    });
    await sleep(30);
    turnNotify(turnId, 'item/delta', { itemId: 'tc-edit-1', field: 'output', delta: 'src/demo.js\n- const a = 1\n' });
    await sleep(30);
    turnNotify(turnId, 'item/delta', { itemId: 'tc-edit-1', field: 'output', delta: '+ const a = 2\n' });
    await sleep(30);
    turnNotify(turnId, 'item/completed', {
      item: { itemId: 'tc-edit-1', kind: 'toolCall', status: 'completed', tool: 'Edit', args: '{"file_path":"src/demo.js"}', fallbackText: 'edited src/demo.js' },
    });
    await sleep(20);
    if (await emitAgentText('m-edit', ['I updated the config file. '], 'I updated the config file. ', turnId)) {
      completeTurn(turnId);
    }
    return;
  }

  if (t.includes('kids')) {
    // Subagent + workflow lifecycle for the panel e2e. The child streams one
    // delta that must NEVER land in the parent transcript, then completes
    // with a drillable child session; the workflow folds two children.
    turnNotify(turnId, 'item/started', {
      item: msgItem('sub-1', 'subagent', {
        subagentId: 'mock-sub-1', agentPath: 'researcher', role: 'research',
        objective: 'research the cache options', depth: 1, controlStatus: 'starting',
      }),
    });
    await sleep(20);
    turnNotify(turnId, 'item/delta', { itemId: 'sub-1', delta: 'child-private-stream ' });
    await sleep(20);
    turnNotify(turnId, 'item/updated', {
      item: {
        itemId: 'sub-1', kind: 'subagent', status: 'inProgress', subagentId: 'mock-sub-1',
        agentPath: 'researcher', depth: 1, controlStatus: 'running', childSessionId: 'mock-child-1',
      },
    });
    await sleep(20);
    turnNotify(turnId, 'item/completed', {
      item: {
        itemId: 'sub-1', kind: 'subagent', status: 'completed', subagentId: 'mock-sub-1',
        agentPath: 'researcher', depth: 1, durationMs: 3200, controlStatus: 'closed',
        childSessionId: 'mock-child-1',
        result: { artifactRefs: [], evidenceRefs: [], summary: 'Redis wins', text: 'Redis wins on latency. Details…' },
      },
    });
    await sleep(20);
    turnNotify(turnId, 'item/started', {
      item: msgItem('wf-1', 'workflow', {
        entryId: 'mock-entry', scriptId: 'mock-script', children: [
          { childId: 'plan', attempt: 1, label: 'plan', status: 'running' },
        ],
      }),
    });
    await sleep(20);
    turnNotify(turnId, 'item/completed', {
      item: {
        itemId: 'wf-1', kind: 'workflow', status: 'completed', entryId: 'mock-entry',
        message: 'both done',
        children: [
          { childId: 'plan', attempt: 1, label: 'plan', status: 'succeeded', durationMs: 900 },
          { childId: 'build', attempt: 1, label: 'build', phase: 'ship', status: 'succeeded', durationMs: 2100 },
        ],
      },
    });
    await sleep(20);
    if (await emitAgentText('m-kids', ['Delegated to a child. '], 'Delegated to a child. ', turnId)) {
      completeTurn(turnId);
    }
    return;
  }

  if (t.includes('ungoal')) {
    notify('session/goalChanged', { sessionId: SESSION_ID, goal: null });
    await sleep(20);
    if (await emitAgentText('m-ungoal', ['Goal cleared. '], 'Goal cleared. ', turnId)) {
      completeTurn(turnId);
    }
    return;
  }

  if (t.includes('quota')) {
    notify('usage/changed', mockUsage());
    await sleep(20);
    if (await emitAgentText('m-quota', ['Quota noted. '], 'Quota noted. ', turnId)) {
      completeTurn(turnId);
    }
    return;
  }

  if (t.includes('ctxusage')) {
    notify('session/contextUsage', {
      sessionId: SESSION_ID, usedTokens: 123456, windowTokens: 1000000, pressure: 'normal',
    });
    await sleep(20);
    notify('session/tokenUsage', {
      sessionId: SESSION_ID, modelId: 'mock-model',
      promptTokens: 120000, totalTokens: 123456,
      cumulative: { promptTokens: 120000, outputTokens: 3456, totalTokens: 123456 },
    });
    await sleep(20);
    if (await emitAgentText('m-ctx', ['Usage noted. '], 'Usage noted. ', turnId)) {
      completeTurn(turnId);
    }
    return;
  }

  if (t.includes('goal')) {
    notify('session/goalChanged', {
      sessionId: SESSION_ID,
      goal: {
        objective: 'Ship the tasks panel',
        percentComplete: 45,
        status: 'running',
        currentWork: 'wiring the goal chip',
        nextWork: 'e2e for the panel',
      },
    });
    await sleep(20);
    if (await emitAgentText('m-goal', ['Goal set. '], 'Goal set. ', turnId)) {
      completeTurn(turnId);
    }
    return;
  }

  if (await emitAgentText('m0', ['สวัสดีจาก mock ', 'agent '], 'สวัสดีจาก mock agent (final)', turnId)) {
    completeTurn(turnId);
  }
}
