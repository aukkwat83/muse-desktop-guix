// Muse Desktop renderer.
//
// Two rules shape everything here:
//
//  1. **The server is the source of truth.** Nothing is painted from an HTTP
//     response body; `POST /prompt` only yields a turnId. Every visible change
//     arrives as an SSE event, so a second window — or the same window after a
//     reload — shows exactly the same thing.
//
//  2. **Turn state is per chat, keyed by turnId.** A global "current turn"
//     breaks the moment you switch chats while one is streaming: the other
//     chat's chunks land in the visible transcript. `turnViews` keeps one
//     record per chat and paints only when that chat is on screen.

import { renderMarkdown, installCodeCopyDelegation, copyTextToClipboard, paintMarkdownDiagrams, applyMermaidTheme, installDiagramDownloadDelegation } from './markdown.js?v=0.4.4';
import { escapeHtml } from './markdown-core.js?v=0.4.1';
import { Sidebar } from './sidebar.js?v=0.4.6';
import { initSidebarResize } from './sidebar-resize.js?v=1.0.0';
import { initRightbarResize } from './rightbar-resize.js?v=1.0.0';
import { closePopover, miniConfirm, openMenu, openPanel } from './popover.js?v=0.4.2';
import { createMcpPanel } from './mcp-panel.js?v=1.0.0';
import { createRightbar, goalControlFor, goalStatusWord } from './rightbar.js?v=1.1.3';
import { createChildActivity } from './child-activity.js?v=1.0.0';
import { paintApTitle } from './ap-tags.js?v=1.0.0';
import { formatCtxMeter } from './ctx-meter.js?v=1.0.0';
import { computePin } from './scroll-pin.js?v=0.4.0';
import { createComposerDraftStore } from './composer-draft.js?v=0.4.0';
import { createPromptQueue, shouldDispatch } from './prompt-queue.js?v=0.4.0';
import { adaptiveHistoryDefaults, computeHistoryStartIndex, expandHistoryStartIndex, sliceHistoryMessages } from './history-window.js?v=0.4.0';
import { parseSlashCommand } from './slash-commands.js?v=0.4.0';
import { chatToMarkdown } from './transcript-markdown.js?v=0.4.0';
import { createTurnView, bindTurnId, interruptedMarkerText, liveChildOrder, createLivePaintScheduler, seedTurnView, resolveStatusVerb, ixSubmitTransition, toolStatusLabel, ixPrimaryOptionId, ixKeyToOptionId, escStopAction, confirmedStopProceeds, messageChildOrder, shouldAutoExpandTool, toggleProgressOpen, progressSummary, progressTopic, toolTopic, configSelectsFromOptions, modelShortName, configMenuItems, agentToolMeta, agentSubtitle, toolDisplayState, agentCounts, formatElapsed, turnHeaderLabel } from './turn-view.js?v=0.4.24';

const $ = (sel) => document.querySelector(sel);

const el = {
  sidebarNav: $('#sidebar-nav'),
  newGroup: $('#new-group'),
  transcript: $('#transcript'),
  title: $('#chat-title'),
  cwd: $('#chat-cwd'),
  agentState: $('#agent-state'),
  agentsChip: $('#agents-chip'),
  tasksChip: $('#tasks-chip'),
  goalChip: $('#goal-chip'),
  liveCluster: $('#live-cluster'),
  overviewBtn: $('#overview-btn'),
  goalBar: $('#goal-bar'),
  goalObjective: $('#goal-bar .goal-objective'),
  goalMeta: $('#goal-bar .goal-meta'),
  goalBarBtn: $('#goal-bar-btn'),
  mcpBtn: $('#mcp-btn'),
  contextPill: $('#context-pill'),
  ctxBarFill: $('#ctx-bar-fill'),
  ctxBarText: $('#ctx-bar-text'),
  usagePill: $('#usage-pill'),
  agentBadge: $('#agent-badge'),
  versionBadge: $('#version-badge'),
  modeChip: $('#mode-chip'),
  modelChip: $('#model-chip'),
  effortChip: $('#effort-chip'),
  composer: $('#composer'),
  grow: $('#grow'),
  prompt: $('#prompt'),
  send: $('#send'),
  jumpLatest: $('#jump-latest'),
  statusLine: $('#status-line'),
  statusText: $('#status-text'),
  statusTimer: $('#status-timer'),
  promptQueue: $('#prompt-queue'),
  promptQueueChip: $('#prompt-queue-chip'),
  promptQueueList: $('#prompt-queue-list'),
  newChat: $('#new-chat'),
  releaseAgent: $('#release-agent'),
  rightbar: $('#rightbar'),
  rightbarToggle: $('#rightbar-toggle'),
  themeToggle: $('#theme-toggle'),
  authGate: $('#auth-gate'),
  authLogin: $('#auth-login'),
  authRetry: $('#auth-retry'),
  authCmd: $('#auth-cmd'),
  // Cross-chat search + find-in-chat (grok-desktop parity).
  sessionSearchInput: $('#session-search-input'),
  sessionSearchHits: $('#session-search-hits'),
  btnSessionFind: $('#btn-session-find'),
  sessionFind: $('#session-find'),
  sessionFindInput: $('#session-find-input'),
  sessionFindCount: $('#session-find-count'),
  sessionFindPrev: $('#session-find-prev'),
  sessionFindNext: $('#session-find-next'),
  sessionFindClose: $('#session-find-close'),
  sessionFindHits: $('#session-find-hits'),
  // File attach (paths handed to agent; images as parts, never in prompt).
  attachBar: $('#attach-bar'),
  btnAttach: $('#btn-attach'),
  attachPop: $('#attach-pop'),
  attachBrowse: $('#attach-browse'),
  attachBrowseFolder: $('#attach-browse-folder'),
  attachPaste: $('#attach-paste'),
  attachAdd: $('#attach-add'),
  attachClose: $('#attach-close'),
};

const state = {
  clientId: crypto.randomUUID(),
  chats: [],
  groups: [],
  activeGroupId: null,
  activeId: null,
  chat: null, // full active chat incl. messages
  /** Active chat's { model, effort, options } config snapshot (BUG-074);
   *  options is null until the live agent advertises its selects. */
  chatConfig: null,
  /** chatId → live turn record. Never a single global "current turn". */
  turnViews: new Map(),
  agent: null,
  authCommand: null,
  pinned: true,
  /** Content painted while unpinned — drives the "↓ ล่าสุด" pill (BUG-047). */
  newContentWhileUnpinned: false,
};

/** chatId → composer draft, mirrored into sessionStorage so typed-but-unsent
 *  text survives a reload (BUG-050). Never a single global draft — drafts
 *  used to leak across chats. */
const drafts = createComposerDraftStore();

/** chatId → FIFO of prompts typed while a turn was running (BUG-051).
 *  In-memory only; dispatched strictly through POST /prompt after settle. */
const promptQueue = createPromptQueue();
/** Chats with a queue dispatch in flight — one POST per chat at a time. */
const queueDispatching = new Set();
/** Chats already focus-warmed — one warm POST per cold period (a release or
 * exit re-arms). The server single-flights anyway; this just saves the HTTP. */
const warmedChats = new Set();

const MODE_CYCLE = ['normal', 'plan', 'always'];
const MODE_LABEL = { normal: 'ask', plan: 'plan', always: 'yolo' };

/** chatId → itemId → server subagent record (wire children, not tool rows). */
const wireSubagents = new Map();
/** chatId → session goal block (or null when cleared). */
const wireGoals = new Map();
/** chatId → { ctx, tokens, baseChars } — usage snaps + estimator anchor. */
const wireCtx = new Map();

/* Realtime CTX estimator (grok-desktop app.js:1440-1472): contextUsage only
 * moves when the (window, used, pressure) triple changes, so between snaps
 * we interpolate from streamed output chars (~3.5 chars/token) and repaint
 * at most once per frame — the pill fills smoothly while generating. */
const CTX_CHARS_PER_TOKEN = 3.5;
let ctxLiveRaf = 0;

function paintCtxPill() {
  const s = state.activeId ? wireCtx.get(state.activeId) : null;
  if (!el.contextPill) return;
  if (!s?.ctx) {
    el.ctxBarText.textContent = 'ctx — / —';
    if (el.ctxBarFill) el.ctxBarFill.style.width = '0%';
    el.contextPill.dataset.level = 'idle';
    el.contextPill.title = 'Context window — ยังไม่มีข้อมูล (รอเทิร์นแรก)';
    el.contextPill.setAttribute('aria-label', 'Context unknown');
    return;
  }
  const m = formatCtxMeter(s.ctx.usedTokens, s.ctx.windowTokens, s.ctx.pressure, s.tokens);
  el.ctxBarText.textContent = `ctx ${m.text}`;
  if (el.ctxBarFill) el.ctxBarFill.style.width = `${m.usedPct ?? 0}%`;
  el.contextPill.dataset.level = m.level;
  el.contextPill.title = m.title;
  el.contextPill.setAttribute('aria-label', `Context ${m.text}`);
}

/** Authoritative snap: store it, anchor the estimator, repaint. */
function snapCtxLive(chatId, ctx, tokens) {
  const prev = wireCtx.get(chatId) || {};
  const tvLen = state.turnViews.get(chatId)?.text.length || 0;
  const merged = {
    ctx: ctx ?? prev.ctx ?? null,
    tokens: tokens ?? prev.tokens ?? null,
    baseChars: tvLen,
  };
  wireCtx.set(chatId, merged);
  if (chatId === state.activeId) paintCtxPill();
  rightbar.applyCtx(chatId, merged.tokens, costModelFor(chatId));
}

/** Live turn id for the rail's identity rows — null when no turn runs
 * (a 'pending' placeholder is not a turn yet). */
function liveTurnIdFor(chatId) {
  const id = state.turnViews.get(chatId)?.turnId;
  return id && id !== 'pending' ? id : null;
}

/** Best-known model id for the cost math: live advertised value first,
 * then the chat's configured model. */
function costModelFor(chatId) {
  if (chatId === state.activeId) {
    return (
      state.chatConfig?.options?.model?.currentValue ??
      state.chat?.model ??
      state.chats.find((c) => c.id === chatId)?.model ??
      null
    );
  }
  return state.chats.find((c) => c.id === chatId)?.model ?? null;
}

/* Subscription usage pill (5h window + weekly): account-level, so one pill
 * for all chats. Painted from GET /api/usage (boot, turn end, 5-min poll)
 * and the global `usage` broadcast. Numbers are point-in-time — the tooltip
 * says "as of", never implies live data (schema US-FR-004). */
let lastUsage = null;
let lastUsageFetch = 0;

function fmtReset(ms) {
  const s = Math.max(0, Math.round((Number(ms) - Date.now()) / 1000));
  if (s < 90) return `อีก ${s} วินาที`;
  if (s < 5400) return `อีก ${Math.round(s / 60)} นาที`;
  if (s < 172800) return `อีก ${(s / 3600).toFixed(s < 36000 ? 1 : 0).replace(/\.0$/, '')} ชม.`;
  return `อีก ${Math.round(s / 86400)} วัน`;
}

