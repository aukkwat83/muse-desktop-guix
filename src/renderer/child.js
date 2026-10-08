// Standalone live view for one child session — the pop-out target from
// the overview popup's drill header. Same data as the popup drill (the drill
// endpoint + the registry list for live status), polling on the same 2.5s
// clock while the child runs. No app boot: this page owns its own fetch +
// paint and only borrows the shared pure view-model.

import {
  childKindLabel,
  drillItemPreview,
  drillKindTag,
  nativeRunStatus,
  subagentDotClass,
  subagentStatusWord,
  subagentTitle,
} from './rightbar.js?v=1.2.0';
import { setIcon } from './icons.js?v=1.0.0';

const root = document.getElementById('child-root');
const params = new URLSearchParams(location.search);
const chatId = params.get('chat') || '';
const itemId = params.get('item') || '';
const sessionId = params.get('session') || '';

const POLL_MS = 2500;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = body.code || null;
    throw err;
  }
  return body;
}

function drillUrl() {
  if (itemId) return `/api/chats/${encodeURIComponent(chatId)}/subagents/${encodeURIComponent(itemId)}`;
  return `/api/chats/${encodeURIComponent(chatId)}/child-session/${encodeURIComponent(sessionId)}`;
}

function titleFor(drill, rec) {
  // The child session's own title is the best heading when the binary gives
  // one — it names what the child actually did, not the spawn brief. The
  // registry title trails, then the raw id. (subagentTitle itself never
  // returns the wire's generic reminder line, so no extra guard here.)
  const sessionTitle = typeof drill?.session?.title === 'string' ? drill.session.title.trim() : '';
  if (sessionTitle) return sessionTitle;
  if (rec) return subagentTitle(rec);
  if (drill?.record) return subagentTitle(drill.record);
  return (sessionId || itemId || 'child').slice(0, 24);
}

function statusOf(drill, rec) {
  // A native-log run envelope decides when present — active reads running,
  // terminal reads its outcome, either way over a stale record. Same
  // helper as the popup drill, so both surfaces headline the same run.
  const native = nativeRunStatus(drill?.nativeRun);
  if (native) return native;
  return rec?.status || drill?.record?.status
    || (drill?.session?.status === 'running' ? 'inProgress' : drill?.record?.status || '');
}

function paintHead(head, drill, rec) {
  head.replaceChildren();
  const kind = rec?.kind || drill?.record?.kind || null;
  if (kind) head.append(el('span', 'kind-tag', childKindLabel(kind)));
  const title = el('div', 'agent-drill-title', titleFor(drill, rec));
  head.append(title);
  const st = statusOf(drill, rec);
  if (st) {
    const pill = el('span', 'panel-sub', subagentStatusWord(st));
    head.append(el('span', subagentDotClass(st)), pill);
  }
  document.title = `${titleFor(drill, rec)} · ${subagentStatusWord(st) || '—'} — Muse Desktop`;
  const refresh = el('button', 'btn ghost sm');
  setIcon(refresh, 'refresh', 'ico ico-sm');
  refresh.type = 'button';
  refresh.title = 'อ่านใหม่';
  refresh.setAttribute('aria-label', 'อ่านใหม่');
  refresh.addEventListener('click', () => void load({ quiet: false }));
  head.append(refresh);
}

function paintBody(body, drill, rec) {
  body.replaceChildren();
  if (drill?.readError) {
    body.append(el('div', 'panel-sub warn', `อ่าน session ไม่ได้ (${drill.readError}) — แสดงข้อมูลที่เหลืออยู่`));
  }
  if (drill?.notice) {
    body.append(el('div', 'panel-sub', drill.notice));
  }
  // No separate verdict line: the server already unshifts the verdict card
  // as items[0] (same as the popup drill) — a second copy reads like a bug.
  if (drill?.session) {
    const s = drill.session;
    const bits = [
      s.status ? `session ${s.status}` : null,
      s.turnCount != null ? `${s.turnCount} turns` : null,
      drill.mode && drill.mode !== 'inline' ? `mode ${drill.mode}` : null,
    ].filter(Boolean).join(' · ');
    if (bits) body.append(el('div', 'panel-sub', bits));
  }
  if (drill?.droppedFromHead) {
    body.append(el('div', 'panel-sub', `…ข้าม ${drill.droppedFromHead} รายการแรก`));
  }
  if (drill?.mode === 'none' && !(drill.items || []).length) {
    body.append(el('div', 'panel-empty', 'ยังไม่มีประวัติให้อ่าน'));
  }
  const list = el('div', 'panel-list');
  for (const it of drill?.items || []) list.append(paintItem(it));
  body.append(list);
  const live = rec?.liveText;
  if (live) {
    const box = el('div', 'drill-live');
    box.append(el('span', 'kind-tag live', 'สด'));
    box.append(el('span', 'drill-text', String(live).slice(-500)));
    body.append(box);
  }
}

function paintItem(it) {
  const node = el('div', 'drill-row');
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
  return node;
}

let pollTimer = null;

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** Same stay-alive rule as the popup's drill poll: any running signal
 * keeps the 2.5s clock, a landed drill stops it. */
function stillRunning(drill, rec) {
  if (!drill) return true;
  if ((drill.items || []).some((it) => it.status === 'inProgress')) return true;
  if (drill.session?.status === 'running') return true;
  // A native-log run with no tool rows yet is still live work — the run
  // state (not the item list) keeps this poll alive. A terminal run stops
  // unless the registry still claims liveness: that refresh discovers a
  // resumed run no transition relayed yet.
  if (drill.nativeRun?.state === 'running') return true;
  return String(rec?.status || drill?.record?.status || '') === 'inProgress';
}

function paintError(message) {
  stopPoll();
  root.replaceChildren();
  root.append(el('div', 'panel-empty', message));
  document.title = 'Child session — Muse Desktop';
}

async function load({ quiet = true } = {}) {
  let drill;
  try {
    drill = await fetchJson(drillUrl());
  } catch (err) {
    if (!quiet || !root.querySelector('[data-role="child-items"]')) {
      paintError(err?.code === 'NO_SESSION'
        ? 'child นี้ยังไม่มี session ให้อ่าน'
        : `อ่านไม่ได้: ${err?.message || err}`);
    }
    return;
  }
  let rec = drill.record || null;
  // The registry leads the drill for live status + stream tail.
  if (itemId) {
    try {
      const list = await fetchJson(`/api/chats/${encodeURIComponent(chatId)}/subagents`);
      rec = (list.subagents || []).find((r) => r?.itemId === itemId) || rec;
    } catch { /* the drill alone still paints */ }
  }
  let head = root.querySelector('[data-role="child-head"]');
  let body = root.querySelector('[data-role="child-items"]');
  if (!head || !body) {
    root.replaceChildren();
    head = el('div', 'agent-drill-head');
    head.dataset.role = 'child-head';
    body = el('div', 'agent-content');
    body.dataset.role = 'child-items';
    root.append(head, body);
  }
  paintHead(head, drill, rec);
  paintBody(body, drill, rec);
  stopPoll();
  if (stillRunning(drill, rec)) {
    pollTimer = setInterval(() => void load({ quiet: true }), POLL_MS);
  }
}

if (!chatId || (!itemId && !sessionId)) {
  paintError('ลิงก์ไม่ครบ — เปิดจากปุ่มเปิดหน้าต่างใหม่ในแผง subagents');
} else {
  void load({ quiet: false });
}
