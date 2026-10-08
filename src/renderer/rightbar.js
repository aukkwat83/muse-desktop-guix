// Right bar: session identity + cost (THB). Goal, tasks and subagents live in
// the live overview popup (overview-panel.js), not here — the rail holds no
// turn children since 1.1.30, only the session that owns them.
//
// Hidden by default — the hamburger in the head bar opens it. Each section
// is a <details> block so collapse is native + keyboard-accessible; data
// arrives by push from app.js (same SSE the pills already ride) plus one
// fetch: /api/pricing once. (The SCB tags+insights section was removed
// 2026-09-22 — sidebar [APxxxx] chips and title prefixes are untouched.)
//
// This module also owns the shared child/goal/task view-model (titles,
// status words, the popup's union rows): pure functions with no top-level
// DOM touch, imported by the popup, the child page and the node suite.

import { setIcon } from './icons.js?v=1.0.0';

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
    case 'completed': return { glyph: '✓', cls: 'task-glyph done' }; // tofu-ok: legacy data contract, paints use taskIcon
    case 'in_progress': return { glyph: '→', cls: 'task-glyph run' }; // tofu-ok: legacy data contract, paints use taskIcon
    case 'cancelled': return { glyph: '✕', cls: 'task-glyph cancel' }; // tofu-ok: legacy data contract, paints use taskIcon
    default: return { glyph: '○', cls: 'task-glyph idle' }; // tofu-ok: legacy data contract, paints use taskIcon
  }
}

/**
 * Vector twin of taskGlyph: the icons.js name each task status paints.
 * taskGlyph stays the legacy data contract (pinned); every paint uses this.
 * Pure — the node suite pins the mapping.
 */