function fmtTime(ms) {
  try {
    return new Date(Number(ms)).toLocaleString('th-TH', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function paintUsagePill() {
  const pill = el.usagePill;
  if (!pill) return;
  const u = lastUsage;
  if (!u?.window || !u?.weekly) {
    pill.textContent = '5h — · wk —';
    pill.dataset.level = 'idle';
    pill.title = 'Subscription usage — ยังไม่มีข้อมูล (รอ agent ตัวแรก)';
    pill.setAttribute('aria-label', 'Subscription usage unknown');
    return;
  }
  const w = u.window.usedPercent;
  const k = u.weekly.usedPercent;
  const dur = u.window.windowDurationMins;
  pill.textContent = `${dur % 60 === 0 ? `${dur / 60}h` : `${dur}m`} ${w}% · wk ${k}%`;
  const peak = Math.max(w, k);
  pill.dataset.level = peak > 90 ? 'danger' : peak > 70 ? 'warn' : 'ok';
  const durLabel = dur % 60 === 0 ? `${dur / 60} ชม.` : `${dur} นาที`;
  pill.title =
    `Subscription ${u.tier || ''} (ข้อมูล ณ ${fmtTime(u.observedAtMs)})\n` +
    `หน้าต่าง ${durLabel}ใช้ ${w}% — รีเซ็ต${fmtReset(u.window.resetsAtMs)} (${fmtTime(u.window.resetsAtMs)})\n` +
    `รายสัปดาห์ใช้ ${k}% — รีเซ็ต${fmtReset(u.weekly.resetsAtMs)} (${fmtTime(u.weekly.resetsAtMs)})`;
  pill.setAttribute('aria-label', `Subscription usage 5h ${w} percent, weekly ${k} percent`);
}

async function refreshUsage() {
  const now = Date.now();
  if (now - lastUsageFetch < 30_000) return; // server caches 60s; don't spam
  lastUsageFetch = now;
  const { usage } = await api('/api/usage').catch(() => ({ usage: null }));
  if (usage) {
    lastUsage = usage;
    paintUsagePill();
  }
}

function scheduleCtxLive(chatId) {
  if (ctxLiveRaf || typeof requestAnimationFrame !== 'function') return;
  if (chatId !== state.activeId) return;
  ctxLiveRaf = requestAnimationFrame(() => {
    ctxLiveRaf = 0;
    const s = wireCtx.get(chatId);
    if (!s?.ctx || s.ctx.windowTokens == null) {
      paintCtxPill();
      return;
    }
    const grown = Math.max(0, (state.turnViews.get(chatId)?.text.length || 0) - (s.baseChars || 0));
    const est = s.ctx.usedTokens + grown / CTX_CHARS_PER_TOKEN;
    const m = formatCtxMeter(Math.round(est), s.ctx.windowTokens, s.ctx.pressure, s.tokens);
    el.ctxBarText.textContent = `ctx ${m.text}`;
    if (el.ctxBarFill) el.ctxBarFill.style.width = `${m.usedPct ?? 0}%`;
    el.contextPill.dataset.level = m.level;
    el.contextPill.title = m.title;
  });
}

function wireSubagentCounts(chatId) {
  let running = 0;
  let total = 0;
  for (const rec of wireSubagents.get(chatId)?.values() || []) {
    total += 1;
    if (rec.status === 'inProgress') running += 1;
  }
  return { running, total };
}

// ------------------------------------------------------------------ api

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { ok: false, error: text.slice(0, 300) };
  }
  if (!res.ok && json.ok !== true) {
    const err = new Error(json.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

// ------------------------------------------------------ mcp + subagents

/** Paint the MCP head button from a servers snapshot (dot + up/total). */
function paintMcpButton(snap) {
  const btn = el.mcpBtn;
  if (!btn) return;
  const servers = Array.isArray(snap?.servers) ? snap.servers : [];
  const enabled = servers.filter((s) => s.enabled);
  const up = enabled.filter((s) => s.status === 'connected').length;
  const down = enabled.filter((s) => s.status === 'failed').length;
  const dot = btn.querySelector('.dot');
  if (dot) {
    dot.className = `dot ${!servers.length || snap?.probedAt == null ? 'idle' : down ? 'bad' : up === enabled.length && enabled.length ? 'ok' : 'idle'}`;
  }
  const label = btn.querySelector('.mcp-label');
  if (label) label.textContent = snap?.probedAt != null ? `MCP ${up}/${enabled.length}` : `MCP ${servers.length}`;
  btn.title = snap?.error
    ? snap.error
    : `${up} connected · ${down} failed · ${servers.length - enabled.length} off — คลิกเพื่อดู/เปิด-ปิด`;
}

const mcpPanel = createMcpPanel({ api, onSnapshot: paintMcpButton });
// Right rail (Codex Desktop parity): cost · goal/tasks · subagents · SCB.
// Hidden by default; the ☰ button and the head-bar chips open it. It replaces
// the old floating subagents/tasks popovers — one rail, no stacked popups.
const rightbar = createRightbar({ api, aside: el.rightbar, toggleBtn: el.rightbarToggle });
// Inline child activity inside transcript agent rows (nested delegate view).
const childActivity = createChildActivity({ api, onOpenRail: () => rightbar.reveal('agents') });

// ------------------------------------------------------------ turn view

function turnView(chatId, create = false) {
  let tv = state.turnViews.get(chatId);
  if (!tv && create) {
    tv = createTurnView();
    state.turnViews.set(chatId, tv);
  }
  return tv || null;
}

function isRunning(chatId) {
  const tv = state.turnViews.get(chatId);
  return !!tv?.turnId;
}

// ------------------------------------------------------------- sidebar

const sidebar = new Sidebar({
  mount: el.sidebarNav,
  actions: {
    selectChat: (id) => void selectChat(id),
    selectGroup: (id) => void selectGroup(id),
    createChat: (groupId) => void newChat({ groupId }),
    deleteChat: (id) => void deleteChat(id),
    createGroup: (name, position) => void createGroup(name, position),
    renameGroup: (id, name) => void renameGroup(id, name),
    deleteGroup: (id) => void deleteGroup(id),
    reorderGroups: (order) => void reorderGroups(order),
    moveChat: (chatId, groupId) => void moveChat(chatId, groupId),
    copyChatMarkdown: (chatId) => void copyChatMarkdown(chatId),
  },
});

function renderSidebar() {
  sidebar.render({
    groups: state.groups,
    // The server's `running` flag can lag a beat behind the SSE event that
    // opened the turn; the local turn view is the fresher of the two.
    chats: state.chats.map((c) => ({ ...c, running: c.running || isRunning(c.id) })),
    activeChatId: state.activeId,
    activeGroupId: state.activeGroupId,
  });
}

// ----------------------------------------------------------- transcript

// grok-desktop's LIVE_MD_MIN_MS — the streaming answer re-parses its markdown
// at most this often; the DOM text node itself stays live per delta.
const LIVE_MD_MIN_MS = 32;

function nearBottom() {
  const t = el.transcript;
  return t.scrollHeight - t.scrollTop - t.clientHeight < 120;
}

function showJumpLatest() {
  el.jumpLatest.hidden = false;
}

function hideJumpLatest() {
  el.jumpLatest.hidden = true;
}

// One scroll per frame (grok-desktop app.js:1965-1974, "1 scroll/frame"):
// message_delta arrives per SSE chunk and each one used to assign scrollTop
// directly — coalesce through a single rAF. The callback runs before the next
// paint, so callers that just rebuilt the DOM see no top-then-bottom flash.
//
// While unpinned this NEVER force-scrolls (BUG-045); it raises the jump pill
// instead (BUG-047; grok-desktop scrollChatToBottom, app.js:1938-1975).
let scrollRaf = 0;
function scrollToBottom(force = false) {
  if (force) {
    state.pinned = true;
    state.newContentWhileUnpinned = false;
  }
  const decision = computePin({
    pinned: state.pinned,
    nearBottom: force ? true : nearBottom(),
    userScrolled: false,
    // Every non-forced caller reaches here because something just painted.
    newContent: true,
  });
  state.pinned = decision.pinned;
  if (!decision.shouldScroll) {
    state.newContentWhileUnpinned = true;
    showJumpLatest();
    return;
  }
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    // Direct assignment — cheaper than scrollTo() during high-rate streams.
    el.transcript.scrollTop = el.transcript.scrollHeight;
    state.newContentWhileUnpinned = false;
    hideJumpLatest();
  });
}

/** Drop a scheduled scroll (a keepScroll restore is about to set scrollTop). */
function cancelPendingScroll() {
  if (!scrollRaf) return;
  cancelAnimationFrame(scrollRaf);
  scrollRaf = 0;
}

function interruptedMarkerNode(reason) {
  const div = document.createElement('div');
  div.className = 'turn-interrupted-marker';
  div.textContent = interruptedMarkerText(reason);
  return div;
}

/**
 * @param {object} msg
 * @param {number|null} [index] absolute message index — stamped as
 * data-msg-index so search deep-links can flash the exact bubble.
 */
function messageNode(msg, index = null) {
  const stamp = (node) => {
    if (index != null) node.dataset.msgIndex = String(index);
    return node;
  };
  if (msg.role === 'user') {
    const div = document.createElement('div');
    div.className = 'msg-user';
    if (msg.text) {
      const span = document.createElement('span');
      span.className = 'msg-user-text';
      span.textContent = msg.text;
      div.append(span);
    }
    // Attachments live in meta, never in the text — paint them as chips.
    const chips = attachChipsNode(msg.meta?.attachments);
    if (chips) div.append(chips);
    return stamp(div);
  }
  if (msg.role === 'notice') {
    const div = document.createElement('div');
    div.className = 'msg-notice';
    div.textContent = msg.text;
    return stamp(div);
  }
  const wrap = stamp(document.createElement('div'));
  // Class hook for the result-stack dividers (same blocks as the live
  // paint's direct children). Class-only — order untouched (BUG-031).
  wrap.classList.add('msg-assistant-turn');
  // Same order as the live paint (liveChildOrder) — a reload that reshuffles
  // tools/plan/answer reads as a visible jump right after turn_done (BUG-031).
  // Tools + plan ride inside one collapsed progress group; the answer stays
  // the visible content.
  const histTools = msg.meta?.toolCalls || [];
  const histPlan = msg.meta?.plan || [];
  const histPlanDone = histPlan.filter((e) => String(e?.status || '') === 'completed').length;
  let histPg = null;
  const ensureHistPg = () => {
    if (histPg) return histPg;
    // Settled turns keep the same header shape as live ones — ChatGPT
    // Desktop's `Worked for 36s · …`; pre-1.1.26 transcripts without a
    // persisted duration fall back to counts only.
    const histAgents = histTools.filter((t) => agentToolMeta(subKindOf(t))).length;
    const pg = progressGroupNode(
      turnHeaderLabel({
        running: false,
        durationMs: msg.meta?.durationMs ?? null,
        tools: histTools.length,
        planSteps: histPlan.length,
        planDone: histPlanDone,
        agentsTotal: histAgents,
      }),
      false,
      () => {
        const collapsed = !pg.group.classList.contains('pg-collapsed');
        pg.group.classList.toggle('pg-collapsed', collapsed);
        pg.glyphEl.textContent = collapsed ? '▸' : '▾';
      },
    );
    histPg = pg;
    wrap.append(pg.group);
    return pg;
  };
  for (const key of messageChildOrder(msg)) {
    if (key === 'tools') {
      const pg = ensureHistPg();
      for (const tool of histTools) pg.body.append(toolNode(tool));
    } else if (key === 'plan') {
      ensureHistPg().body.append(planNode(histPlan));
    } else if (key === 'text') {
      const div = document.createElement('div');
      div.className = 'msg-assistant';
      div.innerHTML = renderMarkdown(msg.text);
      wrap.append(div);
      // Diagrams paint after attach (paintMarkdownDiagrams waits for it).
      void paintMarkdownDiagrams(div, msg.text);
    } else if (key === 'marker') {
      // The interruption marker is rendered from persisted meta, so it
      // survives the transcript reload that follows the live paint.
      wrap.append(interruptedMarkerNode(msg.meta.reason));
    }
  }
  return wrap;
}

/** One place owns the collapsed class + glyph so they can never disagree. */
function setToolRowCollapsed(row, collapsed) {
  row.classList.toggle('collapsed', collapsed);
  const glyph = row.querySelector('.tool-head .glyph');
  if (glyph) glyph.textContent = collapsed ? '▸' : '▾';
}

function toolNode(tool, existing = null, onUserToggle = null) {
  const row = existing || document.createElement('div');
  // Agent facts can arrive LATE (rawInput is null on an early lazy-created
  // call, filled by the update) — the class + subtitle are re-resolved on
  // every paint, not only at creation (BUG-076).
  const agent = agentToolMeta(tool);
  if (!existing) {
    row.className = 'tool-row collapsed';
    row.dataset.toolId = tool.id;
    // The head is a div, not a button: it holds TWO buttons (toggle +
    // explain) and a <button> inside a <button> silently breaks clicks in
    // WKWebView — the same trap the sidebar row comment warns about.
    const head = document.createElement('div');
    head.className = 'tool-head';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tool-toggle';
    toggle.innerHTML = '<span class="glyph">▸</span><span class="name"></span><span class="sub"></span><span class="status"></span>';
    toggle.title = 'แสดง/ซ่อน console ของ tool นี้';
    const flip = () => {
      const collapsed = !row.classList.contains('collapsed');
      setToolRowCollapsed(row, collapsed);
      // A manual toggle mutes auto-expand for this row for the rest of the
      // turn (BUG-033) — history rows pass no callback and stay exactly as
      // the user left them. The live turn also records expands so a
      // re-paint re-opens rows the user explicitly opened.
      onUserToggle?.(tool.id, !collapsed);
      if (!collapsed) {
        const act = row.querySelector(':scope > .child-activity');
        if (act) childActivity.ensureLoaded(act);
      }
    };
    toggle.addEventListener('click', flip);
    // "explain" reveals this console only — progress hides by default and
    // this is the per-row way back in (group-level toggle lives on the
    // progress group header).
    const explain = document.createElement('button');
    explain.type = 'button';
    explain.className = 'tool-explain';
    explain.textContent = 'explain';
    explain.title = 'แสดง console ของ tool นี้';
    explain.addEventListener('click', flip);
    head.append(toggle, explain);
    const body = document.createElement('div');
    body.className = 'tool-body';
    row.append(head, body);
    // Agent rows that name a durable child grow an inline activity block
    // above the console. It loads on first expand — this only reserves
    // the slot, so mounting is free while collapsed.
    if (agent && tool.agentLink) {
      const act = childActivity.mountRow(state.activeId, tool);
      if (act) row.insertBefore(act, body);
    }
  }
  row.classList.toggle('agent', !!agent);
  row.dataset.status = tool.status || 'pending';
  // The row names the TOPIC, not the raw command (toolTopic strips the old
  // `Bash ls …` prefix; stored transcripts still carry it). The tool kind
  // moves to the quiet subtitle so "which tool ran" stays answerable, and
  // the full original title survives as a hover tooltip for debugging.
  const topic = toolTopic(tool) || tool.kind || 'tool';
  row.querySelector('.name').textContent = topic;
  const sub = agent ? agentSubtitle(tool) : (tool.kind && tool.kind !== topic ? tool.kind : '');
  row.querySelector('.sub').textContent = sub;
  const full = String(tool.title || '').replace(/\s+/g, ' ').trim();
  row.querySelector('.tool-toggle').title =
    full && full !== topic ? `แสดง/ซ่อน console ของ tool นี้ — ${full}` : 'แสดง/ซ่อน console ของ tool นี้';
  // Thai label, not the raw wire string (BUG-027); the row's left strip
  // blinks off data-status in CSS. A completed BACKGROUND agent keeps running behind
  // the scenes — say so instead of "เสร็จแล้ว" (BUG-076; display only, the
  // wire status is untouched).
  row.querySelector('.status').textContent =
    agent && toolDisplayState(tool) === 'background'
      ? 'ทำงานเบื้องหลัง'
      : toolStatusLabel(tool.status);
  const body = row.querySelector('.tool-body');
  const out = tool.output || '';
  if (body.textContent !== out) body.textContent = out;
  // The link can land after the row (a spawn row gains its id when the
  // output arrives) — mount the slot then. A mounted block is never
  // touched here: repaints must not wipe a loaded activity view.
  if (existing && agent && tool.agentLink && !row.querySelector(':scope > .child-activity')) {
    const act = childActivity.mountRow(state.activeId, tool);
    if (act) row.insertBefore(act, body);
  }
  return row;
}

function planNode(entries) {
  const card = document.createElement('div');
  card.className = 'plan-card';
  const h = document.createElement('h3');
  h.textContent = 'plan';
  const ol = document.createElement('ol');
  for (const entry of entries) {
    const li = document.createElement('li');
    li.className = String(entry.status || '');
    li.textContent = entry.content || entry.title || '';
    ol.append(li);
  }
  card.append(h, ol);
  return card;
}

/**
 * Collapsible wrapper around a turn's tools + plan (Codex Desktop parity).
 * Hidden by default — the answer is the content; progress is one click away
 * at group level, or per-console via the row's "explain" button. The live
 * turn drives `open` from tv.progressOpen; history rows own DOM-local state.
 */
function progressGroupNode(label, open, onToggle) {
  const group = document.createElement('div');
  group.className = 'progress-group' + (open ? '' : ' pg-collapsed');
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'progress-head';
  head.title = 'แสดง/ซ่อนความคืบหน้าทั้งหมดของเทิร์นนี้';
  const glyph = document.createElement('span');
  glyph.className = 'glyph';
  glyph.textContent = open ? '▾' : '▸';
  const text = document.createElement('span');
  text.className = 'progress-label';
  text.textContent = label;
  // The wheel lives here and only here: visible while .pg-running (BUG-027).
  const wheel = document.createElement('span');
  wheel.className = 'progress-spin';
  wheel.setAttribute('aria-hidden', 'true');
  head.append(glyph, text, wheel);
  head.addEventListener('click', () => onToggle?.());
  const body = document.createElement('div');
  body.className = 'progress-body';
  group.append(head, body);
  return { group, body, glyphEl: glyph, labelEl: text };
}

/** Header line for a tool+plan bundle: `<topic> · 3 tools · plan 2/4`.
 * The topic names the live work (plan step, else running tool); settled
 * history passes none and keeps the generic `Progress Bar` head. */
function progressLabel(toolsCount, running, planSteps, planDone, topic) {
  const bits = [topic || 'Progress Bar'];
  if (toolsCount) bits.push(`${toolsCount} tools${running ? ` · ${running} กำลังรัน` : ''}`);
  if (planSteps) bits.push(`plan ${planDone}/${planSteps}`);
  return bits.join(' · ');
}

/**
 * Live turn header — ChatGPT Desktop's `Working for 24s · …`: a ticking
 * clock plus topic/counts. The 500 ms running tick repaints through this so
 * the header counts up without a structural repaint.
 */
function liveTurnHeaderLabel(tv, sum = progressSummary(tv), agents = agentCounts(tv)) {
  return turnHeaderLabel({
    running: true,
    elapsedMs: Date.now() - (tv.startedAt || Date.now()),
    topic: progressTopic(tv),
    tools: sum.tools,
    runningTools: sum.running,
    planSteps: sum.planSteps,
    planDone: sum.planDone,
    agentsRunning: agents.running,
    agentsTotal: agents.total,
  });
}

// Fallback for pre-options agents (grok-shaped hosts with no option list).
// Shared with the keyboard map so a card and its shortcuts never disagree.
const DEFAULT_IX_OPTIONS = [
  { optionId: 'allow-once', name: 'อนุญาตครั้งนี้' },
  { optionId: 'allow-always', name: 'อนุญาตตลอด' },
  { optionId: 'reject-once', name: 'ปฏิเสธ' },
];

function interactionNode(ix) {
  const card = document.createElement('div');
  card.className = 'ix-card';
  card.dataset.ixId = ix.id;
  if (ix.subtype) card.dataset.ixSubtype = ix.subtype;

  const title = document.createElement('div');
  title.className = 'ix-title';
  // AskUserQuestion / ExitPlanMode tunnel through the permission channel with
  // their content as the payload (BUG-026) — a bare "ขออนุญาตใช้ …" title
  // would hide the question/plan the user is actually answering.
  title.textContent =
    ix.subtype === 'ask'
      ? 'agent มีคำถาม'
      : ix.subtype === 'plan'
        ? 'แผนพร้อมแล้ว — อนุมัติได้ไหม?'
        : `ขออนุญาตใช้ ${ix.toolName || 'tool'}`;
  card.append(title);

  if (ix.body) {
    // The body is markdown (a plan; sometimes a formatted question) — render
    // it like the assistant stream, not as a monospace summary chip.
    const body = document.createElement('div');
    body.className = 'ix-body msg-assistant';
    body.innerHTML = renderMarkdown(ix.body);
    card.append(body);
    void paintMarkdownDiagrams(body, ix.body);
  } else if (ix.summary) {
    const sum = document.createElement('div');
    sum.className = 'ix-summary';
    sum.textContent = ix.summary;
    card.append(sum);
  }

  const actions = document.createElement('div');
  actions.className = 'ix-actions';
  const options = ix.options?.length ? ix.options : DEFAULT_IX_OPTIONS;
  // A failed submit (stale id → 404, network down) must hand the card back:
  // buttons re-enabled plus an inline error — a dead card leaves the agent
  // blocked on its permission reply forever (grok-desktop app.js:8769-8776).
  const errLine = document.createElement('div');
  errLine.className = 'ix-card-error';
  errLine.setAttribute('role', 'alert');
  errLine.hidden = true;
  let submitState = { submitting: false, error: null };
  const paintSubmit = () => {
    for (const b of actions.querySelectorAll('button')) b.disabled = submitState.submitting;
    errLine.hidden = !submitState.error;
    errLine.textContent = submitState.error || '';
  };
  // One primary per card (BUG-028): with canonical options both "once" and
  // "for this session" used to render primary; with AskUserQuestion all N
  // answers did.
  const primaryId = ixPrimaryOptionId(options);
  for (const opt of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = opt.optionId === primaryId ? 'btn primary' : 'btn';
    btn.dataset.optionId = opt.optionId; // the keyboard map (BUG-030) finds buttons by this
    btn.textContent = opt.name || opt.optionId;
    btn.addEventListener('click', async () => {
      if (submitState.submitting) return; // a double-click must not double-post
      submitState = ixSubmitTransition(submitState, 'start');
      paintSubmit();
      try {
        await api(`/api/interactions/${encodeURIComponent(ix.id)}`, {
          method: 'POST',
          body: { optionId: opt.optionId },
        });
        // Success paints via the interaction_resolved SSE event, which greys
        // the card out — nothing to do locally (202-and-SSE-only rule).
        submitState = ixSubmitTransition(submitState, 'ok');
      } catch {
        submitState = ixSubmitTransition(submitState, 'fail');
        paintSubmit();
      }
    });
    actions.append(btn);
  }
  card.append(actions, errLine);
  return card;
}

// The transcript mounts only the trailing window of a long chat (BUG-052) —
// a full re-render re-parsed markdown for the entire history on every chat
// switch AND every turn settle. `null` = the default window; a number = a
// user-expanded start index. selectChat resets it on a chat switch; a
// same-chat re-render (settle) keeps the expansion.
let historyStartIndex = null;

function historyWindowStart(messages) {
  if (historyStartIndex != null) {
    return Math.max(0, Math.min(historyStartIndex, messages.length));
  }
  return computeHistoryStartIndex(messages, adaptiveHistoryDefaults()).startIndex;
}

/**
 * Expand the window upward without any fetch — every message is already in
 * memory (grok-desktop loadOlderHistory, app.js:4509-4539). The scroll anchor
 * is the DISTANCE FROM BOTTOM so the messages on screen stay put.
 */
function loadOlderHistory() {
  const chat = state.chat;
  if (!chat) return;
  const cur = historyWindowStart(chat.messages);
  if (cur <= 0) return;
  const next = expandHistoryStartIndex(
    chat.messages,
    cur,
    adaptiveHistoryDefaults().expandTurns,
  );
  historyStartIndex = next >= cur ? 0 : next;
  const t = el.transcript;
  const distBottom = t.scrollHeight - t.scrollTop - t.clientHeight;
  renderTranscript({ stick: false });
  t.scrollTop = Math.max(0, t.scrollHeight - t.clientHeight - distBottom);
}

/** "โหลดข้อความเก่ากว่า · N ข้อความ" above the mounted window
 *  (grok-desktop mountHistoryLoadOlder, app.js:4483-4504). */
function loadOlderNode(hiddenCount) {
  const wrap = document.createElement('div');
  wrap.className = 'history-load-older';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = `โหลดข้อความเก่ากว่า · ${hiddenCount} ข้อความ`;
  btn.addEventListener('click', () => loadOlderHistory());
  wrap.append(btn);
  return wrap;
}

/** Full repaint — used on chat switch and after a turn settles. */
function renderTranscript({ stick = true } = {}) {
  const chat = state.chat;
  el.transcript.replaceChildren();
  if (!chat) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = '<span class="big">◗</span>เลือกแชทด้านซ้าย หรือกด ＋ เพื่อเริ่มใหม่';
    el.transcript.append(empty);
    return;
  }
  if (!chat.messages.length && !isRunning(chat.id)) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = '<span class="big">◗</span>พิมพ์คำถามด้านล่างเพื่อเริ่มคุยกับ Muse';
    el.transcript.append(empty);
  }

  const turn = document.createElement('div');
  turn.className = 'turn';
  // Mount only the trailing window; the load-older row advertises how many
  // messages are hidden above it.
  const start = historyWindowStart(chat.messages);
  if (start > 0) el.transcript.append(loadOlderNode(start));
  const { slice, absoluteOffset } = sliceHistoryMessages(chat.messages, start);
  slice.forEach((msg, i) => {
    turn.append(messageNode(msg, absoluteOffset + i));
  });
  el.transcript.append(turn);

  paintLiveTurn(true);
  // stick=false is the keepScroll path: selectChat restores the scroll
  // position right after — a force-scroll here would win the race only by
  // luck once scrolling is rAF-coalesced (BUG-046).
  if (stick) scrollToBottom(true);
}

