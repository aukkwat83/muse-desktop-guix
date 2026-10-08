// Session pool + turn core for Muse Desktop.
//
// The single most important rule in this file: **one funnel settles a turn**.
// `settleTurn()` is the only place that may emit a terminal event, and it is
// idempotent. The kimi/grok lineage learned this the hard way — three racing
// paths to "turn is over" (a stream event, the blocking HTTP response, and a
// cancel handler) left the UI showing a spinner for a finished turn, or
// painting a finished turn twice.
//
// Corollaries that follow from that rule and are enforced here:
//   - every turn has a `turnId`; late events from a superseded turn are dropped
//   - `POST /prompt` returns 202 immediately; all painting happens over SSE
//   - turn state is per-chat, never a module-level "current turn"
//   - the agent's final `turn/start` result is authoritative over the
//     accumulated stream chunks

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { MspClient, formatRpcError, isAuthRequiredError, isClientAlive, isHistoryIncompatibleError, isMcpAuditFailedError, sanitizeSubscriptionUsage, terminalAuthCommand, uuidv7 } from './msp-client.js';
import { ConfigCatalog } from './config-catalog.js';
import { classifyPendingUserInputs, formatDiffPreview } from './hosts.js';
import { normalizeSessionMode } from './session-mode.js';
import { SearchIndex, turnForMessageIndex } from './search-index.js';
import { readNativeChildTranscript } from './native-transcript.js';
import { stateDir } from './session-store.js';
import { cutEllipsis } from './text.js';
import { normalizeAttachmentInput, resolveAttachments } from './attachments.js';
import { applyApPrefixToTitle } from './ap-title.js';
import { usageCacheFile, writeUsageCache } from './usage-cache.js';

const DEFAULT_MAX_HOT = Number(process.env.MUSE_DESKTOP_MAX_HOT_AGENTS || 6);
const DEFAULT_IDLE_DEMOTE_MS = Number(process.env.MUSE_DESKTOP_IDLE_DEMOTE_MS || 30 * 60 * 1000);
/** No first activity within this window ⇒ the agent is wedged, not thinking. */
const NO_ACTIVITY_MS = Number(process.env.MUSE_DESKTOP_NO_ACTIVITY_MS || 180_000);
/** Streaming stalled this long ⇒ settle rather than spin forever. */
const STALL_MS = Number(process.env.MUSE_DESKTOP_STALL_MS || 900_000);
/**
 * Opt-in ceiling while a *live* agent still holds the turn open. Default is
 * 0 = hold forever, like `muse` CLI (the user stops a wedged turn with the
 * stop button, exactly like Ctrl-C): chat 74f04882 ran 3h09m with 22 tools
 * done and the agent silent, and the old 65 min default cut it — the user
 * wanted it alive. Set MUSE_DESKTOP_WATCHDOG_HARD_MS to a finite value
 * >= 60000 to restore an auto-settle ceiling. Resolved per tick (not a
 * frozen const) so tests can pin clocks without re-importing the module.
 */
export function resolveWatchdogHardMs() {
  const raw = process.env.MUSE_DESKTOP_WATCHDOG_HARD_MS;
  if (raw == null || String(raw).trim() === '' || raw === '0' || raw === 'false') return 0;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 60_000) return Math.floor(n);
  return 0;
}
/** Watchdog tick interval — env-overridable so tests can use short clocks. */
const WATCHDOG_TICK_MS = Number(process.env.MUSE_DESKTOP_WATCHDOG_TICK_MS || 15_000);
/**
 * Silence past this on a lively turn triggers a point-in-time
 * `approval/listPending` read (BUG-084): a live userInput/request(ed) frame
 * can go missing and the agent then waits forever on a question nobody was
 * shown. Resolved per call so tests can pin short clocks.
 */
export function resolvePendingPollMs() {
  const raw = process.env.MUSE_DESKTOP_PENDING_POLL_MS;
  if (raw == null || String(raw).trim() === '') return 45_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 45_000;
}
/**
 * How long an auto-cancelled prompt may stay pending before the watchdog
 * concludes the agent ignored the cancel and interrupts the run (BUG-084).
 * Net effect with defaults: one missed frame + one ignored cancel ⇒ loud
 * recovery in ~75s, never a silent multi-hour wedge.
 */
export function resolveCancelGraceMs() {
  const raw = process.env.MUSE_DESKTOP_CANCEL_GRACE_MS;
  if (raw == null || String(raw).trim() === '') return 30_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 30_000;
}
/**
 * Delta batching (grok-desktop: 16ms / 768 chars; we run 8ms). The agent
 * streams one RPC frame per token; forwarding each as its own SSE frame
 * burns CPU and can exhaust the 2000-frame replay ring on a long answer.
 * Accumulate per chat and flush on a short timer or a size threshold.
 * Env-tunable (and 0 = flush every chunk) so tests never wait on real time.
 */
const DELTA_FLUSH_MS = Number(process.env.MUSE_DESKTOP_DELTA_FLUSH_MS ?? 8);
const DELTA_FLUSH_CHARS = Number(process.env.MUSE_DESKTOP_DELTA_FLUSH_CHARS ?? 768);
/** Cap per recap section in the post-rotation recovery preamble. */
const RECOVERY_MAX_CHARS = 4_000;
/** Transcript notice for every history-incompatible rotation (prompt path
 * and config-change path share the one wording). */
const HISTORY_INCOMPATIBLE_NOTICE =
  'ประวัติเดิมของ agent ใช้ต่อไม่ได้ — เปิดเซสชันใหม่แล้วลองส่งต่ออีกครั้ง';
/** Transcript notice for an MCP-audit rotation (BUG-082). Unlike the
 * history case the session itself is kept — only the serve host is
 * poisoned, so the retry resumes the same session on a fresh agent. */
const MCP_AUDIT_FAILED_NOTICE =
  'agent สตาร์ท MCP ไม่ผ่าน (MCP startup audit failed) — เปิด agent ใหม่แล้วลองส่งต่ออีกครั้ง เซสชันเดิมยังอยู่ครบ';

export function extractText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(extractText).join('');
  if (typeof content !== 'object') return String(content);
  if (typeof content.text === 'string') return content.text;
  if (content.content) return extractText(content.content);
  return '';
}

/**
 * Body text for a tool row. Prefers the terminal `rawOutput` the CLI
 * attaches to the completed `tool_call_update` (grok-desktop's
 * `extractToolOutput` does the same); otherwise reads the content blocks.
 * An Edit/Write call carries its change as a leading `{type:'diff'}` block
 * — plain `extractText` returns '' for those, which is why such rows used
 * to show nothing but the raw args JSON.
 */
export function extractToolOutput(update) {
  if (!update || typeof update !== 'object') return '';
  const direct = extractText(update.rawOutput ?? update.raw_output);
  if (direct.trim()) return direct;
  const content = update.content;
  const blocks = Array.isArray(content) ? content : content != null ? [content] : [];
  const diffs = blocks.filter((b) => b && typeof b === 'object' && b.type === 'diff');
  if (diffs.length) {
    // The text block next to a diff is the stringified args — the same
    // information, raw. The diff is its readable rendering; show it alone.
    return diffs.map(formatDiffPreview).filter(Boolean).join('\n');
  }
  return extractText(content);
}

/** One-line preview for the sidebar row: the latest thing that was said. */
export function previewOf(chat, max = 90) {
  const last = [...(chat.messages || [])].reverse().find((m) => m.text && m.text.trim());
  if (!last) return '';
  const flat = last.text
    .replace(/```[\s\S]*?```/g, ' ⌗ ')
    .replace(/\s+/g, ' ')
    .trim();
  return cutEllipsis(flat, max);
}

/** `mcp__<server>.<tool>` → `<server>`; null for built-in tools. */
export function mcpServerOfToolKind(kind) {
  const m = /^mcp__([^.]+)\./.exec(String(kind || ''));
  return m ? m[1] : null;
}

/** Cap per item text in a subagent drill-down — the child session log stays on disk. */
const DRILL_TEXT_MAX = 2_000;
/** Cap live-streamed child text kept per subagent record. */
const SUBAGENT_LIVE_MAX = 4_000;

/**
 * Rail actions onto the MSP verbs (SS3.16). Deliberately the small honest
 * set: interrupt/close/reopen/followupTask stay unwired until their exact
 * semantics are probed against the real binary — two buttons whose
 * difference nobody can explain is worse than one.
 */
export const SUBAGENT_COMMANDS = {
  stop: 'subagent/stop',
  resume: 'subagent/resume',
  send: 'subagent/sendMessage',
};

/**
 * Model-side native subagent tools — the CLI's parallel children. Unlike
 * SS4.5.7 `subagent` items, these surface as plain toolCalls: spawn args
 * carry the topic (task_name/objective/role), spawn/wait outputs (which
 * arrive as `visibleOutput`, never deltas) carry the durable id + result.
 * Shapes probed against the real binary, 2026-10-02.
 */
const NATIVE_SUBAGENT_TOOLS = new Set([
  'subagent_spawn',
  'subagent_wait',
  'subagent_send_message',
  'subagent_read_result',
  'subagent_cancel',
  'subagent_status',
]);

function tryJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Fold one native-subagent tool row into a registry-record patch. Pure —
 * the tracker applies the patch, the unit suite covers the matrix.
 * Returns null for other tools, mid-flight rows without identity, and
 * verbs with nothing to fold (send/status are fire-and-forget reads).
 */
export function nativeSubagentPatch({ toolCallId, kind, rawInput, output, status }) {
  if (!NATIVE_SUBAGENT_TOOLS.has(String(kind || ''))) return null;
  const args = tryJson(rawInput);
  const out = tryJson(output);
  const id = (out && typeof out.subagent_id === 'string' && out.subagent_id)
    || (args && typeof args.subagent_id === 'string' && args.subagent_id)
    || null;
  const st = String(status || '');
  const fail = (rec) => {
    if (st !== 'failed' && st !== 'cancelled') return null;
    return { key: id ? `native:${id}` : `native:tool:${toolCallId}`, rec };
  };
  switch (String(kind)) {
    case 'subagent_spawn': {
      if (st === 'failed') {
        return fail({
          status: 'failed',
          subagentId: id,
          role: args?.role ?? null,
          objective: args?.objective ?? null,
          taskName: args?.task_name ?? null,
        });
      }
      if (st !== 'completed') return null;
      if (out && out.status && out.status !== 'accepted') {
        return {
          key: id ? `native:${id}` : `native:tool:${toolCallId}`,
          rec: { status: 'failed', subagentId: id, failureReason: String(out.status).slice(0, 200) },
        };
      }
      return {
        key: id ? `native:${id}` : `native:tool:${toolCallId}`,
        rec: {
          status: 'inProgress',
          subagentId: id,
          agentPath: typeof out?.agent_path === 'string' ? out.agent_path : null,
          role: args?.role ?? null,
          objective: args?.objective ?? null,
          taskName: args?.task_name ?? null,
          taskRef: typeof out?.task_ref === 'string' ? out.task_ref : null,
        },
      };
    }
    case 'subagent_wait': {
      if (!id) return null;
      if (st === 'failed') return fail({ status: 'failed', subagentId: id });
      if (st === 'completed' && out) {
        if (out.status === 'ready') {
          return {
            key: `native:${id}`,
            rec: {
              status: 'completed',
              subagentId: id,
              result: {
                summary: typeof out.summary === 'string' ? out.summary.slice(0, 2000) : null,
                evidenceRefs: Array.isArray(out.evidence_refs)
                  ? out.evidence_refs.filter((e) => typeof e === 'string').slice(0, 10)
                  : [],
              },
            },
          };
        }
        // A timed-out wait gave up waiting — the child itself is alive.
        if (out.status === 'timeout') return { key: `native:${id}`, rec: { status: 'inProgress', subagentId: id } };
        if (out.error || out.errorKind || out.status === 'error') {
          return {
            key: `native:${id}`,
            rec: {
              status: 'failed',
              subagentId: id,
              failureReason: String(out.error || out.errorKind || out.status).slice(0, 500),
            },
          };
        }
      }
      // Started, or a completed row with no parseable output: the child the
      // wait names is (still) running. Skeletons cover a missed spawn.
      return { key: `native:${id}`, rec: { status: 'inProgress', subagentId: id } };
    }
    case 'subagent_cancel': {
      if (!id || st !== 'completed') return null;
      return { key: `native:${id}`, rec: { status: 'cancelled', subagentId: id } };
    }
    case 'subagent_read_result': {
      if (!id || st !== 'completed') return null;
      const text = typeof out?.text === 'string' ? out.text
        : typeof output === 'string' && output ? output : '';
      return {
        key: `native:${id}`,
        rec: {
          subagentId: id,
          result: {
            summary: typeof out?.summary === 'string' ? out.summary.slice(0, 2000) : null,
            text: text.slice(0, 4000) || null,
          },
        },
      };
    }
    default:
      return null;
  }
}

/**
 * Registry key behind one transcript tool row, or null. Native subagent
 * verbs (subagent_spawn/wait/…) name their child via `subagent_id` in args
 * or output — the same id the registry fold keys on — so an agent row can
 * inline the child's activity through the drill endpoint. Shapes are mixed
 * on the wire (object or JSON string), so both are probed. Model-side
 * `Agent` rows carry only a type, no durable child id — they stay
 * unlinked; the row's own output is all the wire offers. Pure.
 */
