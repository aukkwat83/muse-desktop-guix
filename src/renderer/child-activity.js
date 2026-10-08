// Inline child activity for transcript agent rows — the ChatGPT-desktop-like
// nested delegate view. An agent tool row that names a durable child
// (tool.agentLink, server-resolved to a registry key) grows a
// .child-activity block above its console: the child's status + step rows
// from the drill endpoint, with a live tail while it runs. Model-side
// Agent rows carry no child id, so they never mount (the row's own output
// is all the wire offers).
//
// No top-level DOM touch — app.js mounts one block per row and forwards
// the subagent SSE. One level only: deeper nesting lives in the overview
// popup drill (the "ดูเต็ม" button opens it, drilled into that child).

import {
  drillItemPreview,
  drillKindTag,
  subagentDotClass,
  subagentStatusWord,
} from './rightbar.js?v=1.2.0';
import { setIconLabel } from './icons.js?v=1.0.0';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** Counts for one drill payload. Pure — the node suite covers it. */
export function childActivitySummary(drill) {
  const items = Array.isArray(drill?.items) ? drill.items : [];
  let done = 0;
  let running = 0;
  for (const it of items) {
    const s = String(it?.status || '');
    if (s === 'completed') done += 1;
    else if (s === 'inProgress' || s === 'running') running += 1;
  }
  return { total: items.length, done, running };
}

/** Headline next to the status dot: `กำลังรัน · 5 ขั้นตอน`. Pure. */
export function childActivityHeadline(drill) {
  const s = childActivitySummary(drill);
  const status = subagentStatusWord(drill?.record?.status);
  const steps = s.total === 1 ? '1 ขั้นตอน' : `${s.total} ขั้นตอน`;
  return `${status} · ${steps}`;
}

function activityRow(it) {
  const row = el('div', 'drill-row ca-row');
  row.append(el('span', subagentDotClass(it.status)));
  const main = el('div', 'mcp-main');
  const first = el('div', 'drill-first');
  first.append(el('span', 'kind-tag', drillKindTag(it.kind)));
  if (it.tool) first.append(el('span', 'drill-tool', it.tool));
  else if (it.agentPath || it.role) first.append(el('span', 'drill-tool', it.agentPath || it.role));
  main.append(first);
  const preview = drillItemPreview(it);
  if (preview) main.append(el('div', 'drill-text', preview));
  if (it.durationMs != null) {
    main.append(el('div', 'mcp-meta', `${(Number(it.durationMs) / 1000).toFixed(1)}s`));
  }
  row.append(main);
  return row;
}