/** Incremental paint of the in-flight turn only — O(delta), not O(transcript). */
let liveWrap = null;
let liveText = null;
// key → element for the CURRENT liveWrap ('tool:<id>' | 'plan' | 'text' |
// 'ix:<id>'). Re-appending in liveChildOrder() every paint keeps the
// streaming answer bottommost no matter when a tool row or card arrives.
// Tool + plan nodes live inside the progress group's body; text + cards stay
// direct children of the wrap.
let liveChildren = new Map();
let liveProgress = null;
// chatId:turnId:rev of the last STRUCTURAL paint — pure text deltas reuse
// the rows/cards/order and only reschedule markdown + scroll.
let lastLiveStamp = null;

function paintLiveTurn(rebuild = false) {
  const chatId = state.activeId;
  const tv = chatId ? state.turnViews.get(chatId) : null;

  if (!tv || !tv.turnId) {
    liveWrap?.remove();
    liveWrap = null;
    liveText = null;
    liveChildren = new Map();
    liveProgress = null;
    lastLiveStamp = null;
    return;
  }

  const remade = rebuild || !liveWrap || !liveWrap.isConnected;
  if (remade) {
    liveWrap = document.createElement('div');
    liveWrap.className = 'turn live-turn';
    liveText = null;
    liveChildren = new Map();
    liveProgress = null;
    el.transcript.append(liveWrap);
  }

  const stamp = `${chatId}:${tv.turnId}:${tv.rev || 0}`;
  // The answer bubble itself needs mounting when text arrives after the last
  // structural paint (or its node was dropped) — that also needs the order
  // logic, so it forces the full path.
  const needsTextMount = !!tv.text && (!liveText || !liveText.isConnected || !liveChildren.has('text'));
  const structural = remade || needsTextMount || stamp !== lastLiveStamp;

  if (!structural) {
    // Text-only delta: rows, cards and order are exactly as painted — only
    // the answer text grew. Skip the whole DOM-diff section.
    if (tv.text) liveMd.schedule();
    scrollToBottom();
    return;
  }

  // Upsert content into the child map; the re-append below pins the order.
  for (const tool of tv.tools.values()) {
    const key = `tool:${tool.id}`;
    const node = toolNode(tool, liveChildren.get(key), (toolId, expanded) => {
      // The click lands on the visible (active) chat's rows.
      const cur = state.turnViews.get(state.activeId);
      cur?.userToggledTools?.add(toolId);
      if (expanded) cur?.userExpandedTools?.add(toolId);
      else cur?.userExpandedTools?.delete(toolId);
    });
    // Progress hides by default — a row opens only when the user explicitly
    // opened it (head click or "explain"); streaming never pops rows open.
    // A fresh row is born collapsed, so only the explicit-open path unhides.
    if (shouldAutoExpandTool(tv, tool)) {
      setToolRowCollapsed(node, false);
      const act = node.querySelector(':scope > .child-activity');
      if (act) childActivity.ensureLoaded(act);
    }
    liveChildren.set(key, node);
  }

  if (tv.plan) {
    // Plan entries flip status mid-turn; the card is small, so rebuild it.
    liveChildren.get('plan')?.remove();
    liveChildren.set('plan', planNode(tv.plan));
  }

  if (tv.text) {
    if (!liveText || !liveText.isConnected) {
      liveText = document.createElement('div');
      liveText.className = 'msg-assistant';
    }
    liveChildren.set('text', liveText);
    // Rebuilds (chat switch, hydration) paint at once; the per-delta path is
    // throttled — a full re-parse per SSE chunk was CPU churn and flicker.
    if (remade) liveMd.flush();
    else liveMd.schedule();
  }

  for (const ix of tv.interactions.values()) {
    const key = `ix:${ix.id}`;
    const existing = liveChildren.get(key);
    if (ix.resolved) {
      existing?.classList.add('resolved');
      existing?.querySelectorAll('button').forEach((b) => (b.disabled = true));
      // Mark the picked option (BUG-032): the card stays (muse keeps resolved
      // cards, grok dismounts), so the choice must remain readable on it.
      const chosen = ix.optionId
        ? existing?.querySelector(`.ix-actions button[data-option-id="${CSS.escape(ix.optionId)}"]`)
        : null;
      if (chosen && !chosen.classList.contains('chosen')) {
        chosen.classList.add('chosen');
        chosen.textContent = `${chosen.textContent} ✓ เลือกแล้ว`;
      }
      continue;
    }
    if (!existing) liveChildren.set(key, interactionNode(ix));
  }

  // The progress group owns the tool + plan nodes; its header carries the
  // live ChatGPT-style `กำลังทำ Xs · …` clock plus counts, and flips
  // tv.progressOpen (rev bump → next paint is structural). The open turn
  // ALWAYS shows the header — even before the first tool lands — so the
  // task row stays visible like Codex Desktop's working block.
  const sum = progressSummary(tv);
  const agents = agentCounts(tv);
  const hasProgress = true;
  if (!liveProgress || !liveProgress.group.isConnected) {
    const chatOfPaint = chatId;
    liveProgress = progressGroupNode('', !!tv.progressOpen, () => {
      const cur = state.turnViews.get(chatOfPaint);
      if (!cur) return;
      toggleProgressOpen(cur);
      if (chatOfPaint === state.activeId) paintLiveTurn();
    });
  }
  liveProgress.labelEl.textContent = liveTurnHeaderLabel(tv, sum, agents);
  liveProgress.group.classList.toggle('pg-collapsed', !tv.progressOpen);
  liveProgress.glyphEl.textContent = tv.progressOpen ? '▾' : '▸';
  liveProgress.group.classList.toggle('pg-running', sum.running > 0);

  // Pin the order — a tool call that starts after some answer text must still
  // render ABOVE the streaming bubble, not below it. append() moves connected
  // nodes, so re-appending in order is free when the order is already right.
  // Tools + plan ride inside the progress body; the answer and every
  // interaction card stay direct children of the wrap — a card anchored
  // inside a collapsed group would hide the very question that blocks the
  // turn (the old BUG-029 after-the-row mount cannot survive hide-defaults).
  const order = liveChildOrder(tv);
  if (liveProgress && hasProgress) liveWrap.append(liveProgress.group);
  for (const key of order) {
    const node = liveChildren.get(key);
    if (!node) continue;
    if ((key.startsWith('tool:') || key === 'plan') && liveProgress && hasProgress) {
      liveProgress.body.append(node);
      continue;
    }
    liveWrap.append(node);
  }
  // Prune rows whose content vanished (e.g. a cleared plan).
  for (const [key, node] of liveChildren) {
    if (!order.includes(key)) {
      node.remove();
      liveChildren.delete(key);
    }
  }
  lastLiveStamp = stamp;

  scrollToBottom();
}

/**
 * The markdown paint behind the throttle: full re-parse + DOM rewrite of the
 * streaming bubble. Cheap enough at ≤1/32ms, ruinous per delta token.
 */
function paintLiveMarkdownNow() {
  const tv = state.activeId ? state.turnViews.get(state.activeId) : null;
  if (!liveText || !liveText.isConnected || !tv) return;
  liveText.innerHTML = renderMarkdown(tv.text, { live: true });
  void paintMarkdownDiagrams(liveText, tv.text, { live: true });
  scrollToBottom();
}

const liveMd = createLivePaintScheduler(paintLiveMarkdownNow, { minMs: LIVE_MD_MIN_MS });

// ------------------------------------------------------------ chrome UI

let timerHandle = null;
function updateRunningChrome() {
  const running = isRunning(state.activeId);
  const tv = running ? state.turnViews.get(state.activeId) : null;
  // A requested-but-not-yet-settled cancel morphs the stop button into a
  // disabled "cancelling" state (grok-desktop cancelInFlight,
  // turn-view.js:335-341 + composerMorph 1052-1063).
  const cancelling = !!tv?.cancelling;
  el.send.classList.toggle('stopping', running);
  el.send.textContent = running ? (cancelling ? '…' : '■') : '↑';
  el.send.disabled = cancelling;
  el.send.title = running ? (cancelling ? 'กำลังหยุด…' : 'Stop (Esc)') : 'Send (⏎)';
  el.statusLine.hidden = !running;

  if (running) {
    el.statusText.textContent = resolveStatusVerb(tv);
    const tick = () => {
      const t = state.turnViews.get(state.activeId);
      if (!t?.startedAt) return;
      const secs = Math.round((Date.now() - t.startedAt) / 1000);
      el.statusTimer.textContent = `${secs}s · Esc เพื่อหยุด`;
      // The live turn header counts up on the same tick — ChatGPT Desktop's
      // `Working for …` clock, repainted without a structural pass.
      if (t.turnId && liveProgress?.labelEl?.isConnected) {
        liveProgress.labelEl.textContent = liveTurnHeaderLabel(t);
      }
    };
    tick(); // no reason the hint waits a half second for the first interval
    if (!timerHandle) {
      timerHandle = setInterval(tick, 500);
    }
  } else if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
    el.statusTimer.textContent = '';
  }
  updateRunningSidebar();
  updateAgentsChip(); // the chip rides the same funnel — no new SSE (BUG-077)
  updateTasksGoalChips();
  paintCtxPill();
}

/**
 * Tasks chip in the head bar (`tasks done/total` from the active chat's live
 * plan) + goal chip in the bottom-right live cluster (the session goal's
 * percent + objective, realtime like the CLI). Both hide when there is
 * nothing to show; both open the shared panel on click.
 */
function updateTasksGoalChips() {
  const tv = state.activeId ? state.turnViews.get(state.activeId) : null;
  const entries = Array.isArray(tv?.plan) ? tv.plan : [];
  const done = entries.filter((t) => String(t?.status) === 'completed').length;
  el.tasksChip.hidden = entries.length === 0;
  if (entries.length) {
    el.tasksChip.textContent = `tasks ${done}/${entries.length}`;
    const running = entries.some((t) => String(t?.status) === 'in_progress');
    el.tasksChip.classList.toggle('busy', running);
    el.tasksChip.title = `tasks เสร็จ ${done} จาก ${entries.length} — คลิกเพื่อดูรายการ`;
  }
  const goal = state.activeId ? wireGoals.get(state.activeId) : null;
  el.goalChip.hidden = !goal;
  if (goal) {
    const pct = Math.min(100, Math.max(0, Math.round(Number(goal.percentComplete) || 0)));
    const label = el.goalChip.querySelector('.goal-label');
    const pctEl = el.goalChip.querySelector('.goal-pct');
    if (pctEl) pctEl.textContent = `${pct}%`;
    if (label) label.textContent = String(goal.objective || '');
    el.goalChip.classList.toggle('busy', goalControlFor(goal.status) === 'pause');
    el.goalChip.title = `${goal.objective || ''} — ${pct}% ${goal.status || ''} — คลิกเพื่อดูรายละเอียด`;
  }
  updateGoalBar(goal);
  updateLiveCluster();
}

/**
 * Thread goal strip above the composer — ChatGPT Desktop's goal bar: the
 * CLI-owned session goal for this chat (objective, percent, status word,
 * pause/resume). Hidden when the chat has no goal; the goal itself is set
 * in the CLI, the desktop only mirrors + pauses/resumes it.
 */
function updateGoalBar(goal) {
  if (!el.goalBar) return;
  el.goalBar.hidden = !goal;
  if (!goal) return;
  const pct = Math.min(100, Math.max(0, Math.round(Number(goal.percentComplete) || 0)));
  if (el.goalObjective) el.goalObjective.textContent = String(goal.objective || 'goal');
  if (el.goalMeta) el.goalMeta.textContent = `${pct}% · ${goalStatusWord(goal.status)}`;
  if (el.goalBarBtn) {
    const control = goalControlFor(goal.status);
    el.goalBarBtn.hidden = !control;
    if (control) {
      el.goalBarBtn.textContent = control === 'pause' ? '⏸ หยุดชั่วคราว' : '▶ ทำต่อ';
      el.goalBarBtn.title = control === 'pause' ? 'หยุด goal ชั่วคราว' : 'ทำ goal ต่อ';
      el.goalBarBtn.dataset.action = control;
    }
  }
}

async function sendGoalBarCommand() {
  const chatId = state.activeId;
  const action = el.goalBarBtn?.dataset.action;
  if (!chatId || !action) return;
  if (el.goalBarBtn) el.goalBarBtn.disabled = true;
  try {
    await api(`/api/chats/${encodeURIComponent(chatId)}/goal`, { method: 'POST', body: { action } });
  } catch (err) {
    if (el.goalBarBtn) {
      el.goalBarBtn.disabled = false;
      el.goalBarBtn.title = `สั่งไม่ได้: ${err?.message || err}`;
    }
  }
}

/**
 * Thread overview popup — ChatGPT Desktop's header toggle (Outputs /
 * Subagents / Sources): one glance at this chat's live turn with a row per
 * subagent, task, and the session goal. Rows drill into the right rail;
 * empty sections collapse to a quiet hint instead of a bare list.
 */