export function agentRowLink(tool) {
  if (!tool || typeof tool !== 'object') return null;
  const kind = String(tool.kind || '');
  const probe = (v) => {
    if (!v) return null;
    if (typeof v === 'object') return v;
    return tryJson(v);
  };
  const args = probe(tool.rawInput);
  const obj = (tool.rawInput && typeof tool.rawInput === 'object')
    ? tool.rawInput
    : args;
  const isAgentRow = NATIVE_SUBAGENT_TOOLS.has(kind)
    || !!(obj && (obj.subagent_type || obj.prompt_template));
  if (!isAgentRow) return null;
  const out = probe(tool.output);
  const id = (out && typeof out.subagent_id === 'string' && out.subagent_id)
    || (args && typeof args.subagent_id === 'string' && args.subagent_id)
    || null;
  return id ? `native:${id}` : null;
}

/**
 * Small projection of one child-session item for the drill-down view. Keeps
 * identity + state + the readable text, capped; nested children keep their
 * drill keys so the panel can recurse one level deeper.
 */
export function sanitizeDrillItem(item) {
  if (!item || typeof item !== 'object') return null;
  const out = {
    itemId: item.itemId != null ? String(item.itemId) : null,
    kind: String(item.kind || ''),
    status: String(item.status || ''),
  };
  const str = (v) => (v == null ? null : String(v));
  for (const k of ['subagentId', 'agentPath', 'role', 'objective', 'taskName', 'controlStatus', 'childSessionId',
    'tool', 'title', 'topic', 'fallbackText', 'entryId', 'scriptId', 'message']) {
    if (item[k] != null) out[k] = str(item[k]);
  }
  if (typeof item.text === 'string' && item.text) {
    out.text = item.text.length > DRILL_TEXT_MAX
      ? `${item.text.slice(0, DRILL_TEXT_MAX)}…`
      : item.text;
    if (item.text.length > DRILL_TEXT_MAX) out.truncated = true;
  }
  if (item.result && typeof item.result === 'object') {
    out.result = {
      summary: str(item.result.summary),
      ...(typeof item.result.errorKind === 'string' ? { errorKind: item.result.errorKind } : {}),
    };
    if (typeof item.result.text === 'string' && item.result.text) {
      out.result.text = item.result.text.length > DRILL_TEXT_MAX
        ? `${item.result.text.slice(0, DRILL_TEXT_MAX)}…`
        : item.result.text;
    }
  }
  if (Array.isArray(item.children)) {
    out.children = item.children
      .filter((c) => c && typeof c === 'object')
      .map((c) => ({
        childId: str(c.childId),
        label: str(c.label),
        phase: str(c.phase),
        status: str(c.status),
      }));
  }
  return out;
}

/**
 * A reminder child does exactly one thing: call `submit_reminder_decision`
 * once with `{decision, reason}`. The parent wire never carries it — the
 * only copy lives in the child's own session — so the drill/live-fold reads
 * the raw child items (pre-sanitize: the args never leave the server) and
 * the registry keeps it as the row's topic line. Pure — the unit suite
 * covers the matrix. Returns null when the child has not decided yet.
 */
export function extractReminderDecision(rawItems) {
  if (!Array.isArray(rawItems)) return null;
  for (const it of rawItems) {
    if (!it || it.kind !== 'toolCall' || it.tool !== 'submit_reminder_decision') continue;
    const args = tryJson(it.args ?? it.rawInput);
    if (!args || typeof args !== 'object') continue;
    const decision = args.decision != null ? String(args.decision).slice(0, 80) : null;
    const reason = args.reason != null ? String(args.reason).slice(0, 500) : null;
    if (!decision && !reason) continue;
    return { decision, reason };
  }
  return null;
}

/** One line the rail shows for a reminder that already decided. */
export function reminderDecisionLine(dec) {
  if (!dec || typeof dec !== 'object') return null;
  const d = dec.decision ? String(dec.decision) : null;
  const r = dec.reason ? String(dec.reason) : null;
  if (d && r) return `${d}: ${r}`;
  return d || r || null;
}

/** The client wraps the discriminator in `params.update.sessionUpdate`; be tolerant. */
export function readUpdate(params) {
  const update = params?.update && typeof params.update === 'object' ? params.update : params || {};
  const kind = String(update.sessionUpdate || update.kind || update.type || '').trim();
  return { kind, update };
}

export class SessionManager extends EventEmitter {
  constructor({ store, wire, defaults = {}, catalog = null, searchDbPath = null }) {
    super();
    this.store = store;
    this.wire = wire;
    /** Agent-wide model/thinking catalog — lets cold chats offer pickers
     * before their first spawn (BUG-079). */
    this.catalog = catalog || new ConfigCatalog();
    this.defaults = {
      mode: defaults.mode || 'always',
      cwd: defaults.cwd || process.cwd(),
      model: defaults.model || null,
      effort: defaults.effort || 'ultra',
      // Create-warm (grok-desktop's recipe): a fresh chat spawns its agent
      // in the background while the UI stays idle, so the ~20s of async MCP
      // connects after session/start usually finish while the user is still
      // typing the first prompt. MUSE_DESKTOP_CREATE_WARM=0 disables.
      createWarm: defaults.createWarm ?? process.env.MUSE_DESKTOP_CREATE_WARM !== '0',
      maxHot: defaults.maxHot || DEFAULT_MAX_HOT,
      idleDemoteMs: defaults.idleDemoteMs || DEFAULT_IDLE_DEMOTE_MS,
    };
    /** chatId → { client, turn, lastUsed, starting } */
    this.slots = new Map();
    /** interactionId → { chatId, resolve } — any client may answer. */
    this.pendingInteractions = new Map();
    /**
     * chatId → { message?: {turnId,delta,text,timer}, thought?: {...} } —
     * batched stream deltas, flushed by timer/size and always by settleTurn
     * before its terminal frame so ordering is preserved.
     */
    this._deltaBufs = new Map();
    /**
     * chatId → { reason, message } — the agent session was rotated away
     * (load_miss / history-incompatible). The next prompt prepends a lean
     * recovery recap to its wire text (once), then clears the flag.
     */
    this._rotated = new Map();
    /** mcp server name → last-seen-epoch-ms, learned from `mcp__<srv>.` tool kinds. */
    this.mcpUsage = new Map();
    this._mcpUsageFile = null;
    this._mcpUsageTimer = null;
    this._loadMcpUsage();
    this.lastAuth = null;

    // Cross-chat full-text search (SQLite FTS5 trigram, grok-desktop parity).
    // Loud by design: the constructor throws when the binding is missing and
    // self-heals a corrupt db — FTS is never silently disabled.
    // searchDbPath is the test seam: suites MUST pass a temp path, otherwise
    // the boot rebuild below wipes the developer's real index and re-sources
    // it from the suite's fixture store (2026-09-30: npm test rebuilt the
    // live 85-session index down to 15 fixture sessions).
    this.searchIndex = new SearchIndex({ dbPath: searchDbPath || undefined });
    this.store.onWrite = (type, payload) => this._onStoreWrite(type, payload);
    // Rebuild from restored chats + groups (next tick — boot stays snappy).
    setImmediate(() => {
      try {
        const r = this.searchIndex.rebuildAll(this.store.list(), this.store.listGroups());
        if (r?.ok) {
          console.log(
            `[sessions] search index ready chunks=${r.chunks} sessions=${r.sessions} groups=${r.groups} ${r.ms || 0}ms`,
          );
        } else {
          console.warn(`[sessions] search index rebuild: ${r?.error || 'disabled'}`);
        }
      } catch (err) {
        console.error('[sessions] search rebuild failed:', err?.message || err);
      }
    });

    this._demoteTimer = setInterval(() => this._demoteIdle(), 60_000);
    this._demoteTimer.unref?.();
  }

  // ---------------------------------------------------------------- chats

  listChats() {
    // Queue order: most recent conversation activity first. Only a real
    // message moves a chat — a prompt sent, a run settled — while opening a
    // session to look at it never reorders (the sidebar keeps this order
    // within each group block).
    return [...this.store.list()]
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map((c) => this.chatSummary(c));
  }

  chatSummary(chat) {
    const slot = this.slots.get(chat.id);
    return {
      id: chat.id,
      title: chat.title,
      cwd: chat.cwd,
      mode: chat.mode,
      model: chat.model,
      effort: chat.effort,
      groupId: chat.groupId,
      preview: previewOf(chat),
      updatedAt: chat.updatedAt,
      createdAt: chat.createdAt,
      messageCount: chat.messages.length,
      live: !!slot?.client,
      status: slot?.client?.status || 'cold',
      running: !!slot?.turn && !slot.turn.settled,
      turnId: slot?.turn && !slot.turn.settled ? slot.turn.turnId : null,
      // Agent-side session id for the rail's identity rows (usable with
      // `muse export`/`trace`/`resume`). Live client first — the stored
      // copy lags during rotation — stored copy once the agent is cold.
      mspSessionId: slot?.client?.sessionId ?? chat.mspSessionId ?? null,
      pendingInteractions: [...this.pendingInteractions.values()]
        .filter((p) => p.chatId === chat.id)
        .map((p) => p.payload),
    };
  }

  getChat(id) {
    const chat = this.store.get(id);
    if (!chat) return null;
    return { ...this.chatSummary(chat), config: this.chatConfig(id), messages: chat.messages };
  }

  /**
   * Model/effort snapshot for the chat plus the selects its pickers show
   * (BUG-074/079): the live client's advertised selects when there is one,
   * else the agent-wide catalog cache (with the CHAT's stored values as
   * current — currentValue is per-chat, the catalog is not), else null when
   * nothing was ever learned.
   */
  chatConfig(chatId) {
    const chat = this.store.get(chatId);
    const client = this.slots.get(chatId)?.client;
    let options = client && isClientAlive(client) ? client.configSelects() : null;
    if (!options) {
      const cached = this.catalog.selects();
      if (cached) {
        options = {
          model: cached.model
            ? { ...cached.model, currentValue: chat?.model ?? cached.model.currentValue }
            : null,
          thinking: cached.thinking
            ? { ...cached.thinking, currentValue: chat?.effort ?? cached.thinking.currentValue }
            : null,
        };
      }
    }
    return {
      model: chat?.model ?? null,
      effort: chat?.effort ?? null,
      options,
    };
  }

  /** Feed the agent-wide catalog from a live client's advertised selects (BUG-079). */
  _learnConfig(client) {
    if (!client) return;
    try {
      this.catalog.update(client.configSelects());
    } catch {
      /* a learning hiccup must never break the session path */
    }
  }

  /**
   * Prewarm the chat's agent session so its advertised selects can serve the
   * pickers (BUG-079): ensureClient() spawns + session/new WITHOUT a prompt,
   * the catalog refreshes from the live client, and the reply is the same
   * config shape GET returns. Spawn/auth errors propagate to the route.
   */
  async refreshChatConfig(chatId) {
    const chat = this.store.get(chatId);
    if (!chat) return null;
    await this.ensureClient(chatId);
    this._learnConfig(this.slots.get(chatId)?.client);
    return { config: this.chatConfig(chatId) };
  }

  /**
   * Live open-turn snapshot for `GET /api/chats/:id/turn` — a reloaded UI
   * needs the in-flight text/tools/plan to repaint its live area
   * (grok-desktop sessions.js:843-872). `null` for an unknown chat;
   * `{ turn: null }` when no turn is live.
   */
  getTurn(chatId) {
    if (!this.store.get(chatId)) return null;
    const turn = this.slots.get(chatId)?.turn;
    if (!turn || turn.settled) return { turn: null };
    return {
      turn: {
        turnId: turn.turnId,
        startedAt: turn.startedAt,
        partial: turn.text,
        tools: [...turn.toolCalls.values()],
        plan: turn.plan,
        pendingInteractions: [...this.pendingInteractions.values()]
          .filter((p) => p.chatId === chatId)
          .map((p) => p.payload),
      },
    };
  }

  /** The newest chat that was never used — nothing typed, no agent session. */
  findReusableEmptyChat(groupId = null) {
    const pool = groupId ? this.store.listInGroup(groupId) : this.store.list();
    return pool.find((c) => c.messages.length === 0 && !c.mspSessionId) || null;
  }

  createChat(opts = {}) {
    // Boot passes `reuseEmpty` so that N clients starting against an empty
    // store (app window + a browser tab, or just a fast reload) do not each
    // add a "New chat" row — and so the list does not accumulate blank chats
    // every time the app is opened without one being used.
    if (opts.reuseEmpty) {
      const existing = this.findReusableEmptyChat(opts.groupId || this.store.activeGroupId);
      if (existing) {
        this._warmChat(existing.id);
        return existing;
      }
    }
    const chat = this.store.create({
      groupId: opts.groupId || null,
      title: opts.title || 'New chat',
      cwd: opts.cwd || this.defaults.cwd,
      mode: normalizeSessionMode(opts.mode || this.defaults.mode),
      model: opts.model ?? this.defaults.model,
      effort: opts.effort ?? this.defaults.effort,
    });
    this.wire.emit(chat.id, 'chat_created', { chat: this.chatSummary(chat) });
    this._warmChat(chat.id);
    return chat;
  }

  /**
   * Background agent spawn for a chat the user is about to use. Returns
   * immediately; the boot single-flights with a racing first prompt inside
   * ensureClient, and a failure only logs — the prompt path retries aloud.
   */
  _warmChat(chatId) {
    if (!this.defaults.createWarm) return;
    void this.ensureClient(chatId).catch((err) => {
      console.warn(`[sessions] create-warm failed for ${chatId}: ${err?.message || err}`);
    });
  }

  async removeChat(id) {
    await this.releaseClient(id, 'chat removed');
    const ok = this.store.remove(id);
    if (ok) this.wire.emit(id, 'chat_removed', {});
    return ok;
  }

  // --------------------------------------------------------------- groups

