// Tasks + goal panel: the session goal block (objective, %, current/next
// work) above the live todo checklist. Both halves refresh in place while
// open — `goal` broadcasts feed the top, `plan` broadcasts the list.

import { closePopover, openPanel } from './popover.js?v=0.5.1';
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

function goalStatusWord(status) {
  switch (String(status || '')) {
    case 'running': return 'กำลังทำ';
    case 'paused': return 'หยุดชั่วคราว';
    case 'complete': return 'เสร็จ';
    case 'blocked': return 'ติดขัด';
    default: return String(status || '—');
  }
}

function taskStatusWord(status) {
  switch (String(status || '')) {
    case 'in_progress': return 'ทำอยู่';
    case 'completed': return 'เสร็จ';
    case 'failed': return 'ล้มเหลว';
    case 'cancelled': return 'ยกเลิก';
    default: return 'รอ';
  }
}

function taskDot(status) {
  switch (String(status || '')) {
    case 'completed': return 'dot ok';
    case 'in_progress': return 'dot run';
    case 'failed': return 'dot bad';
    default: return 'dot idle';
  }
}

export function createTasksPanel() {
  let handle = null;
  let root = null;
  let chatId = null;
  let chatTitle = '';
  let goal = null;
  let plan = [];

  function render() {
    if (!root) return;
    root.textContent = '';

    const head = el('div', 'panel-head');
    head.append(el('div', 'panel-title', `tasks · ${chatTitle || 'แชทนี้'}`));
    const actions = el('div', 'panel-actions');
    const close = el('button', 'btn ghost sm');
    setIcon(close, 'x', 'ico ico-sm');
    close.type = 'button';
    close.title = 'ปิด';
    close.setAttribute('aria-label', 'ปิด');
    close.addEventListener('click', () => closePopover());
    actions.append(close);
    head.append(actions);
    root.append(head);

    const list = el('div', 'panel-list');

    // ---- goal section
    const gHead = el('div', 'panel-sect', 'goal');
    list.append(gHead);
    if (!goal) {
      list.append(el('div', 'panel-empty', 'ยังไม่ตั้ง goal ในแชทนี้'));
    } else {
      const pct = clampPct(goal.percentComplete);
      const gRow = el('div', 'goal-block');
      const first = el('div', 'drill-first');
      first.append(el('span', 'kind-tag', `${pct}%`));
      first.append(el('span', 'drill-tool', goalStatusWord(goal.status)));
      gRow.append(first);
      if (goal.objective) gRow.append(el('div', 'goal-objective', goal.objective));
      const bar = el('div', 'goal-bar');
      const fill = el('div', 'goal-fill');
      fill.style.width = `${pct}%`;
      bar.append(fill);
      gRow.append(bar);
      if (goal.currentWork) gRow.append(el('div', 'goal-work', `กำลังทำ: ${goal.currentWork}`));
      if (goal.nextWork) gRow.append(el('div', 'goal-work next', `ถัดไป: ${goal.nextWork}`));
      list.append(gRow);
    }

    // ---- tasks section
    const entries = Array.isArray(plan) ? plan : [];
    const done = entries.filter((t) => String(t?.status) === 'completed').length;
    list.append(el('div', 'panel-sect', `tasks · เสร็จ ${done}/${entries.length}`));
    if (!entries.length) {
      list.append(el('div', 'panel-empty', 'ยังไม่มี tasks ในเทิร์นนี้'));
    }
    for (const t of entries) {
      const row = el('div', 'mcp-row task-row');
      row.append(el('span', taskDot(t?.status)));
      const main = el('div', 'mcp-main');
      main.append(el('div', 'task-content', String(t?.content || '(ไม่มีชื่อ task)')));
      main.append(el('div', 'mcp-meta', taskStatusWord(t?.status)));
      row.append(main);
      list.append(row);
    }

    root.append(list);
  }

  return {
    isOpen: () => !!handle?.isOpen(),
    openChat: () => chatId,

    open(anchor, id, title, snap = {}) {
      if (handle?.isOpen() && chatId === id) {
        closePopover();
        return;
      }
      chatId = id;
      chatTitle = title || '';
      goal = snap.goal ?? null;
      plan = Array.isArray(snap.plan) ? snap.plan : [];
      root = el('div', 'panel tasks-panel');
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-label', 'tasks และ goal');
      handle = openPanel(anchor, root, { onClose: () => { handle = null; } });
      render();
    },

    applyGoal(g) {
      goal = g ?? null;
      if (handle?.isOpen()) render();
    },

    applyPlan(entries) {
      plan = Array.isArray(entries) ? entries : [];
      if (handle?.isOpen()) render();
    },
  };
}