function openThreadOverview() {
  const tv = state.activeId ? state.turnViews.get(state.activeId) : null;
  const goal = state.activeId ? wireGoals.get(state.activeId) : null;
  const root = document.createElement('div');
  root.className = 'panel thread-overview';
  const mkSection = (title) => {
    const h = document.createElement('h2');
    h.textContent = title;
    root.append(h);
    const ul = document.createElement('ul');
    root.append(ul);
    return ul;
  };
  const mkRow = (icon, label, trailing, title, onPick) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ov-row';
    const avatar = document.createElement('span');
    avatar.className = 'ov-avatar';
    avatar.textContent = icon;
    avatar.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'ov-label';
    name.textContent = label;
    btn.append(avatar, name);
    if (trailing) {
      const trail = document.createElement('span');
      trail.className = 'ov-trailing';
      trail.textContent = trailing;
      btn.append(trail);
    }
    if (title) btn.title = title;
    btn.addEventListener('click', () => { closePopover(); onPick(); });
    li.append(btn);
    return li;
  };
  const mkEmpty = (text) => {
    const li = document.createElement('li');
    li.className = 'ov-empty';
    li.textContent = text;
    return li;
  };
  // Subagents — agent rows of the live turn, newest last like the rail.
  const agentsUl = mkSection('Subagents');
  const agentTools = tv ? [...tv.tools.values()].map((n) => n.tool).filter((t) => agentToolMeta(subKindOf(t))) : [];
  if (!agentTools.length) agentsUl.append(mkEmpty('ยังไม่มี subagent ในเทิร์นนี้'));
  for (const tool of agentTools) {
    const meta = agentToolMeta(subKindOf(tool));
    const label = agentSubtitle(tool, meta) || meta.label;
    const status = toolDisplayState(tool).status;
    const word = status === 'running' ? 'กำลังรัน' : status === 'error' ? 'ล้มเหลว' : 'เสร็จ';
    agentsUl.append(mkRow(meta.icon || '✳', label, word, `${label} — ${word}`, () => rightbar.reveal('agents')));
  }
  // Tasks — live plan checklist.
  const tasksUl = mkSection('Tasks');
  const entries = Array.isArray(tv?.plan) ? tv.plan : [];
  if (!entries.length) tasksUl.append(mkEmpty('ยังไม่มี tasks ในเทิร์นนี้'));
  for (const t of entries) {
    const done = String(t?.status) === 'completed';
    const active = String(t?.status) === 'in_progress';
    tasksUl.append(mkRow(done ? '☑' : '☐', String(t?.content || '(ไม่มีชื่อ task)'), active ? 'กำลังทำ' : '', '', () => rightbar.reveal('tasks')));
  }
  // Goal — the CLI-owned session goal.
  const goalUl = mkSection('Goal');
  if (!goal) goalUl.append(mkEmpty('แชทนี้ยังไม่มี goal (ตั้งใน CLI)'));
  else {
    const pct = Math.min(100, Math.max(0, Math.round(Number(goal.percentComplete) || 0)));
    goalUl.append(mkRow('◎', String(goal.objective || 'goal'), `${pct}% · ${goalStatusWord(goal.status)}`, '', () => rightbar.reveal('goal')));
  }
  openPanel(el.overviewBtn, root);
}

/** The live cluster collapses when both of its chips hide — no stray gap. */
function updateLiveCluster() {
  el.liveCluster.hidden = el.goalChip.hidden && el.agentsChip.hidden;
}

/**
 * Agents chip in the bottom-right live cluster (BUG-077; grok-desktop
 * setAgentsPill, app.js:1383-1411): `agents running/total` of the ACTIVE
 * chat's turn view, accent + pulsing while anything runs, hidden when the
 * turn has no agent rows. Driven from updateRunningChrome — the same funnel
 * every tool_call/turn_started/turn_done already flows through, no new SSE.
 */
function updateAgentsChip() {
  const tv = state.activeId ? state.turnViews.get(state.activeId) : null;
  let { running, total } = agentCounts(tv);
  if (!total && state.activeId) {
    // No agent tool rows — fall back to the server's wire children so the
    // chip (and the panel behind it) still shows real subagents.
    ({ running, total } = wireSubagentCounts(state.activeId));
  }
  el.agentsChip.hidden = total === 0;
  updateLiveCluster(); // before the early return, or the cluster never collapses
  if (!total) return;
  el.agentsChip.textContent = `agents ${running}/${total}`;
  el.agentsChip.classList.toggle('busy', running > 0);
  el.agentsChip.classList.toggle('agents-pulse', running > 0);
  el.agentsChip.title = `subagent กำลังรัน ${running} จากทั้งหมด ${total} — คลิกเพื่อดูรายละเอียด`;
}

// A tool_call / plan / message_delta of the active chat lands here per event;
// re-rendering the whole sidebar each time detaches any open inline editor
// (group rename / new-group box fires blur on detach — BUG-049). The sidebar's
// running chrome only changes when the SET of running chats does, so re-render
// on a signature change and otherwise flip pulse classes in place
// (grok-desktop re-renders its sidebar on status transitions only).
let lastRunningSig = null;

function runningChatIds() {
  return new Set(
    state.chats.filter((c) => c.running || isRunning(c.id)).map((c) => c.id),
  );
}

function updateRunningSidebar() {
  const running = runningChatIds();
  const sig = [...running].sort().join('|');
  if (sig !== lastRunningSig) {
    lastRunningSig = sig;
    renderSidebar();
    return;
  }
  for (const row of el.sidebarNav.querySelectorAll('.session-item')) {
    const on = running.has(row.dataset.id);
    row.classList.toggle('is-running', on);
    if (on) row.querySelector('.s-pulse')?.classList.add('on');
    else row.querySelector('.s-pulse')?.classList.remove('on');
  }
}

function setAgentState(status) {
  const map = {
    idle: ['ready', 'pill ok'],
    running: ['running', 'pill busy'],
    errored: ['error', 'pill bad'],
    exited: ['exited', 'pill bad'],
    cold: ['cold', 'pill muted'],
  };
  const [label, cls] = map[status] || [status, 'pill muted'];
  el.agentState.textContent = label;
  el.agentState.className = cls;
}

function setMode(mode) {
  el.modeChip.dataset.mode = mode;
  el.modeChip.textContent = MODE_LABEL[mode] || mode;
}

// ------------------------------------------------------ config pickers (BUG-075)

/**
 * Repaint the model/effort pills from state.chatConfig. Options now arrive
 * from the live client OR the agent-wide catalog cache (BUG-079), so the
 * pills are always clickable — a click with no options at all (fresh
 * install, catalog never learned) prewarms the session on demand. The
 * effort pill hides only when advertised options lack a thinking select
 * (0.36.1 omits it for non-thinking models).
 */
function updateConfigPills() {
  const cfg = state.chatConfig;
  const opts = cfg?.options || null;
  const model = opts?.model?.currentValue || cfg?.model || null;
  el.modelChip.hidden = !model && !opts?.model;
  el.modelChip.textContent = modelShortName(model);
  el.modelChip.title = model ? `โมเดล: ${model} — คลิกเพื่อเปลี่ยน` : 'โมเดล — คลิกเพื่อเปลี่ยน';
  el.modelChip.disabled = false;
  el.effortChip.hidden = opts ? !opts.thinking : !cfg?.effort;
  el.effortChip.textContent = opts?.thinking?.currentValue || cfg?.effort || '—';
  el.effortChip.disabled = false;
}

function openConfigMenu(kind, anchor) {
  if (!state.activeId) return;
  const select = state.chatConfig?.options?.[kind];
  if (!select?.values?.length) {
    void prewarmConfigMenu(kind, anchor);
    return;
  }
  const stored = kind === 'model' ? state.chatConfig?.model : state.chatConfig?.effort;
  closePopover();
  openMenu(
    anchor,
    configMenuItems(select, stored).map((it) => ({
      label: it.current ? `${it.label} ✓` : it.label,
      action: () => void setChatConfig(kind, it.value),
    })),
  );
}

/**
 * No catalog yet (fresh install, never spawned anywhere): the click itself
 * is the intent — show a loading row and prewarm the session (spawn +
 * session/new, NO prompt) via config-refresh, then reopen with the real
 * items (BUG-079). The first click pays the 1-3s spawn; the hot pool + the
 * persisted catalog make every later click instant. Never fired
 * automatically on chat select — a CLI process per click-through is waste.
 */
async function prewarmConfigMenu(kind, anchor) {
  openMenu(anchor, [{ label: 'กำลังดึงรายการ…', disabled: true }]);
  try {
    const res = await api(`/api/chats/${encodeURIComponent(state.activeId)}/config-refresh`, {
      method: 'POST',
    });
    state.chatConfig = res.config;
    updateConfigPills();
    closePopover();
    // Reopen only when the select actually exists now — a non-thinking model
    // legitimately has no thinking select; looping there would prewarm forever.
    if (state.chatConfig?.options?.[kind]?.values?.length) openConfigMenu(kind, anchor);
  } catch (err) {
    closePopover();
    showError(`ดึงรายการไม่สำเร็จ: ${err?.message || err}`);
  }
}

/**
 * Optimistic pill update + rollback on error — the same contract the mode
 * chip follows (cycleMode): paint first, the server's snapshot wins when it
 * lands, restore the old pills when the POST fails.
 */
async function setChatConfig(kind, value) {
  if (!state.activeId) return;
  const prev = state.chatConfig;
  const optimistic = { ...(prev || { model: null, effort: null }) };
  optimistic[kind === 'model' ? 'model' : 'effort'] = value;
  if (prev?.options?.[kind]) {
    optimistic.options = { ...prev.options, [kind]: { ...prev.options[kind], currentValue: value } };
  }
  state.chatConfig = optimistic;
  updateConfigPills();
  try {
    const res = await api(`/api/chats/${encodeURIComponent(state.activeId)}/config`, {
      method: 'POST',
      body: { configId: kind, value },
    });
    state.chatConfig = res.config; // the server's fresh selects win
    updateConfigPills();
  } catch (err) {
    state.chatConfig = prev;
    updateConfigPills();
    showError(`เปลี่ยนการตั้งค่าไม่สำเร็จ: ${err?.message || err}`);
  }
}

function showAuthGate(command) {
  state.authCommand = command || state.authCommand;
  el.authGate.hidden = false;
  const cmd = state.authCommand;
  el.authCmd.textContent = cmd ? [cmd.command, ...(cmd.args || [])].join(' ') : 'muse login';
}

function hideAuthGate() {
  el.authGate.hidden = true;
}

// --------------------------------------------------------------- events

/**
 * macOS alert when the agent blocks on a question/approval. Two paths: the
 * Web Notification (works in a real browser) and POST /api/notify (osascript
 * banner — the WKWebView shell does not deliver Web Notifications reliably).
 * Either may fail silently; the card in the transcript is the fallback that
 * never fails.
 */
function notifyAgentQuestion(ix, chatId) {
  const chat = chatId === state.activeId
    ? state.chat
    : state.chats.find((c) => c.id === chatId);
  const title =
    ix?.subtype === 'ask'
      ? 'Muse มีคำถาม'
      : ix?.subtype === 'plan'
        ? 'Muse รอตรวจแผน'
        : 'Muse รอการอนุญาต';
  const detail = String(ix?.toolName || ix?.summary || ix?.body || 'ตอบหน่อย')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  const body = `${chat?.title || 'แชท'} — ${detail}`;
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body, tag: String(ix?.id || chatId) });
    }
  } catch {
    // The host banner below is the real path on macOS; this is best-effort.
  }
  void api('/api/notify', { method: 'POST', body: { title, body } }).catch(() => {});
}

