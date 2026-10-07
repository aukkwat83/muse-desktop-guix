// Right bar: session cost (THB), goal + tasks, subagents.
//
// Hidden by default — the hamburger in the head bar (and the goal/tasks/
// agents chips) opens it. Codex Desktop parity: one collapsible rail on the
// right instead of three floating popovers. Each section is a <details>
// block so collapse is native + keyboard-accessible; data arrives by push
// from app.js (same SSE the pills already ride) plus one fetch:
// /api/pricing once. (The SCB tags+insights section was removed 2026-09-22 —
// sidebar [APxxxx] chips and title prefixes are untouched.)

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function clampPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/**
 * Goal + task display vocabulary, Mcode ConversationStatusPanel parity.
 * Exported for the node suite — rightbar.js has no top-level DOM touch.
 */
export function goalStatusWord(status) {
  switch (String(status || '')) {
    case 'active': // the real MSP running state (probed 2026-09-22)
    case 'running': return 'กำลังทำ';
    case 'paused': return 'หยุดชั่วคราว';
    case 'verified': // Mcode's done state, accepted defensively
    case 'complete':
    case 'done': return 'เสร็จ';
    case 'blocked': return 'ติดขัด';
    case 'failed': return 'ล้มเหลว';
    default: return String(status || '—');
  }
}

/** Which trailing control the goal header carries (Mcode GoalStatusSection). */
export function goalControlFor(status) {
  switch (String(status || '')) {
    case 'active':
    case 'running': return 'pause';
    case 'paused': return 'resume';
    case 'verified':
    case 'complete':
    case 'done': return 'done';
    default: return null;
  }
}

export function taskStatusWord(status) {
  switch (String(status || '')) {
    case 'in_progress': return 'ทำอยู่';
    case 'completed': return 'เสร็จ';
    case 'failed': return 'ล้มเหลว';
    case 'cancelled': return 'ยกเลิก';
    default: return 'รอ';
  }
}

/** Per-row status glyph (Mcode PlanStatusIcon): shape carries the meaning. */
export function taskGlyph(status) {
  switch (String(status || '')) {
    case 'completed': return { glyph: '✓', cls: 'task-glyph done' };
    case 'in_progress': return { glyph: '→', cls: 'task-glyph run' };
    case 'cancelled': return { glyph: '✕', cls: 'task-glyph cancel' };
    default: return { glyph: '○', cls: 'task-glyph idle' };
  }
}

const TODO_COMPACT_THRESHOLD = 6;
const TODO_FOCUS_SIZE = 3;

/**
 * Mcode getStatusPanelTodoFocusWindow: past 6 items only 3 stay visible —
 * the running row (else first unfinished, else the tail) plus context, the
 * rest fold into preceding/following <details> groups with counts.
 */
export function todoFocusWindow(items) {
  const list = Array.isArray(items) ? items : [];
  if (list.length <= TODO_COMPACT_THRESHOLD) {
    return { compact: false, preceding: [], focus: list.slice(), following: [] };
  }
  let focusIndex = list.findIndex((t) => String(t?.status) === 'in_progress');
  if (focusIndex < 0) focusIndex = list.findIndex((t) => String(t?.status) !== 'completed');
  if (focusIndex < 0) focusIndex = Math.max(0, list.length - TODO_FOCUS_SIZE);
  const start = Math.max(0, Math.min(focusIndex, list.length - TODO_FOCUS_SIZE));
  const end = Math.min(list.length, start + TODO_FOCUS_SIZE);
  return {
    compact: true,
    preceding: list.slice(0, start),
    focus: list.slice(start, end),
    following: list.slice(end),
  };
}

/** Fold-row label, Mcode's four cases (completed/earlier/waiting/later). */
export function todoFoldLabel(items, side) {
  const n = items.length;
  if (side === 'preceding') {
    return items.every((t) => String(t?.status) === 'completed')
      ? `เสร็จแล้ว ${n} รายการ`
      : `ก่อนหน้า ${n} รายการ`;
  }
  return items.every((t) => String(t?.status) === 'pending')
    ? `รอทำ ${n} รายการ`
    : `ถัดไป ${n} รายการ`;
}

// ---------------------------------------------------------------- subagents
// Pure view-model for the rail's per-child rows + drill-down. Exported for
// the node suite — no top-level DOM touch. (Successor to the retired
// subagents-panel.js popover: same vocabulary, rendered inline in the rail.)

export function subagentStatusWord(status) {
  switch (String(status || '')) {
    case 'inProgress': return 'กำลังรัน';
    case 'completed': return 'เสร็จ';
    case 'failed': return 'ล้มเหลว';
    case 'cancelled': return 'ยกเลิก';
    default: return String(status || '—');
  }
}

export function subagentDotClass(status) {
  switch (String(status || '')) {
    case 'inProgress': return 'dot run';
    case 'completed': return 'dot ok';
    case 'failed': return 'dot bad';
    default: return 'dot idle';
  }
}

export function subagentTitle(rec) {
  if (!rec || typeof rec !== 'object') return 'child';
  // Native children lead with their task name (the per-topic header the CLI
  // shows); system reminders lead with their agent id — the fallbackText
  // the wire ships for them is the same generic line on every row.
  return rec.taskName || rec.role || rec.agentPath || rec.objective
    || rec.reminderAgentId || rec.entryId || rec.fallbackText || rec.kind || 'child';
}

/** The wire's one-size line for every reminder row — never shown as a topic. */
const GENERIC_REMINDER_FALLBACK = 'Reminder child session';