export function createChildActivity({ api, onOpenRail }) {
  /** `${chatId}::${itemId}` → { drill, status } — a chat switch back or a
   * re-expand repaints from cache, no refetch. */
  const cache = new Map();
  /** key → Set<wrap> of mounted blocks (live + history rows). */
  const mounted = new Map();
  const key = (chatId, itemId) => `${chatId}::${itemId}`;

  function track(chatId, itemId, wrap) {
    const k = key(chatId, itemId);
    if (!mounted.has(k)) mounted.set(k, new Set());
    mounted.get(k).add(wrap);
  }

  function liveMounted(k) {
    const set = mounted.get(k);
    if (!set) return [];
    const out = [];
    for (const wrap of [...set]) {
      // A chat switch rebuilds the transcript — disconnected wraps prune.
      if (!wrap.isConnected) set.delete(wrap);
      else out.push(wrap);
    }
    if (!set.size) mounted.delete(k);
    return out;
  }

  function paintHead(wrap, drill) {
    let head = wrap.querySelector(':scope > .ca-head');
    if (!head) {
      head = el('div', 'ca-head');
      head.append(el('span', 'dot idle'));
      head.append(el('span', 'ca-title', ''));
      const open = el('button', 'btn ghost sm ca-open');
      setIconLabel(open, 'chevRight', 'ดูเต็ม', 'ico ico-sm');
      // Icon trails the word ("ดูเต็ม ›" shape): label first, chevron after.
      open.appendChild(open.querySelector('svg'));
      open.type = 'button';
      open.title = 'ดู child นี้แบบเต็ม (ป๊อปอัปภาพรวม)';
      open.addEventListener('click', () => onOpenRail?.(wrap.dataset.chatId, wrap.dataset.itemId, open));
      head.append(open);
      wrap.prepend(head);
    }
    head.querySelector('.dot').className = subagentDotClass(drill?.record?.status);
    head.querySelector('.ca-title').textContent = childActivityHeadline(drill);
  }

  function paintWrap(wrap, drill) {
    wrap.querySelectorAll(':scope > .ca-list, :scope > .ca-live, :scope > .ca-note').forEach((n) => n.remove());
    paintHead(wrap, drill);
    if (drill?.readError) {
      wrap.append(el('div', 'panel-sub warn ca-note',
        `อ่าน session ไม่ได้ (${drill.readError}) — แสดงข้อมูลที่เหลืออยู่`));
    }
    const items = Array.isArray(drill?.items) ? drill.items : [];
    if (!items.length) {
      wrap.append(el('div', 'panel-empty ca-note', 'ยังไม่มีประวัติให้อ่าน'));
      return;
    }
    const list = el('div', 'ca-list');
    for (const it of items) list.append(activityRow(it));
    wrap.append(list);
    if (String(drill?.record?.status) === 'inProgress') {
      const live = el('div', 'drill-live ca-live');
      live.append(el('span', 'kind-tag live', 'สด'));
      const tail = el('span', 'drill-text', '');
      tail.dataset.role = 'ca-live-text';
      live.append(tail);
      wrap.append(live);
    }
  }

  function paintFallback(wrap, err) {
    wrap.querySelectorAll(':scope > .ca-list, :scope > .ca-live, :scope > .ca-note').forEach((n) => n.remove());
    const status = err?.status ?? err?.code;
    const gone = status === 404 || status === 409 || status === 'NOT_FOUND' || status === 'NO_SESSION';
    wrap.append(el('div', 'panel-sub warn ca-note', gone
      ? 'รายละเอียด child ไม่อยู่แล้ว — ดู console ด้านล่าง'
      : `อ่าน activity ไม่ได้ (${err?.message || err}) — ดู console ด้านล่าง`));
  }

  async function loadInto(wrap) {
    const { chatId, itemId } = wrap.dataset;
    if (!chatId || !itemId || wrap.dataset.loaded || wrap.dataset.loading) return;
    wrap.dataset.loading = '1';
    try {
      const drill = await api(
        `/api/chats/${encodeURIComponent(chatId)}/subagents/${encodeURIComponent(itemId)}`,
      );
      cache.set(key(chatId, itemId), { drill, status: String(drill?.record?.status || '') });
      if (!wrap.isConnected) return;
      wrap.dataset.loaded = '1';
      paintWrap(wrap, drill);
    } catch (err) {
      if (!wrap.isConnected) return;
      paintFallback(wrap, err);
    } finally {
      delete wrap.dataset.loading;
    }
  }

  return {
    /** Block for one agent row, or null when the row names no child.
     * Empty until the row opens (ensureLoaded) — a cached drill paints
     * instantly for re-expands and chat switches back. */
    mountRow(chatId, tool) {
      if (!tool?.agentLink || !chatId) return null;
      const wrap = el('div', 'child-activity');
      wrap.dataset.chatId = String(chatId);
      wrap.dataset.itemId = String(tool.agentLink);
      track(chatId, tool.agentLink, wrap);
      const hit = cache.get(key(chatId, tool.agentLink));
      if (hit) {
        wrap.dataset.loaded = '1';
        paintWrap(wrap, hit.drill);
      }
      return wrap;
    },

    /** Fetch on first open. Mounted-but-collapsed rows cost nothing. */
    ensureLoaded(wrap) {
      if (wrap?.isConnected) void loadInto(wrap);
    },

    /** Registry record changed: a status transition refetches every mounted
     * block for that child; same-status frames only repaint the header.
     * Steps that land mid-status arrive at the next transition — the live
     * tail covers "still working" between them. */
    noteSubagent(chatId, rec) {
      if (!rec?.itemId) return;
      const k = key(chatId, rec.itemId);
      const prev = cache.get(k);
      const next = String(rec?.status || '');
      for (const wrap of liveMounted(k)) {
        if (!wrap.dataset.loaded) continue;
        if (prev && prev.status === next) {
          if (prev.drill) paintHead(wrap, prev.drill);
          continue;
        }
        delete wrap.dataset.loaded;
        void loadInto(wrap);
      }
    },

    /** Stream tail patches in place — never a list re-render per chunk. */
    noteSubagentDelta(chatId, itemId, text) {
      for (const wrap of liveMounted(key(chatId, itemId))) {
        let tail = wrap.querySelector('[data-role="ca-live-text"]');
        if (!tail) {
          if (!wrap.dataset.loaded) continue;
          const live = el('div', 'drill-live ca-live');
          live.append(el('span', 'kind-tag live', 'สด'));
          tail = el('span', 'drill-text', '');
          tail.dataset.role = 'ca-live-text';
          live.append(tail);
          wrap.append(live);
        }
        tail.textContent = String(text || '').slice(-240);
      }
    },
  };
}