  listGroups() {
    return this.store.listGroups().map((g) => {
      const chats = this.store.listInGroup(g.id);
      return {
        ...g,
        chatCount: chats.length,
        runningCount: chats.filter((c) => {
          const slot = this.slots.get(c.id);
          return !!slot?.turn && !slot.turn.settled;
        }).length,
      };
    });
  }

  groupsState() {
    return { groups: this.listGroups(), activeGroupId: this.store.activeGroupId };
  }

  // ------------------------------------------------------------- search

  _groupNameForSearch(groupId) {
    return (groupId && this.store.getGroup(groupId)?.name) || null;
  }

  /**
   * SessionStore write observer → FTS indexer. One choke point: every string
   * the store persists (messages, titles, tool calls, plans, group names)
   * lands in the index through here, so search can find any of them in any
   * chat. The store already guards this call; index work itself is queued
   * off the MSP hot path.
   */
  _onStoreWrite(type, p = {}) {
    const idx = this.searchIndex;
    if (!idx?.enabled) return;
    try {
      switch (type) {
        case 'message': {
          const chat = this.store.get(p.chatId);
          if (!chat || !p.msg) return;
          const turn = turnForMessageIndex(chat.messages, p.index);
          const gopts = { groupId: chat.groupId };
          idx.indexMessage(p.chatId, p.index, p.msg.role, p.msg.text, p.msg.ts, turn, gopts);
          idx.indexMessageExtras(p.chatId, p.index, p.msg, p.msg.ts, { ...gopts, turn });
          // Title may have auto-derived from this message — re-shell cheaply.
          idx.indexSessionShell(chat, { groupName: this._groupNameForSearch(chat.groupId) });
          break;
        }
        case 'trim': {
          const chat = this.store.get(p.chatId);
          if (chat) idx.reindexSession(chat, { groupName: this._groupNameForSearch(chat.groupId) });
          break;
        }
        case 'chat':
        case 'chat-update': {
          const chat = this.store.get(p.chat?.id || p.id);
          if (chat) {
            idx.indexSessionShell(chat, {
              groupName: this._groupNameForSearch(chat.groupId),
              urgent: true,
            });
          }
          break;
        }
        case 'chat-remove':
          idx.removeSession(p.id);
          break;
        case 'group':
          if (p.group) idx.indexGroup(p.group, { urgent: true });
          break;
        case 'group-remove':
          idx.removeGroup(p.id);
          for (const cid of p.removedChatIds || []) idx.removeSession(cid);
          break;
        default:
          break;
      }
    } catch (err) {
      console.error(`[sessions] search index (${type}) failed:`, err?.message || err);
    }
  }

  /**
   * Cross-chat search with live chrome (grok-desktop sessions.js:search).
   * @param {string} query
   */
  search(query, { limit = 40, groupId, kind, surface } = {}) {
    const meta = new Map();
    for (const c of this.store.list()) {
      const slot = this.slots.get(c.id);
      // Epoch → ISO: the index's recency bonus Date.parse()s this, and
      // Date.parse(1726…) is NaN, which would poison the hit score.
      const ts = c.updatedAt || c.createdAt || '';
      meta.set(c.id, {
        shortId: String(c.id).slice(0, 8),
        title: c.title || 'แชท',
        groupId: c.groupId || null,
        groupName: this._groupNameForSearch(c.groupId),
        status: slot?.turn && !slot.turn.settled ? 'running' : slot?.client ? 'starting' : 'idle',
        updatedAt: typeof ts === 'number' ? new Date(ts).toISOString() : ts,
      });
    }

    const out = this.searchIndex.search(query, {
      limit,
      sessionMeta: meta,
      groupId,
      kind,
      surface,
    });
    // Also match bare chat ids that FTS may miss (uuid punctuation).
    const q = String(query || '').trim().toLowerCase();
    if (q.length >= 4 && out?.hits) {
      for (const c of this.store.list()) {
        if (
          c.id.toLowerCase().includes(q) ||
          (c.mspSessionId && c.mspSessionId.toLowerCase().includes(q))
        ) {
          if (!out.hits.some((h) => h.sessionId === c.id)) {
            const m = meta.get(c.id) || {};
            out.hits.unshift({
              sessionId: c.id,
              groupId: m.groupId || null,
              groupName: m.groupName || null,
              shortId: m.shortId || String(c.id).slice(0, 8),
              title: m.title || c.title || 'แชท',
              status: m.status || 'idle',
              score: 5,
              matches: [{ field: 'id', kind: 'shell', surface: 'meta', snippet: c.id }],
              updatedAt: m.updatedAt || '',
              hitType: 'session',
            });
          }
        }
      }
    }
    return out;
  }

  createGroup(opts = {}) {
    const group = this.store.createGroup(opts);
    this.wire.emit(null, 'group_created', { group, ...this.groupsState() });
    return group;
  }

  renameGroup(id, name) {
    const group = this.store.renameGroup(id, name);
    if (group) this.wire.emit(null, 'group_updated', { group, ...this.groupsState() });
    return group;
  }

  /**
   * Deleting a group takes its chats with it — so every agent in it has to be
   * shut down first, or we leak `muse serve` processes with no chat to belong to.
   */
  async removeGroup(id) {
    const chatIds = this.store.listInGroup(id).map((c) => c.id);
    const result = this.store.removeGroup(id);
    if (!result) return null; // unknown group, or it was the last one
    await Promise.all(chatIds.map((cid) => this.releaseClient(cid, 'group removed')));
    this.wire.emit(null, 'group_removed', {
      groupId: id,
      removedChatIds: result.removedChatIds,
      ...this.groupsState(),
    });
    return result;
  }

  reorderGroups(order) {
    const groups = this.store.reorderGroups(order);
    this.wire.emit(null, 'groups_reordered', { ...this.groupsState() });
    return groups;
  }

  selectGroup(id) {
    const active = this.store.setActiveGroup(id);
    if (!active) return null;
    this.wire.emit(null, 'group_selected', { ...this.groupsState() });
    return active;
  }

  moveChat(chatId, groupId) {
    const chat = this.store.moveChat(chatId, groupId);
    if (!chat) return null;
    this.wire.emit(chatId, 'chat_moved', {
      chat: this.chatSummary(chat),
      groupId,
      ...this.groupsState(),
    });
    return chat;
  }

  // --------------------------------------------------------------- agent

  hasLiveClient(id) {
    return !!this.slots.get(id)?.client;
  }

  async ensureClient(chatId) {
    const chat = this.store.get(chatId);
    if (!chat) throw new Error(`unknown chat ${chatId}`);

    let slot = this.slots.get(chatId);
    if (slot?.client && slot.client.sessionId && slot.client.proc?.exitCode == null) {
      slot.lastUsed = Date.now();
      return slot.client;
    }
    // Single-flight: two prompts arriving together must not spawn two agents.
    if (slot?.starting) return slot.starting;

    if (!slot) {
      // cancelledPrompts: userInputId → cancel-timestamp ms, for the BUG-084
      // recovery poll (a cancel the agent still holds past grace escalates).
      slot = { client: null, turn: null, lastUsed: Date.now(), starting: null, subagents: new Map(), cancelledPrompts: new Map() };
      this.slots.set(chatId, slot);
      // A restart wipes slots but not the store — reseed the registry so the
      // rail and drill-downs work without waiting for the next turn.
      for (const rec of chat.subagents || []) {
        if (rec?.itemId && !slot.subagents.has(rec.itemId)) slot.subagents.set(rec.itemId, { ...rec });
      }
    }
    if (!slot.subagents) slot.subagents = new Map();

    const boot = (async () => {
      await this._evictIfOverCap(chatId);
      const client = new MspClient({
        cwd: chat.cwd,
        model: chat.model,
        // Per-chat effort wins over the global env default (BUG-074) —
        // applySessionConfig() pushes the constructor value at session open.
        effort: chat.effort,
        sessionMode: chat.mode,
        env: process.env,
      });
      this._bindClient(chatId, client);
      slot.client = client;
      try {
        await client.start({ resumeSessionId: chat.mspSessionId });
      } catch (err) {
        console.warn(`[sessions ${new Date().toISOString()}] agent boot failed for ${String(chatId).slice(0, 8)}…: ${err?.message || err}`);
        slot.client = null;
        try {
          await client.shutdown();
        } catch { /* best effort */ }
        throw err;
      }
      // Persist immediately: a debounced write here loses the race with a
      // process exit and strands a dead agent-session id on disk forever.
      if (client.sessionId && client.sessionId !== chat.mspSessionId) {
        this.store.update(chatId, { mspSessionId: client.sessionId });
      }
      // A resume miss boots a NEW session id under the old slot — retire
      // the previous session's live goal (same-id resume retains).
      this._retireGoalOnRotation(chatId, slot, client.sessionId);
      this._learnConfig(client); // fresh configOptions feed the catalog (BUG-079)
      slot.lastUsed = Date.now();
      slot.bootedAt = Date.now();
      slot.turnsStarted = 0;
      this.wire.emit(chatId, 'agent_ready', {
        sessionId: client.sessionId,
        mode: client.sessionMode,
        modeId: client.currentModeId,
        agent: client.agentInfo,
      });
      // New hot agent: refresh the account snapshot right away so the
      // on-disk usage cache (read by Übersicht) is fresh from the first
      // run — not whenever the next usage/changed happens to arrive.
      // Fire-and-forget: usage/read needs no model call but must never
      // delay the prompt that just booted this agent.
      this.getUsage().catch(() => {});
      // Same deal for pre-tracker children: rebuild native rows from the
      // parent history without blocking the turn that booted this agent.
      this._backfillNativeSubagents(chatId, slot, client).catch(() => {});
      return client;
    })();

    slot.starting = boot;
    try {
      return await boot;
    } finally {
      slot.starting = null;
    }
  }

  _bindClient(chatId, client) {
    const wire = this.wire;

    client.on('status', (s) => wire.emit(chatId, 'agent_status', s));
    client.on('stderr', (text) => {
      // Dropped completions + subscribe failures travel here — they diagnosed
      // chat 81442763, so they belong in host.log too, not just the SSE wire.
      const firstLine = String(text).split('\n')[0].slice(0, 300);
      console.warn(`[sessions ${new Date().toISOString()}] agent_stderr ${String(chatId).slice(0, 8)}… ${firstLine}`);
      wire.emit(chatId, 'agent_stderr', { text: String(text).slice(0, 4000) });
    });

    // 'diag' is stderr's quiet sibling: host.log only, never the SSE wire —
    // one line per interactive frame / answer / cancel would spam the UI's
    // transient notices, but the log needs them (BUG-084 was invisible).
    client.on('diag', (text) => {
      const firstLine = String(text).split('\n')[0].slice(0, 300);
      console.log(`[sessions ${new Date().toISOString()}] agent_diag ${String(chatId).slice(0, 8)}… ${firstLine}`);
    });

    client.on('handshake', (h) => wire.emit(chatId, 'agent_handshake', h));

    client.on('auth_required', (info) => {
      const cmd = terminalAuthCommand(info?.authMethods || client.authMethods);
      this.lastAuth = { ...info, command: cmd };
      wire.emit(chatId, 'auth_required', { ...info, command: cmd });
    });

    client.on('load_miss', (info) => {
      // The agent threw the old session away (version change, expired
      // encryption, pruned history). Clear our copy of its id in the same tick
      // so we do not retry the dead id on every restart — and flag the chat so
      // the next prompt carries a recovery recap instead of landing on a
      // fresh agent with zero context.
      this.store.update(chatId, { mspSessionId: null });
      this._rotated.set(chatId, {
        reason: 'load-miss',
        message: info?.message || 'unknown',
      });
      this.store.addMessage(chatId, {
        role: 'notice',
        text: `เซสชันเดิมของ agent ใช้ต่อไม่ได้ (${info?.message || 'unknown'}) — เปิดเซสชันใหม่ให้แล้ว`,
      });
      wire.emit(chatId, 'load_miss', info);
    });

    client.on('update', (params) => this._onUpdate(chatId, params));

    client.on('permission', (req) => this._onPermission(chatId, req));

    client.on('exit', ({ code, signal }) => {
      const slot = this.slots.get(chatId);
      if (slot) slot.client = null;
      // An exit mid-turn is a terminal condition — settle so the UI is not
      // left spinning on a process that no longer exists.
      if (slot?.turn && !slot.turn.settled) {
        this.settleTurn(chatId, slot.turn.turnId, {
          reason: 'agent_exit',
          error: `agent exited (code=${code ?? 'null'}${signal ? ` signal=${signal}` : ''})`,
        });
      }
      wire.emit(chatId, 'agent_exit', { code, signal });
    });

    client.on('error', (err) => {
      wire.emit(chatId, 'agent_error', { message: err?.message || String(err) });
    });
  }

  async releaseClient(chatId, reason = 'released') {
    const slot = this.slots.get(chatId);
    if (!slot) return false;
    if (slot.turn && !slot.turn.settled) {
      this.settleTurn(chatId, slot.turn.turnId, { reason: 'released', error: reason });
    }
    for (const [id, p] of [...this.pendingInteractions]) {
      if (p.chatId === chatId) {
        // Same dead-shape fix as settleTurn: reject through the real waiter on
        // the client before it is shut down below.
        try { slot.client?.resolvePermission(id, 'reject'); } catch { /* ignore */ }
        this.pendingInteractions.delete(id);
      }
    }
    const client = slot.client;
    slot.client = null;
    this.slots.delete(chatId);
    if (client) {
      try {
        await client.shutdown();
      } catch { /* best effort */ }
    }
    this.wire.emit(chatId, 'agent_released', { reason });
    return true;
  }

