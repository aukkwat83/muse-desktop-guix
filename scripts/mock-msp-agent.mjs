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
//   auditfail → first turn fails MCP-audit-failed (rotation, session kept), then normal
//   boom     → turn fails with a synthetic error
//   kids     → subagent lifecycle + workflow fold (panel e2e; session/read drillable)
//   kidshold → a child that stays inProgress until subagent/stop (command e2e)
//   nativespawn → native children via subagent_spawn/wait toolCalls whose
//     outputs arrive as visibleOutput with NO deltas (instant tools, as the
//     real binary emits them) — alpha completes, beta stays running
//   reminders → system reminderChild items shaped like the real wire
//     (reminderAgentId + generationId + v4 childSessionId)
//
// Owner verbs (SS3.16) for the command e2e: subagent/stop|resume|sendMessage.
// Each validates the wire contract (UUIDv7 commandId, parent sessionId,
// known subagentId, non-empty send body), appends one JSON line to
// MOCK_MSP_SUBAGENT_LOG, and emits the resulting item frames.
//   mcptool  → one mcp__github.* tool call (usage-learning e2e)
//   goal     → session/goalChanged set (45% running); ungoal → goal:null clear
//   ctxusage → session/contextUsage + session/tokenUsage pair
//   quota    → usage/changed broadcast (usage/read answers the same shape)
//   topic    → two tool_calls: one with a human description (topic title),
//     one path-only (basename fallback title)
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
const AUDITFAIL_MARKER = process.env.MOCK_MSP_AUDITFAIL_MARKER || '';
const PROMPT_LOG = process.env.MOCK_MSP_PROMPT_LOG || '';
const SESSION_LOG = process.env.MOCK_MSP_SESSION_LOG || '';
const SUBAGENT_LOG = process.env.MOCK_MSP_SUBAGENT_LOG || '';

const MODEL = process.env.MUSE_DESKTOP_MODEL || 'mock-model-1';
const EFFORT = process.env.MUSE_DESKTOP_EFFORT || 'max';

