// Per-chat live-turn view state — the renderer's half of the turn pipeline.
//
// Pure functions only (no DOM, no timers) so the turn logic is unit-testable
// in Node; app.js wires these to the real elements. Mirrors grok-desktop's
// turn-view.js in spirit, leaner: one record per chat, keyed by turnId.

/** Fresh per-chat turn record. One per chat — never a global "current turn". */
export function createTurnView() {
  return {
    turnId: null,
    text: '',
    tools: new Map(),
    plan: null,
    interactions: new Map(),
    /** Bumped on every structural event (tool/plan/card) — the live paint
     * skips its DOM-diff section while the stamp is unchanged, so pure text
     * deltas cost a markdown schedule + scroll and nothing else. */
    rev: 0,
    /** tool ids the user collapsed/expanded by hand this turn — a manual
     * toggle beats auto-expand for the rest of the turn (BUG-033). */
    userToggledTools: new Set(),
    startedAt: 0,
    cancelling: false,
    /** a thought_delta arrived this turn — drives the กำลังคิด… status verb
     * without ever painting the reasoning text itself (BUG-072). */
    thoughtSeen: false,
    /** first turn on a just-booted agent — the status verb says "preparing
     * tools" until the first activity lands (MCP connects are still running). */
    warming: false,
  };
}

/**
 * Accept a turn-scoped SSE event into the chat's view, binding the turnId it
 * carries when the view has none yet. A window that missed `turn_started`
 * (reload, second window, ring eviction) must still open the turn on the
 * first scoped event — otherwise nothing paints until `turn_done`
 * (grok-desktop turn-view.js:179-184 `maybeBindTurnId`, and a first delta can
 * even open the turn there, turn-view.js:672-691).
 *
 * @returns {'open'|'ok'|'drop'} 'open' when this event opened the turn
 *   locally (chrome must refresh); 'drop' for a late frame from a superseded
 *   turn, which must never touch the view that replaced it.
 */
export function bindTurnId(tv, data) {
  const tid = data?.turnId != null ? String(data.turnId) : null;
  if (!tid) return 'ok'; // unscoped event — nothing to check
  // 'pending' is the placeholder a rehydrated permission card sets when its
  // turn_started was missed; the first scoped event upgrades it to the real id.
  if (!tv.turnId || tv.turnId === 'pending') {
    tv.turnId = tid;
    if (!tv.startedAt) tv.startedAt = Date.now();
    return 'open';
  }
  return tv.turnId === tid ? 'ok' : 'drop';
}

/**
 * Quiet transcript marker for a turn that ended by interruption rather than
 * by the agent finishing. The watchdog gets a distinct label so users do not
 * think they pressed Stop themselves (grok-desktop
 * transcript-model.js:168-176 `interruptedMarkerText`).
 */
export function interruptedMarkerText(reason) {
  if (reason === 'watchdog') return '⚠︎ ระบบหยุดให้ (เงียบเกินเพดาน watchdog)';
  return '⏹ หยุดโดยผู้ใช้';
}

/**
 * Desired DOM order of the live turn's children: agent rows (pinned above
 * plain tools, grok-desktop upsertLiveTool inserts them before the first
 * non-agent row — app.js:2890-2896; BUG-076) → plain tool rows → plan card →
 * streaming answer → permission cards. Arrival order is kept WITHIN each
 * tool group; the settled transcript keeps pure arrival order
 * (messageChildOrder) like grok's history restore. The answer is pinned
 * bottommost of the produced content (grok-desktop `pinLiveLayout`,
 * app.js:2132-2176 — "answer always bottommost"); permission cards stay last
 * so they remain reachable while the answer grows above them.
 */
export function liveChildOrder(tv) {
  const keys = [];
  const agents = [];
  const plain = [];
  for (const tool of tv.tools?.values?.() || []) {
    (isAgentTool(tool) ? agents : plain).push(`tool:${tool.id}`);
  }
  keys.push(...agents, ...plain);
  if (tv.plan) keys.push('plan');
  if (tv.text) keys.push('text');
  for (const id of tv.interactions?.keys?.() || []) keys.push(`ix:${id}`);
  return keys;
}