function onEvent(type, data) {
  const chatId = data.chatId;

  switch (type) {
    case 'resync': {
      // Our replay cursor was evicted from the host's ring — the events in
      // the gap (possibly a turn_done) are gone for good. Refetch snapshots
      // instead of reconstructing them (grok-desktop app.js:7399-7408).
      void resyncFromServer();
      return;
    }

    case 'turn_started': {
      const tv = turnView(chatId, true);
      tv.turnId = data.turnId;
      tv.text = '';
      tv.warming = data.warming === true;
      tv.tools = new Map();
      tv.plan = null;
      tv.rev = 0;
      tv.interactions = new Map();
      tv.userToggledTools = new Set(); // per-turn: last turn's manual collapses do not leak
      tv.userExpandedTools = new Set(); // explicit opens do not leak either
      tv.progressOpen = false; // every turn starts with progress hidden
      tv.startedAt = Date.now();
      tv.cancelling = false; // a leftover 'pending' view may carry a stale flag
      tv.thoughtSeen = false; // the reasoning stream restarts with the turn
      if (chatId === state.activeId) {
        if (data.message) {
          state.chat?.messages.push(data.message);
          const turnEl = el.transcript.querySelector('.turn:not(.live-turn)');
          if (turnEl) turnEl.append(messageNode(data.message, state.chat.messages.length - 1));
          else renderTranscript();
        }
        el.transcript.querySelector('.empty')?.remove();
        paintLiveTurn(true);
      }
      if (data.title && state.chat?.id === chatId) paintApTitle(el.title, data.title);
      rightbar.applyTurn(chatId, data.turnId ?? null);
      updateRunningChrome();
      void refreshChats();
      return;
    }

    case 'message_delta': {
      const tv = turnView(chatId, true);
      // A window that missed turn_started (reload, second window, ring
      // eviction) opens the turn from this first scoped event; a late delta
      // from a superseded turn is dropped.
      const bind = bindTurnId(tv, data);
      if (bind === 'drop') return;
      // `text` is the server's running total — trust it over local accumulation
      // so a dropped-then-replayed chunk cannot duplicate or lose text.
      tv.text = typeof data.text === 'string' ? data.text : tv.text + (data.delta || '');
      if (chatId === state.activeId) {
        paintLiveTurn();
        scheduleCtxLive(chatId); // pill fills smoothly between snaps
      }
      if (bind === 'open') updateRunningChrome();
      return;
    }

    case 'thought_delta': {
      // Reasoning TEXT stays unsurfaced (lean UI), but the stream's presence
      // drives the กำลังคิด… status verb. Chunks arrive at delta frequency,
      // so chrome refreshes only on the false→true flip (once per turn) or
      // when this frame opened the turn — per-chunk chrome churn is what the
      // old drop-everything comment feared, not the flip.
      const tv = turnView(chatId, true);
      const bind = bindTurnId(tv, data);
      if (bind === 'drop') return;
      if (!tv.thoughtSeen) {
        tv.thoughtSeen = true;
        if (chatId === state.activeId || bind === 'open') updateRunningChrome();
      }
      return;
    }

    case 'tool_call':
    case 'tool_call_update': {
      const tv = turnView(chatId, true);
      const bind = bindTurnId(tv, data);
      if (bind === 'drop') return;
      tv.tools.set(data.tool.id, data.tool);
      tv.rev = (tv.rev || 0) + 1;
      if (chatId === state.activeId) {
        paintLiveTurn();
        updateRunningChrome();
      } else if (bind === 'open') {
        updateRunningChrome();
      }
      return;
    }

    case 'plan': {
      const tv = turnView(chatId, true);
      const bind = bindTurnId(tv, data);
      if (bind === 'drop') return;
      tv.plan = data.entries;
      tv.rev = (tv.rev || 0) + 1;
      if (chatId === state.activeId) {
        paintLiveTurn();
        updateRunningChrome(); // the status verb follows the in-progress step
      } else if (bind === 'open') {
        updateRunningChrome();
      }
      rightbar.applyPlan(chatId, data.entries);
      return;
    }

    case 'goal': {
      wireGoals.set(chatId, data.goal ?? null);
      if (chatId === state.activeId) updateRunningChrome(); // chips
      rightbar.applyGoal(chatId, data.goal ?? null);
      return;
    }

    case 'ctx': {
      snapCtxLive(chatId, data.ctx ?? null, data.tokens ?? null);
      return;
    }

    case 'usage': {
      if (data.usage) {
        lastUsage = data.usage;
        lastUsageFetch = Date.now();
        paintUsagePill();
      }
      return;
    }

    case 'subagent': {
      const rec = data.subagent;
      if (rec?.itemId) {
        if (!wireSubagents.has(chatId)) wireSubagents.set(chatId, new Map());
        wireSubagents.get(chatId).set(rec.itemId, rec);
        if (chatId === state.activeId) updateRunningChrome(); // chip fallback
        rightbar.applyAgents(chatId, wireSubagents.get(chatId));
        childActivity.noteSubagent(chatId, rec);
      }
      return;
    }

    case 'subagent_delta': {
      // Live child text patches the rail rows in place (list + open drill);
      // the mirror update keeps a rail opened later honest too.
      const live = wireSubagents.get(chatId)?.get(String(data.itemId));
      if (live && typeof data.text === 'string') live.liveText = data.text;
      rightbar.applyAgentDelta(chatId, String(data.itemId), String(data.text || ''));
      childActivity.noteSubagentDelta(chatId, String(data.itemId), String(data.text || ''));
      return;
    }

    case 'mcp_servers': {
      mcpPanel.applySnapshot(data);
      return;
    }

    case 'interaction': {
      const tv = turnView(chatId, true);
      const bind = bindTurnId(tv, data);
      if (bind === 'drop') return;
      // Replays (resync, second window) re-deliver the same card — notify
      // only the first time an id is seen, or one question spams N banners.
      const isNew = !tv.interactions.has(data.id) && !data.resolved;
      tv.interactions.set(data.id, data);
      tv.rev = (tv.rev || 0) + 1;
      if (isNew) notifyAgentQuestion(data, chatId);
      if (chatId === state.activeId) {
        paintLiveTurn();
        updateRunningChrome(); // the status verb flips to รอการอนุญาต…
      } else {
        renderSidebar();
        if (bind === 'open') updateRunningChrome();
      }
      void refreshChats();
      return;
    }

    case 'interaction_resolved': {
      const tv = state.turnViews.get(chatId);
      const ix = tv?.interactions.get(data.id);
      if (ix) {
        ix.resolved = true;
        // The picked option survives on the card — a resolved card with no
        // record of the choice reads as unanswered (BUG-032).
        if (data.optionId != null) ix.optionId = data.optionId;
        tv.rev = (tv.rev || 0) + 1;
      }
      if (chatId === state.activeId) {
        paintLiveTurn();
        updateRunningChrome(); // answered card: the verb drops รอการอนุญาต…
      }
      void refreshChats();
      return;
    }

    case 'turn_done':
    case 'turn_error': {
      // Flush the throttled markdown BEFORE the view is dropped — a pending
      // paint would otherwise fire into the deleted view (a no-op) and the
      // final chunks would stay unrendered if the transcript reload fails.
      if (chatId === state.activeId) liveMd.flush();
      state.turnViews.delete(chatId);
      rightbar.applyTurn(chatId, null);
      if (chatId === state.activeId) {
        // Dereference only the ACTIVE chat's live nodes. Nulling them for a
        // background chat's settle orphaned the visible live wrap: the next
        // active delta then painted a SECOND live turn above the frozen one
        // (grok-desktop app.js:6883-6886 touches only epoch/stop controls
        // for non-active settles).
        liveWrap = null;
        liveText = null;
        liveProgress = null;
        // Paint the outcome BEFORE the transcript reload wipes the live DOM —
        // a cancelled turn with no text otherwise leaves zero trace, and an
        // errored one reads as a normal answer until the reload lands
        // (grok-desktop app.js:6917-6932 paints the final answer + an error
        // bubble; the reload then replaces these with the persisted copies).
        if (data.reason === 'cancelled' || data.reason === 'watchdog') {
          el.transcript.append(interruptedMarkerNode(data.reason));
        }
        if (data.error) showError(`เทิร์นจบแบบไม่สำเร็จ: ${data.error}`);
        // Reload the settled transcript from the server: its stored version is
        // authoritative (it merged the final content over the chunks).
        // The next queued prompt dispatches only AFTER this paint path settles
        // (R14b), so turn_started of the follow-up never races the refetch.
        void selectChat(chatId, { keepScroll: true }).finally(() => scheduleQueueDispatch(chatId));
      } else {
        // A background chat's settle has no paint to wait for here.
        scheduleQueueDispatch(chatId);
      }
      updateRunningChrome();
      void refreshChats();
      void refreshUsage(); // subscription counters move every turn
      return;
    }

    case 'agent_status':
      if (chatId === state.activeId) setAgentState(data.status);
      return;

    case 'agent_ready':
      hideAuthGate();
      if (chatId === state.activeId) setAgentState('idle');
      return;

    case 'agent_exit':
      warmedChats.delete(chatId);
      if (chatId === state.activeId) setAgentState('exited');
      void refreshChats();
      return;

    case 'agent_released':
      warmedChats.delete(chatId);
      if (chatId === state.activeId) setAgentState('cold');
      void refreshChats();
      return;

    case 'agent_error': {
      // The agent process itself failed (spawn / handshake / bad frame).
      // Every attached window must learn it — not just the one that started
      // the turn (grok-desktop emits start failures over SSE,
      // sessions.js:3564).
      if (chatId === state.activeId) {
        setAgentState('errored');
        showError(`agent ทำงานไม่สำเร็จ: ${data.message || 'unknown'}`);
      }
      void refreshChats();
      return;
    }

    case 'agent_stderr': {
      // MSP diagnostics (subscribe retries, dropped completions) + raw agent
      // stderr. Shown as a transient notice, never modal, and never an
      // errored state — stderr is a warning, not a death. Chat 81442763
      // hung silently for 20+ minutes because this event had no handler.
      if (chatId === state.activeId) {
        const first = String(data.text || '').split('\n')[0].slice(0, 300);
        if (first.trim()) showError(`agent: ${first}`);
      }
      return;
    }

    case 'auth_required':
      showAuthGate(data.command);
      return;

    case 'mode_changed':
      if (chatId === state.activeId) setMode(data.mode);
      return;

    case 'config_changed': {
      // Authoritative snapshot after a successful POST /config — from this
      // window or another (BUG-075). Only the active chat's pills repaint;
      // off-screen chats refetch on select like everything else.
      if (chatId === state.activeId) {
        state.chatConfig = data.config || null;
        updateConfigPills();
        rightbar.applyModel(chatId, costModelFor(chatId));
      }
      return;
    }

    case 'config_option_update': {
      // The agent pushed a fresh configOptions snapshot (fires after any
      // set_config_option). Fold it into the local copy so the pickers stay
      // current without a refetch.
      const raw = data.update?.configOptions;
      if (Array.isArray(raw) && chatId === state.activeId) {
        state.chatConfig = {
          model: null,
          effort: null,
          ...(state.chatConfig || {}),
          options: configSelectsFromOptions(raw),
        };
        updateConfigPills();
      }
      return;
    }

    case 'load_miss':
    case 'chat_created':
    case 'chat_updated':
    case 'chat_removed':
    case 'chat_moved':
      applyGroupsState(data);
      void refreshChats();
      return;

    case 'group_created':
    case 'group_updated':
    case 'group_removed':
    case 'groups_reordered':
    case 'group_selected':
      // Another window changed the sidebar — adopt it wholesale rather than
      // trying to merge, so both windows always show the same tree.
      applyGroupsState(data);
      void refreshChats();
      return;

    default:
      return;
  }
}

function connectStream() {
  const source = new EventSource(`/api/events?clientId=${encodeURIComponent(state.clientId)}`);
  const types = [
    'hello', 'resync', 'turn_started', 'message_delta', 'thought_delta', 'tool_call', 'tool_call_update',
    'plan', 'interaction', 'interaction_resolved', 'turn_done', 'turn_error', 'agent_status',
    'agent_ready', 'agent_exit', 'agent_released', 'agent_error', 'agent_stderr', 'auth_required',
    'mode_changed', 'load_miss', 'chat_created', 'chat_updated', 'chat_removed', 'chat_moved',
    'group_created', 'group_updated', 'group_removed', 'groups_reordered', 'group_selected',
    'available_commands', 'agent_handshake', 'agent_mode_echo', 'config_option_update',
    'agent_update_other', 'subagent', 'subagent_delta', 'mcp_servers', 'goal', 'ctx', 'usage',
  ];
  for (const t of types) {
    source.addEventListener(t, (ev) => {
      let data = {};
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      onEvent(t, data);
    });
  }
  source.addEventListener('error', () => {
    // EventSource reconnects on its own and replays via Last-Event-ID.
    el.agentBadge.classList.add('bad');
    el.agentBadge.textContent = 'host disconnected — retrying…';
  });
  source.addEventListener('open', () => {
    el.agentBadge.classList.remove('bad');
    void refreshAgentBadge();
  });
  return source;
}

// --------------------------------------------------------------- actions

/** One request refreshes both halves of the sidebar — they must not disagree. */
async function refreshChats() {
  const { chats, groups, activeGroupId } = await api('/api/chats');
  state.chats = chats;
  if (Array.isArray(groups)) state.groups = groups;
  if (activeGroupId) state.activeGroupId = activeGroupId;
  renderSidebar();
}

/**
 * Full snapshot reload after an SSE `resync` (our replay cursor was evicted
 * from the host ring). Reuses the boot-time fetches: chat list + groups, any
 * permission cards still waiting, and the open chat's transcript.
 */
async function resyncFromServer() {
  wireSubagents.clear();
  wireGoals.clear();
  wireCtx.clear();
  if (state.activeId) {
    const { goal } = await api(`/api/chats/${encodeURIComponent(state.activeId)}/goal`)
      .catch(() => ({ goal: null }));
    if (goal) wireGoals.set(state.activeId, goal);
    const snap = await api(`/api/chats/${encodeURIComponent(state.activeId)}/ctx`)
      .catch(() => ({ ctx: null, tokens: null }));
    if (snap?.ctx || snap?.tokens) {
      wireCtx.set(state.activeId, { ctx: snap.ctx ?? null, tokens: snap.tokens ?? null, baseChars: 0 });
    }
  }
  if (state.activeId) {
    // A subagent frame may have fallen into the evicted gap — the registry
    // is the truth, like the running flags below.
    const { subagents } = await api(`/api/chats/${encodeURIComponent(state.activeId)}/subagents`)
      .catch(() => ({ subagents: [] }));
    if (Array.isArray(subagents) && subagents.length) {
      wireSubagents.set(state.activeId, new Map(subagents.map((s) => [s.itemId, s])));
    }
  }
  await refreshChats();
  // A turn_done that fell into the evicted gap would leave the local live
  // view spinning forever — the server's per-chat running flag is the truth.
  for (const chat of state.chats) {
    if (!chat.running) state.turnViews.delete(chat.id);
  }
  const { interactions } = await api('/api/interactions').catch(() => ({ interactions: [] }));
  for (const ix of interactions || []) {
    const tv = turnView(ix.chatId, true);
    if (!tv.turnId) tv.turnId = 'pending';
    tv.interactions.set(ix.id, ix);
  }
  if (state.activeId) await selectChat(state.activeId, { keepScroll: true });
  updateRunningChrome();
}

function applyGroupsState(payload) {
  if (Array.isArray(payload?.groups)) state.groups = payload.groups;
  if (payload?.activeGroupId) state.activeGroupId = payload.activeGroupId;
}

async function selectGroup(groupId) {
  if (!groupId) return;
  const res = await api(`/api/groups/${encodeURIComponent(groupId)}/select`, { method: 'POST' });
  applyGroupsState(res);
  if (Array.isArray(res.chats)) state.chats = res.chats;
  renderSidebar();
}

async function createGroup(name, position = 'top') {
  const res = await api('/api/groups', { method: 'POST', body: { name, position } });
  applyGroupsState(res);
  if (res.group) {
    sidebar.ensureExpanded(res.group.id);
    await selectGroup(res.group.id);
  }
  renderSidebar();
}

/* ─────────────────── Cross-chat search + find-in-chat ───────────────────
 * grok-desktop parity (app.js runSessionSearch / wireSessionSearch /
 * navigateToSearchHit / find-in-session block): the sidebar box finds any
 * string in any chat (FTS5 trigram server-side), the ⌘F toolbar finds in the
 * open chat's generated content only. Both deep-link and flash the target.
 * ------------------------------------------------------------------------- */

/** Flash a deep-linked transcript node so the eye lands on it. */
function flashSearchTarget(node) {
  if (!node?.scrollIntoView) return;
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  node.classList.remove('search-flash');
  // Restart the animation when jumping between adjacent hits.
  void node.offsetWidth;
  node.classList.add('search-flash');
  setTimeout(() => node.classList.remove('search-flash'), 2200);
}

/**
 * Make sure the message at absolute index is mounted: expand the history
 * window upward when the hit sits above it (all messages are already in
 * memory — no fetch, unlike grok's loadHistory).
 */
function ensureMsgMounted(msgIndex) {
  const chat = state.chat;
  if (chat && msgIndex != null && Number(msgIndex) < historyWindowStart(chat.messages)) {
    historyStartIndex = Math.max(0, Number(msgIndex));
    renderTranscript({ stick: false });
  }
}

function findTranscriptNode(m) {
  const root = el.transcript;
  if (!root) return null;
  // Tool / console hits land on the tool row — opening every collapsed
  // ancestor (progress group + the row itself) so the flash is visible.
  if (m.surface === 'activity' || m.surface === 'console' || m.kind === 'tool' || m.kind === 'agent' || m.kind === 'tool_out') {
    const tid = m.refId;
    let row = tid
      ? root.querySelector(`.tool-row[data-tool-id="${CSS.escape(String(tid))}"]`)
      : null;
    if (!row && m.msgIndex != null) {
      row = root.querySelector(`[data-msg-index="${m.msgIndex}"]`);
    }
    if (row) {
      const toolRow = row.classList?.contains('tool-row') ? row : row.querySelector?.('.tool-row');
      const group = (toolRow || row).closest?.('.progress-group');
      if (group?.classList.contains('pg-collapsed')) {
        group.classList.remove('pg-collapsed');
        const glyph = group.querySelector('.progress-head .glyph');
        if (glyph) glyph.textContent = '▾';
        // A DOM-only open of the LIVE group would be re-collapsed by the
        // next structural paint — sync the turn view too.
        if (liveProgress && group === liveProgress.group) {
          const cur = state.activeId ? state.turnViews.get(state.activeId) : null;
          if (cur) cur.progressOpen = true;
        }
      }
      if (toolRow?.classList.contains('collapsed')) {
        setToolRowCollapsed(toolRow, false);
        const tid2 = toolRow.dataset?.toolId;
        if (tid2 && liveProgress && group === liveProgress.group) {
          state.turnViews.get(state.activeId)?.userExpandedTools?.add(tid2);
        }
      }
      return toolRow || row;
    }
  }
  const snip = String(m.snippet || '').replace(/[[\]]/g, '').slice(0, 48);
  if (m.msgIndex != null) {
    const byIndex = root.querySelector(`[data-msg-index="${m.msgIndex}"]`);
    if (byIndex) return byIndex;
  }
  if (snip) {
    return [...root.querySelectorAll('.msg-user, .msg-assistant, .msg-notice')].find((n) =>
      (n.textContent || '').includes(snip.slice(0, 24)),
    ) || null;
  }
  return null;
}

async function navigateToSearchHit(hit) {
  if (!hit) return;
  // Group-only hit: switch group, no chat.
  if (hit.hitType === 'group' && hit.groupId) {
    await selectGroup(hit.groupId);
    return;
  }
  if (!hit.sessionId) return;
  if (hit.groupId && hit.groupId !== state.activeGroupId) {
    await selectGroup(hit.groupId);
  }
  const m = hit.matches?.[0] || {};
  await selectChat(hit.sessionId);
  if (m.msgIndex != null) ensureMsgMounted(Number(m.msgIndex));
  const node = findTranscriptNode(m);
  if (node) flashSearchTarget(node);
}

let searchTimer = 0;

/** Cross-chat search → dropdown of chat hits (FTS5 trigram). */
async function runSessionSearch(q) {
  const box = el.sessionSearchHits;
  const input = el.sessionSearchInput;
  if (!box) return;
  const query = String(q ?? input?.value ?? '').trim();
  if (!query) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = '<div class="search-hit muted">กำลังค้นหา…</div>';
  let res;
  try {
    res = await api(`/api/search?q=${encodeURIComponent(query)}&limit=40`);
  } catch (err) {
    box.innerHTML = `<div class="search-hit muted">${escapeHtml(err?.message || 'search error')}</div>`;
    return;
  }
  if (!res?.ok && res?.engine === 'disabled') {
    box.innerHTML =
      `<div class="search-hit muted">FTS ปิด: ${escapeHtml(res?.error || 'unavailable')}</div>` +
      `<div class="search-hit muted">ใช้ Node ที่ build better-sqlite3 ได้ แล้ว rebuild</div>`;
    return;
  }
  if (!res?.ok) {
    box.innerHTML = `<div class="search-hit muted">${escapeHtml(res?.error || 'search failed')}</div>`;
    return;
  }
  const hits = Array.isArray(res.hits) ? res.hits : [];
  if (!hits.length) {
    box.innerHTML = '<div class="search-hit muted">ไม่พบผลลัพธ์</div>';
    return;
  }
  box.innerHTML = '';
  for (const h of hits) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'search-hit';
    btn.setAttribute('role', 'option');
    const m0 = h.matches?.[0] || {};
    const snip = m0.snippet || '';
    const field = m0.kind || m0.field || '';
    const surface = m0.surface || '';
    const gLabel = h.groupName || '';
    const turnBit = m0.turn != null ? ` · t#${m0.turn}` : '';
    btn.innerHTML =
      (gLabel ? `<span class="search-hit-group">${escapeHtml(gLabel)}</span>` : '') +
      `<span class="search-hit-title">${escapeHtml(h.title || 'แชท')}</span>` +
      `<span class="search-hit-meta">${escapeHtml(h.shortId || '')}` +
      (h.status === 'running' || h.status === 'starting' ? ' · run' : '') +
      (field ? ` · ${escapeHtml(field)}` : '') +
      (surface ? ` · ${escapeHtml(surface)}` : '') +
      turnBit +
      `</span>` +
      (snip ? `<span class="search-hit-snip">${escapeHtml(snip)}</span>` : '');
    btn.title = (h.matches || [])
      .map((m) => `${m.kind || m.field}${m.surface ? '/' + m.surface : ''}: ${m.snippet}`)
      .join('\n');
    btn.addEventListener('click', () => {
      box.hidden = true;
      void navigateToSearchHit(h);
    });
    box.appendChild(btn);
  }
  const foot = document.createElement('div');
  foot.className = 'search-hit muted search-hit-foot';
  foot.textContent =
    `${hits.length}${res.total > hits.length ? ` / ${res.total}` : ''} ผลลัพธ์` +
    (res.engine ? ` · ${res.engine}` : '') +
    (res.tookMs != null ? ` · ${res.tookMs}ms` : '');
  box.appendChild(foot);
}

