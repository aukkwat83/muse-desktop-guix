// Subagent panel: the current chat's spawned children, with drill-down into
// each child's own session (and one level deeper — nested children chain
// through the child-session endpoint).
//
// Live updates ride the `subagent` / `subagent_delta` broadcasts; the drill
// view is a point-in-time `session/read`, refreshed manually or on a short
// poll while the child still runs.

import { closePopover, openPanel } from './popover.js?v=0.4.2';

const CHILDISH = new Set(['subagent', 'workflow', 'reminderChild']);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function statusWord(status) {
  switch (String(status || '')) {
    case 'inProgress': return 'กำลังรัน';
    case 'completed': return 'เสร็จ';
    case 'failed': return 'ล้มเหลว';
    case 'cancelled': return 'ยกเลิก';
    default: return String(status || '—');
  }
}

function dotClass(status) {
  switch (String(status || '')) {
    case 'inProgress': return 'dot run';
    case 'completed': return 'dot ok';
    case 'failed': return 'dot bad';
    default: return 'dot idle';
  }
}

function childTitle(rec) {
  return rec.role || rec.agentPath || rec.objective || rec.entryId || rec.kind || 'child';
}

function childSub(rec) {
  const bits = [];
  if (rec.kind === 'workflow' && Array.isArray(rec.children)) {
    bits.push(`${rec.children.length} children`);
  } else {
    if (rec.depth != null) bits.push(`depth ${rec.depth}`);
    if (rec.controlStatus) bits.push(rec.controlStatus);
  }
  if (rec.durationMs != null) bits.push(`${(rec.durationMs / 1000).toFixed(1)}s`);
  if (rec.objective && rec.role) bits.push(rec.objective);
  else if (rec.objective && !rec.role && !rec.agentPath) bits.push(rec.objective);
  if (rec.message) bits.push(rec.message);
  return bits.join(' · ');
}

function itemPreview(it) {
  if (it.text) return it.text;
  if (it.result?.summary) return it.result.summary;
  if (it.tool) return `${it.tool}${it.fallbackText ? ` → ${it.fallbackText}` : ''}`;
  if (it.objective) return it.objective;
  if (it.message) return it.message;
  if (it.fallbackText) return it.fallbackText;
  return '';
}