export function subagentSub(rec) {
  const bits = [];
  if (rec.kind === 'workflow' && Array.isArray(rec.children)) {
    bits.push(`${rec.children.length} children`);
  } else if (rec.kind === 'reminderChild') {
    if (rec.generationId != null) bits.push(`gen ${rec.generationId}`);
    // The verdict is the row's topic (folded by the server from the child
    // session); a running row falls back to its live tail, and the generic
    // wire line only shows when it says something else.
    if (rec.result?.summary) bits.push(rec.result.summary);
    else if (String(rec.status) === 'inProgress' && rec.liveText) bits.push(String(rec.liveText).slice(-120));
    else if (rec.fallbackText && rec.fallbackText !== GENERIC_REMINDER_FALLBACK) bits.push(rec.fallbackText);
  } else {
    if (rec.depth != null) bits.push(`depth ${rec.depth}`);
    if (rec.controlStatus) bits.push(rec.controlStatus);
  }
  if (rec.durationMs != null) bits.push(`${(rec.durationMs / 1000).toFixed(1)}s`);
  if (rec.objective && rec.role) bits.push(rec.objective);
  else if (rec.objective && !rec.role && !rec.agentPath && !rec.taskName) bits.push(rec.objective);
  if (rec.message) bits.push(rec.message);
  return bits.join(' · ');
}

/**
 * System reminders (skill/memory/goal/verify) arrive by the dozen and bury
 * the real parallel children — the rail lists real ones first and folds
 * reminders into one collapsed group below.
 */
export function partitionReminders(recs) {
  const main = [];
  const reminders = [];
  for (const r of recs || []) {
    if (r?.kind === 'reminderChild') reminders.push(r);
    else main.push(r);
  }
  return { main, reminders };
}

/** Wire rows the thread-overview popup lists before folding the rest. */
export const OVERVIEW_WIRE_CAP = 6;

/**
 * Thread-overview Subagents section rows (1.1.29): the live turn's agent
 * tool rows win; when the turn has none, the server's wire children back
 * them — the same fallback as the agents chip, so the overview never
 * claims "none" while the chip counts running ones. Real children list
 * first (capped — the popup is a glance, the rail holds the rest) and
 * system reminders fold into one row like the rail.
 *
 * Pure view-model: app.js paints the descriptors. Shapes:
 *   { kind: 'empty' } — nothing anywhere
 *   { kind: 'turn', tools } — live-turn agent tools
 *   { kind: 'wire', main, hiddenMain, reminders, remindersRunning }
 */
export function overviewSubagentRows(agentTools, wireRecs) {
  const tools = Array.isArray(agentTools) ? agentTools : [];
  if (tools.length) return { kind: 'turn', tools };
  const recs = [...(wireRecs || [])].sort((a, b) => (b?.updatedAt || 0) - (a?.updatedAt || 0));
  if (!recs.length) return { kind: 'empty' };
  const { main, reminders } = partitionReminders(recs);
  return {
    kind: 'wire',
    main: main.slice(0, OVERVIEW_WIRE_CAP),
    hiddenMain: Math.max(0, main.length - OVERVIEW_WIRE_CAP),
    reminders: reminders.length,
    remindersRunning: reminders.filter((r) => String(r?.status) === 'inProgress').length,
  };
}

export function drillKindTag(kind) {
  switch (String(kind || '')) {
    case 'agentMessage': return 'ตอบ';
    case 'userMessage': return 'ถาม';
    case 'toolCall': return 'tool';
    case 'subagent': return 'subagent';
    case 'workflow': return 'workflow';
    case 'reasoning': return 'คิด';
    default: return String(kind || '?');
  }
}

export function drillItemPreview(it) {
  if (it.text) return it.text;
  if (it.result?.summary) return it.result.summary;
  if (it.tool) return `${it.tool}${it.fallbackText ? ` → ${it.fallbackText}` : ''}`;
  if (it.objective) return it.objective;
  if (it.message) return it.message;
  if (it.fallbackText) return it.fallbackText;
  return '';
}

/**
 * Which owner verbs the rail offers for one record. Running → stop+send;
 * landed (completed/failed/cancelled) → resume; anything without a durable
 * subagentId, or a non-subagent fold, offers nothing — the server would 409.
 */
export function subagentActions(rec) {
  if (!rec || rec.kind !== 'subagent' || !rec.subagentId) return [];
  if (String(rec.status) === 'inProgress') return ['stop', 'send'];
  if (['completed', 'failed', 'cancelled'].includes(String(rec.status))) return ['resume'];
  return [];
}

export const SUBAGENT_ACTION_LABEL = {
  stop: '⏹ หยุด',
  resume: '▶ ทำต่อ',
  send: '✉ ส่งข้อความ',
};

/**
 * Pop-out target for one registry row: the standalone live page for the
 * child's own session (child.html polls the same drill endpoint the rail
 * uses). Item frames resolve through the record; nested session frames
 * address the child session directly.
 */
export function childWindowUrl(chatId, ref = {}) {
  const q = [`chat=${encodeURIComponent(String(chatId ?? ''))}`];
  if (ref.itemId) q.push(`item=${encodeURIComponent(String(ref.itemId))}`);
  else if (ref.childSessionId) q.push(`session=${encodeURIComponent(String(ref.childSessionId))}`);
  return `/child.html?${q.join('&')}`;
}