  async _evictIfOverCap(exceptChatId) {
    const live = [...this.slots.entries()].filter(([id, s]) => s.client && id !== exceptChatId);
    if (live.length < this.defaults.maxHot) return;
    live.sort((a, b) => (a[1].lastUsed || 0) - (b[1].lastUsed || 0));
    const victims = live.slice(0, live.length - this.defaults.maxHot + 1);
    for (const [id, slot] of victims) {
      if (slot.turn && !slot.turn.settled) continue; // never evict a running turn
      await this.releaseClient(id, 'pool cap');
    }
  }

  _demoteIdle() {
    const now = Date.now();
    for (const [id, slot] of [...this.slots]) {
      if (!slot.client) continue;
      if (slot.turn && !slot.turn.settled) continue;
      if (now - (slot.lastUsed || 0) > this.defaults.idleDemoteMs) {
        void this.releaseClient(id, 'idle');
      }
    }
  }

  // ---------------------------------------------------------------- turns

  /**
   * Wire text for the first prompt after an agent-session rotation
   * (load_miss / history-incompatible): a lean `[SESSION RECOVERY]` recap of
   * the latest exchange, prepended to the user's text **on the wire only** —
   * the stored user message stays the plain text. Fires once, then the flag
   * is cleared. grok-desktop does the same in turn-recovery.js:221-304.
   */
  _buildRecoveryWireText(chatId, body, excludeMessageId = null) {
    const rotated = this._rotated.get(chatId);
    if (!rotated) return body;
    this._rotated.delete(chatId);

    const msgs = (this.store.get(chatId)?.messages || []).filter((m) => m.id !== excludeMessageId);
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user' && m.text?.trim())?.text || '';
    const lastAsst =
      [...msgs].reverse().find((m) => m.role === 'assistant' && m.text?.trim())?.text || '';
    const clip = (s) => (s.length > RECOVERY_MAX_CHARS ? `${s.slice(0, RECOVERY_MAX_CHARS)}…` : s);

    const lines = [
      '[SESSION RECOVERY — Muse Desktop]',
      'You are a FRESH agent session. The previous session could not be resumed',
      `(${rotated.reason}${rotated.message ? `: ${String(rotated.message).slice(0, 300)}` : ''}).`,
      'The desktop transcript is the source of truth — continue from the recap',
      'below; do not restart the task from scratch.',
      '',
      '## Latest user message',
      clip(lastUser) || '(none)',
      '',
      '## Latest assistant output',
      clip(lastAsst) || '(none yet)',
      '',
      '## The user message to answer now follows',
      '',
    ];
    return `${lines.join('\n')}${body}`;
  }

  async prompt(chatId, text, opts = {}) {
    const chat = this.store.get(chatId);
    if (!chat) throw new Error(`unknown chat ${chatId}`);
    const body = String(text ?? '').trim();
    // Attachments arrive separately and stay separate: images become image
    // parts, files become @mentions — the text part is the user's verbatim
    // text (grok merges a preamble into it; we deliberately do not).
    const rawAtts = Array.isArray(opts.attachments) ? opts.attachments : [];
    if (!body && !rawAtts.length) throw new Error('empty prompt');
    const normalized = rawAtts.map(normalizeAttachmentInput);
    const resolved = resolveAttachments(normalized, {
      attachDir: path.join(stateDir(), 'attach'),
      chatId,
    });

    const slot = this.slots.get(chatId);
    if (slot?.turn && !slot.turn.settled) {
      const err = new Error('a turn is already running for this chat');
      err.code = 'TURN_IN_FLIGHT';
      err.status = 409;
      throw err;
    }

    const client = await this.ensureClient(chatId);
    const turnId = randomUUID();
    const live = this.slots.get(chatId);
    // A history-rotation retry re-sends the same text — the user message is
    // already in the transcript from the first attempt; storing it again
    // would paint the prompt twice.
    const userMsg = opts.skipUserMessage
      ? null
      : this.store.addMessage(chatId, {
        role: 'user',
        text: body,
        ...(resolved.meta.length ? { meta: { attachments: resolved.meta } } : {}),
      });
    if (!body && resolved.meta.length && (!chat.title || chat.title === 'New chat')) {
      this.store.update(chatId, { title: `ไฟล์แนบ ${resolved.meta.length} รายการ` });
    }
    // A prompt that mentions APxxxx tags the session title with [APxxxx]
    // (grok-desktop sessions.js:2989) — the sidebar and right bar read the
    // same tags to show which SCB project this session is about.
    if (body && !opts.skipUserMessage) {
      const apTitle = applyApPrefixToTitle(this.store.get(chatId)?.title || 'New chat', body);
      if (apTitle.changed) this.store.update(chatId, { title: apTitle.title });
    }
    const wireText = this._buildRecoveryWireText(chatId, body, userMsg?.id);

    live.turn = {
      turnId,
      text: '',
      thought: '',
      toolCalls: new Map(),
      plan: null,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      sawActivity: false,
      settled: false,
      // The agent echoes the prompt back as `user_message_chunk`; without this
      // the transcript grows a duplicate copy of every message the user sends.
      promptText: body,
    };
    live.lastUsed = Date.now();
    // First turn on a just-booted agent: the ~20s of async MCP connects are
    // usually still running, so the UI says "preparing tools" instead of a
    // dead spinner until the first real activity lands.
    const warming = live.turnsStarted === 0 && Date.now() - (live.bootedAt || 0) < 45_000;
    live.turnsStarted = (live.turnsStarted || 0) + 1;

    this.wire.emit(chatId, 'turn_started', {
      turnId,
      message: userMsg,
      title: this.store.get(chatId)?.title,
      ...(warming ? { warming: true } : {}),
    });

    live.watchdog = setInterval(() => this._checkWatchdog(chatId, turnId), WATCHDOG_TICK_MS);
    live.watchdog.unref?.();

    // Fire-and-forget: the HTTP caller gets 202 + turnId, everything else
    // arrives over SSE. Painting from the HTTP response is what made grok's
    // UI single-threaded across a whole turn.
    client
      .prompt(wireText, { images: resolved.images, mentionText: resolved.mentionText })
      .then((result) => {
        const stopReason = result?.stopReason || result?.stop_reason || null;
        const finalText = extractText(result?.content ?? result?.message ?? null);
        this.settleTurn(chatId, turnId, {
          reason: stopReason || 'end_turn',
          content: finalText || null,
        });
      })
      .catch(async (err) => {
        if (err?.cancelled) {
          this.settleTurn(chatId, turnId, { reason: 'cancelled' });
          return;
        }
        // The agent rejected our stored history (model change, expired
        // encryption, pruned session). Settling with an error here would
        // brick the chat: the dead mspSessionId stays on disk and every later
        // prompt fails the same way. Settle the partial stream, clear the id
        // (update() flushNow()s that field), rotate to a fresh agent and
        // retry exactly once — grok-desktop sessions.js:3536-3586.
        if (isHistoryIncompatibleError(err) && !opts._historyRetried) {
          this.settleTurn(chatId, turnId, { reason: 'rotated' });
          this.store.update(chatId, { mspSessionId: null });
          this._rotated.set(chatId, {
            reason: 'history-incompatible',
            message: formatRpcError(err),
          });
          this.store.addMessage(chatId, {
            role: 'notice',
            text: HISTORY_INCOMPATIBLE_NOTICE,
          });
          await this.releaseClient(chatId, 'history-incompatible');
          try {
            // Attachments live in the stored user message — re-send them so
            // the retry sees the same turn (normalized {path} shape re-validates).
            await this.prompt(chatId, body, {
              _historyRetried: true,
              skipUserMessage: true,
              attachments: userMsg?.meta?.attachments || rawAtts,
            });
          } catch (retryErr) {
            // The retry surfaces its own turn events; only an early throw
            // (e.g. the fresh agent refused to start) needs a signal here.
            this.wire.emit(chatId, 'agent_error', { message: formatRpcError(retryErr) });
          }
          return;
        }
        // The serve host poisoned its own MCP runtime (BUG-082): it stays
        // alive but every turn on it dies with `MCP startup audit failed`.
        // Retrying on the same host would fail forever, so rotate to a
        // fresh agent and retry exactly once — same shape as the
        // history-incompatible branch above, except the session is KEPT
        // (the audit failure is host-local; the session log is intact, so
        // no recovery recap is prepended).
        if (isMcpAuditFailedError(err) && !opts._mcpAuditRetried) {
          this.settleTurn(chatId, turnId, { reason: 'rotated' });
          this.store.addMessage(chatId, {
            role: 'notice',
            text: MCP_AUDIT_FAILED_NOTICE,
          });
          await this.releaseClient(chatId, 'mcp-audit-failed');
          try {
            // Same turn, fresh host: attachments re-send so the retry sees
            // the identical input (mirrors the history branch above).
            await this.prompt(chatId, body, {
              _mcpAuditRetried: true,
              skipUserMessage: true,
              attachments: userMsg?.meta?.attachments || rawAtts,
            });
          } catch (retryErr) {
            // The retry surfaces its own turn events; only an early throw
            // (e.g. the fresh agent refused to start) needs a signal here.
            this.wire.emit(chatId, 'agent_error', { message: formatRpcError(retryErr) });
          }
          return;
        }
        if (isAuthRequiredError(err)) {
          const cmd = terminalAuthCommand(client.authMethods);
          this.lastAuth = { authMethods: client.authMethods, command: cmd };
          this.wire.emit(chatId, 'auth_required', { authMethods: client.authMethods, command: cmd });
        }
        this.settleTurn(chatId, turnId, {
          reason: 'error',
          error: formatRpcError(err),
        });
      });

    return { turnId, message: userMsg };
  }

  /**
   * The one and only way a turn ends. Idempotent by `settled`; ignores a
   * turnId that is not the live one (a late reply from a superseded turn must
   * never terminate the turn that replaced it).
   */
  settleTurn(chatId, turnId, { reason = 'end_turn', content = null, error = null } = {}) {
    const slot = this.slots.get(chatId);
    const turn = slot?.turn;
    if (!turn || turn.turnId !== turnId || turn.settled) return false;

    turn.settled = true;
    if (slot.watchdog) {
      clearInterval(slot.watchdog);
      slot.watchdog = null;
    }
    // Flush any batched deltas BEFORE the terminal frame so the client sees
    // the full running text ahead of turn_done/turn_error, never after it.
    this._flushDelta(chatId, 'message');
    this._flushDelta(chatId, 'thought');
    this._deltaBufs.delete(chatId);

    // Close every still-open tool row before anything persists or emits —
    // pending/in_progress must not survive into the transcript, where they
    // would render as spinners forever. grok-desktop flips by stop reason
    // (turn-view.js:230-241): interrupted work on cancel/watchdog, failed
    // on error, completed otherwise (a done turn's tools should already be
    // completed; anything left open simply joins them).
    const openToolStatus =
      reason === 'cancelled' || reason === 'watchdog' ? 'cancelled' : error ? 'failed' : 'completed';
    for (const tool of turn.toolCalls.values()) {
      if (/^(pending|in_progress|running)$/i.test(String(tool.status || ''))) {
        tool.status = openToolStatus;
      }
    }

    // The agent's final content wins over accumulated chunks when present —
    // chunks can be partial or re-ordered; the result is authoritative.
    const finalText = content != null && String(content).length ? String(content) : turn.text;

    // History's `ทำไป Xs` header (ChatGPT Desktop's `Worked for …`) reads
    // this — without it a reload can only show counts, never the clock.
    const durationMs = Date.now() - turn.startedAt;
    if (finalText && finalText.trim()) {
      this.store.setAssistantMessage(chatId, turnId, finalText, {
        reason,
        durationMs,
        toolCalls: [...turn.toolCalls.values()],
        // The plan is part of what the agent produced for this turn; without
        // persisting it, it vanishes the instant the turn settles and the
        // transcript reloads.
        ...(turn.plan ? { plan: turn.plan } : {}),
      });
    } else {
      // Never blank a turn after tools ran (grok-desktop's rule): a cancel
      // right after tool activity leaves no assistant text, but the tool
      // rows must still survive a transcript reload. The empty assistant
      // message renders as just its tool rows (`.msg-assistant` has no
      // chrome of its own).
      if (turn.toolCalls.size) {
        this.store.setAssistantMessage(chatId, turnId, '', {
          reason,
          durationMs,
          toolCalls: [...turn.toolCalls.values()],
          ...(turn.plan ? { plan: turn.plan } : {}),
        });
      }
      if (error) {
        this.store.addMessage(chatId, {
          role: 'notice',
          text: `เทิร์นจบแบบไม่สำเร็จ: ${error}`,
          meta: { turnId, reason },
        });
      } else if (!turn.toolCalls.size && reason !== 'rotated') {
        // Never blank a turn, period: no text + no tools + no error used to
        // persist NOTHING — the spinner just died and the user could not tell
        // "ran and said nothing" from "never ran" (chat bcb3975b collected
        // two orphan user messages this way and the user re-sent). 'rotated'
        // is exempt: its own recovery notice already narrates the handoff.
        this.store.addMessage(chatId, {
          role: 'notice',
          text:
            reason === 'cancelled'
              ? 'ยกเลิกเทิร์นแล้ว (ไม่มีข้อความตอบกลับ)'
              : 'agent จบเทิร์นโดยไม่มีข้อความตอบกลับ — ลอง prompt ใหม่อีกครั้ง',
          meta: { turnId, reason },
        });
      }
    }
    this.store.trimMessages(chatId);

    for (const [id, p] of [...this.pendingInteractions]) {
      if (p.chatId === chatId) {
        // The waiter that actually unblocks the agent lives on the MspClient
        // (_permWaiters) — pendingInteractions is metadata only. Resolving it
        // here is what lets a watchdog/released settle un-park an agent that
        // is still sitting on session/request_permission.
        try { slot.client?.resolvePermission(id, 'reject'); } catch { /* ignore */ }
        this.pendingInteractions.delete(id);
        this.wire.emit(chatId, 'interaction_resolved', { id, optionId: 'reject', reason: 'turn settled' });
      }
    }

    this.wire.emit(chatId, error ? 'turn_error' : 'turn_done', {
      turnId,
      reason,
      content: finalText,
      error,
      toolCalls: [...turn.toolCalls.values()],
      durationMs,
      chat: this.chatSummary(this.store.get(chatId) || { id: chatId, messages: [] }),
    });
    slot.turn = null;
    return true;
  }