export function taskIcon(status) {
  switch (String(status || '')) {
    case 'completed': return 'check';
    case 'in_progress': return 'arrowRight';
    case 'cancelled': return 'x';
    default: return 'circle';
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

/**
 * Effective drill status from a native-log run envelope ({state, terminal}
 * off the drill endpoint). The latest run is ground truth in BOTH
 * directions: an active run reads running even with no rows yet, and a
 * terminal run reads its outcome (completed/failed/cancelled) even over a
 * fossil inProgress record — the record only leads when there is no native
 * signal (null). Shared by the popup drill and the child page so the two
 * surfaces can never disagree about the same run.
 */
export function nativeRunStatus(nativeRun) {
  if (!nativeRun || typeof nativeRun !== 'object') return null;
  if (nativeRun.state === 'running') return 'inProgress';
  if (nativeRun.state === 'terminal') {
    const t = String(nativeRun.terminal || '');
    if (t === 'failed' || t === 'cancelled' || t === 'completed') return t;
    // Unknown outcomes pass through for the status word to show raw —
    // never mislabelled completed; empty means the run just ended.
    return t || 'completed';
  }
  return null;
}

/** The wire's one-size line for every reminder row — never shown as a topic. */
const GENERIC_REMINDER_FALLBACK = 'Reminder child session';

export function subagentTitle(rec) {
  if (!rec || typeof rec !== 'object') return 'child';
  // Human topic first: the per-topic header the CLI shows (task name, title,
  // objective), then identity (role/path). A row headlined "research" tells
  // nothing when every sibling says the same; the objective is the heading,
  // the role trails in the sub line. The wire's one-size reminder line is
  // never a title — a bare reminder falls back to its agent id, then the
  // kind word, so real reminder children stay distinct, never generic.
  const text = (v) => (typeof v === 'string' && v.trim() ? v : null);
  return text(rec.taskName) || text(rec.title) || text(rec.topic) || text(rec.objective)
    || text(rec.role) || text(rec.agentPath) || text(rec.reminderAgentId) || text(rec.entryId)
    || (rec.fallbackText !== GENERIC_REMINDER_FALLBACK ? text(rec.fallbackText) : null)
    || (rec.kind === 'reminderChild' ? 'reminder' : text(rec.kind))
    || 'child';
}

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
  // The objective trails only when the headline is not already it — titles
  // now lead with the topic, so an unconditional push would print it twice.
  if (rec.objective && rec.objective !== subagentTitle(rec)
    && (rec.role || (!rec.agentPath && !rec.taskName && !rec.title && !rec.topic))) {
    bits.push(rec.objective);
  }
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

/**
 * Popup Subagents section rows (1.1.30): the UNION of the live turn's agent
 * tool rows and the server's wire children, deduped on the durable link the
 * server resolves (tool.agentLink → registry itemId). No cap — the popup is
 * the full view now that the rail holds no children — and no folding: every
 * system reminder lists individually and drills into its own session like
 * any other child. Tools without a durable link (model-side Agent rows, or
 * a link the registry does not know) still list, honestly undrillable —
 * never invent a drill target for them.
 *
 * Pure view-model: the popup paints the descriptors. Shapes:
 *   { kind: 'empty' } — nothing anywhere
 *   { kind: 'union', rows } — rows of { type: 'child', rec }
 *     (registry children, newest first) then { type: 'tool', tool }
 *     (unlinked live-turn tools, in turn order).
 */
export function overviewSubagentRows(agentTools, wireRecs) {
  const tools = Array.isArray(agentTools) ? agentTools : [];
  const recs = [...(wireRecs || [])].sort((a, b) => (b?.updatedAt || 0) - (a?.updatedAt || 0));
  const byId = new Map();
  for (const r of recs) {
    if (r?.itemId != null) byId.set(String(r.itemId), r);
  }
  const rows = [];
  for (const rec of recs) rows.push({ type: 'child', rec });
  for (const tool of tools) {
    const link = tool?.agentLink != null ? String(tool.agentLink) : null;
    if (link && byId.has(link)) continue; // the registry row already carries it
    rows.push({ type: 'tool', tool });
  }
  if (!rows.length) return { kind: 'empty' };
  return { kind: 'union', rows };
}

/**
 * running/total over union rows — the ONE count behind the agents chip and
 * the popup header, so the two can never disagree. Children read the
 * registry status; unlinked tool rows read their captured `running` flag
 * (falling back to the raw status for foreign shapes).
 */
export function unionSubagentCounts(sec) {
  let running = 0;
  const rows = sec?.kind === 'union' && Array.isArray(sec.rows) ? sec.rows : [];
  for (const row of rows) {
    if (row?.type === 'child') {
      if (String(row.rec?.status) === 'inProgress') running += 1;
    } else if (row?.type === 'tool') {
      const t = row.tool || {};
      if (t.running === true) running += 1;
      else if (t.running == null && ['in_progress', 'inProgress', 'pending'].includes(String(t.status))) {
        running += 1;
      }
    }
  }
  return { running, total: rows.length };
}

/** Provenance tag for one union row — reminders stay visibly reminders. */
export function childKindTag(kind) {
  switch (String(kind || '')) {
    case 'subagent': return 'subagent';
    case 'native': return 'native';
    case 'reminderChild': return 'reminder';
    case 'workflow': return 'workflow';
    default: return String(kind || '?');
  }
}

/**
 * Display provenance for one union row / drill head — Thai UI words for the
 * English wire `kind`. The internal kind on every record stays untouched;
 * only the painted label is localized (reminders read as system work).
 */
export function childKindLabel(kind) {
  switch (String(kind || '')) {
    case 'subagent': return 'เอเจนต์ย่อย';
    case 'native': return 'เนทีฟ';
    case 'reminderChild': return 'งานระบบ';
    case 'workflow': return 'เวิร์กโฟลว์';
    default: return String(kind || '?');
  }
}

export function drillKindTag(kind) {
  switch (String(kind || '')) {
    case 'agentMessage': return 'ตอบ';
    case 'userMessage': return 'ถาม';
    case 'toolCall': return 'tool';
    case 'subagent': return 'subagent';
    case 'workflow': return 'workflow';
    case 'reasoning': return 'คิด';
    case 'terminal': return 'จบ';
    default: return String(kind || '?');
  }
}

export function drillItemPreview(it) {
  if (it.text) return it.text;
  if (it.result?.summary) return it.result.summary;
  if (it.tool) return `${it.tool}${it.fallbackText ? ` → ${it.fallbackText}` : ''}`; // tofu-ok: pinned prose arrow in drill preview text
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
  stop: 'หยุด',
  resume: 'ทำต่อ',
  send: 'ส่งข้อความ',
};

/** Vector twin of the action labels — paints mount icon + label together. */
export const SUBAGENT_ACTION_ICON = {
  stop: 'stop',
  resume: 'play',
  send: 'mail',
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
  /** chatId → { msp, turn } identity row inputs (MSP session + live turn). */
  const sessionByChat = new Map();

  let chatId = null;
  let pricing = null;
  let pricingFailed = false;

  aside.replaceChildren();

  const head = el('div', 'rb-head');
  head.append(el('div', 'rb-title', 'แผงขวา'));
  const close = el('button', 'btn ghost sm');
  setIcon(close, 'x', 'ico ico-sm');
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

  function setOpen(open) {
    document.body.classList.toggle('rb-open', open);
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

  /** Open the rail and scroll a section into view (session/cost only —
   * goal/tasks/agents chips open the overview popup, never the rail). */
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
        const btn = el('button', 'rb-copy');
        setIcon(btn, 'copy', 'ico ico-sm');
        btn.type = 'button';
        btn.title = `คัดลอก ${label}`;
        btn.setAttribute('aria-label', `คัดลอก ${label}`);
        btn.addEventListener('click', async () => {
          // Feedback swaps the VECTOR, never textContent — the restore is the
          // same call, so a slow click can never strand a text glyph.
          const ok = await copyText(value);
          setIcon(btn, ok ? 'check' : 'alert', 'ico ico-sm');
          btn.classList.toggle('is-ok', !!ok);
          btn.classList.toggle('is-fail', !ok);
          setTimeout(() => {
            if (!btn.isConnected) return;
            setIcon(btn, 'copy', 'ico ico-sm');
            btn.classList.remove('is-ok', 'is-fail');
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

  function render() {
    if (!isOpen()) return;
    void ensurePricing().then(() => {
      if (isOpen()) renderCost();
    });
    renderSession();
    renderCost();
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
  };
}