function wireSessionSearch() {
  const input = el.sessionSearchInput;
  const box = el.sessionSearchHits;
  if (!input || !box) return;
  input.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = 0;
      void runSessionSearch(input.value);
    }, 220);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      box.hidden = true;
      input.blur();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void runSessionSearch(input.value);
    }
  });
  // Close hits when clicking outside.
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t instanceof Element && t.closest('#session-search')) return;
    box.hidden = true;
  });
}

/* ── Find-in-chat: generated content of the OPEN chat only ─────────────── */

let sessionFindTimer = 0;
/** @type {Array<{turn:number|null,msgIndex:number|null,kind:string,snippet:string}>} */
let sessionFindHits = [];
let sessionFindIdx = -1;
let sessionFindReqSeq = 0;

function isSessionFindOpen() {
  return !!(el.sessionFind && !el.sessionFind.hidden);
}

function openSessionFind() {
  if (!el.sessionFind) return;
  el.sessionFind.hidden = false;
  el.btnSessionFind?.setAttribute('aria-expanded', 'true');
  el.btnSessionFind?.classList.add('is-active');
  const input = el.sessionFindInput;
  if (input) {
    input.focus();
    input.select();
    if (input.value.trim()) void runSessionFind(input.value);
  }
}

function closeSessionFind() {
  if (!el.sessionFind) return;
  el.sessionFind.hidden = true;
  el.btnSessionFind?.setAttribute('aria-expanded', 'false');
  el.btnSessionFind?.classList.remove('is-active');
  if (el.sessionFindHits) {
    el.sessionFindHits.hidden = true;
    el.sessionFindHits.innerHTML = '';
  }
}

function toggleSessionFind() {
  if (isSessionFindOpen()) closeSessionFind();
  else openSessionFind();
}

/** Reset state when the active chat changes (hits belong to the old chat). */
function resetSessionFind() {
  sessionFindHits = [];
  sessionFindIdx = -1;
  if (el.sessionFindCount) el.sessionFindCount.textContent = '';
  if (el.sessionFindHits) {
    el.sessionFindHits.hidden = true;
    el.sessionFindHits.innerHTML = '';
  }
  if (isSessionFindOpen() && el.sessionFindInput?.value.trim()) {
    void runSessionFind(el.sessionFindInput.value);
  }
}

async function runSessionFind(q) {
  const query = String(q ?? el.sessionFindInput?.value ?? '').trim();
  const countEl = el.sessionFindCount;
  const box = el.sessionFindHits;
  sessionFindHits = [];
  sessionFindIdx = -1;
  if (!query) {
    if (countEl) countEl.textContent = '';
    if (box) { box.hidden = true; box.innerHTML = ''; }
    return;
  }
  if (!state.activeId) {
    if (countEl) countEl.textContent = 'ไม่มีแชท';
    return;
  }
  if (countEl) countEl.textContent = '…';
  const seq = ++sessionFindReqSeq;
  let res;
  try {
    res = await api(
      `/api/chats/${encodeURIComponent(state.activeId)}/search?q=${encodeURIComponent(query)}&limit=100`,
    );
  } catch (err) {
    if (seq !== sessionFindReqSeq) return;
    if (countEl) countEl.textContent = 'error';
    return;
  }
  if (seq !== sessionFindReqSeq) return; // stale response
  if (!res?.ok && res?.engine === 'disabled') {
    if (countEl) countEl.textContent = 'FTS ปิด';
    return;
  }
  const hits = Array.isArray(res?.hits) ? res.hits : [];
  sessionFindHits = hits;
  sessionFindIdx = -1;
  renderSessionFindHits(hits);
  if (countEl) countEl.textContent = hits.length ? `0/${hits.length}` : 'ไม่พบ';
  if (hits.length) void gotoSessionFindHit(0);
}

function renderSessionFindHits(hits) {
  const box = el.sessionFindHits;
  if (!box) return;
  if (!hits.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = '';
  hits.forEach((h, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'session-find-hit';
    btn.setAttribute('role', 'option');
    btn.dataset.findIdx = String(i);
    const snip = String(h.snippet || '').replace(/[[\]]/g, '');
    const turnBit = h.turn != null ? `t#${h.turn}` : '';
    btn.innerHTML =
      `<span class="session-find-hit-meta">${escapeHtml(turnBit)}` +
      (h.kind ? ` · ${escapeHtml(h.kind)}` : '') +
      `</span>` +
      `<span class="session-find-hit-snip">${escapeHtml(snip.slice(0, 140))}</span>`;
    btn.addEventListener('click', () => gotoSessionFindHit(i));
    box.appendChild(btn);
  });
}

async function gotoSessionFindHit(i) {
  if (!sessionFindHits.length) return;
  const n = sessionFindHits.length;
  const idx = ((i % n) + n) % n;
  sessionFindIdx = idx;
  const m = sessionFindHits[idx];
  if (el.sessionFindCount) el.sessionFindCount.textContent = `${idx + 1}/${n}`;
  if (el.sessionFindHits) {
    for (const b of el.sessionFindHits.querySelectorAll('.session-find-hit')) {
      b.classList.toggle('is-active', b.dataset.findIdx === String(idx));
    }
    const active = el.sessionFindHits.querySelector('.session-find-hit.is-active');
    active?.scrollIntoView({ block: 'nearest' });
  }
  if (m.msgIndex != null) ensureMsgMounted(Number(m.msgIndex));
  const node = findTranscriptNode(m);
  if (node) flashSearchTarget(node);
}

function wireSessionFind() {
  el.btnSessionFind?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleSessionFind();
  });
  el.sessionFindClose?.addEventListener('click', () => closeSessionFind());
  el.sessionFindPrev?.addEventListener('click', () => {
    if (sessionFindHits.length) gotoSessionFindHit(sessionFindIdx - 1);
  });
  el.sessionFindNext?.addEventListener('click', () => {
    if (sessionFindHits.length) gotoSessionFindHit(sessionFindIdx + 1);
  });
  const input = el.sessionFindInput;
  if (input) {
    input.addEventListener('input', () => {
      if (sessionFindTimer) clearTimeout(sessionFindTimer);
      sessionFindTimer = window.setTimeout(() => {
        sessionFindTimer = 0;
        void runSessionFind(input.value);
      }, 230);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSessionFind();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (!sessionFindHits.length) {
          void runSessionFind(input.value);
        } else {
          gotoSessionFindHit(sessionFindIdx + (e.shiftKey ? -1 : 1));
        }
      }
    });
  }
  // Cmd/Ctrl+F opens find-in-chat (when a chat is open).
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      if (!state.activeId) return;
      e.preventDefault();
      openSessionFind();
    }
  });
}

/* ───────────────────────────── File attach ─────────────────────────────
 * grok-desktop's attach UX (picker + pasted paths + chips, app.js:5330-5492)
 * with one deliberate break: attachments NEVER merge into the prompt text.
 * Images ride as MSP `image` parts, files as `@path` mentions in a separate
 * text part (see src/server/attachments.js). The transcript keeps them in
 * message meta and paints chips under the user bubble.
 * ------------------------------------------------------------------------- */

/** @type {Map<string, Array<{kind:string,path?:string,name?:string,mediaType?:string,base64?:string}>>} */
const attachmentsByChat = new Map();

function attachKey() {
  return state.activeId || '__no_chat__';
}

function getAttachments(id = attachKey()) {
  return attachmentsByChat.get(id) || [];
}

function setAttachments(list, id = attachKey()) {
  // Paths dedup by string; pasted pixels are always intentional — keep all.
  const seen = new Set();
  const uniq = [];
  for (const a of list) {
    if (a?.kind === 'path' && a.path) {
      if (seen.has(a.path)) continue;
      seen.add(a.path);
    }
    if (a && (a.kind === 'path' || a.kind === 'image-data')) uniq.push(a);
  }
  if (uniq.length) attachmentsByChat.set(id, uniq);
  else attachmentsByChat.delete(id);
  renderAttachBar();
}

function addAttachments(items, id = attachKey()) {
  if (!items?.length) return;
  setAttachments([...getAttachments(id), ...items], id);
}

function removeAttachment(item) {
  const id = attachKey();
  setAttachments(getAttachments(id).filter((a) => a !== item), id);
}

function clearAttachments(id = attachKey()) {
  attachmentsByChat.delete(id);
  renderAttachBar();
}

function baseName(p) {
  const s = String(p || '').replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

function attachIcon(a) {
  if (a.kind === 'image-data' || a.mediaType?.startsWith('image/')) return '🖼️';
  if (a.kind === 'path' || a.path) {
    const p = a.path || '';
    if (/\/$/.test(p)) return '📁';
    if (/\.(png|jpe?g|gif|webp)$/i.test(p)) return '🖼️';
  }
  return '📄';
}

function renderAttachBar() {
  const bar = el.attachBar;
  if (!bar) return;
  const list = getAttachments();
  if (!list.length) {
    bar.hidden = true;
    bar.innerHTML = '';
    el.btnAttach?.classList.remove('has-attachments');
    return;
  }
  bar.hidden = false;
  bar.innerHTML =
    `<span class="attach-bar-label" title="ไฟล์เหล่านี้แนบไปกับข้อความถัดไป (ไม่รวมในข้อความ)">📎 ${list.length} รายการ</span>`;
  for (const a of list) {
    const chip = document.createElement('span');
    chip.className = 'attach-chip';
    chip.title = a.path || `${a.name || 'image'} (${a.mediaType || ''})`;
    chip.innerHTML =
      `<span class="attach-chip-ico" aria-hidden="true">${attachIcon(a)}</span>` +
      `<span class="attach-chip-name">${escapeHtml(a.path ? baseName(a.path) : a.name || 'image')}</span>` +
      `<button type="button" class="attach-chip-x" aria-label="เอาออก">✕</button>`;
    chip.querySelector('.attach-chip-x')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeAttachment(a);
    });
    bar.appendChild(chip);
  }
  el.btnAttach?.classList.add('has-attachments');
}

/** Chips under a settled user bubble, from message meta (history + live). */
function attachChipsNode(attachments) {
  const row = document.createElement('div');
  row.className = 'msg-attach-chips';
  for (const a of attachments || []) {
    if (!a?.path) continue;
    const chip = document.createElement('span');
    chip.className = 'attach-chip static';
    chip.title = a.path;
    chip.innerHTML =
      `<span class="attach-chip-ico" aria-hidden="true">${attachIcon(a)}</span>` +
      `<span class="attach-chip-name">${escapeHtml(a.name || baseName(a.path))}</span>`;
    row.appendChild(chip);
  }
  return row.childNodes.length ? row : null;
}

/** Wire shape for POST /prompt: paths stay paths, pixels ride inline. */
function toWireAttachments(list) {
  return (list || []).map((a) =>
    a.kind === 'image-data'
      ? { name: a.name, mediaType: a.mediaType, base64: a.base64 }
      : { path: a.path },
  );
}

function openAttachPop() {
  const pop = el.attachPop;
  if (!pop) return;
  pop.hidden = false;
  el.btnAttach?.setAttribute('aria-expanded', 'true');
  el.attachPaste && (el.attachPaste.value = '');
  el.attachPaste?.focus();
}

function closeAttachPop() {
  if (!el.attachPop) return;
  el.attachPop.hidden = true;
  el.btnAttach?.setAttribute('aria-expanded', 'false');
}

function commitPastedPaths() {
  const raw = el.attachPaste?.value || '';
  const paths = raw
    .split('\n')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter((s) => s.length > 1)
    .map((p) => ({ kind: 'path', path: p }));
  if (paths.length) addAttachments(paths);
  if (el.attachPaste) el.attachPaste.value = '';
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(new Error('read failed'));
    r.readAsDataURL(file);
  });
}

const CLIENT_MAX_IMAGE_BYTES = 15 * 1024 * 1024;
let pastedImageSeq = 0;

/**
 * Files from paste / drop. Images become inline image-data (screenshots have
 * no path); anything else uploads to the server inbox and attaches by path.
 */
async function handleAttachFiles(files) {
  const list = [...(files || [])];
  if (!list.length) return;
  for (const file of list) {
    try {
      if (file.size > CLIENT_MAX_IMAGE_BYTES && file.type.startsWith('image/')) {
        showError(`รูป ${file.name || ''} ใหญ่เกิน 15MB — แนบไม่สำเร็จ`.trim());
        continue;
      }
      if (file.type.startsWith('image/')) {
        const dataUrl = await readFileAsDataUrl(file);
        const base64 = (dataUrl.split(',', 2)[1] || '').trim();
        if (!base64) continue;
        pastedImageSeq += 1;
        addAttachments([{
          kind: 'image-data',
          name: file.name || `pasted-image-${pastedImageSeq}.png`,
          mediaType: file.type,
          base64,
        }]);
      } else {
        const dataUrl = await readFileAsDataUrl(file);
        const base64 = (dataUrl.split(',', 2)[1] || '').trim();
        if (!base64) continue;
        const res = await api('/api/attachments/upload', {
          method: 'POST',
          body: { name: file.name || 'dropped-file', base64 },
        });
        if (res?.path) addAttachments([{ kind: 'path', path: res.path }]);
      }
    } catch (err) {
      showError(`แนบไฟล์ไม่สำเร็จ: ${err.message}`);
    }
  }
}

