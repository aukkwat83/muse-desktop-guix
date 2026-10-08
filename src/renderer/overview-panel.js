// Thread overview popup: goal + tasks + subagents for ONE chat, live.
//
// Since 1.1.30 this is the only place that renders turn children — the right
// rail holds session identity + cost, and every goal/tasks/agents chip (plus
// the transcript's inline child-activity blocks) opens this popup. Sections:
//
//   goal — objective, percent, status, current/next work, pause/resume;
//   tasks — the live plan checklist (persisted transcript plan rehydrates it
//     after the turn settles);
//   subagents — the UNION of the live turn's agent tool rows and the
//     server's wire children, every child (system reminders included)
//     drilling into its own live session.
//
// Updates ride the same SSE app.js already handles (goal/plan/subagent/
// subagent_delta); the popup never fetches except for drill-down reads and
// user commands, and command repaints ride the broadcast, never the reply.
// Live repaints preserve scroll and never steal focus.

import { closePopover, openPanel } from './popover.js?v=0.5.1';
import {
  childWindowUrl,
  drillItemPreview,
  drillKindTag,
  goalControlFor,
  goalStatusWord,
  overviewSubagentRows,
  subagentActions,
  subagentDotClass,
  SUBAGENT_ACTION_ICON,
  SUBAGENT_ACTION_LABEL,
  subagentStatusWord,
  subagentSub,
  subagentTitle,
  childKindLabel,
  nativeRunStatus,
  taskGlyph,
  taskIcon,
  taskStatusWord,
  todoFoldLabel,
  todoFocusWindow,
  unionSubagentCounts,
} from './rightbar.js?v=1.2.0';
import { setIcon, setIconLabel } from './icons.js?v=1.0.0';

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
 * Latest persisted plan in a transcript, newest message first. The live plan
 * dies with its turn view on settle; the transcript's meta.plan (written by
 * settleTurn) is what rehydrates the checklist after. A persisted [] is
 * authoritative too — the agent cleared the list, older plans stay buried.
 * Pure — node suite.
 */
export function latestPlanFromMessages(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const p = messages[i]?.meta?.plan;
    if (Array.isArray(p)) return p;
  }
  return null;
}

/**
 * What the tasks section shows: the live plan while the turn runs, else the
 * latest persisted one. Only null/undefined (no turn view, or no plan event
 * yet) falls back — an explicit live [] clears the list instead of
 * resurrecting history. Pure — node suite.
 */
export function resolvePlan(livePlan, messages) {
  if (Array.isArray(livePlan)) return livePlan;
  return latestPlanFromMessages(messages) || [];
}

/** Re-exported for suite compat — the canonical home is rightbar.js. */
export { childKindTag } from './rightbar.js?v=1.2.0';


const DRILL_POLL_MS = 2500;
/** Item kinds that nest a readable child session one level deeper. */
const DRILLABLE_CHILD_KINDS = new Set(['subagent', 'workflow', 'reminderChild']);

/**
 * Stay-alive rule for one drill frame's 2.5s poll — any running signal
 * keeps it: live items, a running session, an active native-log run (even
 * with no tool rows yet), or a running registry record. A terminal native
 * run stops it unless the registry still claims liveness — that refresh
 * is how a resumed run is discovered (the heading already shows the
 * terminal outcome; the poll only watches for newer evidence). A landed
 * drill stops it. Pure — the node suite pins the matrix.
 */
export function drillShouldPoll(frame, recStatus) {
  if (!frame || frame.type === 'workflow' || frame.error) return false;
  if (!frame.drill) return true; // the first read may have raced the spawn
  const items = frame.drill.items || [];
  if (items.some((it) => it.status === 'inProgress')) return true;
  if (frame.drill.session?.status === 'running') return true;
  if (frame.drill.nativeRun?.state === 'running') return true;
  return String(recStatus || '') === 'inProgress';
}

