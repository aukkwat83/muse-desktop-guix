// MSP client for `muse serve` — JSON-RPC 2.0 over newline-delimited stdio.
//
// Same framing as the ACP dialect in the kimi lineage (one JSON object per
// line, `id` correlation, server→client requests for approvals), but the
// method set is MSP: initialize / session/start|resume / turn/start|interrupt
// with view events (item/*, turn/*, approval/*, session/*) streamed back.
//
// The public surface intentionally mirrors the old AcpClient so SessionManager
// keeps working unchanged: start/prompt/cancel/shutdown, setSessionMode,
// ACK-safe decideApproval/answerUserInput/cancelUserInput (+ the sweep-only
// cancelInteractive), configSelects/setConfigOption, and the same emitted
// events (status/stderr/handshake/auth_required/load_miss/update/permission/
// exit/error/mode/session). MSP frames are normalized to the ACP-shaped
// update kinds _onUpdate already handles (agent_message_chunk,
// tool_call(_update), plan, config_option_update, current_mode_update).

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  mspApprovalCard,
  mspApprovalOptions,
  mspChoiceIsSticky,
  mspDecisionIsApprove,
  mspUserInputCard,
  pickMspApproveChoice,
  pickMspDenyChoice,
} from './hosts.js';
import {
  normalizeSessionMode,
  sessionModeAlwaysApprove,
  sessionModeToMspApprovalMode,
} from './session-mode.js';
import { buildTurnInput } from './attachments.js';

export function formatRpcError(error) {
  if (error == null) return 'rpc error';
  if (typeof error === 'string') return error.trim() || 'rpc error';
  if (error instanceof Error) {
    if (error.rpc && typeof error.rpc === 'object') {
      const fromRpc = formatRpcError(error.rpc);
      if (
        error.message &&
        error.message !== 'Invalid params' &&
        error.message.length > fromRpc.length
      ) {
        return error.message;
      }
      return fromRpc || error.message || 'error';
    }
    return error.message || 'error';
  }
  if (typeof error !== 'object') return String(error);

  const msg = String(/** @type {any} */ (error).message || 'rpc error').trim();
  let data = /** @type {any} */ (error).data;
  if (data == null || data === '') return msg || 'rpc error';
  if (typeof data !== 'string') {
    try {
      data = JSON.stringify(data);
    } catch {
      data = String(data);
    }
  }
  data = String(data).trim();
  if (!data) return msg || 'rpc error';
  if (msg.toLowerCase() === 'invalid params') {
    return data.toLowerCase().startsWith('invalid') ? data : `Invalid params: ${data}`;
  }
  if (msg.includes(data)) return msg;
  return `${msg}: ${data}`;
}

export function isHistoryIncompatibleError(err) {
  const parts = [];
  if (err instanceof Error) {
    parts.push(err.message);
    if (err.rpc && typeof err.rpc === 'object') {
      parts.push(err.rpc.message, err.rpc.data);
    }
  } else if (err && typeof err === 'object') {
    parts.push(/** @type {any} */ (err).message, /** @type {any} */ (err).data);
  } else {
    parts.push(String(err || ''));
  }
  const blob = parts
    .filter((x) => x != null && x !== '')
    .map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
    .join(' ')
    .toLowerCase();
  return (
    blob.includes('session not found') ||
    blob.includes('unknown session') ||
    blob.includes('no such session') ||
    blob.includes('session expired') ||
    blob.includes('resume failed') ||
    blob.includes('could not resume') ||
    blob.includes('incompatible with the current model') ||
    (blob.includes('start a new session') &&
      (blob.includes('invalid params') || blob.includes('incompatible') || blob.includes('history')))
  );
}

export function isClientAlive(client) {
  if (!client) return false;
  if (client._closing) return false;
  if (!client.sessionId) return false;
  const proc = client.proc;
  if (!proc || proc.killed || proc.exitCode != null) return false;
  try {
    if (!proc.stdin || proc.stdin.destroyed || !proc.stdin.writable) return false;
  } catch {
    return false;
  }
  return true;
}