  /**
   * True while the agent process is alive AND a turn is still in flight —
   * silence then means a long quiet tool run, not a dead turn. MSP's
   * turn/start admits fast (completion arrives as a notification), so the
   * in-flight signal is status === 'running' for the whole prompt() window;
   * the _pending scan stays as a second witness for the admission moment.
   */
  _clientLively(slot) {
    const client = slot?.client;
    if (!client) return false;
    if (client.status === 'exited') return false;
    if (!isClientAlive(client)) return false;
    if (client._pending instanceof Map) {
      for (const p of client._pending.values()) {
        if (p?.method === 'turn/start' || p?.method === 'session/prompt') return true;
      }
    }
    // status==='running' covers the whole prompt() window.
    return client.status === 'running';
  }

  _hasPendingInteraction(chatId) {
    for (const p of this.pendingInteractions.values()) {
      if (p.chatId === chatId) return true;
    }
    return false;
  }

  /** One line per minute per held turn — a held turn with zero log reads as
   *  a dead watchdog (grok-desktop _tickStickyRunning logs the same way). */
  _logStickyHold(chatId, turn, now, why) {
    if (now - (turn._holdLogAt || 0) < 60_000) return;
    turn._holdLogAt = now;
    const silentFor = now - (turn.sawActivity ? turn.lastActivity : turn.startedAt);
    console.log(
      `[sessions ${new Date(now).toISOString()}] sticky-hold ${String(chatId).slice(0, 8)}… silenceMs=${silentFor} lively=true why=${why}`,
    );
  }

  /**
   * Re-read pending approvals + userInput prompts point-in-time and act on
   * what the live frames never delivered (BUG-084): mount cards the UI can
   * answer, auto-cancel the shapes it cannot, and escalate cancels the agent
   * ignored past grace. Single-flight per chat via slot._pollInFlight; the
   * turn is re-validated after every await. Never settles directly — the
   * only settle path is _escalateIgnoredPrompt, which still funnels through
   * settleTurn.
   */
  async _pollPendingPrompts(chatId, turnId) {
    const slot = this.slots.get(chatId);
    const turn = slot?.turn;
    if (!turn || turn.turnId !== turnId || turn.settled) return;
    const client = slot?.client;
    if (!client || !isClientAlive(client)) return;
    let snap;
    try {
      snap = await client.listPending();
      slot._pollFailed = false;
    } catch (err) {
      // Throttled: a failing poll must not spam one line per tick.
      if (!slot._pollFailed) {
        slot._pollFailed = true;
        console.warn(`[sessions ${new Date().toISOString()}] pending-poll ${String(chatId).slice(0, 8)}… failed: ${err?.message || err}`);
      }
      return;
    }
    // Re-validate after the await — the turn may have settled mid-poll.
    const turnNow = this.slots.get(chatId)?.turn;
    if (!turnNow || turnNow.turnId !== turnId || turnNow.settled) return;
    const now = Date.now();
    if (!slot.cancelledPrompts) slot.cancelledPrompts = new Map();

    // Approvals first: a missed approval frame wedges the same way a missed
    // question does — the run waits, the user sees nothing.
    for (const a of snap.approvals) {
      const id = String(a?.approvalId || '').trim();
      if (!id || client.hasInteractiveWaiter(id)) continue;
      console.log(`[sessions ${new Date().toISOString()}] pending-poll ${String(chatId).slice(0, 8)}… mount approval ${id}`);
      try { client.recoverApproval(a); } catch { /* a bad frame must not kill the poll */ }
    }

    // Drop cancels whose prompts are gone — settled answers must not linger.
    const liveIds = new Set(snap.userInputs.map((p) => String(p?.userInputId || '')));
    for (const id of [...slot.cancelledPrompts.keys()]) {
      if (!liveIds.has(id)) slot.cancelledPrompts.delete(id);
    }

    const { mount, cancel, escalate } = classifyPendingUserInputs({
      pending: snap.userInputs,
      knownIds: client.interactiveWaiterIds(),
      cancelledAt: slot.cancelledPrompts,
      now,
      graceMs: resolveCancelGraceMs(),
    });
    for (const p of mount) {
      console.log(`[sessions ${new Date().toISOString()}] pending-poll ${String(chatId).slice(0, 8)}… mount question ${p.userInputId}`);
      try { client.recoverUserInput(p, 'poll'); } catch { /* keep polling the rest */ }
    }
    for (const p of cancel) {
      let action = null;
      try { action = client.recoverUserInput(p, 'poll'); } catch { /* recorded below anyway */ }
      // A failed cancel re-escalates on evidence (still pending past grace),
      // never on a local guess — so record every attempt, not just acks.
      if (action !== 'duplicate') slot.cancelledPrompts.set(String(p.userInputId), now);
      console.log(`[sessions ${new Date().toISOString()}] pending-poll ${String(chatId).slice(0, 8)}… auto-cancel ${p.userInputId} (${action || 'failed'})`);
    }
    if (escalate.length) {
      await this._escalateIgnoredPrompt(chatId, turnId, escalate[0]);
    }
  }

  /**
   * Last resort for a prompt the agent still holds past cancel grace
   * (BUG-084): interrupt the run, settle loud with the cause, and release
   * the host so the next prompt boots fresh. This is what makes "stuck on
   * request_user_input" impossible to hold forever.
   */
  async _escalateIgnoredPrompt(chatId, turnId, stuck) {
    const slot = this.slots.get(chatId);
    const turn = slot?.turn;
    if (!turn || turn.turnId !== turnId || turn.settled) return;
    const n = Array.isArray(stuck?.questions) ? stuck.questions.length : 0;
    console.warn(`[sessions ${new Date().toISOString()}] pending-poll ${String(chatId).slice(0, 8)}… ESCALATE ${stuck?.userInputId} still pending ${Math.round((stuck?.waitedMs || 0) / 1000)}s after cancel — interrupting run`);
    try {
      await slot.client?.interrupt();
    } catch { /* the interrupt is best-effort; the settle below is the guarantee */ }
    this.settleTurn(chatId, turnId, {
      reason: 'watchdog',
      error: `agent ค้างที่คำถาม request_user_input (${n} คำถาม) — ยกเลิกแล้วแต่ agent ไม่ขยับ จึงตัดเทิร์นทิ้ง ลอง prompt ใหม่อีกครั้ง`,
    });
    void this.releaseClient(chatId, 'ignored userInput cancel: run interrupted, host released').catch(() => {});
  }

  _checkWatchdog(chatId, turnId) {
    const slot = this.slots.get(chatId);
    const turn = slot?.turn;
    if (!turn || turn.turnId !== turnId || turn.settled) return;
    const now = Date.now();

    // A mounted permission card is an intentional human wait — freeze the
    // stall clock so the card outlives the watchdog, and restart the
    // countdown only after it resolves (grok-desktop R52).
    if (this._hasPendingInteraction(chatId)) {
      if (turn.sawActivity) turn.lastActivity = now;
      else turn.startedAt = now;
      return;
    }

    // Liveness guard: while the agent is alive and the turn is still
    // in flight, never settle for silence — a >15 min quiet build is work,
    // not a wedge. Settling here would strand the real reply (settleTurn
    // would reject it) and let a second prompt run concurrently on the same
    // MSP session. The hard cap is the backstop for a genuinely wedged turn.
    if (this._clientLively(slot)) {
      // Deaf-client backstop (chat 81442763): a turn that never received a
      // single frame is NOT "a quiet build" — turn/started + item/started
      // always precede any work, so zero activity past NO_ACTIVITY_MS means
      // the channel is deaf or the agent never started. Settle loudly and
      // release the useless client so the next prompt boots a fresh one.
      // Turns that HAD activity still hold forever (74f04882).
      if (!turn.sawActivity && now - turn.startedAt > NO_ACTIVITY_MS) {
        this.settleTurn(chatId, turnId, {
          reason: 'watchdog',
          error: `agent ไม่ส่งอะไรกลับมาเลยภายใน ${Math.round(NO_ACTIVITY_MS / 1000)}s — ไม่ได้ยิน agent (ตัดการเชื่อมต่อแล้ว ลอง prompt ใหม่อีกครั้ง)`,
        });
        void this.releaseClient(chatId, 'deaf client: zero frames past no-activity window').catch(() => {});
        return;
      }
      // Pending-prompt recovery (BUG-084): the agent can sit parked on a
      // question nobody can answer — a missed live frame, or an auto-cancel
      // the host rejected — while silence grows forever under lively-hold.
      // Past the poll threshold, re-read the pending set point-in-time
      // (mount / cancel / escalate). Fire-and-forget; the hold below
      // stands either way.
      const pendingSilentMs = now - (turn.sawActivity ? turn.lastActivity : turn.startedAt);
      if (pendingSilentMs > resolvePendingPollMs() && !slot._pollInFlight) {
        slot._pollInFlight = true;
        void this._pollPendingPrompts(chatId, turnId).finally(() => {
          if (this.slots.get(chatId) === slot) slot._pollInFlight = false;
        });
      }
      // CLI parity: a live agent holding the turn open is never auto-settled
      // by default — not for silence, not for elapsed time. A ceiling exists
      // only as an explicit opt-in (MUSE_DESKTOP_WATCHDOG_HARD_MS), and even
      // then a tool still marked live (long shell / MCP call) holds it:
      // chat 74f04882 proved a silent stretch is deliberation, not death.
      const hardMs = resolveWatchdogHardMs();
      if (!hardMs) {
        this._logStickyHold(chatId, turn, now, 'lively-hold');
        return;
      }
      const anyLiveTool = [...(turn.toolCalls?.values?.() || [])].some((t) =>
        /pending|in_progress|running/i.test(String(t?.status || '')),
      );
      if (anyLiveTool) {
        this._logStickyHold(chatId, turn, now, 'live-tool');
        return;
      }
      const silentFor = now - (turn.sawActivity ? turn.lastActivity : turn.startedAt);
      if (silentFor <= hardMs) {
        this._logStickyHold(chatId, turn, now, 'lively');
        return;
      }
      this.settleTurn(chatId, turnId, {
        reason: 'watchdog',
        error: `agent ค้างเกิน ${Math.round(hardMs / 60000)} นาทีทั้งที่ยังเชื่อมต่ออยู่ — ตัดเทิร์นตาม hard cap`,
      });
      return;
    }

    if (!turn.sawActivity && now - turn.startedAt > NO_ACTIVITY_MS) {
      this.settleTurn(chatId, turnId, {
        reason: 'watchdog',
        error: `agent ไม่ตอบสนองภายใน ${Math.round(NO_ACTIVITY_MS / 1000)}s`,
      });
      return;
    }
    if (turn.sawActivity && now - turn.lastActivity > STALL_MS) {
      this.settleTurn(chatId, turnId, {
        reason: 'watchdog',
        error: `สตรีมค้างเกิน ${Math.round(STALL_MS / 1000)}s`,
      });
    }
  }

  async cancel(chatId) {
    const slot = this.slots.get(chatId);
    if (!slot?.client) return { cancelled: false };
    const turnId = slot.turn?.turnId;
    await slot.client.cancel();
    if (turnId) this.settleTurn(chatId, turnId, { reason: 'cancelled' });
    return { cancelled: true, turnId: turnId || null };
  }

  async setMode(chatId, mode) {
    const next = normalizeSessionMode(mode);
    this.store.update(chatId, { mode: next });
    const slot = this.slots.get(chatId);
    let applied = null;
    if (slot?.client) applied = await slot.client.setSessionMode(next);
    this.wire.emit(chatId, 'mode_changed', {
      mode: next,
      modeId: slot?.client?.currentModeId || null,
      applied,
    });
    return { mode: next, applied };
  }

  /**
   * Change the chat's model or thinking effort (POST /api/chats/:id/config).
   * The value is persisted to the store either way; with a live client it is
   * validated against the advertised configOptions and applied via
   * `session/set_config_option`, and the fresh selects ride both the reply
   * and the `config_changed` broadcast. A cold chat validates against the
   * agent-wide catalog cache when one exists (BUG-079); with NO catalog at
   * all the value is accepted-and-persisted — applySessionConfig() skips
   * unadvertised values at spawn, so a stale pick degrades instead of
   * bricking. Errors carry `.status = 400` for unknown ids/values.
   */
  async setChatConfig(chatId, body = {}) {
    const chat = this.store.get(chatId);
    if (!chat) return null;
    const kind = String(body.configId || '');
    if (kind !== 'model' && kind !== 'thinking') {
      const err = new Error(`unknown configId ${kind || '(missing)'} — expected model|thinking`);
      err.status = 400;
      throw err;
    }
    const value = String(body.value ?? '');
    if (!value) {
      const err = new Error(`empty value for ${kind}`);
      err.status = 400;
      throw err;
    }

    const slot = this.slots.get(chatId);
    const client = slot?.client && isClientAlive(slot.client) ? slot.client : null;
    if (client) {
      try {
        await client.setConfigOption(kind, value);
        this._learnConfig(client);
      } catch (err) {
        // A model the stored history is incompatible with kills the resumed
        // session — rotate exactly like the prompt path: clear the dead id
        // (update() flushNow()s it), notice in the transcript, release the
        // client; the stored value applies at the next spawn.
        if (!isHistoryIncompatibleError(err)) throw err;
        this.store.update(chatId, { mspSessionId: null });
        this._rotated.set(chatId, {
          reason: 'history-incompatible',
          message: formatRpcError(err),
        });
        this.store.addMessage(chatId, {
          role: 'notice',
          text: HISTORY_INCOMPATIBLE_NOTICE,
        });
        await this.releaseClient(chatId, 'history-incompatible');
      }
    } else {
      // Cold chat: the cached catalog stands in for the live validation —
      // same 400 the client would raise (BUG-079).
      const cached = this.catalog.selects();
      if (cached) {
        const select = kind === 'model' ? cached.model : cached.thinking;
        const bad = (msg) => {
          const err = new Error(msg);
          err.status = 400;
          throw err;
        };
        if (!select) bad(`config ${kind} is not advertised by this agent/model`);
        if (select.values?.length && !select.values.includes(value)) {
          bad(`${kind}=${value} not advertised (${select.values.join('/')})`);
        }
      }
    }
    this.store.update(chatId, kind === 'model' ? { model: value } : { effort: value });
    const config = this.chatConfig(chatId);
    this.wire.emit(chatId, 'config_changed', { configId: kind, value, config });
    return { config };
  }