function fmtInt(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function fmtThb(n) {
  return `฿${Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtUsd(n) {
  return `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
}

/** Clipboard with a legacy fallback — older WKWebView has no async API. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Client mirror of the server's rateFor(): exact → basename → lower → lower-basename → default. */
function pickRate(modelId, pricing) {
  const models = pricing?.models || {};
  const raw = String(modelId || '').trim();
  const base = raw ? raw.split('/').filter(Boolean).pop() : '';
  for (const c of raw ? [raw, base, raw.toLowerCase(), (base || '').toLowerCase()] : []) {
    if (c && models[c]) return { rate: models[c], matched: c, estimated: false };
  }
  return {
    rate: models.default || { ...BUILTIN_PRICING.models.default },
    matched: 'default',
    estimated: true,
  };
}

// Built-in estimate, mirrored from src/server/pricing.js — the cost math
// must never run on {0,0} rates. Used while /api/pricing is still loading
// and when the host is too old to serve it (then everything is estimated).
const BUILTIN_PRICING = {
  effective: '2026-09-22',
  source: 'Meta Model API public pricing',
  models: {
    'muse-spark-1.3': { input: 1.25, output: 4.25 },
    'muse-spark-1.3-contributor': { input: 0.10, output: 0.20 },
    'muse-spark-1.2': { input: 1.25, output: 4.25 },
    'muse-spark-1.2-contributor': { input: 0.10, output: 0.20 },
    'muse-spark': { input: 1.25, output: 4.25 },
    'meta-muse-spark': { input: 1.25, output: 4.25 },
    default: { input: 1.25, output: 4.25 },
  },
  override: false,
};
const BUILTIN_THB_PER_USD = 35;

export function createRightbar({ api, aside, toggleBtn }) {
  /** chatId → { tokens, model } — cost inputs; a switch back repaints free. */
  const costByChat = new Map();
  /** chatId → goal block (or null). */
  const goalByChat = new Map();
  /** chatId → plan entries. */
  const planByChat = new Map();
  /** chatId → Map(itemId → subagent record). */
  const agentsByChat = new Map();
  /** chatId → { msp, turn } identity row inputs (MSP session + live turn). */
  const sessionByChat = new Map();

  let chatId = null;
  let pricing = null;
  let pricingFailed = false;

  aside.replaceChildren();

  const head = el('div', 'rb-head');
  head.append(el('div', 'rb-title', 'แผงขวา'));
  const close = el('button', 'btn ghost sm', '✕');
  close.type = 'button';
  close.title = 'ซ่อนแผงขวา';
  close.setAttribute('aria-label', 'ซ่อนแผงขวา');
  close.addEventListener('click', () => setOpen(false));
  head.append(close);
  aside.append(head);

  const scroll = el('div', 'rb-scroll');
  aside.append(scroll);

  function section(id, title) {
    const d = document.createElement('details');
    d.className = 'rb-sect';
    d.open = true;
    d.dataset.sect = id;
    const s = document.createElement('summary');
    s.className = 'rb-summary';
    s.textContent = title;
    const body = el('div', 'rb-body');
    d.append(s, body);
    scroll.append(d);
    return body;
  }

  const sessionBody = section('session', 'session');
  const costBody = section('cost', 'ค่าใช้จ่าย session นี้');
  const goalBody = section('goal', 'goal');
  const tasksBody = section('tasks', 'tasks');
  const agentsBody = section('agents', 'subagents');

  function setOpen(open) {
    document.body.classList.toggle('rb-open', open);
    if (!open) stopAgentPoll();
    aside.hidden = !open;
    // The resize gutter lives and dies with the rail.
    const gutter = document.getElementById('rightbar-gutter');
    if (gutter) gutter.hidden = !open;
    toggleBtn?.classList.toggle('is-active', open);
    toggleBtn?.setAttribute('aria-expanded', String(open));
    if (open) render();
  }

  function isOpen() {
    return !aside.hidden;
  }

  /** Open the rail and scroll a section into view (chip clicks land here). */
  function reveal(sect) {
    setOpen(true);
    const d = scroll.querySelector(`details[data-sect="${sect}"]`);
    if (d) {
      d.open = true;
      d.scrollIntoView({ block: 'nearest' });
    }
  }

  function summaryLine(summaryEl, text) {
    const d = summaryEl?.closest?.('details');
    const s = d?.querySelector?.(':scope > summary');
    if (s) {
      s.querySelector('.rb-count')?.remove();
      if (text) s.append(el('span', 'rb-count', text));
    }
  }

  // ---------------------------------------------------------------- session

  function renderSession() {
    sessionBody.replaceChildren();
    if (!chatId) {
      sessionBody.append(el('div', 'panel-empty', 'ยังไม่เลือกแชท'));
      summaryLine(sessionBody, '');
      return;
    }
    const snap = sessionByChat.get(chatId) || {};
    const idRow = (label, value, emptyText, title) => {
      const r = el('div', 'rb-id-row');
      r.append(el('span', 'rb-k', label));
      const v = el('span', 'rb-id-val', value || emptyText);
      if (value) v.title = title || value;
      else v.classList.add('is-empty');
      r.append(v);
      if (value) {
        const btn = el('button', 'rb-copy', '⧉');
        btn.type = 'button';
        btn.title = `คัดลอก ${label}`;
        btn.setAttribute('aria-label', `คัดลอก ${label}`);
        btn.addEventListener('click', async () => {
          const ok = await copyText(value);
          btn.textContent = ok ? '✓' : '✗';
          setTimeout(() => {
            btn.textContent = '⧉';
          }, 1200);
        });
        r.append(btn);
      }
      sessionBody.append(r);
    };
    idRow('chat', chatId, '', 'Desktop chat ID');
    idRow('agent', snap.msp || '', '— ยังไม่ spawn', 'MSP session ID — ใช้กับ muse export/trace/resume');
    idRow('turn', snap.turn || '', '— ไม่มีเทิร์นรันอยู่', 'เทิร์นที่กำลังรัน');
    summaryLine(sessionBody, snap.turn ? 'running' : '');
  }

  // ---------------------------------------------------------------- cost

  async function ensurePricing() {
    if (pricing || pricingFailed) return;
    try {
      const res = await api('/api/pricing');
      pricing = { table: res.pricing, thbPerUsd: Number(res.thbPerUsd) || 35 };
    } catch {
      pricingFailed = true;
    }
  }

  function renderCost() {
    costBody.replaceChildren();
    const snap = chatId ? costByChat.get(chatId) : null;
    const tokens = snap?.tokens;
    const model = snap?.model || null;
    if (!tokens || (tokens.promptTokens == null && tokens.totalTokens == null)) {
      costBody.append(el('div', 'panel-empty', 'ยังไม่มีข้อมูล usage — รอเทิร์นแรก'));
      summaryLine(costBody, '');
      return;
    }
    const p = Math.max(0, Math.round(Number(tokens.promptTokens) || 0));
    const o = Math.max(0, Math.round(Number(tokens.outputTokens) || 0));
    const t = tokens.totalTokens != null ? Math.round(Number(tokens.totalTokens)) : p + o;
    const table = pricing?.table || BUILTIN_PRICING;
    const thbRate = pricing?.thbPerUsd || BUILTIN_THB_PER_USD;
    const { rate, matched, estimated } = pickRate(model, table);
    const usd = (p * (rate.input || 0) + o * (rate.output || 0)) / 1_000_000;
    const thb = usd * thbRate;

    const total = el('div', 'rb-cost-total', fmtThb(thb));
    total.title = `${fmtUsd(usd)} · เรท ${thbRate} ฿/$
· โมเดล ${model || '—'} (${matched})`;
    costBody.append(total);

    const grid = el('div', 'rb-kv');
    const row = (k, v, title) => {
      const r = el('div', 'rb-kv-row');
      r.append(el('span', 'rb-k', k), el('span', 'rb-v', v));
      if (title) r.title = title;
      grid.append(r);
    };
    row('input', `${fmtInt(p)} tokens`);
    row('output', `${fmtInt(o)} tokens`);
    row('รวม', `${fmtInt(t)} tokens`);
    row('โมเดล', model ? String(model).split('/').filter(Boolean).pop() : '—');
    // Which table row prices this session — a silent default fallback is
    // exactly how every model used to cost the same.
    row(
      'ใช้เรท',
      estimated ? `${matched} (ไม่พบเรทโมเดลนี้)` : matched,
      estimated ? 'โมเดลนี้ไม่มีแถวในตารางเรท — ใช้เรท default แทน' : `เรทของ ${matched}`,
    );
    row('เรท input', `$${rate.input ?? 0} / 1M`, `เรทของ ${matched}`);
    row('เรท output', `$${rate.output ?? 0} / 1M`, `เรทของ ${matched}`);
    costBody.append(grid);

    const foot = el(
      'div',
      'rb-foot',
      `${estimated || !table.override ? 'ประมาณการ · ' : ''}เรท ${table.effective || '—'} · ${table.source || ''}`.trim(),
    );
    costBody.append(foot);
    summaryLine(costBody, fmtThb(thb));
  }

  // ---------------------------------------------------------------- goal

  /** Header trailing: Mcode's pause/resume/done control next to the pct. */
  function renderGoalSummary(goal) {
    summaryLine(goalBody, goal ? `${clampPct(goal.percentComplete)}%` : '');
    const d = goalBody.closest?.('details');
    const s = d?.querySelector?.(':scope > summary');
    if (!s) return;
    // summaryLine only clears .rb-count — drop the previous control too.
    s.querySelectorAll('.rb-goal-btn, .rb-goal-done').forEach((n) => n.remove());
    if (!goal) return;
    const control = goalControlFor(goal.status);
    if (!control) return;
    if (control === 'done') {
      const mark = el('span', 'rb-goal-done', '✓');
      mark.title = 'goal เสร็จแล้ว';
      mark.setAttribute('aria-label', 'goal เสร็จแล้ว');
      s.append(mark);
      return;
    }
    const btn = el('button', 'btn ghost sm rb-goal-btn', control === 'pause' ? '⏸' : '▶');
    btn.type = 'button';
    const cold = !(chatId && sessionByChat.get(chatId)?.msp);
    btn.disabled = cold;
    btn.title = cold
      ? 'รอ agent spawn ก่อน (prompt สักครั้ง)'
      : control === 'pause' ? 'หยุด goal ชั่วคราว' : 'ทำ goal ต่อ';
    btn.setAttribute('aria-label', btn.title);
    btn.addEventListener('click', (ev) => {
      // The button lives inside <summary> — without this the section toggles.
      ev.preventDefault();
      ev.stopPropagation();
      void driveGoal(control);
    });
    s.append(btn);
  }

  /** POST the verb; the repaint rides the goalChanged SSE, never the reply. */
  async function driveGoal(action) {
    if (!chatId) return;
    renderGoalSummary(goalByChat.get(chatId) ?? null);
    const d = goalBody.closest?.('details');
    const btn = d?.querySelector?.(':scope > summary .rb-goal-btn');
    if (btn) btn.disabled = true;
    try {
      await api(`/api/chats/${encodeURIComponent(chatId)}/goal`, { method: 'POST', body: { action } });
    } catch (err) {
      if (btn) {
        btn.disabled = false;
        btn.title = `สั่งไม่ได้: ${err?.message || err}`;
      }
    }
  }

  function renderGoal() {
    goalBody.replaceChildren();
    const goal = chatId ? goalByChat.get(chatId) ?? null : null;
    if (!goal) {
      if (!chatId) goalBody.append(el('div', 'panel-empty', 'ยังไม่เลือกแชท'));
      else goalBody.append(el('div', 'panel-empty', 'ยังไม่ตั้ง goal ในแชทนี้'));
    } else {
      const pct = clampPct(goal.percentComplete);
      const g = el('div', 'goal-block');
      const first = el('div', 'drill-first');
      first.append(el('span', 'kind-tag', `${pct}%`));
      first.append(el('span', 'drill-tool', goalStatusWord(goal.status)));
      g.append(first);
      if (goal.objective) {
        const obj = el('div', 'goal-objective', goal.objective);
        obj.title = goal.objective;
        g.append(obj);
      }
      const bar = el('div', 'goal-bar');
      const fill = el('div', 'goal-fill');
      fill.style.width = `${pct}%`;
      bar.append(fill);
      g.append(bar);
      if (goal.currentWork) {
        const w = el('div', 'goal-work', `กำลังทำ: ${goal.currentWork}`);
        w.title = goal.currentWork;
        g.append(w);
      }
      if (goal.nextWork) {
        const w = el('div', 'goal-work next', `ถัดไป: ${goal.nextWork}`);
        w.title = goal.nextWork;
        g.append(w);
      }
      goalBody.append(g);
    }
    renderGoalSummary(goal);
  }

  // ---------------------------------------------------------------- tasks

  /** One Mcode-style todo row: glyph + clamped text, full text on hover. */
  function taskRow(t) {
    const status = String(t?.status || 'pending');
    const { glyph, cls } = taskGlyph(status);
    const row = el('div', 'mcp-row task-row');
    const g = el('span', cls, glyph);
    g.setAttribute('aria-hidden', 'true');
    row.append(g);
    const running = status === 'in_progress';
    const active = running && t?.activeForm ? String(t.activeForm) : '';
    const content = String(t?.content || '(ไม่มีชื่อ task)');
    const text = el('div', 'task-content', active || content);
    if (active && active !== content) text.title = `${active}\n${content}`;
    else text.title = content;
    if (status === 'completed') text.classList.add('is-done');
    row.append(text);
    row.setAttribute('aria-label', `${taskStatusWord(status)}: ${content}`);
    return row;
  }

  function renderTasks() {
    tasksBody.replaceChildren();
    const entries = chatId ? planByChat.get(chatId) || [] : [];
    if (!chatId) {
      tasksBody.append(el('div', 'panel-empty', 'ยังไม่เลือกแชท'));
      summaryLine(tasksBody, '');
      return;
    }
    const done = entries.filter((e) => String(e?.status) === 'completed').length;
    tasksBody.append(el('div', 'panel-sect', `tasks · เสร็จ ${done}/${entries.length}`));
    if (!entries.length) {
      tasksBody.append(el('div', 'panel-empty', 'ยังไม่มี tasks ในเทิร์นนี้'));
      summaryLine(tasksBody, '');
      return;
    }
    const win = todoFocusWindow(entries);
    const fold = (items, side) => {
      const d = document.createElement('details');
      d.className = 'todo-fold';
      const s = document.createElement('summary');
      s.className = 'todo-fold-summary';
      s.textContent = todoFoldLabel(items, side);
      d.append(s);
      for (const t of items) d.append(taskRow(t));
      return d;
    };
    if (win.compact && win.preceding.length) tasksBody.append(fold(win.preceding, 'preceding'));
    for (const t of win.focus) tasksBody.append(taskRow(t));
    if (win.compact && win.following.length) tasksBody.append(fold(win.following, 'following'));
    summaryLine(tasksBody, `${done}/${entries.length}`);
  }

  // ---------------------------------------------------------------- agents
  //
  // Counts on top, one row per child below, click a row to drill into the
  // child's own session inline (Codex-rail parity). Drill data is a
  // point-in-time session/read, refreshed on a short poll while the child
  // runs; live deltas patch rows in place so streaming never re-renders the
  // list out from under the cursor. Owner verbs (stop/resume/send) live in
  // the drill header — the repaint rides the item SSE, never the POST reply.

  /** Drill stack for the OPEN chat — showChat resets it. Frames:
   * { type:'workflow', label, rec } |
   * { type:'item'|'sess', itemId|childSessionId, label, drill, error,
   *   liveText, sendOpen, confirming, busy, note } */
  let agentStack = [];
  let agentPollTimer = null;
  /** Item kinds that nest a readable child session one level deeper. */
  const DRILLABLE_CHILD_KINDS = new Set(['subagent', 'workflow', 'reminderChild']);

  function stopAgentPoll() {
    if (agentPollTimer) {
      clearInterval(agentPollTimer);
      agentPollTimer = null;
    }
  }

  function agentRecords() {
    return [...((chatId && agentsByChat.get(chatId)?.values()) || [])]
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function agentTop() {
    return agentStack.length ? agentStack[agentStack.length - 1] : null;
  }

  /** Live registry record behind an item drill frame (null for sess frames). */
  function agentRecordFor(frame) {
    if (!frame || frame.type !== 'item' || !chatId) return null;
    return agentsByChat.get(chatId)?.get(frame.itemId) || null;
  }

  function renderAgents() {
    stopAgentPoll();
    agentsBody.replaceChildren();
    const recs = agentRecords();
    const counts = renderAgentCounts(recs);
    counts.dataset.role = 'agents-counts';
    agentsBody.append(counts);
    const content = el('div', 'agent-content');
    content.dataset.role = 'agents-content';
    agentsBody.append(content);
    if (!recs.length) {
      content.append(el('div', 'panel-empty', 'ยังไม่มี subagent ในแชทนี้'));
    } else {
      const top = agentTop();
      if (!top) renderAgentList(content, recs);
      else if (top.type === 'workflow') renderAgentWorkflow(content, top);
      else renderAgentDrill(content, top);
    }
    const running = recs.filter((r) => String(r.status) === 'inProgress').length;
    summaryLine(agentsBody, recs.length ? `${running}/${recs.length}` : '');
  }

  function renderAgentCounts(recs) {
    const count = (st) => recs.filter((r) => String(r.status) === st).length;
    const grid = el('div', 'rb-kv');
    const row = (k, v, dot) => {
      const r = el('div', 'rb-kv-row');
      if (dot) r.append(el('span', dot));
      r.append(el('span', 'rb-k', k), el('span', 'rb-v', String(v)));
      grid.append(r);
    };
    row('กำลังรัน', count('inProgress'), 'dot run');
    row('เสร็จ', count('completed'), 'dot ok');
    row('ล้มเหลว', count('failed'), 'dot bad');
    row('ยกเลิก', count('cancelled'), 'dot idle');
    row('รวมที่ใช้', recs.length, null);
    return grid;
  }

  function renderAgentList(content, recs) {
    const { main, reminders } = partitionReminders(recs);
    const list = el('div', 'panel-list');
    for (const rec of main) list.append(renderAgentRow(rec));
    content.append(list);
    if (reminders.length) {
      const fold = document.createElement('details');
      fold.className = 'todo-fold';
      const summary = document.createElement('summary');
      summary.className = 'todo-fold-summary';
      summary.textContent = `system reminders · ${reminders.length}`;
      const inner = el('div', 'panel-list');
      for (const rec of reminders) inner.append(renderAgentRow(rec));
      fold.append(summary, inner);
      content.append(fold);
    }
  }

  function renderAgentRow(rec) {
    // Native children drill into their folded detail view (no MSP session);
    // item children drill into their own session; workflow folds open inline.
    const drillable = rec.kind === 'native'
      || (rec.kind === 'workflow' && Array.isArray(rec.children) && rec.children.length)
      || !!rec.childSessionId;
    const row = el(drillable ? 'button' : 'div', 'child-row');
    if (drillable) row.type = 'button';
    row.dataset.itemid = rec.itemId;
    const running = rec.status === 'inProgress';
    row.append(el('span', subagentDotClass(rec.status)));
    const main = el('div', 'mcp-main');
    main.append(el('div', 'mcp-name', subagentTitle(rec)));
    const bits = [subagentStatusWord(rec.status), subagentSub(rec)].filter(Boolean).join(' · ');
    main.append(el('div', 'mcp-meta', bits));
    // Reminders carry their verdict in the sub line already — a second copy
    // below would read like a rendering bug.
    if (rec.result?.summary && rec.status !== 'inProgress' && rec.kind !== 'reminderChild') {
      main.append(el('div', 'child-result', rec.result.summary));
    }
    if (running && rec.liveText) {
      const live = el('div', 'child-live', rec.liveText.slice(-240));
      live.dataset.role = 'agent-live';
      main.append(live);
    }
    row.append(main);
    if (rec.kind === 'workflow' && Array.isArray(rec.children) && rec.children.length) {
      row.append(el('span', 'child-chev', `${rec.children.length}›`));
    } else if (drillable) {
      row.append(el('span', 'child-chev', '›'));
    }
    if (drillable) {
      row.addEventListener('click', () => {
        if (rec.kind === 'workflow' && Array.isArray(rec.children) && rec.children.length) {
          agentStack.push({ type: 'workflow', label: subagentTitle(rec), rec });
        } else {
          const frame = {
            type: 'item', itemId: rec.itemId, label: subagentTitle(rec),
            drill: null, error: null, liveText: '', sendOpen: false,
            confirming: null, busy: null, note: null,
          };
          agentStack.push(frame);
          void reloadAgentDrill(frame);
        }
        renderAgents();
      });
    }
    return row;
  }

  function renderAgentDrillHead(content, frame, statusText) {
    const head = el('div', 'agent-drill-head');
    const back = el('button', 'btn ghost sm', '‹ กลับ');
    back.type = 'button';
    back.addEventListener('click', () => {
      agentStack.pop();
      renderAgents();
    });
    head.append(back);
    head.append(el('div', 'agent-drill-title', frame.label));
    if (statusText) {
      const pill = el('span', 'panel-sub', statusText);
      pill.dataset.role = 'agents-status';
      head.append(pill);
    }
    if (frame.type !== 'workflow') {
      const refresh = el('button', 'btn ghost sm', '⟳');
      refresh.type = 'button';
      refresh.title = 'อ่านใหม่';
      refresh.addEventListener('click', () => void reloadAgentDrill(frame));
      head.append(refresh);
    }
    // Record-backed drills pop out into their own live window — the child
    // session on its own page, polling the same drill endpoint. The shell
    // opens it as a real window (createWebViewWith); anywhere else it is a
    // normal tab, and a blocked popup says so instead of failing silently.
    if (frame.type === 'item') {
      const pop = el('button', 'btn ghost sm', '⧉');
      pop.type = 'button';
      pop.title = 'เปิดหน้าต่างใหม่';
      pop.dataset.role = 'agents-popout';
      pop.addEventListener('click', () => {
        const win = window.open(childWindowUrl(chatId, { itemId: frame.itemId }), '_blank');
        if (!win) {
          frame.note = { ok: false, text: 'เปิดหน้าต่างไม่ได้ — popup ถูกบล็อก' };
          if (agentTop() === frame) renderAgents();
        }
      });
      head.append(pop);
    }
    content.append(head);
  }

  function renderAgentWorkflow(content, frame) {
    renderAgentDrillHead(content, frame, '');
    const list = el('div', 'panel-list');
    for (const c of frame.rec.children || []) {
      const row = el('div', 'mcp-row');
      row.append(el('span', subagentDotClass(c.status === 'succeeded' ? 'completed' : c.status)));
      const main = el('div', 'mcp-main');
      main.append(el('div', 'mcp-name', c.label || c.childId || '?'));
      const bits = [c.status || '', c.phase || '', c.durationMs != null ? `${(c.durationMs / 1000).toFixed(1)}s` : '']
        .filter(Boolean).join(' · ');
      main.append(el('div', 'mcp-meta', bits));
      row.append(main);
      list.append(row);
    }
    content.append(list);
  }

  function renderAgentDrill(content, frame) {
    const rec = agentRecordFor(frame);
    renderAgentDrillHead(content, frame, rec ? subagentStatusWord(rec.status) : '');
    if (frame.type === 'item') {
      const actions = el('div', 'agent-actions');
      actions.dataset.role = 'agents-actions';
      paintAgentActions(actions, frame, rec);
      content.append(actions);
      if (frame.sendOpen) content.append(renderAgentSendForm(frame));
      if (frame.note) {
        content.append(el('div', frame.note.ok ? 'panel-sub' : 'panel-sub warn', frame.note.text));
      }
    }
    const items = el('div', 'panel-list');
    items.dataset.role = 'agents-items';
    paintAgentItems(items, frame);
    content.append(items);
    armAgentPoll(frame);
  }

  function paintAgentItems(items, frame) {
    items.replaceChildren();
    if (frame.error) {
      items.append(el('div', 'panel-empty', frame.error));
      return;
    }
    if (!frame.drill) {
      items.append(el('div', 'panel-empty', 'กำลังอ่าน…'));
      return;
    }
    // A gone child session still drills into its record detail — the read
    // failure rides along as context, never as a bare error page.
    if (frame.drill.readError) {
      items.append(el('div', 'panel-sub warn', `อ่าน session ไม่ได้ (${frame.drill.readError}) — แสดงข้อมูลที่เหลืออยู่`));
    }
    if (frame.drill.droppedFromHead) {
      items.append(el('div', 'panel-sub', `…ข้าม ${frame.drill.droppedFromHead} รายการแรก`));
    }
    if (frame.drill.mode === 'none') {
      items.append(el('div', 'panel-empty', 'ยังไม่มีประวัติให้อ่าน'));
    }
    for (const it of frame.drill.items || []) items.append(renderAgentDrillItem(it));
    if (frame.liveText) {
      const live = el('div', 'drill-live');
      live.dataset.role = 'agent-drill-live';
      live.append(el('span', 'kind-tag live', 'สด'));
      live.append(el('span', 'drill-text', frame.liveText.slice(-500)));
      items.append(live);
    }
  }

  function renderAgentDrillItem(it) {
    const nested = DRILLABLE_CHILD_KINDS.has(it.kind) && it.childSessionId;
    const node = el(nested ? 'button' : 'div', 'drill-row');
    if (nested) node.type = 'button';
    node.append(el('span', subagentDotClass(it.status)));
    const main = el('div', 'mcp-main');
    const first = el('div', 'drill-first');
    first.append(el('span', 'kind-tag', drillKindTag(it.kind)));
    if (it.tool) first.append(el('span', 'drill-tool', it.tool));
    else if (it.agentPath || it.role) first.append(el('span', 'drill-tool', it.agentPath || it.role));
    main.append(first);
    const preview = drillItemPreview(it);
    if (preview) main.append(el('div', 'drill-text', preview));
    node.append(main);
    if (nested) {
      node.append(el('span', 'child-chev', '›'));
      node.addEventListener('click', () => {
        const frame = {
          type: 'sess', childSessionId: it.childSessionId,
          label: it.agentPath || it.role || 'subagent',
          drill: null, error: null, liveText: '',
        };
        agentStack.push(frame);
        renderAgents();
        void reloadAgentDrill(frame);
      });
    }
    return node;
  }

  /** Owner verbs for an item drill. Rebuilt on record change — except while
   * the user is mid-gesture (confirm/send/busy), when it is left untouched. */
  function paintAgentActions(actions, frame, rec) {
    actions.replaceChildren();
    // Mid-gesture the chrome freezes: a record update must not swap the
    // buttons (or the confirm row) out from under the cursor — except the
    // confirm row itself, which is painted below once and stays put.
    if (frame.busy || frame.sendOpen) return;
    if (frame.confirming === 'stop') {
      const ask = el('span', 'panel-sub warn', 'หยุด child นี้?');
      const yes = el('button', 'btn sm danger', 'หยุดเลย');
      yes.type = 'button';
      yes.addEventListener('click', () => void sendAgentCommand(frame, 'stop', { reason: 'หยุดจากแผงขวา' }));
      const no = el('button', 'btn ghost sm', 'ยกเลิก');
      no.type = 'button';
      no.addEventListener('click', () => {
        frame.confirming = null;
        renderAgents();
      });
      actions.append(ask, yes, no);
      return;
    }
    for (const action of subagentActions(rec)) {
      const btn = el('button', 'btn ghost sm', SUBAGENT_ACTION_LABEL[action]);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        if (action === 'stop') {
          frame.confirming = 'stop';
          renderAgents();
        } else if (action === 'send') {
          frame.sendOpen = true;
          frame.note = null;
          renderAgents();
          agentsBody.querySelector('.agent-send-input')?.focus();
        } else {
          void sendAgentCommand(frame, action, {});
        }
      });
      actions.append(btn);
    }
  }

  function renderAgentSendForm(frame) {
    const form = el('form', 'agent-send-form');
    const input = document.createElement('input');
    input.className = 'agent-send-input';
    input.type = 'text';
    input.placeholder = 'พิมพ์ข้อความถึง child…';
    input.value = frame.sendDraft || '';
    input.setAttribute('aria-label', 'ข้อความถึง child');
    // The poll repaints around this form, never through it — but a loud
    // refresh rebuilds everything, so the draft also lives on the frame.
    input.addEventListener('input', () => {
      frame.sendDraft = input.value;
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        // The document Esc handler opens the turn stop-confirm while a turn
        // runs — without this, closing the form also asks to stop the turn.
        ev.stopPropagation();
        frame.sendOpen = false;
        renderAgents();
      }
    });
    const send = el('button', 'btn sm primary', 'ส่ง');
    send.type = 'submit';
    const cancel = el('button', 'btn ghost sm', 'ยกเลิก');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      frame.sendOpen = false;
      renderAgents();
    });
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void sendAgentCommand(frame, 'send', { body: input.value });
    });
    form.append(input, send, cancel);
    return form;
  }

  async function sendAgentCommand(frame, action, extra) {
    if (frame.busy || !chatId) return;
    if (action === 'send' && !String(extra.body ?? '').trim()) {
      frame.note = { ok: false, text: 'พิมพ์ข้อความก่อนส่ง' };
      renderAgents();
      agentsBody.querySelector('.agent-send-input')?.focus();
      return;
    }
    frame.busy = action;
    frame.note = null;
    renderAgents();
    try {
      await api(`/api/chats/${encodeURIComponent(chatId)}/subagents/${encodeURIComponent(frame.itemId)}/command`, {
        method: 'POST',
        body: { action, ...extra },
      });
      frame.confirming = null;
      if (action === 'send') {
        frame.sendOpen = false;
        frame.sendDraft = '';
        frame.note = { ok: true, text: 'ส่งแล้ว — child จะเห็นในรอบถัดไป' };
      } else {
        frame.note = null;
      }
    } catch (err) {
      frame.note = { ok: false, text: `สั่งไม่ได้: ${err?.message || err}` };
    } finally {
      frame.busy = null;
    }
    // The repaint rides the item SSE the verb triggers; this render only
    // settles the gesture chrome (confirm/form/note) on cached drill data.
    if (agentTop() === frame) renderAgents();
  }

  async function reloadAgentDrill(frame, { quiet = false } = {}) {
    try {
      const url = frame.type === 'item'
        ? `/api/chats/${encodeURIComponent(chatId)}/subagents/${encodeURIComponent(frame.itemId)}`
        : `/api/chats/${encodeURIComponent(chatId)}/child-session/${encodeURIComponent(frame.childSessionId)}`;
      const drill = await api(url);
      frame.drill = drill;
      frame.error = null;
    } catch (err) {
      if (!quiet) frame.error = err?.message || 'อ่านไม่ได้';
    }
    if (agentTop() !== frame || !isOpen()) return;
    if (quiet) {
      syncAgentDrillItems(frame);
      armAgentPoll(frame);
    } else {
      renderAgents();
    }
  }

  /** Quiet poll repaint: items + status + actions only. The send form owns
   * its own subtree and focus — rebuilding it every 2.5s would eat keystrokes. */
  function syncAgentDrillItems(frame) {
    const content = agentsBody.querySelector('[data-role="agents-content"]');
    const items = content?.querySelector('[data-role="agents-items"]');
    if (items) paintAgentItems(items, frame);
    syncAgentDrillChrome(frame);
  }

  function syncAgentDrillChrome(frame) {
    const rec = agentRecordFor(frame);
    const pill = agentsBody.querySelector('[data-role="agents-status"]');
    if (pill) pill.textContent = rec ? subagentStatusWord(rec.status) : '';
    const actions = agentsBody.querySelector('[data-role="agents-actions"]');
    if (actions && !frame.busy && !frame.confirming && !frame.sendOpen) {
      paintAgentActions(actions, frame, rec);
    }
  }

  function armAgentPoll(frame) {
    stopAgentPoll();
    if (frame.type === 'workflow' || frame.error) return;
    const itemsRunning = (frame.drill?.items || []).some((it) => it.status === 'inProgress');
    const sessionRunning = frame.drill?.session?.status === 'running';
    const recRunning = String(agentRecordFor(frame)?.status) === 'inProgress';
    // The registry leads the drill (frames land before the next read), so a
    // running record alone keeps the poll alive; a drill with no items yet
    // (!frame.drill) also polls — the first read may have raced the spawn.
    if (frame.drill && !itemsRunning && !sessionRunning && !recRunning) return;
    agentPollTimer = setInterval(() => {
      if (!isOpen() || agentTop() !== frame) return stopAgentPoll();
      void reloadAgentDrill(frame, { quiet: true });
    }, 2500);
  }

  function render() {
    if (!isOpen()) return;
    void ensurePricing().then(() => {
      if (isOpen()) renderCost();
    });
    renderSession();
    renderCost();
    renderGoal();
    renderTasks();
    renderAgents();
  }

  return {
    isOpen,
    openChat: () => chatId,
    setOpen,
    toggle: () => setOpen(!isOpen()),
    reveal,

    /** Chat switch: point every section at the new chat. */
    showChat(id) {
      chatId = id;
      agentStack = [];
      stopAgentPoll();
      render();
    },

    /** MSP session id for the identity rows (from the full chat payload). */
    showSession(id, msp) {
      const prev = sessionByChat.get(id) || {};
      // Authoritative from the full chat payload — including an explicit
      // null (rotation/brick-guard clears), never a stale keep.
      sessionByChat.set(id, { ...prev, msp: msp ?? null });
      if (id === chatId) renderSession();
    },

    /** Live turn id for the identity rows (null once the turn settles). */
    applyTurn(id, turnId) {
      const prev = sessionByChat.get(id) || {};
      sessionByChat.set(id, { ...prev, turn: turnId ?? null });
      if (id === chatId) renderSession();
    },

    applyCtx(id, tokens, model) {
      costByChat.set(id, { tokens: tokens ?? null, model: model ?? costByChat.get(id)?.model ?? null });
      if (id === chatId) renderCost();
    },

    applyModel(id, model) {
      const prev = costByChat.get(id) || {};
      costByChat.set(id, { ...prev, model: model ?? prev.model ?? null });
      if (id === chatId) renderCost();
    },

    applyGoal(id, goal) {
      goalByChat.set(id, goal ?? null);
      if (id === chatId) renderGoal();
    },

    applyPlan(id, entries) {
      planByChat.set(id, Array.isArray(entries) ? entries : []);
      if (id === chatId) renderTasks();
    },

    applyAgents(id, map) {
      agentsByChat.set(id, new Map(map || []));
      if (id !== chatId) return;
      const top = agentTop();
      if (!top) {
        renderAgents();
        return;
      }
      // A drill is open: refresh counts + header chrome around the open
      // frame — never the items or the send form mid-gesture.
      const counts = agentsBody.querySelector('[data-role="agents-counts"]');
      if (counts) {
        const fresh = renderAgentCounts(agentRecords());
        fresh.dataset.role = 'agents-counts';
        counts.replaceWith(fresh);
      }
      const recs = agentRecords();
      const running = recs.filter((r) => String(r.status) === 'inProgress').length;
      summaryLine(agentsBody, recs.length ? `${running}/${recs.length}` : '');
      if (top.type !== 'workflow') syncAgentDrillChrome(top);
    },

    /** SSE `subagent_delta` — patch the streaming line in place; a full
     * list re-render per chunk would rebuild the rows out from under clicks. */
    applyAgentDelta(id, itemId, text) {
      const rec = agentsByChat.get(id)?.get(String(itemId));
      if (rec) {
        rec.liveText = String(text || '');
        rec.updatedAt = Date.now();
      }
      if (id !== chatId || !isOpen()) return;
      const content = agentsBody.querySelector('[data-role="agents-content"]');
      if (!content) return;
      const top = agentTop();
      if (top?.type === 'item' && top.itemId === String(itemId)) {
        top.liveText = String(text || '');
        let box = content.querySelector('[data-role="agent-drill-live"] .drill-text');
        if (!box) {
          // First delta for this drill — the items repaint picks the box up.
          const items = content.querySelector('[data-role="agents-items"]');
          if (items) paintAgentItems(items, top);
          box = content.querySelector('[data-role="agent-drill-live"] .drill-text');
        } else {
          box.textContent = String(text || '').slice(-500);
        }
        return;
      }
      if (top) return;
      const row = content.querySelector(`[data-itemid="${String(itemId).replace(/"/g, '\\"')}"]`);
      if (!row) {
        renderAgents();
        return;
      }
      let live = row.querySelector('[data-role="agent-live"]');
      if (!live) {
        live = el('div', 'child-live', '');
        live.dataset.role = 'agent-live';
        row.querySelector('.mcp-main')?.append(live);
      }
      live.textContent = String(text || '').slice(-240);
    },
  };
}