/** MSP surfaces login state as turn/RPC failures, not a dedicated code. */
export function isAuthRequiredError(err) {
  const blob = [
    err?.message,
    err?.rpc?.message,
    typeof err?.rpc?.data === 'string' ? err.rpc.data : JSON.stringify(err?.rpc?.data ?? ''),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return (
    blob.includes('not logged in') ||
    blob.includes('not authenticated') ||
    blob.includes('login required') ||
    blob.includes('authentication required') ||
    blob.includes('auth_required') ||
    blob.includes('unauthenticated') ||
    blob.includes('unauthorized')
  );
}

/**
 * MSP surfaces a poisoned serve host as a turn failure, not a dedicated
 * code (BUG-082). Production wording, verbatim from the session log:
 * `invalid run configuration: MCP startup audit failed; MCP is disabled
 * for this runtime`. The host stays alive but every later turn on it dies
 * the same way — the only recovery is a fresh agent (see sessions.js).
 */
export function isMcpAuditFailedError(err) {
  const blob = [
    err?.message,
    err?.rpc?.message,
    typeof err?.rpc?.data === 'string' ? err.rpc.data : JSON.stringify(err?.rpc?.data ?? ''),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return (
    blob.includes('mcp startup audit failed') ||
    blob.includes('mcp is disabled for this runtime')
  );
}

/** UUIDv7 — every MSP commandId must be one or the host rejects it. */
export function uuidv7() {
  const b = randomBytes(16);
  const ms = BigInt(Date.now());
  b[0] = Number((ms >> 40n) & 0xffn);
  b[1] = Number((ms >> 32n) & 0xffn);
  b[2] = Number((ms >> 24n) & 0xffn);
  b[3] = Number((ms >> 16n) & 0xffn);
  b[4] = Number((ms >> 8n) & 0xffn);
  b[5] = Number(ms & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The closed ReasoningEffort vocabulary, straight from the MSP schema. */
export const REASONING_TIERS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

function resolveMuseBin() {
  if (process.env.MUSE_BIN && fs.existsSync(process.env.MUSE_BIN)) {
    return process.env.MUSE_BIN;
  }
  const home = os.homedir();
  const candidates = [
    process.env.MUSE_BIN,
    path.join(path.dirname(process.execPath), 'muse'),
    path.join(home, '.local/bin/muse'),
    '/opt/homebrew/bin/muse',
    '/usr/local/bin/muse',
    '/usr/bin/muse',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  return 'muse';
}

const MUSE_BIN = resolveMuseBin();

function mapItemStatus(status) {
  switch (String(status || '')) {
    case 'inProgress': return 'in_progress';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'rejected': return 'failed';
    case 'timedOut': return 'failed';
    default: return String(status || 'in_progress');
  }
}

/** Item kinds that describe spawned children — tracked for the subagent panel. */
const CHILD_KINDS = new Set(['subagent', 'workflow', 'reminderChild']);

function childUpdateKind(kind) {
  return kind === 'workflow' ? 'msp:workflow' : kind === 'reminderChild' ? 'msp:reminder_child' : 'msp:subagent';
}

/**
 * Small, UI-safe projection of a subagent/workflow/reminderChild item. The
 * full item (notably the subagent `result` envelope and workflow `children`)
 * rides the view on every change; the panel only needs identity + state +
 * the drill-down keys (`childSessionId`, `subagentId`). Result text is
 * capped — the drill-down re-reads the child session for the full story.
 */
export function sanitizeChildItem(item) {
  if (!item || typeof item !== 'object') return null;
  const out = {
    itemId: item.itemId != null ? String(item.itemId) : null,
    kind: String(item.kind || ''),
    status: String(item.status || ''),
    turnId: item.turnId != null ? String(item.turnId) : null,
  };
  const str = (v) => (v == null ? null : String(v));
  const pick = (key) => {
    if (item[key] != null) out[key] = str(item[key]);
  };
  for (const k of ['subagentId', 'agentPath', 'role', 'objective', 'taskName', 'title', 'topic',
    'controlStatus', 'childSessionId',
    'entryId', 'scriptId', 'message', 'fallbackText', 'reminderAgentId', 'taskId',
    'generationId', 'workflowRunId']) pick(k);
  // The wire uses both casings for the per-topic header — normalize the snake
  // case onto the camelCase the renderer titles on, never both, never none.
  if (out.taskName == null && item.task_name != null) out.taskName = str(item.task_name);
  for (const k of ['depth', 'durationMs', 'revision']) {
    if (Number.isFinite(item[k])) out[k] = item[k];
  }
  if (item.result && typeof item.result === 'object') {
    out.result = {
      summary: str(item.result.summary),
      ...(typeof item.result.text === 'string' && item.result.text
        ? { text: item.result.text.slice(0, 4000), truncated: item.result.text.length > 4000 }
        : {}),
      ...(typeof item.result.errorKind === 'string' ? { errorKind: item.result.errorKind } : {}),
    };
  }
  if (Array.isArray(item.children)) {
    // Workflow children: folded per-child state, re-emitted whole — small.
    out.children = item.children.map((c) => (c && typeof c === 'object' ? {
      childId: str(c.childId),
      attempt: Number.isFinite(c.attempt) ? c.attempt : null,
      label: str(c.label),
      phase: str(c.phase),
      status: str(c.status),
      durationMs: Number.isFinite(c.durationMs) ? c.durationMs : null,
      ...(c.terminal && typeof c.terminal === 'object' ? { terminal: str(c.terminal.terminal ?? c.terminal) } : {}),
    } : null)).filter(Boolean);
  }
  if (item.usage && typeof item.usage === 'object') out.usage = item.usage;
  return out;
}

/**
 * Wire-true todo entries onto the codebase's snake_case plan vocabulary.
 * The MSP schema (TodoItem) sends `{ text, status, activeForm? }` with
 * camelCase statuses (`pending|inProgress|completed|cancelled`) — tools
 * already normalize `inProgress`→`in_progress` at this same boundary
 * (mapItemStatus), and every renderer (rail, chips, turn-view) reads snake,
 * so todos do the same. Passing camelCase through painted every running
 * todo as "waiting" (97 real stored entries confirm the wire is camel).
 */
export function normalizeTodoItems(items) {
  return (Array.isArray(items) ? items : []).map((t) => {
    const raw = String(t?.status ?? 'pending');
    const entry = {
      content: String(t?.content ?? t?.text ?? t?.title ?? ''),
      status: raw === 'inProgress' ? 'in_progress' : raw,
    };
    if (t?.activeForm != null && String(t.activeForm).trim() !== '') {
      entry.activeForm = String(t.activeForm);
    }
    return entry;
  });
}

/**
 * UI-safe projection of a session goal block. `null` passes through as the
 * clear; over-long model text is capped — the panel shows the objective in
 * full up to 4k, past that the transcript has it.
 */
export function sanitizeGoal(goal) {
  if (goal == null) return null;
  if (typeof goal !== 'object') return null;
  const str = (v, max = 4000) => {
    if (v == null) return null;
    const s = String(v);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  };
  return {
    objective: str(goal.objective) ?? '',
    percentComplete: Number.isFinite(goal.percentComplete) ? goal.percentComplete : 0,
    status: String(goal.status ?? ''),
    currentWork: str(goal.currentWork),
    nextWork: str(goal.nextWork),
  };
}

/**
 * UI-safe projection of the subscription usage payload (shared by
 * `usage/read` and `usage/changed`). Verbatim percents — over-100 is valid.
 */
export function sanitizeSubscriptionUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const block = (b, withDuration) => {
    if (!b || typeof b !== 'object') return null;
    if (!Number.isFinite(b.usedPercent) || b.usedPercent < 0) return null;
    if (!Number.isFinite(b.resetsAtMs)) return null;
    const out = { usedPercent: b.usedPercent, resetsAtMs: b.resetsAtMs };
    if (withDuration) {
      if (!Number.isFinite(b.windowDurationMins) || b.windowDurationMins <= 0) return null;
      out.windowDurationMins = b.windowDurationMins;
    }
    return out;
  };
  const window = block(u.window, true);
  const weekly = block(u.weekly, false);
  if (!window || !weekly) return null;
  if (!Number.isFinite(u.observedAtMs)) return null;
  return {
    tier: String(u.tier ?? ''),
    observedAtMs: u.observedAtMs,
    window,
    weekly,
  };
}

/** Args keys that carry a human topic, in preference order — the agent's
 * own one-line summary of the call. These win over the raw command/path
 * so tool rows read as headings, not debug dumps. */
const TOOL_TOPIC_KEYS = [
  'description', 'summary', 'topic', 'title', 'prompt', 'objective', 'task_name', 'label',
];
/** Technical args keys used only when no human topic exists. */
const TOOL_TECH_KEYS = ['command', 'cmd', 'path', 'file', 'file_path', 'pattern', 'url'];
const TOOL_PATH_KEYS = new Set(['path', 'file', 'file_path']);

function oneLineText(value, max) {
  if (value == null) return '';
  const s = String(typeof value === 'string' ? value : JSON.stringify(value))
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, max);
}

/**
 * Display title for a toolCall row: the human topic when the agent gave
 * one (`description`, `objective`, `task_name`, …), else a SHORT technical
 * label — basename for paths, first line for commands — never a raw JSON
 * dump. A topic stands alone without the tool-name prefix: the row's kind
 * chip and the status verb already say which tool ran, and prefixing both
 * reads "กำลังรัน Bash ls …".
 */
export function toolTitle(tool, args) {
  const name = String(tool || 'tool');
  let parsed = null;
  if (args && typeof args === 'object') {
    parsed = args;
  } else if (typeof args === 'string' && args.trim() !== '') {
    try {
      const p = JSON.parse(args);
      if (p && typeof p === 'object') parsed = p;
    } catch {
      /* verbatim-almost-JSON — fall through to the raw slice */
    }
  }
  if (parsed) {
    for (const key of TOOL_TOPIC_KEYS) {
      const topic = oneLineText(parsed[key], 120);
      if (topic) return topic;
    }
    for (const key of TOOL_TECH_KEYS) {
      if (parsed[key] == null || parsed[key] === '') continue;
      let s = oneLineText(parsed[key], TOOL_PATH_KEYS.has(key) ? 120 : 80);
      if (TOOL_PATH_KEYS.has(key)) {
        // Deep paths collapse to the file the user recognizes.
        const segs = s.split(/[\\/]/).filter(Boolean);
        if (segs.length) s = segs[segs.length - 1].slice(0, 80);
      }
      if (s) return `${name} ${s}`;
    }
    return name;
  }
  if (!args) return name;
  const flat = oneLineText(args, 80);
  return flat ? `${name} ${flat}` : name;
}

export class MspClient extends EventEmitter {
  constructor({
    cwd,
    model = null,
    effort = null,
    alwaysApprove = true,
    sessionMode = null,
    env = process.env,
  }) {
    super();
    this.cwd = cwd;
    this.model = model;
    this.effort = effort;
    this.sessionMode = sessionMode
      ? normalizeSessionMode(sessionMode)
      : alwaysApprove === false
        ? 'normal'
        : 'always';
    this.alwaysApprove = sessionModeAlwaysApprove(this.sessionMode);
    this.permissionStickyApprove = false;
    this.env = env;

    this.proc = null;
    this.sessionId = null;
    this.modelId = null;
    this.status = 'idle';
    this.lastError = null;
    this.availableCommands = [];
    this.contextMax = 200_000;

    this.initializeResult = null;
    this.agentCapabilities = {};
    this.authMethods = [];
    this.agentInfo = null;
    /** Pseudo configOptions in the ACP shape, built from model/list + the
     * static reasoning tiers — the config picker path stays identical. */
    this.configOptions = [];
    this.modelCatalog = [];
    this.currentModeId = null;
    this.authRequired = false;

    /** interaction id → { resolve, reject, kind, ... } — same role as the
     * ACP _permWaiters: the waiter that unblocks the agent on resolve. */
    this._permWaiters = new Map();
    /** itemId → { kind, text, output } — item/delta frames carry no kind,
     * so started frames teach the router what each item is. */
    this._items = new Map();
    /** The in-flight turn: { mspTurnId, resolve, reject, text }. */
    this._activeTurn = null;

    this._pending = new Map();
    this._nextId = 1;
    this._closing = false;
    this._cancelRequested = false;
    this._sessionReady = false;
    /** True once view/subscribe is confirmed — prompt() refuses to run deaf. */
    this.subscribed = false;
  }

  /**
   * ACK-safe approval decision. The waiter survives until the host acks
   * `approval/decide` (or the call fails): resolving the card before the
   * ack is what used to paint answered cards over parked agents. The
   * caller (sessions.submitInteraction) owns idempotency — it passes the
   * stored commandId on uncertain retries so the host dedupes by its
   * SS3.1.1 handle. Rejects with the RPC error; never resolves falsely.
   *
   * Multi-stage approvals (schema ApprovalDecideResult.terminal): a
   * terminal:false ack ACCEPTED the decision but the approval stays
   * pending — the waiter and the card stay, and the follow-up
   * approval/request refreshes the choices. Only a terminal:true ack
   * drops the waiter. The sticky flag engages only after a validated
   * accepted APPROVE decision, never before the RPC.
   */
  async decideApproval(approvalId, choiceId, { commandId = null } = {}) {
    const id = String(approvalId || '');
    const wait = this._permWaiters.get(id);
    if (!wait || wait.kind !== 'approval') {
      const err = new Error(`no pending approval ${id}`);
      err.code = 'NO_WAIT';
      throw err;
    }
    const picked = (wait.choices || []).find((c) => String(c?.choiceId) === String(choiceId));
    if (!picked) {
      // Policy gate, second layer (sessions validates first): never decide
      // blind. An unknown choice is a caller bug, not a deny.
      const err = new Error(`unknown choice ${choiceId} for approval ${id}`);
      err.code = 'UNKNOWN_CHOICE';
      throw err;
    }
    const cid = commandId || uuidv7();
    const stage = wait.requirementId ?? null;
    let res;
    try {
      res = await this.request('approval/decide', {
        approvalId: wait.approvalId,
        choiceId: String(picked.choiceId),
        requirementId: stage,
        sessionId: this.sessionId,
        commandId: cid,
      });
    } catch (err) {
      // Loud, never swallowed — and the waiter STAYS, so the card stays
      // answerable and the retry reuses this commandId.
      this.emit('stderr', `[msp] approval/decide FAILED id=${id}: ${err?.message || err}\n`);
      err.commandId = cid;
      err.stage = stage;
      throw err;
    }
    // Validate the ack — a malformed result is a failure, not a success.
    // (status accepted + terminal boolean + id echoes, per the schema.)
    const badAck = res?.status !== 'accepted'
      || typeof res?.terminal !== 'boolean'
      || (res.approvalId != null && String(res.approvalId) !== id)
      || (res.commandId != null && String(res.commandId) !== cid);
    if (badAck) {
      const err = new Error(`approval/decide ack invalid for ${id}`);
      err.code = 'BAD_ACK';
      err.commandId = cid;
      err.stage = stage;
      this.emit('stderr', `[msp] approval/decide BAD_ACK id=${id}: ${JSON.stringify(res)}\n`);
      throw err;
    }
    if (mspChoiceIsSticky(picked) && mspDecisionIsApprove(picked.decision)) {
      this.permissionStickyApprove = true;
    }
    this.emit('diag', `[msp] approval/decide ok id=${id} choice=${picked.choiceId} terminal=${res.terminal}\n`);
    if (res.terminal) {
      this._permWaiters.delete(id);
      try { wait.resolve(String(picked.choiceId)); } catch { /* ignore */ }
    }
    return {
      choiceId: String(picked.choiceId),
      commandId: cid,
      status: res.status,
      terminal: res.terminal,
      stage,
    };
  }

  /**
   * ACK-safe question answer. `answers` is the validated full set (one
   * entry per question — sessions.validate first). Same contract as
   * decideApproval: waiter until ack, caller-owned commandId for
   * idempotent retries, rejection propagates with the RPC attached.
   */
  async answerUserInput(userInputId, answers, { commandId = null } = {}) {
    const id = String(userInputId || '');
    const wait = this._permWaiters.get(id);
    if (!wait || wait.kind !== 'userInput') {
      const err = new Error(`no pending question ${id}`);
      err.code = 'NO_WAIT';
      throw err;
    }
    const cid = commandId || uuidv7();
    let res;
    try {
      res = await this.request('userInput/answer', {
        userInputId: wait.userInputId,
        sessionId: this.sessionId,
        commandId: cid,
        answers,
      });
    } catch (err) {
      this.emit('stderr', `[msp] userInput/answer FAILED id=${id}: ${err?.message || err}\n`);
      err.commandId = cid;
      throw err;
    }
    // Validate the ack (schema UserInputAnswerResult): status accepted +
    // id echoes. A malformed result is a failure — never a substituted
    // success — and the waiter stays for the retry.
    if (res?.status !== 'accepted'
      || (res.commandId != null && String(res.commandId) !== cid)
      || (res.userInputId != null && String(res.userInputId) !== id)) {
      const err = new Error(`userInput/answer ack invalid for ${id}`);
      err.code = 'BAD_ACK';
      err.commandId = cid;
      this.emit('stderr', `[msp] userInput/answer BAD_ACK id=${id}: ${JSON.stringify(res)}\n`);
      throw err;
    }
    this._permWaiters.delete(id);
    this.emit('diag', `[msp] userInput/answer ok id=${id} n=${answers.length}\n`);
    try { wait.resolve(answers); } catch { /* ignore */ }
    return { commandId: cid, status: res.status, answers };
  }

  /**
   * ACK-safe explicit cancel of one question. A reason is always sent —
   * the schema marks it optional but binary 1.4.2 rejects a reason-less
   * cancel (`missing field 'reason'`), the f381a7e1 wedge (BUG-084).
   */
  async cancelUserInput(userInputId, reason, { commandId = null } = {}) {
    const id = String(userInputId || '');
    const wait = this._permWaiters.get(id);
    if (!wait || wait.kind !== 'userInput') {
      const err = new Error(`no pending question ${id}`);
      err.code = 'NO_WAIT';
      throw err;
    }
    const cid = commandId || uuidv7();
    let res;
    try {
      res = await this.request('userInput/cancel', {
        userInputId: wait.userInputId,
        sessionId: this.sessionId,
        commandId: cid,
        reason: String(reason || 'declined in Muse Desktop'),
      });
    } catch (err) {
      this.emit('stderr', `[msp] userInput/cancel FAILED id=${id}: ${err?.message || err}\n`);
      err.commandId = cid;
      throw err;
    }
    // Same ack validation as answers (schema UserInputCancelResult).
    if (res?.status !== 'accepted'
      || (res.commandId != null && String(res.commandId) !== cid)
      || (res.userInputId != null && String(res.userInputId) !== id)) {
      const err = new Error(`userInput/cancel ack invalid for ${id}`);
      err.code = 'BAD_ACK';
      err.commandId = cid;
      this.emit('stderr', `[msp] userInput/cancel BAD_ACK id=${id}: ${JSON.stringify(res)}\n`);
      throw err;
    }
    this._permWaiters.delete(id);
    this.emit('diag', `[msp] userInput/cancel ok id=${id}\n`);
    try { wait.resolve(null); } catch { /* ignore */ }
    return { commandId: cid, status: res.status };
  }

  /**
   * Engagement note for a timed prompt (schema userInput/engaged):
   * fire-and-forget, no commandId, no result — the host disarms that
   * prompt's auto-resolution countdown. Sent at most once per id; a
   * dead stdin must never throw the UI path that reports engagement.
   */
  engageUserInput(userInputId) {
    const id = String(userInputId || '');
    if (!id || !this.sessionId) return false;
    if (!this._engagedIds) this._engagedIds = new Set();
    if (this._engagedIds.has(id)) return true;
    this._engagedIds.add(id);
    try {
      this.notify('userInput/engaged', { sessionId: this.sessionId, userInputId: id });
    } catch (err) {
      this.emit('stderr', `[msp] userInput/engaged not sent id=${id}: ${err?.message || err}\n`);
      return false;
    }
    return true;
  }

  /**
   * Shutdown/sweep path for one interactive waiter (settleTurn, client
   * release): un-park the agent best-effort — a deny decide for approvals,
   * a cancel for questions — then drop the waiter. Best-effort only: the
   * turn is already settling, so there is no flight to await and no card
   * left to keep truthful. Returns false when nothing was waiting.
   */
  cancelInteractive(id, reason = 'turn settled') {
    const wait = this._permWaiters.get(String(id || ''));
    if (!wait) return false;
    this._permWaiters.delete(String(id));
    if (wait.kind === 'approval') {
      const deny = pickMspDenyChoice(wait.choices || []);
      if (deny) {
        this.request('approval/decide', {
          approvalId: wait.approvalId,
          choiceId: String(deny.choiceId),
          requirementId: wait.requirementId,
          sessionId: this.sessionId,
          commandId: uuidv7(),
        }).then(
          () => this.emit('diag', `[msp] approval/decide ok id=${wait.approvalId} (sweep deny)\n`),
          (err) => this.emit('stderr', `[msp] approval/decide FAILED id=${wait.approvalId} (sweep): ${err?.message || err}\n`),
        );
      }
      try { wait.resolve('reject'); } catch { /* ignore */ }
      return true;
    }
    if (wait.kind === 'userInput') {
      this.request('userInput/cancel', {
        userInputId: wait.userInputId,
        sessionId: this.sessionId,
        commandId: uuidv7(),
        reason: String(reason || 'turn settled'),
      }).then(
        () => this.emit('diag', `[msp] userInput/cancel ok id=${wait.userInputId} (sweep)\n`),
        (err) => this.emit('stderr', `[msp] userInput/cancel FAILED id=${wait.userInputId} (sweep): ${err?.message || err}\n`),
      );
      try { wait.resolve(null); } catch { /* ignore */ }
      return true;
    }
    try { wait.resolve(null); } catch { /* ignore */ }
    return true;
  }

  _emitError(err) {
    // 'error' on an EventEmitter throws when nobody listens — a bare client
    // (unit tests, smoke scripts) must not die on a background failure.
    // Production always attaches a listener via SessionManager._bindClient.
    if (this.listenerCount('error')) this.emit('error', err);
    else this.emit('stderr', `[msp-client error] ${err?.message || err}\n`);
  }

  _rejectInteractiveWaiters(err) {
    for (const [, w] of this._permWaiters) {
      try { w.reject(err); } catch { /* ignore */ }
    }
    this._permWaiters.clear();
  }

  _onProcExit(code, signal) {
    this.setStatus('exited', { code, signal });
    this.emit('exit', { code, signal });
    const exitErr = new Error('agent exited');
    exitErr.code = 'AGENT_EXITED';
    for (const [, p] of this._pending) {
      try { p.reject(exitErr); } catch { /* ignore */ }
    }
    this._pending.clear();
    this._rejectInteractiveWaiters(exitErr);
    if (this._activeTurn) {
      const t = this._activeTurn;
      this._activeTurn = null;
      try { t.reject(exitErr); } catch { /* ignore */ }
    }
  }

  /**
   * UI modes onto the closed ApprovalMode vocabulary. Static — unlike ACP
   * agents, MSP hosts do not advertise mode ids per version.
   */
  resolveModeId(mode) {
    return sessionModeToMspApprovalMode(mode);
  }

  async setSessionMode(mode) {
    const next = normalizeSessionMode(mode);
    this.sessionMode = next;
    this.alwaysApprove = sessionModeAlwaysApprove(next);
    const modeId = this.resolveModeId(next);

    if (this.sessionId && this.proc && !this._closing) {
      try {
        await this.request('session/setApprovalMode', {
          sessionId: this.sessionId,
          commandId: uuidv7(),
          mode: modeId,
        });
        this.currentModeId = modeId;
      } catch (err) {
        this.emit('stderr', `session/setApprovalMode failed: ${err?.message || err}\n`);
      }
    }

    this.emit('mode', {
      sessionMode: this.sessionMode,
      alwaysApprove: this.alwaysApprove,
    });
    return {
      sessionMode: this.sessionMode,
      alwaysApprove: this.alwaysApprove,
    };
  }

  _buildConfigOptions() {
    const models = (this.modelCatalog || [])
      .map((m) => String(m?.modelId || ''))
      .filter(Boolean);
    return [
      {
        id: 'model',
        name: 'Model',
        currentValue: this.modelId || this.model || null,
        options: models.map((value) => {
          const row = this.modelCatalog.find((m) => String(m?.modelId) === value) || {};
          return { value, name: row.displayLabel || value };
        }),
      },
      {
        id: 'thinking',
        name: 'Thinking',
        currentValue: this.effort || null,
        options: REASONING_TIERS.map((value) => ({ value })),
      },
    ];
  }

  _refreshConfigOptions() {
    this.configOptions = this._buildConfigOptions();
  }

  /**
   * The model + thinking selects a picker UI needs. Same normalized shape
   * as the ACP client: { model: {id, currentValue, values} | null,
   * thinking: {...} | null }.
   */
  configSelects() {
    const pick = (kind) => {
      const option = (this.configOptions || []).find(
        (o) => String(o?.id ?? o?.configId ?? '').toLowerCase() === kind,
      );
      if (!option) return null;
      const rows = Array.isArray(option.options)
        ? option.options
        : Array.isArray(option.values)
          ? option.values
          : [];
      const values = rows
        .map((v) => (typeof v === 'string' ? v : String(v?.value ?? v?.id ?? v?.optionId ?? '')))
        .filter(Boolean);
      return {
        id: String(option.id ?? option.configId),
        currentValue: option.currentValue ?? null,
        values,
      };
    };
    return { model: pick('model'), thinking: pick('thinking') };
  }

  /**
   * Change one select (model | thinking) on the LIVE session and return the
   * fresh selects. Model validates against model/list; thinking validates
   * against the schema's closed tier vocabulary. Rejections carry
   * `.status = 400` so the route answers a clean 400 instead of a 500.
   */
  async setConfigOption(kind, value) {
    const bad = (msg) => {
      const err = new Error(msg);
      err.status = 400;
      return err;
    };
    if (kind !== 'model' && kind !== 'thinking') throw bad(`unknown configId ${kind}`);
    const v = String(value ?? '');
    if (!v) throw bad(`empty value for ${kind}`);
    if (!this.sessionId || !this.proc || this._closing) throw bad('no live agent session');
    if (kind === 'model') {
      const ids = (this.modelCatalog || []).map((m) => String(m?.modelId || '')).filter(Boolean);
      if (ids.length && !ids.includes(v)) {
        throw bad(`model=${v} not advertised (${ids.join('/')})`);
      }
      await this.request('session/setModel', {
        sessionId: this.sessionId,
        commandId: uuidv7(),
        model: { modelId: v },
      });
      this.model = v;
      this.modelId = v;
    } else {
      if (!REASONING_TIERS.includes(v)) {
        throw bad(`thinking=${v} not advertised (${REASONING_TIERS.join('/')})`);
      }
      await this.request('session/setReasoningEffort', {
        sessionId: this.sessionId,
        commandId: uuidv7(),
        reasoningEffort: v,
      });
      this.effort = v;
    }
    this._refreshConfigOptions();
    return this.configSelects();
  }

  /**
   * Push the configured model + reasoning effort onto the live session.
   * Advisory like the mode set: an unadvertised value is skipped with a
   * stderr note, never a session failure.
   */
  async applySessionConfig() {
    if (!this.sessionId || !this.proc || this._closing) return;
    if (this.model) {
      const ids = (this.modelCatalog || []).map((m) => String(m?.modelId || '')).filter(Boolean);
      if (ids.length && !ids.includes(this.model)) {
        this.emit('stderr', `config model=${this.model} not advertised (${ids.join('/')}); skipped\n`);
      } else if (this.modelId !== this.model) {
        try {
          await this.setConfigOption('model', this.model);
        } catch (err) {
          this.emit('stderr', `session/setModel ${this.model} failed: ${err?.message || err}\n`);
        }
      }
    }
    if (this.effort) {
      if (!REASONING_TIERS.includes(this.effort)) {
        this.emit('stderr', `config thinking=${this.effort} not advertised (${REASONING_TIERS.join('/')}); skipped\n`);
      } else {
        try {
          await this.setConfigOption('thinking', this.effort);
        } catch (err) {
          this.emit('stderr', `session/setReasoningEffort ${this.effort} failed: ${err?.message || err}\n`);
        }
      }
    }
  }

  buildArgv() {
    // Durable on purpose: --no-session-log withholds view/subscribe and the
    // turn view events never flow (verified against 1.3.0).
    return ['serve', '--trust-workspace'];
  }

  spawnEnv() {
    // Finder/Dock launches strip the shell env, and on the mac direct
    // TLS is unreliable — default the child to the local PAC proxy there.
    // Linux/Guix has no PAC bridge: pointing the child at a dead
    // 127.0.0.1:39080 would break agent TLS, so the fallback is darwin-only.
    // An explicitly exported env always wins over the fallback.
    const pac = defaultPacProxy(this.env);
    return {
      ...(pac ? { HTTPS_PROXY: pac, HTTP_PROXY: pac } : {}),
      NO_PROXY: 'localhost,127.0.0.1,::1',
      ...this.env,
    };
  }

  setStatus(status, extra = {}) {
    this.status = status;
    this.emit('status', { status, ...extra });
  }

  async start({ resumeSessionId = null } = {}) {
    const argv = this.buildArgv();
    const env = this.spawnEnv();
    this.emit('spawn', {
      bin: MUSE_BIN,
      argv,
      cwd: this.cwd,
    });

    this.proc = spawn(MUSE_BIN, argv, {
      cwd: this.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.on('error', (err) => {
      this.lastError = err.message;
      this.setStatus('errored', { error: err.message });
      this._emitError( err);
    });

    this.proc.on('exit', (code, signal) => this._onProcExit(code, signal));

    this.proc.stderr?.on('data', (b) => {
      this.emit('stderr', b.toString('utf8'));
    });

    if (!this.proc.stdout) throw new Error('muse process has no stdout');
    try { this.proc.stdout.setEncoding('utf8'); } catch { /* ignore */ }

    const rl = createInterface({
      input: this.proc.stdout,
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => {
      void this._onLine(line);
    });

    try {
      await this._handshake(resumeSessionId);
      this.setStatus('idle');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      this.setStatus('errored', { error: msg });
      this._emitError( err);
      throw err;
    }
  }

  async _handshake(resumeSessionId) {
    const init = await this.request('initialize', {
      clientInfo: { name: 'muse_desktop', version: '1.0.0' },
    });

    this.initializeResult = init || null;
    this.agentCapabilities = { viewSubscribe: true, resume: true, approvals: true };
    this.authMethods = [];
    this.agentInfo = init?.serverInfo
      ? { name: init.serverInfo.name || 'Muse', version: init.serverInfo.version || null }
      : { name: 'Muse', version: null };
    this.emit('handshake', {
      protocolVersion: init?.schema?.version ?? 1,
      modelId: this.modelId,
      agentName: this.agentInfo.name,
      agentVersion: this.agentInfo.version,
      agentCapabilities: this.agentCapabilities,
      authMethods: this.authMethods,
      availableCommands: this.availableCommands,
    });
    this.notify('initialized');

    let loaded = false;
    if (resumeSessionId) {
      // MSP resume returns history in the RESULT (no wire replay), and we
      // keep our own transcript anyway — excludeItems keeps it lean.
      try {
        const res = await this.request('session/resume', {
          commandId: uuidv7(),
          sessionId: resumeSessionId,
          excludeItems: true,
        });
        this.sessionId = resumeSessionId;
        this.modelId = res?.session?.modelId || this.modelId;
        loaded = true;
        this.emit('session', { sessionId: this.sessionId, resumed: true, method: 'session/resume' });
      } catch (err) {
        if (isAuthRequiredError(err)) {
          this.authRequired = true;
          this.emit('auth_required', { authMethods: this.authMethods, agentInfo: this.agentInfo });
          throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        this.emit('stderr', `session/resume miss (${msg}); opening fresh session\n`);
        this.emit('load_miss', { message: msg, sessionId: resumeSessionId });
      }
    }

    if (!loaded) {
      let ns;
      try {
        ns = await this.request('session/start', {
          commandId: uuidv7(),
          workspaceRoot: this.cwd,
          approvalMode: this.resolveModeId(this.sessionMode),
          ...(this.model ? { modelId: this.model } : {}),
        });
      } catch (err) {
        if (isAuthRequiredError(err)) {
          this.authRequired = true;
          this.emit('auth_required', { authMethods: this.authMethods, agentInfo: this.agentInfo });
        }
        throw err;
      }
      if (!ns?.session?.sessionId) throw new Error('session/start did not return session.sessionId');
      this.sessionId = ns.session.sessionId;
      this.modelId = ns.session.modelId || this.modelId;
      this.emit('session', {
        sessionId: this.sessionId,
        resumed: false,
        configOptions: this.configOptions,
      });
    }

    this.authRequired = false;
    // Load-bearing, not advisory: without a subscription the server never
    // pushes view events and every turn hangs deaf (chat 81442763 held two
    // already-completed runs open forever). Fail the whole spawn LOUD — a
    // client that cannot hear the agent must never look healthy.
    await this.ensureSubscribed();
    try {
      const catalog = await this.request('model/list', { sessionId: this.sessionId });
      if (Array.isArray(catalog?.models)) this.modelCatalog = catalog.models;
    } catch {
      /* a missing catalog only narrows validation, never the session */
    }
    this._refreshConfigOptions();
    try {
      await this.setSessionMode(this.sessionMode);
    } catch { /* mode is advisory — a failure here must not sink the session */ }
    try {
      await this.applySessionConfig();
    } catch { /* model/effort are advisory too — never sink the session */ }

    this._sessionReady = true;
  }

  /**
   * Subscribe to the session's view events, retrying transient failures.
   * Throws when the channel cannot be established: the handshake treats this
   * as a fatal spawn failure (a client that cannot hear the agent must never
   * serve prompts). Every failed attempt emits on 'stderr' so it stays
   * visible in the UI + host log instead of dying silently.
   */
  async ensureSubscribed({ attempts = 3, delayMs = 500 } = {}) {
    let lastErr = null;
    for (let i = 1; i <= attempts; i++) {
      try {
        await this.request('view/subscribe', { sessionId: this.sessionId });
        this.subscribed = true;
        return true;
      } catch (err) {
        lastErr = err;
        this.emit('stderr', `view/subscribe attempt ${i}/${attempts} failed: ${err?.message || err}\n`);
        if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    const e = new Error(
      `view/subscribe failed after ${attempts} attempts (${lastErr?.message || lastErr}) — the agent would run deaf: no stream, no completion`,
    );
    e.code = 'SUBSCRIBE_FAILED';
    throw e;
  }

  _send(msg) {
    if (!this.proc?.stdin?.writable) throw new Error('agent stdin not writable');
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  request(method, params, opts = {}) {
    const id = `c-${this._nextId++}`;
    // Unlike ACP's session/prompt (which holds the RPC open for the whole
    // turn), every MSP call admits fast — completion arrives as a
    // notification. One timeout fits all.
    const timeoutMs = opts.timeoutMs ?? 30_000;

    const promise = new Promise((resolve, reject) => {
      let timer = null;
      const clearTimer = () => {
        if (timer != null) {
          clearTimeout(timer);
          timer = null;
        }
      };
      const entry = {
        method,
        resolve: (v) => { clearTimer(); resolve(v); },
        reject: (e) => { clearTimer(); reject(e); },
      };
      this._pending.set(id, entry);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!this._pending.has(id)) return;
          this._pending.delete(id);
          const e = new Error(`RPC timeout after ${timeoutMs}ms: ${method}`);
          e.code = 'RPC_TIMEOUT';
          try { entry.reject(e); } catch { /* ignore */ }
        }, timeoutMs);
        timer.unref?.();
      }
      try {
        const frame = { jsonrpc: '2.0', id, method, params };
        this.emit('wire', { dir: 'tx', frame });
        this._send(frame);
      } catch (err) {
        this._pending.delete(id);
        entry.reject(err);
      }
    });
    promise.catch(() => {});
    return promise;
  }

  notify(method, params) {
    const frame = params === undefined
      ? { jsonrpc: '2.0', method }
      : { jsonrpc: '2.0', method, params };
    this.emit('wire', { dir: 'tx', frame });
    this._send(frame);
  }

  async _onLine(line) {
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this._emitError( new Error(`non-json frame: ${line.slice(0, 120)}`));
      return;
    }

    this.emit('wire', { dir: 'rx', frame: msg });

    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
      const p = this._pending.get(msg.id);
      if (p) {
        this._pending.delete(msg.id);
        if (msg.error) {
          const e = new Error(formatRpcError(msg.error));
          e.rpc = msg.error;
          p.reject(e);
        } else {
          p.resolve(msg.result);
        }
      }
      return;
    }

    if (msg.id != null && msg.method) {
      // Server-initiated request — approval/request and userInput/request.
      // The response is a presentation receipt only; the decision travels
      // as a separate command (approval/decide, userInput/answer).
      try {
        await this._dispatch(msg.method, msg.params);
        this._send({ jsonrpc: '2.0', id: msg.id, result: {} });
      } catch (err) {
        const rpc = err?.rpc && typeof err.rpc === 'object'
          ? err.rpc
          : { code: -32603, message: err?.message || 'internal error' };
        this._send({ jsonrpc: '2.0', id: msg.id, error: rpc });
      }
      return;
    }

    if (msg.method) {
      this._onNotification(msg.method, msg.params || {});
    }
  }

  async _dispatch(method, params) {
    switch (method) {
      case 'approval/request':
        this._onApprovalFrame(params, { forceEmit: true });
        return {};
      case 'userInput/request':
        this._onUserInputFrame(params);
        return {};
      default: {
        const err = new Error(`Method not found: ${method}`);
        err.rpc = { code: -32601, message: `Method not found: ${method}` };
        throw err;
      }
    }
  }

  _onNotification(method, params) {
    switch (method) {
      case 'item/started':
      case 'item/delta':
      case 'item/updated':
      case 'item/completed':
        this._onItemEvent(method, params);
        return;
      case 'turn/started':
        this.emit('update', { sessionUpdate: 'turn_started', turnId: params?.turnId || null });
        return;
      case 'turn/completed':
        this._onTurnCompleted(params);
        return;
      case 'turn/retracted':
      case 'turn/retryScheduled':
      case 'turn/unqueued':
        this.emit('update', { sessionUpdate: `msp:${method}`, ...params });
        return;
      case 'approval/requested':
        this._onApprovalFrame(params, { forceEmit: false });
        return;
      case 'approval/updated': {
        // Fresh choices / advanced requirement for a card already mounted —
        // re-emit so the renderer re-renders it.
        const wait = this._permWaiters.get(String(params?.approvalId || ''));
        if (wait && wait.kind === 'approval') {
          wait.choices = params.availableChoices || wait.choices;
          wait.requirementId = params.currentRequirementId ?? wait.requirementId;
        }
        this._onApprovalFrame(params, { forceEmit: true });
        return;
      }
      case 'approval/resolved': {
        const id = String(params?.approvalId || '');
        this._permWaiters.delete(id);
        this.emit('permission', {
          id,
          resolved: true,
          // The wire carries NO choice identity (ApprovalResolvedParams
          // has decision + decidedByCommandId only): the decision enum
          // is the OUTCOME, never the optionId. The session layer
          // attributes our submitted choice IFF the winning command is
          // ours; anything else stays null (BUG-032 selected button).
          optionId: null,
          outcome: params?.decision != null ? String(params.decision) : 'resolved',
          decidedByCommandId: params?.decidedByCommandId ?? null,
        });
        return;
      }
      case 'userInput/requested':
        this._onUserInputFrame(params);
        return;
      case 'userInput/settled': {
        // The authoritative settlement (schema UserInputSettledParams):
        // outcome ∈ answered|cancelled|interrupted|clarified|timedOut|
        // aborted, plus the winning commandId. Forwarded verbatim — the
        // card must show what actually happened, never a blanket
        // 'answered' (a timedOut prompt is not an answered one).
        const id = String(params?.userInputId || '');
        this._permWaiters.delete(id);
        this._cancelledIds?.delete(id);
        this._engagedIds?.delete(id);
        this.emit('permission', {
          id,
          resolved: true,
          // Questions have no single choice identity on the wire — the
          // outcome enum is the OUTCOME (answers carry the detail), never
          // the optionId. Unknown choice stays null, outcome separate.
          optionId: null,
          outcome: String(params?.outcome || 'answered'),
          decidedByCommandId: params?.decidedByCommandId ?? null,
          reason: params?.reason ?? null,
          answers: Array.isArray(params?.answers) ? params.answers : null,
        });
        return;
      }
      case 'session/todoListChanged': {
        const items = params?.items ?? params?.todos ?? params?.todoList;
        if (Array.isArray(items)) {
          this.emit('update', {
            sessionUpdate: 'plan',
            entries: normalizeTodoItems(items),
          });
        } else {
          this.emit('update', { sessionUpdate: 'msp:session/todoListChanged', ...params });
        }
        return;
      }
      case 'session/modelChanged':
        if (params?.modelId) this.modelId = String(params.modelId);
        this._refreshConfigOptions();
        this.emit('update', { sessionUpdate: 'config_option_update', configOptions: this.configOptions });
        return;
      case 'session/reasoningEffortChanged': {
        const v = params?.reasoningEffort ?? params?.effort ?? params?.value;
        if (v) this.effort = String(v);
        this._refreshConfigOptions();
        this.emit('update', { sessionUpdate: 'config_option_update', configOptions: this.configOptions });
        return;
      }
      case 'session/approvalModeChanged':
        this.emit('update', {
          sessionUpdate: 'current_mode_update',
          currentModeId: params?.mode ?? params?.approvalMode ?? null,
        });
        return;
      case 'session/goalChanged': {
        // Replace wholesale; explicit null clears. An absent `goal` key is
        // not a change — never clear on it.
        if (!params || !('goal' in params)) return;
        this.emit('update', { sessionUpdate: 'msp:goal', goal: sanitizeGoal(params.goal) });
        return;
      }
      case 'session/contextUsage': {
        if (!params || !Number.isFinite(params.usedTokens)) return;
        // windowTokens is absent when the basis has no limit — the UI omits
        // the limit part, never invents one (schema tdd SS4.6.6).
        this.emit('update', {
          sessionUpdate: 'msp:ctx',
          ctx: {
            usedTokens: Math.max(0, params.usedTokens),
            windowTokens: Number.isFinite(params.windowTokens) && params.windowTokens > 0
              ? params.windowTokens
              : null,
            pressure: String(params.pressure || 'normal'),
          },
        });
        return;
      }
      case 'usage/changed': {
        const u = sanitizeSubscriptionUsage(params);
        if (!u) return;
        this.emit('update', { sessionUpdate: 'msp:usage', usage: u });
        return;
      }
      case 'session/tokenUsage': {
        const c = params?.cumulative;
        if (!c || typeof c !== 'object') return;
        const num = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
        this.emit('update', {
          sessionUpdate: 'msp:tokens',
          tokens: {
            promptTokens: num(c.promptTokens),
            outputTokens: num(c.outputTokens),
            totalTokens: num(c.totalTokens),
          },
        });
        return;
      }
      default:
        // session/*, usage/*, view/gap and future channels are forwarded,
        // not swallowed — a silently discarded channel is invisible until
        // someone notices a feature has never worked.
        this.emit('update', { sessionUpdate: `msp:${method}`, ...params });
    }
  }

  _trackItem(item, { fresh = false } = {}) {
    if (!item || item.itemId == null) return null;
    const id = String(item.itemId);
    let rec = this._items.get(id);
    if (!rec) {
      rec = { kind: String(item.kind || ''), text: '', output: '' };
      this._items.set(id, rec);
    }
    if (item.kind) rec.kind = String(item.kind);
    // A fresh open resets the accumulators — ids are routinely reused
    // across turns, and a stale span would corrupt the turn total.
    if (fresh) {
      rec.text = '';
      rec.output = '';
    }
    return rec;
  }

  _onItemEvent(method, params) {
    const item = params?.item && typeof params.item === 'object' ? params.item : null;
    const itemId = String(params?.itemId ?? item?.itemId ?? '');
    if (method === 'item/started' && item) {
      const rec = this._trackItem(item, { fresh: true });
      if (rec?.kind === 'toolCall') {
        this.emit('update', {
          sessionUpdate: 'tool_call',
          toolCallId: itemId,
          title: toolTitle(item.tool, item.args),
          kind: item.tool ? String(item.tool) : 'tool',
          status: mapItemStatus(item.status),
          rawInput: item.args ?? null,
        });
      } else if (rec?.kind === 'userMessage') {
        // Echo of what we just sent — drop it, or every message appears twice.
      } else if (CHILD_KINDS.has(rec?.kind)) {
        // Spawned children feed the subagent panel, never the transcript.
        this.emit('update', {
          sessionUpdate: childUpdateKind(rec.kind),
          itemId,
          item: sanitizeChildItem(item),
        });
      } else {
        // agentMessage / reasoning / ... opens are liveness; their content
        // arrives as deltas + the completed object.
        this.emit('update', { sessionUpdate: 'msp:item/started', itemId, kind: rec?.kind || '' });
      }
      return;
    }
    if (method === 'item/delta') {
      const rec = this._items.get(itemId) || { kind: '', text: '', output: '' };
      if (!this._items.has(itemId)) this._items.set(itemId, rec);
      const delta = String(params?.delta ?? '');
      if (!delta) return;
      const field = String(params?.field ?? 'text');
      const kind = rec.kind
        || (field.startsWith('summary') ? 'reasoning' : field === 'output' ? 'toolCall' : 'agentMessage');
      if (!rec.kind) rec.kind = kind;
      if (kind === 'reasoning') {
        rec.text += delta;
        this.emit('update', {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: delta },
        });
        return;
      }
      if (kind === 'toolCall') {
        rec.output += delta;
        this.emit('update', {
          sessionUpdate: 'tool_call_update',
          toolCallId: itemId,
          status: 'in_progress',
          rawOutput: rec.output,
        });
        return;
      }
      if (kind === 'userMessage') return; // prompt echo — drop
      if (CHILD_KINDS.has(kind)) {
        // A child's streaming text is its own story — routing it into the
        // parent's message would corrupt the turn transcript. The panel
        // picks it up as live activity instead.
        this.emit('update', {
          sessionUpdate: 'msp:subagent_delta',
          itemId,
          kind,
          field,
          delta,
        });
        return;
      }
      rec.text += delta;
      if (this._activeTurn) this._activeTurn.text += delta;
      this.emit('update', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: delta },
      });
      return;
    }
    if (method === 'item/updated' && item) {
      const rec = this._trackItem(item);
      if (rec?.kind === 'toolCall') {
        this.emit('update', {
          sessionUpdate: 'tool_call_update',
          toolCallId: itemId,
          title: toolTitle(item.tool, item.args),
          kind: item.tool ? String(item.tool) : 'tool',
          status: mapItemStatus(item.status),
          rawInput: item.args ?? null,
          rawOutput: rec.output || undefined,
        });
      } else if (CHILD_KINDS.has(rec?.kind)) {
        this.emit('update', {
          sessionUpdate: childUpdateKind(rec.kind),
          itemId,
          item: sanitizeChildItem(item),
        });
      } else {
        this.emit('update', { sessionUpdate: 'msp:item/updated', itemId, kind: rec?.kind || '' });
      }
      return;
    }
    if (method === 'item/completed' && item) {
      const rec = this._trackItem(item);
      const kind = rec?.kind || '';
      if (kind === 'toolCall') {
        // Instant tools (subagent_spawn/wait, reads) never stream deltas —
        // their whole output arrives here as visibleOutput. Streamed tools
        // already filled rec.output from deltas and keep winning, so live
        // rows never shrink to the bounded transcript text.
        const output = rec.output || String(item.visibleOutput || item.fallbackText || '');
        this.emit('update', {
          sessionUpdate: 'tool_call_update',
          toolCallId: itemId,
          title: toolTitle(item.tool, item.args),
          kind: item.tool ? String(item.tool) : 'tool',
          status: mapItemStatus(item.status),
          rawInput: item.args ?? null,
          ...(output ? { content: [{ type: 'text', text: output }], rawOutput: output } : {}),
        });
        return;
      }
      if (kind === 'agentMessage') {
        // The completed object is authoritative FOR THIS ITEM: reconcile the
        // span its deltas contributed so the turn total is exact — replace
        // when the item's text sits at the end, append when it arrived
        // without deltas (or after a view gap).
        const full = typeof item.text === 'string' ? item.text : '';
        const t = this._activeTurn;
        if (t && full) {
          if (rec.text.length && t.text.endsWith(rec.text)) {
            t.text = t.text.slice(0, t.text.length - rec.text.length) + full;
          } else {
            t.text += full;
          }
          rec.text = full;
        }
        return;
      }
      if (kind === 'userMessage') return; // prompt echo — drop
      if (CHILD_KINDS.has(kind)) {
        this.emit('update', {
          sessionUpdate: childUpdateKind(kind),
          itemId,
          item: sanitizeChildItem(item),
        });
        return;
      }
      this.emit('update', { sessionUpdate: 'msp:item/completed', itemId, kind });
      return;
    }
    this.emit('update', { sessionUpdate: `msp:${method}`, ...params });
  }

  _onApprovalFrame(params, { forceEmit = true } = {}) {
    this.emit('diag', `[msp] rx approval frame id=${params?.approvalId || '?'}\n`);
    const card = mspApprovalCard(params);
    if (!card) {
      this.emit('update', { sessionUpdate: 'msp:approval/unknown', ...params });
      return;
    }
    // The server may send both the request and the notification for one
    // approval — exactly one card goes up; a repeat only refreshes the
    // stored choices unless the frame is an explicit update.
    if (this.alwaysApprove || this.permissionStickyApprove) {
      const auto = pickMspApproveChoice(params?.availableChoices || []);
      if (auto) {
        // Sticky engages only after a validated accepted ack — never
        // before the RPC, and never for a non-approve pick.
        this.request('approval/decide', {
          approvalId: card.approvalId,
          choiceId: String(auto.choiceId),
          requirementId: card.requirementId,
          sessionId: this.sessionId,
          commandId: uuidv7(),
        }).then(
          (res) => {
            if (res?.status === 'accepted'
              && mspChoiceIsSticky(auto)
              && mspDecisionIsApprove(auto.decision)) {
              this.permissionStickyApprove = true;
            }
            this.emit('diag', `[msp] approval/decide ok id=${card.approvalId} (auto-approve)\n`);
          },
          (err) => this.emit('stderr', `[msp] approval/decide FAILED id=${card.approvalId}: ${err?.message || err}\n`),
        );
        return;
      }
      // No approve choice on offer — fall through to a card rather than
      // deciding blind.
    }
    const isNew = !this._permWaiters.has(card.id);
    if (isNew) {
      this._permWaiters.set(card.id, {
        kind: 'approval',
        approvalId: card.approvalId,
        requirementId: card.requirementId,
        choices: params?.availableChoices || [],
        resolve: () => {},
        reject: () => {},
      });
      const waiter = this._permWaiters.get(card.id);
      const gate = new Promise((resolve, reject) => {
        waiter.resolve = resolve;
        waiter.reject = reject;
      });
      gate.catch(() => {});
      setTimeout(() => {
        if (!this._permWaiters.has(card.id)) return;
        this._permWaiters.delete(card.id);
        const deny = pickMspDenyChoice(waiter.choices);
        if (deny) {
          this.request('approval/decide', {
            approvalId: card.approvalId,
            choiceId: String(deny.choiceId),
            requirementId: waiter.requirementId,
            sessionId: this.sessionId,
            commandId: uuidv7(),
          }).then(
            () => this.emit('diag', `[msp] approval/decide ok id=${card.approvalId} (card timeout)\n`),
            (err) => this.emit('stderr', `[msp] approval/decide FAILED id=${card.approvalId}: ${err?.message || err}\n`),
          );
        }
        this.emit('permission', {
          id: card.id,
          resolved: true,
          optionId: deny ? String(deny.choiceId) : 'reject',
          outcome: 'decided',
          reason: 'timeout',
        });
      }, 5 * 60 * 1000).unref?.();
    } else {
      const waiter = this._permWaiters.get(card.id);
      waiter.choices = params?.availableChoices || waiter.choices;
      waiter.requirementId = card.requirementId ?? waiter.requirementId;
      if (!forceEmit) return; // repeat frame, card already up
    }
    this.emit('permission', {
      id: card.id,
      toolName: card.toolName,
      toolCallId: card.toolCallId,
      summary: card.summary,
      subtype: card.subtype,
      body: card.body,
      params,
      options: card.options,
      // The multi-stage race token: the UI posts it back with its decision
      // so the server can tell a stale decision from the current stage.
      requirementId: card.requirementId ?? null,
    });
  }

  _onUserInputFrame(params) {
    this.emit('diag', `[msp] rx userInput frame id=${params?.userInputId || '?'} q=${Array.isArray(params?.questions) ? params.questions.length : '?'}\n`);
    this.recoverUserInput(params, 'live');
  }

  /**
   * Mount-or-cancel for one userInput prompt — shared by the live
   * `userInput/request(ed)` frames and the watchdog's listPending recovery
   * poll (BUG-084), so a missed frame and a live frame end identically.
   * Returns 'card' | 'cancelled' | 'duplicate' | null (no id).
   */
  recoverUserInput(params, source = 'live') {
    const userInputId = String(params?.userInputId || '');
    if (!userInputId) {
      this.emit('update', { sessionUpdate: 'msp:userInput/unknown', ...params });
      return null;
    }
    // Request + notification dedupe covers BOTH paths: the cancel path
    // creates no waiter, so without _cancelledIds the pair would double
    // the cancel RPC and the transcript notice.
    if (this._permWaiters.has(userInputId)) return 'duplicate';
    if (this._cancelledIds?.has(userInputId)) return 'duplicate';
    const card = mspUserInputCard(params);
    if (!card) {
      // Malformed frames only (no id, no questions, unknown mode) — every
      // well-formed shape mounts a form since 1.1.33. Cancelling (with a
      // visible trace) beats stranding the turn on a prompt nobody can
      // answer; the watchdog poll escalates when the agent ignores it.
      const qCount = Array.isArray(params?.questions) ? params.questions.length : 0;
      if (!this._cancelledIds) this._cancelledIds = new Set();
      this._cancelledIds.add(userInputId);
      this.emit('update', {
        sessionUpdate: 'msp:user_input_unsupported',
        userInputId,
        questions: params?.questions || [],
      });
      this.emit('diag', `[msp] userInput/cancel → id=${userInputId} q=${qCount} (${source})\n`);
      this.request('userInput/cancel', {
        userInputId,
        sessionId: this.sessionId,
        commandId: uuidv7(),
        // Load-bearing: the schema marks reason optional but binary 1.4.2
        // rejects the cancel without it (`missing field 'reason'`) — the
        // actual f381a7e1 wedge. The model sees the cancelled result, so
        // say why and what to do.
        reason: 'desktop cannot render this prompt shape; proceeding without an answer',
      }).then(
        () => this.emit('diag', `[msp] userInput/cancel ok id=${userInputId}\n`),
        (err) => this.emit('stderr', `[msp] userInput/cancel FAILED id=${userInputId}: ${err?.message || err}\n`),
      );
      return 'cancelled';
    }
    // Questions always surface — even an always-approve session cannot know
    // the answers, and cancelling them would silently change the outcome.
    // The card waits for the human by default: there is deliberately no
    // auto-cancel timer here (1.1.33 removed the silent 5-minute cancel —
    // a question the user never saw must never answer itself). The
    // watchdog still freezes while the card is mounted, and the stop
    // button / turn settle path cancels explicitly.
    this._permWaiters.set(card.id, {
      kind: 'userInput',
      userInputId: card.userInputId,
      resolve: () => {},
      reject: () => {},
    });
    const waiter = this._permWaiters.get(card.id);
    const gate = new Promise((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
    });
    gate.catch(() => {});
    this.emit('permission', {
      id: card.id,
      toolName: card.toolName,
      toolCallId: card.toolCallId,
      summary: card.summary,
      subtype: card.subtype,
      body: card.body,
      params,
      options: card.options,
      questions: card.questions,
      autoResolutionMs: card.autoResolutionMs,
    });
    return 'card';
  }

  /**
   * Mount a pending approval the live frames never delivered (BUG-084 poll).
   * forceEmit=false: a repeat only refreshes choices, exactly one card goes
   * up. Returns true when a waiter exists for the approval afterwards.
   */
  recoverApproval(params) {
    this._onApprovalFrame(params, { forceEmit: false });
    const id = String(params?.approvalId || '');
    return !!id && this._permWaiters.has(id);
  }

  /** True when a card/waiter already covers this interactive id. */
  hasInteractiveWaiter(id) {
    return this._permWaiters.has(String(id || ''));
  }

  /** Mounted interactive ids — the poll's "already handled" set. */
  interactiveWaiterIds() {
    return new Set(this._permWaiters.keys());
  }

  /**
   * Point-in-time pending approvals + userInput prompts (the pull dual of
   * the push frames). A log-fold read — safe to call on a running turn.
   */
  async listPending() {
    if (!this.sessionId) throw new Error('session not ready');
    const res = await this.request('approval/listPending', { sessionId: this.sessionId });
    return {
      approvals: Array.isArray(res?.approvals) ? res.approvals : [],
      userInputs: Array.isArray(res?.userInputs) ? res.userInputs : [],
    };
  }

  /**
   * Best-effort run interrupt WITHOUT touching the local turn waiter —
   * the escalation path settles the turn itself with its own error, and a
   * local reject here would race it into a plain 'cancelled' (BUG-084).
   */
  async interrupt() {
    if (!this.sessionId) return false;
    const turnId = this._activeTurn?.mspTurnId || null;
    try {
      await Promise.race([
        this.request('turn/interrupt', {
          commandId: uuidv7(),
          sessionId: this.sessionId,
          ...(turnId ? { turnId } : {}),
        }).catch(() => null),
        new Promise((resolve) => setTimeout(resolve, 1200)),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  _onTurnCompleted(params) {
    const t = this._activeTurn;
    if (!t) {
      this.emit('stderr', `[msp] dropped turn/completed (no active turn) turnId=${params?.turnId || 'none'} terminal=${params?.terminal || 'none'}\n`);
      return;
    }
    if (t.mspTurnId && params?.turnId && params.turnId !== t.mspTurnId) {
      this.emit('stderr', `[msp] dropped turn/completed for a superseded turn (got ${params.turnId}, live is ${t.mspTurnId})\n`);
      return;
    }
    this._activeTurn = null;
    const terminal = String(params?.terminal || '');
    if (this._cancelRequested || terminal === 'cancelled') {
      this._cancelRequested = false;
      this.setStatus('idle');
      const e = new Error('cancelled by user');
      e.cancelled = true;
      try { t.reject(e); } catch { /* ignore */ }
      return;
    }
    if (terminal === 'failed') {
      const detail = params?.error?.message || params?.reason || 'turn failed';
      this.setStatus('errored', { error: String(detail) });
      const e = new Error(String(detail));
      e.rpc = params?.error && typeof params.error === 'object' ? params.error : { message: String(detail) };
      try { t.reject(e); } catch { /* ignore */ }
      return;
    }
    this.setStatus('idle');
    this.emit('prompt_result', { turnId: params?.turnId || t.mspTurnId });
    try { t.resolve({ stopReason: 'end_turn', content: t.text }); } catch { /* ignore */ }
  }

  /**
   * @param {string} text user text (verbatim, may be '' when attachments-only)
   * @param {{ images?: Array<{base64Data,mediaType}>, mentionText?: string }} [parts]
   * Attachments ride as their own input parts — never merged into the text.
   */
  async prompt(text, parts = {}) {
    if (!this.sessionId) throw new Error('session not ready');
    if (!this.subscribed) {
      const err = new Error('session not subscribed to view events — refusing a turn the agent could never complete back');
      err.code = 'NOT_SUBSCRIBED';
      throw err;
    }
    if (this._activeTurn) {
      const err = new Error('a turn is already running for this session');
      err.code = 'TURN_IN_FLIGHT';
      throw err;
    }
    this._cancelRequested = false;
    this.setStatus('running');

    // Install the waiter BEFORE the ack: the agent can burst deltas in the
    // same stdout chunk as the ack, and a delta landing before the waiter
    // exists is dropped from the turn text while the reconciler still sees
    // the full completed object — the long-burst e2e's intermittent
    // duplication. mspTurnId fills in on ack; the null matches anything.
    let resolveTurn;
    let rejectTurn;
    const waiter = new Promise((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    waiter.catch(() => {});
    this._activeTurn = { mspTurnId: null, resolve: resolveTurn, reject: rejectTurn, text: '' };

    let ack;
    try {
      ack = await this.request('turn/start', {
        commandId: uuidv7(),
        sessionId: this.sessionId,
        input: buildTurnInput({
          text: String(text),
          images: parts.images || [],
          mentionText: parts.mentionText || '',
        }),
      });
    } catch (err) {
      // The turn never opened — uninstall the pre-ack waiter so the next
      // prompt is not stuck behind a phantom TURN_IN_FLIGHT.
      this._activeTurn = null;
      this.setStatus('idle');
      throw err;
    }
    if (this._cancelRequested) {
      // Cancel landed between the prompt call and the ack — the waiter was
      // never returned, so drop it and settle here.
      this._cancelRequested = false;
      this._activeTurn = null;
      this.setStatus('idle');
      const e = new Error('cancelled by user');
      e.cancelled = true;
      throw e;
    }
    // The turn may already have completed inside the ack chunk — then the
    // waiter is settled and uninstalled, and there is nothing to stamp.
    if (this._activeTurn) this._activeTurn.mspTurnId = ack?.turnId || null;
    return waiter;
  }

  async cancel() {
    if (!this.sessionId) return { cancelled: false };
    this._cancelRequested = true;

    const t = this._activeTurn;
    this._activeTurn = null;
    if (t) {
      const e = new Error('cancelled by user');
      e.cancelled = true;
      try { t.reject(e); } catch { /* ignore */ }
    }

    try {
      await Promise.race([
        this.request('turn/interrupt', {
          commandId: uuidv7(),
          sessionId: this.sessionId,
          ...(t?.mspTurnId ? { turnId: t.mspTurnId } : {}),
        }).catch(() => null),
        new Promise((resolve) => setTimeout(resolve, 1200)),
      ]);
    } catch { /* ignore */ }

    if (this.status === 'running') this.setStatus('idle');
    return { cancelled: true };
  }

  async shutdown(signal = 'SIGTERM') {
    if (this._closing) return;
    this._closing = true;
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill(signal); } catch { /* ignore */ }
      const proc = this.proc;
      setTimeout(() => {
        if (proc.exitCode == null && !proc.killed) {
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }, 2000).unref?.();
    }
  }
}

/**
 * Proxy fallback for spawned `muse serve` children. Pure (env + platform in,
 * URL-or-empty out) so the Guix rule is unit-testable on any platform.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {string} proxy URL, or '' for direct connection
 */
export function defaultPacProxy(env = {}, platform = process.platform) {
  if (env.SCB_PAC_PROXY) return env.SCB_PAC_PROXY;
  if (platform === 'darwin') return 'http://127.0.0.1:39080';
  return '';
}

/**
 * `muse login` runs a device-code flow in a real terminal — it cannot be
 * completed over the socket, so the UI hands it to Terminal.app.
 */
export function terminalAuthCommand() {
  return {
    id: 'login',
    label: 'Log in',
    command: MUSE_BIN,
    args: ['login'],
    env: {},
  };
}

export { MUSE_BIN };