/**
 * Coalesce live markdown paints to at most one per `minMs` (trailing timer),
 * with a synchronous force-flush for turn end and rebuilds. A per-delta full
 * re-parse + DOM rewrite was CPU churn, highlight flicker, scroll jank and
 * impossible text selection (grok-desktop `scheduleLiveMarkdownPaint`,
 * app.js:3233-3247 with LIVE_MD_MIN_MS=32). `paints` is exposed for tests.
 */
export function createLivePaintScheduler(paint, { minMs = 48 } = {}) {
  let timer = null;
  let paints = 0;
  const fire = () => {
    timer = null;
    paints++;
    paint();
  };
  return {
    schedule() {
      if (timer) return;
      timer = setTimeout(fire, minMs);
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      paints++;
      paint();
    },
    get paints() {
      return paints;
    },
  };
}

/**
 * Merge the server's open-turn snapshot (`GET /api/chats/:id/turn`) into the
 * local view after a reload / resync / chat switch (grok-desktop
 * `resyncSessionTurn` → `turnStore.reset`, app.js:6682-6711).
 *
 *  - A different live turnId means the local view is stale — the server wins
 *    outright; its snapshot replaces text/tools/plan/interactions.
 *  - Same/empty id: fill only what is missing or older. `partial` is the
 *    server's running total, so a shorter snapshot than the local text is
 *    stale and must never regress what SSE already painted.
 */
export function seedTurnView(tv, snapshot) {
  if (!snapshot?.turnId) return tv;
  if (tv.turnId && tv.turnId !== 'pending' && tv.turnId !== snapshot.turnId) {
    tv.text = '';
    tv.tools = new Map();
    tv.plan = null;
    tv.interactions = new Map();
    tv.startedAt = 0;
    tv.turnId = snapshot.turnId;
  }
  if (!tv.turnId || tv.turnId === 'pending') tv.turnId = snapshot.turnId;
  if (!tv.startedAt) tv.startedAt = snapshot.startedAt || 0;
  if ((snapshot.partial || '').length > tv.text.length) tv.text = snapshot.partial;
  for (const tool of snapshot.tools || []) {
    if (!tv.tools.has(tool.id)) tv.tools.set(tool.id, tool);
  }
  if (!tv.plan && snapshot.plan) tv.plan = snapshot.plan;
  for (const ix of snapshot.pendingInteractions || []) {
    if (!tv.interactions.has(ix.id)) tv.interactions.set(ix.id, ix);
  }
  // A merge may have added rows behind the paint's back — force the next
  // paint structural even when the caller forgets rebuild.
  tv.rev = (tv.rev || 0) + 1;
  return tv;
}

/**
 * Error line a failed answer-submit paints inside the interaction card. Fixed
 * Thai text on purpose: the raw HTTP error (404, network down) tells the user
 * nothing actionable — the only recovery that matters is "try again".
 */
export const IX_SUBMIT_ERROR_TEXT = 'ส่งคำตอบไม่สำเร็จ — ลองอีกครั้ง';

/**
 * Submit-state reducer for an interaction card (grok-desktop
 * interaction-lifecycle.js:100-119 — submit_start / submit_ok / submit_fail).
 * The click path disables every button up front; a failed resolve MUST hand
 * the card back (submitting:false + an error line) or the card sits dead
 * while the agent stays blocked on the permission reply (BUG-025).
 */
export function ixSubmitTransition(cur, phase) {
  if (phase === 'start') return { submitting: true, error: null };
  if (phase === 'ok') return { submitting: false, error: null };
  if (phase === 'fail') return { submitting: false, error: IX_SUBMIT_ERROR_TEXT };
  return cur;
}

/**
 * Human label for a tool row's protocol status — the wire strings
 * (`in_progress`, …) must never reach the Thai UI verbatim (grok-desktop
 * app.js:2916-2923 maps to Pending/Running/Done/Stopped/Failed).
 * Unknown statuses pass through so a new agent state is never blank.
 */
export function toolStatusLabel(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'pending') return 'รอดำเนินการ';
  if (s === 'in_progress' || s === 'running') return 'กำลังทำงาน';
  if (s === 'completed') return 'เสร็จแล้ว';
  if (s === 'failed') return 'ล้มเหลว';
  if (s === 'cancelled') return 'ถูกยกเลิก';
  return String(status || '');
}