export function createOverviewPanel({ api }) {
  let handle = null;
  let root = null;
  let chatId = null;
  let chatTitle = '';
  let goal = null;
  /** No live agent for the bound chat — goal controls render disabled. */
  let goalCold = false;
  let plan = [];
  /** itemId → server subagent record (the popup's registry mirror). */
  let agents = new Map();
  /** Live-turn agent tool descriptors from app.js ({id,title,state,agentLink}). */
  let toolRows = [];
  /** Drill stack: { type:'workflow', label, rec } |
   * { type:'item'|'sess', itemId|childSessionId, label, drill, error,
   *   liveText, sendOpen, confirming, busy, note, sendDraft } */
  let stack = [];
  let pollTimer = null;

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function top() {
    return stack.length ? stack[stack.length - 1] : null;
  }

  /** Live registry record behind an item drill frame (null for sess frames). */
  function recordFor(frame) {
    if (!frame || frame.type !== 'item') return null;
    return agents.get(frame.itemId) || null;
  }

  function isOpen() {
    return !!handle?.isOpen();
  }

  function close() {
    stopPoll();
    closePopover();
  }

  // ------------------------------------------------------------ sections

  function sectionHead(title, extra) {
    const head = el('div', 'ov-sect-head');
    head.append(el('div', 'panel-sect', title));
    if (extra) head.append(extra);
    return head;
  }

  function paintGoal(box) {
    if (!goal) {
      box.append(el('div', 'panel-empty', 'แชทนี้ยังไม่มี goal (ตั้งใน CLI)'));
      return;
    }
    const pct = clampPct(goal.percentComplete);
    const control = goalControlFor(goal.status);
    const btn = control && control !== 'done' ? el('button', 'btn ghost sm') : null;
    if (btn) {
      setIconLabel(btn, control === 'pause' ? 'pause' : 'play', control === 'pause' ? 'หยุดชั่วคราว' : 'ทำต่อ', 'ico ico-sm');
      btn.type = 'button';
      btn.dataset.focusKey = 'goal-btn';
      // A rehydrated goal on a cold chat shows state, not verbs — the POST
      // would only 409 (goalCommand backstop), so never pretend it works.
      btn.disabled = goalCold;
      btn.title = goalCold ? 'รอ agent spawn ก่อน (prompt สักครั้ง)' : '';
      btn.addEventListener('click', () => void driveGoal(control, btn));
    } else if (control === 'done') {
      const mark = el('span', 'rb-goal-done');
      setIconLabel(mark, 'check', 'เสร็จ', 'ico ico-sm');
      mark.title = 'goal เสร็จแล้ว';
      box.append(mark);
    }
    box.append(sectionHead(`goal · ${pct}% · ${goalStatusWord(goal.status)}`, btn));
    const g = el('div', 'goal-block');
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
    box.append(g);
  }

  /** POST the verb; the repaint rides the goalChanged SSE, never the reply. */
  async function driveGoal(action, btn) {
    if (!chatId) return;
    if (btn) btn.disabled = true;
    try {
      await api(`/api/chats/${encodeURIComponent(chatId)}/goal`, { method: 'POST', body: { action } });
    } catch (err) {
      if (btn) btn.title = `สั่งไม่ได้: ${err?.message || err}`;
    } finally {
      // A success repaint rides the goal SSE, but the button must never
      // stay disabled if that frame is slow — restore the cold rule now.
      if (btn?.isConnected) btn.disabled = goalCold;
    }
  }

  /** One Mcode-style todo row: glyph + clamped text, full text on hover. */
  function taskRow(t) {
    const status = String(t?.status || 'pending');
    const { cls } = taskGlyph(status);
    const row = el('div', 'mcp-row task-row');
    const dot = el('span', cls);
    setIcon(dot, taskIcon(status), 'ico ico-sm');
    dot.setAttribute('aria-hidden', 'true');
    row.append(dot);
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

  function paintTasks(box) {
    const entries = Array.isArray(plan) ? plan : [];
    const done = entries.filter((e) => String(e?.status) === 'completed').length;
    box.append(sectionHead(`tasks · เสร็จ ${done}/${entries.length}`, null));
    if (!entries.length) {
      box.append(el('div', 'panel-empty', 'ยังไม่มี tasks — ดูรายการล่าสุดหลังเทิร์นจบ'));
      return;
    }
    const win = todoFocusWindow(entries);
    const fold = (items, side) => {
      const d = document.createElement('details');
      d.className = 'todo-fold';
      d.dataset.foldKey = `tasks:${side}`;
      const s = document.createElement('summary');
      s.className = 'todo-fold-summary';
      s.textContent = todoFoldLabel(items, side);
      d.append(s);
      for (const t of items) d.append(taskRow(t));
      return d;
    };
    if (win.compact && win.preceding.length) box.append(fold(win.preceding, 'preceding'));
    for (const t of win.focus) box.append(taskRow(t));
    if (win.compact && win.following.length) box.append(fold(win.following, 'following'));
  }

  // ---------------------------------------------------------- subagents

  function childDrillable(rec) {
    // Native children drill into their folded detail view (no MSP session —
    // the honest fallback, not a read); item children drill into their own
    // session; workflow folds open inline. Anything else is a static row.
    return rec?.kind === 'native'
      || (rec?.kind === 'workflow' && Array.isArray(rec.children) && rec.children.length)
      || !!rec?.childSessionId;
  }

  function paintChildRow(rec) {
    const drillable = childDrillable(rec);
    const row = el(drillable ? 'button' : 'div', 'child-row ov-child');
    if (drillable) {
      row.type = 'button';
      row.dataset.focusKey = `child:${rec.itemId}`;
    }
    row.dataset.itemid = rec.itemId;
    row.append(el('span', subagentDotClass(rec.status)));
    const main = el('div', 'mcp-main');
    const first = el('div', 'drill-first');
    first.append(el('span', 'kind-tag', childKindLabel(rec.kind)));
    const title = el('div', 'mcp-name ov-title', subagentTitle(rec));
    title.title = subagentTitle(rec);
    main.append(first, title);
    const bits = [subagentStatusWord(rec.status), subagentSub(rec)].filter(Boolean).join(' · ');
    if (bits) {
      const meta = el('div', 'mcp-meta', bits);
      meta.title = bits;
      main.append(meta);
    }
    if (rec.result?.summary && rec.status !== 'inProgress' && rec.kind !== 'reminderChild') {
      main.append(el('div', 'child-result', rec.result.summary));
    }
    if (String(rec.status) === 'inProgress' && rec.liveText) {
      const live = el('div', 'child-live', String(rec.liveText).slice(-240));
      live.dataset.role = 'ov-live';
      main.append(live);
    }
    row.append(main);
    if (rec.kind === 'workflow' && Array.isArray(rec.children) && rec.children.length) {
      const chev = el('span', 'child-chev');
      // Count first, chevron after: the number stays a text node (no
      // createTextNode — the helper covers the fake-DOM suites too).
      const count = el('span', 'child-count', String(rec.children.length));
      setIcon(chev, 'chevRight', 'ico ico-sm');
      chev.prepend(count);
      row.append(chev);
    } else if (drillable) {
      const chev = el('span', 'child-chev');
      setIcon(chev, 'chevRight', 'ico ico-sm');
      row.append(chev);
    }
    if (drillable) {
      row.addEventListener('click', () => {
        if (rec.kind === 'workflow' && Array.isArray(rec.children) && rec.children.length) {
          stack.push({ type: 'workflow', itemId: rec.itemId, label: subagentTitle(rec), kind: 'workflow', rec });
          render();
          return;
        }
        openItemFrame(rec.itemId, subagentTitle(rec));
      });
    }
    return row;
  }

  function paintToolRow(tool) {
    // A live-turn agent row with no durable child identity: listed honestly,
    // never drilled — there is no session to read behind it.
    const row = el('div', 'child-row ov-child is-static');
    row.append(el('span', 'dot idle'));
    const main = el('div', 'mcp-main');
    const first = el('div', 'drill-first');
    first.append(el('span', 'kind-tag', 'tool'));
    main.append(first);
    const title = el('div', 'mcp-name ov-title', String(tool?.title || tool?.kind || 'agent'));
    title.title = title.textContent;
    main.append(title);
    main.append(el('div', 'mcp-meta', `${String(tool?.state || tool?.status || '—')} · ไม่มี session ให้เปิด`));
    row.append(main);
    return row;
  }

  function paintSubagents(box) {
    const recs = [...agents.values()];
    const sec = overviewSubagentRows(toolRows, recs);
    // The header counts the same deduped union it lists — the same helper
    // as the agents chip, so the two can never disagree.
    const { running, total } = unionSubagentCounts(sec);
    box.append(sectionHead(`subagents · กำลังรัน ${running} · ทั้งหมด ${total}`, null));
    if (sec.kind === 'empty') {
      box.append(el('div', 'panel-empty', 'ยังไม่มี subagent ในแชทนี้'));
      return;
    }
    const list = el('div', 'ov-agent-list');
    for (const row of sec.rows) {
      list.append(row.type === 'child' ? paintChildRow(row.rec) : paintToolRow(row.tool));
    }
    box.append(list);
  }

  // -------------------------------------------------------------- drill

  function openItemFrame(itemId, label) {
    const frame = {
      type: 'item', itemId: String(itemId), label: label || 'child',
      kind: agents.get(String(itemId))?.kind ?? null,
      drill: null, error: null, liveText: '', sendOpen: false,
      confirming: null, busy: null, note: null, sendDraft: '',
      _recStatus: String(agents.get(String(itemId))?.status || ''),
      _readGen: 0,
    };
    stack.push(frame);
    render();
    void reloadDrill(frame);
  }

  function paintDrillHead(box, frame, statusText) {
    const head = el('div', 'agent-drill-head');
    const back = el('button', 'btn ghost sm');
    setIconLabel(back, 'chevLeft', 'กลับ', 'ico ico-sm');
    back.type = 'button';
    back.dataset.focusKey = 'back';
    back.addEventListener('click', () => {
      stack.pop();
      render();
    });
    head.append(back);
    const kind = frame.type === 'workflow' ? 'workflow' : frame.kind;
    if (kind) head.append(el('span', 'kind-tag', childKindLabel(kind)));
    const title = el('div', 'agent-drill-title', frame.label);
    title.title = frame.label;
    head.append(title);
    if (statusText) {
      const pill = el('span', 'panel-sub', statusText);
      pill.dataset.role = 'ov-status';
      head.append(pill);
    }
    if (frame.type !== 'workflow') {
      const refresh = el('button', 'btn ghost sm');
      setIcon(refresh, 'refresh', 'ico ico-sm');
      refresh.type = 'button';
      refresh.dataset.focusKey = 'refresh';
      refresh.title = 'อ่านใหม่';
      refresh.setAttribute('aria-label', 'อ่านใหม่');
      refresh.addEventListener('click', () => void reloadDrill(frame));
      head.append(refresh);
    }
    if (frame.type === 'item') {
      const pop = el('button', 'btn ghost sm');
      setIcon(pop, 'popout', 'ico ico-sm');
      pop.type = 'button';
      pop.dataset.focusKey = 'popout';
      pop.title = 'เปิดหน้าต่างใหม่';
      pop.setAttribute('aria-label', 'เปิดหน้าต่างใหม่');
      pop.dataset.role = 'ov-popout';
      pop.addEventListener('click', () => {
        const win = window.open(childWindowUrl(chatId, { itemId: frame.itemId }), '_blank');
        if (!win) {
          frame.note = { ok: false, text: 'เปิดหน้าต่างไม่ได้ — popup ถูกบล็อก' };
          if (top() === frame) render();
        }
      });
      head.append(pop);
    }
    box.append(head);
  }

  function paintWorkflow(box, frame) {
    paintDrillHead(box, frame, '');
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
    box.append(list);
  }

  /** Drill status word: a native-log run envelope decides when present
   * (active reads running, terminal reads its outcome — either way over a
   * stale record), else the registry record leads. Same helper as the
   * child page, so both surfaces headline the same run identically. */
  function drillStatusWord(frame, rec) {
    const native = nativeRunStatus(frame.drill?.nativeRun);
    if (native) return subagentStatusWord(native);
    return rec ? subagentStatusWord(rec.status) : '';
  }

  function paintDrill(box, frame) {
    const rec = recordFor(frame);
    if (!frame.kind && rec?.kind) frame.kind = rec.kind; // late-bound provenance
    paintDrillHead(box, frame, drillStatusWord(frame, rec));
    if (frame.type === 'item') {
      const actions = el('div', 'agent-actions');
      actions.dataset.role = 'ov-actions';
      paintActions(actions, frame, rec);
      box.append(actions);
      if (frame.sendOpen) box.append(paintSendForm(frame));
      if (frame.note) {
        box.append(el('div', frame.note.ok ? 'panel-sub' : 'panel-sub warn', frame.note.text));
      }
    }
    const items = el('div', 'panel-list');
    items.dataset.role = 'ov-items';
    paintItems(items, frame);
    box.append(items);
    armPoll(frame);
  }

  function paintItems(items, frame) {
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
    if (frame.drill.notice) {
      items.append(el('div', 'panel-sub', frame.drill.notice));
    }
    if (frame.drill.droppedFromHead) {
      items.append(el('div', 'panel-sub', `…ข้าม ${frame.drill.droppedFromHead} รายการแรก`));
    }
    if (frame.drill.mode === 'none') {
      items.append(el('div', 'panel-empty', 'ยังไม่มีประวัติให้อ่าน'));
    }
    if (frame.drill.mode === 'native') {
      items.append(el('div', 'panel-sub', 'child นี้ไม่มี MSP session — แสดงข้อมูลที่พับไว้จาก tool'));
    }
    for (const it of frame.drill.items || []) items.append(paintDrillItem(it));
    if (frame.liveText) {
      const live = el('div', 'drill-live');
      live.dataset.role = 'ov-drill-live';
      live.append(el('span', 'kind-tag live', 'สด'));
      live.append(el('span', 'drill-text', frame.liveText.slice(-500)));
      items.append(live);
    }
  }

  function paintDrillItem(it) {
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
      const chev = el('span', 'child-chev');
      setIcon(chev, 'chevRight', 'ico ico-sm');
      node.append(chev);
      node.addEventListener('click', () => {
        const frame = {
          type: 'sess', childSessionId: it.childSessionId,
          label: subagentTitle(it), kind: it.kind ?? null,
          drill: null, error: null, liveText: '',
          _readGen: 0,
        };
        stack.push(frame);
        render();
        void reloadDrill(frame);
      });
    }
    return node;
  }

  /** Owner verbs for an item drill. Rebuilt on record change — except while
   * the user is mid-gesture (confirm/send/busy), when it is left untouched. */
  function paintActions(actions, frame, rec) {
    actions.replaceChildren();
    // Mid-gesture the chrome freezes: a record update must not swap the
    // buttons (or the confirm row) out from under the cursor — except the
    // confirm row itself, which is painted below once and stays put.
    if (frame.busy || frame.sendOpen) return;
    if (frame.confirming === 'stop') {
      const ask = el('span', 'panel-sub warn', 'หยุด child นี้?');
      const yes = el('button', 'btn sm danger', 'หยุดเลย');
      yes.type = 'button';
      yes.dataset.focusKey = 'stop-yes';
      yes.addEventListener('click', () => void sendCommand(frame, 'stop', { reason: 'หยุดจากป๊อปอัป' }));
      const no = el('button', 'btn ghost sm', 'ยกเลิก');
      no.type = 'button';
      no.dataset.focusKey = 'stop-no';
      no.addEventListener('click', () => {
        frame.confirming = null;
        render();
      });
      actions.append(ask, yes, no);
      return;
    }
    for (const action of subagentActions(rec)) {
      const btn = el('button', 'btn ghost sm');
      setIconLabel(btn, SUBAGENT_ACTION_ICON[action] || 'circle', SUBAGENT_ACTION_LABEL[action] || action, 'ico ico-sm');
      btn.type = 'button';
      btn.dataset.focusKey = `act:${action}`;
      btn.addEventListener('click', () => {
        if (action === 'stop') {
          frame.confirming = 'stop';
          render();
        } else if (action === 'send') {
          frame.sendOpen = true;
          frame.note = null;
          render();
          root.querySelector('.agent-send-input')?.focus();
        } else {
          void sendCommand(frame, action, {});
        }
      });
      actions.append(btn);
    }
  }

  function paintSendForm(frame) {
    const form = el('form', 'agent-send-form');
    const input = document.createElement('input');
    input.className = 'agent-send-input';
    input.type = 'text';
    input.placeholder = 'พิมพ์ข้อความถึง child…';
    input.value = frame.sendDraft || '';
    input.dataset.focusKey = 'send-input';
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
        render();
      }
    });
    const send = el('button', 'btn sm primary', 'ส่ง');
    send.type = 'submit';
    send.dataset.focusKey = 'send-submit';
    const cancel = el('button', 'btn ghost sm', 'ยกเลิก');
    cancel.type = 'button';
    cancel.dataset.focusKey = 'send-cancel';
    cancel.addEventListener('click', () => {
      frame.sendOpen = false;
      render();
    });
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void sendCommand(frame, 'send', { body: input.value });
    });
    form.append(input, send, cancel);
    return form;
  }

  async function sendCommand(frame, action, extra) {
    if (frame.busy || !chatId) return;
    if (action === 'send' && !String(extra.body ?? '').trim()) {
      frame.note = { ok: false, text: 'พิมพ์ข้อความก่อนส่ง' };
      render();
      root.querySelector('.agent-send-input')?.focus();
      return;
    }
    frame.busy = action;
    frame.note = null;
    render();
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
    if (top() === frame) render();
  }

  async function reloadDrill(frame, { quiet = false } = {}) {
    const bound = chatId;
    // Poll ticks, manual refresh and status transitions overlap freely — the
    // generation guard drops slow older responses instead of serializing
    // reads (a stuck read must never head-block the next poll).
    frame._readGen = (frame._readGen || 0) + 1;
    const gen = frame._readGen;
    let drill = null;
    let readError = null;
    try {
      const url = frame.type === 'item'
        ? `/api/chats/${encodeURIComponent(bound)}/subagents/${encodeURIComponent(frame.itemId)}`
        : `/api/chats/${encodeURIComponent(bound)}/child-session/${encodeURIComponent(frame.childSessionId)}`;
      drill = await api(url);
    } catch (err) {
      readError = err?.message || 'อ่านไม่ได้';
    }
    if (frame._readGen !== gen) return; // superseded — newer read owns the frame
    if (drill) {
      frame.drill = drill;
      frame.error = null;
      // The child session's own title names what it actually did — adopt it
      // over the spawn-brief heading (and over generic reminder headings).
      // Trusted binary metadata, same source the child page titles from.
      const sessionTitle = typeof drill.session?.title === 'string' ? drill.session.title.trim() : '';
      if (sessionTitle) frame.label = sessionTitle;
    } else if (!quiet) {
      frame.error = readError;
    }
    // A chat switch or close while the read flew leaves this frame obsolete —
    // never paint it over the new chat.
    if (!isOpen() || chatId !== bound || top() !== frame) return;
    if (quiet) {
      syncDrillItems(frame);
      armPoll(frame);
    } else {
      render();
    }
  }

  /** Quiet poll repaint: items + status + actions only. The send form owns
   * its own subtree and focus — rebuilding it every 2.5s would eat keystrokes. */
  function syncDrillItems(frame) {
    const body = root?.querySelector('[data-role="ov-body"]');
    const items = body?.querySelector('[data-role="ov-items"]');
    if (items) paintItems(items, frame);
    syncDrillChrome(frame);
  }

  function syncDrillChrome(frame) {
    const rec = recordFor(frame);
    const title = root?.querySelector('.agent-drill-title');
    if (title) {
      title.textContent = frame.label;
      title.title = frame.label;
    }
    const pill = root?.querySelector('[data-role="ov-status"]');
    if (pill) pill.textContent = drillStatusWord(frame, rec);
    const actions = root?.querySelector('[data-role="ov-actions"]');
    if (actions && !frame.busy && !frame.confirming && !frame.sendOpen) {
      paintActions(actions, frame, rec);
    }
  }

  function armPoll(frame) {
    stopPoll();
    // The registry leads the drill (frames land before the next read), so a
    // running record alone keeps the poll alive — see drillShouldPoll.
    if (!drillShouldPoll(frame, recordFor(frame)?.status)) return;
    pollTimer = setInterval(() => {
      if (!isOpen() || top() !== frame) return stopPoll();
      void reloadDrill(frame, { quiet: true });
    }, DRILL_POLL_MS);
  }

  // --------------------------------------------------------------- shell

  /**
   * What a loud rebuild must carry across: focused control (by stable key),
   * open <details> folds, scroll positions, and the send draft + caret. Live
   * SSE repaints rebuild the whole tree — without this a keyboard user
   * tabbing the list loses focus on every delta, and expanded task folds
   * snap shut under the cursor.
   */
  function captureView() {
    const saved = { focusKey: null, hadFocus: false, folds: [], scrolls: {}, sendSel: null };
    if (!root) return saved;
    const ae = document.activeElement;
    if (ae && root.contains(ae)) {
      saved.hadFocus = true;
      saved.focusKey = typeof ae.getAttribute === 'function' ? ae.getAttribute('data-focus-key') : null;
      if (ae.classList?.contains('agent-send-input')) {
        try {
          saved.sendSel = [ae.selectionStart, ae.selectionEnd, ae.selectionDirection];
        } catch { saved.sendSel = null; }
        const f = top();
        if (f) f.sendDraft = ae.value;
      }
    }
    for (const d of root.querySelectorAll('details[data-fold-key]')) {
      if (d.open) saved.folds.push(d.getAttribute('data-fold-key'));
    }
    for (const [key, sel] of [['body', '[data-role="ov-body"]'], ['items', '[data-role="ov-items"]']]) {
      const n = root.querySelector(sel);
      if (n) saved.scrolls[key] = n.scrollTop;
    }
    return saved;
  }

  function restoreView(saved) {
    if (!root || !saved) return;
    for (const key of saved.folds || []) {
      const d = root.querySelector(`details[data-fold-key="${String(key).replace(/"/g, '\\"')}"]`);
      if (d) d.open = true;
    }
    const body = root.querySelector('[data-role="ov-body"]');
    if (body && saved.scrolls?.body != null) body.scrollTop = saved.scrolls.body;
    const items = root.querySelector('[data-role="ov-items"]');
    if (items && saved.scrolls?.items != null) items.scrollTop = saved.scrolls.items;
    // Focus returns to the same control — never stolen when it was outside.
    if (saved.hadFocus && saved.focusKey) {
      const next = root.querySelector(`[data-focus-key="${String(saved.focusKey).replace(/"/g, '\\"')}"]`);
      if (next?.focus) {
        next.focus({ preventScroll: true });
        if (Array.isArray(saved.sendSel) && next.classList?.contains('agent-send-input')) {
          try { next.setSelectionRange(saved.sendSel[0], saved.sendSel[1], saved.sendSel[2] || 'none'); } catch { /* ignore */ }
        }
      }
    }
  }

  /** Build the DOM into root. Runs detached too — open() paints BEFORE
   * openPanel so placement measures the real box, not an empty node. */
  function paint() {
    root.replaceChildren();
    const head = el('div', 'panel-head');
    const titleWrap = el('div', 'panel-title-row');
    titleWrap.append(el('div', 'panel-title', `ภาพรวม · ${chatTitle || 'แชทนี้'}`));
    head.append(titleWrap);
    const actions = el('div', 'panel-actions');
    const closeBtn = el('button', 'btn ghost sm');
    setIcon(closeBtn, 'x', 'ico ico-sm');
    closeBtn.type = 'button';
    closeBtn.dataset.focusKey = 'close';
    closeBtn.title = 'ปิด';
    closeBtn.setAttribute('aria-label', 'ปิดภาพรวม');
    closeBtn.addEventListener('click', () => close());
    actions.append(closeBtn);
    head.append(actions);
    root.append(head);
    const sub = el('div', 'panel-sub', chatId ? `แชท ${String(chatId).slice(0, 8)}` : '');
    root.append(sub);
    const body = el('div', 'ov-body');
    body.dataset.role = 'ov-body';
    root.append(body);
    const frame = top();
    if (!frame) {
      paintGoal(body);
      paintTasks(body);
      paintSubagents(body);
    } else if (frame.type === 'workflow') {
      paintWorkflow(body, frame);
    } else {
      paintDrill(body, frame);
    }
  }

  function render() {
    if (!root || !isOpen()) return;
    const saved = captureView();
    stopPoll();
    paint();
    restoreView(saved);
    // Content growth (drill push, rows arriving) can push the panel past the
    // viewport edge — clamp back in. Clamp-only: a fitting popup never moves.
    handle?.reposition?.();
  }

  function reset(chat, snap = {}) {
    stopPoll();
    stack = [];
    chatId = chat;
    chatTitle = snap.chatTitle || '';
    goal = snap.goal ?? null;
    goalCold = snap.goalCold === true;
    plan = Array.isArray(snap.plan) ? snap.plan : [];
    agents = new Map(snap.agents || []);
    toolRows = Array.isArray(snap.toolRows) ? snap.toolRows : [];
  }

  function refreshData(snap = {}) {
    chatTitle = snap.chatTitle || chatTitle;
    goal = snap.goal ?? null;
    goalCold = snap.goalCold === true;
    plan = Array.isArray(snap.plan) ? snap.plan : [];
    agents = new Map(snap.agents || []);
    toolRows = Array.isArray(snap.toolRows) ? snap.toolRows : [];
  }

  /** Captured workflow frames hold a record copy — refresh from the new map. */
  function refreshWorkflowFrames() {
    for (const f of stack) {
      if (f.type !== 'workflow' || f.itemId == null) continue;
      const fresh = agents.get(String(f.itemId));
      if (fresh) {
        f.rec = fresh;
        f.label = subagentTitle(fresh);
      }
    }
  }

  return {
    isOpen,
    openChat: () => chatId,
    close,

    open(anchor, id, snap = {}) {
      if (handle?.isOpen() && chatId === id && !stack.length) {
        close();
        return;
      }
      // Close first: openPanel's replacement close would otherwise fire the
      // old onClose AFTER we built the new tree and wipe the fresh state.
      if (isOpen()) close();
      reset(id, snap);
      root = el('div', 'panel overview-panel');
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-label', 'ภาพรวมเทิร์น: goal, tasks, subagents');
      paint(); // real content first — placement measures this box, not an empty node
      handle = openPanel(anchor, root, {
        onClose: () => {
          handle = null;
          root = null;
          stopPoll();
          stack = [];
          chatId = null;
        },
      });
    },

    /** Open drilled straight into one child (transcript activity links). */
    openDrill(anchor, id, itemId, snap = {}) {
      const rec = (snap.agents instanceof Map ? snap.agents : new Map(snap.agents || []))
        .get(String(itemId));
      if (handle?.isOpen() && chatId === id) {
        openItemFrame(itemId, rec ? subagentTitle(rec) : 'child');
        return;
      }
      if (isOpen()) close();
      reset(id, snap);
      root = el('div', 'panel overview-panel');
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-label', 'ภาพรวมเทิร์น: goal, tasks, subagents');
      const frame = {
        type: 'item', itemId: String(itemId),
        label: rec ? subagentTitle(rec) : 'child',
        kind: rec?.kind ?? null,
        drill: null, error: null, liveText: '', sendOpen: false,
        confirming: null, busy: null, note: null, sendDraft: '',
        _recStatus: rec ? String(rec.status || '') : '',
        _readGen: 0,
      };
      stack.push(frame);
      paint(); // real content first — placement measures this box, not an empty node
      handle = openPanel(anchor, root, {
        onClose: () => {
          handle = null;
          root = null;
          stopPoll();
          stack = [];
          chatId = null;
        },
      });
      void reloadDrill(frame);
    },

    /**
     * Chat switch / resync while open: rebind to the new snapshot. A real
     * chat change drops the drill stack (frames belong to the old chat); a
     * same-chat refetch (turn_done repaint, resync) keeps the open child
     * view and only refreshes the data under it.
     */
    rebind(id, snap = {}) {
      if (!isOpen()) return;
      if (id !== chatId) {
        reset(id, snap);
        render();
        return;
      }
      const frame = top();
      const before = frame?.type === 'item' ? String(agents.get(frame.itemId)?.status || '') : null;
      refreshData(snap);
      refreshWorkflowFrames();
      if (frame?.type === 'item') {
        const after = String(agents.get(frame.itemId)?.status || '');
        frame._recStatus = after;
        render();
        // A status flip across the refetch (child landed mid-turn) needs a
        // fresh drill, not just chrome — same as the live transition path.
        if (before !== after) void reloadDrill(frame, { quiet: true });
        return;
      }
      render();
    },

    applyGoal(id, g) {
      if (!isOpen() || id !== chatId) return;
      goal = g ?? null;
      if (!top()) render();
    },

    applyPlan(id, entries) {
      if (!isOpen() || id !== chatId) return;
      plan = Array.isArray(entries) ? entries : [];
      if (!top()) render();
    },

    applyAgents(id, map) {
      if (!isOpen() || id !== chatId) return;
      agents = new Map(map || []);
      const frame = top();
      if (!frame) {
        render();
        return;
      }
      if (frame.type === 'workflow') {
        // The captured rec is a copy — refresh it or the fold shows stale
        // child states until the user backs out and re-enters.
        const fresh = frame.itemId != null ? agents.get(String(frame.itemId)) : null;
        if (fresh) {
          frame.rec = fresh;
          frame.label = subagentTitle(fresh);
        }
        render();
        return;
      }
      if (frame.type === 'item') {
        // A status transition (running → landed, or resume → running again)
        // needs fresh items AND a re-armed poll — chrome alone leaves a
        // resumed child frozen with its poll stopped.
        const st = String(recordFor(frame)?.status || '');
        if (frame._recStatus !== st) {
          frame._recStatus = st;
          void reloadDrill(frame, { quiet: true });
          return;
        }
      }
      // Same status: refresh the header chrome around the open frame —
      // never the items or the send form mid-gesture.
      syncDrillChrome(frame);
    },

    applyTools(id, rows) {
      if (!isOpen() || id !== chatId) return;
      toolRows = Array.isArray(rows) ? rows : [];
      if (!top()) render();
    },

    /** SSE `subagent_delta` — patch the streaming line in place; a full
     * list re-render per chunk would rebuild the rows out from under clicks. */
    applyAgentDelta(id, itemId, text) {
      if (!isOpen() || id !== chatId) return;
      const key = String(itemId);
      const rec = agents.get(key);
      if (rec) {
        rec.liveText = String(text || '');
        rec.updatedAt = Date.now();
      }
      const body = root?.querySelector('[data-role="ov-body"]');
      if (!body) return;
      const frame = top();
      if (frame?.type === 'item' && frame.itemId === key) {
        frame.liveText = String(text || '');
        let box = body.querySelector('[data-role="ov-drill-live"] .drill-text');
        if (!box) {
          // First delta for this drill — the items repaint picks the box up.
          const items = body.querySelector('[data-role="ov-items"]');
          if (items) paintItems(items, frame);
          box = body.querySelector('[data-role="ov-drill-live"] .drill-text');
        } else {
          box.textContent = String(text || '').slice(-500);
        }
        return;
      }
      if (frame) return;
      const row = body.querySelector(`[data-itemid="${key.replace(/"/g, '\\"')}"]`);
      if (!row) {
        render();
        return;
      }
      let live = row.querySelector('[data-role="ov-live"]');
      if (!live) {
        live = el('div', 'child-live', '');
        live.dataset.role = 'ov-live';
        row.querySelector('.mcp-main')?.append(live);
      }
      live.textContent = String(text || '').slice(-240);
    },
  };
}