  // ------------------------------------------------------------- streaming

  _touch(chatId, turnId) {
    const slot = this.slots.get(chatId);
    const turn = slot?.turn;
    if (!turn || turn.turnId !== turnId || turn.settled) return null;
    turn.sawActivity = true;
    turn.lastActivity = Date.now();
    return turn;
  }

  /**
   * Batch one stream chunk per chat. The frame that eventually goes out
   * carries the accumulated `delta` plus the running-total `text` captured at
   * queue time — the renderer trusts `text`, so batching loses nothing.
   */
  _queueDelta(chatId, turnId, kind, delta, text) {
    let buf = this._deltaBufs.get(chatId);
    if (!buf) {
      buf = {};
      this._deltaBufs.set(chatId, buf);
    }
    const entry = buf[kind] || (buf[kind] = { turnId, delta: '', text: '', timer: null });
    entry.turnId = turnId;
    entry.delta += delta;
    entry.text = text;
    if (DELTA_FLUSH_MS <= 0 || entry.delta.length >= DELTA_FLUSH_CHARS) {
      this._flushDelta(chatId, kind);
      return;
    }
    if (!entry.timer) {
      entry.timer = setTimeout(() => this._flushDelta(chatId, kind), DELTA_FLUSH_MS);
      entry.timer.unref?.();
    }
  }

  _flushDelta(chatId, kind) {
    const entry = this._deltaBufs.get(chatId)?.[kind];
    if (!entry) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (!entry.delta) return;
    const { turnId, delta, text } = entry;
    entry.delta = '';
    this.wire.emit(chatId, kind === 'message' ? 'message_delta' : 'thought_delta', {
      turnId,
      delta,
      text,
    });
  }

  _onUpdate(chatId, params) {
    const slot = this.slots.get(chatId);
    const turn = slot?.turn;
    // Updates outside a live turn still matter (mode echoes, command lists),
    // but chunk accumulation only makes sense while a turn is open.
    const turnId = turn && !turn.settled ? turn.turnId : null;
    const { kind, update } = readUpdate(params);
    // Every frame from the agent is liveness, not just the kinds we render —
    // a turn that emits only thoughts / unknown kinds must still feed the
    // watchdog (grok-desktop bumps on every RPC frame).
    const t = turnId ? this._touch(chatId, turnId) : null;

    switch (kind) {
      case 'agent_message_chunk': {
        const delta = extractText(update.content);
        if (!delta) return;
        if (t) {
          t.text += delta;
          this._queueDelta(chatId, turnId, 'message', delta, t.text);
          return;
        }
        this.wire.emit(chatId, 'message_delta', { turnId, delta, text: delta });
        return;
      }
      case 'agent_thought_chunk': {
        const delta = extractText(update.content);
        if (!delta) return;
        if (t) {
          t.thought += delta;
          this._queueDelta(chatId, turnId, 'thought', delta, t.thought);
          return;
        }
        this.wire.emit(chatId, 'thought_delta', { turnId, delta, text: delta });
        return;
      }
      case 'user_message_chunk': {
        // Echo of what we just sent. Dropping it is the whole point — grok
        // appended these and every restart showed each prompt twice.
        return;
      }
      case 'msp:subagent':
      case 'msp:workflow':
      case 'msp:reminder_child': {
        const snap = update.item && typeof update.item === 'object' ? update.item : null;
        const id = String(snap?.itemId || update.itemId || '');
        if (!id) return;
        if (!slot) return;
        if (!slot.subagents) slot.subagents = new Map();
        const prev = slot.subagents.get(id) || {};
        const record = {
          ...prev,
          ...snap,
          itemId: id,
          kind: snap?.kind || prev.kind
            || (kind === 'msp:workflow' ? 'workflow' : kind === 'msp:reminder_child' ? 'reminderChild' : 'subagent'),
          chatId,
          turnId: turnId || prev.turnId || null,
          updatedAt: Date.now(),
        };
        slot.subagents.set(id, record);
        this.wire.emit(chatId, 'subagent', { turnId, subagent: record });
        this._persistSubagents(chatId, slot);
        // A landed reminder already decided — fold the verdict now so the
        // row carries its topic without waiting for a drill. Fire-and-forget
        // over the live client only: a background read must never warm an
        // agent (the drill path folds on demand when this is skipped).
        if (kind === 'msp:reminder_child'
          && record.childSessionId && !record.result?.summary
          && ['completed', 'failed', 'cancelled'].includes(String(record.status || ''))) {
          const live = slot.client && slot.client.proc?.exitCode == null ? slot.client : null;
          if (live) {
            live.request('session/read', {
              sessionId: record.childSessionId,
              excludeItems: false,
            }, { timeoutMs: 15_000 }).then((res) => {
              const dec = extractReminderDecision(res?.history?.items);
              const line = dec && reminderDecisionLine(dec);
              if (!line) return;
              const cur = slot.subagents.get(id);
              if (!cur || cur.result?.summary) return;
              this._foldReminderVerdict(chatId, cur, line);
            }).catch(() => { /* a pruned child just keeps its bare row */ });
          }
        }
        return;
      }
      case 'msp:subagent_delta': {
        const id = String(update.itemId || '');
        const delta = String(update.delta || '');
        if (!id || !delta || !slot?.subagents?.has(id)) return;
        const rec = slot.subagents.get(id);
        const text = `${rec.liveText || ''}${delta}`.slice(-SUBAGENT_LIVE_MAX);
        rec.liveText = text;
        rec.updatedAt = Date.now();
        this.wire.emit(chatId, 'subagent_delta', { turnId, itemId: id, delta, text });
        return;
      }
      case 'tool_call':
      case 'tool_call_update': {
        this._noteMcpUsage(mcpServerOfToolKind(update.kind));
        const id = String(update.toolCallId || update.tool_call_id || update.id || randomUUID());
        const prev = t?.toolCalls.get(id) || {};
        const record = {
          id,
          title: update.title ?? prev.title ?? update.kind ?? 'tool',
          kind: update.kind ?? prev.kind ?? null,
          status: update.status ?? prev.status ?? 'pending',
          locations: update.locations ?? prev.locations ?? [],
          output: extractToolOutput(update) || prev.output || '',
          rawInput: update.rawInput ?? prev.rawInput ?? null,
        };
        // Inline child activity: an agent row that names a durable child
        // links to its registry record, so the transcript can inline the
        // child's activity without a second lookup. Re-resolved on every
        // update — a spawn row gains its id when the output lands.
        const agentLink = agentRowLink(record);
        if (agentLink) record.agentLink = agentLink;
        if (t) t.toolCalls.set(id, record);
        this.wire.emit(chatId, kind === 'tool_call' ? 'tool_call' : 'tool_call_update', {
          turnId,
          tool: record,
        });
        // Native subagent tools double as the parallel-children feed — the
        // same row paints the transcript AND folds into the rail registry.
        if (slot) this._trackNativeSubagent(chatId, turnId, slot, record);
        return;
      }
      case 'plan': {
        const entries = Array.isArray(update.entries) ? update.entries : [];
        if (t) t.plan = entries;
        this.wire.emit(chatId, 'plan', { turnId, entries });
        return;
      }
      case 'msp:goal': {
        if (!slot) return;
        slot.goal = update.goal ?? null;
        // The live goal is bound to the session it arrived under, exactly
        // like the persisted snapshot — the slot outlives agent exits, so
        // without this the old goal leaks into the next session id.
        slot.goalSessionId = slot.client?.sessionId ?? null;
        // Mirror to disk so the goal rehydrates after a host restart
        // (getGoal falls back to the store on a cold chat). Bound to the
        // originating MSP session — a rotation retires it, a resume keeps
        // it. Controls stay live-only — goalCommand 409s without a
        // running agent.
        try {
          this.store.saveGoal(chatId, slot.goal, slot.client?.sessionId ?? null);
        } catch { /* a persist hiccup must never break the turn path */ }
        this.wire.emit(chatId, 'goal', { turnId, goal: slot.goal });
        return;
      }
      case 'msp:ctx': {
        if (!slot) return;
        slot.ctx = update.ctx;
        this.wire.emit(chatId, 'ctx', { turnId, ctx: slot.ctx, tokens: slot.tokens ?? null });
        return;
      }
      case 'msp:tokens': {
        if (!slot) return;
        slot.tokens = update.tokens;
        this.wire.emit(chatId, 'ctx', { turnId, ctx: slot.ctx ?? null, tokens: slot.tokens });
        return;
      }
      case 'msp:usage': {
        // Subscription usage is account-level, not per chat — cache it and
        // broadcast globally so every window's pill moves together.
        this.setUsageCache(update.usage);
        this.wire.emit(null, 'usage', { usage: update.usage });
        return;
      }
      case 'available_commands_update': {
        this.wire.emit(chatId, 'available_commands', {
          commands: update.availableCommands || update.commands || [],
        });
        return;
      }
      case 'current_mode_update': {
        this.wire.emit(chatId, 'agent_mode_echo', { modeId: update.currentModeId || update.modeId || null });
        return;
      }
      case 'config_option_update': {
        const slotClient = this.slots.get(chatId)?.client;
        if (slotClient && Array.isArray(update.configOptions)) {
          slotClient.configOptions = update.configOptions;
          this._learnConfig(slotClient); // the push refreshes the catalog too (BUG-079)
        }
        this.wire.emit(chatId, 'config_option_update', { update });
        return;
      }
      case 'msp:user_input_unsupported': {
        // Persist, not just broadcast: the SSE trace alone vanishes on
        // reload, and the turn that follows ("continuing without an answer")
        // reads as a non sequitur without it (BUG-084).
        const qs = Array.isArray(update.questions) ? update.questions : [];
        // Record the live-path cancel too: without this a live auto-cancel
        // the agent ignores would re-cancel every poll tick and never
        // escalate, because cancelledAt only tracked poll-path cancels.
        if (slot && update.userInputId) {
          if (!slot.cancelledPrompts) slot.cancelledPrompts = new Map();
          slot.cancelledPrompts.set(String(update.userInputId), Date.now());
        }
        const heads = qs.map((q) => String(q?.header || q?.id || '').trim()).filter(Boolean);
        this.store.addMessage(chatId, {
          role: 'notice',
          text: `agent ถาม ${qs.length} คำถามพร้อมกัน${heads.length ? ` (${heads.slice(0, 4).join(' / ')})` : ''} — เดสก์ท็อปแสดงได้ทีละคำถาม จึงยกเลิกให้ agent ตอบต่อเอง`,
          meta: { ...(turnId ? { turnId } : {}), userInputId: update.userInputId || null },
        });
        this.wire.emit(chatId, 'agent_update_other', { kind: kind || 'unknown', update });
        return;
      }
      default: {
        // Unknown kinds are forwarded rather than swallowed: a silently
        // dropped channel is how grok lost `plan` for months.
        this.wire.emit(chatId, 'agent_update_other', { kind: kind || 'unknown', update });
      }
    }
  }

  _onPermission(chatId, req) {
    if (req?.resolved) {
      this.pendingInteractions.delete(req.id);
      this.wire.emit(chatId, 'interaction_resolved', {
        id: req.id,
        optionId: req.optionId,
        reason: req.reason || null,
      });
      return;
    }
    // Scoped like every other turn event: a renderer that missed turn_started
    // binds the turn from this frame (BUG-015).
    const turn = this.slots.get(chatId)?.turn;
    const payload = {
      id: req.id,
      kind: 'permission',
      toolName: req.toolName,
      toolCallId: req.toolCallId || null,
      subtype: req.subtype || null,
      summary: req.summary,
      body: req.body || '',
      options: req.options || [],
      turnId: turn && !turn.settled ? turn.turnId : null,
      ts: Date.now(),
    };
    // Stored, not just broadcast: a client that was not watching this chat
    // when the request arrived must still be able to answer it.
    this.pendingInteractions.set(req.id, { chatId, payload });
    this._touch(chatId, turn?.turnId);
    this.wire.emit(chatId, 'interaction', payload);
  }

  resolveInteraction(interactionId, optionId) {
    const pending = this.pendingInteractions.get(interactionId);
    if (!pending) return false;
    const slot = this.slots.get(pending.chatId);
    const ok = slot?.client?.resolvePermission(interactionId, optionId);
    this.pendingInteractions.delete(interactionId);
    this.wire.emit(pending.chatId, 'interaction_resolved', { id: interactionId, optionId });
    return !!ok;
  }