/**
 * The one option that gets primary styling on an interaction card
 * (grok-desktop app.js:8196-8198 paints exactly one primary per card).
 * `allow_always` when the card offers it, else the first allow-kind option;
 * reject/skip-kind options are never primary. The kind comes through
 * extractPermissionOptions server-side; optionId spellings stay as fallback
 * for older agents and the no-options default list.
 */
export function ixPrimaryOptionId(options = []) {
  const isReject = (o) =>
    /reject/i.test(String(o?.kind || '')) || /reject|deny|skip/i.test(String(o?.optionId || ''));
  const allows = (Array.isArray(options) ? options : []).filter((o) => o && !isReject(o));
  if (!allows.length) return null;
  const always = allows.find(
    (o) =>
      String(o.kind || '') === 'allow_always' ||
      /allow[-_]?always|approve[-_]?always/i.test(String(o.optionId)),
  );
  return (always || allows[0]).optionId;
}

/**
 * Live-child key of the tool row an interaction card belongs to, or null when
 * the row is not in this turn's view (e.g. a card rehydrated after reload
 * while its tool only exists in history) — the caller then keeps the
 * liveChildOrder() end position (grok-desktop findIxMountPoint,
 * app.js:7975-7998: after the tool row when known, else end of turn).
 */
export function ixAnchorKey(tv, ix) {
  const id = ix?.toolCallId;
  if (id == null || id === '') return null;
  return tv.tools?.has?.(id) ? `tool:${id}` : null;
}

/**
 * Keyboard map for a mounted interaction card (grok-desktop app.js:8867-8908:
 * number keys pick an option, Esc rejects). '1'..'9' select by position;
 * Escape picks the reject/skip-kind option. Returns null for unmapped keys —
 * and for Escape when the card has no reject option, so the global
 * stop-the-turn binding is not swallowed by a card that offers no way out.
 */
export function ixKeyToOptionId(options, key) {
  const opts = Array.isArray(options) ? options : [];
  if (/^[1-9]$/.test(key)) {
    return opts[Number(key) - 1]?.optionId ?? null;
  }
  if (key === 'Escape') {
    const isReject = (o) =>
      /reject/i.test(String(o?.kind || '')) || /reject|deny|skip/i.test(String(o?.optionId || ''));
    return opts.find((o) => o && isReject(o))?.optionId ?? null;
  }
  return null;
}

/**
 * Child order for a persisted assistant message — must mirror
 * liveChildOrder() (tools → plan → answer, marker last). After turn_done the
 * transcript reloads from disk; if history rendered plan → tools → text while
 * the live paint showed tools → plan → text, the plan visibly jumps on every
 * settle (BUG-031). grok-desktop uses activity → plan → assistant in both
 * paths for the same reason.
 */
export function messageChildOrder(msg) {
  if (msg?.role === 'user') return ['user'];
  if (msg?.role === 'notice') return ['notice'];
  const keys = [];
  if (msg?.meta?.toolCalls?.length) keys.push('tools');
  if (msg?.meta?.plan?.length) keys.push('plan');
  keys.push('text');
  if (msg?.meta?.reason === 'cancelled' || msg?.meta?.reason === 'watchdog') keys.push('marker');
  return keys;
}

/**
 * Whether a live tool row should auto-expand while streaming (grok-desktop
 * paintToolOutput, app.js:3533-3545: bash/execute/running rows open so the
 * output is visible). A row the user toggled by hand this turn is left alone
 * either way — auto-expand must never fight the user (BUG-033).
 */
export function shouldAutoExpandTool(tv, tool) {
  const id = tool?.id;
  if (id != null && tv?.userToggledTools?.has?.(id)) return false;
  if (/^(in_progress|running)$/i.test(String(tool?.status || ''))) return true;
  return /execute|bash|shell|command/i.test(String(tool?.kind || ''));
}

/**
 * Subagent tool detection. muse-serve exposes subagents through the Agent /
 * AgentSwarm tools: `kind` stays 'other' and the title is the free-text task
 * description, so the rawInput payload is the only reliable signal. rawInput
 * may be null on an early lazy-created call — degrade to "plain tool".
 * (Exported for the renderer's agent-row styling, BUG-076.)
 */
export function isAgentTool(tool) {
  const raw = tool?.rawInput;
  return !!(raw && (raw.subagent_type || raw.prompt_template));
}