function wireAttach() {
  if (!el.btnAttach) return;
  el.btnAttach.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (el.attachPop && !el.attachPop.hidden) closeAttachPop();
    else openAttachPop();
  });
  el.attachClose?.addEventListener('click', () => {
    commitPastedPaths();
    closeAttachPop();
  });
  el.attachAdd?.addEventListener('click', () => {
    commitPastedPaths();
    el.attachPaste?.focus();
  });
  const runPicker = async (btn, mode) => {
    if (!btn) return;
    const was = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'กำลังเปิด…';
    try {
      const r = await api(`/api/pick-files?mode=${mode}`, { method: 'POST' });
      if (r?.ok && Array.isArray(r.paths) && r.paths.length) {
        addAttachments(r.paths.map((p) => ({ kind: 'path', path: p })));
      } else if (r?.ok === false && r?.error) {
        btn.title = r.error;
        showError(r.error);
      }
    } catch (err) {
      showError(`เปิดตัวเลือกไฟล์ไม่สำเร็จ: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = was;
    }
  };
  el.attachBrowse?.addEventListener('click', () => runPicker(el.attachBrowse, 'file'));
  el.attachBrowseFolder?.addEventListener('click', () => runPicker(el.attachBrowseFolder, 'folder'));
  // Close popover on outside click / Esc.
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t instanceof Element && (t.closest('#attach-pop') || t.closest('#btn-attach'))) return;
    if (el.attachPop && !el.attachPop.hidden) {
      commitPastedPaths();
      closeAttachPop();
    }
  });
  el.attachPaste?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAttachPop();
  });
  // Paste screenshots straight into attachments (text still pastes as text).
  el.prompt?.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) void handleAttachFiles(files);
  });
  // Drop files onto the composer.
  el.composer?.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.composer.classList.add('attach-dragover');
  });
  el.composer?.addEventListener('dragleave', () => {
    el.composer.classList.remove('attach-dragover');
  });
  el.composer?.addEventListener('drop', (e) => {
    e.preventDefault();
    el.composer.classList.remove('attach-dragover');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) void handleAttachFiles(files);
  });
}

async function renameGroup(groupId, name) {
  const res = await api(`/api/groups/${encodeURIComponent(groupId)}`, {
    method: 'PATCH',
    body: { name },
  });
  applyGroupsState(res);
  renderSidebar();
}

async function deleteGroup(groupId) {
  try {
    const res = await api(`/api/groups/${encodeURIComponent(groupId)}`, { method: 'DELETE' });
    applyGroupsState(res);
    if (Array.isArray(res.chats)) state.chats = res.chats;
    // The active chat may have lived in the group that just went away.
    if (!state.chats.some((c) => c.id === state.activeId)) {
      await selectChat(state.chats[0]?.id ?? null);
    }
    renderSidebar();
  } catch (err) {
    showError(err.payload?.code === 'LAST_GROUP' ? 'ต้องเหลืออย่างน้อย 1 group' : err.message);
  }
}

async function reorderGroups(order) {
  // Paint the new order immediately — a drag that visually snaps back while
  // the request is in flight reads as "it didn't work".
  const byId = new Map(state.groups.map((g) => [g.id, g]));
  state.groups = order.map((id) => byId.get(id)).filter(Boolean);
  renderSidebar();
  const res = await api('/api/groups/reorder', { method: 'POST', body: { order } });
  applyGroupsState(res);
  renderSidebar();
}

async function moveChat(chatId, groupId) {
  const res = await api(`/api/chats/${encodeURIComponent(chatId)}/move`, {
    method: 'POST',
    body: { groupId },
  });
  applyGroupsState(res);
  await refreshChats();
  if (chatId === state.activeId) state.activeGroupId = groupId;
  renderSidebar();
}

async function deleteChat(chatId) {
  await api(`/api/chats/${encodeURIComponent(chatId)}`, { method: 'DELETE' });
  state.turnViews.delete(chatId);
  drafts.clear(chatId);
  promptQueue.clear(chatId);
  await refreshChats();
  if (state.activeId === chatId) {
    const sameGroup = state.chats.find((c) => c.groupId === state.activeGroupId);
    await selectChat((sameGroup || state.chats[0])?.id ?? null);
  }
}

/**
 * Copy the whole chat as Markdown (BUG-054; grok-desktop copySessionSummary,
 * app.js:6407-6426). Uses the chat on screen when possible, otherwise fetches
 * it — the menu works on any sidebar row, not just the active chat.
 */
async function copyChatMarkdown(chatId) {
  try {
    const chat =
      chatId === state.activeId && state.chat
        ? state.chat
        : (await api(`/api/chats/${encodeURIComponent(chatId)}`)).chat;
    const ok = await copyTextToClipboard(chatToMarkdown(chat));
    // The menu is gone by now — feedback only lands where the user is looking.
    if (!ok && chatId === state.activeId) showError('คัดลอกไม่สำเร็จ — clipboard ไม่พร้อม');
  } catch (err) {
    if (chatId === state.activeId) showError(`คัดลอกไม่สำเร็จ: ${err.message}`);
  }
}

/**
 * Pull the server's open-turn snapshot into the local view, so a reload /
 * resync / chat switch mid-turn repaints the partial answer, tool rows, plan
 * and running chrome without waiting for the next delta (grok-desktop
 * `resyncSessionTurn`, app.js:6682-6711 → `overlayLiveTurnFromStore`,
 * app.js:6620-6674). No-op when no turn is live.
 */
async function hydrateTurnView(chatId) {
  const { turn } = await api(`/api/chats/${encodeURIComponent(chatId)}/turn`).catch(() => ({
    turn: null,
  }));
  if (!turn) return;
  seedTurnView(turnView(chatId, true), turn);
}

async function selectChat(chatId, { keepScroll = false } = {}) {
  const prevId = state.activeId;
  if (prevId && prevId !== chatId) {
    drafts.set(prevId, el.prompt.value);
  }
  // keepScroll must not remember an absolute scrollTop: after the refetch the
  // transcript is re-laid-out and the old pixel value points at the wrong
  // content (BUG-044). Remember the DISTANCE FROM BOTTOM instead (grok-desktop
  // loadOlderHistory, app.js:4526-4538).
  const keepDistBottom = keepScroll
    ? el.transcript.scrollHeight - el.transcript.clientHeight - el.transcript.scrollTop
    : 0;
  state.activeId = chatId;
  // The pill and its dirty flag belong to the transcript of the chat we just
  // left — never carry them onto the new one (BUG-047).
  if (chatId !== prevId) {
    state.newContentWhileUnpinned = false;
    hideJumpLatest();
    historyStartIndex = null; // a fresh trailing window for the incoming chat
    resetSessionFind(); // find hits belong to the chat we just left
    renderAttachBar(); // attachments are per-chat too
  }
  // Restore the incoming chat's draft BEFORE any await (grok-desktop
  // syncComposerDraftForSession runs before the select fetch, app.js:5782-5784).
  // The input listener keys drafts off state.activeId, which is already the new
  // chat — leaving the old text in the box during the fetch window would both
  // flash the wrong text and bake anything typed into the NEW chat's draft.
  // Same-chat reselect (turn_done keepScroll) skips the restore so a
  // programmatically-restored value is never clobbered.
  if (chatId !== prevId) {
    el.prompt.value = drafts.get(chatId);
    autoGrow();
  }

  if (!chatId) {
    state.chat = null;
    state.chatConfig = null;
    paintApTitle(el.title, 'Muse Desktop');
    el.cwd.textContent = '';
    rightbar.showChat(null);
    renderTranscript();
    updateRunningChrome();
    updateConfigPills();
    renderPromptQueue();
    return;
  }

  const { chat } = await api(`/api/chats/${encodeURIComponent(chatId)}`);
  state.chat = chat;
  state.chatConfig = chat.config || null; // BUG-074 snapshot feeds the pills
  // Opening a session to look at it never reorders: the queue moves only
  // on conversation activity (a prompt sent, a run settled).
  // Opening a chat makes its group the active one. A real switch expands
  // the incoming group so the session is visible — but a same-chat refetch
  // (turn_done repaint) leaves a deliberate collapse alone.
  if (chat.groupId) {
    state.activeGroupId = chat.groupId;
    if (chatId !== prevId) sidebar.ensureExpanded(chat.groupId);
  }
  paintApTitle(el.title, chat.title);
  el.cwd.textContent = chat.cwd;
  el.cwd.title = chat.cwd;
  setMode(chat.mode);
  setAgentState(chat.live ? chat.status : 'cold');
  updateConfigPills();

  // Rehydrate pending approvals: one may have arrived while this chat was off
  // screen, and it blocks the agent until answered from *somewhere*.
  if (chat.pendingInteractions?.length) {
    const tv = turnView(chatId, true);
    if (!tv.turnId) tv.turnId = chat.turnId || 'pending';
    for (const ix of chat.pendingInteractions) tv.interactions.set(ix.id, ix);
  }

  // Mid-turn switch/reload: seed the live view from the server's snapshot.
  // renderTranscript() below then paints partial text + tool rows + plan, and
  // updateRunningChrome() starts spinner/Stop/elapsed from turn.startedAt.
  if (chat.running) await hydrateTurnView(chatId);
  // The goal outlives the turn — seed the chip from the server's memory so a
  // chat switch shows it without waiting for the next goalChanged.
  if (!wireGoals.has(chatId)) {
    const { goal } = await api(`/api/chats/${encodeURIComponent(chatId)}/goal`)
      .catch(() => ({ goal: null }));
    wireGoals.set(chatId, goal ?? null);
  }
  // Same for context usage — the pill must show the chat's window the
  // moment it opens, not after the next contextUsage triple-change.
  if (!wireCtx.has(chatId)) {
    const snap = await api(`/api/chats/${encodeURIComponent(chatId)}/ctx`)
      .catch(() => ({ ctx: null, tokens: null }));
    wireCtx.set(chatId, { ctx: snap?.ctx ?? null, tokens: snap?.tokens ?? null, baseChars: 0 });
  }
  // Same for the subagent registry — the rail must list the chat's children
  // the moment it opens, not only children born while the page watches.
  if (!wireSubagents.has(chatId)) {
    const { subagents } = await api(`/api/chats/${encodeURIComponent(chatId)}/subagents`)
      .catch(() => ({ subagents: [] }));
    wireSubagents.set(chatId, new Map(
      (Array.isArray(subagents) ? subagents : []).map((s) => [s.itemId, s]),
    ));
  }
  // Point the right rail at the incoming chat: cost inputs, goal/plan state
  // and the SCB re-detect (its title may have gained [APxxxx] since).
  rightbar.showChat(chatId);
  rightbar.showSession(chatId, chat.mspSessionId ?? null);
  rightbar.applyTurn(chatId, liveTurnIdFor(chatId));
  rightbar.applyGoal(chatId, wireGoals.get(chatId) ?? null);
  rightbar.applyPlan(chatId, state.turnViews.get(chatId)?.plan);
  rightbar.applyAgents(chatId, wireSubagents.get(chatId));
  rightbar.applyCtx(chatId, wireCtx.get(chatId)?.tokens ?? null, costModelFor(chatId));

  renderTranscript({ stick: !keepScroll || state.pinned });
  if (keepScroll) {
    // Pinned means the user was following the tail — re-pin to the bottom like
    // grok's settle path (app.js:6912,6929,6949) instead of restoring pixels.
    if (state.pinned) scrollToBottom(true);
    else {
      // An earlier coalesced scroll (live paint before the settle) must not
      // fire after this restore and yank the view to the bottom.
      cancelPendingScroll();
      el.transcript.scrollTop = Math.max(
        0,
        el.transcript.scrollHeight - el.transcript.clientHeight - keepDistBottom,
      );
      // The refetch replaced the transcript under an unpinned reader — that
      // counts as new content, so offer the way back to the tail (BUG-047).
      state.newContentWhileUnpinned = true;
      showJumpLatest();
    }
  }
  updateRunningChrome();
  renderSidebar();
  renderPromptQueue(); // the chip follows the active chat's queue
}

async function newChat({ reuseEmpty = false, groupId = null } = {}) {
  const target = groupId || state.activeGroupId || null;
  const { chat } = await api('/api/chats', {
    method: 'POST',
    body: { reuseEmpty, groupId: target },
  });
  if (chat.groupId) sidebar.ensureExpanded(chat.groupId);
  await refreshChats();
  await selectChat(chat.id);
  el.prompt.focus();
}

async function submitPrompt() {
  const text = el.prompt.value.trim();
  // Attachments ride along even with empty text (grok allows send with
  // attachments alone). Capture under the pre-create key — a fresh chat
  // sends with them and the old key is cleared below.
  const attachId = attachKey();
  const atts = getAttachments(attachId);
  if (!text && !atts.length) return;
  if (!state.activeId) await newChat({ reuseEmpty: true });
  const chatId = state.activeId;

  el.prompt.value = '';
  drafts.clear(chatId);
  autoGrow();
  state.pinned = true;

  // Slash commands run pre-send and never enter the queue (BUG-053;
  // grok-desktop app.js:7264-7269).
  const slash = parseSlashCommand(text);
  if (slash.type !== 'none') {
    await runSlashCommand(chatId, slash, text, atts, attachId);
    return;
  }

  // A turn is running → enqueue and free the composer (grok-desktop
  // app.js:7282-7289). The chip above the composer tracks the queue; the
  // settle of the in-flight turn dispatches the next one.
  if (isRunning(chatId)) {
    promptQueue.enqueue(chatId, text, atts);
    clearAttachments(attachId);
    renderPromptQueue();
    return;
  }
  clearAttachments(attachId);
  await sendPromptText(chatId, text, { attachments: atts });
}

/**
 * Execute a parsed slash command (BUG-053). Modes go through the existing
 * POST /mode flow — the server resolves the agent's advertised mode ids via
 * MspClient.resolveModeId(), so the renderer never hardcodes a wire id.
 * `/plan <text>` sends the remainder as a prompt right after the switch
 * (grok-desktop app.js:1861-1869). An unknown command is never eaten: it goes
 * out as a normal prompt behind a Thai notice.
 */
async function runSlashCommand(chatId, slash, rawText, atts = [], attachId = null) {
  // Pure mode switches keep the attachments for the next real send — only
  // consume them when text actually goes out.
  const consume = () => {
    if (attachId) clearAttachments(attachId);
  };
  if (slash.type === 'unknown') {
    showError(`ไม่รู้จักคำสั่ง ${slash.name} — ส่งเป็นข้อความตามปกติ`);
    if (isRunning(chatId)) {
      promptQueue.enqueue(chatId, rawText, atts);
      consume();
      renderPromptQueue();
    } else {
      consume();
      await sendPromptText(chatId, rawText, { attachments: atts });
    }
    return;
  }
  const current = el.modeChip.dataset.mode || 'always';
  const next = slash.type === 'toggle-always' ? (current === 'always' ? 'normal' : 'always') : slash.mode;
  setMode(next); // optimistic; the server echoes mode_changed
  try {
    await api(`/api/chats/${encodeURIComponent(chatId)}/mode`, {
      method: 'POST',
      body: { mode: next },
    });
  } catch (err) {
    setMode(current); // roll the optimistic chip back on a real failure
    showError(`ตั้งโหมดไม่สำเร็จ: ${err.message}`);
    return;
  }
  if (slash.type === 'mode' && slash.rest) {
    if (isRunning(chatId)) {
      promptQueue.enqueue(chatId, slash.rest, atts);
      consume();
      renderPromptQueue();
    } else {
      consume();
      await sendPromptText(chatId, slash.rest, { attachments: atts });
    }
  }
}

/**
 * The one POST /prompt funnel. The 202 paints nothing itself — every visible
 * change arrives over SSE (the non-negotiable). A 409 TURN_IN_FLIGHT race
 * (the server still has a turn the local view already forgot) never loses
 * text: the prompt goes back to the FRONT of the chat's queue and the next
 * settle retries it in order (grok-desktop prompt-queue.js:119-139).
 */
async function sendPromptText(chatId, text, { queueItem = null, attachments = [] } = {}) {
  const atts = queueItem?.attachments?.length ? queueItem.attachments : attachments;
  try {
    await api(`/api/chats/${encodeURIComponent(chatId)}/prompt`, {
      method: 'POST',
      body: { text, ...(atts?.length ? { attachments: toWireAttachments(atts) } : {}) },
    });
  } catch (err) {
    if (err.status === 409) {
      promptQueue.requeueFront(chatId, queueItem || { text, attachments: atts });
      if (chatId === state.activeId) renderPromptQueue();
      return;
    }
    if (queueItem) {
      // A queued send that failed for real: keep the text rather than drop it.
      promptQueue.requeueFront(chatId, queueItem);
      if (chatId === state.activeId) renderPromptQueue();
    } else {
      // Direct submit: hand the text AND attachments back — silently eating
      // a prompt is worse than an error.
      el.prompt.value = text;
      if (atts?.length) addAttachments(atts, chatId);
      autoGrow();
    }
    showError(err.message);
  }
}

// --------------------------------------------------------- prompt queue

/**
 * Quiet chip above the composer: "⏳ รอส่ง N ข้อความ" — click expands the
 * per-item list with ✕ remove (grok-desktop renderPromptQueue,
 * app.js:6997-7050).
 */
function renderPromptQueue() {
  const items = state.activeId ? promptQueue.list(state.activeId) : [];
  const n = items.length;
  if (!n) {
    el.promptQueue.hidden = true;
    el.promptQueue.classList.remove('is-expanded');
    el.promptQueueChip.textContent = '⏳ รอส่ง 0 ข้อความ';
    el.promptQueueList.hidden = true;
    el.promptQueueList.replaceChildren();
    return;
  }
  el.promptQueue.hidden = false;
  el.promptQueueChip.textContent = `⏳ รอส่ง ${n} ข้อความ`;
  el.promptQueueChip.setAttribute('aria-label', `รอส่ง ${n} ข้อความในคิว — คลิกเพื่อดูรายการ`);
  if (!el.promptQueue.classList.contains('is-expanded')) {
    el.promptQueueList.hidden = true;
    return;
  }
  el.promptQueueList.hidden = false;
  el.promptQueueList.replaceChildren();
  items.forEach((item, idx) => {
    const li = document.createElement('li');
    li.className = 'prompt-queue-item';
    const preview = document.createElement('span');
    preview.className = 'prompt-queue-preview';
    const t = item.text.replace(/\s+/g, ' ').trim();
    const attBit = item.attachments?.length ? `📎${item.attachments.length} ` : '';
    preview.textContent = attBit + (t.length > 72 ? `${t.slice(0, 72)}…` : t);
    preview.title = item.text;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'prompt-queue-remove';
    rm.textContent = '✕';
    rm.title = 'ลบออกจากคิว';
    rm.setAttribute('aria-label', `ลบข้อความคิวลำดับ ${idx + 1}`);
    rm.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!state.activeId) return;
      promptQueue.removeAt(state.activeId, idx);
      renderPromptQueue();
    });
    li.append(preview, rm);
    el.promptQueueList.append(li);
  });
}

/**
 * After a settle: dispatch the chat's next queued prompt. Deferred to a
 * macrotask (setTimeout 0), NOT a microtask — the terminal paint must complete
 * before a new turn can clobber it (grok-desktop R14b, app.js:7052-7065).
 * Callers invoke this only after the turn_done/turn_error paint path.
 */
function scheduleQueueDispatch(chatId) {
  if (!chatId) return;
  setTimeout(() => {
    void maybeDispatchQueue(chatId);
  }, 0);
}

async function maybeDispatchQueue(chatId) {
  if (!chatId || queueDispatching.has(chatId)) return;
  // muse's per-chat view has no phase field — a bound turnId IS the open phase.
  const phase = isRunning(chatId) ? 'running' : 'idle';
  if (!shouldDispatch(phase, promptQueue.length(chatId))) return;
  const item = promptQueue.dequeue(chatId);
  if (!item) return;
  if (chatId === state.activeId) renderPromptQueue();
  queueDispatching.add(chatId);
  try {
    // sendPromptText prefers queueItem.attachments — queued files ride along.
    await sendPromptText(chatId, item.text, { queueItem: item });
  } finally {
    queueDispatching.delete(chatId);
  }
}

function showError(message) {
  const div = document.createElement('div');
  div.className = 'msg-notice';
  div.textContent = message;
  el.transcript.append(div);
  scrollToBottom(true);
}

async function stopTurn() {
  const chatId = state.activeId;
  if (!chatId) return;
  const tv = state.turnViews.get(chatId);
  if (tv?.cancelling) return; // double-Esc must not double-cancel
  if (tv) {
    tv.cancelling = true;
    updateRunningChrome();
  }
  const res = await api(`/api/chats/${encodeURIComponent(chatId)}/cancel`, { method: 'POST' }).catch(
    () => null,
  );
  // The flag clears on settle (the terminal event drops the whole view,
  // including for non-active chats). Only a cancel that never reached the
  // host needs a manual reset — the turn is still running.
  if (!res && tv && state.turnViews.get(chatId) === tv) {
    tv.cancelling = false;
    updateRunningChrome();
  }
}

/**
 * ESC-to-stop: ask first, stop only on "หยุด". Anchored to the Stop-morphed
 * send button so the question sits on the control it talks about (the same
 * miniConfirm the sidebar uses for deletes). The popover's own capture-phase
 * ESC dismiss wins over the global binding below, so ESC ESC cancels the
 * ask instead of stopping — and anything but an explicit "หยุด" (outside
 * click, second ESC) resolves false and the turn keeps running. The
 * confirmedStopProceeds guard drops a stale yes: a turn that settled, or a
 * chat switched, behind the open popover must not be stopped.
 */
async function confirmStopTurn() {
  const chatId = state.activeId;
  if (!chatId) return;
  const ok = await miniConfirm(el.send, 'หยุดเทิร์นนี้ใช่หรือไม่?', { okLabel: 'หยุด', cancelLabel: 'ทำต่อ' });
  if (!ok) return;
  if (!confirmedStopProceeds({ escChatId: chatId, activeChatId: state.activeId, running: isRunning(chatId) })) return;
  await stopTurn();
}

async function cycleMode() {
  if (!state.activeId) return;
  const current = el.modeChip.dataset.mode || 'always';
  const next = MODE_CYCLE[(MODE_CYCLE.indexOf(current) + 1) % MODE_CYCLE.length];
  setMode(next); // optimistic; server echoes mode_changed
  await api(`/api/chats/${encodeURIComponent(state.activeId)}/mode`, {
    method: 'POST',
    body: { mode: next },
  }).catch(() => {});
}

async function refreshAgentBadge() {
  try {
    const { agent, auth } = await api('/api/agent');
    state.agent = agent;
    if (agent?.ok) {
      el.agentBadge.classList.remove('bad');
      el.agentBadge.textContent = `Muse ${agent.version || ''}`.trim();
    } else {
      el.agentBadge.classList.add('bad');
      el.agentBadge.textContent = agent?.error === 'muse not found' ? 'ไม่พบคำสั่ง muse' : 'muse ใช้ไม่ได้';
    }
    if (auth?.command) state.authCommand = auth.command;
  } catch {
    el.agentBadge.textContent = 'host?';
  }
}

// version-boot.js already painted once; this re-fetches after boot so the
// badge tracks the host actually serving (grok-desktop applyVersionBadge,
// app.js:1027-1105). On failure only mark the badge missing when the early
// paint never landed a real version.
async function refreshVersionBadge() {
  const badge = el.versionBadge;
  if (!badge) return;
  try {
    const res = await fetch('/api/version', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const j = await res.json();
    if (!j.version) throw new Error('no version');
    badge.textContent = `v${j.version}`;
    badge.title = `${j.name || 'Muse Desktop'} v${j.version}`;
    badge.classList.remove('is-missing', 'is-loading');
  } catch {
    if (badge.classList.contains('is-loading') || /^[…?]$/.test(badge.textContent)) {
      badge.textContent = '?';
      badge.title = 'host unreachable';
      badge.classList.add('is-missing');
      badge.classList.remove('is-loading');
    }
  }
}

// --------------------------------------------------------------- themes

// `theme-boot.js` already applied the saved theme before first paint; reuse
// its resolver so the switcher and the boot path can never disagree.
const THEME_BOOT = window.__museTheme;
const THEME_OPTIONS = [
  { pref: 'moonlight', label: 'Moonlight', icon: '☾' },
  { pref: 'claude-dark', label: 'Claude Dark', icon: '🌘' },
  { pref: 'claude-light', label: 'Claude Light', icon: '☕' },
  { pref: 'daylight', label: 'Daylight', icon: '☀' },
  { pref: 'auto', label: 'Auto (ตามระบบ)', icon: '◐' },
];

function currentThemePref() {
  const pref = document.documentElement.dataset.themePref;
  return THEME_BOOT?.normalize ? THEME_BOOT.normalize(pref) : pref || 'auto';
}

let themeTransitionTimer = null;

function applyTheme(pref) {
  // Normalize first so dataset/localStorage only ever hold a valid pref —
  // anything missing or unknown becomes Auto, same rule as the boot path.
  const p = THEME_BOOT?.normalize ? THEME_BOOT.normalize(pref) : pref || 'auto';
  const resolved = THEME_BOOT?.resolve
    ? THEME_BOOT.resolve(p)
    : p === 'auto'
      ? 'moonlight'
      : p;
  const root = document.documentElement;
  // Crossfade instead of a hard cut: the class turns on a short colour
  // transition (style.css, --duration-theme 250ms) for the flip, then comes
  // back off. Under prefers-reduced-motion the media query forces
  // transition: none, so this is a no-op there.
  root.classList.add('theme-switching');
  if (themeTransitionTimer !== null) clearTimeout(themeTransitionTimer);
  themeTransitionTimer = setTimeout(() => {
    root.classList.remove('theme-switching');
    themeTransitionTimer = null;
  }, 280);
  root.dataset.theme = resolved;
  root.dataset.themePref = p;
  // Re-tint settled diagrams from stashed source (no-op before first paint).
  void applyMermaidTheme(resolved);
  try {
    localStorage.setItem(THEME_BOOT?.STORAGE_KEY || 'muse-desktop.theme', p);
  } catch {
    /* private mode — the theme just will not persist */
  }
}

function openThemeMenu(anchor) {
  const active = currentThemePref();
  closePopover();
  openMenu(
    anchor,
    THEME_OPTIONS.map((opt) => ({
      label: opt.pref === active ? `${opt.label} ✓` : opt.label,
      icon: opt.icon,
      action: () => applyTheme(opt.pref),
    })),
  );
}

// Only follow the system while the preference *is* Auto — otherwise an
// explicit choice would be silently overridden the next time macOS flips.
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if (currentThemePref() === 'auto') applyTheme('auto');
});

// ------------------------------------------------------------------ ui

/** Mirror the value into the grid wrapper; CSS does the sizing. */
function autoGrow() {
  el.grow.dataset.value = el.prompt.value;
}

function wireUi() {
  wireSessionSearch();
  wireSessionFind();
  wireAttach();
  el.composer.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (isRunning(state.activeId)) void stopTurn();
    else void submitPrompt();
  });

  el.prompt.addEventListener('input', () => {
    autoGrow();
    if (state.activeId) drafts.set(state.activeId, el.prompt.value);
  });

  // Typing is the strongest "about to prompt" signal there is — warm a cold
  // agent while the user types so the ~20s of background MCP connects after
  // session/start usually finish before Send. Fire-and-forget; the server
  // single-flights with a racing first prompt.
  el.prompt.addEventListener('focus', () => {
    const id = state.activeId;
    if (!id || warmedChats.has(id)) return;
    warmedChats.add(id);
    void api(`/api/chats/${encodeURIComponent(id)}/agent`, {
      method: 'POST',
      body: { warm: true },
    }).catch(() => {
      warmedChats.delete(id);
    });
  });

  el.prompt.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.metaKey) {
      ev.preventDefault();
      // Enter during a turn ENQUEUES (BUG-051) — the composer is never a dead
      // key. The send button stays the Stop morph while running.
      void submitPrompt();
      return;
    }
    if (ev.key === 'Tab' && ev.shiftKey) {
      ev.preventDefault();
      void cycleMode();
    }
  });

  document.addEventListener('keydown', (ev) => {
    // Interaction-card shortcuts (BUG-030): 1..9 picks an option, Esc rejects
    // — scoped to the active chat's unanswered card, and never while any
    // input/textarea (composer, sidebar renames) is focused.
    const tv = state.activeId ? state.turnViews.get(state.activeId) : null;
    const openIx = tv ? [...tv.interactions.values()].find((ix) => !ix.resolved) : null;
    const typingTag = (document.activeElement?.tagName || '').toLowerCase();
    if (openIx && typingTag !== 'textarea' && typingTag !== 'input' && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      const optionId = ixKeyToOptionId(openIx.options?.length ? openIx.options : DEFAULT_IX_OPTIONS, ev.key);
      if (optionId) {
        const card = liveChildren.get(`ix:${openIx.id}`);
        const btn = card
          ? [...card.querySelectorAll('.ix-actions button')].find((b) => b.dataset.optionId === optionId)
          : null;
        if (btn) {
          ev.preventDefault();
          btn.click(); // same path as a mouse click — one submit funnel
          return;
        }
      }
    }
    if (escStopAction({ key: ev.key, running: isRunning(state.activeId) }) === 'confirm') {
      ev.preventDefault();
      void confirmStopTurn();
      return;
    }
    // New chat: Cmd+N on mac, Ctrl+N on Linux (the GTK shell has no browser
    // chrome, so Ctrl+N is free there; same dual binding as find-in-chat).
    if (ev.key.toLowerCase() === 'n' && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      if (ev.shiftKey) sidebar.actions.createGroup(`Group ${state.groups.length + 1}`);
      else void newChat();
    }
  });

  el.transcript.addEventListener(
    'scroll',
    () => {
      // A bare scroll event must never UNPIN (content growing under a pinned
      // reader fires scroll events too); it only re-pins at the bottom. The
      // unpin gestures are wheel-up / touch-pan-up below (grok-desktop
      // wireChatScroll, app.js:1985-2043).
      const decision = computePin({
        pinned: state.pinned,
        nearBottom: nearBottom(),
        userScrolled: false,
        newContent: state.newContentWhileUnpinned,
      });
      state.pinned = decision.pinned;
      if (state.pinned) {
        state.newContentWhileUnpinned = false;
        hideJumpLatest();
      } else if (state.newContentWhileUnpinned) {
        showJumpLatest();
      }
    },
    { passive: true },
  );

  // Wheel-up unpins immediately — even a sub-threshold nudge must stop the
  // next delta from yanking the view back down (BUG-045; grok-desktop
  // app.js:2006-2022).
  el.transcript.addEventListener(
    'wheel',
    (ev) => {
      if (ev.deltaY >= 0) return;
      const decision = computePin({
        pinned: state.pinned,
        nearBottom: false,
        userScrolled: true,
        newContent: state.newContentWhileUnpinned,
      });
      state.pinned = decision.pinned;
      if (decision.showJump) showJumpLatest();
    },
    { passive: true },
  );

  // Touch: the first upward pan unpins (grok-desktop app.js:2023-2043).
  let touchY0 = null;
  el.transcript.addEventListener(
    'touchstart',
    (ev) => {
      touchY0 = ev.touches?.[0]?.clientY ?? null;
    },
    { passive: true },
  );
  el.transcript.addEventListener(
    'touchmove',
    (ev) => {
      if (touchY0 == null) return;
      const y = ev.touches?.[0]?.clientY;
      if (y != null && y > touchY0 + 8) {
        state.pinned = false;
        touchY0 = null;
      }
    },
    { passive: true },
  );

  // The jump pill re-pins and lands on the live tail (grok-desktop
  // rePinChatToBottom, app.js:1930-1936).
  el.jumpLatest.addEventListener('click', () => {
    state.pinned = true;
    state.newContentWhileUnpinned = false;
    hideJumpLatest();
    scrollToBottom(true);
  });

  el.promptQueueChip.addEventListener('click', () => {
    el.promptQueue.classList.toggle('is-expanded');
    renderPromptQueue();
  });

  el.newChat.addEventListener('click', () => void newChat());
  el.newGroup.addEventListener('click', () => {
    closePopover();
    sidebar.draftOpen = true;
    sidebar.draftAt = 'top';
    sidebar.draftValue = sidebar.draftValue || `Group ${state.groups.length + 1}`;
    renderSidebar();
  });
  el.modeChip.addEventListener('click', () => void cycleMode());

  el.modelChip.addEventListener('click', () => openConfigMenu('model', el.modelChip));
  el.effortChip.addEventListener('click', () => openConfigMenu('thinking', el.effortChip));

  el.mcpBtn?.addEventListener('click', () => mcpPanel.open(el.mcpBtn));
  // Head-bar chips open the right rail at their section (the old floating
  // popovers are gone — one rail instead of stacked popups).
  el.agentsChip.addEventListener('click', () => rightbar.reveal('agents'));
  el.tasksChip.addEventListener('click', () => rightbar.reveal('tasks'));
  el.goalChip.addEventListener('click', () => rightbar.reveal('goal'));
  if (el.overviewBtn) el.overviewBtn.addEventListener('click', openThreadOverview);
  if (el.goalBarBtn) el.goalBarBtn.addEventListener('click', sendGoalBarCommand);
  el.rightbarToggle?.addEventListener('click', () => rightbar.toggle());

  el.releaseAgent.addEventListener('click', async () => {
    if (!state.activeId) return;
    await api(`/api/chats/${encodeURIComponent(state.activeId)}/agent`, { method: 'DELETE' }).catch(() => {});
  });

  el.cwd.addEventListener('click', async () => {
    if (!state.chat) return;
    const next = prompt('working directory ของแชทนี้', state.chat.cwd);
    if (!next || next === state.chat.cwd) return;
    await api(`/api/chats/${encodeURIComponent(state.chat.id)}`, {
      method: 'PATCH',
      body: { cwd: next },
    });
    // cwd is fixed at spawn time — drop the agent so the next turn honours it.
    await api(`/api/chats/${encodeURIComponent(state.chat.id)}/agent`, { method: 'DELETE' }).catch(() => {});
    await selectChat(state.chat.id);
  });

  el.themeToggle.addEventListener('click', () => openThemeMenu(el.themeToggle));

  el.authLogin.addEventListener('click', async () => {
    const res = await api('/api/auth/login', { method: 'POST' }).catch(() => null);
    if (res && res.manual) alert(`รันคำสั่งนี้ในเทอร์มินัล:\n\n${res.command}`);
  });

  el.authRetry.addEventListener('click', async () => {
    if (!state.activeId) return;
    try {
      await api(`/api/chats/${encodeURIComponent(state.activeId)}/agent`, { method: 'POST' });
      hideAuthGate();
    } catch (err) {
      showAuthGate(state.authCommand);
    }
  });
}

// ---------------------------------------------------------------- boot

async function boot() {
  // Theme is already on <html> — theme-boot.js runs before the stylesheets.
  // Sidebar width first: restoring the stored width before first paint
  // avoids a visible snap from the stylesheet default.
  initSidebarResize();
  initRightbarResize();
  wireUi();
  // Ask once for Web Notification permission (browser path for agent
  // questions; the macOS host banner via /api/notify needs no permission).
  try {
    if ('Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission().catch(() => {});
    }
  } catch {
    // ignore — the transcript card + host banner still alert
  }
  installCodeCopyDelegation();
  installDiagramDownloadDelegation();
  connectStream();
  await refreshAgentBadge();
  void refreshVersionBadge();
  // MCP head button: catalog counts only (no probe — spawning 27 servers at
  // boot would be rude). The first panel open probes on demand.
  void api('/api/mcp/servers').then((snap) => mcpPanel.applySnapshot(snap)).catch(() => {});
  // Subscription pill: fetch at boot, then every 5 minutes (silent window
  // resets), plus after every turn and on the `usage` broadcast.
  void refreshUsage();
  setInterval(() => void refreshUsage(), 5 * 60_000);
  await refreshChats();

  // Any approval still waiting from a previous UI session blocks its agent.
  const { interactions } = await api('/api/interactions').catch(() => ({ interactions: [] }));
  for (const ix of interactions || []) {
    const tv = turnView(ix.chatId, true);
    if (!tv.turnId) tv.turnId = 'pending';
    tv.interactions.set(ix.id, ix);
  }

  await selectChat(state.chats[0]?.id ?? null);
  if (!state.chats.length) await newChat({ reuseEmpty: true });
  el.prompt.focus();
}

// A boot that throws (host hiccup mid-refreshChats, etc.) must still surface
// the error — a half-initialised UI with zero message reads as "the app is
// frozen" (grok-desktop app.js:9305-9307).
boot().catch((err) => showError(err?.message || String(err)));