  listPendingInteractions() {
    return [...this.pendingInteractions.entries()].map(([id, p]) => ({
      id,
      chatId: p.chatId,
      ...p.payload,
    }));
  }

  // ------------------------------------------------------------ subagents

  /**
   * One child's record, live slot first, persisted mirror second. The store
   * fallback is what keeps the rail and drill-downs working on a cold chat
   * after a restart — without warming an agent just to list rows.
   */
  subagentRecord(chatId, itemId) {
    const key = String(itemId);
    return this.slots.get(chatId)?.subagents?.get(key)
      || (this.store.get(chatId)?.subagents || []).find((r) => r?.itemId === key)
      || null;
  }

  listSubagents(chatId) {
    const slot = this.slots.get(chatId);
    if (slot?.subagents) {
      return [...slot.subagents.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }
    const stored = this.store.get(chatId)?.subagents || [];
    return [...stored].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  /** Mirror the registry to disk (debounced, liveText stripped). Item frames
   * and tool completions are low-frequency state transitions, unlike
   * per-chunk deltas — safe to persist on every one. */
  _persistSubagents(chatId, slot) {
    try {
      this.store.saveSubagents(chatId, [...(slot?.subagents?.values() || [])]
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
    } catch { /* a persist hiccup must never break the turn path */ }
  }

  /**
   * Fold a native-subagent tool row (spawn/wait/cancel/read_result) into a
   * `kind: 'native'` registry record. Native children have no MSP session,
   * so the registry row IS the child view — topic from spawn args, result
   * from the wait output, drill-down from the folded I/O (see readSubagent).
   */
  _trackNativeSubagent(chatId, turnId, slot, toolRow) {
    let folded;
    try {
      folded = nativeSubagentPatch({
        toolCallId: toolRow.id,
        kind: toolRow.kind,
        rawInput: toolRow.rawInput,
        output: toolRow.output,
        status: toolRow.status,
      });
    } catch {
      return;
    }
    if (!folded) return;
    this._applyNativePatch(chatId, turnId, slot, folded);
  }

  /** Merge one folded patch into the registry + mirror. Shared by the live
   * tracker and the boot backfill, so a re-read never duplicates a row. */
  _applyNativePatch(chatId, turnId, slot, folded) {
    if (!slot.subagents) slot.subagents = new Map();
    const prev = slot.subagents.get(folded.key) || {};
    // Patches use null for "unknown" — strip them so a skeleton never wipes
    // a topic the spawn already recorded (same rule as the result merge).
    const patch = Object.fromEntries(
      Object.entries(folded.rec).filter(([, v]) => v != null),
    );
    const record = {
      ...prev,
      ...patch,
      itemId: folded.key,
      kind: 'native',
      chatId,
      turnId: turnId || prev.turnId || null,
      // The MSP session that owns this child — stamped at fold time and
      // kept across rotation, so the native transcript adapter always
      // resolves the log under the OWNING parent, never the current one.
      parentSessionId: prev.parentSessionId ?? slot?.client?.sessionId ?? null,
      startedAt: prev.startedAt || Date.now(),
      updatedAt: Date.now(),
    };
    // Merge results instead of replacing: a read_result attaches text to the
    // summary the wait already recorded. Nulls never wipe: a patch that
    // carries no summary must not erase the one already stored.
    if (prev.result || folded.rec.result) {
      const incoming = Object.fromEntries(
        Object.entries(folded.rec.result || {}).filter(([, v]) => v != null),
      );
      record.result = { ...(prev.result || {}), ...incoming };
    }
    if (record.status && record.status !== 'inProgress' && record.startedAt) {
      record.durationMs = Math.max(0, record.updatedAt - record.startedAt);
    }
    slot.subagents.set(folded.key, record);
    this.wire.emit(chatId, 'subagent', { turnId, subagent: record });
    this._persistSubagents(chatId, slot);
  }

  /**
   * Recover native children from turns the live tracker never saw (older
   * than the tracker, or spawned while the host was down). The agent-side
   * history still carries the full spawn/wait outputs the old client
   * dropped, so one boot-time parent read rebuilds every row. Once per slot,
   * fire-and-forget, best-effort — a failure just means live-tracking only.
   */
  async _backfillNativeSubagents(chatId, slot, client) {
    if (!slot || slot.backfilled) return;
    slot.backfilled = true;
    try {
      const data = await client.request(
        'session/read',
        { sessionId: client.sessionId, excludeItems: false },
        { timeoutMs: 30_000 },
      );
      const items = data?.history?.items || [];
      for (const it of items) {
        if (!it || it.kind !== 'toolCall' || !NATIVE_SUBAGENT_TOOLS.has(it.tool)) continue;
        let folded = null;
        try {
          folded = nativeSubagentPatch({
            toolCallId: it.itemId,
            kind: it.tool,
            rawInput: it.args ?? it.rawInput ?? null,
            output: it.visibleOutput || it.output || '',
            status: it.status,
          });
        } catch { /* one bad row must not poison the rest */ }
        if (folded) this._applyNativePatch(chatId, it.turnId || null, slot, folded);
      }
    } catch { /* best-effort by design */ }
  }

  /**
   * Read-only native transcript for one child record, or null when no
   * verified mapping exists (unstamped record, missing log, workspace
   * mismatch, ambiguous parent — every miss falls back to the synthesized
   * fold, never throws into the drill path).
   */
  _readNativeLog(chatId, rec) {
    try {
      const parentId = rec?.parentSessionId;
      const childId = rec?.subagentId;
      const chatCwd = this.store.get(chatId)?.cwd;
      if (!parentId || !childId || !chatCwd) return null;
      const res = readNativeChildTranscript({ parentId, childId, chatCwd });
      if (!res?.ok) return null;
      return res;
    } catch {
      return null;
    }
  }

  /**
   * Drill into one child: point-in-time `session/read` of its own session
   * (no attach, no lease — a pure read). Warms the chat's agent when cold.
   * Throws NOT_FOUND / NO_SESSION / Error (RPC failure) for the route.
   */
  async readSubagent(chatId, itemId) {
    const rec = this.subagentRecord(chatId, itemId);
    if (!rec) {
      const e = new Error(`unknown subagent ${itemId}`);
      e.code = 'NOT_FOUND';
      throw e;
    }
    // Native children have no MSP session (session/read rejects their id),
    // but a delegated child keeps its own durable log under the owning
    // parent's session dir — the drill reads that transcript when the
    // mapping verifies, and falls back to the synthesized fold when it
    // does not (unstamped record, pruned log, another workspace).
    if (rec.kind === 'native') {
      const items = [];
      const brief = [
        rec.taskName ? `task: ${rec.taskName}` : null,
        rec.title ? `title: ${rec.title}` : null,
        rec.objective ? `objective: ${rec.objective}` : null,
        rec.role ? `role: ${rec.role}` : null,
        rec.agentPath ? `path: ${rec.agentPath}` : null,
        rec.subagentId ? `id: ${rec.subagentId}` : null,
      ].filter(Boolean).join('\n');
      items.push(sanitizeDrillItem({
        itemId: `${rec.itemId}:spawn`,
        kind: 'toolCall',
        status: 'completed',
        tool: 'subagent_spawn',
        fallbackText: brief || 'spawned',
      }));
      const nativeLog = this._readNativeLog(chatId, rec);
      if (nativeLog) {
        for (const it of nativeLog.items) {
          const clean = sanitizeDrillItem({ ...it, itemId: `${rec.itemId}:${it.itemId}` });
          if (clean) items.push(clean);
        }
        if (rec.failureReason) {
          items.push(sanitizeDrillItem({
            itemId: `${rec.itemId}:failure`,
            kind: 'agentMessage',
            status: 'failed',
            text: rec.failureReason,
          }));
        }
        // Latest-run state drives drill polling + status: an active run with
        // no tool rows yet must still poll, and a terminal run must stop.
        const notices = [];
        if (nativeLog.malformed) {
          notices.push(`${nativeLog.malformed} บรรทัดใน log อ่านไม่ได้ — ข้ามไป`);
        }
        if (nativeLog.byteTruncated) {
          const kb = nativeLog.bytesSkipped >= 1024
            ? `${Math.round(nativeLog.bytesSkipped / 1024)} KB`
            : `${nativeLog.bytesSkipped} ไบต์`;
          notices.push(`log ใหญ่ — ข้ามต้นไฟล์ไป ${kb}`);
        }
        return {
          record: rec,
          session: null,
          sessionId: rec.subagentId || null,
          mode: 'native-log',
          terminal: nativeLog.terminal,
          nativeRun: { state: nativeLog.runState, terminal: nativeLog.terminal },
          ...(notices.length ? { notice: notices.join(' · ') } : {}),
          items,
          droppedFromHead: nativeLog.droppedFromHead,
          readAt: Date.now(),
        };
      }
      if (rec.result?.summary || rec.result?.text) {
        items.push(sanitizeDrillItem({
          itemId: `${rec.itemId}:result`,
          kind: 'agentMessage',
          status: 'completed',
          text: rec.result.text || rec.result.summary,
        }));
      } else if (rec.status === 'inProgress') {
        // A running native child has no session to read — the state summary
        // is elapsed time plus the live stream tail when the parent relays it.
        const elapsed = rec.startedAt
          ? `${(Math.max(0, Date.now() - rec.startedAt) / 1000).toFixed(1)}s`
          : null;
        const live = typeof rec.liveText === 'string' && rec.liveText
          ? rec.liveText.slice(-240)
          : null;
        items.push(sanitizeDrillItem({
          itemId: `${rec.itemId}:running`,
          kind: 'agentMessage',
          status: 'inProgress',
          text: [
            `กำลังรัน${elapsed ? ` ${elapsed}` : ''} — ผลจะมาตอน subagent_wait จบ`,
            live ? `ล่าสุด: ${live}` : null,
          ].filter(Boolean).join('\n'),
        }));
      }
      for (const [i, ref] of (rec.result?.evidenceRefs || []).entries()) {
        items.push(sanitizeDrillItem({
          itemId: `${rec.itemId}:evidence:${i}`,
          kind: 'toolCall',
          status: 'completed',
          tool: 'evidence',
          fallbackText: String(ref),
        }));
      }
      if (rec.failureReason) {
        items.push(sanitizeDrillItem({
          itemId: `${rec.itemId}:failure`,
          kind: 'agentMessage',
          status: 'failed',
          text: rec.failureReason,
        }));
      }
      return {
        record: rec,
        session: null,
        sessionId: rec.subagentId || null,
        mode: 'native',
        items,
        droppedFromHead: 0,
        readAt: Date.now(),
      };
    }
    if (!rec.childSessionId) {
      const e = new Error('child has no readable session yet');
      e.code = 'NO_SESSION';
      throw e;
    }
    let drill = null;
    let readError = null;
    try {
      drill = await this.readChildSession(chatId, rec.childSessionId);
    } catch (err) {
      readError = err?.message || String(err);
    }
    // A gone session (pruned/transient child, e.g. a cancelled reminder)
    // must not drill into a bare error page — fall back to the record
    // detail the registry already holds, with the read failure attached.
    if (!drill) {
      const lines = [
        `kind: ${rec.kind}`,
        rec.reminderAgentId ? `agent: ${rec.reminderAgentId}` : null,
        rec.generationId != null ? `generation: ${rec.generationId}` : null,
        rec.taskId ? `task: ${rec.taskId}` : null,
        rec.taskName ? `taskName: ${rec.taskName}` : null,
        rec.title ? `title: ${rec.title}` : null,
        rec.role ? `role: ${rec.role}` : null,
        rec.objective ? `objective: ${rec.objective}` : null,
        `status: ${rec.status || '—'}`,
        rec.durationMs != null ? `duration: ${(rec.durationMs / 1000).toFixed(1)}s` : null,
        rec.result?.summary ? `result: ${rec.result.summary}` : null,
        rec.fallbackText ? `note: ${rec.fallbackText}` : null,
      ].filter(Boolean).join('\n');
      return {
        record: rec,
        session: null,
        sessionId: rec.childSessionId,
        mode: 'gone',
        readError,
        items: [sanitizeDrillItem({
          itemId: `${rec.itemId}:detail`,
          kind: 'agentMessage',
          status: rec.status || 'completed',
          text: lines || 'ไม่มีรายละเอียด',
        })],
        droppedFromHead: 0,
        readAt: Date.now(),
      };
    }
    // A reminder that already decided gets its verdict folded into the
    // registry (the row's topic line) plus a summary card on top of the
    // drill — the raw tool args never leave the server, only this line.
    if (rec.kind === 'reminderChild' && drill.reminderDecision) {
      const line = reminderDecisionLine(drill.reminderDecision);
      if (line) {
        drill.items.unshift(sanitizeDrillItem({
          itemId: `${rec.itemId}:verdict`,
          kind: 'agentMessage',
          status: rec.status || 'completed',
          text: `สรุป: ${line}`,
        }));
        this._foldReminderVerdict(chatId, rec, line);
      }
    }
    return { record: this.subagentRecord(chatId, itemId) || rec, ...drill };
  }

  /**
   * Merge one reminder verdict line into the registry row + mirror. Shared
   * by the drill path (reads on demand) and the live fold (a completion the
   * tracker sees), so whichever lands first wins and the second is a no-op.
   */
  _foldReminderVerdict(chatId, rec, line) {
    if (!rec || rec.result?.summary) return;
    const slot = this.slots.get(chatId);
    const next = {
      ...rec,
      result: { ...(rec.result || {}), summary: line },
      updatedAt: Date.now(),
    };
    if (slot?.subagents) slot.subagents.set(String(rec.itemId), next);
    else if (slot) slot.subagents = new Map([[String(rec.itemId), next]]);
    if (slot) {
      this.wire.emit(chatId, 'subagent', { turnId: rec.turnId || null, subagent: next });
      this._persistSubagents(chatId, slot);
    } else {
      // Cold chat (a drill served straight from disk): mirror the verdict
      // through the store so the next list carries it.
      try {
        const stored = this.store.get(chatId)?.subagents || [];
        this.store.saveSubagents(chatId, stored.map((r) => (
          r?.itemId === rec.itemId ? next : r
        )));
      } catch { /* best-effort by design */ }
    }
  }

  /**
   * The same point-in-time read addressed by child session id — nested
   * children from a drill-down are not in the registry, so the panel chains
   * through here to go one level deeper.
   */
  async readChildSession(chatId, childSessionId) {
    const client = await this.ensureClient(chatId);
    const res = await client.request('session/read', {
      sessionId: childSessionId,
      excludeItems: false,
    }, { timeoutMs: 30_000 });
    const history = res?.history && typeof res.history === 'object' ? res.history : {};
    const mode = typeof history.mode === 'string' ? history.mode : 'unknown';
    const rawItems = Array.isArray(history.items) ? history.items : [];
    // Reminder verdicts live only in the child session (see
    // extractReminderDecision) — read the raw items before sanitize drops
    // the tool args. Null for every other child kind.
    const reminderDecision = extractReminderDecision(rawItems);
    const items = rawItems.map(sanitizeDrillItem).filter(Boolean);
    const CAP = 200;
    const droppedFromHead = items.length > CAP ? items.length - CAP : 0;
    return {
      session: res?.session && typeof res.session === 'object' ? {
        sessionId: String(res.session.sessionId || childSessionId),
        status: String(res.session.status || ''),
        turnCount: Number.isFinite(res.session.turnCount) ? res.session.turnCount : null,
        title: res.session.title != null ? String(res.session.title) : null,
      } : { sessionId: childSessionId, status: '', turnCount: null, title: null },
      mode,
      ...(mode === 'none' && history.noneReason ? { noneReason: String(history.noneReason) } : {}),
      ...(reminderDecision ? { reminderDecision } : {}),
      items: droppedFromHead ? items.slice(droppedFromHead) : items,
      droppedFromHead,
      readAt: Date.now(),
    };
  }

  /**
   * Drive one child (POST …/subagents/:itemId/command) — the rail's per-row
   * stop / resume / send-message buttons. Only kind `subagent` is
   * addressable: workflow folds and reminder children carry no subagentId.
   * Warms the chat's agent like the drill path (an explicit user command,
   * not a background read). The repaint rides the item frames the verb
   * triggers, never this reply — same contract as goalCommand.
   * 404 unknown chat/item · 400 bad action/empty body · 409 cold-kind child.
   */
  async subagentCommand(chatId, itemId, action, opts = {}) {
    if (!this.store.get(chatId)) {
      const err = new Error('chat not found');
      err.status = 404;
      throw err;
    }
    const method = SUBAGENT_COMMANDS[action];
    if (!method) {
      const err = new Error(`unknown subagent action ${action || '(missing)'} — expected stop|resume|send`);
      err.status = 400;
      throw err;
    }
    const rec = this.subagentRecord(chatId, itemId);
    if (!rec) {
      const err = new Error(`unknown subagent ${itemId}`);
      err.status = 404;
      err.code = 'NOT_FOUND';
      throw err;
    }
    if (rec.kind !== 'subagent') {
      const err = new Error(`subagent commands need a subagent child, got ${rec.kind}`);
      err.status = 409;
      err.code = 'UNSUPPORTED';
      throw err;
    }
    if (!rec.subagentId) {
      const err = new Error('child has no addressable subagent id yet');
      err.status = 409;
      err.code = 'NO_SUBAGENT';
      throw err;
    }
    const params = {
      sessionId: null, // filled from the live client below
      subagentId: String(rec.subagentId),
      commandId: uuidv7(),
    };
    if (action === 'send') {
      const body = String(opts.body ?? '').trim();
      if (!body) {
        const err = new Error('send needs a non-empty body');
        err.status = 400;
        throw err;
      }
      params.body = body;
    } else if (opts.reason != null && String(opts.reason).trim() !== '') {
      params.reason = String(opts.reason).trim().slice(0, 500);
    }
    const client = await this.ensureClient(chatId);
    params.sessionId = client.sessionId;
    await client.request(method, params, { timeoutMs: 30_000 });
    return { action, subagentId: params.subagentId };
  }

  /**
   * Retire the goal when a fresh agent session id proves a rotation — the
   * slot (and its goal) survives exits, so an exit + respawn under a NEW
   * id would otherwise leak the old session's goal into the new one. The
   * persisted snapshot retires too: after a restart the slot is fresh (no
   * live goal) but the disk copy is still bound to the old session.
   * Same-id resume retains silently; an actual change clears live + disk
   * and emits one authoritative goal:null so renderers invalidate their
   * mirrors instead of showing the fossil. Returns true when it retired.
   */
  _retireGoalOnRotation(chatId, slot, sessionId) {
    // No proven new id, no proven rotation — a boot that never learned
    // its session id must never wipe either copy.
    if (sessionId == null) return false;
    const liveBound = slot?.goal != null ? (slot.goalSessionId ?? null) : null;
    const liveStale = liveBound != null && liveBound !== sessionId;
    // Fresh slot after a host restart or slot eviction: no live goal, but
    // the persisted snapshot may still be bound to the old session — it
    // retires exactly like a live goal. (A live retire already clears the
    // disk copy below, so this read is only needed when live is absent.)
    let snapStale = false;
    if (!liveStale) {
      try {
        const snap = this.store.get(chatId)?.goal ?? null;
        snapStale = snap != null && snap.sessionId != null && snap.sessionId !== sessionId;
      } catch { snapStale = false; }
    }
    if (!liveStale && !snapStale) return false;
    if (slot) {
      slot.goal = null;
      slot.goalSessionId = null;
    }
    try {
      this.store.saveGoal(chatId, null);
    } catch { /* the live clear is what matters; disk follows best-effort */ }
    // Clearing first makes the retire idempotent — a second pass finds
    // nothing stale, so the invalidation emits exactly once per rotation.
    this.wire.emit(chatId, 'goal', { goal: null });
    return true;
  }

  /** Live slot first, persisted snapshot second — a cold chat (or a fresh
   * host boot) still shows the last known goal until the next goalChanged.
   * Both must belong to the chat's CURRENT agent session: a rotation
   * retires them (stale goal cleared), an ordinary resume retains them.
   * Display-only either way: goalCommand needs a live agent. */
  getGoal(chatId) {
    const slot = this.slots.get(chatId);
    const live = slot?.goal;
    if (live !== undefined) {
      // Backstop behind the eager rotation hook: a live goal bound to a
      // different session than the attached client never leaks through,
      // whichever path swapped the id. A cold slot (no client) keeps
      // showing last-known — that is the rehydration behavior.
      if (live != null && slot.goalSessionId != null && slot.client?.sessionId != null
          && slot.client.sessionId !== slot.goalSessionId) return null;
      return live ?? null;
    }
    const chat = this.store.get(chatId);
    const snap = chat?.goal ?? null;
    if (!snap) return null;
    if (snap.sessionId != null && snap.sessionId !== chat.mspSessionId) return null;
    return snap;
  }

  /**
   * Drive the session goal verb (POST /api/chats/:id/goal) — the rail's
   * pause/resume button, Mcode ConversationStatusPanel parity. Only
   * pause|resume: set/edit/clear stay agent-side. 404 unknown chat ·
   * 400 bad action · 409 cold chat (nothing to command — the button
   * disables itself when cold, this is the backstop). The repaint rides
   * the goalChanged SSE the verb triggers, never this reply.
   */
  async goalCommand(chatId, action) {
    if (!this.store.get(chatId)) {
      const err = new Error('chat not found');
      err.status = 404;
      throw err;
    }
    if (action !== 'pause' && action !== 'resume') {
      const err = new Error(`unknown goal action ${action || '(missing)'} — expected pause|resume`);
      err.status = 400;
      throw err;
    }
    const slot = this.slots.get(chatId);
    const client = slot?.client && isClientAlive(slot.client) ? slot.client : null;
    if (!client?.sessionId) {
      const err = new Error('no live agent for this chat — prompt once to spawn it');
      err.status = 409;
      err.code = 'NO_SESSION';
      throw err;
    }
    await client.request(`goal/${action}`, { sessionId: client.sessionId, commandId: uuidv7() });
    return { action };
  }

  getCtx(chatId) {
    const slot = this.slots.get(chatId);
    return { ctx: slot?.ctx ?? null, tokens: slot?.tokens ?? null };
  }

  _usageCachePath() {
    if (!this._usageCacheFile) {
      const dir = this.store?.file ? path.dirname(this.store.file) : null;
      this._usageCacheFile = dir ? usageCacheFile(dir) : null;
    }
    return this._usageCacheFile;
  }

  /** Single funnel for usage updates: memory cache + on-disk snapshot for
   * external readers (Übersicht). The file write is best-effort and never
   * throws — a quota peek must not break a turn. */
  setUsageCache(usage) {
    if (!usage) return;
    this._usageCache = { usage, at: Date.now() };
    const file = this._usageCachePath();
    if (file) writeUsageCache(file, usage);
  }

  /**
   * Account subscription usage via any hot agent (`usage/read` needs no
   * model call). Cached 60s; null when no agent is hot — the pill shows
   * unknown rather than spawning a whole agent for a quota peek.
   */
  async getUsage() {
    const cached = this._usageCache;
    if (cached && Date.now() - cached.at < 60_000) return cached.usage;
    const slot = [...this.slots.values()].find((s) => s?.client);
    if (!slot) return cached?.usage ?? null;
    try {
      const res = await slot.client.request('usage/read', {}, { timeoutMs: 15_000 });
      const usage = sanitizeSubscriptionUsage(res?.usage);
      if (usage) this.setUsageCache(usage);
      return usage ?? cached?.usage ?? null;
    } catch {
      return cached?.usage ?? null;
    }
  }

  // ------------------------------------------------------------------ mcp

  mcpUsageSnapshot() {
    return Object.fromEntries(this.mcpUsage.entries());
  }

  _mcpUsagePath() {
    if (!this._mcpUsageFile) {
      const dir = this.store?.file ? path.dirname(this.store.file) : null;
      this._mcpUsageFile = dir ? path.join(dir, 'mcp-usage.json') : null;
    }
    return this._mcpUsageFile;
  }

  /** Last-used marks survive restarts — a week of real use is what makes
   * "never used" in the panel a trustworthy trim signal. */
  _loadMcpUsage() {
    try {
      const file = this._mcpUsagePath();
      if (!file) return;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) {
          if (typeof k === 'string' && Number.isFinite(v)) this.mcpUsage.set(k, v);
        }
      }
    } catch {
      /* missing or corrupt — start blank */
    }
  }

  _saveMcpUsageSoon() {
    if (this._mcpUsageTimer || !this._mcpUsagePath()) return;
    this._mcpUsageTimer = setTimeout(() => {
      this._mcpUsageTimer = null;
      try {
        fs.writeFileSync(this._mcpUsagePath(), JSON.stringify(Object.fromEntries(this.mcpUsage.entries())));
      } catch {
        /* state dir unwritable — memory still serves this run */
      }
    }, 1000);
    this._mcpUsageTimer.unref?.();
  }

  _noteMcpUsage(server) {
    if (!server) return;
    this.mcpUsage.set(server, Date.now());
    this._saveMcpUsageSoon();
  }

  /**
   * After an MCP toggle: drop every hot agent that is NOT mid-turn so the
   * next prompt spawns a fresh process with the new config. Running turns
   * keep the old set — killing them would eat the user's work.
   */
  async releaseIdleClients(reason = 'mcp config changed') {
    const released = [];
    const keptRunning = [];
    for (const [chatId, slot] of [...this.slots.entries()]) {
      if (!slot?.client) continue;
      if (slot.turn && !slot.turn.settled) {
        keptRunning.push(chatId);
        continue;
      }
      try {
        await this.releaseClient(chatId, reason);
        released.push(chatId);
      } catch {
        keptRunning.push(chatId);
      }
    }
    return { released, keptRunning };
  }

  // -------------------------------------------------------------- teardown

  async shutdown({ killAgents = true } = {}) {
    if (this._demoteTimer) clearInterval(this._demoteTimer);
    if (killAgents) {
      await Promise.all([...this.slots.keys()].map((id) => this.releaseClient(id, 'host shutdown')));
    } else {
      // Agents outlive the host (deploy/restart) but the live-turn state does
      // not — settle every open turn with a trace instead of letting it
      // evaporate silently (a restart mid-turn used to leave the user message
      // with no reply and no error). The stored mspSessionId is kept, so the
      // next prompt resumes the same agent session where it left off.
      for (const [id, slot] of [...this.slots.entries()]) {
        if (slot?.turn && !slot.turn.settled) {
          this.settleTurn(id, slot.turn.turnId, {
            reason: 'interrupted',
            error: 'host หยุดทำงานระหว่างเทิร์น (deploy/restart) — prompt ใหม่อีกครั้งเพื่อทำต่อ',
          });
        }
      }
    }
    this.store.flushNow();
  }

  stats() {
    const live = [...this.slots.values()].filter((s) => s.client).length;
    const running = [...this.slots.values()].filter((s) => s.turn && !s.turn.settled).length;
    return {
      chats: this.store.list().length,
      groups: this.store.listGroups().length,
      hot: live,
      running,
      maxHot: this.defaults.maxHot,
      pendingInteractions: this.pendingInteractions.size,
    };
  }
}