/**
 * Display facts about an agent-type tool row (BUG-076), or null for a plain
 * tool: the subagent type (or a swarm), the swarm's fan-out (fresh items +
 * resumed agent ids), and whether it was launched in the background
 * (rawInput.run_in_background).
 */
export function agentToolMeta(tool) {
  const raw = tool?.rawInput;
  if (!raw || (!raw.subagent_type && !raw.prompt_template)) return null;
  const background = raw.run_in_background === true;
  if (raw.prompt_template) {
    const items = Array.isArray(raw.items) ? raw.items.length : 0;
    const resumed =
      raw.resume_agent_ids && typeof raw.resume_agent_ids === 'object'
        ? Object.keys(raw.resume_agent_ids).length
        : 0;
    return { swarm: true, type: 'swarm', count: items + resumed, background };
  }
  return { swarm: false, type: String(raw.subagent_type || 'agent'), count: 1, background };
}

/**
 * Subtitle under an agent row's title (BUG-076): the subagent type, or
 * `swarm · n ตัว` when the fan-out is known.
 */
export function agentSubtitle(tool) {
  const meta = agentToolMeta(tool);
  if (!meta) return '';
  if (meta.swarm) return meta.count > 0 ? `swarm · ${meta.count} ตัว` : 'swarm';
  return meta.type;
}

/**
 * Display-only state for a tool row (BUG-076). A background Agent's
 * tool_call completes as soon as the task is parked while the agent itself
 * keeps running (grok-desktop sessions.js:5030-5038) — the row must not read
 * "เสร็จแล้ว". Presentation ONLY: the wire status is never rewritten, so
 * resolveStatusVerb/isRunning never see this state (a background agent does
 * not block the turn).
 */
export function toolDisplayState(tool) {
  const s = String(tool?.status || '').toLowerCase();
  if (s === 'failed' || s === 'cancelled') return 'failed';
  if (s === 'completed') return agentToolMeta(tool)?.background ? 'background' : 'done';
  if (s === 'pending') return 'pending';
  return 'running'; // in_progress | running | anything else still open
}

/**
 * Agent counts of one turn for the head-bar chip (BUG-077; grok-desktop
 * setAgentsPill/renderAgentsChip, app.js:1383-1411). Every agent-type tool
 * row counts once — a swarm is one row however many items it fans out to.
 * "running" follows the wire status (pending|in_progress|running); a
 * completed BACKGROUND agent (BUG-076 display state 'background') is
 * excluded — the chip pulses for work the turn waits on, and background work
 * blocks nothing.
 */
export function agentCounts(tv) {
  let running = 0;
  let total = 0;
  for (const tool of tv?.tools?.values?.() || []) {
    if (!isAgentTool(tool)) continue;
    total += 1;
    const ds = toolDisplayState(tool);
    if (ds === 'pending' || ds === 'running') running += 1;
  }
  return { running, total };
}

/**
 * Kind-aware Thai verb for one running tool (grok-desktop `formatToolVerb`,
 * transcript-model.js:812-837, re-keyed to the MSP wire kinds). A title that
 * already reads like a verb phrase (กำลัง…, or an English -ing word) is used
 * as-is — prefixing it again would read "กำลังอ่าน Reading …".
 */
function formatToolVerb(tool) {
  const kind = String(tool?.kind || '').toLowerCase();
  const title = String(tool?.title || '').replace(/\s+/g, ' ').trim();
  const short = title.slice(0, 48) || kind || 'tool';
  if (title && (/^กำลัง/.test(title) || /^[a-z]+ing\b/i.test(title))) {
    return title.endsWith('…') ? title : `${title}…`;
  }
  switch (kind) {
    case 'read':
      return title ? `กำลังอ่าน ${short}…` : 'กำลังอ่าน…';
    case 'edit':
      return title ? `กำลังแก้ไข ${short}…` : 'กำลังแก้ไข…';
    case 'execute':
      return title ? `กำลังรัน ${short}…` : 'กำลังรันคำสั่ง…';
    case 'fetch':
      return title ? `กำลังค้นหา ${short}…` : 'กำลังค้นหา…';
    case 'think':
      return 'กำลังคิด…';
    default:
      return title ? `กำลังใช้ ${short}…` : 'กำลังใช้เครื่องมือ…';
  }
}