function kindTag(kind) {
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

export function createSubagentsPanel({ api }) {
  let handle = null;
  let root = null;
  let chatId = null;
  let chatTitle = '';
  /** Registry mirror for the open chat: itemId → record. */
  let records = new Map();
  /** Drill stack: [{ key, label, drill|null, error|null }]. Empty = list. */
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

  function renderHead(titleText, { onBack = null, onRefresh = null, extra = '' } = {}) {
    const head = el('div', 'panel-head');
    const left = el('div', 'panel-title-row');
    if (onBack) {
      const back = el('button', 'btn ghost sm', '‹ กลับ');
      back.type = 'button';
      back.addEventListener('click', onBack);
      left.append(back);
    }
    left.append(el('div', 'panel-title', titleText));
    const actions = el('div', 'panel-actions');
    if (extra) actions.append(el('span', 'panel-sub', extra));
    if (onRefresh) {
      const refresh = el('button', 'btn ghost sm', '⟳');
      refresh.type = 'button';
      refresh.title = 'อ่านใหม่';
      refresh.addEventListener('click', () => void onRefresh());
      actions.append(refresh);
    }
    const close = el('button', 'btn ghost sm', '✕');
    close.type = 'button';
    close.title = 'ปิด';
    close.addEventListener('click', () => closePopover());
    actions.append(close);
    head.append(left, actions);
    return head;
  }

  function renderList() {
    root.textContent = '';
    root.append(renderHead(`subagents · ${chatTitle || 'แชทนี้'}`));
    const list = el('div', 'panel-list');
    const recs = [...records.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (!recs.length) {
      list.append(el('div', 'panel-empty', 'ยังไม่มี subagent ในแชทนี้'));
    }
    for (const rec of recs) list.append(renderRow(rec));
    root.append(list);
  }

  function renderRow(rec) {
    const row = el('button', 'child-row');
    row.type = 'button';
    const running = rec.status === 'inProgress';
    row.append(el('span', dotClass(rec.status)));
    const main = el('div', 'mcp-main');
    main.append(el('div', 'mcp-name', childTitle(rec)));
    const bits = [statusWord(rec.status), childSub(rec)].filter(Boolean).join(' · ');
    main.append(el('div', 'mcp-meta', bits));
    if (rec.result?.summary && rec.status !== 'inProgress') {
      main.append(el('div', 'child-result', rec.result.summary));
    }
    if (running && rec.liveText) {
      main.append(el('div', 'child-live', rec.liveText.slice(-240)));
    }
    row.append(main);
    if (rec.kind === 'workflow' && Array.isArray(rec.children) && rec.children.length) {
      row.append(el('span', 'child-chev', `${rec.children.length}›`));
    } else if (rec.childSessionId) {
      row.append(el('span', 'child-chev', '›'));
    }
    row.addEventListener('click', () => {
      if (rec.kind === 'workflow' && Array.isArray(rec.children) && rec.children.length) {
        stack.push({ key: `wf:${rec.itemId}`, label: childTitle(rec), workflow: rec, drill: null, error: null });
        render();
        return;
      }
      if (rec.childSessionId) void openDrill(rec.itemId, childTitle(rec));
    });
    return row;
  }

  function renderWorkflowFrame(frame) {
    root.textContent = '';
    root.append(renderHead(frame.label, { onBack: () => { stack.pop(); render(); } }));
    const list = el('div', 'panel-list');
    for (const c of frame.workflow.children || []) {
      const row = el('div', 'mcp-row');
      row.append(el('span', dotClass(c.status === 'succeeded' ? 'completed' : c.status)));
      const main = el('div', 'mcp-main');
      main.append(el('div', 'mcp-name', c.label || c.childId || '?'));
      const bits = [c.status || '', c.phase || '', c.durationMs != null ? `${(c.durationMs / 1000).toFixed(1)}s` : '']
        .filter(Boolean).join(' · ');
      main.append(el('div', 'mcp-meta', bits));
      row.append(main);
      list.append(row);
    }
    root.append(list);
  }

  function renderDrill() {
    const frame = top();
    root.textContent = '';
    root.append(renderHead(frame.label, {
      onBack: () => { stack.pop(); render(); },
      onRefresh: () => void reloadDrill(frame),
      extra: frame.drill?.session ? statusWord(frame.drill.session.status) : '',
    }));
    const list = el('div', 'panel-list');
    if (frame.error) {
      list.append(el('div', 'panel-empty', frame.error));
    } else if (!frame.drill) {
      list.append(el('div', 'panel-empty', 'กำลังอ่าน…'));
    } else {
      const items = frame.drill.items || [];
      if (frame.drill.droppedFromHead) {
        list.append(el('div', 'panel-sub', `…ข้าม ${frame.drill.droppedFromHead} รายการแรก`));
      }
      if (frame.drill.mode === 'none') {
        list.append(el('div', 'panel-empty', 'ยังไม่มีประวัติให้อ่าน'));
      }
      for (const it of items) list.append(renderDrillItem(it));
      if (frame.liveText) {
        const live = el('div', 'drill-live');
        live.append(el('span', 'kind-tag live', 'สด'));
        live.append(el('span', 'drill-text', frame.liveText.slice(-500)));
        list.append(live);
      }
    }
    root.append(list);
    // Stay pinned to the newest activity while a drill view renders.
    list.scrollTop = list.scrollHeight;
  }

  function renderDrillItem(it) {
    const nested = CHILDISH.has(it.kind) && it.childSessionId;
    const node = el(nested ? 'button' : 'div', 'drill-row');
    if (nested) node.type = 'button';
    node.append(el('span', dotClass(it.status)));
    const main = el('div', 'mcp-main');
    const first = el('div', 'drill-first');
    first.append(el('span', 'kind-tag', kindTag(it.kind)));
    if (it.tool) first.append(el('span', 'drill-tool', it.tool));
    else if (it.agentPath || it.role) first.append(el('span', 'drill-tool', it.agentPath || it.role));
    main.append(first);
    const preview = itemPreview(it);
    if (preview) main.append(el('div', 'drill-text', preview));
    node.append(main);
    if (nested) {
      node.append(el('span', 'child-chev', '›'));
      node.addEventListener('click', () => void openChildSession(it.childSessionId, it.agentPath || it.role || 'subagent'));
    }
    return node;
  }

  function render() {
    if (!root) return;
    stopPoll();
    const frame = top();
    if (!frame) {
      renderList();
      return;
    }
    if (frame.workflow) {
      renderWorkflowFrame(frame);
      return;
    }
    renderDrill();
    // While the drilled child still runs, re-read on a short poll so the
    // view tracks what it is doing without hammering a finished child.
    const running = frame.drill?.session?.status === 'running'
      || (frame.drill?.items || []).some((it) => it.status === 'inProgress');
    if (running && !frame.error) {
      pollTimer = setInterval(() => {
        if (!handle?.isOpen() || top() !== frame) return stopPoll();
        void reloadDrill(frame, { quiet: true });
      }, 2500);
    }
  }

  async function loadList() {
    try {
      const r = await api(`/api/chats/${encodeURIComponent(chatId)}/subagents`);
      records = new Map((r.subagents || []).map((s) => [s.itemId, s]));
    } catch {
      records = new Map();
    }
    if (handle?.isOpen() && !top()) render();
  }

  async function openDrill(itemId, label) {
    const frame = { key: `item:${itemId}`, label, drill: null, error: null, liveText: '' };
    stack.push(frame);
    render();
    await reloadDrill(frame);
  }

  async function openChildSession(childSessionId, label) {
    const frame = { key: `sess:${childSessionId}`, label, drill: null, error: null, liveText: '' };
    stack.push(frame);
    render();
    try {
      const drill = await api(
        `/api/chats/${encodeURIComponent(chatId)}/child-session/${encodeURIComponent(childSessionId)}`,
      );
      frame.drill = drill;
    } catch (err) {
      frame.error = err?.message || 'อ่าน child session ไม่ได้';
    }
    if (handle?.isOpen() && top() === frame) render();
  }

  async function reloadDrill(frame, { quiet = false } = {}) {
    const itemId = frame.key.startsWith('item:') ? frame.key.slice(5) : null;
    const sessId = frame.key.startsWith('sess:') ? frame.key.slice(5) : null;
    try {
      const drill = itemId
        ? await api(`/api/chats/${encodeURIComponent(chatId)}/subagents/${encodeURIComponent(itemId)}`)
        : await api(`/api/chats/${encodeURIComponent(chatId)}/child-session/${encodeURIComponent(sessId)}`);
      frame.drill = drill;
      frame.error = null;
    } catch (err) {
      if (!quiet) frame.error = err?.message || 'อ่านไม่ได้';
    }
    if (handle?.isOpen() && top() === frame) render();
  }

  return {
    isOpen: () => !!handle?.isOpen(),
    openChat: () => chatId,

    open(anchor, id, title) {
      if (handle?.isOpen() && chatId === id && !stack.length) {
        closePopover();
        return;
      }
      chatId = id;
      chatTitle = title || '';
      records = new Map();
      stack = [];
      root = el('div', 'panel sub-panel');
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-label', 'subagents');
      handle = openPanel(anchor, root, {
        onClose: () => { handle = null; stopPoll(); },
      });
      render();
      void loadList();
    },

    /** SSE `subagent` — refresh the open list when it is ours. */
    applyRecord(rec) {
      if (!rec?.itemId || !handle?.isOpen()) return;
      records.set(rec.itemId, { ...(records.get(rec.itemId) || {}), ...rec });
      if (!top()) render();
    },

    /** SSE `subagent_delta` — live line inside the open drill, when it matches. */
    applyDelta(itemId, text) {
      const frame = top();
      if (!frame || frame.key !== `item:${itemId}`) return;
      frame.liveText = String(text || '').slice(-2000);
      if (handle?.isOpen()) render();
    },
  };
}