let sidCounter = 0;
try {
  sidCounter = Number(fs.readFileSync(ID_FILE, 'utf8')) || 0;
} catch { /* first agent in this e2e — counter starts at 0 */ }
sidCounter += 1;
try { fs.writeFileSync(ID_FILE, String(sidCounter)); } catch { /* ignore */ }
// let, not const: session/resume ADOPTS the requested id, like the real
// binary resumes the same session — a fresh boot that kept minting would
// fork the host's id from the agent's, and every sessionId-scoped verb
// (subagent/*) would 502 after a rotation (the host correctly keeps the
// requested id; BUG-082 pins the stored id untouched).
let SESSION_ID = `mock-session-${sidCounter}`;
let turnCounter = 0;
/** Goal block the goal/* verbs mutate (null until a goal turn sets it). */
let MOCK_GOAL = null;

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
// BUG-084 wedge emulation: prompts the agent holds but never announced over
// the wire (served via approval/listPending only), and ids whose cancel the
// agent ignores (served pending forever, until turn/interrupt).
const ghostPending = new Map();
const ignoreCancel = new Set();
// subagentId → itemId for every child the scripts can spawn. Owner verbs
// reject anything outside this map, like the real host rejects a child id
// it never minted.
const KNOWN_CHILDREN = new Map([
  ['mock-sub-1', 'sub-1'],
  ['mock-sub-hold', 'sub-hold'],
]);

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
      if (SESSION_LOG) {
        try { fs.appendFileSync(SESSION_LOG, `${JSON.stringify({ verb: 'start', minted: SESSION_ID })}\n`); } catch { /* ignore */ }
      }
      reply(id, { session: sessionObject(), viewCursor: 'mock-cursor-0' });
      notify('session/started', { session: sessionObject() });
      return;
    }
    case 'session/resume': {
      if (SESSION_LOG) {
        try { fs.appendFileSync(SESSION_LOG, `${JSON.stringify({ verb: 'resume', requested: String(params?.sessionId || ''), minted: SESSION_ID })}\n`); } catch { /* ignore */ }
      }
      // Adopt-then-reply: the log keeps the boot-minted id (BUG-082 asserts
      // the retry runs on a fresh PROCESS), while the session from here on
      // answers to the resumed id, exactly like the real binary.
      if (String(params?.sessionId || '')) SESSION_ID = String(params.sessionId);
      reply(id, { session: sessionObject(), viewCursor: 'mock-cursor-0', history: { mode: 'none' } });
      return;
    }
    case 'usage/read': {
      reply(id, { usage: mockUsage() });
      return;
    }
    case 'session/read': {
      // Drill-down fixture: mock-child-1 nests one deeper, everything else
      // is a leaf. Unknown ids read as empty history (mode none) — except
      // mock-gone-*, which fail like a pruned child session, and the live
      // parent session itself, which carries one historical spawn+wait pair
      // for the boot backfill to recover.
      const sid = String(params?.sessionId || '');
      if (sid.startsWith('mock-gone-')) {
        replyError(id, -32000, `session ${sid} was not found: {"kind":"sessionNotFound","retryable":false,"sessionId":"${sid}"}`);
        return;
      }
      if (sid === SESSION_ID) {
        reply(id, {
          session: sessionObject(),
          history: { mode: 'inline', items: [
            {
              itemId: 'hist-spawn-old', kind: 'toolCall', status: 'completed', tool: 'subagent_spawn',
              callId: 'call-hist-spawn-old', turnId: 'mock-turn-0', revision: 2,
              args: JSON.stringify({ command_id: 'mock-cmd-old', objective: 'answer old', role: 'research', task_name: 'old-probe' }),
              visibleOutput: JSON.stringify({ status: 'accepted', subagent_id: 'mock-nat-old', agent_path: 'main/old-probe/1', task_ref: 'task/mock#0' }),
            },
            {
              itemId: 'hist-wait-old', kind: 'toolCall', status: 'completed', tool: 'subagent_wait',
              callId: 'call-hist-wait-old', turnId: 'mock-turn-0', revision: 2,
              args: JSON.stringify({ subagent_id: 'mock-nat-old', timeout_ms: 30000 }),
              visibleOutput: JSON.stringify({ status: 'ready', subagent_id: 'mock-nat-old', summary: 'old did it', evidence_refs: [] }),
            },
          ] },
        });
        return;
      }
      const leaf = sid === 'mock-child-1-1';
      const held = sid === 'mock-child-hold';
      const rem = sid.startsWith('mock-rem-');
      // Wire-true: a real reminder child calls submit_reminder_decision once
      // with {decision, reason} — the host folds it as the row's topic line.
      const remDecision = sid === 'mock-rem-2'
        ? { decision: 'none', reason: 'no skill gap this turn' }
        : { decision: 'remind', reason: 'memory: capture the Redis choice' };
      const items = rem ? [
        { itemId: 'rem-msg-1', kind: 'agentMessage', status: 'completed', text: 'reminder noted. ' },
        {
          itemId: 'rem-dec-1', kind: 'toolCall', status: 'completed', tool: 'submit_reminder_decision',
          args: JSON.stringify(remDecision), fallbackText: remDecision.decision,
        },
      ] : held ? [
        { itemId: 'h-msg-1', kind: 'agentMessage', status: 'completed', text: 'holding. ' },
      ] : sid === 'mock-child-1' ? [
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
      ghostPending.delete(params?.userInputId);
      const w = waiters.get(params?.userInputId);
      if (w) {
        waiters.delete(params.userInputId);
        w.resolve(params);
      }
      notify('userInput/settled', { sessionId: SESSION_ID, userInputId: params?.userInputId });
      return;
    }
    case 'userInput/cancel': {
      if (DECIDE_LOG) fs.appendFileSync(DECIDE_LOG, `cancel ${JSON.stringify(params)}\n`);
      // Binary-true: 1.4.2 rejects a reason-less cancel (`missing field
      // 'reason'`) even though the schema marks it optional — the actual
      // f381a7e1 wedge. The mock enforces it so the e2e fails if the
      // client ever drops the field again.
      if (typeof params?.reason !== 'string' || !params.reason.trim()) {
        replyError(id, -32602, 'Invalid params: missing field `reason`');
        return;
      }
      reply(id, {});
      // Wire-true (schema: the tool call resolves with a cancelled result),
      // except ids flagged to emulate an agent that ignores the cancel.
      if (ignoreCancel.has(params?.userInputId)) return;
      ghostPending.delete(params?.userInputId);
      const w = waiters.get(params?.userInputId);
      if (w) {
        waiters.delete(params.userInputId);
        w.resolve({ cancelled: true });
      }
      notify('userInput/settled', { sessionId: SESSION_ID, userInputId: params?.userInputId });
      return;
    }
    case 'approval/listPending':
      // The pull dual of the push frames: full request params per pending
      // prompt, exactly like the binary serves them.
      reply(id, { approvals: [], userInputs: [...ghostPending.values()] });
      return;
    case 'goal/pause':
    case 'goal/resume': {
      // Real-binary contract (probed 2026-09-22): accepted ack + a
      // session/goalChanged carrying the new status; the host repaints from
      // the event, never from this reply.
      const status = method === 'goal/pause' ? 'paused' : 'active';
      MOCK_GOAL = {
        ...(MOCK_GOAL || {
          objective: 'Ship the tasks panel',
          percentComplete: 45,
          currentWork: 'wiring the goal chip',
          nextWork: 'e2e for the panel',
        }),
        status,
      };
      reply(id, { commandId: params?.commandId, status: 'accepted' });
      notify('session/goalChanged', { sessionId: SESSION_ID, goal: { ...MOCK_GOAL } });
      return;
    }
    case 'subagent/stop':
    case 'subagent/resume':
    case 'subagent/sendMessage': {
      // Wire-trueness the e2e asserts on: the real host rejects a
      // non-UUIDv7 commandId with -32602 (AGENTS.md), and every verb
      // addresses the child through its PARENT session id.
      const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!UUIDV7.test(String(params?.commandId || ''))) {
        replyError(id, -32602, 'Invalid params: commandId must be UUIDv7');
        return;
      }
      if (String(params?.sessionId || '') !== SESSION_ID) {
        replyError(id, -32000, `unknown session ${params?.sessionId}`);
        return;
      }
      const itemId = KNOWN_CHILDREN.get(String(params?.subagentId || ''));
      if (!itemId) {
        replyError(id, -32000, `unknown subagent ${params?.subagentId}`);
        return;
      }
      if (method === 'subagent/sendMessage' && !String(params?.body ?? '').trim()) {
        replyError(id, -32602, 'Invalid params: body must be non-empty');
        return;
      }
      if (SUBAGENT_LOG) {
        try {
          fs.appendFileSync(SUBAGENT_LOG, `${JSON.stringify({
            method,
            sessionId: params.sessionId,
            subagentId: params.subagentId,
            commandId: params.commandId,
            ...(params.body != null ? { body: params.body } : {}),
            ...(params.reason != null ? { reason: params.reason } : {}),
          })}\n`);
        } catch { /* ignore */ }
      }
      reply(id, { commandId: params.commandId, status: 'accepted' });
      const turnId = `mock-turn-${turnCounter}`;
      if (method === 'subagent/stop') {
        // A held script owns its own terminal frame (cancelled + turn
        // settle); anything else just folds closed — idempotent ack.
        const w = waiters.get(`hold:${params.subagentId}`);
        if (w) {
          waiters.delete(`hold:${params.subagentId}`);
          w.resolve({ stopped: true });
        } else {
          turnNotify(turnId, 'item/updated', {
            item: { itemId, kind: 'subagent', status: 'completed', subagentId: params.subagentId, controlStatus: 'closed' },
          });
        }
      } else if (method === 'subagent/resume') {
        // Re-run then land: the e2e asserts the inProgress frame AND the
        // new terminal summary, so a dropped intermediate cannot hide.
        turnNotify(turnId, 'item/started', {
          item: {
            itemId, kind: 'subagent', status: 'inProgress', subagentId: params.subagentId,
            agentPath: 'researcher', depth: 1, controlStatus: 'running', childSessionId: 'mock-child-1',
          },
        });
        await sleep(60);
        turnNotify(turnId, 'item/completed', {
          item: {
            itemId, kind: 'subagent', status: 'completed', subagentId: params.subagentId,
            agentPath: 'researcher', depth: 1, durationMs: 4100, controlStatus: 'closed',
            childSessionId: 'mock-child-1',
            result: { artifactRefs: [], evidenceRefs: [], summary: 'resumed done' },
          },
        });
      }
      // sendMessage is ack-only: the real binary does not echo the note
      // back as an item frame, so neither do we.
      return;
    }
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
  const t = text.toLowerCase();
  if (t.includes('stay-deaf')) {
    return; // accept the ack, emit nothing — not even turn/started. The
    // deaf-client watchdog owns this turn (BUG-080).
  }
  turnNotify(turnId, 'turn/started', {});

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

  if (t.includes('auditfail')) {
    // BUG-082: first turn dies with the verbatim production reason, the
    // retry on a fresh agent succeeds. Separate marker from histfail so
    // the two rotation e2es stay independent.
    let seen = false;
    try { seen = fs.existsSync(AUDITFAIL_MARKER); } catch { /* ignore */ }
    if (!seen) {
      try { fs.writeFileSync(AUDITFAIL_MARKER, '1'); } catch { /* ignore */ }
      await sleep(30);
      completeTurn(turnId, 'failed', { reason: 'invalid run configuration: MCP startup audit failed; MCP is disabled for this runtime' });
      return;
    }
    if (await emitAgentText('m-audit', ['สวัสดีจาก mock agent '], 'สวัสดีจาก mock agent (audit-retry final)', turnId)) {
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

  if (t.includes('ghostquiz')) {
    // BUG-084: the wedge — a multi-question prompt the agent holds but never
    // announces (no userInput/request, no userInput/requested). The client's
    // only rescue is the listPending recovery poll, whose auto-cancel must
    // unblock this waiter; the turn then completes normally.
    const userInputId = `mock-ghost-${turnId}`;
    ghostPending.set(userInputId, {
      sessionId: SESSION_ID,
      userInputId,
      toolName: 'AskUserQuestion',
      toolCallId: 'mock-tool-ghost',
      turnId,
      questions: [
        { id: 'g1', question: 'Ghost first?', header: 'Ghost1', selection: { mode: 'single' }, options: [{ label: 'a' }, { label: 'b' }] },
        { id: 'g2', question: 'Ghost second?', header: 'Ghost2', selection: { mode: 'single' }, options: [{ label: 'x' }, { label: 'y' }] },
      ],
    });
    await new Promise((resolve) => waiters.set(userInputId, { resolve }));
    ghostPending.delete(userInputId);
    if (cancelled.has(turnId)) return;
    if (await emitAgentText('m-ghost', ['Recovered without an answer. '], 'Recovered without an answer.', turnId)) {
      completeTurn(turnId);
    }
    return;
  }

  if (t.includes('stubbornquiz')) {
    // BUG-084 escalation: like ghostquiz, but the agent ignores the cancel
    // (stays pending) — the client must interrupt the run and settle loud.
    // The interrupt unparks the waiter; the script then stays silent because
    // the client already settled the turn itself.
    const userInputId = `mock-stubborn-${turnId}`;
    ignoreCancel.add(userInputId);
    ghostPending.set(userInputId, {
      sessionId: SESSION_ID,
      userInputId,
      toolName: 'AskUserQuestion',
      toolCallId: 'mock-tool-stubborn',
      turnId,
      questions: [
        { id: 's1', question: 'Stubborn first?', header: 'Stub1', selection: { mode: 'single' }, options: [{ label: 'a' }, { label: 'b' }] },
        { id: 's2', question: 'Stubborn second?', header: 'Stub2', selection: { mode: 'single' }, options: [{ label: 'x' }, { label: 'y' }] },
      ],
    });
    await new Promise((resolve) => waiters.set(userInputId, { resolve }));
    ghostPending.delete(userInputId);
    ignoreCancel.delete(userInputId);
    return; // interrupted (or released) — the client owns the terminal event
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
    // Wire-true TodoItem shape: { text, status: camelCase, activeForm? } —
    // the host normalizes onto its snake_case plan vocabulary.
    notify('session/todoListChanged', {
      sessionId: SESSION_ID,
      revision: 7,
      sourceTool: 'TodoWrite',
      viewCursor: 'mock-cursor-todo-7',
      items: [
        { text: 'Set up scaffolding', status: 'pending' },
        { text: 'Wire the mock provider', status: 'inProgress', activeForm: 'Wiring the mock provider' },
        { text: 'Ship it', status: 'completed' },
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

  if (t.includes('kidshold')) {
    // BEFORE the plain `kids` branch: "kidshold" contains "kids".
    // The child stays inProgress until subagent/stop resolves the waiter —
    // the owner-verb round-trip the command e2e drives mid-turn.
    turnNotify(turnId, 'item/started', {
      item: msgItem('sub-hold', 'subagent', {
        subagentId: 'mock-sub-hold', agentPath: 'holder', role: 'hold',
        objective: 'hold until stopped', depth: 1, controlStatus: 'running',
        childSessionId: 'mock-child-hold',
      }),
    });
    await sleep(20);
    turnNotify(turnId, 'item/delta', { itemId: 'sub-hold', delta: 'holding-for-stop ' });
    await new Promise((resolve) => waiters.set('hold:mock-sub-hold', { resolve }));
    if (cancelled.has(turnId)) return;
    turnNotify(turnId, 'item/completed', {
      item: {
        itemId: 'sub-hold', kind: 'subagent', status: 'cancelled', subagentId: 'mock-sub-hold',
        agentPath: 'holder', depth: 1, durationMs: 1200, controlStatus: 'closed',
        childSessionId: 'mock-child-hold',
        result: { artifactRefs: [], evidenceRefs: [], summary: 'stopped by owner' },
      },
    });
    await sleep(20);
    if (await emitAgentText('m-hold', ['Held child stopped. '], 'Held child stopped. ', turnId)) {
      completeTurn(turnId);
    }
    return;
  }

  if (t.includes('nativespawn')) {
    // Native parallel children, wire-true to the real binary: plain toolCalls
    // whose outputs arrive ONLY as visibleOutput on the completed item (no
    // deltas — instant tools). Alpha runs to ready; beta is still working
    // when the turn lands, so the rail shows one of each state.
    const spawnArgs = (task, objective) => JSON.stringify({
      command_id: 'mock-cmd-1', objective, role: 'research', task_name: task,
    });
    const spawnOut = (id, task) => JSON.stringify({
      status: 'accepted', subagent_id: id, agent_path: `main/${task}/1`, task_ref: `task/mock#1`,
    });
    const natStarted = (id, tool, args) => turnNotify(turnId, 'item/started', {
      item: {
        itemId: id, kind: 'toolCall', status: 'inProgress', tool, callId: `call-${id}`,
        args, turnId, revision: 1,
      },
    });
    const natDone = (id, tool, args, out) => turnNotify(turnId, 'item/completed', {
      item: {
        itemId: id, kind: 'toolCall', status: 'completed', tool, callId: `call-${id}`,
        args, turnId, revision: 2, visibleOutput: out,
      },
    });
    natStarted('nt-spawn-a', 'subagent_spawn', spawnArgs('alpha-probe', 'answer alpha'));
    await sleep(20);
    natDone('nt-spawn-a', 'subagent_spawn', spawnArgs('alpha-probe', 'answer alpha'),
      spawnOut('mock-nat-alpha', 'alpha-probe'));
    natStarted('nt-wait-a', 'subagent_wait', JSON.stringify({ subagent_id: 'mock-nat-alpha', timeout_ms: 30000 }));
    await sleep(20);
    natDone('nt-wait-a', 'subagent_wait', JSON.stringify({ subagent_id: 'mock-nat-alpha', timeout_ms: 30000 }),
      JSON.stringify({
        status: 'ready', subagent_id: 'mock-nat-alpha', task_ref: 'task/mock#1',
        summary: 'alpha did the thing',
        evidence_refs: ['subagent/mock-nat-alpha/session.jsonl'],
      }));
    natStarted('nt-spawn-b', 'subagent_spawn', spawnArgs('beta-probe', 'answer beta'));
    await sleep(20);
    natDone('nt-spawn-b', 'subagent_spawn', spawnArgs('beta-probe', 'answer beta'),
      spawnOut('mock-nat-beta', 'beta-probe'));
    await sleep(20);
    if (await emitAgentText('m-nat', ['Native children spawned. '], 'Native children spawned. ', turnId)) {
      completeTurn(turnId);
    }
    return;
  }

  if (t.includes('reminders')) {
    // System reminder children, shaped exactly like the production wire:
    // reminderAgentId + generationId + a v4 childSessionId, no role/objective.
    turnNotify(turnId, 'item/started', {
      item: msgItem('rem-1', 'reminderChild', {
        childSessionId: 'mock-rem-1', generationId: 3, reminderAgentId: 'memory-reminder',
        taskId: 'mock-task-1', fallbackText: 'Reminder child session',
      }),
    });
    await sleep(20);
    turnNotify(turnId, 'item/completed', {
      item: {
        itemId: 'rem-1', kind: 'reminderChild', status: 'completed', childSessionId: 'mock-rem-1',
        generationId: 3, reminderAgentId: 'memory-reminder', taskId: 'mock-task-1',
        fallbackText: 'Reminder child session',
      },
    });
    turnNotify(turnId, 'item/started', {
      item: msgItem('rem-2', 'reminderChild', {
        childSessionId: 'mock-rem-2', generationId: 1, reminderAgentId: 'skill-reminder',
        taskId: 'mock-task-2', fallbackText: 'Reminder child session',
      }),
    });
    // rem-3's session is already pruned server-side — the drill must fall
    // back to the record detail instead of a bare error page.
    turnNotify(turnId, 'item/completed', {
      item: {
        itemId: 'rem-3', kind: 'reminderChild', status: 'cancelled', childSessionId: 'mock-gone-1',
        generationId: 2, reminderAgentId: 'todo-reminder', taskId: 'mock-task-3',
        fallbackText: 'Reminder child session',
      },
    });
    await sleep(20);
    if (await emitAgentText('m-rem', ['Reminders observed. '], 'Reminders observed. ', turnId)) {
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
    // The real binary reports status:'active' here (probed 2026-09-22).
    MOCK_GOAL = {
      objective: 'Ship the tasks panel',
      percentComplete: 45,
      status: 'active',
      currentWork: 'wiring the goal chip',
      nextWork: 'e2e for the panel',
    };
    notify('session/goalChanged', {
      sessionId: SESSION_ID,
      goal: { ...MOCK_GOAL },
    });
    await sleep(20);
    if (await emitAgentText('m-goal', ['Goal set. '], 'Goal set. ', turnId)) {
      completeTurn(turnId);
    }
    return;
  }

  if (t.includes('topic')) {
    // Topic-title probe (1.1.19): the first call carries a human
    // description (the row must name THAT, not the command); the second is
    // path-only (the row must name the basename, not the deep path).
    turnNotify(turnId, 'item/started', {
      item: msgItem('tc-topic-1', 'toolCall', { tool: 'Bash', args: '{"command":"ls /tmp/mock","description":"ตรวจไฟล์ชั่วคราว"}' }),
    });
    await sleep(30);
    if (cancelled.has(turnId)) return;
    turnNotify(turnId, 'item/delta', { itemId: 'tc-topic-1', field: 'output', delta: 'mock-file.txt\n' });
    turnNotify(turnId, 'item/completed', {
      item: { itemId: 'tc-topic-1', kind: 'toolCall', status: 'completed', tool: 'Bash', args: '{"command":"ls /tmp/mock","description":"ตรวจไฟล์ชั่วคราว"}', fallbackText: 'mock-file.txt\n' },
    });
    await sleep(20);
    if (cancelled.has(turnId)) return;
    turnNotify(turnId, 'item/started', {
      item: msgItem('tc-topic-2', 'toolCall', { tool: 'Read', args: '{"file_path":"src/deeply/nested/auth.js"}' }),
    });
    await sleep(30);
    if (cancelled.has(turnId)) return;
    turnNotify(turnId, 'item/completed', {
      item: { itemId: 'tc-topic-2', kind: 'toolCall', status: 'completed', tool: 'Read', args: '{"file_path":"src/deeply/nested/auth.js"}', fallbackText: 'file contents' },
    });
    await sleep(20);
    if (await emitAgentText('m-topic', ['Topics titled. '], 'Topics titled. ', turnId)) {
      completeTurn(turnId);
    }
    return;
  }

  if (await emitAgentText('m0', ['สวัสดีจาก mock ', 'agent '], 'สวัสดีจาก mock agent (final)', turnId)) {
    completeTurn(turnId);
  }
}