/**
 * Status-line verb for a running turn — a lean port of grok-desktop's
 * `resolveStatusVerb` (transcript-model.js:730-806) over the MSP view shape.
 * Priority (top wins): unanswered interaction (subtype-aware) → in-progress
 * plan step → first running NON-agent tool (kind-aware) → running agent
 * count → thought stream seen this turn → working fallback. Deliberately no
 * tokens segment and no compact verb: MSP exposes neither a usage nor a
 * notice channel, so there is nothing honest to show for either.
 */
export function resolveStatusVerb(tv) {
  if (!tv) return '';
  // 0) Fresh agent, first turn, nothing back yet — the background MCP
  //    connects are the likeliest thing happening. Self-clears on the first
  //    activity of any kind.
  const silent = !tv.thoughtSeen && !tv.text && (tv.tools?.size || 0) === 0 && !tv.plan;
  if (tv.warming && silent) return 'กำลังเตรียมเครื่องมือ…';
  // 1) An interaction card nobody has answered yet — the subtype picks the
  //    verb (permissionSubtype() server-side: AskUserQuestion → 'ask',
  //    ExitPlanMode → 'plan', anything else a plain approval).
  for (const ix of tv.interactions?.values?.() || []) {
    if (ix.resolved) continue;
    if (ix.subtype === 'ask') return 'รอคำตอบจากคุณ…';
    if (ix.subtype === 'plan') return 'แผนพร้อมแล้ว — รอตรวจสอบ…';
    return 'รอการอนุญาต…';
  }
  // 2) The plan's in-progress step
  const inProgress = (tv.plan || []).find((e) =>
    /in_progress|running|active|current/i.test(String(e?.status || '')),
  );
  const step = String(inProgress?.content || inProgress?.title || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 56);
  if (step) return step.endsWith('…') ? step : `${step}…`;
  // 3) The first still-running NON-agent tool — agents are counted in (4);
  //    a plain tool wins this slot (grok transcript-model.js:761-776).
  for (const tool of tv.tools?.values?.() || []) {
    if (!/pending|in_progress|running/i.test(String(tool?.status || ''))) continue;
    if (isAgentTool(tool)) continue;
    return formatToolVerb(tool);
  }
  // 4) Agent-type tools still running (grok counts them only after plain
  //    tools had their chance, transcript-model.js:785-799).
  let agents = 0;
  for (const tool of tv.tools?.values?.() || []) {
    if (isAgentTool(tool) && /pending|in_progress|running/i.test(String(tool?.status || ''))) {
      agents += 1;
    }
  }
  if (agents > 0) return agents === 1 ? 'กำลังรัน 1 agent…' : `กำลังรัน ${agents} agents…`;
  // 5) The agent streamed reasoning this turn — thoughtSeen flips once per
  //    turn, the text itself stays unsurfaced.
  if (tv.thoughtSeen) return 'กำลังคิด…';
  // 6) Fallback — thinking is data-driven now, so the fallback must not
  //    claim it.
  return 'กำลังทำงาน…';
}

/**
 * Normalize the agent's advertised configOptions into the two selects the
 * head-bar pickers need — same shape as the server's MspClient.configSelects
 * (BUG-074), duplicated here so the renderer can fold a pushed
 * `config_option_update` snapshot in without a refetch (BUG-075). The
 * thinking select is absent entirely on models that cannot think (0.36.1).
 */
export function configSelectsFromOptions(configOptions) {
  const pick = (kind) => {
    const option = (configOptions || []).find(
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
 * Short model label for the pill: config aliases look like `provider/model-id` —
 * the last path segment is the name a user recognizes. Falls back to the
 * full id, then an em dash when nothing is known yet.
 */
export function modelShortName(model) {
  const s = String(model || '').trim();
  if (!s) return '—';
  return s.split('/').filter(Boolean).pop() || s;
}

/**
 * Menu rows for one select — the advertised values in order, flagging the
 * current one so the picker marks it with a check (theme picker pattern,
 * app.js openThemeMenu).
 */
export function configMenuItems(select, currentValue) {
  const cur = currentValue ?? select?.currentValue ?? null;
  return (select?.values || []).map((value) => ({
    value,
    label: value,
    current: value === cur,
  }));
}
