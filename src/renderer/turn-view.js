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
    /** Tool rows the user explicitly opened this turn (head click or the
     * console "Explain" button). Progress hides by default; this set is the
     * only thing that opens a row. */
    userExpandedTools: new Set(),
    /** The whole progress group (tools + plan) starts hidden, like Codex
     * Desktop's collapsed working block — the answer is the content. */
    progressOpen: false,
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
  if (reason === 'watchdog') return '⚠︎ ระบบหยุดให้ (เงียบเกินเพดาน watchdog)'; // tofu-ok: persisted data string, paint strips the glyph
  if (reason === 'interrupted') return '⏹ host หยุดระหว่างเทิร์น — prompt ใหม่เพื่อทำต่อ'; // tofu-ok: persisted data string, paint strips the glyph
  return '⏹ หยุดโดยผู้ใช้'; // tofu-ok: persisted data string, paint strips the glyph
}

/**
 * Display text for an interruption marker: the persisted string minus its
 * leading icon glyph — the paint mounts the vector twin (warn/stop) beside
 * the words instead. Pure — the node suite pins the strip rule.
 */
export function stripMarkerGlyph(text) {
  // U+23F9 / U+26A0 + text-style VS15 U+FE0E — escapes, not literals,
  // so the rule itself carries no tofu.
  return String(text ?? '').replace(/^[\u23F9\u26A0\uFE0E\s]+/, '');
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
    // A new turn starts with progress hidden again — open state must not
    // leak from the turn this view just replaced.
    tv.userToggledTools = new Set();
    tv.userExpandedTools = new Set();
    tv.progressOpen = false;
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
 * Global ESC-to-stop decision (app.js document keydown). ESC never stops a
 * turn directly: while a turn runs it opens a confirm popover, so a stray
 * keypress cannot kill a long turn. The interaction-card map above runs
 * first — an ESC that rejects a card never reaches this. Returns 'confirm'
 * when the handler should ask, 'none' otherwise.
 */
export function escStopAction({ key, running }) {
  if (key !== 'Escape' || !running) return 'none';
  return 'confirm';
}

/**
 * Stale-confirm guard for the other side of escStopAction: the turn may have
 * settled — or the chat switched — while the popover sat open, so the
 * confirmed stop only proceeds when the ESC-time chat is still the active
 * one and still running. Stopping anything else would surprise.
 */
export function confirmedStopProceeds({ escChatId, activeChatId, running }) {
  if (escChatId == null || escChatId !== activeChatId) return false;
  return !!running;
}

/**
 * Thai label for an interaction outcome — what the resolved card and the
 * inbox show instead of the wire string. Unknown outcomes pass through so
 * a new agent state is never blank (same rule as toolStatusLabel).
 */
export function outcomeLabel(outcome) {
  const o = String(outcome || '');
  if (o === 'answered') return 'ตอบแล้ว';
  if (o === 'decided') return 'ตัดสินใจแล้ว';
  if (o === 'cancelled') return 'ยกเลิกแล้ว';
  if (o === 'timedOut') return 'หมดเวลา';
  if (o === 'interrupted') return 'ถูกขัดจังหวะ';
  if (o === 'clarified') return 'ชี้แจงแล้ว';
  if (o === 'aborted') return 'ยกเลิกโดยระบบ';
  if (o === 'settled-remote') return 'agent ดำเนินการเองแล้ว';
  if (o === 'settled') return 'จบพร้อมเทิร์น';
  if (o === 'resolved' || o === 'released') return 'เสร็จแล้ว';
  return o;
}

/**
 * Merge a server pending-interactions snapshot into one chat's live map.
 * The caller decides authoritativeness with the wireRevs 'ix' guard: a
 * snapshot fetched while SSE kept flowing is stale and may only backfill
 * unknown ids — applying it wholesale would resurrect a card the user
 * just answered (the resolve raced the GET). A fresh snapshot is
 * authoritative: unknown ids are added, unresolved locals are refreshed
 * from server truth (this is what heals a same-ID recovery — the
 * re-mounted question replaces the dead resolved model), and unresolved
 * locals ABSENT from the snapshot are removed (their resolve fell into
 * an evicted SSE gap; answering would 404). Locally-resolved entries are
 * never touched — the resolved mark came from newer SSE by construction.
 *
 * `tombstones` (a Map<id, turnId>, chat-scoped, owned by the caller)
 * closes the GET-captured-pending → resolved-SSE → late-GET hole: an
 * unknown snapshot id the window already saw resolve, for the SAME turn,
 * is stale wire and is dropped. A different turn means the id was
 * re-asked in a new turn — accepted, and the tombstone lifted. A live
 * `interaction` frame always lifts the tombstone outright (same-ID
 * recovery re-mounts through the live wire, never the snapshot).
 *
 * Mutates `current` (a tv.interactions Map). Pure apart from the map.
 * @returns {{added: string[], updated: string[], removed: string[]}}
 */
export function applyIxSnapshot(current, list, { authoritative = false, tombstones = null } = {}) {
  const added = [];
  const updated = [];
  const removed = [];
  const snap = new Map();
  for (const ix of Array.isArray(list) ? list : []) {
    if (ix?.id != null) snap.set(String(ix.id), ix);
  }
  for (const [id, ix] of snap) {
    const local = current.get(id);
    if (!local) {
      if (tombstones?.has(id)) {
        const snapTurn = ix?.turnId == null ? '' : String(ix.turnId);
        const tombTurn = tombstones.get(id) == null ? '' : String(tombstones.get(id));
        if (snapTurn === tombTurn) continue; // stale: we saw this turn resolve
        tombstones.delete(id); // re-asked under a new turn — accept below
      }
      current.set(id, ix);
      added.push(id);
      continue;
    }
    if (!authoritative) continue; // stale: backfill only, never overwrite
    if (!local.resolved) {
      current.set(id, ix);
      updated.push(id);
      continue;
    }
    // A resolved local from an OLDER turn is fossil — the snapshot's
    // pending entry for the same id belongs to the live turn.
    if (local.turnId && ix.turnId && String(local.turnId) !== String(ix.turnId)) {
      current.set(id, ix);
      updated.push(id);
    }
  }
  if (authoritative) {
    for (const [id, local] of [...current]) {
      if (!local?.resolved && !snap.has(id)) {
        current.delete(id);
        removed.push(id);
      }
    }
  }
  return { added, updated, removed };
}

/**
 * Live-card check behind the placeholder rule: resolved cards are display
 * history, only unresolved ones justify a view or a turnId. Shared by the
 * funnel and the route merge so both bind on the same condition.
 */
export function ixHasUnresolved(interactions) {
  if (!interactions) return false;
  for (const ix of interactions.values()) {
    if (!ix?.resolved) return true;
  }
  return false;
}

/**
 * Post-filter probe shared by every snapshot path that may allocate a
 * view: raw rows can ALL be filtered out (tombstoned-same-turn under a
 * stale snapshot, or resolved-only rows), and a view must be stored only
 * when unresolved cards survive the merge. Runs the merge against a
 * throwaway — callers merge for real afterwards. The probe's tombstone
 * writes are idempotent with the real merge that follows (a re-asked id
 * the probe un-tombs merges as a plain add, with identical counts).
 */
export function ixSnapshotSurvives(list, { authoritative = false, tombstones = null } = {}) {
  const probe = new Map();
  applyIxSnapshot(probe, Array.isArray(list) ? list : [], { authoritative, tombstones });
  return ixHasUnresolved(probe);
}

/**
 * One funnel for pending-interaction snapshots (selectChat, resync, boot
 * backfill): merge the rows AND discipline the placeholder, without
 * inventing a running turn. `store` is the chatId → turn-view Map
 * (state.turnViews in app.js, a plain Map in tests); `adoptSubmits`
 * mirrors submit states (may be null in tests). Returns the live view,
 * or null when there is none.
 *
 * The P1 this fixes: 1.1.33 bound `turnId = 'pending'` for EVERY snapshot
 * including empty ones, and isRunning() reads ANY turnId — so an idle
 * chat spun with Stop forever and queued prompts behind a phantom turn
 * that never settles. A view is now allocated only when unresolved rows
 * survive the merge (probed first — raw rows may all be tombstoned); an
 * empty snapshot reconciles removals on an existing view only, and an
 * empty AUTHORITATIVE snapshot on an idle chat drops a synthetic view.
 *
 * The drop is narrow: authoritative + server-idle (no running turn AND no
 * turn id) + synthetic 'pending' turnId + nothing unresolved left AFTER
 * the merge (the merge runs first, so a stale unresolved local the
 * snapshot drops also leads here). Real turnIds, running chats and views
 * with unresolved cards are never dropped — a turn_started (or a live
 * question) that landed mid-fetch survives this snapshot.
 */
export function reconcileIxSnapshot(store, chatId, list, {
  authoritative = false,
  running = false,
  turnId = null,
  tombstones = null,
  adoptSubmits = null,
} = {}) {
  const rows = Array.isArray(list) ? list : [];
  let tv = store.get(chatId) || null;
  if (rows.length && !tv) {
    // Probe before allocating (P1 edge): a stale snapshot whose rows are
    // all tombstoned-same-turn must never create a view or a synthetic
    // turnId — with authoritative:false the drop below cannot heal it.
    if (!ixSnapshotSurvives(rows, { authoritative, tombstones })) return null;
    tv = createTurnView();
    store.set(chatId, tv);
  }
  if (!tv) return null;
  const merged = applyIxSnapshot(tv.interactions, rows, { authoritative, tombstones });
  if (rows.length && typeof adoptSubmits === 'function') adoptSubmits(rows, authoritative);
  if (merged.added.length || merged.updated.length || merged.removed.length) {
    tv.rev = (tv.rev || 0) + 1;
  }
  // Bind AFTER the merge: rows that all filtered out must not bind a
  // placeholder to a view with nothing live.
  if (rows.length && !tv.turnId && ixHasUnresolved(tv.interactions)) tv.turnId = turnId || 'pending';
  if (authoritative && !running && !turnId && tv.turnId === 'pending' && !ixHasUnresolved(tv.interactions)) {
    store.delete(chatId);
    return null;
  }
  return tv;
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
 * Whether a live tool row should be expanded. Progress hides by default
 * (Codex Desktop parity): streaming no longer pops rows open — not even
 * running bash rows (the old grok-desktop behaviour this replaced). A row
 * opens only when the user explicitly asked: head click or the console
 * "Explain" button records the id in `userExpandedTools` for the turn.
 * `userToggledTools` keeps its BUG-033 meaning (a manual toggle wins).
 */
export function shouldAutoExpandTool(tv, tool) {
  const id = tool?.id;
  if (id == null) return false;
  if (tv?.userToggledTools?.has?.(id) && !tv?.userExpandedTools?.has?.(id)) return false;
  return !!tv?.userExpandedTools?.has?.(id);
}

/** Flip the whole progress group (tools + plan) open/closed for the turn. */
export function toggleProgressOpen(tv) {
  if (!tv) return false;
  tv.progressOpen = !tv.progressOpen;
  tv.rev = (tv.rev || 0) + 1;
  return tv.progressOpen;
}

/**
 * One-line counts for the progress group header: how many tool rows exist,
 * how many still run, and how many plan steps are done/total.
 */
export function progressSummary(tv) {
  let tools = 0;
  let running = 0;
  for (const tool of tv?.tools?.values?.() || []) {
    tools += 1;
    if (/pending|in_progress|running/i.test(String(tool?.status || ''))) running += 1;
  }
  const plan = Array.isArray(tv?.plan) ? tv.plan : [];
  const planDone = plan.filter((e) => String(e?.status || '') === 'completed').length;
  return { tools, running, planSteps: plan.length, planDone };
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
 * Live-turn agent rows as overview descriptors: human title + display state
 * + the durable server link (tool.agentLink → registry itemId) the popup's
 * union dedupes on. Rows without a link stay honestly undrillable.
 *
 * tv.tools holds RAW tool objects (the tool_call handler stores data.tool
 * directly) — a `.map((n) => n.tool)` here reads undefined off every row
 * and the whole live side of the union silently disappears (1.1.30).
 */
export function agentToolRows(tv) {
  const out = [];
  for (const tool of tv?.tools?.values?.() || []) {
    if (!tool || !agentToolMeta(tool)) continue;
    const ds = toolDisplayState(tool);
    out.push({
      id: tool.id,
      title: agentSubtitle(tool),
      state: ds === 'background' ? 'ทำงานเบื้องหลัง' : toolStatusLabel(tool.status),
      // Captured liveness for the union count — the descriptor leaves the
      // raw tool behind, so the chip/popup count from this, not status.
      running: ds === 'pending' || ds === 'running',
      status: tool.status,
      kind: tool.kind,
      agentLink: tool.agentLink ?? null,
    });
  }
  return out;
}

/**
 * Display topic of one tool row: the title with the old `${tool} ${args}`
 * prefix stripped (server titles used to read `Bash ls …`, stored
 * transcripts still do). New server titles are already bare topics, which
 * pass through untouched. Case-insensitive on purpose — the wire spells
 * the same tool `Bash`, `bash` and `execute` in different places.
 */
export function toolTopic(tool) {
  const raw = String(tool?.title || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const kind = String(tool?.kind || '').trim();
  if (kind) {
    const lower = raw.toLowerCase();
    const kl = kind.toLowerCase();
    if (lower === kl) return '';
    for (const sep of [' ', ':', '：', '—', '-', '·']) {
      if (lower.startsWith(`${kl}${sep}`)) {
        return raw.slice(kind.length + sep.length).trim();
      }
    }
  }
  return raw;
}

/**
 * Normalized content of the plan's in-progress step, or '' when no step
 * runs. Shared by the status verb and the progress header so both name the
 * same step (callers slice to their own width).
 */
export function inProgressPlanStep(tv) {
  const entry = (tv?.plan || []).find((e) =>
    /in_progress|running|active|current/i.test(String(e?.status || '')),
  );
  return String(entry?.content || entry?.title || '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Kind-aware Thai verb for one running tool (grok-desktop `formatToolVerb`,
 * transcript-model.js:812-837, re-keyed to the MSP wire kinds). A title that
 * already reads like a verb phrase (กำลัง…, or an English -ing word) is used
 * as-is — prefixing it again would read "กำลังอ่าน Reading …".
 */
function formatToolVerb(tool) {
  const kind = String(tool?.kind || '').toLowerCase();
  const title = toolTopic(tool);
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
  const step = inProgressPlanStep(tv).slice(0, 56);
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
 * Heading topic for the progress group's header: the in-progress plan
 * step first (the most human line available), else the first running
 * plain tool's topic, else the running agent count. '' when nothing is
 * in flight — the caller falls back to the generic `Progress Bar` label.
 * Same priority spine as resolveStatusVerb minus the interaction branch:
 * a permission card already has its own card + status verb, the header
 * keeps naming the work underneath it.
 */
export function progressTopic(tv) {
  if (!tv) return '';
  const step = inProgressPlanStep(tv).slice(0, 48);
  if (step) return step;
  for (const tool of tv.tools?.values?.() || []) {
    if (!/pending|in_progress|running/i.test(String(tool?.status || ''))) continue;
    if (isAgentTool(tool)) continue;
    const topic = toolTopic(tool).slice(0, 48);
    if (topic) return topic;
  }
  let agents = 0;
  for (const tool of tv.tools?.values?.() || []) {
    if (isAgentTool(tool) && /pending|in_progress|running/i.test(String(tool?.status || ''))) {
      agents += 1;
    }
  }
  if (agents > 0) return agents === 1 ? '1 agent' : `${agents} agents`;
  return '';
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

/**
 * Compact elapsed clock for turn headers — ChatGPT Desktop's `Working for
 * 24s` / `Worked for 5m 49s` shape, units only (the caller adds the verb).
 * `24s` under a minute, `5m 49s` under an hour, `1h 2m` beyond; zero parts
 * drop (`5m`, never `5m 0s`).
 */
export function formatElapsed(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const r = s % 60;
    return r ? `${m}m ${r}s` : `${m}m`;
  }
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

/**
 * One-line turn header — the always-visible disclosure ChatGPT Desktop
 * paints per turn: `กำลังทำ 24s · …` while running, `ทำไป 36s · …` once
 * settled. Counts follow the clock (topic → tools → plan → agents); a
 * settled turn without a persisted duration falls back to counts only.
 */
export function turnHeaderLabel({
  running = false,
  elapsedMs = 0,
  durationMs = null,
  topic = '',
  tools = 0,
  runningTools = 0,
  planSteps = 0,
  planDone = 0,
  agentsRunning = 0,
  agentsTotal = 0,
} = {}) {
  const bits = [];
  if (running) bits.push(`กำลังทำ ${formatElapsed(elapsedMs)}`);
  else if (durationMs != null) bits.push(`ทำไป ${formatElapsed(durationMs)}`);
  if (topic) bits.push(topic);
  if (tools) bits.push(`${tools} tools${runningTools ? ` · ${runningTools} กำลังรัน` : ''}`);
  if (planSteps) bits.push(`plan ${planDone}/${planSteps}`);
  if (agentsTotal) bits.push(`agents ${agentsRunning}/${agentsTotal}`);
  if (!bits.length) return running ? 'กำลังทำ…' : 'เทิร์นนี้';
  return bits.join(' · ');
}
